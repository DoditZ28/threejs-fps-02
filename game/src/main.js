// EMBERLINE — boot and the one loop: a fixed 60 Hz simulation feeding a
// render at the display's rate. The game owns one state object; the
// modules own their pieces. ?shot=start|play|plant|end with &seed=N sets
// up a deterministic frame for a capture, renders it twice, then freezes
// it and sets window.__shotReady.
import * as THREE from 'three';
import { PALETTE } from './palette.js';
import { mulberry32, clamp, dist2D } from './util.js';
import { createWorld } from './world.js';
import { createInput } from './input.js';
import { createPlayer } from './player.js';
import { createBotManager } from './bots.js';
import { createCombat } from './combat.js';
import { createMatch, SHOP, FUSE_TIME, PLANT_TIME } from './rounds.js';
import { createHud } from './hud.js';
import { createAudio } from './audio.js';
import { GRENADE, createLoadout, weaponSpread, damageAt } from './weapons.js';

const FIXED_STEP = 1 / 60;
const params = new URLSearchParams(window.location.search);
const shot = params.get('shot');
const seed = Number.parseInt(params.get('seed') ?? '1', 10) || 1;
const random = mulberry32(seed * 7919 + 13);

// --- Renderer, scene, camera ---------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.getElementById('game').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(PALETTE.canvas);
scene.fog = new THREE.Fog(new THREE.Color(PALETTE.canvas), 24, 78);
const camera = new THREE.PerspectiveCamera(74, window.innerWidth / window.innerHeight, 0.05, 160);
scene.add(camera);

const hemi = new THREE.HemisphereLight(0xffd9b0, 0x2a2118, 0.85);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffb36b, 2.2);
sun.position.set(28, 34, 14);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -45;
sun.shadow.camera.right = 45;
sun.shadow.camera.top = 40;
sun.shadow.camera.bottom = -40;
sun.shadow.camera.far = 120;
sun.shadow.bias = -0.0004;
scene.add(sun);

// --- World, actors, systems ------------------------------------------------
const world = createWorld(scene);
const combat = createCombat(scene, world);
const audio = createAudio();
const hud = createHud();
const player = createPlayer(world);
const losRaycaster = new THREE.Raycaster();
losRaycaster.far = 120;

const game = {
  started: false,
  frozen: false,
  primaryId: 'rifle',
  primary: createLoadout('rifle'),
  pistol: createLoadout('pistol'),
  slot: 1, // 1 primary, 2 pistol
  grenades: 0,
  switchCooldown: 0,
  plant: null, // { site, progress }
  lastDamageAt: -99,
  time: 0,
  beepTimer: 0,
  buyOpen: false,
};

function currentLoadout() {
  return game.slot === 1 ? game.primary : game.pistol;
}

// The player's own hit meshes: invisible to the eye (colorWrite off),
// solid to a raycast, so bot fire resolves against the same code path
// as the player's fire.
const playerBodyMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
playerBodyMat.colorWrite = false;
const playerBody = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.38, 1.7, 10), playerBodyMat);
const playerHead = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), playerBodyMat);
playerBody.userData.player = true;
playerBody.userData.part = 'body';
playerHead.userData.player = true;
playerHead.userData.part = 'head';
scene.add(playerBody, playerHead);

// The planted bomb: a small dark case with a blinking light, so the
// objective is visible in the world, not only on the HUD.
const bombMesh = new THREE.Group();
const bombCase = new THREE.Mesh(
  new THREE.BoxGeometry(0.42, 0.16, 0.3),
  new THREE.MeshStandardMaterial({ color: 0x1c1a17, roughness: 0.4, metalness: 0.7 }),
);
bombCase.position.y = 0.08;
const bombLightMat = new THREE.MeshStandardMaterial({ color: 0xff9a2a, emissive: 0xff7a00, emissiveIntensity: 2 });
const bombLight = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), bombLightMat);
bombLight.position.set(0.12, 0.2, 0);
bombMesh.add(bombCase, bombLight);
bombMesh.visible = false;
scene.add(bombMesh);
const viewmodel = new THREE.Group();
const gunMetal = new THREE.MeshStandardMaterial({ color: 0x1c1a17, roughness: 0.45, metalness: 0.65 });
const gunAccent = new THREE.MeshStandardMaterial({ color: 0xff9a2a, roughness: 0.4, metalness: 0.4, emissive: 0xff9a2a, emissiveIntensity: 0.25 });
const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.13, 0.52), gunMetal);
const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.34, 8), gunMetal);
barrel.rotation.x = Math.PI / 2;
barrel.position.set(0, 0.02, -0.4);
const magazine = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.16, 0.09), gunMetal);
magazine.position.set(0, -0.12, -0.05);
magazine.rotation.x = 0.2;
const sight = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.05, 0.08), gunAccent);
sight.position.set(0, 0.09, -0.1);
viewmodel.add(receiver, barrel, magazine, sight);
viewmodel.position.set(0.27, -0.24, -0.5);
camera.add(viewmodel);
let viewKick = 0;
let walkCycle = 0;

const shootTargets = [];
const muzzleWorld = new THREE.Vector3();
const aimDir = new THREE.Vector3();
const losFrom = new THREE.Vector3();
const losTo = new THREE.Vector3();

function syncPlayerMeshes() {
  const p = player.state;
  playerBody.position.set(p.position.x, 0.85, p.position.z);
  playerBody.scale.y = p.crouched ? 0.62 : 1;
  playerBody.position.y = p.crouched ? 0.53 : 0.85;
  playerHead.position.set(p.position.x, p.eye - 0.12, p.position.z);
}

function syncCamera() {
  const p = player.state;
  camera.position.set(p.position.x, p.eye, p.position.z);
  camera.rotation.set(player.aimPitch(), player.aimYaw(), 0, 'YXZ');
  const targetFov = p.aiming ? 58 : 74;
  if (Math.abs(camera.fov - targetFov) > 0.05) {
    camera.fov += (targetFov - camera.fov) * 0.2;
    camera.updateProjectionMatrix();
  }
  syncPlayerMeshes();
}

function collectShootTargets() {
  shootTargets.length = 0;
  for (const bot of bots.bots) {
    if (!bot.alive) continue;
    shootTargets.push(bot.mesh.body, bot.mesh.head);
  }
  if (player.state.alive) shootTargets.push(playerBody, playerHead);
  return shootTargets;
}

function losClear(ax, ay, az, bx, by, bz) {
  losFrom.set(ax, ay, az);
  losTo.set(bx, by, bz);
  const dist = losFrom.distanceTo(losTo);
  aimDir.copy(losTo).sub(losFrom).normalize();
  losRaycaster.set(losFrom, aimDir);
  losRaycaster.far = dist;
  const hit = losRaycaster.intersectObjects(world.shootables, false)[0];
  return !hit;
}

// --- Match -----------------------------------------------------------------
const match = createMatch({
  onRoundStart(round) {
    resetPositions();
    game.primary = createLoadout(game.primaryId);
    game.primary.mag = game.primary.def.mag;
    game.primary.reserve = game.primary.def.reserve;
    game.pistol = createLoadout('pistol');
    game.slot = 1;
    game.grenades = 0;
    game.plant = null;
    player.state.armor = false;
    hud.setBuyItems(SHOP, match.state.money);
    hud.setPhase('BUY PHASE — PRESS B');
    hud.setBomb(null);
    hud.setChannel(null, null);
    hud.setHint('');
    // Hide the round overlay on auto-advance, but never at boot: the
    // start overlay stays until the player deploys.
    if (game.started) hud.hideOverlay();
    bombMesh.visible = false;
    updateWeaponHud();
    if (!shot) hud.toast(`Round ${round} — buy phase, press B to shop`);
  },
  onLiveStart() {
    hud.setPhase('LIVE');
    hud.showBuy(false);
    game.buyOpen = false;
    audio.roundStart();
    if (!shot) hud.toast('Round live — plant the bomb or eliminate Slate');
  },
  onBombPlanted(site) {
    hud.setPhase(`BOMB PLANTED — SITE ${site}`);
    hud.toast(`Bomb planted at Site ${site} — defend it`);
    audio.plantBeep(true);
    const center = world.sites[site].center;
    bombMesh.position.set(center.x, 0, center.z);
    bombMesh.visible = true;
    const node = site === 'A' ? 11 : 15;
    bots.orderDefuse(node);
    bots.orderHoldSite(node);
    game.beepTimer = 0;
  },
  onRoundEnd(winner, reason, score) {
    const title = winner === 'ember' ? 'Round to Ember' : 'Round to Slate';
    hud.showOverlay('round', {
      title,
      sub: reason,
      score: `EMBER ${score.ember} — ${score.slate} SLATE`,
    });
    hud.setPhase(winner === 'ember' ? 'ROUND WON' : 'ROUND LOST');
    audio.roundEnd(winner === 'ember');
    if (document.pointerLockElement) document.exitPointerLock();
  },
  onMatchEnd(winner, score) {
    hud.showOverlay('match', {
      title: winner === 'ember' ? 'Ember wins the match' : 'Slate wins the match',
      sub: `Final score — EMBER ${score.ember} — ${score.slate} SLATE. The yard is yours either way: play again?`,
    });
    audio.roundEnd(winner === 'ember');
  },
  onTeamWiped(team) {
    hud.toast(team === 'ember' ? 'Ember wiped — Slate must still defuse' : 'Slate wiped');
  },
});

// --- Bots ------------------------------------------------------------------
const bots = createBotManager(scene, world, {
  losClear,
  playerPosition() {
    return player.state.position;
  },
  fireShot(bot, aim) {
    // A bot's shot: from its muzzle toward its aim point, with its own
    // spread folded in by the aim error it already applied.
    const from = bot.muzzle;
    aimDir.set(aim.x - from.x, aim.y - from.y, aim.z - from.z).normalize();
    const result = combat.shoot(from, aimDir, collectShootTargets());
    combat.tracer(from, result.point, bot.weapon.def.tracer);
    combat.muzzle(from, aimDir);
    audio.shot(bot.weapon.def.id, true);
    if (result.object && result.object.userData.player) {
      const head = result.object.userData.part === 'head';
      const amount = damageAt(bot.weapon.def, result.range, head);
      killPlayer(amount, bot);
    } else if (result.victim && result.victim.team !== bot.team) {
      const head = result.part === 'head';
      const amount = damageAt(bot.weapon.def, result.range, head);
      killBot(result.victim, amount, bot);
    } else if (result.blocked) {
      combat.impact(result.point);
    }
  },
  onBotDeath(bot, attacker) {
    const killer = attacker === 'player' ? 'YOU' : attacker === 'bot' ? '???' : attacker.name;
    const killerTeam = attacker === 'player' ? 'ember' : attacker.team;
    hud.killfeed(killerTeam, killer, bot.team, bot.name, false);
    if (attacker === 'player') {
      match.awardKill();
      hud.setMoney(match.state.money);
    }
    // The bomb changes hands: the nearest live Ember bot carries on.
    if (bot.hasBomb) {
      bot.hasBomb = false;
      const carrier = bots.aliveBots('ember')[0];
      if (carrier) {
        const siteNode = dist2D(carrier.position.x, carrier.position.z, -24, -13) < dist2D(carrier.position.x, carrier.position.z, 24, -13) ? 11 : 15;
        bots.orderPlant(carrier, siteNode);
        match.state.bomb.carrier = carrier.id;
      }
    }
    checkElimination();
  },
  onPlantDone(bot) {
    const site = match.siteAt(bot.position.x, bot.position.z, world.sites);
    if (site) match.plantBomb(site);
  },
  onDefuseDone() {
    match.defuseBomb();
    hud.toast('Bomb defused — round to Slate');
  },
});
bots.spawnAll();

function killBot(bot, amount, attacker) {
  const killed = bots.damage(bot, amount, attacker);
  if (killed) return;
  // Non-lethal hit: nothing else to show; the hitmarker is the shooter's.
}

function killPlayer(amount, attacker) {
  if (!player.state.alive) return;
  const died = player.damage(amount);
  game.lastDamageAt = game.time;
  hud.damageFlash();
  audio.hurt();
  if (died) {
    hud.killfeed(attacker.team, attacker.name, 'ember', 'YOU', false);
    hud.setHint('You were eliminated — your squad fights on.');
    if (document.pointerLockElement) document.exitPointerLock();
    // The bomb drops to the nearest live Ember bot.
    if (match.state.bomb.carrier === 'player') {
      const carrier = bots.aliveBots('ember')[0];
      if (carrier) {
        const siteNode = dist2D(carrier.position.x, carrier.position.z, -24, -13) < dist2D(carrier.position.x, carrier.position.z, 24, -13) ? 11 : 15;
        bots.orderPlant(carrier, siteNode);
        match.state.bomb.carrier = carrier.id;
      }
    }
    checkElimination();
  }
}

function checkElimination() {
  const ember = bots.aliveCount('ember') + (player.state.alive ? 1 : 0);
  const slate = bots.aliveCount('slate');
  match.reportElimination({ ember, slate });
}

function resetPositions() {
  const spawn = world.spawnAttack;
  player.reset(spawn.x, spawn.z, 0);
  bots.resetRound();
  syncCamera();
}

// --- Player shooting ---------------------------------------------------------
function muzzlePosition() {
  // From the player's state, not the camera's matrix: the matrix is a
  // frame behind the state whenever the mouse just moved.
  const p = player.state;
  const yaw = player.aimYaw();
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const rx = Math.cos(yaw);
  const rz = -Math.sin(yaw);
  muzzleWorld.set(
    p.position.x + fx * 0.9 + rx * 0.27,
    p.eye - 0.18,
    p.position.z + fz * 0.9 + rz * 0.27,
  );
  return muzzleWorld;
}

function shoot(spreadOverride = null) {
  const loadout = currentLoadout();
  const def = loadout.def;
  if (loadout.cooldown > 0 || loadout.reloadLeft > 0) return false;
  if (loadout.mag <= 0) {
    audio.dryFire();
    startReload();
    return false;
  }
  loadout.cooldown = def.fireInterval;
  loadout.mag -= 1;
  loadout.bloom = Math.min(loadout.bloom + def.bloom, 0.03);
  const spread = spreadOverride ?? weaponSpread(loadout, player.state.speed, player.state.crouched, player.state.aiming);
  const p = player.state;
  const cp = Math.cos(player.aimPitch());
  aimDir.set(-Math.sin(player.aimYaw()) * cp, Math.sin(player.aimPitch()), -Math.cos(player.aimYaw()) * cp);
  aimDir.x += (random() * 2 - 1) * spread;
  aimDir.y += (random() * 2 - 1) * spread;
  aimDir.z += (random() * 2 - 1) * spread;
  aimDir.normalize();
  const from = muzzlePosition();
  const result = combat.shoot(from, aimDir, collectShootTargets());
  game.lastShot = {
    victim: result.victim ? result.victim.name : null,
    part: result.part,
    range: result.range,
    blocked: result.blocked,
    point: { x: result.point.x, y: result.point.y, z: result.point.z },
  };
  combat.tracer(from, result.point, def.tracer);
  combat.muzzle(from, aimDir);
  if (result.victim) {
    const head = result.part === 'head';
    const amount = damageAt(def, result.range, head);
    const killed = bots.damage(result.victim, amount, 'player');
    hud.hitmarker(killed);
    audio.hit(killed);
    if (killed) {
      hud.killfeed('ember', 'YOU', result.victim.team, result.victim.name, head);
      match.awardKill();
      hud.setMoney(match.state.money);
      checkElimination();
    }
  } else if (result.blocked) {
    combat.impact(result.point);
  }
  player.recoil(def.kick * (0.85 + random() * 0.3), (random() * 2 - 1) * def.kick * 0.45);
  viewKick = Math.min(viewKick + def.kick * 2.2, 0.09);
  audio.shot(def.id);
  bots.notifyNoise(player.state.position.x, player.state.position.z, 'player');
  updateWeaponHud();
  return true;
}

function startReload() {
  const loadout = currentLoadout();
  if (loadout.reloadLeft > 0 || loadout.mag >= loadout.def.mag || loadout.reserve <= 0) return;
  loadout.reloadLeft = loadout.def.reloadTime;
  audio.reload();
  updateWeaponHud();
}

function throwGrenade() {
  if (game.grenades <= 0) return;
  if (match.state.phase !== 'live' && match.state.phase !== 'planted') return;
  game.grenades -= 1;
  const p = player.state;
  const cp = Math.cos(player.aimPitch());
  aimDir.set(-Math.sin(player.aimYaw()) * cp, Math.sin(player.aimPitch()), -Math.cos(player.aimYaw()) * cp);
  combat.throwGrenade(muzzlePosition(), aimDir);
  audio.shot('smg');
  hud.toast(game.grenades > 0 ? `Grenade away — ${game.grenades} left` : 'Grenade away');
}

function explodeGrenade(at) {
  audio.explosion();
  const radius = GRENADE.radius;
  // The player.
  if (player.state.alive) {
    const d = dist2D(player.state.position.x, player.state.position.z, at.x, at.z);
    if (d < radius) {
      const amount = GRENADE.damage * (1 - (d / radius) * 0.7);
      killPlayer(amount, { team: 'ember', name: 'YOU' });
    }
  }
  for (const bot of bots.bots) {
    if (!bot.alive) continue;
    const d = dist2D(bot.position.x, bot.position.z, at.x, at.z);
    if (d >= radius) continue;
    const amount = GRENADE.damage * (1 - (d / radius) * 0.7);
    const killed = bots.damage(bot, amount, 'player');
    if (killed) {
      hud.killfeed('ember', 'YOU', bot.team, bot.name, false);
      match.awardKill();
      hud.setMoney(match.state.money);
      checkElimination();
    }
  }
}

// --- Buy ---------------------------------------------------------------------
function buyItem(itemId) {
  const item = match.buy(itemId);
  if (!item) {
    hud.toast('Not enough money — or the buy phase is over');
    return;
  }
  if (item.kind === 'primary') {
    game.primaryId = item.id;
    game.primary = createLoadout(item.id);
    game.slot = 1;
  } else if (item.kind === 'grenade') {
    game.grenades = Math.min(game.grenades + 1, 2);
  } else if (item.kind === 'armor') {
    player.state.armor = true;
  }
  audio.buy();
  hud.setMoney(match.state.money);
  hud.setBuyItems(SHOP, match.state.money);
  hud.toast(`${item.name} bought`);
  updateWeaponHud();
}

function updateWeaponHud() {
  const loadout = currentLoadout();
  hud.setAmmo(loadout.mag, loadout.reserve, loadout.reloadLeft > 0);
  hud.setMoney(match.state.money);
  document.getElementById('weapon-name').textContent = loadout.def.name;
}

// --- Input -------------------------------------------------------------------
const input = createInput(renderer.domElement, (locked) => {
  if (shot) return;
  if (locked) {
    game.started = true;
    hud.hideOverlay();
    audio.unlock();
  } else if (match.state.phase === 'matchover') {
    hud.showOverlay('match', {
      title: match.state.winner === 'ember' ? 'Ember wins the match' : 'Slate wins the match',
      sub: `Final score — EMBER ${match.state.score.ember} — ${match.state.score.slate} SLATE.`,
    });
  } else if (match.state.phase === 'over') {
    // Round overlay already shown by onRoundEnd; keep it.
  } else if (!game.buyOpen) {
    hud.showOverlay(game.started ? 'paused' : 'start');
  }
});

hud.onPlay(() => {
  if (shot) return;
  audio.unlock();
  input.requestLock();
});
hud.onResume(() => {
  if (shot) return;
  input.requestLock();
});
hud.onRestart(() => {
  if (match.state.phase === 'over') match.nextRound();
  hud.hideOverlay();
  if (!shot) input.requestLock();
});
const againButton = document.getElementById('play-again-button');
if (againButton) {
  againButton.addEventListener('click', () => {
    match.startMatch();
    hud.hideOverlay();
    if (!shot) input.requestLock();
  });
}
document.addEventListener('emberline-buy', (event) => buyItem(event.detail));

// --- Fixed-step simulation ---------------------------------------------------
function step(dt) {
  game.time += dt;
  const phase = match.state.phase;
  const live = phase === 'live' || phase === 'planted';

  // Plant channel: standing still on a site, holding the bomb.
  if (game.plant) {
    const site = match.siteAt(player.state.position.x, player.state.position.z, world.sites);
    const moved = player.state.speed > 0.6;
    if (!player.state.alive || site !== game.plant.site || moved || game.time - game.lastDamageAt < 0.5) {
      game.plant = null;
      hud.setChannel(null, null);
      hud.setHint('');
    } else {
      game.plant.progress += dt;
      hud.setChannel('PLANTING BOMB', game.plant.progress / PLANT_TIME);
      if (game.plant.progress >= PLANT_TIME) {
        const plantedSite = game.plant.site;
        game.plant = null;
        hud.setChannel(null, null);
        match.plantBomb(plantedSite);
      }
    }
  }

  // Bots carry the bomb on when the player cannot.
  if (live) {
    for (const bot of bots.bots) {
      if (!bot.alive || !bot.hasBomb || bot.channel) continue;
      if (bot.routeIndex >= bot.route.length) {
        const site = match.siteAt(bot.position.x, bot.position.z, world.sites);
        if (site) bots.tryPlant(bot);
      }
    }
    // Defenders defuse when the site is clear of live attackers.
    if (match.state.bomb.planted) {
      const site = world.sites[match.state.bomb.site];
      const near = bots.aliveBots('ember').some((b) => dist2D(b.position.x, b.position.z, site.center.x, site.center.z) < 12)
        || (player.state.alive && dist2D(player.state.position.x, player.state.position.z, site.center.x, site.center.z) < 12);
      if (!near) {
        for (const bot of bots.aliveBots('slate')) {
          if (bot.channel) continue;
          if (dist2D(bot.position.x, bot.position.z, site.center.x, site.center.z) < 2.5) {
            bots.tryDefuse(bot);
            break;
          }
        }
      }
      // The bomb beeps, faster as the fuse runs down.
      game.beepTimer -= dt;
      if (game.beepTimer <= 0) {
        game.beepTimer = clamp(match.state.bomb.fuse / FUSE_TIME, 0.25, 1);
        audio.plantBeep(false);
      }
    }
  }

  match.step(dt, { ember: 0, slate: 0 });
  if (phase === 'buy' || live) {
    bots.step(dt, { player: { ...player.state, team: 'ember' }, time: game.time, phase: match.state.phase });
  }
  combat.stepGrenades(dt, explodeGrenade);
  combat.step(dt);

  // Timers on the player's loadouts.
  for (const loadout of [game.primary, game.pistol]) {
    loadout.cooldown = Math.max(0, loadout.cooldown - dt);
    loadout.bloom = Math.max(0, loadout.bloom - dt * 0.02);
    if (loadout.reloadLeft > 0) {
      loadout.reloadLeft -= dt;
      if (loadout.reloadLeft <= 0) {
        const need = loadout.def.mag - loadout.mag;
        const take = Math.min(need, loadout.reserve);
        loadout.mag += take;
        loadout.reserve -= take;
        updateWeaponHud();
      }
    }
  }
  game.switchCooldown = Math.max(0, game.switchCooldown - dt);

  // HUD: timer, bomb, money, health.
  hud.setTimer(match.state.phaseTime, match.state.bomb.planted);
  hud.setBomb(match.state.bomb.planted ? match.state.bomb.fuse : null, FUSE_TIME);
  hud.setScore(match.state.score.ember, match.state.score.slate, match.state.round);
  hud.setHealth(player.state.health, player.state.armor);
  const spreadPx = 5 + weaponSpread(currentLoadout(), player.state.speed, player.state.crouched, player.state.aiming) * 900;
  hud.setCrosshair(spreadPx, player.state.aiming);
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;
  if (game.frozen) {
    renderer.render(scene, camera);
    return;
  }
  const look = input.takeLook();
  player.look(look.x, look.y);
  player.state.aiming = input.state.aiming && player.state.alive;
  const phase = match.state.phase;
  const live = phase === 'live' || phase === 'planted';

  for (const code of input.takePressed()) {
    // Global keys work in any phase.
    if (code === 'KeyM') {
      const on = audio.toggle();
      hud.toast(on ? 'Sound on' : 'Sound off');
      continue;
    }
    if (code === 'KeyB' && phase === 'buy') {
      game.buyOpen = !game.buyOpen;
      hud.showBuy(game.buyOpen);
      if (game.buyOpen) {
        hud.setBuyItems(SHOP, match.state.money);
        if (document.pointerLockElement) document.exitPointerLock();
      } else if (!shot) {
        input.requestLock();
      }
      continue;
    }
    if (game.buyOpen && /^Digit[1-5]$/.test(code)) {
      const item = SHOP[Number(code.slice(5)) - 1];
      if (item) buyItem(item.id);
      continue;
    }
    if (!player.state.alive || !live || game.buyOpen) continue;
    if (code === 'KeyR') startReload();
    if (code === 'KeyG') throwGrenade();
    if (code === 'Digit1') {
      game.slot = 1;
      game.switchCooldown = 0.3;
      updateWeaponHud();
    }
    if (code === 'Digit2') {
      game.slot = 2;
      game.switchCooldown = 0.3;
      updateWeaponHud();
    }
    if (code === 'KeyE' && !game.plant && match.state.bomb.carrier === 'player') {
      const site = match.siteAt(player.state.position.x, player.state.position.z, world.sites);
      if (site) {
        game.plant = { site, progress: 0 };
        hud.setHint(`Planting at Site ${site} — hold still`);
      } else {
        hud.toast('No bomb site here — A is the warehouse, B the tank farm');
      }
    }
  }

  if (live && player.state.alive) {
    if (input.state.firing && currentLoadout().def.auto) shoot();
    else if (input.state.firing && !currentLoadout().def.auto && !frame.firedOnce) {
      shoot();
      frame.firedOnce = true;
    }
    if (!input.state.firing) frame.firedOnce = false;
  }

  let accumulator = frame.accumulator ?? 0;
  accumulator += dt;
  let steps = 0;
  while (accumulator >= FIXED_STEP && steps < 5) {
    player.step(FIXED_STEP, input.state.keys);
    step(FIXED_STEP);
    accumulator -= FIXED_STEP;
    steps += 1;
  }
  if (accumulator > FIXED_STEP * 5) accumulator = 0;
  frame.accumulator = accumulator;

  // Viewmodel kick and bob.
  viewKick = Math.max(0, viewKick - dt * 0.5);
  if (player.state.speed > 0.5 && player.state.alive) walkCycle += dt * player.state.speed * 1.6;
  viewmodel.position.z = -0.5 + viewKick;
  viewmodel.position.y = -0.24 + Math.sin(walkCycle * 2) * 0.006 * Math.min(player.state.speed / 5, 1);
  viewmodel.position.x = player.state.aiming ? 0 : 0.27;
  viewmodel.rotation.x = viewKick * 1.4;

  // The bomb light blinks while the fuse runs.
  if (bombMesh.visible) {
    bombLightMat.emissiveIntensity = 1.2 + Math.sin(game.time * 9) * 1.1;
  }

  syncCamera();
  renderer.render(scene, camera);
}

let lastTime = performance.now();

// --- Staged shots ------------------------------------------------------------
function settle(steps) {
  for (let i = 0; i < steps; i += 1) {
    player.step(FIXED_STEP, new Set());
    step(FIXED_STEP);
  }
}

function aimAt(point) {
  const p = player.state;
  const dx = point.x - p.position.x;
  const dy = point.y - p.eye;
  const dz = point.z - p.position.z;
  const len = Math.hypot(dx, dy, dz) || 1;
  p.yaw = Math.atan2(-dx, -dz);
  p.pitch = Math.asin(clamp(dy / len, -1, 1));
  syncCamera();
}

function paintTwiceThenReady() {
  let painted = 0;
  function paint() {
    requestAnimationFrame(paint);
    syncCamera();
    renderer.render(scene, camera);
    painted += 1;
    if (painted === 2) {
      window.__shotReady = true;
      game.frozen = true;
    }
  }
  requestAnimationFrame(paint);
}

function runShot(name) {
  hud.hideOverlay();
  match.startMatch();
  if (name === 'start') {
    player.reset(0, 22, 0.12);
    settle(30);
    aimAt({ x: -2, y: 1.5, z: -10 });
    hud.showOverlay('start');
  } else if (name === 'play') {
    match.beginLive();
    player.reset(0, 8, 0);
    const slate = bots.aliveBots('slate');
    const first = slate[0];
    const second = slate[1];
    first.position.x = 3;
    first.position.z = -4;
    first.state = 'hold';
    first.holdUntil = 999;
    first.yaw = Math.PI;
    first.mesh.group.position.set(3, 0, -4);
    first.mesh.group.rotation.y = Math.PI;
    second.position.x = -5;
    second.position.z = -2;
    second.state = 'hold';
    second.holdUntil = 999;
    second.yaw = Math.PI - 0.4;
    second.mesh.group.position.set(-5, 0, -2);
    second.mesh.group.rotation.y = Math.PI - 0.4;
    settle(10);
    aimAt({ x: 3, y: 1.3, z: -4 });
    shoot(0);
    settle(2);
  } else if (name === 'plant') {
    match.beginLive();
    match.plantBomb('A');
    player.reset(-20.5, -4.5, 0);
    const slate = bots.aliveBots('slate');
    const first = slate[0];
    first.position.x = -27;
    first.position.z = -10;
    first.state = 'hold';
    first.holdUntil = 999;
    first.yaw = Math.PI * 0.6;
    first.mesh.group.position.set(-27, 0, -10);
    first.mesh.group.rotation.y = Math.PI * 0.6;
    settle(10);
    aimAt({ x: -25, y: 1.2, z: -14 });
    hud.setHint('Bomb planted at Site A — defend it');
  } else if (name === 'end') {
    match.beginLive();
    for (const bot of bots.aliveBots('slate')) bots.damage(bot, 9999, 'player');
    checkElimination();
    settle(10);
    player.reset(0, 6, 0);
    aimAt({ x: 0, y: 1.5, z: -12 });
  }
  hud.setScore(match.state.score.ember, match.state.score.slate, match.state.round);
  hud.setMoney(match.state.money);
  updateWeaponHud();
  paintTwiceThenReady();
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

match.startMatch();
resetPositions();
syncCamera();
updateWeaponHud();
hud.setScore(0, 0, 1);
hud.setMoney(match.state.money);
// A testing hook, off unless ?debug=1: the live state, for driving the
// game from a browser-automation script. It ships inert otherwise.
if (params.get('debug') === '1') {
  window.__dbg = { game, match, bots, player, world, combat, shoot, startReload, throwGrenade };
}
window.__gameReady = true;
if (shot) runShot(shot);
else requestAnimationFrame(frame);
