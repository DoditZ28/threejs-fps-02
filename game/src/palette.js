// EMBERLINE — the look plan, in one place. Six values and one accent hue;
// the lighting makes every shade the game needs, so no other colour appears
// in the code. The same names are the CSS custom properties in index.html.
export const PALETTE = {
  canvas: '#191512', // dusk sky / fog
  surface: '#262019', // panels, crates in shade
  hairline: '#3d332a', // edges, trims
  ink: '#f2ead9', // text, crosshair
  muted: '#a89a80', // secondary text
  accent: '#ff9a2a', // Ember team, tracers, warnings
  slate: '#3fb6c9', // Slate team, defuse, cool light
};

export function shade(name) {
  return PALETTE[name];
}
