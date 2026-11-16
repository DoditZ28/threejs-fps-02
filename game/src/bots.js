// The bots: seven of them, three Ember beside the player and four Slate
// across the yard. Each one is a small state machine — route, hold,
// engage, plant, defuse — walking a waypoint graph, seeing through a
// raycast, hearing gunfire, and shooting back in bursts with a reaction
// delay and an aim error that grows with range and movement. They never
// know where you are until they can see you (or hear you shoot).
import * as THREE from 'three';
import { createLoadout, damageAt } from './weapons.js';
import { findRoute } from './world.js';
import { angleLerp, dist2D, mulberry32 } from './util.js';

const BOT_NAMES = {
  ember: ['Ash', 'Cinder', 'Flint'],
  slate: ['Gravel', 'Iron', 'Mica', 'Basalt'],
};
const TEAM_COLOR = { ember: 0xff9a2a, slate: 0x3fb6c9 };
const TEAM_CSS = { ember: '#ff9a2a', slate: '#3fb6c9' };

const bodyGeometry = new THREE.CapsuleGeometry(0.32, 0.85, 6, 12);
const headGeometry = new THREE.SphereGeometry(0.21, 14, 10);
const visorGeometry = new THREE.BoxGeometry(0.3, 0.09, 0.06);
const gunGeometry = new THREE.BoxGeometry(0.08, 0.11, 0.68);
const bandGeometry = new THREE.CylinderGeometry(0.34, 0.34, 0.1, 12);
const legGeometry = new THREE.BoxGeometry(0.16, 0.55, 0.2);

function teamMaterials(team) {
  return {
    body: new THREE.MeshStandardMaterial({ color: team === 'ember' ? 0x4a3421 : 0x24383e, roughness: 0.85 }),
    trim: new THREE.MeshStandardMaterial({ color: TEAM_COLOR[team], roughness: 0.4, metalness: 0.3, emissive: TEAM_COLOR[team], emissiveIntensity: 0.35 }),
    head: new THREE.MeshStandardMaterial({ color: 0x2c2620, roughness: 0.7 }),
    visor: new THREE.MeshStandardMaterial({ color: TEAM_COLOR[team], emissive: TEAM_COLOR[team], emissiveIntensity: 1.4 }),
    gun: new THREE.MeshStandardMaterial({ color: 0x1c1a17, roughness: 0.5, metalness: 0.6 }),
  };
}

export function createBotManager(scene, world, hooks) {
  const random = mulberry32(20261116);
  const bots = [];
  const hitMeshes = [];
  const tmp = new THREE.Vector3();

  function buildMesh(bot) {
    const mats = teamMaterials(bot.team);
    const group = new THREE.Group();
    const body = new THREE.Mesh(bodyGeometry, mats.body);
    body.position.y = 1.0;
    body.castShadow = true;
    body.userData.bot = bot;
    body.userData.part = 'body';
    const head = new THREE.Mesh(headGeometry, mats.head);
    head.position.y = 1.68;
    head.castShadow = true;
    head.userData.bot = bot;
    head.userData.part = 'head';
    const visor = new THREE.Mesh(visorGeometry, mats.visor);
    visor.position.set(0, 1.68, -0.17);
    const band = new THREE.Mesh(bandGeometry, mats.trim);
    band.position.y = 1.32;
    const gun = new THREE.Mesh(gunGeometry, mats.gun);
    gun.position.set(0.26, 1.28, -0.32);
    const legL = new THREE.Mesh(legGeometry, mats.body);
    legL.position.set(-0.14, 0.28, 0);
    const legR = new THREE.Mesh(legGeometry, mats.body);
    legR.position.set(0.14, 0.28, 0);
    group.add(body, head, visor, band, gun, legL, legR);
    group.position.set(bot.position.x, 0, bot.position.z);
    scene.add(group);
    hitMeshes.push(body, head);
    return { group, body, head };
  }

  function makeBot(team, index, role, weaponId) {
    const bot = {
      id: `${team}-${index}`,
      name: BOT_NAMES[team][index],
      team,
      role,
      weapon: createLoadout(weaponId),
      position: { x: 0, z: 0 },
      velocity: { x: 0, z: 0 },
      yaw: 0,
      aimYaw: 0,
      health: 100,
      armor: false,
      alive: true,
      speed: 0,
      state: 'route',
      route: [],
      routeIndex: 0,
      holdUntil: 0,
      holdYaw: 0,
      enemy: null,
      enemyKind: null,
      lastSeen: { x: 0, z: 0, time: -99 },
      reaction: 0,
      burstLeft: 0,
      burstTimer: 0,
      fireCooldown: 0,
      scanTimer: random() * 0.15,
      strafeTimer: 0,
      strafeDir: 1,
      stuckTimer: 0,
      lastProgress: { x: 0, z: 0, time: 0 },
      sidestepUntil: 0,
      sidestepDir: 1,
      investigateUntil: 0,
      investigate: { x: 0, z: 0 },
      channel: null, // { kind: 'plant'|'defuse', progress, need }
      hasBomb: false,
      time: 0,
    };
    bot.mesh = buildMesh(bot);
    bots.push(bot);
    return bot;
  }

  function spawnPositions(team) {
    const base = team === 'ember' ? world.spawnAttack : world.spawnDefend;
    const facing = team === 'ember' ? Math.PI : 0;
    return [
      { x: base.x - 2, z: base.z },
      { x: base.x + 2, z: base.z },
      { x: base.x, z: base.z + (team === 'ember' ? 2 : -2) },
      { x: base.x + 4, z: base.z },
    ].map((p) => ({ ...p, yaw: facing }));
  }

  function assignOrders(round) {
    const ember = bots.filter((b) => b.team === 'ember');
    const slate = bots.filter((b) => b.team === 'slate');
    // Attackers split: two to A, one to B, and the carrier's site is the
    // one the player is walking toward (default A).
    const targets = [11, 15, 11];
    ember.forEach((bot, i) => {
      bot.role = i === 1 ? 'pushB' : 'pushA';
      setRoute(bot, targets[i]);
      bot.state = 'route';
      bot.hasBomb = false;
    });
    const holds = [12, 16, 20, 6];
    slate.forEach((bot, i) => {
      bot.role = i === 3 ? 'roam' : 'hold';
      setRoute(bot, holds[i]);
      bot.state = 'route';
    });
    void round;
  }

  function setRoute(bot, nodeIndex) {
    const from = world.nearestNode(bot.position.x, bot.position.z);
    bot.route = findRoute(world.adjacency, from, nodeIndex);
    bot.routeIndex = 0;
    bot.state = 'route';
  }

  function nodePosition(index) {
    const node = world.nodes[index];
    return { x: node[0], z: node[1] };
  }

  function visibleEnemy(bot, game) {
    // Candidates: the player (if on the other team) and every live bot
    // on the other team. Nearest visible one wins.
    let best = null;
    let bestDist = Infinity;
    const eyeY = 1.5;
    const consider = (x, z, chestY, kind, ref) => {
      const d = dist2D(bot.position.x, bot.position.z, x, z);
      if (d > 48 || d >= bestDist) return;
      const dx = x - bot.position.x;
      const dz = z - bot.position.z;
      const angle = Math.atan2(-dx, -dz);
      let diff = angle - bot.yaw;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      // 120-degree vision cone, or anything closer than 7 m.
      if (Math.abs(diff) > 1.05 && d > 7) return;
      if (!hooks.losClear(bot.position.x, eyeY, bot.position.z, x, chestY, z)) return;
      best = { kind, ref, x, z, chestY, dist: d };
      bestDist = d;
    };
    if (game.player.alive && game.player.team !== bot.team) {
      // The player is a stable target: its ref is the string 'player',
      // never null, so the "new enemy" test below can tell a fresh
      // sighting from the same one it already tracks.
      consider(game.player.position.x, game.player.position.z, game.player.eye - 0.35, 'player', 'player');
    }
    for (const other of bots) {
      if (!other.alive || other.team === bot.team) continue;
      consider(other.position.x, other.position.z, 1.25, 'bot', other);
    }
    return best;
  }

  function startChannel(bot, kind, need) {
    bot.channel = { kind, progress: 0, need };
    bot.state = kind;
  }

  function cancelChannel(bot) {
    bot.channel = null;
    if (bot.state === 'plant' || bot.state === 'defuse') bot.state = 'route';
  }

  function stepBot(bot, dt, game) {
    bot.time += dt;
    if (!bot.alive) return;
    bot.fireCooldown = Math.max(0, bot.fireCooldown - dt);
    bot.burstTimer = Math.max(0, bot.burstTimer - dt);

    // --- Perception, staggered so seven raycasts never land one frame.
    // Nobody fights during the buy phase: the round has not started.
    const combatPhase = game.phase === 'live' || game.phase === 'planted';
    if (!combatPhase && bot.state === 'engage') {
      bot.enemy = null;
      bot.state = 'route';
    }
    bot.scanTimer -= dt;
    if (combatPhase && bot.scanTimer <= 0) {
      bot.scanTimer = 0.15 + random() * 0.05;
      const seen = visibleEnemy(bot, game);
      if (seen) {
        const isNew = !bot.enemy || bot.enemyKind !== seen.kind || bot.enemy !== seen.ref;
        bot.enemy = seen.ref;
        bot.enemyKind = seen.kind;
        bot.lastSeen.x = seen.x;
        bot.lastSeen.z = seen.z;
        bot.lastSeen.time = bot.time;
        if (isNew) {
          bot.reaction = 0.35 + random() * 0.35;
          bot.burstLeft = 0;
        }
        if (bot.channel) cancelChannel(bot);
        bot.state = 'engage';
      } else if (bot.state === 'engage' && bot.time - bot.lastSeen.time > 2) {
        bot.enemy = null;
        bot.state = 'route';
        if (bot.routeIndex >= bot.route.length) setRoute(bot, world.nearestNode(bot.position.x, bot.position.z));
      }
    }

    // --- Bomb channels: standing still, progress, done or interrupted.
    if (bot.channel) {
      const channel = bot.channel;
      channel.progress += dt;
      if (channel.progress >= channel.need) {
        const kind = channel.kind;
        bot.channel = null;
        bot.state = 'route';
        if (kind === 'plant') hooks.onPlantDone(bot);
        else hooks.onDefuseDone(bot);
      }
      return;
    }

    let moveX = 0;
    let moveZ = 0;
    let speed = 0;
    let faceYaw = bot.yaw;

    if (bot.state === 'engage' && bot.enemy) {
      // Face the last seen spot; shoot in bursts once reacted.
      const tx = bot.lastSeen.x;
      const tz = bot.lastSeen.z;
      faceYaw = Math.atan2(-(tx - bot.position.x), -(tz - bot.position.z));
      const d = dist2D(bot.position.x, bot.position.z, tx, tz);
      bot.strafeTimer -= dt;
      if (bot.strafeTimer <= 0) {
        bot.strafeTimer = 0.9 + random() * 1.2;
        bot.strafeDir = random() < 0.5 ? -1 : 1;
      }
      if (bot.reaction > 0) {
        bot.reaction -= dt;
      } else if (bot.burstLeft === 0 && bot.burstTimer <= 0) {
        bot.burstLeft = 3 + ((random() * 3) | 0);
      }
      if (bot.burstLeft > 0 && bot.fireCooldown <= 0 && bot.time - bot.lastSeen.time < 0.6) {
        bot.burstLeft -= 1;
        bot.fireCooldown = bot.weapon.def.fireInterval;
        // Aim error: range, target speed and own movement all open it.
        const targetSpeed = bot.enemyKind === 'player' ? game.player.speed : bot.enemy.speed;
        const error = 0.02 + d * 0.0006 + targetSpeed * 0.004 + bot.speed * 0.005;
        const aim = {
          x: tx + (random() * 2 - 1) * error * d,
          y: 1.25 + (random() * 2 - 1) * error * d * 0.6,
          z: tz + (random() * 2 - 1) * error * d,
        };
        // One in five bursts goes for the head.
        if (random() < 0.2) aim.y = 1.66;
        hooks.fireShot(bot, aim);
      }
      // Strafe sideways; close in past 20 m, back off inside 6 m.
      const fx = -(Math.sin(faceYaw));
      const fz = -(Math.cos(faceYaw));
      const px = -fz * bot.strafeDir;
      const pz = fx * bot.strafeDir;
      const advance = d > 20 ? 1 : d < 6 ? -1 : 0;
      moveX = px * 0.8 + fx * advance * 0.6;
      moveZ = pz * 0.8 + fz * advance * 0.6;
      speed = 2.6;
    } else if (bot.state === 'route') {
      // Investigate a heard shot before resuming the route.
      if (bot.investigateUntil > bot.time) {
        const target = world.nearestNode(bot.investigate.x, bot.investigate.z);
        if (bot.route.length === 0 || bot.route[bot.route.length - 1] !== target) {
          setRoute(bot, target);
        }
      }
      if (bot.routeIndex < bot.route.length) {
        const target = nodePosition(bot.route[bot.routeIndex]);
        const d = dist2D(bot.position.x, bot.position.z, target.x, target.z);
        if (d < 0.7) {
          bot.routeIndex += 1;
        } else {
          const dx = (target.x - bot.position.x) / d;
          const dz = (target.z - bot.position.z) / d;
          moveX = dx;
          moveZ = dz;
          speed = 4.2;
          faceYaw = Math.atan2(-dx, -dz);
        }
      }
      if (bot.routeIndex >= bot.route.length) {
        bot.state = 'hold';
        bot.holdUntil = bot.time + 4 + random() * 6;
        // Hold facing the map centre: the likeliest approach.
        bot.holdYaw = Math.atan2(bot.position.x, bot.position.z);
      }
      // Stuck: no progress while trying to move means a corner; step
      // sideways for a while instead of grinding against the wall.
      const moved = dist2D(bot.position.x, bot.position.z, bot.lastProgress.x, bot.lastProgress.z);
      if (moved < 0.25) {
        bot.stuckTimer += dt;
        if (bot.stuckTimer > 1.2) {
          bot.stuckTimer = 0;
          bot.sidestepUntil = bot.time + 0.7;
          bot.sidestepDir = random() < 0.5 ? -1 : 1;
        }
      } else {
        bot.stuckTimer = 0;
      }
      bot.lastProgress.x = bot.position.x;
      bot.lastProgress.z = bot.position.z;
      bot.lastProgress.time = bot.time;
      if (bot.sidestepUntil > bot.time && speed > 0) {
        const px = -moveZ * bot.sidestepDir;
        const pz = moveX * bot.sidestepDir;
        moveX = px;
        moveZ = pz;
      }
    } else if (bot.state === 'hold') {
      faceYaw = bot.holdYaw;
      if (bot.time >= bot.holdUntil) {
        // Rotate: attackers re-push a site, roamers shuffle, holders
        // stay put and keep watching.
        if (bot.team === 'ember') {
          const site = random() < 0.5 ? 11 : 15;
          setRoute(bot, site);
        } else if (bot.role === 'roam') {
          setRoute(bot, [6, 20, 12, 16][(random() * 4) | 0]);
        } else {
          bot.holdUntil = bot.time + 3 + random() * 4;
        }
      }
    }

    // --- Integrate movement with sliding collision.
    const wishLen = Math.hypot(moveX, moveZ);
    if (wishLen > 0 && speed > 0) {
      const nx = moveX / wishLen;
      const nz = moveZ / wishLen;
      const accel = 30;
      bot.velocity.x += nx * accel * dt;
      bot.velocity.z += nz * accel * dt;
      const current = Math.hypot(bot.velocity.x, bot.velocity.z);
      if (current > speed) {
        bot.velocity.x *= speed / current;
        bot.velocity.z *= speed / current;
      }
    } else {
      bot.velocity.x *= Math.max(0, 1 - dt * 10);
      bot.velocity.z *= Math.max(0, 1 - dt * 10);
    }
    bot.position.x += bot.velocity.x * dt;
    world.resolveCircle(bot.position, 0.38);
    bot.position.z += bot.velocity.z * dt;
    world.resolveCircle(bot.position, 0.38);
    bot.speed = Math.hypot(bot.velocity.x, bot.velocity.z);

    bot.yaw = angleLerp(bot.yaw, faceYaw, Math.min(1, dt * 8));
    bot.mesh.group.position.set(bot.position.x, 0, bot.position.z);
    bot.mesh.group.rotation.y = bot.yaw;
    // A small bob while running, so movement reads on the silhouette.
    const bob = bot.speed > 1 ? Math.sin(bot.time * 11) * 0.03 : 0;
    bot.mesh.group.position.y = bob;
    // Muzzle flash point, for the shooter's tracer origin.
    bot.muzzle = bot.muzzle ?? { x: 0, y: 1.28, z: 0 };
    bot.muzzle.x = bot.position.x - Math.sin(bot.yaw) * 0.7 + Math.cos(bot.yaw) * 0.26;
    bot.muzzle.y = 1.28;
    bot.muzzle.z = bot.position.z - Math.cos(bot.yaw) * 0.7 - Math.sin(bot.yaw) * 0.26;
  }

  function damageBot(bot, amount, attacker) {
    if (!bot.alive) return false;
    const taken = bot.armor ? amount * 0.5 : amount;
    bot.health -= taken;
    if (bot.health <= 0) {
      bot.health = 0;
      bot.alive = false;
      bot.state = 'dead';
      cancelChannel(bot);
      bot.mesh.group.rotation.z = Math.PI / 2;
      bot.mesh.group.position.y = 0.35;
      hooks.onBotDeath(bot, attacker);
      return true;
    }
    // Being shot at reveals the shooter: face them next scan.
    if (attacker) {
      const ax = attacker === 'player' ? hooks.playerPosition().x : attacker.position.x;
      const az = attacker === 'player' ? hooks.playerPosition().z : attacker.position.z;
      bot.lastSeen.x = ax;
      bot.lastSeen.z = az;
      bot.lastSeen.time = bot.time;
      if (bot.state !== 'engage') {
        bot.enemy = attacker === 'player' ? 'player' : attacker;
        bot.enemyKind = attacker === 'player' ? 'player' : 'bot';
        bot.state = 'engage';
        bot.reaction = Math.min(bot.reaction, 0.25);
      }
    }
    return false;
  }

  return {
    bots,
    hitMeshes,
    teamColor: TEAM_CSS,
    resetRound() {
      const emberSpawns = spawnPositions('ember');
      const slateSpawns = spawnPositions('slate');
      const seen = { ember: 0, slate: 0 };
      bots.forEach((bot) => {
        const spawn = (bot.team === 'ember' ? emberSpawns : slateSpawns)[seen[bot.team]];
        seen[bot.team] += 1;
        bot.position.x = spawn.x;
        bot.position.z = spawn.z;
        bot.velocity.x = 0;
        bot.velocity.z = 0;
        bot.yaw = spawn.yaw;
        bot.health = 100;
        bot.alive = true;
        bot.state = 'route';
        bot.route = [];
        bot.routeIndex = 0;
        bot.enemy = null;
        bot.channel = null;
        bot.hasBomb = false;
        bot.weapon = createLoadout(bot.weapon.def.id);
        bot.mesh.group.rotation.set(0, spawn.yaw, 0);
        bot.mesh.group.position.set(spawn.x, 0, spawn.z);
        bot.lastProgress.x = spawn.x;
        bot.lastProgress.z = spawn.z;
        bot.investigateUntil = 0;
      });
      assignOrders(1);
    },
    spawnAll() {
      makeBot('ember', 0, 'pushA', 'rifle');
      makeBot('ember', 1, 'pushB', 'rifle');
      makeBot('ember', 2, 'pushA', 'smg');
      makeBot('slate', 0, 'hold', 'rifle');
      makeBot('slate', 1, 'hold', 'rifle');
      makeBot('slate', 2, 'hold', 'smg');
      makeBot('slate', 3, 'roam', 'sniper');
      this.resetRound();
    },
    step(dt, game) {
      for (const bot of bots) stepBot(bot, dt, game);
    },
    aliveCount(team) {
      return bots.filter((b) => b.team === team && b.alive).length;
    },
    aliveBots(team) {
      return bots.filter((b) => b.team === team && b.alive);
    },
    damage(bot, amount, attacker) {
      return damageBot(bot, amount, attacker);
    },
    notifyNoise(x, z, shooter) {
      for (const bot of bots) {
        if (!bot.alive || bot.state === 'engage') continue;
        if (bot === shooter) continue;
        if (dist2D(bot.position.x, bot.position.z, x, z) > 30) continue;
        bot.investigate.x = x;
        bot.investigate.z = z;
        bot.investigateUntil = bot.time + 6;
      }
    },
    // Orders from the match: the carrier plants, the defence defuses.
    orderPlant(carrier, siteNode) {
      if (!carrier || !carrier.alive) return false;
      carrier.hasBomb = true;
      setRoute(carrier, siteNode);
      return true;
    },
    orderDefuse(siteNode) {
      for (const bot of bots) {
        if (bot.team !== 'slate' || !bot.alive) continue;
        if (bot.channel) continue;
        setRoute(bot, siteNode);
      }
    },
    orderHoldSite(siteNode) {
      for (const bot of bots) {
        if (bot.team !== 'ember' || !bot.alive) continue;
        if (bot.hasBomb) continue;
        setRoute(bot, siteNode);
      }
    },
    tryPlant(bot) {
      if (!bot.alive || bot.channel) return false;
      startChannel(bot, 'plant', 3);
      return true;
    },
    tryDefuse(bot) {
      if (!bot.alive || bot.channel) return false;
      startChannel(bot, 'defuse', 5);
      return true;
    },
    damageAtRange(bot, range, head) {
      return damageAt(bot.weapon.def, range, head);
    },
    setArmor(team, value) {
      for (const bot of bots) if (bot.team === team) bot.armor = value;
    },
  };
}
