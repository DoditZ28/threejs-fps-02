// Keyboard and mouse, and the pointer lock that turns the mouse into
// look. Plain browser APIs only. Besides the held-key set, this keeps an
// edge queue: keys pressed since the last frame, so the game can react
// to one tap (reload, grenade, buy, plant) without re-triggering.
export function createInput(canvas, onLockChange) {
  const keys = new Set();
  const pressed = [];
  const state = {
    keys,
    locked: false,
    firing: false,
    aiming: false,
    lookX: 0,
    lookY: 0,
  };

  function setKey(event, down) {
    if (down) {
      if (!keys.has(event.code)) pressed.push(event.code);
      keys.add(event.code);
    } else {
      keys.delete(event.code);
    }
    if (event.code === 'Space') event.preventDefault();
  }

  window.addEventListener('keydown', (event) => setKey(event, true));
  window.addEventListener('keyup', (event) => setKey(event, false));
  window.addEventListener('blur', () => {
    keys.clear();
    state.firing = false;
    state.aiming = false;
  });
  window.addEventListener('mousemove', (event) => {
    if (!state.locked) return;
    state.lookX += event.movementX;
    state.lookY += event.movementY;
  });
  window.addEventListener('mousedown', (event) => {
    if (!state.locked) return;
    if (event.button === 0) state.firing = true;
    if (event.button === 2) state.aiming = true;
  });
  window.addEventListener('mouseup', (event) => {
    if (event.button === 0) state.firing = false;
    if (event.button === 2) state.aiming = false;
  });
  window.addEventListener('contextmenu', (event) => event.preventDefault());
  document.addEventListener('pointerlockchange', () => {
    state.locked = document.pointerLockElement === canvas;
    if (!state.locked) {
      keys.clear();
      state.firing = false;
      state.aiming = false;
    }
    onLockChange(state.locked);
  });

  return {
    state,
    requestLock() {
      canvas.requestPointerLock();
    },
    takeLook() {
      const x = state.lookX;
      const y = state.lookY;
      state.lookX = 0;
      state.lookY = 0;
      return { x, y };
    },
    // The codes pressed since the last call, in order; consumed.
    takePressed() {
      if (pressed.length === 0) return pressed;
      const out = pressed.slice();
      pressed.length = 0;
      return out;
    },
  };
}
