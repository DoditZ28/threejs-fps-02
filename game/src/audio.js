// Procedural sound: every effect is an oscillator or a burst of shaped
// noise through WebAudio, so the game ships no audio files. The mixer is
// created lazily on the first user gesture, which is also when browsers
// allow audio to start.
export function createAudio() {
  let ctx = null;
  let master = null;
  let enabled = true;

  function ensure() {
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume();
      return true;
    }
    try {
      const AudioContext = window.AudioContext ?? window.webkitAudioContext;
      ctx = new AudioContext();
      master = ctx.createGain();
      master.gain.value = 0.5;
      master.connect(ctx.destination);
      return true;
    } catch {
      return false;
    }
  }

  function noiseBuffer(seconds) {
    const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  function burst({ duration, filterFreq, filterType = 'lowpass', gain = 0.8, decay = 0.12 }) {
    if (!enabled || !ensure()) return;
    const now = ctx.currentTime;
    const source = ctx.createBufferSource();
    source.buffer = noiseBuffer(duration);
    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = filterFreq;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(gain, now);
    amp.gain.exponentialRampToValueAtTime(0.001, now + decay);
    source.connect(filter);
    filter.connect(amp);
    amp.connect(master);
    source.start(now);
    source.stop(now + duration);
  }

  function tone({ freq, endFreq = null, duration, type = 'sine', gain = 0.3 }) {
    if (!enabled || !ensure()) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    if (endFreq !== null) osc.frequency.exponentialRampToValueAtTime(endFreq, now + duration);
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(gain, now);
    amp.gain.exponentialRampToValueAtTime(0.001, now + duration);
    osc.connect(amp);
    amp.connect(master);
    osc.start(now);
    osc.stop(now + duration);
  }

  return {
    unlock() {
      ensure();
    },
    toggle() {
      enabled = !enabled;
      return enabled;
    },
    get enabled() {
      return enabled;
    },
    shot(weaponId, distant = false) {
      if (distant) {
        burst({ duration: 0.18, filterFreq: 900, gain: 0.16, decay: 0.16 });
        return;
      }
      if (weaponId === 'sniper') {
        burst({ duration: 0.3, filterFreq: 2400, gain: 1, decay: 0.28 });
        tone({ freq: 160, endFreq: 55, duration: 0.22, type: 'triangle', gain: 0.5 });
      } else if (weaponId === 'smg') {
        burst({ duration: 0.09, filterFreq: 3200, gain: 0.55, decay: 0.08 });
      } else if (weaponId === 'pistol') {
        burst({ duration: 0.12, filterFreq: 2600, gain: 0.6, decay: 0.1 });
      } else {
        burst({ duration: 0.14, filterFreq: 1800, gain: 0.85, decay: 0.12 });
        tone({ freq: 120, endFreq: 50, duration: 0.14, type: 'triangle', gain: 0.35 });
      }
    },
    dryFire() {
      tone({ freq: 1400, duration: 0.03, type: 'square', gain: 0.12 });
    },
    reload() {
      tone({ freq: 900, duration: 0.04, type: 'square', gain: 0.15 });
      setTimeout(() => tone({ freq: 620, duration: 0.04, type: 'square', gain: 0.15 }), 320);
    },
    hit(kill) {
      tone({ freq: kill ? 1500 : 1100, duration: 0.06, type: 'square', gain: 0.2 });
      if (kill) setTimeout(() => tone({ freq: 1900, duration: 0.08, type: 'square', gain: 0.2 }), 70);
    },
    hurt() {
      tone({ freq: 220, endFreq: 110, duration: 0.18, type: 'sawtooth', gain: 0.25 });
    },
    plantBeep(final = false) {
      tone({ freq: final ? 1900 : 1250, duration: final ? 0.3 : 0.09, type: 'square', gain: 0.18 });
    },
    explosion() {
      burst({ duration: 0.9, filterFreq: 500, gain: 1, decay: 0.85 });
      tone({ freq: 90, endFreq: 30, duration: 0.7, type: 'sine', gain: 0.7 });
    },
    roundStart() {
      tone({ freq: 520, duration: 0.12, type: 'triangle', gain: 0.25 });
      setTimeout(() => tone({ freq: 780, duration: 0.2, type: 'triangle', gain: 0.25 }), 130);
    },
    roundEnd(win) {
      const notes = win ? [523, 659, 784] : [392, 330, 262];
      notes.forEach((freq, i) => setTimeout(() => tone({ freq, duration: 0.22, type: 'triangle', gain: 0.25 }), i * 140));
    },
    buy() {
      tone({ freq: 990, duration: 0.07, type: 'square', gain: 0.15 });
    },
  };
}
