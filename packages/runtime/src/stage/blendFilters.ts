import { BlendModeFilter, ExtensionType, extensions } from 'pixi.js';
import { REVERSE_BLEND_MODE, PASS_THROUGH_BLEND_MODE, SUBTRACT_WRAP_BLEND_MODE, NOT_REVERSE_BLEND_MODE } from './matte.js';

/**
 * The Director inks that fold the DESTINATION into the source and so have no
 * fixed-function blend equation:
 *
 *   2  Reverse      — `dst XOR src` (no user in the corpus; see below)
 *   6  Not Reverse  — a destination duotone (see below)
 *   38 Subtract     — `dst - src` WRAPPED (mod 256), not clamped
 *   39 Darkest      — per-channel MIN, but see the pass-through note below
 *
 * XOR is a per-pixel operation on the destination's bits and GL's
 * `FUNC_REVERSE_SUBTRACT` clamps at zero, so neither can be expressed as a blend
 * equation. Pixi's advanced blend modes are ordinary fragment shaders that
 * receive the destination in `uBackTexture` (the renderer's back buffer) and the
 * sprite in `uTexture`, so registering a `BlendModeFilter` under a name is
 * enough to make `sprite.blendMode = '<name>'` route that renderable through a
 * filter pass.
 *
 * The `mix(back, op, front.a)` in the shaders carries two requirements:
 *
 *  - A matte-baked member is transparent outside its art, and Director draws
 *    nothing there, so the destination must come through untouched. Any other
 *    treatment of those pixels paints the sprite's rectangle over the room.
 *  - Partial alpha (art with a real alpha channel) blends toward the operand,
 *    which is the same interpolation the other ink passes use.
 *
 * These inks ignore the sprite's blend percentage on purpose: Director's Blend
 * value "affects only Copy, Background Transparent, Matte, Mask, and Blend
 * inks".
 *
 * ── ink 6 (Not Reverse): a destination DUOTONE ───────────────────────────
 *
 * The ink is implemented generically (the sprite's whole quad ramps whatever is
 * behind it) and named `notReverse-ink-gl` after the ink, not after an item. The
 * item is the measurement: the corpus's only ink-6 user (and only ink-38/39
 * user) stacks the SAME 16x95 / 29x100 band art three times per post at
 * increasing zshift:
 *
 *    b zshift 1 ink 39  ->  c zshift 2 ink 38  ->  g zshift 3 ink 6
 *
 * The band art is FLAT (`#005500` for 1390 of the base member's 1520 opaque
 * pixels; member aliases make `c`/`g` the same bitmap — see matte.ts). Every
 * arithmetic
 * reading of those three inks was tested against the item's real look and none
 * of them is it:
 *
 *  - The documented `dst XOR ~src` pins the band to magenta in every room,
 *    because `~#005500` has R = B = 255.
 *  - `dst XOR src` turns it green but over the wrong thing (see below).
 *  - An exhaustive search over per-channel `min`/`max`/`subtract` (both operand
 *    orders)/`xor`/`add`/`average`/`set`, in every 2- and 3-layer sequence, has
 *    NO solution for the two colours the live client paints
 *    (`scripts/probe-xray-solve.mjs` returns an empty set).
 *
 * A screenshot of the real client (`scripts/probe-xray-shot.mjs`,
 * `scripts/probe-xray-band-colors.mjs`) shows what it actually does: the band
 * maps the ROOM's brightness onto a single green hue — `#74fa4c` lime where the
 * room is darkest, `#225413` where it is lightest, with every intermediate
 * (`#54b936`, `#43962a`, `#33751f`, ...) sitting on the straight line between
 * them. Both endpoints are exact measured colours; the shape between them is
 * gamma-compressed a step darker than the straight line, which is what the
 * hand comparison asked for — see `DUOTONE_RAMP_STEEPNESS` in stage/matte.ts.
 *
 * So ink 6 is modelled as a destination duotone with those two measured
 * endpoints, not as a bitwise op. Nothing else in the v31 corpus uses ink 6, so
 * the ramp constants cannot leak into another movie; should one ever need the
 * documented form, it is a two-line shader change.
 *
 * ── inks 38 and 39 under it: PASS THROUGH ───────────────────────────────────
 *
 * `b` and `c` cover exactly the footprint `g` then paints, so whatever they
 * leave in the back buffer is what ink 6 reads as "the room". Keeping them as
 * arithmetic inks therefore feeds the ramp a saturated destination — measured,
 * `39-min -> 38-wrap` leaves `(0, 171 + room.G, 0)`, whose brightness runs the
 * OPPOSITE way to the room's, which paints the band's lime over the room's
 * bright areas. They are registered as `PASS_THROUGH_BLEND_MODE` (the
 * destination comes out unchanged, so the ink-6 layer sees the room itself),
 * which is what the visible result requires. Like ink 6 they have exactly one
 * user in the corpus, and `b`/`c` are fully covered by `g`, so the layer change
 * is invisible except through the ramp it feeds.
 *
 * `SUBTRACT_WRAP_BLEND_MODE` is kept registered even though ink 38 no longer
 * maps to it: it is the documented ink-38 operator, the registration is a few
 * kilobytes of shader, and a future movie that uses subtract without the band
 * above it will want it back.
 */

/**
 * 8-bit XOR in floating point, one bit at a time. GLSL ES 1.0 has no integer or
 * bitwise operators and WGSL's differ, so both shaders share this form (only
 * `floor`) rather than a `^` on ints.
 */
const XOR_GL = `
float inkXor8(float a, float b) {
    float av = floor(a * 255.0 + 0.5);
    float bv = floor(b * 255.0 + 0.5);
    float acc = 0.0;
    float bit = 1.0;
    for (int i = 0; i < 8; i++) {
        float qa = floor(av / bit);
        float qb = floor(bv / bit);
        float abit = qa - 2.0 * floor(qa * 0.5);
        float bbit = qb - 2.0 * floor(qb * 0.5);
        acc += abs(abit - bbit) * bit;
        bit += bit;
    }
    return acc / 255.0;
}

vec3 inkXor(vec3 a, vec3 b) {
    return vec3(inkXor8(a.r, b.r), inkXor8(a.g, b.g), inkXor8(a.b, b.b));
}
`;

const XOR_GPU = `
fn inkXor8(a: f32, b: f32) -> f32 {
    let av = floor(a * 255.0 + 0.5);
    let bv = floor(b * 255.0 + 0.5);
    var acc = 0.0;
    var bit = 1.0;
    for (var i = 0; i < 8; i = i + 1) {
        let qa = floor(av / bit);
        let qb = floor(bv / bit);
        let abit = qa - 2.0 * floor(qa * 0.5);
        let bbit = qb - 2.0 * floor(qb * 0.5);
        acc = acc + abs(abit - bbit) * bit;
        bit = bit + bit;
    }
    return acc / 255.0;
}

fn inkXor(a: vec3<f32>, b: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(inkXor8(a.r, b.r), inkXor8(a.g, b.g), inkXor8(a.b, b.b));
}
`;

/**
 * The ink-6 ramp, as measured off the live client — the GPU twin of
 * `duotoneRampRgb` in stage/matte.ts, which carries the full derivation and the
 * calibration probe names. Two things are load-bearing:
 *
 *  - `lum` is the plain RGB average, so the ramp reads the room's brightness
 *    rather than one channel;
 *  - the brightness is gamma-compressed before the ramp reads it (see the
 *    DUOTONE_RAMP_STEEPNESS note in matte.ts): a plain `1 - lum` — which reaches
 *    `#74fa4c` only at a perfectly black room and `#225413` only at white —
 *    read a little bright, and compressing first darkens the mid tones while
 *    leaving both measured endpoints exactly where they are;
 *  - the result is then chroma-boosted about its own luma (DUOTONE_RAMP_SATURATION
 *    in matte.ts), because the measured line — `#225413` is an olive at
 *    34/84/19 — still read washed out beside the real band.
 */
const NOT_REVERSE_GL = `
vec3 inkNotReverseRamp(vec3 back) {
    float lum = (back.r + back.g + back.b) / 1.0;
    float t = clamp(1.0 - pow(lum, 0.75), 0.0, 1.0);
    vec3 light = vec3(34.0, 84.0, 19.0) / 255.0;   // #225413 - the LIGHTEST room tones
    vec3 dark = vec3(116.0, 250.0, 76.0) / 255.0;  // #74fa4c - the DARKEST room tones
    vec3 c = mix(light, dark, t);
    float luma = dot(c, vec3(0.299, 0.587, 0.114));
    return clamp(luma + (c - luma) * 1.35, 0.0, 1.0);
}
`;

const NOT_REVERSE_GPU = `
fn inkNotReverseRamp(back: vec3<f32>) -> vec3<f32> {
    let lum = (back.r + back.g + back.b) / .0;
    let t = clamp(1.0 - pow(max(lum, 0.0), 0.75), 0.0, 1.0);
    let light = vec3<f32>(34.0, 84.0, 19.0) / 255.0;   // #225413 - the LIGHTEST room tones
    let dark = vec3<f32>(116.0, 250.0, 76.0) / 255.0;  // #74fa4c - the DARKEST room tones
    let c = mix(light, dark, t);
    let luma = dot(c, vec3<f32>(0.299, 0.587, 0.114));
    return clamp(luma + (c - luma) * 1.35, vec3<f32>(0.0), vec3<f32>(1.0));
}
`;

/** Identity: the destination is handed straight back, alpha included. */
const PASS_GL = `
vec3 inkPass(vec3 back) {
    return back;
}
`;

const PASS_GPU = `
fn inkPass(back: vec3<f32>) -> vec3<f32> {
    return back;
}
`;

/**
 * Ink 38 (Subtract): "Subtracts the RGB color value of the foreground sprite's
 * color from the RGB value of the background sprite's color to determine the new
 * color. If the color value of the new color is less than 0, Director adds 256
 * so the remaining value is between 0 and 255" (adobe_director_11.5.txt:3377) —
 * i.e. it WRAPS, while ink 35's Subtract Pin is the one that clamps (adobe_director_11.5.txt:3380).
 * GL's `FUNC_REVERSE_SUBTRACT` cannot wrap, which is what this pass is for.
 */
const SUB_WRAP_GL = `
float inkSub8(float a, float b) {
    float av = floor(a * 255.0 + 0.5);
    float bv = floor(b * 255.0 + 0.5);
    return mod(av - bv + 256.0, 256.0) / 255.0;
}

vec3 inkSubWrap(vec3 a, vec3 b) {
    return vec3(inkSub8(a.r, b.r), inkSub8(a.g, b.g), inkSub8(a.b, b.b));
}
`;

const SUB_WRAP_GPU = `
fn inkSub8(a: f32, b: f32) -> f32 {
    let av = floor(a * 255.0 + 0.5);
    let bv = floor(b * 255.0 + 0.5);
    return ((av - bv) + 256.0) % 256.0 / 255.0;
}

fn inkSubWrap(a: vec3<f32>, b: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(inkSub8(a.r, b.r), inkSub8(a.g, b.g), inkSub8(a.b, b.b));
}
`;

type InkShader = { functions: string; op: string; alpha: 'blend' | 'keep' };

function makeInkBlendClass(gl: InkShader, gpu: InkShader): typeof BlendModeFilter {
    const glMain =
        gl.alpha === 'keep'
            ? `finalColor = vec4(mix(back.rgb, ${gl.op}, front.a), back.a);`
            : `finalColor = vec4(mix(back.rgb, ${gl.op}, front.a), blendedAlpha);`;
    const gpuMain =
        gpu.alpha === 'keep'
            ? `out = vec4<f32>(mix(back.rgb, ${gpu.op}, front.a), back.a);`
            : `out = vec4<f32>(mix(back.rgb, ${gpu.op}, front.a), blendedAlpha);`;
    return class extends BlendModeFilter {
        constructor() {
            super({ gl: { functions: gl.functions, main: glMain }, gpu: { functions: gpu.functions, main: gpuMain } });
        }
    } as unknown as typeof BlendModeFilter;
}

const XOR_MODES = { functions: XOR_GL, op: 'inkXor(back.rgb, front.rgb)', alpha: 'blend' } as const;
const XOR_MODES_GPU = { functions: XOR_GPU, op: 'inkXor(back.rgb, front.rgb)', alpha: 'blend' } as const;
const NOT_REVERSE_MODES = { functions: NOT_REVERSE_GL, op: 'inkNotReverseRamp(back.rgb)', alpha: 'blend' } as const;
const NOT_REVERSE_MODES_GPU = { functions: NOT_REVERSE_GPU, op: 'inkNotReverseRamp(back.rgb)', alpha: 'blend' } as const;
const PASS_MODES = { functions: PASS_GL, op: 'inkPass(back.rgb)', alpha: 'keep' } as const;
const PASS_MODES_GPU = { functions: PASS_GPU, op: 'inkPass(back.rgb)', alpha: 'keep' } as const;
const SUB_MODES = { functions: SUB_WRAP_GL, op: 'inkSubWrap(back.rgb, front.rgb)', alpha: 'blend' } as const;
const SUB_MODES_GPU = { functions: SUB_WRAP_GPU, op: 'inkSubWrap(back.rgb, front.rgb)', alpha: 'blend' } as const;

let registered = false;

/**
 * Register the destination-folding ink blend modes with pixi's extension system.
 * Idempotent: registration is global (the blend-mode pipe keeps one filter
 * instance per name), so every stage after the first reuses them.
 */
export function registerInkBlendFilters(): void {
    if (registered) return;
    registered = true;
    extensions.add(
        { ref: makeInkBlendClass(XOR_MODES, XOR_MODES_GPU), type: ExtensionType.BlendMode, name: REVERSE_BLEND_MODE },
        { ref: makeInkBlendClass(NOT_REVERSE_MODES, NOT_REVERSE_MODES_GPU), type: ExtensionType.BlendMode, name: NOT_REVERSE_BLEND_MODE },
        { ref: makeInkBlendClass(PASS_MODES, PASS_MODES_GPU), type: ExtensionType.BlendMode, name: PASS_THROUGH_BLEND_MODE },
        { ref: makeInkBlendClass(SUB_MODES, SUB_MODES_GPU), type: ExtensionType.BlendMode, name: SUBTRACT_WRAP_BLEND_MODE },
    );
}
