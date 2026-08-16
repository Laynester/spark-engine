# Third-party notices — spark-engine vs GPL/AGPL reference implementations

**Scope:** `packages/runtime` (and the exporter pipeline). Every comment in the
source that cites DirPlayer, LibreShockwave or ScummVM was compared against the
actual GPL/AGPL code to classify each module as a **direct port** (translation
evidence), **derived rules** (concepts taken from reading the GPL code, code
independently written) or **behavioral parity** (own implementation matching
observed behavior).

**License texts** for the three reference projects live in `licenses/`
(copied verbatim):

| File | Project | License |
|---|---|---|
| `licenses/LibreShockwave-LICENCE.txt` | LibreShockwave | AGPL-3.0 |
| `licenses/DirPlayer-LICENSE.txt` | dirplayer-rs | GPL-3.0 |
| `licenses/ScummVM-COPYING.txt` | ScummVM | GPL-3.0+ |

**Disclaimer:** this is an engineering audit, not legal advice. Copyright
analysis of translated code is a judgment call for counsel.

---

## License facts (verified from the repos)

| Project | License | Evidence |
|---|---|---|
| LibreShockwave | **AGPL-3.0** | `LICENCE` (Affero GPL v3) — https://github.com/LibreShockwave/LibreShockwave |
| dirplayer-rs | **GPL-3.0** | `LICENSE` (GPL v3) — https://github.com/igorlira/dirplayer-rs |
| ScummVM | GPL-3.0+ | `COPYING` (GPL v3) — https://github.com/scummvm/scummvm |
| spark-engine | **unlicensed** | no LICENSE/COPYING file — all rights reserved by default |

## What triggers GPL/AGPL obligations

- Both licenses impose obligations only on **distribution/copying** of the code
  (GPLv3 §5–6). Private use triggers nothing.
- **A browser game distributes its code:** the compiled JS is served to every
  visitor, which is conveying copies. If any shipped module is a derivative
  work, serving it requires offering source and licensing the combined work
  under a GPL/AGPL-compatible license.
- **AGPL §13 (network clause):** modifying and running an AGPL program where
  users interact with it remotely requires offering the modified source. This
  is largely redundant for this project since client-side JS is distributed
  anyway.
- **Build-tool output is not covered:** running the AGPL CastExporter to
  produce `.png`/`.pal`/`.ls` data does not make those files AGPL. The tool's
  own (modified) source stays AGPL — the fork lives in the repo, so the source
  offer is trivially satisfied.
- **Separate issue:** the `hh_*` cct assets are Sulake's proprietary data —
  a copyright/trademark question, unaffected by any tool license.

## Exposure ratings

| Module | Location | Cites | Rating |
|---|---|---|---|
| `applyInkPixel` ink compositing | `lingo/values.ts:626-900` | LibreShockwave `applyInk` (`Drawing.cpp:790-885`) | **HIGH — port** |
| fg/bg grayscale tint block (inside `applyInkPixel`) | `lingo/values.ts:647-696` | DirPlayer `drawing.rs` "Bitmap ink=0 colorization" (2640-2700) | **HIGH — port** |
| `tintSpriteBackground` | `stage/matte.ts:519-545` (comment 512) | DirPlayer `drawing.rs:2660-2690` | **HIGH — port** |
| `combineAlpha` / `alphaBlendPixel` | `lingo/values.ts:594-624` | C++ `combineAlpha` / `alphaBlend` | MEDIUM (standard math, same structure) |
| matte/flood-fill pipeline | `stage/matte.ts:4, 75, 183, 258-330, 333-560` | LibreShockwave `Drawing.cpp` FloodFillMatte (19-300) + DirPlayer `drawing.rs` `edge_matte_color` (~2325) / `should_matte_hit_test` (98) | MEDIUM — derived rules, own code, documented deviations |
| `copyPixels` opcode loop | `lingo/values.ts:422-560` | LibreShockwave `imageCopyPixels` (`OpcodeRegistry.cpp`) + `Drawing.cpp` | MEDIUM — parallel structure, own additions |
| `PropPairs` ordered proplist | `lingo/values.ts:66-210` | DirPlayer `PropList(VecDeque<PropListPair>, bool)` / LibreShockwave `properties_` | LOW — design parity, own class |
| `duplicateValue` | `lingo/values.ts:982` | C++ `Datum::deepCopy` | LOW — behavior parity |
| `to_number` sprite→channel coercion | `lingo/values.ts:1164` | DirPlayer `value.rs` | LOW — behavior parity |
| list/point/rect arithmetic | `lingo/values.ts:1051+` | DirPlayer `multiply_datums` | LOW — behavior parity |
| missing-handler no-op | `lingo/interpreter.ts:389` | DirPlayer `script.rs` | LOW — behavior parity |
| `multiply_datums` / `LocalCall` / `get_prop_at` | `lingo/interpreter.ts:934, 1015, 1294` | DirPlayer `flow_control.rs` / `string.rs` | LOW — behavior parity |
| string coercion / `value()` | `lingo/builtins.ts:193, 234` | DirPlayer `string.rs` / LibreShockwave `TypeBuiltins` | LOW — behavior parity |
| `Bitmap::new` 8-bit index-0 fill | `lingo/builtins.ts:332` | DirPlayer | LOW — behavior parity |
| rect/union/intersect, MathBuiltins, ListBuiltins | `lingo/builtins.ts:130, 384, 745` | LibreShockwave C++ | LOW — behavior parity |
| `float_precision`, `num_channels` | `engine/engine.ts:232, 261` | DirPlayer | LOW — behavior parity |
| `get_cast_slot_number` masking | `engine/engine.ts:1125` | DirPlayer | LOW — behavior parity |
| sprite hit-test / `get_sprite_at` | `stage/pixi.ts:875` | DirPlayer | LOW — behavior parity (PixiJS, no code correspondence) |
| text bitmap alpha fill | `stage/text.ts:102` | DirPlayer `text.rs` | LOW — behavior parity |

## HIGH items — evidence

### 1. `applyInkPixel` (`lingo/values.ts:626-900`) ← LibreShockwave `applyInk`

Near line-for-line port. Ink-case **order is identical** to the C++
(`Drawing.cpp:790-885`): 1 transparent → 2 reverse → 3 ghost → 4 not-copy →
5 not-transparent → 6 not-reverse → 7 not-ghost → 8 matte → 9 mask →
36 background-transparent → 32 blend → 33 add-pin → 34 add → 35 subtract-pin
→ 38 subtract → 37/40 lightest → 39 darkest → fallback. Conditions and
formulas match (`srcRgb == 0xFFFFFF ? dest : src`, XOR, averages,
`combineAlpha` truncation, fallback chain `blend<255 → alphaBlend; sa==0 →
dest; sa<255 → alphaBlend; else src`). Only language idioms differ. The
comment at `values.ts:422` says "faithful port".

Deliberate deviations (documented in-code): ink 41 (`imageMultiplyDarkenPixel`
multiply instead of the C++ `alphaBlend`), forced opaque alpha on 8-bit
destinations, and the fg/bg tint guard.

### 2. fg/bg grayscale tint (`lingo/values.ts:647-696`) ← DirPlayer `drawing.rs` (2640-2700)

Same `max-min <= 16` near-grayscale threshold, same `eff_fg`/`eff_bg`
defaulting (black/white), same guard, same ramp `t = gray/255; (1-t)*fg +
t*bg`. The comment says "mirrored from its WebGL2 shader".

### 3. `tintSpriteBackground` (`stage/matte.ts:519-545`) ← DirPlayer `drawing.rs:2660-2690`

Same 16-threshold and ramp formula; the comment cites the exact line range.

## MEDIUM items — evidence

### matte/flood-fill pipeline (`stage/matte.ts`)

The header (line 4) claims "Ported from LibreShockwave's bitmap pipeline", but
the body is **not** a translation: own function decomposition and naming
(`inferDominantEdgeRgb` 75, `resolveChannelMatte` 258, `bakeEdgeBackground`
333, `matteRegionMask` 419, `edgeMatteColor` 183) vs theirs (`FloodFillMatte`,
`inferDominantEdgePaletteIndex`, `resolveRgbFloodFillMatte`,
`computeEdgeConnectedMask`), and the comments document **deliberate behavioral
divergences** ("The C++ reference requires near-white corners and ≥75%
near-white edges, but real Habbo backdrops bleed art to a corner…", "The C++
resolveRgbFloodFillMatte shortcut is 'any white edge pixel wins'…"). The BFS
flood fill is generic algorithm. Closest mirrors: `edgeMatteColor` = pixel
(0,0) (DirPlayer `edge_matte_color`) and `matteSpriteHitTest` (`matte.ts:594`
= DirPlayer `should_matte_hit_test`, which is a one-line rule `ink == 8`).

### `copyPixels` (`lingo/values.ts:422-560`)

Parallel structure to the C++ opcode (nearest-neighbor integer sampling, mask
sampling) with substantial TS-specific additions (quad-flip mapping, palette
adoption on full-surface copies, depth-gated keying) and documented removals
of the C++ near-white gates (`shouldKeyNearWhiteMatte`).

## Caveats

- **The source-citing comments are double-edged.** They are honest
  documentation, but they hand a claimant the exact file/line ranges to diff
  (e.g. `matte.ts:512` cites `drawing.rs:2660-2690`). They are also evidence
  of good-faith, documented divergence in the same files.
- `matte.ts`'s "Ported from" header overclaims relative to the code beneath
  it, but the header + the close behavioral mirroring of
  `tintSpriteBackground` are what a claimant would point at first.
- Exposure is concentrated in ~150 lines: `applyInkPixel` + the tint block +
  `tintSpriteBackground`. The remaining ~4.8k lines of the interpreter are
  either independent code or spec-dictated behavior.

## Remediation paths

1. **Clean-room rewrite of the three HIGH functions** (from the Director ink
   spec + observed Habbo behavior, without the GPL case structure): restores
   those modules to fully-owned code. This is the recommended path if the
   project may ever be distributed/published.
2. **GPL/AGPL compliance** (if keeping the ports): ship source, keep notices,
   license the combined work AGPL-3.0-compatible. Cheap, but incompatible with
   any future closed/commercial distribution.
3. **Private use only:** no obligations trigger until distribution.

## Re-verification pointers

GPL/AGPL sources used for this audit:

- LibreShockwave: `cpp/src/bitmap/Drawing.cpp` (`applyInk` 790-885,
  `FloodFillMatte` 19-300, `preprocessBackgroundTransparent`),
  `cpp/src/lingo/vm/OpcodeRegistry.cpp` (`imageCopyPixels`),
  `cpp/src/bitmap/BitmapProcessing.hpp`
- DirPlayer: `vm-rust/src/player/bitmap/drawing.rs` (`should_matte_hit_test`
  98, ink 41 ~290, `edge_matte_color` ~2325, grayscale tint 2640-2700),
  `player/bytecode/flow_control.rs` (`local_call`),
  `player/bytecode/string.rs`, `value.rs` (`to_number`)
