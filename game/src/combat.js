// Combat effects and hit resolution. Tracers, impact puffs and the muzzle
// flash are small pools reused every shot, so a firefight allocates
// nothing; the one Raycaster is shared too. Grenades are the only thing
// with a real flight: gravity, a bounce off the floor, a fuse, and then
// a call back to the game to apply the blast.
import * as THREE from 'three';

const TRACER_COUNT = 16;
const PUFF_COUNT = 12;
const TRACER_LIFE = 0.07;

function radialTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
  gradient.addColorStop(0, 'rgba(255,240,200,1)');
  gradient.addColorStop(0.4, 'rgba(255,170,60,0.7)');
  gradient.addColorStop(1, 'rgba(255,120,20,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(canvas);
}

export function createCombat(scene, world) {
  const raycaster = new THREE.Raycaster();
  raycaster.far = 120;
  const origin = new THREE.Vector3();
  const direction = new THREE.Vector3();
  const tmpA = new THREE.Vector3();
  const tmpB = new THREE.Vector3();

  // Tracer pool: one line each, two endpoints, opacity fades with life.
  const tracers = [];
  for (let i = 0; i < TRACER_COUNT; i += 1) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    const material = new THREE.LineBasicMaterial({ color: 0xff9a2a, transparent: true, opacity: 0 });
    const line = new THREE.Line(geometry, material);
    line.frustumCulled = false;
    line.visible = false;
    scene.add(line);
    tracers.push({ line, life: 0 });
  }
  let tracerNext = 0;

  // Impact puffs: sprites that grow and fade.
  const puffTexture = radialTexture();
  const puffs = [];
  for (let i = 0; i < PUFF_COUNT; i += 1) {
    const material = new THREE.SpriteMaterial({ map: puffTexture, transparent: true, opacity: 0, depthWrite: false });
    const sprite = new THREE.Sprite(material);
    sprite.visible = false;
    scene.add(sprite);
    puffs.push({ sprite, life: 0, max: 0.3 });
  }
  let puffNext = 0;

  // Muzzle flash: one sprite plus one light, both driven by a timer.
  const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: puffTexture, transparent: true, opacity: 0, depthWrite: false }));
  flash.scale.set(0.55, 0.55, 1);
  flash.visible = false;
  scene.add(flash);
  const flashLight = new THREE.PointLight(0xffc060, 0, 9, 2);
  scene.add(flashLight);
  let flashLife = 0;

  const grenades = [];
  const grenadeGeometry = new THREE.SphereGeometry(0.09, 10, 8);
  const grenadeMaterial = new THREE.MeshStandardMaterial({ color: 0x2f3a26, roughness: 0.5, metalness: 0.6 });

  function spawnTracer(from, to, color) {
    const tracer = tracers[tracerNext];
    tracerNext = (tracerNext + 1) % TRACER_COUNT;
    const positions = tracer.line.geometry.attributes.position.array;
    positions[0] = from.x;
    positions[1] = from.y;
    positions[2] = from.z;
    positions[3] = to.x;
    positions[4] = to.y;
    positions[5] = to.z;
    tracer.line.geometry.attributes.position.needsUpdate = true;
    tracer.line.material.color.setHex(color);
    tracer.line.material.opacity = 0.9;
    tracer.line.visible = true;
    tracer.life = TRACER_LIFE;
  }

  function spawnPuff(point, big = false) {
    const puff = puffs[puffNext];
    puffNext = (puffNext + 1) % PUFF_COUNT;
    puff.sprite.position.copy(point);
    const size = big ? 1.6 : 0.5;
    puff.sprite.scale.set(size, size, 1);
    puff.sprite.material.opacity = 0.85;
    puff.sprite.visible = true;
    puff.life = big ? 0.6 : 0.3;
    puff.max = puff.life;
  }

  return {
    // Resolve one hitscan shot. `targets` is the flat list of hit meshes
    // (bot bodies and heads); the world meshes are the walls. Returns
    // null on a clean miss, else { point, range, victim, part }.
    shoot(from, dir, targets) {
      origin.set(from.x, from.y, from.z);
      direction.set(dir.x, dir.y, dir.z);
      raycaster.set(origin, direction);
      const wallHit = raycaster.intersectObjects(world.shootables, false)[0] ?? null;
      const targetHit = raycaster.intersectObjects(targets, false)[0] ?? null;
      const wallRange = wallHit ? wallHit.distance : Infinity;
      if (targetHit && targetHit.distance < wallRange) {
        return {
          point: targetHit.point,
          range: targetHit.distance,
          victim: targetHit.object.userData.bot ?? null,
          part: targetHit.object.userData.part ?? 'body',
          blocked: false,
          object: targetHit.object,
        };
      }
      if (wallHit) {
        return { point: wallHit.point, range: wallHit.distance, victim: null, part: null, blocked: true, object: wallHit.object };
      }
      tmpA.copy(origin).addScaledVector(direction, 90);
      return { point: tmpA.clone(), range: 90, victim: null, part: null, blocked: false, object: null };
    },
    tracer(from, to, color) {
      tmpB.set(from.x, from.y, from.z);
      spawnTracer(tmpB, to, color);
    },
    impact(point, big = false) {
      spawnPuff(point, big);
    },
    muzzle(at, gunDir) {
      flash.position.set(at.x, at.y, at.z).addScaledVector(gunDir, 0.55);
      flash.position.y -= 0.06;
      flash.material.opacity = 0.95;
      flash.visible = true;
      flashLife = 0.05;
      flashLight.position.copy(flash.position);
      flashLight.intensity = 14;
    },
    throwGrenade(from, dir) {
      const mesh = new THREE.Mesh(grenadeGeometry, grenadeMaterial);
      mesh.position.set(from.x, from.y, from.z);
      scene.add(mesh);
      grenades.push({
        mesh,
        velocity: { x: dir.x * 13, y: dir.y * 13 + 3.2, z: dir.z * 13 },
        fuse: 1.6,
      });
    },
    // Step grenades; onExplode(position) is the game's job (damage,
    // sound, camera shake) so this module never learns about actors.
    stepGrenades(dt, onExplode) {
      for (let i = grenades.length - 1; i >= 0; i -= 1) {
        const g = grenades[i];
        g.velocity.y -= 14 * dt;
        g.mesh.position.x += g.velocity.x * dt;
        g.mesh.position.y += g.velocity.y * dt;
        g.mesh.position.z += g.velocity.z * dt;
        const p = g.mesh.position;
        if (p.y < 0.09) {
          p.y = 0.09;
          g.velocity.y *= -0.35;
          g.velocity.x *= 0.7;
          g.velocity.z *= 0.7;
        }
        const probe = { x: p.x, z: p.z };
        world.resolveCircle(probe, 0.1);
        if (probe.x !== p.x || probe.z !== p.z) {
          p.x = probe.x;
          p.z = probe.z;
          g.velocity.x *= -0.4;
          g.velocity.z *= -0.4;
        }
        g.fuse -= dt;
        if (g.fuse <= 0) {
          const at = p.clone();
          scene.remove(g.mesh);
          grenades.splice(i, 1);
          spawnPuff(at, true);
          flashLight.position.copy(at);
          flashLight.intensity = 60;
          flashLife = 0.12;
          onExplode(at);
        }
      }
    },
    step(dt) {
      for (const tracer of tracers) {
        if (tracer.life <= 0) continue;
        tracer.life -= dt;
        tracer.line.material.opacity = Math.max(0, tracer.life / TRACER_LIFE) * 0.9;
        if (tracer.life <= 0) tracer.line.visible = false;
      }
      for (const puff of puffs) {
        if (puff.life <= 0) continue;
        puff.life -= dt;
        const k = Math.max(0, puff.life / puff.max);
        puff.sprite.material.opacity = k * 0.85;
        const s = puff.sprite.scale.x + dt * 2.2;
        puff.sprite.scale.set(s, s, 1);
        if (puff.life <= 0) puff.sprite.visible = false;
      }
      if (flashLife > 0) {
        flashLife -= dt;
        flash.material.opacity = Math.max(0, flashLife / 0.05) * 0.95;
        flashLight.intensity = Math.max(0, flashLife / 0.12) * 60;
        if (flashLife <= 0) {
          flash.visible = false;
          flashLight.intensity = 0;
        }
      }
    },
  };
}
