import type { Handler, Script } from './ast.js';
import type { Interpreter } from './interpreter.js';
import {
  asNum, duplicateValue, ilkOf, keyOf, lingoListCompare, toLingoString, VOID,
  type LVal, type LMemberRef, type LObject, type LSpriteRef, type LStageRef,
  type LWindowRef, type LCastLibRef, LSymbol, LList, LPoint, LPropList, LRect, LImage, LSpriteRef as LSpriteRefClass,
  LColor, colorFrom, hexColor, intColor,
  LMemberRef as LMemberRefClass, LObject as LObjectClass, LScriptRef as LScriptRefClass,
} from './values.js';

// The system palette `image(w, h, 8)` (no palette arg) attaches: SystemWin /
// SystemMac both have WHITE at index 0, and only index 0 is ever read.
const SYSTEM_PALETTE: number[][] = [[255, 255, 255]];

/** The slice of engine functionality builtins need. Implemented by DirectorEngine. */
export interface BuiltinBackend {
  log(msg: string): void;
  warn(msg: string): void;
  getMember(number: number, castLibNumber?: number): LMemberRef | null;
  getMemberByName(name: string): LMemberRef | null;
  getMemberByNameInCast(name: string, castLibNumber: number): LMemberRef | null;
  /** `startTimer()` builtin: reset `the timer` clock (Paalu countdowns). */
  resetTimer(): void;
  /** Resolve a paletteRef value (member ref / name string / member number /
   *  #grayscale symbol) to its RGB table, or null when unresolvable. Feeds the
   *  image() builtin's background fill (DirPlayer Bitmap::new index-0 fill). */
  resolvePaletteTable(value: LVal): number[][] | null;
  newMember(kind: string, castLibNumber: number): LMemberRef | null;
  /** Director `createMember(name, #kind[, castLib])` — named dynamic member; returns the global number. */
  createNamedMember(name: string, kind: string, castLibNumber: number): number;
  getMemberProp(m: LMemberRef, prop: string): LVal;
  getSprite(channel: number): LSpriteRef;
  getCastLib(arg: LVal): LCastLibRef | null;
  getWindow(id: string): LWindowRef | null;
  createWindow(id: string): LWindowRef | null;
  removeWindow(id: string): void;
  windowExists(id: string): boolean;
  /** Director `getWindowIdList()` — ids of all open windows. */
  getWindowIdList(): string[];
  getStage(): LStageRef;
  globalGet(name: string): LVal | undefined;
  globalSet(name: string, value: LVal): void;
  go(frame: LVal): void;
  resolveScript(name: string): Script | null;
  resolveScriptByNumber(number: number): Script | null;
  makeObject(script: Script): LObject;
  getObjectById(id: string): LObject | null;
  setObjectById(id: string, obj: LObject): void;
  removeObjectById(id: string): void;
  getUniqueId(): string;
  netGetNetText(url: string): number;
  getStreamStatus(id: number): LVal;
  importFileInto(member: LVal, url: string): number;
  netDone(id: number | undefined): number;
  netError(id: number | undefined): string;
  netTextResult(id: number | undefined): string;
  preloadNetThing(url: string): number;
  puppetSound(channel: number, member: LVal): void;
  /** Director `queueSound member, channel[, props]` (Song Player queues tracks). */
  queueSoundOnChannel(member: LVal, channel: number, props?: LVal): void;
  /** Director `startSoundChannel channel` — begin the queued playlist. */
  startSoundChannelBuiltin(channel: number): number;
  /** Director `stopSoundChannel channel` — stop + clear the queue. */
  stopSoundChannelBuiltin(channel: number): number;
  /** Director `playSoundInChannel member, channel` — play now; 1 on success. */
  playSoundInChannelBuiltin(member: LVal, channel: number): number;
  getSoundChannel(channel: number): LVal;
  dispatchMessage(msgName: string, data: LVal): void;
  registerListener(connId: string, objId: string, msgs: LVal): void;
  registerCommands(connId: string, objId: string, cmds: LVal): void;
  unregisterListener(connId: string, objId: string): void;
  getConnection(id: string): LVal;
  connectionExists(id: string): boolean;
  removeConnection(id: string): void;
  /** Director `getPref(name)` — the movie's preference string, "" when unset. */
  getPref(name: string): string;
  /** Director `setPref(name, value)` — stores a movie preference. */
  setPref(name: string, value: string): void;
  rollover(): number;
  /** DirPlayer `rollover(spriteNum)`: TRUE when the mouse is over THAT
   *  specific sprite (direct hit test, ignoring sprites stacked above it). */
  rolloverSprite?(n: number): boolean;
  setRollover(n: number): void;
  /** Director `paletteIndex(n)` — the RGB color at index (n & 0xFF) of the
   *  movie's current palette (Figure System resolves avatar colors this way). */
  paletteColor(index: number): LColor;
  /** Director `image(w,h,depth,paletteMember)`: adopting a palette member
   *  makes it the movie's current palette for paletteIndex(n) lookups
   *  (same rule as the paletteref member setter — Navigator row backs). */
  adoptImagePalette(ref: LMemberRef): void;
  setPuppet(channel: number, flag: number): void;
  setFrameTempo(n: number): void;
  /** Director `timeout(name)` — a timer object whose .new() registers it. */
  timeout(name: string): LObject;
  /** Shared `xtra("Name")` stub factory. */
  xtraInstance(name: string): LObject;
  /** External params from the embed tag — Director `externalParamValue()`. */
  externalParamValue(v: LVal): LVal;
  externalParamCount(): number;
  externalParamName(n: number): LVal;
}

export type BuiltinFn = (b: BuiltinBackend, args: LVal[], interp: Interpreter) => LVal;

function numArgs(args: LVal[], i: number): number {
  return asNum(args[i]);
}

// Round half away from zero (C round()): Math.round rounds halves toward
// +Infinity, so integer(-2.5) must be -3, not -2.
function roundHalfAway(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

export function createBuiltinTable(): Map<string, BuiltinFn> {
  const t = new Map<string, BuiltinFn>();
  const set = (names: string[], fn: BuiltinFn) => {
    for (const n of names) t.set(n.toLowerCase(), fn);
  };

  // ---- math ----
  set(['abs'], (b, a) => Math.abs(numArgs(a, 0)));
  // DirPlayer sqrt is ALWAYS float-typed (int.rs:46/float.rs:45 — Datum::Float)
  // and power is float-typed when either operand is (types.rs power: Float cases).
  // The mark matters for downstream division typing: `sqrt(4) / 2` must be a
  // float division (2.0 / 2 = 1.0), not int-truncated, and Gamesystem CIterateSeed
  // does `n / power(2, s)` — unmarked perfect-square powers silently truncate.
  set(['sqrt'], (b, a, interp) => interp.markFloatValue(Math.sqrt(numArgs(a, 0))));
  set(['sqr'], (b, a) => numArgs(a, 0) * numArgs(a, 0));
  set(['power'], (b, a, interp) => {
    const out = Math.pow(numArgs(a, 0), numArgs(a, 1));
    return interp.isFloatValue(a[0]) || interp.isFloatValue(a[1]) ? interp.markFloatValue(out) : out;
  });
  // integer() ROUNDS to the nearest whole (Director: integer(3.9) = 4; DirPlayer
  // f.round(); LibreShockwave javaRoundToInt) — half away from zero, NOT
  // truncation. trunc() is the truncating one. Was Math.trunc for both, so Room
  // Geometry getWorldCoordinate resolved a tile's center to the tile up-left
  // and the room hiliter hovered the wrong tile (U128).
  // String handling mirrors LibreShockwave's MathBuiltins::integer exactly: a
  // strict int parse, else a strict float parse (rounds), else VOID — NOT 0.
  // The corpus's Variable Container dump converts `key = value` lines with
  // `if integerp(integer(tValue)) then ... tValue = integer(tValue)`; with
  // integer("h") = 0 the guard converted hh_human's `human.size.64 = h` and
  // `human.parts.h = [...]` to 0 and every figure lookup broke (U141).
  set(['integer'], (b, a, interp) => {
    const v = a[0];
    if (typeof v === 'string') {
      const s = v.trim();
      if (s === '') return 0;
      if (s.length > 1 && s[0] === '*') {
        // Director hex-string constants: integer("*1A") = 26.
        const hex = parseInt(s.slice(1), 16);
        if (!Number.isNaN(hex) && /^[0-9a-fA-F]+$/.test(s.slice(1))) return interp.clearFloatMark(hex);
        return VOID;
      }
      if (/^[+-]?\d+$/.test(s)) return interp.clearFloatMark(parseInt(s, 10));
      if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return interp.clearFloatMark(roundHalfAway(Number(s)));
      return VOID;
    }
    return interp.clearFloatMark(roundHalfAway(numArgs(a, 0)));
  });
  // float(x) is FLOAT-TYPED even for whole numbers (Lingo: float(250) is a
  // float, so float(250) / 500 = 0.5, while 250 / 500 = 0). Human Class
  // 0002:536 lerps the walk with `tFactor = float(the milliSeconds -
  // pMoveStart) / pMoveTime` — without the mark, 250 / 500 truncated to 0
  // and the walk never advanced (the avatar teleported per status message).
  set(['float'], (b, a, interp) => interp.markFloatValue(numArgs(a, 0)));
  set(['trunc'], (b, a, interp) => interp.clearFloatMark(Math.trunc(numArgs(a, 0))));
  set(['random'], (b, a) => {
    const n = Math.floor(numArgs(a, 0));
    return n <= 0 ? 0 : 1 + Math.floor(Math.random() * n);
  });
  // DirPlayer min/max (types.rs): a single LIST arg is unwrapped element-wise
  // (`min([a, b])`), multiple scalar args reduce. Room Component 0011:341 does
  // `tRemoveCount = min([tRemoveCountMax, tActiveObjCount])` and Visualizer
  // Part Wrapper 0079:304 `tMinX1 = min(tLocs[#X1])` — without the unwrap,
  // asNum(list) = 0 collapsed the result to 0 (remove counts and bounding-box
  // math vanished).
  set(['min'], (b, a, interp) => {
    const vals = a.length === 1 && a[0] instanceof LList ? a[0].items : a;
    if (!vals.length) return 0;
    const nums = vals.map((v) => numArgs([v], 0));
    const out = Math.min(...nums);
    return vals.some((v) => interp.isFloatValue(v)) ? interp.markFloatValue(out) : out;
  });
  set(['max'], (b, a, interp) => {
    const vals = a.length === 1 && a[0] instanceof LList ? a[0].items : a;
    if (!vals.length) return 0;
    const nums = vals.map((v) => numArgs([v], 0));
    const out = Math.max(...nums);
    return vals.some((v) => interp.isFloatValue(v)) ? interp.markFloatValue(out) : out;
  });
  set(['bitAnd'], (b, a) => Math.round(numArgs(a, 0)) & Math.round(numArgs(a, 1)));
  set(['bitOr'], (b, a) => Math.round(numArgs(a, 0)) | Math.round(numArgs(a, 1)));
  set(['bitXor'], (b, a) => Math.round(numArgs(a, 0)) ^ Math.round(numArgs(a, 1)));
  set(['bitNot'], (b, a) => ~Math.round(numArgs(a, 0)));
  // Lingo sin/cos take DEGREES (C++ MathBuiltins parity: deg * pi/180).
  // Furniture_Bottle_Class's rolling anim and other corpus maths rely on them.
  set(['sin'], (b, a) => Math.sin((numArgs(a, 0) * Math.PI) / 180));
  set(['cos'], (b, a) => Math.cos((numArgs(a, 0) * Math.PI) / 180));

  // ---- stage/UI no-ops the corpus calls unconditionally (C++ parity: all
  //      return void and don't disturb the pipeline) ----
  set(['updatestage'], () => VOID);
  set(['beep'], () => VOID);
  set(['cursor'], () => VOID);
  set(['dontpassevent'], () => VOID);
  // Director `startTimer` resets `the timer` (Paalu game countdowns read it).
  set(['starttimer'], (b) => {
    b.resetTimer();
    return VOID;
  });
  // `gotoNetPage(url[, target])` — opens a URL (browser embed: window.open;
  // headless: log). Client Initialization uses it for client.reload.url.
  set(['gotonetpage'], (b, a) => {
    const url = toLingoString(a[0] ?? VOID);
    // Symbol targets (#_blank / #self) resolve by their name.
    const target =
      a[1] === undefined ? '_blank' :
        a[1] instanceof LSymbol ? a[1].name :
          toLingoString(a[1]);
    const g = globalThis as { open?: (u: string, t: string) => unknown };
    if (url !== '' && typeof g.open === 'function') {
      try { g.open(url, target); } catch { /* popup-blocked: silent */ }
    } else {
      b.log(`gotoNetPage(${url}, ${target})`);
    }
    return VOID;
  });
  // `callAncestor(#handler, instance[, args...])` — C++ LingoVM::callAncestor
  // parity: walk the instance's ANCESTOR chain (skipping the instance itself)
  // for the handler and run it with `me` still bound to the descendant.
  // A list of instances maps over (Credit_Furni/Active_Object_Extension:
  // `callAncestor(#construct, [me])`).
  // The walk starts at the ancestor of the SCRIPT CONTAINING the call
  // (Director semantics): classes along the chain that define the same
  // handler as the current one are skipped, so a child that re-implements a
  // handler and then calls callAncestor(#handler) reaches the handler's real
  // ancestor instead of re-entering itself. Without the skip, Furniture
  // Sound Machine's chain (Object Base <- Active Object Class <- Active
  // Object Extension Class <- Furniture Sound Machine Class) recursed:
  // Extension.define -> callAncestor(#define, [me]) found define on
  // me.ancestor == the Extension instance itself -> infinite depth -> the
  // sound machine's createRoomObject failed and it never rendered.
  set(['callancestor'], (b, a, interp) => {
    const handlerName = a[0] instanceof LSymbol ? a[0].name : toLingoString(a[0]);
    const target = a[1];
    const rest = a.slice(2);
    const targets = target instanceof LList ? target.items : [target];
    const currentScript = interp.currentScript;
    let last = VOID;
    for (const t of targets) {
      if (!(t instanceof LObjectClass)) continue;
      let cur = t.props.get('ancestor');
      let found: { script: Script; handler: Handler } | null = null;
      let hops = 0;
      while (cur instanceof LObjectClass) {
        const h = cur.handlers.get(handlerName.toLowerCase());
        if (h && cur.script && cur.script !== currentScript) { found = { script: cur.script, handler: h }; break; }
        if (++hops > 32) break;
        const next = cur.props.get('ancestor');
        cur = next instanceof LObjectClass ? next : null;
      }
      if (found) last = interp.callHandler(found.script, found.handler, rest, t, new Set());
      else b.warn(`callAncestor(#${handlerName}): no ancestor handler on ${t.scriptName}`);
    }
    return last;
  });

  // ---- strings & values ----
  // Director string coercion (DirPlayer string.rs / LibreShockwave
  // stringRefLikeJava parity): VOID coerces to EMPTY in string contexts.
  // `string(VOID)` = "" (the Connection Instance `send` relies on this to
  // emit empty message bodies for commands with no payload — sending the
  // literal "VOID" corrupted GETUSERFLATCATS/MESSENGER_GETREQUESTS packets),
  // `length(VOID)` = 0 (underpins the common `if length(me.prop) > 0`
  // idiom), and `string(#symbol)` drops the # prefix (`string(#foo)` = "foo").
  set(['length'], (b, a) => {
    const v = a[0];
    if (v === null || v === undefined) return 0;
    return typeof v === 'string' ? v.length : toLingoString(v).length;
  });
  set(['string'], (b, a) => {
    const v = a[0];
    if (v === null || v === undefined) return '';
    if (v instanceof LSymbol) return v.name;
    return toLingoString(v);
  });
  set(['value'], (b, a, interp) => {
    const v = a[0];
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      const direct = interp.evalExpressionString(v);
      // U92: Director value() parses a bare comma-separated list of literals
      // as a linear list — the server's availablesets message ("1,2,3,4,...")
      // flows through handle_availablesets' value(tMsg.content) and must pass
      // listp() or Figure_System never builds the selectable part list
      // (getCountOfPart = 0 -> random(0) = VOID -> the avatar editor arrows
      // iterate nothing and save dies). dirplayer parses value() strings as
      // full Lingo expressions; LibreShockwave's parseListOrPropList splits
      // list elements on top-level commas. The direct parse falls back to the
      // raw string for non-expressions, so retry bracketed ONLY when a comma
      // is present — non-comma bare words keep the literal-string fallback
      // (Variable Container GetValue: value(pItemList[x]) must not turn
      // variable values into lists).
      if (direct === v && v.includes(',')) {
        const wrapped = interp.evalExpressionString('[' + v + ']');
        if (wrapped instanceof LList) return wrapped;
      }
      return direct;
    }
    // Director (LibreShockwave TypeBuiltins::value): non-strings pass through
    // UNCHANGED. The Variable Container's GetValue does value(pItemList[x]) on
    // every variable — symbol values (#info etc.) must survive intact or
    // getClassVariable/getVariableValue fall back to their defaults, breaking
    // connection lookups (getVariableValue("connection.info.id", #Info)
    // returned #Info against a manager keyed by #info -> "Connection not
    // found"). null/undefined stay VOID so voidp-based default fallbacks in
    // GetValue still fire for genuinely missing variables (voidp is a strict
    // === null check).
    return v ?? VOID;
  });
  set(['symbol'], (b, a) => {
    const v = a[0];
    if (v instanceof LSymbol) return v;
    if (typeof v === 'string') return new LSymbol(v);
    return VOID;
  });
  set(['offset'], (b, a) => {
    // offset(needle, haystack) — 1-based position of needle in haystack.
    const needle = toLingoString(a[0]);
    const haystack = toLingoString(a[1]);
    const i = haystack.indexOf(needle);
    return i === -1 ? 0 : i + 1;
  });
  set(['charToNum'], (b, a) => {
    const s = toLingoString(a[0]);
    return s.length > 0 ? s.charCodeAt(0) : 0;
  });
  set(['numToChar'], (b, a) => String.fromCharCode(Math.round(numArgs(a, 0))));

  // ---- types ----
  set(['ilk'], (b, a) => {
    const sym = ilkOf(a[0]);
    // two-arg form: ilk(value, #type) returns 1/0
    if (a[1] instanceof LSymbol) {
      return sym.name.toLowerCase() === a[1].name.toLowerCase() ? 1 : 0;
    }
    return sym;
  });
  set(['voidp'], (b, a) => (a[0] === null ? 1 : 0));
  set(['objectp'], (b, a) => (a[0] instanceof LObjectClass ? 1 : 0));
  set(['stringp'], (b, a) => (typeof a[0] === 'string' ? 1 : 0));
  set(['integerp'], (b, a) => (typeof a[0] === 'number' && Number.isInteger(a[0]) ? 1 : 0));
  // floatp stays a pure non-integer check (NOT mark-aware): the Variable
  // Container's GetValue runs `floatp(float(tValue))` on EVERY boot variable
  // (Special Services 0043 / Variable Container 0046) — making float()
  // results count as floats flipped integer variable parsing ("5" -> 5) and
  // broke the class-variable chain at boot (broker.manager.class -> VOID ->
  // error-reporting recursion). The walk lerp needs float() marks only in
  // `float(a) / b` division, which never consults floatp.
  set(['floatp'], (b, a) => (typeof a[0] === 'number' && !Number.isInteger(a[0]) ? 1 : 0));
  set(['symbolp'], (b, a) => (a[0] instanceof LSymbol ? 1 : 0));
  // Director: proplists ARE lists (ilk is #proplist, but listp is TRUE).
  // The Download Instance gates on `listp(getStreamStatus(id))`.
  set(['listp'], (b, a) => (a[0] instanceof LList || a[0] instanceof LPropList ? 1 : 0));
  // Director `count()`: elements in a list/proplist, chars in a string
  // (FUSE: `count(tCastList)`, `tURL.char.count`...).
  set(['count'], (b, a) => {
    const v = a[0];
    if (v instanceof LList) return v.items.length;
    if (v instanceof LPropList) return v.props.size;
    if (typeof v === 'string') return v.length;
    if (v instanceof LPoint) return 2;
    return 0;
  });
  set(['pointp'], (b, a) => (a[0] instanceof LPoint ? 1 : 0));
  set(['memberp'], (b, a) => (a[0] instanceof LMemberRefClass ? 1 : 0));
  // Director `image(width, height)` — an offscreen image object (stub: size
  // props only, draw/fill/copyPixels no-op). Balloon Manager's flipH and the
  // Loading Bar draw on it; without it those calls hit VOID.
  set(['image'], (b, a) => {
    // Director 4-arg form `image(w, h, depth, paletteRef)` — Window Instance
    // buildVisual (0054:498) creates 8-bit buffers with a palette member,
    // and Image Wrapper prepare passes `the colorDepth` (32). Keep depth +
    // paletteRef on the LImage; the RGBA buffer is the same either way.
    const img = new LImage(Math.round(numArgs(a, 0)), Math.round(numArgs(a, 1)));
    if (a[2] !== undefined) {
      const d = Math.round(numArgs(a, 2));
      if (d > 0) img.depth = d;
    }
    if (a[3] !== undefined) {
      img.paletteRef = a[3];
      // An image created FROM a palette member also makes that palette the
      // movie's current palette for paletteIndex(n) lookups — same rule as the
      // `paletteref` member setter (engine.ts). The corpus Navigator builds
      // row backs via `image(311,16,8,member("nav_ui_palette"))` then fills
      // with `paletteIndex(82)`; without this, paletteIndex resolves against
      // the wrong/absent palette and the row body paints neutral gray.
      if (a[3] instanceof LMemberRefClass) b.adoptImagePalette(a[3]);
      // Attach the resolved table to the image too — image.getPixel() maps
      // pixel RGB back to its palette index (Photo Component terrain
      // sampling, Object Mover wall hit-tests) off `img.palette`, the same
      // field bitmap members carry from their .pal companions.
      const table = b.resolvePaletteTable(a[3]);
      if (table) img.palette = table;
    }
    // DirPlayer image(w, h, 8) with NO palette arg attaches the system
    // palette (SystemWin, index 0 = white) — the corpus Unique Element
    // flipH() rebuilds pimage via `image(w, h, pimage.depth)` and the
    // recreated image must still carry palette index 0 = white so the
    // ink-8 copyPixels matte keys the white backdrop of the flipped
    // purse_sd shadow (without it the matte has no palette and the grey
    // shadow's white background pastes as a white box at blend 30).
    else if (img.depth <= 8) img.palette = SYSTEM_PALETTE;
    // DirPlayer Bitmap::new parity (U122 info_name_bg): a fresh INDEXED image
    // is NOT transparent — it is filled with the palette's background (index
    // 0), which is opaque white for the system/window palettes. FUSE window
    // compositing depends on it: the group buffer `image(w,h,8,tPalette)`
    // starts white, the plate's ink-36 keying leaves that white in place, and
    // the info_name_bg strip's 70% blend over it yields the light grey info
    // stand plate (was: transparent buffer -> the strip fell through to the
    // room as black). 16/32-bit surfaces stay TRANSPARENT (alpha 0): the room
    // wall/floor wrappers composite their parts into a STAGE-SIZED 32-bit
    // buffer (`Visualizer_Part_Wrapper renderImage` ->
    // `image(tStageWidth, tStageHeight, 32)`) whose uncovered area must let
    // the room behind show through — an opaque white fill there, multiplied
    // by the wrapper sprite's ink-41 wall-color tint, flooded the whole stage
    // with the wall color (U123).
    const fw = Math.max(0, Math.round(img.width));
    const fh = Math.max(0, Math.round(img.height));
    if (fw > 0 && fh > 0 && img.depth <= 8) {
      const buf = img.ensure();
      let fr = 255, fg = 255, fb = 255;
      const table = a[3] !== undefined ? b.resolvePaletteTable(a[3]) : SYSTEM_PALETTE;
      if (table && table.length > 0) {
        fr = table[0][0];
        fg = table[0][1];
        fb = table[0][2];
      }
      for (let i = 0; i < fw * fh; i++) {
        buf[i * 4] = fr;
        buf[i * 4 + 1] = fg;
        buf[i * 4 + 2] = fb;
        buf[i * 4 + 3] = 255;
      }
      img.dirty = true;
    }
    return img;
  });
  // Director `date()` / `time()` — the current date/time strings (the Error
  // Manager's fatal report header does `date() && time() & RETURN & ...`;
  // same formats as `the date` / `the time`).
  set(['date'], () => new Date().toLocaleDateString('en-US'));
  set(['time'], () => new Date().toLocaleTimeString('en-US'));

  // FUSE helper `chars(str, from, to)`: 1-based inclusive substring. Defined
  // nowhere in the exported scripts, but CastLoad/HttpCookie/Connection and
  // the Variable Container all rely on it (e.g. stripping "#" or extensions).
  set(['chars'], (b, a) => {
    const s = toLingoString(a[0]);
    const from = Math.round(numArgs(a, 1));
    const to = a[2] !== undefined ? Math.round(numArgs(a, 2)) : s.length;
    const f = Math.max(1, from);
    const t = Math.min(s.length, to);
    if (f > t) return '';
    return s.slice(f - 1, t);
  });

  // ---- list/point/rect constructors ----
  set(['list'], (b, a) => new LList(a.slice()));
  set(['point'], (b, a) => new LPoint(numArgs(a, 0), numArgs(a, 1)));
  // Director rect() takes EITHER four numbers `rect(l, t, r, b)` OR two
  // points `rect(point1, point2)` = rect(p1.x, p1.y, p2.x, p2.y). The two-point
  // form is the corpus's rect-offset idiom (`pCacheRectA + rect(pLocFix, pLocFix)`
  // with pLocFix = point(-1, 2) shifts the avatar bodyparts 1px left, 2px down;
  // passing points through asNum zeroed them, dropping the offset entirely).
  set(['rect'], (b, a) => {
    if (a.length === 2 && a[0] instanceof LPoint && a[1] instanceof LPoint) {
      return new LRect(a[0].locH, a[0].locV, a[1].locH, a[1].locV);
    }
    return new LRect(numArgs(a, 0), numArgs(a, 1), numArgs(a, 2), numArgs(a, 3));
  });
  // Director rect functions (LibreShockwave ConstructorBuiltins::unionRect /
  // intersect parity). FUSE Bodypart_Class_EX tracks its dirty rect with
  // `me.pUpdateRect = union(me.pUpdateRect, pCacheRectA)`. Empty = degenerate
  // (right<=left or bottom<=top). Non-rect / missing args -> VOID.
  const isEmptyRect = (r: LRect) => r.right <= r.left || r.bottom <= r.top;
  const rectArg = (v: LVal | undefined): LRect | null => (v instanceof LRect ? v : null);
  set(['union'], (b, a) => {
    if (a.length < 2) return VOID;
    const f = rectArg(a[0]);
    const s = rectArg(a[1]);
    if (!f || !s) return VOID;
    const fe = isEmptyRect(f);
    const se = isEmptyRect(s);
    if (fe && se) return new LRect(0, 0, 0, 0);
    if (fe) return s;
    if (se) return f;
    return new LRect(Math.min(f.left, s.left), Math.min(f.top, s.top), Math.max(f.right, s.right), Math.max(f.bottom, s.bottom));
  });
  set(['intersect'], (b, a) => {
    if (a.length < 2) return VOID;
    const f = rectArg(a[0]);
    const s = rectArg(a[1]);
    if (!f || !s) return VOID;
    const left = Math.max(f.left, s.left);
    const top = Math.max(f.top, s.top);
    const right = Math.min(f.right, s.right);
    const bottom = Math.min(f.bottom, s.bottom);
    if (right <= left || bottom <= top) return new LRect(0, 0, 0, 0);
    return new LRect(left, top, right, bottom);
  });
  // rgb(r, g, b) | rgb("#RRGGBB"/"#RGB") | rgb(0xRRGGBB) | rgb(colorObj) —
  // always an LColor (ilk #color). FUSE gates on `ilk(x, #color)` in Loading
  // Bar define(), and Layout Parser re-wraps stored colors with rgb(...).
  set(['rgb'], (b, a) => {
    if (a.length >= 3) {
      return new LColor(Math.round(numArgs(a, 0)), Math.round(numArgs(a, 1)), Math.round(numArgs(a, 2)));
    }
    return colorFrom(a[0] ?? VOID) ?? new LColor(0, 0, 0);
  });
  set(['color'], (b, a) => {
    if (a.length >= 3) {
      return new LColor(Math.round(numArgs(a, 0)), Math.round(numArgs(a, 1)), Math.round(numArgs(a, 2)));
    }
    if (typeof a[0] === 'number') return intColor(a[0]);
    if (typeof a[0] === 'string') return hexColor(a[0]) ?? new LColor(0, 0, 0);
    return colorFrom(a[0] ?? VOID) ?? new LColor(0, 0, 0);
  });
  // paletteIndex(n) — color at index (n & 0xFF) of the movie's current palette
  // (C++ ConstructorBuiltins::paletteIndex -> paletteIndexColor). The Figure
  // System builds avatar part colors with `paletteIndex(integer(tColor))`, so
  // this must resolve real RGB from the loaded .pal, not a neutral gray.
  set(['paletteIndex'], (b, a) => b.paletteColor(Math.round(asNum(a[0]))));

  // ---- director objects ----
  // ---- external params (sw1..sw9, src, ... from the embed tag) ----
  set(['externalParamValue'], (b, a) => b.externalParamValue(a[0]));
  set(['externalParamCount'], (b) => b.externalParamCount());
  set(['externalParamName'], (b, a) => b.externalParamName(Math.round(numArgs(a, 0))));
  // `script("Name")` / `script(memberNum)` / `script(memberRef)` — parent-
  // script reference; .new()/.construct() instantiate. The memberRef form is
  // the corpus's standard way to grab a script by cast position:
  // initializeAndRun does `new script(member(5, 1))` (vercode, a Parent
  // member in the movie's Internal cast) — before the memberRef case this
  // warned "unknown script member(5 of castLib 1)" and returned VOID.
  set(['script'], (b, a) => {
    const v = a[0];
    let script: Script | null = null;
    if (typeof v === 'string') script = b.resolveScript(v);
    else if (v instanceof LSymbol) script = b.resolveScript(v.name);
    else if (typeof v === 'number') script = b.resolveScriptByNumber(Math.round(v));
    else if (v instanceof LMemberRefClass) script = v.host?.memberScript(v) ?? null;
    if (!script) {
      b.warn(`script(): unknown script ${toLingoString(v)}`);
      return VOID;
    }
    return new LScriptRefClass(script);
  });
  set(['param'], (b, a, interp) => interp.param(Math.round(asNum(a[0]))));
  set(['member'], (b, a) => {
    const v = a[0];
    // member(num [, castLibNum]) / member(name [, castLibNum]). The 2nd arg
    // may be a castLib NAME (e.g. `member(tMemName, pBinCastName)` where
    // pBinCastName = "bin" in the Dynamic Downloader) — asNum would coerce
    // "bin" to 0 and resolve nothing.
    let castLibNum: number | undefined;
    const cArg = a[1];
    if (cArg !== undefined && cArg !== null) {
      if (typeof cArg === 'string' || cArg instanceof LSymbol) {
        const cl = b.getCastLib(cArg);
        castLibNum = cl ? cl.number : undefined;
      } else {
        castLibNum = Math.round(asNum(cArg));
      }
    }
    if (typeof v === 'number') return b.getMember(Math.round(v), castLibNum) ?? VOID;
    if (typeof v === 'string') {
      if (castLibNum !== undefined) return b.getMemberByNameInCast(v, castLibNum) ?? VOID;
      return b.getMemberByName(v) ?? VOID;
    }
    if (v instanceof LMemberRefClass) return v;
    return VOID;
  });
  // Director `memberExists(nameOrNum)`. The FUSE Layout Parser gates every
  // window-def parse on `memberExists("habbo_basic.window")`, and Text
  // Manager's dump() gates the System Props bootstrap on it — it was missing
  // entirely, so those gates always read VOID and silently skipped.
  // Director `createMember(name, #kind[, castLibNum])` — a named dynamic member
  // returning its movie-global number. The Entry Cloud Class builds its cloud
  // surface this way: `member(createMember("entrycloud_" & tCount, #bitmap))`.
  set(['createmember'], (b, a) => {
    const name = toLingoString(a[0]);
    const kind = a[1] instanceof LSymbol ? a[1].name : toLingoString(a[1] ?? 'bitmap');
    const castNum = a[2] !== undefined && a[2] !== null ? Math.round(asNum(a[2])) : 1;
    return b.createNamedMember(name, kind, castNum);
  });
  // Director `field("Name"[, castLib])` evaluates to the field's *text*.
  // The 2nd arg matters: Resource Manager's readAliasIndexesFromField calls
  // `field(tAliasIndex, tCastlibNo)` against a specific downloaded cast, and
  // each furniture cast ships its own memberalias.index — searching all casts
  // could read a stale alias file from another cast. Resolve the cast the
  // same way member() does (number, string name, symbol, or castLib ref) —
  // asNum would coerce "bin"-style names to 0 and read the wrong cast.
  set(['field'], (b, a) => {
    const v = a[0];
    let castLibNum: number | undefined;
    const cArg = a[1];
    if (cArg !== undefined && cArg !== null) {
      const cl = b.getCastLib(cArg);
      castLibNum = cl ? cl.number : undefined;
    }
    let ref: LMemberRef | null = null;
    if (typeof v === 'number') ref = b.getMember(Math.round(v), castLibNum);
    else if (typeof v === 'string') ref = castLibNum !== undefined ? b.getMemberByNameInCast(v, castLibNum) : b.getMemberByName(v);
    else if (v instanceof LMemberRefClass) ref = v;
    if (!ref) return VOID;
    return b.getMemberProp(ref, 'text');
  });
  set(['sprite'], (b, a) => b.getSprite(Math.round(numArgs(a, 0))));
  set(['castLib'], (b, a) => b.getCastLib(a[0]) ?? VOID);
  set(['window'], (b, a) => b.getWindow(toLingoString(a[0])) ?? VOID);
  // Director `timeout(name)` — a timer object; .new(period, #h, target) registers it.
  set(['timeout'], (b, a) => b.timeout(toLingoString(a[0])));
  // `xtra("Multiuser")` — Xtra instance/ref (multiuser is stubbed).
  set(['xtra'], (b, a) => b.xtraInstance(toLingoString(a[0])));
  // Director preferences — `getPref(name)` returns EMPTY when unset; names are
  // case-insensitive (the corpus writes setPref("blocktime", ...) and reads
  // getPref("Blocktime")). HttpCookie, quick-login and registration blocktime
  // all live here.
  set(['getPref'], (b, a) => b.getPref(toLingoString(a[0] ?? '')));
  set(['setPref'], (b, a) => {
    b.setPref(toLingoString(a[0] ?? ''), toLingoString(a[1] ?? ''));
    return VOID;
  });
  set(['deletePref'], (b, a) => {
    b.setPref(toLingoString(a[0] ?? ''), '');
    return VOID;
  });
  // Director event control: `pass()` continues the event to lower-priority
  // handlers; `stopEvent()` halts the rest of the current dispatch chain
  // (lower behaviors, the editable-field insertion for key events). The Event
  // Broker Behavior calls both in mouseDown/mouseUp/keyDown.
  set(['pass'], () => VOID);
  set(['stopEvent'], (b) => {
    (b as unknown as { _stopEventPending: boolean })._stopEventPending = true;
    return VOID;
  });
  set(['new'], (b, a, interp) => {
    const type = a[0];
    // `new(xtra("Multiuser"))` — instantiate an Xtra ref.
    if (type instanceof LObjectClass && type.scriptName.startsWith('xtra:')) {
      const name = type.props.get('name') ?? type.scriptName.slice(5);
      return b.xtraInstance(toLingoString(name));
    }
    if (type instanceof LSymbol && type.name.toLowerCase() === 'script') {
      const name = typeof a[1] === 'string' ? a[1] : toLingoString(a[1]);
      const script = b.resolveScript(name);
      if (!script) {
        b.warn(`new(script): unknown script ${name}`);
        return VOID;
      }
      return interp.newInstance(script, a.slice(2));
    }
    // `new(script "Name")` — instantiate a script ref (FUSE Sprite Manager:
    // `pEventBroker = script("Event Broker Behavior")` then
    // `scriptInstanceList = [new(pEventBroker)]` wires the click brokers).
    if (type instanceof LScriptRefClass) {
      return interp.newInstance(type.script, a.slice(1));
    }
    if (type instanceof LSymbol) {
      // `new(#field, castLib(2))` — create a dynamic cast member. Director
      // maps the symbol to a member kind; #script is handled above.
      const kindMap: Record<string, string> = {
        field: 'text',
        text: 'text',
        bitmap: 'bitmap',
        sound: 'sound',
        font: 'font',
        palette: 'palette',
      };
      const kind = kindMap[type.name.toLowerCase()];
      if (kind) {
        const castArg = a[1] ?? 1;
        const cast = b.getCastLib(castArg);
        // `castLib("bin")` may not exist in this export; fall back to cast 1
        // so dynamic members still get created and member(n) resolves.
        const castNum = cast ? cast.number : 1;
        const ref = b.newMember(kind, castNum);
        if (ref) return ref;
      }
      b.warn(`new(#${type.name}, ...) member creation is a stub`);
      return VOID;
    }
    return VOID;
  });
  set(['go', 'goToLoop', 'goNext', 'goPrevious'], (b, a) => {
    b.go(a[0]);
    return VOID;
  });
  set(['puppetSprite'], (b, a) => {
    b.setPuppet(Math.round(numArgs(a, 0)), Math.round(numArgs(a, 1)));
    return VOID;
  });
  set(['puppetSound'], (b, a) => {
    b.puppetSound(Math.round(numArgs(a, 0)), a[1]);
    return VOID;
  });
  set(['sound'], (b, a) => b.getSoundChannel(Math.round(numArgs(a, 0))));
  // The Song Player / Song Controller (hh_shared 0055/0058) drive the sound
  // machine's tracks through these legacy Director sound builtins — without
  // them every queueSound/startSoundChannel no-oped and the machine stayed
  // silent while credits (puppetSound) worked.
  set(['queueSound'], (b, a) => {
    b.queueSoundOnChannel(a[0], Math.round(numArgs(a, 1)), a[2]);
    return VOID;
  });
  set(['startSoundChannel'], (b, a) => b.startSoundChannelBuiltin(Math.round(numArgs(a, 0))));
  set(['stopSoundChannel'], (b, a) => b.stopSoundChannelBuiltin(Math.round(numArgs(a, 0))));
  set(['playSoundInChannel'], (b, a) => b.playSoundInChannelBuiltin(a[0], Math.round(numArgs(a, 1))));
  set(['moveToFront', 'moveToBack', 'moveForward', 'moveBackward'], () => VOID);
  set(['puppetTempo'], (b, a) => {
    b.setFrameTempo(Math.round(numArgs(a, 0)));
    return VOID;
  });

  // ---- net ----
  set(['getNetText'], (b, a) => b.netGetNetText(toLingoString(a[0])));
  set(['netDone'], (b, a) => b.netDone(typeof a[0] === 'number' ? a[0] : undefined));
  set(['getStreamStatus'], (b, a) => b.getStreamStatus(typeof a[0] === 'number' ? a[0] : 0));
  set(['netError'], (b, a) => b.netError(typeof a[0] === 'number' ? a[0] : undefined));
  set(['netTextResult'], (b, a) => b.netTextResult(typeof a[0] === 'number' ? a[0] : undefined));
  set(['netAbort'], () => VOID);
  set(['preloadNetThing'], (b, a) => b.preloadNetThing(toLingoString(a[0])));
  set(['downloadNetThing'], (b, a) => b.preloadNetThing(toLingoString(a[0])));
  set(['importFileInto'], (b, a) => b.importFileInto(a[0], toLingoString(a[1])));

  // ---- FUSE: variables ----
  set(['getVariable'], (b, a) => {
    const v = b.globalGet(toLingoString(a[0]));
    if (v !== undefined && v !== null) return v;
    return a[1] ?? VOID;
  });
  set(['getVariableValue'], (b, a) => {
    const v = b.globalGet(toLingoString(a[0]));
    if (v !== undefined && v !== null) return v;
    return a[1] ?? VOID;
  });
  set(['setVariable'], (b, a) => {
    b.globalSet(toLingoString(a[0]), a[1] ?? VOID);
    return VOID;
  });
  // FUSE tuning knobs (`getIntVariable("net.operation.count", 2)`, retry
  // counts/delays, window positions...). Missing/non-numeric -> default.
  set(['getIntVariable'], (b, a) => {
    const v = b.globalGet(toLingoString(a[0]));
    const def = a[1] !== undefined ? asNum(a[1]) : 0;
    if (v === undefined || v === null) return def;
    const n = asNum(v);
    return Number.isFinite(n) ? Math.round(n) : def;
  });
  set(['variableExists'], (b, a) => (b.globalGet(toLingoString(a[0])) !== undefined ? 1 : 0));
  const dumpField = (b: BuiltinBackend, a: LVal[]): LVal => {
    const member = b.getMemberByName(toLingoString(a[0]));
    const text = (member as unknown as { text?: string })?.text;
    if (typeof text === 'string') {
      let count = 0;
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        // Real FUSE external_variables.txt is `key=value` per line; the
        // tab form is also accepted.
        let key: string;
        let value: string;
        const tab = trimmed.indexOf('\t');
        const eq = trimmed.indexOf('=');
        if (tab > 0 && (eq < 0 || tab < eq)) {
          key = trimmed.slice(0, tab).trim();
          value = trimmed.slice(tab + 1).trim();
        } else if (eq > 0) {
          key = trimmed.slice(0, eq).trim();
          value = trimmed.slice(eq + 1).trim();
        } else {
          continue;
        }
        if (key) {
          b.globalSet(key, value);
          count++;
        }
      }
      return count > 0 ? 1 : 0;
    }
    return 0;
  };

  set(['dumpVariableField', 'dumpTextField'], dumpField);
  set(['getText'], (b, a) => {
    const member = b.getMemberByName(toLingoString(a[0]));
    const text = (member as unknown as { text?: string })?.text;
    if (typeof text === 'string') return text;
    return a[1] ?? VOID;
  });

  // ---- FUSE: objects ----
  set(['getObject'], (b, a) => {
    const key = keyOf(a[0]);
    if (key === undefined) return VOID;
    return b.getObjectById(key) ?? VOID;
  });
  set(['objectExists'], (b, a) => {
    const key = keyOf(a[0]);
    return key !== undefined && b.getObjectById(key) !== null ? 1 : 0;
  });
  set(['removeObject'], (b, a) => {
    const key = keyOf(a[0]);
    if (key !== undefined) b.removeObjectById(key);
    return VOID;
  });
  set(['newObject'], (b, a, interp) => {
    const script = b.resolveScript(toLingoString(a[0]));
    if (!script) {
      b.warn(`newObject: unknown class ${toLingoString(a[0])}`);
      return VOID;
    }
    const obj = interp.newInstance(script, []);
    const params = a[1];
    if (params instanceof LPropList) {
      for (const [k, v] of params.props) obj.props.set(k, v);
    }
    return obj;
  });
  set(['getUniqueID', 'getUniqueId'], (b) => b.getUniqueId());

  // ---- FUSE: messages & windows ----
  set(['executeMessage'], (b, a) => {
    const msg = a[0] instanceof LSymbol ? a[0].name : toLingoString(a[0]);
    b.dispatchMessage(msg, a[1] ?? VOID);
    return VOID;
  });
  set(['createWindow'], (b, a) => b.createWindow(toLingoString(a[0])) ?? VOID);
  set(['removeWindow'], (b, a) => {
    b.removeWindow(toLingoString(a[0]));
    return VOID;
  });
  set(['windowExists'], (b, a) => (b.windowExists(toLingoString(a[0])) ? 1 : 0));
  set(['error'], (b, a) => {
    b.warn(`ERROR: ${toLingoString(a[1] ?? '')} (handler ${toLingoString(a[2] ?? '')})`);
    return VOID;
  });
  set(['warning'], (b, a) => {
    b.warn(`warning: ${toLingoString(a[1] ?? a[0] ?? '')}`);
    return VOID;
  });

  // ---- FUSE: connections ----
  set(['getConnection'], (b, a) => b.getConnection(toLingoString(a[0])));
  set(['connectionExists'], (b, a) => (b.connectionExists(toLingoString(a[0])) ? 1 : 0));
  set(['removeConnection'], (b, a) => {
    b.removeConnection(toLingoString(a[0]));
    return VOID;
  });
  set(['registerListener'], (b, a) => {
    b.registerListener(toLingoString(a[0]), toLingoString(a[1]), a[2]);
    return VOID;
  });
  set(['registerCommands'], (b, a) => {
    b.registerCommands(toLingoString(a[0]), toLingoString(a[1]), a[2]);
    return VOID;
  });
  set(['unregisterListener'], (b, a) => {
    b.unregisterListener(toLingoString(a[0]), toLingoString(a[1]));
    return VOID;
  });


  // ---- sprite helper ----
  set(['setRollover'], (b, a) => {
    b.setRollover(Math.round(numArgs(a, 0)));
    return VOID;
  });

  set(['connectionSend'], (b, a) => {
    const params = a[2] && !(a[2] === null) ? ` ${toLingoString(a[2])}` : '';
    b.log(`CONN ${toLingoString(a[0])} <- ${toLingoString(a[1])}${params}`);
    return VOID;
  });

  // ---- bare list/proplist builtins (C++ ListBuiltins parity) ----
  // Director has both method forms (tList.sort()) and bare forms (sort(tList));
  // the FUSE corpus calls the bare forms in a few hot spots.
  set(['add'], (b, a) => {
    if (a[0] instanceof LList) a[0].items.push(a[1] ?? VOID);
    return VOID;
  });
  set(['sort'], (b, a) => {
    if (a[0] instanceof LList) {
      a[0].items.sort(lingoListCompare);
    }
    return VOID;
  });
  set(['getAt'], (b, a) => {
    const c = a[0];
    const i = Math.round(asNum(a[1]));
    if (c instanceof LList) return i >= 1 && i <= c.items.length ? c.items[i - 1] : VOID;
    if (c instanceof LPropList) {
      // numeric getAt on a proplist returns the VALUE at insertion position
      // (matches the engine's positional getIndexValue semantics)
      const values = [...c.props.values()];
      return i >= 1 && i <= values.length ? values[i - 1] : VOID;
    }
    return VOID;
  });
  set(['getAProp'], (b, a) => {
    const c = a[0];
    const key = keyOf(a[1]);
    if (c instanceof LPropList && key !== undefined) return c.props.get(key) ?? VOID;
    if (c instanceof LList && typeof a[1] === 'number') {
      const i = Math.round(a[1]);
      return i >= 1 && i <= c.items.length ? c.items[i - 1] : VOID;
    }
    return VOID;
  });
  set(['setAProp'], (b, a) => {
    // C++ putTyped parity: replace the FIRST match, else append (same rule as
    // the proplist method setAProp). Variable Container `dump` builds the boot
    // variable list with the BARE form `setaProp(me.pItemList, tProp, tValue)`.
    const c = a[0];
    const key = keyOf(a[1]);
    if (c instanceof LPropList && key !== undefined) c.props.set(key, a[2] ?? VOID);
    else if (c instanceof LList && typeof a[1] === 'number') {
      const i = Math.round(a[1]);
      if (i >= 1) {
        while (c.items.length < i) c.items.push(VOID);
        c.items[i - 1] = a[2] ?? VOID;
      }
    }
    return VOID;
  });
  set(['addAProp'], (b, a) => {
    // C++ appendProperty: ALWAYS append (duplicates kept).
    const c = a[0];
    const key = keyOf(a[1]);
    if (c instanceof LPropList && key !== undefined) c.props.append(key, a[2] ?? VOID);
    else if (c instanceof LList) c.items.push(a[2] ?? VOID);
    return VOID;
  });
  set(['deleteAProp'], (b, a) => {
    const c = a[0];
    const key = keyOf(a[1]);
    if (c instanceof LPropList && key !== undefined) c.props.delete(key);
    return VOID;
  });
  set(['countAProp'], (b, a) => {
    // Director countaProp: number of properties in a property list (linear
    // lists return their item count).
    const c = a[0];
    if (c instanceof LPropList) return c.props.size;
    if (c instanceof LList) return c.items.length;
    return 0;
  });
  set(['getPropAt'], (b, a) => {
    const c = a[0];
    const i = Math.round(asNum(a[1]));
    if (c instanceof LPropList) {
      const keys = [...c.props.keys()];
      return i >= 1 && i <= keys.length ? keys[i - 1] : VOID;
    }
    if (c instanceof LList) return i >= 1 && i <= c.items.length ? c.items[i - 1] : VOID;
    return VOID;
  });
  set(['duplicate'], (b, a) => (a[0] instanceof LList || a[0] instanceof LPropList ? duplicateValue(a[0]) : VOID));

  // ---- mouse / stage builtins ----
  set(['rollover'], (b, a) => {
    // rollover() -> channel under mouse; rollover(n) -> TRUE if mouse over
    // sprite n (a direct concrete_sprite_hit_test — E-Dice passes its LOWER
    // part while the die above it is under the cursor; DirPlayer ignores
    // z-order here). n may be a channel number or a sprite ref.
    if (a.length === 0) return b.rollover();
    const target = a[0] instanceof LSpriteRefClass ? a[0].channel : Math.round(asNum(a[0]));
    if (b.rolloverSprite) return b.rolloverSprite(target) ? 1 : 0;
    return b.rollover() === target ? 1 : 0;
  });
  set(['inside'], (b, a) => {
    // inside(point, rect) -> 1 when the point is inside the rect (half-open).
    const p = a[0];
    const r = a[1];
    if (p instanceof LPoint && r instanceof LRect) {
      return p.locH >= r.left && p.locH < r.right && p.locV >= r.top && p.locV < r.bottom ? 1 : 0;
    }
    return 0;
  });
  set(['getWindowIdList'], (b) => new LList(b.getWindowIdList()));

  set(['stopClient'], (b) => {
    // DirPlayer/updated-client host function: the movie's Initialization
    // stopMovie() calls it when the single-instance guards trip (a window is
    // already open / the active window isn't the stage). The movie follows
    // with go(1) into the idling Loop frame — the client is stopped.
    b.log('stopClient: client stopped');
    return VOID;
  });

  // ---- misc no-ops that appear in Habbo code ----
  set(
    ['noop', 'setCallback', 'updateStage', 'unloadCast', 'loadCast', 'startTimer', 'stopTimer', 'cursor', 'setCursor', 'pauseUpdate', 'nothing', 'beep', 'delay', 'alert', 'quit', 'halt', 'restart'],
    () => VOID,
  );

  return t;
}
