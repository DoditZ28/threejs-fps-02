// The player: a body on the ground plane with a yaw, a pitch, a velocity
// and a health pool. Movement accelerates toward the wish direction and
// friction bleeds speed away, so stopping is a decision and firing on
// the move is a worse one. Collision is a circle against the world's
// boxes, resolved one axis at a time so the player slides along walls.
import { clamp } from './util.js';

export const EYE_STAND = 1.62;
export const EYE_CROUCH = 1.05;
export const RADIUS = 0.38;

export function createPlayer(world) {
  const state = {
    position: { x: 0, z: 22 },
    velocity: { x: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    // Recoil is a temporary offset on top of the aim, not a change to
    // it: it climbs while firing and settles back when the trigger
    // lifts, so a burst climbs and a tap stays true.
    recoilPitch: 0,
    recoilYaw: 0,
    eye: EYE_STAND,
    crouched: false,
    aiming: false,
    health: 100,
    armor: false,
    alive: true,
    speed: 0,
  };

  function maxSpeed() {
    if (state.crouched) return 2.6;
    return state.aiming ? 3.1 : 5.2;
  }

  return {
    state,
    reset(x, z, yaw) {
      state.position.x = x;
      state.position.z = z;
      state.velocity.x = 0;
      state.velocity.z = 0;
      state.yaw = yaw;
      state.pitch = 0;
      state.eye = EYE_STAND;
      state.crouched = false;
      state.aiming = false;
      state.health = 100;
      state.armor = false;
      state.alive = true;
      state.speed = 0;
    },
    look(dx, dy) {
      state.yaw -= dx * 0.0021;
      state.pitch = clamp(state.pitch - dy * 0.0021, -1.5, 1.5);
    },
    recoil(pitchKick, yawKick) {
      state.recoilPitch = clamp(state.recoilPitch + pitchKick, 0, 0.35);
      state.recoilYaw += yawKick;
    },
    aimPitch() {
      return clamp(state.pitch + state.recoilPitch, -1.5, 1.5);
    },
    aimYaw() {
      return state.yaw + state.recoilYaw;
    },
    step(dt, keys) {
      if (!state.alive) return;
      // Recoil settles: a burst climbs, then the sight comes back.
      const settle = Math.max(0, 1 - dt * 5);
      state.recoilPitch *= settle;
      state.recoilYaw *= settle;
      const forward = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
      const strafe = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
      state.crouched = keys.has('ControlLeft') || keys.has('KeyC');
      // state.aiming is set by the mouse (right button), not the keys.
      const sin = Math.sin(state.yaw);
      const cos = Math.cos(state.yaw);
      // Forward is -z rotated by yaw; strafe is +x rotated by yaw.
      let wishX = -sin * forward + cos * strafe;
      let wishZ = -cos * forward - sin * strafe;
      const wishLen = Math.hypot(wishX, wishZ);
      if (wishLen > 0) {
        wishX /= wishLen;
        wishZ /= wishLen;
      }
      const walking = keys.has('ShiftLeft');
      const target = maxSpeed() * (walking ? 0.55 : 1);
      const accel = wishLen > 0 ? 42 : 30;
      state.velocity.x += wishX * accel * dt;
      state.velocity.z += wishZ * accel * dt;
      // Friction: bleed velocity toward zero when no input, and clamp to
      // the target speed when there is.
      const speed = Math.hypot(state.velocity.x, state.velocity.z);
      if (speed > 0) {
        const next = wishLen > 0 ? Math.min(speed, target) : Math.max(0, speed - 34 * dt);
        const scale = next / speed;
        state.velocity.x *= scale;
        state.velocity.z *= scale;
      }
      state.position.x += state.velocity.x * dt;
      world.resolveCircle(state.position, RADIUS);
      state.position.z += state.velocity.z * dt;
      world.resolveCircle(state.position, RADIUS);
      state.speed = Math.hypot(state.velocity.x, state.velocity.z);
      const targetEye = state.crouched ? EYE_CROUCH : EYE_STAND;
      state.eye += (targetEye - state.eye) * Math.min(1, dt * 12);
    },
    damage(amount) {
      if (!state.alive) return false;
      const taken = state.armor ? amount * 0.5 : amount;
      state.health -= taken;
      if (state.health <= 0) {
        state.health = 0;
        state.alive = false;
        return true;
      }
      return false;
    },
  };
}
