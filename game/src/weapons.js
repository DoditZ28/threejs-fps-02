// The armoury. Four guns and one grenade, each with one job: the pistol
// is free and always there, the rifle is the honest middle, the SMG wins
// up close and loses at range, the sniper deletes one head at a time.
// Damage falls with range; spread grows with movement and with every
// shot in a burst, so stopping to aim pays. Prices are the economy.
export const WEAPONS = {
  pistol: {
    id: 'pistol', name: 'P9 Sidearm', slot: 2, price: 0, auto: false,
    damage: 34, headMult: 4, range: 28, falloff: 0.45,
    fireInterval: 0.16, reloadTime: 1.4, mag: 12, reserve: 48,
    spread: 0.006, moveSpread: 0.02, bloom: 0.004, kick: 0.006,
    tracer: 0xf2ead9,
  },
  rifle: {
    id: 'rifle', name: 'AR-7 Jackal', slot: 1, price: 2700, auto: true,
    damage: 33, headMult: 4, range: 55, falloff: 0.55,
    fireInterval: 0.11, reloadTime: 2.2, mag: 30, reserve: 90,
    spread: 0.0035, moveSpread: 0.026, bloom: 0.0035, kick: 0.011,
    tracer: 0xff9a2a,
  },
  smg: {
    id: 'smg', name: 'SMG-9 Wasp', slot: 1, price: 1500, auto: true,
    damage: 24, headMult: 4, range: 26, falloff: 0.3,
    fireInterval: 0.075, reloadTime: 1.9, mag: 32, reserve: 96,
    spread: 0.007, moveSpread: 0.02, bloom: 0.003, kick: 0.007,
    tracer: 0xffd88a,
  },
  sniper: {
    id: 'sniper', name: 'SR-12 Longshot', slot: 1, price: 4500, auto: false,
    damage: 95, headMult: 2.2, range: 90, falloff: 0.9,
    fireInterval: 1.15, reloadTime: 3.1, mag: 5, reserve: 15,
    spread: 0.0004, moveSpread: 0.06, bloom: 0.02, kick: 0.05,
    tracer: 0x9fd8ff,
  },
};

export const GRENADE = {
  id: 'grenade', name: 'HE Grenade', slot: 3, price: 300,
  damage: 110, radius: 6, fuse: 1.6,
};

export const ARMOR_PRICE = 650;
export const ARMOR_ABSORB = 0.5; // armoured targets take half damage

// One live weapon: the definition plus its mutable state. The sim owns
// the timers; nothing here touches the DOM or the scene.
export function createLoadout(weaponId) {
  const def = WEAPONS[weaponId];
  return {
    def,
    mag: def.mag,
    reserve: def.reserve,
    cooldown: 0,
    reloadLeft: 0,
    bloom: 0,
  };
}

export function weaponSpread(loadout, speed, crouched, aiming) {
  const def = loadout.def;
  const moving = Math.min(speed / 5.2, 1);
  let spread = def.spread + def.moveSpread * moving + loadout.bloom;
  if (crouched) spread *= 0.7;
  if (aiming) spread *= 0.55;
  return spread;
}

// Damage at a range, with the head multiplier applied by the caller.
export function damageAt(def, range, head) {
  const beyond = Math.max(0, range - def.range * 0.5) / (def.range * 0.5);
  const scaled = def.damage * (1 - (1 - def.falloff) * Math.min(beyond, 1));
  return scaled * (head ? def.headMult : 1);
}
