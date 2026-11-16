// Kestrel Yard: a freight yard at dusk, drawn for a tactical shooter and
// for nothing else. Two bomb sites (A, the west warehouse; B, the east
// tank farm), three lanes between the spawns, and crates and containers
// that break every sightline into short, holdable pieces. Everything solid
// is an axis-aligned box: the same list drives rendering, collision and
// line of sight, so what you see is what blocks you.
import * as THREE from 'three';
import { makeTextures } from './textures.js';
import { dist2D } from './util.js';

const BOUNDS = { minX: -34, maxX: 34, minZ: -26, maxZ: 26 };

// [x, z, width, depth, height, material]
const SOLIDS = [
  // Perimeter.
  [0, -26, 69, 1, 5, 'wall'], [34, 0, 1, 53, 5, 'wall'],
  [0, 26, 69, 1, 5, 'wall'], [-34, 0, 1, 53, 5, 'wall'],
  // Warehouse A (west): three walls leave the south side open.
  [-26, -18, 14, 1, 6, 'block'], [-33, -13, 1, 10, 6, 'block'],
  [-19, -13, 1, 10, 6, 'block'],
  // Tank farm B (east): three walls leave the west side open.
  [24, -18, 12, 1, 4, 'block'], [30, -13, 1, 10, 4, 'block'],
  [24, -8, 12, 1, 4, 'block'],
  // Mid containers: the long sightline down the middle is cut twice.
  [-5, 1, 5, 2, 2.6, 'container'], [4, -6, 2, 6, 2.6, 'container'],
  [-8, -8, 5, 2, 2.6, 'container'],
  // Crates: cover on the lanes, low enough to read over, full height
  // for bullets.
  [-14, 12, 3, 3, 1.2, 'crate'], [12, 12, 3, 3, 1.2, 'crate'],
  [-18, 2, 2, 2, 1.2, 'crate'], [16, 2, 2, 2, 1.2, 'crate'],
  [-2, 18, 4, 2, 1.2, 'crate'], [12, 18, 2, 2, 1.2, 'crate'],
  [-26, 0, 3, 3, 1.2, 'crate'], [24, -4, 3, 3, 1.2, 'crate'],
  [-8, -18, 3, 2, 1.2, 'crate'], [8, -18, 3, 2, 1.2, 'crate'],
  // Long walls that split the yard into lanes.
  [-12, -6, 1, 6, 3, 'wall'], [12, 9, 1, 6, 3, 'wall'],
  [-2, -14, 8, 1, 3, 'wall'], [6, -12, 1, 8, 3, 'wall'],
  // The mid block: tall enough to cut the spawn-to-spawn sightline, so
  // nobody opens fire from their own spawn.
  [0, 0, 2, 1.5, 4, 'block'],
];

// Waypoint graph the bots walk. Nodes are cover-to-cover hops; edges are
// straight walks that clear every solid (checked against SOLIDS above).
const NODES = [
  [0, 22], [-8, 16], [8, 16], [0, 10], [-4, 4], [4, 4], [0, -2],
  [-10, -2], [10, -2], [-16, 6], [-22, -2], [-24, -11], [-16, -11],
  [16, 6], [20, -2], [24, -11], [16, -11], [0, -20], [-10, -16],
  [10, -16], [0, -10], [-20, -20.5], [20, -18], [-14, -12], [14, -12],
  [-16, -5],
];
const EDGES = [
  [0, 1], [0, 2], [0, 3], [1, 3], [2, 3], [3, 4], [3, 5], [4, 6], [5, 6],
  [4, 7], [5, 8], [1, 9], [9, 10], [10, 11], [9, 25], [25, 10], [25, 11],
  [25, 12], [12, 23], [23, 25], [7, 10], [13, 8], [13, 14], [14, 16],
  [15, 16], [16, 24], [24, 15], [6, 20], [17, 18], [17, 19], [18, 21],
  [19, 22], [18, 23], [19, 24], [21, 23], [8, 24],
];

function buildGraph() {
  const adjacency = NODES.map(() => []);
  for (const [a, b] of EDGES) {
    adjacency[a].push(b);
    adjacency[b].push(a);
  }
  return adjacency;
}

// Breadth-first route through the graph; the path is short (26 nodes)
// and the call is rare (once per bot order), so no heap is needed.
export function findRoute(adjacency, from, to) {
  if (from === to) return [to];
  const prev = new Array(NODES.length).fill(-1);
  const queue = [from];
  prev[from] = from;
  while (queue.length > 0) {
    const node = queue.shift();
    for (const next of adjacency[node]) {
      if (prev[next] !== -1) continue;
      prev[next] = node;
      if (next === to) {
        const path = [to];
        let at = to;
        while (at !== from) {
          at = prev[at];
          path.unshift(at);
        }
        return path;
      }
      queue.push(next);
    }
  }
  return [to];
}

export function createWorld(scene) {
  const textures = makeTextures(7);
  const materials = {
    ground: new THREE.MeshStandardMaterial({ map: textures.ground, roughness: 0.95, metalness: 0 }),
    wall: new THREE.MeshStandardMaterial({ map: textures.wall, roughness: 0.8, metalness: 0.35 }),
    block: new THREE.MeshStandardMaterial({ map: textures.block, roughness: 0.9, metalness: 0.05 }),
    crate: new THREE.MeshStandardMaterial({ map: textures.crate, roughness: 0.85, metalness: 0.05 }),
    container: new THREE.MeshStandardMaterial({ map: textures.container, roughness: 0.6, metalness: 0.5 }),
    hazard: new THREE.MeshStandardMaterial({ map: textures.hazard, roughness: 0.9, metalness: 0 }),
    tank: new THREE.MeshStandardMaterial({ color: 0x8a7a5a, roughness: 0.45, metalness: 0.7 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x2a2118, roughness: 0.9, metalness: 0.2 }),
  };

  const colliders = [];
  const shootables = [];
  const group = new THREE.Group();
  group.name = 'world';

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(68, 52), materials.ground);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  group.add(ground);

  const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
  for (const [x, z, w, d, h, material] of SOLIDS) {
    const mesh = new THREE.Mesh(boxGeometry, materials[material]);
    mesh.position.set(x, h / 2, z);
    mesh.scale.set(w, h, d);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.solid = true;
    group.add(mesh);
    shootables.push(mesh);
    colliders.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, height: h });
  }

  // Site B tanks: cylinders the bots treat as their box colliders.
  const tankGeometry = new THREE.CylinderGeometry(2.2, 2.2, 3.4, 20);
  for (const [x, z] of [[26, -14], [22, -16.5]]) {
    const tank = new THREE.Mesh(tankGeometry, materials.tank);
    tank.position.set(x, 1.7, z);
    tank.castShadow = true;
    tank.receiveShadow = true;
    tank.userData.solid = true;
    group.add(tank);
    shootables.push(tank);
    colliders.push({ minX: x - 2.2, maxX: x + 2.2, minZ: z - 2.2, maxZ: z + 2.2, height: 3.4 });
  }

  // Hazard ground at each site, and a beacon pole so the site reads
  // from across the yard.
  const sites = {
    A: { center: { x: -24, z: -13 }, radius: 4.5, letter: 'A' },
    B: { center: { x: 24, z: -13 }, radius: 4.5, letter: 'B' },
  };
  const hazardGeometry = new THREE.PlaneGeometry(9, 9);
  const poleGeometry = new THREE.CylinderGeometry(0.09, 0.09, 4.4, 8);
  for (const site of Object.values(sites)) {
    const pad = new THREE.Mesh(hazardGeometry, materials.hazard);
    pad.rotation.x = -Math.PI / 2;
    pad.position.set(site.center.x, 0.02, site.center.z);
    pad.receiveShadow = true;
    group.add(pad);
    const pole = new THREE.Mesh(poleGeometry, materials.dark);
    pole.position.set(site.center.x + 4.2, 2.2, site.center.z + 4.2);
    group.add(pole);
    const beacon = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 12, 8),
      new THREE.MeshStandardMaterial({ color: 0xff9a2a, emissive: 0xff7a00, emissiveIntensity: 2.2 }),
    );
    beacon.position.set(site.center.x + 4.2, 4.5, site.center.z + 4.2);
    group.add(beacon);
  }

  // Floodlight poles down mid: the only point lights in the scene.
  const lampGeometry = new THREE.CylinderGeometry(0.12, 0.12, 6, 8);
  for (const [x, z] of [[-6, 8], [6, -4]]) {
    const pole = new THREE.Mesh(lampGeometry, materials.dark);
    pole.position.set(x, 3, z);
    group.add(pole);
    const head = new THREE.Mesh(
      new THREE.BoxGeometry(0.9, 0.25, 0.5),
      new THREE.MeshStandardMaterial({ color: 0xffe6b0, emissive: 0xffd88a, emissiveIntensity: 1.6 }),
    );
    head.position.set(x, 6, z);
    group.add(head);
    const light = new THREE.PointLight(0xffd9a0, 30, 26, 1.8);
    light.position.set(x, 5.6, z);
    group.add(light);
  }

  scene.add(group);
  const adjacency = buildGraph();

  return {
    colliders,
    shootables,
    bounds: BOUNDS,
    sites,
    spawnAttack: { x: 0, z: 22 },
    spawnDefend: { x: 0, z: -20 },
    nodes: NODES,
    adjacency,
    nearestNode(x, z) {
      let best = 0;
      let bestDist = Infinity;
      for (let i = 0; i < NODES.length; i += 1) {
        const d = dist2D(x, z, NODES[i][0], NODES[i][1]);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      }
      return best;
    },
    // Push a ground circle out of every solid it overlaps. The caller
    // moves one axis at a time, so this runs per axis and never tunnels.
    resolveCircle(position, radius) {
      for (const c of colliders) {
        if (position.x + radius <= c.minX || position.x - radius >= c.maxX) continue;
        if (position.z + radius <= c.minZ || position.z - radius >= c.maxZ) continue;
        const pushLeft = position.x + radius - c.minX;
        const pushRight = c.maxX - (position.x - radius);
        const pushUp = position.z + radius - c.minZ;
        const pushDown = c.maxZ - (position.z - radius);
        const smallest = Math.min(pushLeft, pushRight, pushUp, pushDown);
        if (smallest === pushLeft) position.x = c.minX - radius;
        else if (smallest === pushRight) position.x = c.maxX + radius;
        else if (smallest === pushUp) position.z = c.minZ - radius;
        else position.z = c.maxZ + radius;
      }
      position.x = Math.max(BOUNDS.minX + radius, Math.min(BOUNDS.maxX - radius, position.x));
      position.z = Math.max(BOUNDS.minZ + radius, Math.min(BOUNDS.maxZ - radius, position.z));
    },
  };
}
