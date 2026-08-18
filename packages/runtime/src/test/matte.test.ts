import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyMaskAlpha, bakeEdgeBackground, bakeModeForInk, blendModeForInk, matteRegionMask, matteSpriteHitTest, tintSpriteBackground } from '../stage/matte.js';

/** Build an RGBA buffer; fill(x, y, r, g, b, a) default opaque white. */
function makeImage(width: number, height: number): { data: Uint8ClampedArray; fill: (x: number, y: number, r: number, g: number, b: number, a?: number) => void } {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const fill = (x: number, y: number, r: number, g: number, b: number, a = 255): void => {
    const i = (y * width + x) * 4;
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = a;
  };
  return { data, fill };
}

function alphaAt(data: Uint8ClampedArray, width: number, x: number, y: number): number {
  return data[(y * width + x) * 4 + 3];
}

test('matte ink (8): white background flood-filled, interior white detail survives', () => {
  // 8x8 white backdrop with a 2x2 blue blob; a white "highlight" pixel sits
  // INSIDE the blob, sealed off by blue on all sides. The magic-wand flood
  // fill must remove the outer white but keep the interior white.
  const { data, fill } = makeImage(8, 8);
  for (let y = 2; y <= 5; y++) {
    for (let x = 2; x <= 5; x++) fill(x, y, 0, 0, 255); // blue blob
  }
  fill(3, 3, 255, 255, 255); // white highlight, surrounded by blue
  const changed = bakeEdgeBackground(data, 8, 8, 'matte');
  assert.ok(changed, 'background must be baked');
  // corners + outer white -> transparent
  assert.equal(alphaAt(data, 8, 0, 0), 0);
  assert.equal(alphaAt(data, 8, 7, 0), 0);
  assert.equal(alphaAt(data, 8, 7, 7), 0);
  assert.equal(alphaAt(data, 8, 4, 0), 0, 'top edge white removed');
  assert.equal(alphaAt(data, 8, 0, 4), 0, 'left edge white removed');
  // blob stays opaque
  assert.equal(alphaAt(data, 8, 2, 2), 255);
  assert.equal(alphaAt(data, 8, 5, 5), 255);
  // the sealed interior white highlight SURVIVES (magic-wand, not key)
  assert.equal(alphaAt(data, 8, 3, 3), 255, 'interior white must not be removed');
});

test('background transparent ink (36): near-white backdrop removed with tolerance 24', () => {
  const { data, fill } = makeImage(8, 8);
  // near-white (245) background with a 3x3 dark content blob (>= 8 content
  // pixels, matching the C++ hasOpaqueNonNearWhiteContent gate)
  for (let i = 0; i < 64; i++) {
    data[i * 4] = 245;
    data[i * 4 + 1] = 245;
    data[i * 4 + 2] = 248;
  }
  for (let y = 3; y <= 5; y++) {
    for (let x = 3; x <= 5; x++) fill(x, y, 20, 60, 120);
  }
  const changed = bakeEdgeBackground(data, 8, 8, 'backgroundTransparent');
  assert.ok(changed);
  assert.equal(alphaAt(data, 8, 0, 0), 0, 'near-white corner removed');
  assert.equal(alphaAt(data, 8, 7, 2), 0, 'near-white edge removed');
  assert.equal(alphaAt(data, 8, 4, 4), 255, 'content pixel survives');
});

test('background transparent (36) with art bleeding to the bottom edge (garden-style)', () => {
  // Habbo UK garden: white sky on top, green/gray art reaches the bottom edge
  // and one corner — the C++ corner/75%-edge gates reject it, leaving a white
  // box. The edge-connected flood fill only removes the connected white sky;
  // interior white detail (cloud puff in the art) must survive.
  const { data, fill } = makeImage(8, 8);
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 8; x++) fill(x, y, 255, 255, 255); // white sky
  }
  for (let y = 4; y < 8; y++) {
    for (let x = 0; x < 8; x++) fill(x, y, 40, 90, 30); // dark garden art
  }
  fill(2, 5, 255, 255, 255); // interior white highlight, surrounded by art
  const changed = bakeEdgeBackground(data, 8, 8, 'backgroundTransparent');
  assert.ok(changed, 'white sky must be baked away');
  assert.equal(alphaAt(data, 8, 0, 0), 0, 'sky corner removed');
  assert.equal(alphaAt(data, 8, 4, 1), 0, 'sky edge removed');
  assert.equal(alphaAt(data, 8, 0, 7), 255, 'art reaching the bottom edge stays');
  assert.equal(alphaAt(data, 8, 2, 5), 255, 'interior white highlight survives (magic wand)');
});

test('background transparent (36) rejected when nothing near-white touches an edge', () => {
  const { data, fill } = makeImage(6, 6);
  for (let y = 0; y < 6; y++) {
    for (let x = 0; x < 6; x++) fill(x, y, 40, 60, 80); // dark all over
  }
  fill(2, 2, 255, 255, 255); // a white patch in the middle, not touching edges
  const before = data.slice();
  const changed = bakeEdgeBackground(data, 6, 6, 'backgroundTransparent');
  assert.equal(changed, false, 'no near-white edge -> no background to remove');
  assert.deepEqual(data, before);
});

test('transparent ink (1): exact-white key removes white even inside the art', () => {
  const { data, fill } = makeImage(5, 5);
  fill(2, 2, 0, 0, 255); // blue center
  fill(2, 1, 255, 255, 255); // white pixel above it (interior, surrounded by white)
  const changed = bakeEdgeBackground(data, 5, 5, 'key');
  assert.ok(changed);
  assert.equal(alphaAt(data, 5, 0, 0), 0);
  assert.equal(alphaAt(data, 5, 2, 1), 0, 'key mode removes ALL white, even interior');
  assert.equal(alphaAt(data, 5, 2, 2), 255);
});

test('key ink (1/36) still blanket-keys white on a transparent-bordered canvas (avatar regression)', () => {
  // The avatar canvas is a 32-bit image with a TRANSPARENT border (the drawn
  // body never reaches the edges) but the indexed body parts paste OPAQUE
  // white backgrounds onto it, so the interior is white-filled around the
  // colored art. The ink-36 key must remove that white — DirPlayer color-keys
  // against sprite bgColor (white default) EVEN for 32-bit alpha bitmaps
  // (rendering_gpu/webgl2/mod.rs, use_embedded_alpha + ink 36 path: "Plain
  // 32-bit-with-alpha members still need the key so ink 36 can actually do
  // its job"). A transparent border is NOT a reason to skip the key — doing
  // so leaves the white box around every avatar in a room.
  const { data, fill } = makeImage(9, 9);
  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) fill(x, y, 255, 255, 255, 0); // transparent border
  }
  // opaque white fill block (the body part's pasted background), interior,
  // with a colored body pixel inside it
  for (let y = 2; y <= 6; y++) {
    for (let x = 2; x <= 6; x++) fill(x, y, 255, 255, 255);
  }
  fill(4, 4, 40, 90, 180); // avatar body pixel
  const changed = bakeEdgeBackground(data, 9, 9, 'key');
  assert.ok(changed, 'white fill must be keyed even with a transparent border');
  assert.equal(alphaAt(data, 9, 3, 3), 0, 'white fill pixel keyed to transparent');
  assert.equal(alphaAt(data, 9, 4, 4), 255, 'colored body pixel survives');
  assert.equal(alphaAt(data, 9, 0, 0), 0, 'transparent border untouched');
});

test('no matte when edges disagree (no 75% dominant color) -> bake is a no-op', () => {
  // 4x4 border: 4 red (top), 4 green (bottom), 2 blue (left), 2 yellow (right)
  // = 12 edge pixels, none reaching 75%; interior all dark. No white anywhere,
  // so the white-edge short-circuit can't fire either.
  const { data, fill } = makeImage(4, 4);
  fill(0, 0, 255, 0, 0);
  fill(1, 0, 255, 0, 0);
  fill(2, 0, 255, 0, 0);
  fill(3, 0, 255, 0, 0); // top red
  fill(0, 3, 0, 255, 0);
  fill(1, 3, 0, 255, 0);
  fill(2, 3, 0, 255, 0);
  fill(3, 3, 0, 255, 0); // bottom green
  fill(0, 1, 0, 0, 255);
  fill(0, 2, 0, 0, 255); // left blue
  fill(3, 1, 255, 255, 0);
  fill(3, 2, 255, 255, 0); // right yellow
  fill(1, 1, 10, 10, 10);
  fill(2, 1, 10, 10, 10);
  fill(1, 2, 10, 10, 10);
  fill(2, 2, 10, 10, 10);
  const before = data.slice();
  const changed = bakeEdgeBackground(data, 4, 4, 'matte');
  assert.equal(changed, false, 'no dominant edge color -> nothing baked');
  assert.deepEqual(data, before, 'pixels untouched');
});

test('matte on a fully-white image removes it (C++ white-edge short-circuit)', () => {
  // resolveRgbFloodFillMatte returns {white, 0} the moment any opaque edge
  // pixel is pure white — no uniform-image guard on that path (LibreShockwave
  // behavior). An all-white sprite under matte ink is fully transparent.
  const { data } = makeImage(3, 3); // all white
  const changed = bakeEdgeBackground(data, 3, 3, 'matte');
  assert.equal(changed, true);
  assert.equal(alphaAt(data, 3, 0, 0), 0);
  assert.equal(alphaAt(data, 3, 1, 1), 0);
});

test('matte keys a white fill sliver on a non-white-cornered composed buffer (U124 navigator corners)', () => {
  // The image() builtin fills fresh 8-bit group buffers with palette index 0
  // (white). The navigator info-area's art covers the top/left but not the
  // bottom-right corner, so the white FILL shows there. p00 is teal (not
  // white) and the corners aren't all white, so neither the top-left nor the
  // whiteEdgeDominates gate fires — only the U124 gate (any exact-white edge
  // pixel + real content) resolves the matte, and the edge-connected flood
  // keys the sliver while teal art and enclosed white survive.
  const W = 8, H = 8;
  const { data, fill } = makeImage(W, H); // opaque white default = the fill
  for (let y = 0; y < 5; y++) for (let x = 0; x < W; x++) fill(x, y, 0, 100, 160); // teal top band
  for (let y = 5; y < H; y++) for (let x = 0; x < 4; x++) fill(x, y, 0, 100, 160); // teal left block
  fill(2, 2, 255, 255, 255); // white pixel sealed inside teal art — must survive
  const changed = bakeEdgeBackground(data, W, H, 'matte');
  assert.ok(changed, 'white fill sliver must be baked away');
  assert.equal(alphaAt(data, W, 7, 7), 0, 'bottom-right white fill removed');
  assert.equal(alphaAt(data, W, 4, 7), 0, 'bottom-edge white fill removed');
  assert.equal(alphaAt(data, W, 7, 5), 0, 'right-edge white fill removed (below the teal top band)');
  assert.equal(alphaAt(data, W, 0, 0), 255, 'teal (0,0) art survives');
  assert.equal(alphaAt(data, W, 4, 4), 255, 'interior teal art survives');
  assert.equal(alphaAt(data, W, 2, 2), 255, 'enclosed white survives (edge-connected flood)');
});

test('matte with white only in the interior leaves the buffer untouched (U124 gate needs a white edge)', () => {
  const W = 8, H = 8;
  const { data, fill } = makeImage(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) fill(x, y, 0, 100, 160); // teal all over
  fill(3, 3, 255, 255, 255);
  fill(4, 4, 255, 255, 255); // white only in the middle, no white on any border
  const before = data.slice();
  const changed = bakeEdgeBackground(data, W, H, 'matte');
  assert.equal(changed, false, 'no white edge pixel -> no matte, no bake');
  assert.deepEqual(data, before, 'pixels untouched');
});

test('ink -> bake mode mapping (Director id::InkMode)', () => {
  assert.equal(bakeModeForInk(1), 'key'); // transparent
  assert.equal(bakeModeForInk(8), 'matte'); // matte (clouds)
  // BACKGROUND_TRANSPARENT (36) is a BLANKET color-key, not a flood fill:
  // DirPlayer's WebGL ink-36 shader discards every pixel within tolerance of
  // the background color — enclosed whites included (the hotel tower's
  // enclosed whites used to survive our edge-connected flood).
  assert.equal(bakeModeForInk(36), 'key');
  assert.equal(bakeModeForInk(0), null); // copy shows the bitmap as-is
  assert.equal(bakeModeForInk(9), null); // mask uses a mask member
  // every composite ink must be baked first or its white background shows
  // through the blend (light1 / light rays are add pin on opaque white art)
  assert.equal(bakeModeForInk(32), 'matte'); // blend
  assert.equal(bakeModeForInk(33), 'matte'); // add pin
  assert.equal(bakeModeForInk(34), 'matte'); // add
  assert.equal(bakeModeForInk(35), 'matte'); // subtract pin
  // DARKEN (41): the visualizer wrapper composites a near-white pattern and
  // the sprite tints it by bgColor (multiply) at upload — the GPU must NOT
  // min against the stage, or the tinted floor blackens behind the dark stage.
  // (The raw mapping still labels 41 'matte' — pixi's bakeForChannel gates the
  // white-bake to inks 1/8/36, so 41 goes through tint-only in practice.)
  assert.equal(bakeModeForInk(41), 'matte');
  assert.equal(blendModeForInk(41), 'normal');
  assert.equal(bakeModeForInk(38), 'matte'); // subtract
  assert.equal(bakeModeForInk(37), 'matte'); // lightest
  assert.equal(bakeModeForInk(39), 'matte'); // darkest
  assert.equal(bakeModeForInk(40), 'matte'); // lighten
  assert.equal(bakeModeForInk(41), 'matte'); // darken
});

test('key with a palette keys palette index 0 only (cloud body 238 survives)', () => {
  // Real cloud_0_left palette: index 0 = 255,255,255 background, the body is
  // 238,238,238 at a DIFFERENT index. DirPlayer get_bg_color_ref for indexed
  // bitmaps is exactly PaletteIndex(0) — a near-white key would eat the body.
  const palette = [[255, 255, 255], [254, 254, 254], [238, 238, 238]];
  const { data, fill } = makeImage(4, 4);
  fill(0, 0, 255, 255, 255); // bg (index 0)
  fill(3, 3, 255, 255, 255); // bg, ENCLOSED-adjacent corner still keyed
  fill(1, 1, 238, 238, 238); // cloud body (index 2) — must survive
  const changed = bakeEdgeBackground(data, 4, 4, 'key', palette);
  assert.ok(changed);
  assert.equal(alphaAt(data, 4, 0, 0), 0, 'palette-0 white keyed');
  assert.equal(alphaAt(data, 4, 3, 3), 0, 'key is blanket — enclosed whites die');
  assert.equal(alphaAt(data, 4, 1, 1), 255, '238 body (different index) survives');
});

test('key with no palette falls back to exact white (legacy behavior)', () => {
  const { data, fill } = makeImage(3, 3);
  fill(0, 0, 245, 245, 245); // near-white — NOT exact white, must survive
  fill(1, 1, 255, 255, 255); // exact white — keyed
  const changed = bakeEdgeBackground(data, 3, 3, 'key');
  assert.ok(changed);
  assert.equal(alphaAt(data, 3, 0, 0), 255, 'near-white is art without a palette');
  assert.equal(alphaAt(data, 3, 1, 1), 0, 'exact white keyed');
});

test('ink-36 key with real hotel palette removes enclosed whites (DirPlayer)', () => {
  // The hotel tower's 172 truly-enclosed white pixels are palette index 0;
  // the edge-connected flood (old behavior) kept them visible. The blanket
  // key removes them, matching DirPlayer's ink-36 shader.
  const palette = [[255, 255, 255], [0, 0, 0], [153, 87, 109]];
  const { data, fill } = makeImage(6, 6);
  for (let y = 0; y < 6; y++) {
    for (let x = 0; x < 6; x++) fill(x, y, 255, 255, 255);
  }
  // A sealed white box inside the art: the flood fill could not reach it.
  for (let y = 1; y <= 4; y++) {
    for (let x = 1; x <= 4; x++) fill(x, y, 0, 0, 0); // art ring
  }
  fill(2, 2, 255, 255, 255); // enclosed white (index 0)
  fill(2, 3, 153, 87, 109); // art color (index 2) survives
  const changed = bakeEdgeBackground(data, 6, 6, 'key', palette);
  assert.ok(changed);
  assert.equal(alphaAt(data, 6, 2, 2), 0, 'enclosed palette-0 white keyed');
  assert.equal(alphaAt(data, 6, 2, 3), 255, 'palette-2 art survives');
  assert.equal(alphaAt(data, 6, 1, 1), 255, 'black art survives');
});

test('matte with a palette floods from palette index 0 (cloud turn slices)', () => {
  // Cloud art is fully opaque: white bg (index 0) with 238,238,238 puffs
  // (different index) and black outlines. The palette-driven matte must flood
  // ONLY the index-0 white, keeping every puff — the near-white heuristic
  // (>=232) used to eat them.
  const palette = [[255, 255, 255], [238, 238, 238], [0, 0, 0]];
  const { data, fill } = makeImage(8, 8);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) fill(x, y, 255, 255, 255);
  }
  // A sealed ring of black outline with a 238 puff inside it.
  fill(3, 3, 0, 0, 0); fill(4, 3, 0, 0, 0); fill(3, 4, 0, 0, 0); fill(4, 4, 0, 0, 0);
  fill(3, 2, 0, 0, 0); fill(4, 2, 0, 0, 0); fill(2, 3, 0, 0, 0); fill(5, 3, 0, 0, 0);
  fill(2, 4, 0, 0, 0); fill(5, 4, 0, 0, 0); fill(3, 5, 0, 0, 0); fill(4, 5, 0, 0, 0);
  fill(3, 3, 238, 238, 238); // puff sealed by outline
  const changed = bakeEdgeBackground(data, 8, 8, 'matte', palette);
  assert.ok(changed);
  assert.equal(alphaAt(data, 8, 0, 0), 0, 'outer white flooded');
  assert.equal(alphaAt(data, 8, 3, 3), 255, '238 puff survives');
  assert.equal(alphaAt(data, 8, 4, 4), 255, 'black outline survives');
});

test('matte bake keeps edge-touching art (light1: black diamond on white, ink 33)', () => {
  // The entry light rays are a black diamond with a bright core on an opaque
  // white background. The flood fill must remove the white while the art
  // (even where it touches the image edge) survives to be added.
  const { data, fill } = makeImage(6, 6);
  fill(2, 0, 0, 0, 0); // art touches the top edge
  fill(1, 1, 0, 0, 0);
  fill(3, 1, 0, 0, 0);
  fill(2, 2, 0, 0, 0);
  const changed = bakeEdgeBackground(data, 6, 6, 'matte');
  assert.ok(changed);
  assert.equal(alphaAt(data, 6, 0, 0), 0, 'white corner removed');
  assert.equal(alphaAt(data, 6, 5, 5), 0, 'white corner removed');
  assert.equal(alphaAt(data, 6, 2, 0), 255, 'edge-touching black art survives');
  assert.equal(alphaAt(data, 6, 2, 2), 255);
});

test('ink -> blend mode mapping (add pin 33 is additive, per user report)', () => {
  assert.equal(blendModeForInk(33), 'add'); // light1 light rays
  assert.equal(blendModeForInk(34), 'add'); // add
  assert.equal(blendModeForInk(35), 'subtract'); // subtract pin
  assert.equal(blendModeForInk(38), 'subtract'); // subtract
  assert.equal(blendModeForInk(37), 'max'); // lightest -> core GL MAX (pixi advanced lighten is broken)
  assert.equal(blendModeForInk(40), 'max'); // lightest
  assert.equal(blendModeForInk(39), 'min'); // darkest -> core GL MIN
  assert.equal(blendModeForInk(0), 'normal');
  assert.equal(blendModeForInk(8), 'normal'); // matte: baked alpha, normal composite
  assert.equal(blendModeForInk(36), 'normal');
});

test('matteSpriteHitTest: ink 8 falls through transparent pixels, others are bounding-box (DirPlayer parity)', () => {
  const { data, fill } = makeImage(4, 4);
  fill(0, 0, 0, 0, 0, 0); // zero-filled (unpainted) pixel at (0,0) — note 6 args: x,y,r,g,b,a
  fill(1, 1, 255, 0, 0, 255); // single opaque pixel at (1,1)
  fill(2, 2, 0, 0, 0, 0); // explicit transparent pixel at (2,2)
  // ink 8: transparent pixel -> fall through (false), opaque -> hit (true)
  assert.equal(matteSpriteHitTest(8, data, 4, 4, 2, 2), false, 'ink 8 transparent pixel falls through');
  assert.equal(matteSpriteHitTest(8, data, 4, 4, 1, 1), true, 'ink 8 opaque pixel hits');
  assert.equal(matteSpriteHitTest(8, data, 4, 4, 0, 0), false, 'unpainted (zero-filled) pixel falls through');
  // ink 8 with no surface yet: bounding box stands
  assert.equal(matteSpriteHitTest(8, undefined, 4, 4, 2, 2), true, 'no surface -> rect hit');
  // out-of-surface coords (rect said inside, pixel math drifted): treat as hit
  assert.equal(matteSpriteHitTest(8, data, 4, 4, 9, 9), true, 'out-of-bounds -> rect hit');
  // non-matte inks never do pixel tests
  assert.equal(matteSpriteHitTest(0, data, 4, 4, 2, 2), true, 'copy ink is bounding-box');
  assert.equal(matteSpriteHitTest(36, data, 4, 4, 2, 2), true, 'background-transparent ink is bounding-box');
  assert.equal(matteSpriteHitTest(8, data, 4, 4, 2, 2), false, 'sanity: ink 8 still falls through at end');
});

test('ink-8 matte skips transparent-bordered text images (entry_bar white glyphs survive)', () => {
  // The corpus Text Wrapper pastes the field member image ink-8 over its own
  // pimage.fill() background. The member `.image` is TRANSPARENT + white
  // glyphs (DirPlayer text bitmaps are 0,0,0,0-filled). The old matte resolved
  // "white" from the glyph pixels touching the image edge, and the transparent
  // border seeded the flood to roam through every transparent pixel and eat
  // the matching white glyphs — entry_bar labels (txtColor #FFFFFF) vanished.
  // A predominantly-transparent border means the alpha channel IS the mask.
  const W = 40, H = 12;
  const { data } = makeImage(W, H);
  // transparent background (drop the opaque-white default)
  for (let i = 0; i < W * H; i++) data[i * 4 + 3] = 0;
  // white glyph block touching the LEFT edge (left-aligned entry_bar text)
  for (let y = 1; y < 10; y++) for (let x = 0; x < 6; x++) data[(y * W + x) * 4 + 3] = 255;

  const mask = matteRegionMask(data, W, H, 0, 0, W, H, undefined);
  assert.equal(mask, null, 'no color matte on a transparent-bordered text image');

  const baked = new Uint8ClampedArray(data);
  const changed = bakeEdgeBackground(baked, W, H, 'matte');
  assert.equal(changed, false, 'bake must not key the white glyphs either');
  let kept = 0;
  for (let i = 0; i < W * H; i++) if (baked[i * 4 + 3] !== 0) kept++;
  assert.equal(kept, 9 * 6, 'every white glyph pixel survives');
});

test('furniture colour: matte bake FIRST then tint (background keyed, enclosed white recolored)', () => {
  // Coloured furniture (class "pura_mdl1*1"): the Active Object sets
  // `tSpr.bgColor = rgb(pPartColors[j])` on every part sprite. The part art
  // is white-on-white — palette index 0 = background, and the colourable
  // regions are white too but ENCLOSED by dark outlines (so the edge flood
  // keys the backdrop while the art survives). The stage must bake the matte
  // FIRST (key the edge-connected background) and THEN tint the surviving
  // near-grayscale pixels toward the bg colour. Tinting first recolours the
  // background pixels too, so the bake finds no white edges to flood from and
  // the whole part renders as a solid colour rectangle (the reported bug).
  const palette = [[255, 255, 255], [0, 0, 0]];
  const W = 6, H = 6;
  const { data, fill } = makeImage(W, H); // opaque white default = background
  // black outline ring enclosing a white colourable region at (2,2)
  for (let x = 1; x <= 4; x++) { fill(x, 1, 0, 0, 0); fill(x, 4, 0, 0, 0); }
  for (let y = 1; y <= 4; y++) { fill(1, y, 0, 0, 0); fill(4, y, 0, 0, 0); }

  // Correct order: bake then tint.
  const baked = new Uint8ClampedArray(data);
  const changed = bakeEdgeBackground(baked, W, H, 'matte', palette);
  assert.ok(changed, 'background keyed');
  tintSpriteBackground(baked, W, H, 0xff8800);
  assert.equal(alphaAt(baked, W, 0, 0), 0, 'corner background keyed to transparent');
  const o = (2 + 2 * W) * 4;
  assert.equal(baked[o + 3], 255, 'enclosed white survived the flood');
  assert.equal(baked[o], 0xff, 'enclosed white tinted to the bg colour');
  assert.equal(baked[o + 1], 0x88);
  assert.equal(baked[o + 2], 0x00);
  const outline = (1 + 1 * W) * 4;
  assert.equal(baked[outline], 0, 'black outline untouched by the tint');

  // Wrong order (tint first) is exactly the reported regression: the white
  // background becomes orange before the bake, so nothing is keyed.
  const wrong = new Uint8ClampedArray(data);
  tintSpriteBackground(wrong, W, H, 0xff8800);
  const changedWrong = bakeEdgeBackground(wrong, W, H, 'matte', palette);
  assert.equal(alphaAt(wrong, W, 0, 0), 255, 'tint-first leaves the background opaque (regression)');
  assert.ok(!changedWrong, 'no white edge left to flood from');
});

test('opaque white-backdrop art still gets the ink-8 matte (cloud regression)', () => {
  const W = 20, H = 20;
  const { data, fill } = makeImage(W, H); // opaque white default
  for (let y = 5; y < 15; y++) for (let x = 5; x < 15; x++) fill(x, y, 238, 238, 238); // puff
  const mask = matteRegionMask(data, W, H, 0, 0, W, H, undefined);
  assert.ok(mask, 'opaque white backdrop still resolves a matte');
  assert.equal(mask[0], 1, 'border pixel marked background');
  assert.equal(mask[5 * W + 5], 0, 'enclosed puff pixel is content');
});

test('copyPixels ink-8 matte keys the (0,0) pixel color on a 32-bit source (purse shadow)', () => {
  // DirPlayer copy_pixels_with_params: for a 32-bit source WITHOUT alpha the
  // ink-8 matte background is EXACTLY the source's top-left pixel (0,0)
  // (edge_matte_color) — no edge-voting. The purse_sd drop-shadows are
  // white-backdrop art (grey shadow bleeding into the edges): pixel (0,0) is
  // white, so the white is keyed and the grey shadow survives. The old
  // >=75%-white-edges+corners gate rejected this art (white = 41-57% of the
  // edge) and the flipped right-side shadow (flipH: 1, palette dropped by
  // image(w,h,depth)) pasted as a white box at blend 30.
  const W = 49, H = 216;
  const { data, fill } = makeImage(W, H); // opaque white default
  // grey shadow blob touching the bottom/right edges (white = ~57% of edge)
  for (let y = H - 60; y < H; y++) for (let x = 20; x < W; x++) fill(x, y, 153, 153, 153);
  const mask = matteRegionMask(data, W, H, 0, 0, W, H, undefined);
  assert.ok(mask, 'no-palette source still mattes from pixel (0,0)');
  assert.equal(mask[0], 1, 'white (0,0) marked background');
  assert.equal(mask[H * W - 1], 0, 'grey shadow at bottom-right is content');
  assert.equal(mask[(H - 30) * W + 40], 0, 'interior grey shadow survives');
});

test('copyPixels ink-8 matte on a 32-bit source with black (0,0) keys black (U69 glyphs)', () => {
  // U69 regression, DirPlayer parity: entry_bar field-member images are black
  // (0,0) with white glyphs touching the left edge. The matte background is
  // pixel (0,0) = black — the flood keys the black and the white glyphs
  // survive. (A white-glyph edge pixel must NOT hijack the matte to white.)
  const W = 10, H = 6;
  const { data, fill } = makeImage(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) fill(x, y, 0, 0, 0);
  for (let y = 1; y < 4; y++) for (let x = 0; x < 4; x++) fill(x, y, 255, 255, 255);
  const mask = matteRegionMask(data, W, H, 0, 0, W, H, undefined);
  assert.ok(mask, 'black (0,0) resolves a matte');
  assert.equal(mask[0], 1, 'black (0,0) is background');
  assert.equal(mask[1 * W + 0], 0, 'white glyph on the left edge survives');
  assert.equal(mask[2 * W + 3], 0, 'interior white glyph survives');
});

test('nav 9-slice pieces with the shared palette table attached key white / paste as-is (U87)', () => {
  // The navigator chrome ships as 32-bit PNGs with NO per-member .pal — the
  // pieces rely on the shared nav_ui_palette (index 0 = white), attached by
  // Unique Element via `pimage.paletteRef = <member>`. With the table on the
  // image, the ink-8 matte keys palette[0] = white exactly like DirPlayer's
  // 8-bit indexed path: the corner's white backdrop is keyed (black outline +
  // gray fill kept), and strips with no white at all (nav_tb_px solid gray,
  // nav_tb_ed black/gray) get a NULL mask and paste as-is. Without the
  // palette, the pixel-(0,0) fallback keys black/gray and eats the outline /
  // the whole gray panel ("uncoloured" navigator edges).
  // nav_tb_px: 1x1 solid 239-gray panel, (0,0)=gray.
  const px = makeImage(1, 1);
  px.fill(0, 0, 239, 239, 239);
  assert.equal(matteRegionMask(px.data, 1, 1, 0, 0, 1, 1, [[255, 255, 255]]), null, 'gray panel + white palette -> NULL (paste as-is)');
  assert.ok(matteRegionMask(px.data, 1, 1, 0, 0, 1, 1, undefined), 'without palette the panel keys itself (old bug)');
  // nav_tb_ed: 5x1 black outline / gray fill, (0,0)=black.
  const ed = makeImage(5, 1);
  ed.fill(0, 0, 0, 0, 0);
  for (let x = 1; x < 5; x++) ed.fill(x, 0, 239, 239, 239);
  assert.equal(matteRegionMask(ed.data, 5, 1, 0, 0, 5, 1, [[255, 255, 255]]), null, 'black/gray strip + white palette -> NULL (paste as-is)');
  assert.equal(matteRegionMask(ed.data, 5, 1, 0, 0, 5, 1, undefined)![0], 1, 'without palette the black outline is keyed (old bug)');
  // nav_tb_cr: 4x4 white backdrop, black outline, gray fill, (0,0)=white.
  const cr = makeImage(4, 4);
  for (let x = 1; x < 4; x++) cr.fill(x, 0, 0, 0, 0);
  for (let y = 1; y < 4; y++) cr.fill(0, y, 0, 0, 0);
  for (let y = 1; y < 4; y++) for (let x = 1; x < 4; x++) cr.fill(x, y, 239, 239, 239);
  const m = matteRegionMask(cr.data, 4, 4, 0, 0, 4, 4, [[255, 255, 255]]);
  assert.ok(m, 'corner with white palette resolves a matte');
  assert.equal(m[0], 1, 'white (0,0) backdrop keyed');
  assert.equal(m[1], 0, 'black outline kept');
  assert.equal(m[4 * 3 + 3], 0, 'gray fill kept');
});

test('matteRegionMask with raw indices keys ONLY index 0 (fuzzy floor dither)', () => {
  // The fuzzy floor tile: palette index 0 = white background, but indices 17/18
  // (the dither interior) also resolve to 203-gray / white through the pattern
  // palette. DirPlayer floods by palette INDEX, so the white 18s are art and
  // survive; an RGB-keyed flood eats them (they are edge-connected through the
  // index-0 background), and the black V outlines of tiles behind show through
  // as a grid.
  const W = 6, H = 5;
  const palette = [
    [255, 255, 255], // 0 bg
    [0, 0, 0], // 1
    [0, 0, 0], // 2
    [0, 0, 0], // 3
    [0, 0, 0], // 4
    [0, 0, 0], // 5
    [0, 0, 0], // 6
    [0, 0, 0], // 7
    [0, 0, 0], // 8
    [0, 0, 0], // 9
    [0, 0, 0], // 10
    [0, 0, 0], // 11
    [0, 0, 0], // 12
    [0, 0, 0], // 13
    [0, 0, 0], // 14
    [0, 0, 0], // 15
    [0, 0, 0], // 16
    [203, 203, 204], // 17 dark dither square
    [255, 255, 255], // 18 white dither square — same RGB as index 0
  ];
  const idx = new Uint8Array(W * H).fill(0);
  idx[1 * W + 1] = 18; // white dither square, edge-connected to the 0 background
  idx[1 * W + 4] = 18;
  idx[2 * W + 2] = 17;
  const { data, fill } = makeImage(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [r, g, b] = palette[idx[y * W + x]];
      fill(x, y, r, g, b);
    }
  }

  // With indices: only index 0 is keyed, the white 18s survive.
  const withIdx = matteRegionMask(data, W, H, 0, 0, W, H, palette, idx);
  assert.ok(withIdx, 'index-keyed matte resolves');
  assert.equal(withIdx[0], 1, 'index-0 background keyed');
  assert.equal(withIdx[1 * W + 1], 0, 'white index-18 dither survives (index key, not RGB key)');
  assert.equal(withIdx[1 * W + 4], 0, 'white index-18 dither survives');

  // Without indices (old behavior): the RGB flood eats the same-colored 18s.
  const noIdx = matteRegionMask(data, W, H, 0, 0, W, H, palette);
  assert.ok(noIdx);
  assert.equal(noIdx[1 * W + 1], 1, 'RGB-keyed flood eats the white 18 (the bug)');
});

test('bakeEdgeBackground matte with raw indices keeps same-colored dither (fuzzy floor)', () => {
  // Same scenario through the sprite bake: index-0 white keyed, white index-18
  // dither (edge-connected) survives with indices, is eaten without.
  const W = 6, H = 5;
  const idx = new Uint8Array(W * H).fill(0);
  idx[1 * W + 1] = 18;
  idx[1 * W + 4] = 18;
  idx[2 * W + 2] = 17;
  const { data, fill } = makeImage(W, H);
  const colorOf = (i: number): [number, number, number] =>
    i === 18 ? [255, 255, 255] : i === 17 ? [203, 203, 204] : i === 0 ? [255, 255, 255] : [0, 0, 0];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [r, g, b] = colorOf(idx[y * W + x]);
      fill(x, y, r, g, b);
    }
  }

  const rgba = Uint8ClampedArray.from(data);
  bakeEdgeBackground(rgba, W, H, 'matte', undefined, idx);
  assert.equal(alphaAt(rgba, W, 0, 0), 0, 'index-0 background baked away');
  assert.equal(alphaAt(rgba, W, 1, 1), 255, 'white index-18 dither survives the index-keyed flood');

  const rgba2 = Uint8ClampedArray.from(data);
  bakeEdgeBackground(rgba2, W, H, 'matte');
  assert.equal(alphaAt(rgba2, W, 1, 1), 0, 'without indices the RGB flood eats the white 18');
});

test('ink 9 (Mask): applyMaskAlpha cuts the source to the mask black regions', () => {
  // The Habbo pool water: vesi1 is a fully OPAQUE blue rectangle, vesimask1 is
  // its black/white cutout (black = swim area, white = shoreline/edges). Ink 9
  // bakes the NEXT member's bitmap as a grayscale alpha mask onto the source:
  // black(0) -> opaque, white(255) -> transparent, grays -> partial, and pixels
  // outside the mask coverage are transparent (DirPlayer parity).
  const W = 6, H = 6;
  const { data, fill } = makeImage(W, H); // opaque blue water
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) fill(x, y, 0, 128, 255);

  // Mask: 6x6, black square in the middle (swim area), white rim (shoreline).
  const mask = new Uint8ClampedArray(W * H * 4);
  const mfill = (x: number, y: number, v: number) => {
    const o = (y * W + x) * 4;
    mask[o] = mask[o + 1] = mask[o + 2] = v;
    mask[o + 3] = 255;
  };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) mfill(x, y, 255); // white rim
  for (let y = 2; y < 4; y++) for (let x = 2; x < 4; x++) mfill(x, y, 0); // black pool

  const out = new Uint8ClampedArray(data);
  const changed = applyMaskAlpha(out, W, H, mask, W, H, 0, 0);
  assert.ok(changed, 'mask bake changed pixels');
  assert.equal(alphaAt(out, W, 0, 0), 0, 'white mask region -> transparent');
  assert.equal(alphaAt(out, W, 3, 3), 255, 'black mask region -> opaque water');
  // Original source pixel colour survives where the mask lets it through.
  const o = (3 + 3 * W) * 4;
  assert.equal(out[o], 0);
  assert.equal(out[o + 1], 128);
  assert.equal(out[o + 2], 255);

  // Gray mask: partial alpha (128 gray -> ~50% alpha).
  mfill(5, 5, 128);
  const out2 = new Uint8ClampedArray(data);
  applyMaskAlpha(out2, W, H, mask, W, H, 0, 0);
  assert.equal(alphaAt(out2, W, 5, 5), 127, 'gray mask -> partial alpha (255 - 128 = 127)');

  // Mask smaller than the source / offset: uncovered pixels are transparent.
  const small = new Uint8ClampedArray(2 * 2 * 4);
  for (let i = 0; i < 4; i += 4) { small[i] = small[i + 1] = small[i + 2] = 0; small[i + 3] = 255; }
  const out3 = new Uint8ClampedArray(data);
  applyMaskAlpha(out3, W, H, small, 2, 2, 0, 0);
  assert.equal(alphaAt(out3, W, 0, 0), 255, 'covered pixel uses the mask');
  assert.equal(alphaAt(out3, W, 3, 3), 0, 'outside mask coverage -> transparent');

  // Registration-point offset: mask at +1,+1 aligns (source (0,0) samples mask
  // (1,1)). Source pixel under mask black stays, under mask white goes clear.
  const out4 = new Uint8ClampedArray(data);
  applyMaskAlpha(out4, W, H, mask, W, H, 1, 1);
  assert.equal(alphaAt(out4, W, 0, 0), 0, 'source (0,0) samples mask (1,1) = white rim');
  assert.equal(alphaAt(out4, W, 1, 1), 255, 'source (1,1) samples mask (2,2) = black pool -> opaque');
});
