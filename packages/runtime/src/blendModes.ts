/** Maps user-friendly blend mode names to Pixi v8 blend mode strings. */
export const BLEND_MODE_MAP: Record<string, string> = {
  normal: "normal",
  add: "add",
  additive: "add",
  multiply: "multiply",
  screen: "screen",
  overlay: "overlay",
  darken: "darken",
  lighten: "lighten",
  "color-dodge": "color-dodge",
  "color-burn": "color-burn",
  "hard-light": "hard-light",
  "soft-light": "soft-light",
  difference: "difference",
  exclusion: "exclusion",
  hue: "hue",
  saturation: "saturation",
  color: "color",
  luminosity: "luminosity",
};

/** Resolve a user-supplied blend mode string to a Pixi v8 blend mode. */
export function resolveBlendMode(raw: string): string | undefined {
  const key = raw.toLowerCase().replace(/[\s_-]+/g, "-");
  return BLEND_MODE_MAP[key];
}
