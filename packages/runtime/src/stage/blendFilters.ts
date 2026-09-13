import { BlendModeFilter, ExtensionType, extensions } from 'pixi.js';
import { NOT_REVERSE_BLEND_MODE, REVERSE_BLEND_MODE } from './matte.js';

/**
 * Blend modes for the Director inks that XOR the sprite with what is ALREADY on
 * the stage:
 *
 *   2  Reverse     — dst XOR src
 *   6  Not Reverse — dst XOR ~src   ("the foreground image is first reversed,
 *                                    and then the Reverse ink is applied" —
 *                                    Adobe Director 11.5, inks table)
 *
 * XOR is a per-pixel operation on the destination's bits, so it has no
 * fixed-function equivalent (GL can min/max/reverse-subtract, but cannot fold
 * the framebuffer back into the blend equation). Pixi's advanced blend modes
 * are ordinary fragment shaders that receive the destination in `uBackTexture`
 * (the renderer's back buffer) and the sprite in `uTexture`, so registering a
 * `BlendModeFilter` under a name is enough to make
 * `sprite.blendMode = '<name>'` route that renderable through a filter pass.
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
 * Not Reverse is used by the HC lantern (`hc_ln` / `hc_rntgn` props: parts g/h,
 * ink 6) whose art is white + dark green: white XORs as the identity
 * (`~0xffffff` is black) which is exactly how the layer is authored to sit over
 * the room, while the green shape inverts the room behind it.
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

function makeInkBlendClass(glOp: string, gpuOp: string): typeof BlendModeFilter {
  return class extends BlendModeFilter {
    constructor() {
      super({
        gl: {
          functions: XOR_GL,
          main: `finalColor = vec4(mix(back.rgb, ${glOp}, front.a), blendedAlpha);`,
        },
        gpu: {
          functions: XOR_GPU,
          main: `out = vec4<f32>(mix(back.rgb, ${gpuOp}, front.a), blendedAlpha);`,
        },
      });
    }
  } as unknown as typeof BlendModeFilter;
}

let registered = false;

/**
 * Register the XOR ink blend modes with pixi's extension system. Idempotent:
 * registration is global (the blend-mode pipe keeps one filter instance per
 * name), so every stage after the first reuses them.
 */
export function registerInkBlendFilters(): void {
  if (registered) return;
  registered = true;
  extensions.add(
    { ref: makeInkBlendClass('inkXor(back.rgb, front.rgb)', 'inkXor(back.rgb, front.rgb)'), type: ExtensionType.BlendMode, name: REVERSE_BLEND_MODE },
    { ref: makeInkBlendClass('inkXor(back.rgb, vec3(1.0) - front.rgb)', 'inkXor(back.rgb, vec3<f32>(1.0) - front.rgb)'), type: ExtensionType.BlendMode, name: NOT_REVERSE_BLEND_MODE },
  );
}
