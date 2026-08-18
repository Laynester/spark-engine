import type { Expr, Handler, Script, Stmt, TheSegment } from './ast.js';
import { parseExpr } from './parser.js';
import {
  asNum, colorFrom, duplicateValue, ilkOf, isTruthy, keyOf, LEMPTY, lingoAdd, lingoConcat,
  lingoEquals, lingoListCompare, lingoMod, lingoMultiply, lingoNegate, lingoSubtract, toLingoString, VOID,
  type LImage, type LList, type LMemberRef, type LObject, type LPoint, type LPropList,
  type LRect, type LSpriteRef, type LStageRef, type LVal, type LWindowRef,
  LSymbol, LCastLibRef, LList as LListClass, LPropList as LPropListClass,
  PropPairs as PropPairsClass,
  LMemberRef as LMemberRefClass, LSpriteRef as LSpriteRefClass,
  LCastLibRef as LCastLibRefClass, LWindowRef as LWindowRefClass,
  LImage as LImageClass, LRect as LRectClass, LEmptyValue,
  LColor as LColorClass,
  LObject as LObjectClass, LPoint as LPointClass, LStageRef as LStageRefClass,
  LScriptRef as LScriptRefClass,
  type MemberHost,
} from './values.js';
import { matteRegionMask } from '../stage/matte.js';

export class ReturnSignal {
  constructor(public value: LVal) {}
}
export class ExitSignal {}
export class ExitRepeatSignal {}
export class NextRepeatSignal {}

export interface GlobalHandlerRef {
  script: Script;
  handler: Handler;
}

export interface InterpreterHost extends MemberHost {
  log(msg: string): void;
  /** U66 debug: "<cast>#<n> \"<name>\"" for the member owning this LImage, else "". */
  debugCopyOwner(img: unknown): string;
  warn(msg: string): void;
  getMember(number: number, castLibNumber?: number): LMemberRef | null;
  getMemberByName(name: string): LMemberRef | null;
  /** U67: the RGB table behind a paletteRef value (palette member name string,
   *  member ref, or built-in symbol like #grayscale); null when unresolvable. */
  resolvePaletteTable(value: LVal): number[][] | null;
  /** Director `new(#field, castLib(n))` — create a dynamic cast member. */
  newMember(kind: string, castLibNumber: number): LMemberRef | null;
  getSprite(channel: number): LSpriteRef;
  getCastLib(arg: LVal): LCastLibRef | null;
  getWindow(id: string): LWindowRef | null;
  getStage(): LStageRef;
  /** Persistent stage drawing surface (`(the stage).image`). */
  stageImage(): LImage;
  /** The COMPOSITED scene as an image (Director `(the stage).image` reads are
   *  the displayed stage), or null when no adapter can capture it. Consumed
   *  when Lingo uses the stage image as a SOURCE (crop / copyPixels src) —
   *  the FUSE screen camera and the Photo Interface camera shot. */
  stageComposite?(): LImage | null;
  /** Lingo wrote pixels into this image (copyPixels/fill/draw/setPixel). The
   *  host marks the owning member's surface painted so a plain bitmap member
   *  displays its live painted surface instead of the original raw bytes
   *  (FUSE screen camera). Masked members (ink 9) keep the raw+mask path. */
  imageMutated?(img: LImage): void;
  /** Stage background as a color object (`(the stage).bgColor`). */
  stageBgColor(): LVal;
  getThe(head: string, chain: TheSegment[]): LVal;
  setThe(head: string, chain: TheSegment[], value: LVal): void;
  /** Current `the itemDelimiter` (default ",") — used by item chunk splitting. */
  itemDelimiter(): string;
  resolveGlobalHandler(name: string): GlobalHandlerRef | null;
  resolveScript(name: string): Script | null;
  globalGet(name: string): LVal | undefined;
  /** globalGet with an already-lowercased key — the interpreter computes the
   *  key once per identifier read and hands it down instead of lowercasing
   *  again on every host call. The original-case name is passed too so hosts
   *  with case-sensitive stores (the FUSE Variable Container mirror) probe it
   *  exactly as globalGet did. */
  globalGetLower?(key: string, name: string): LVal | undefined;
  globalSet(name: string, value: LVal): void;
  go(frame: LVal): void;
  builtin(name: string, args: LVal[], interp: Interpreter): LVal | undefined;
  memberMethod(m: LMemberRef, name: string, args: LVal[]): LVal;
  spriteMethod(s: LSpriteRef, name: string, args: LVal[]): LVal;
  windowMethod(w: LWindowRef, name: string, args: LVal[]): LVal;
  rollover(): number;
  /** DirPlayer `rollover(spriteNum)`: TRUE when the mouse is over THAT
   *  specific sprite (direct hit test, ignoring sprites stacked above it). */
  rolloverSprite?(n: number): boolean;
  setRollover(n: number): void;
  makeObject(script: Script): LObject;
  getObjectById(id: string): LObject | null;
  setObjectById(id: string, obj: LObject): void;
  removeObjectById(id: string): void;
  /** Shared `xtra("Name")` stub factory. */
  xtraInstance(name: string): LObject;
  /** Real Xtra method dispatch (WebSocket-backed Multiuser) — optional;
   *  hosts without it keep the lenient 0-returning stub contract. */
  xtraMethod?(obj: LObject, name: string, args: LVal[]): LVal;
  /** Real xmlparser Xtra (FUSE Figure System/Data parse partsets.xml,
   *  draworder.xml, animation.xml and figuredata.xml through it) — optional;
   *  hosts without it keep the lenient stub contract (every *.loaded flag
   *  flips to 1 with an empty child tree). */
  xmlParserMethod?(obj: LObject, name: string, args: LVal[]): LVal;
  /** Director `sound(n)` channel object methods (play/queue/stop/...) —
   *  optional; hosts without it keep the lenient stub contract. */
  soundChannelMethod?(obj: LObject, name: string, args: LVal[]): LVal;
  registerTimeout(obj: LObject, period: number, handler: string, target: LObject): void;
  forgetTimeout(obj: LObject): void;
  /** `me.delay(ms, #handler, args...)` — schedule a one-shot handler call on an
   *  object after ms milliseconds (corpus-wide idiom: CastLoad Manager's
   *  DoneCurrentDownLoad drains pCurrentDownLoads via a 50ms delay). Returns
   *  an ID usable with cancelDelay (`me.Cancel(id)`). */
  scheduleDelay?(obj: LObject, ms: number, handler: string, args: LVal[]): number;
  cancelDelay?(id: number): void;
}

/** Director sprite-event messages — unhandled ones are silent (not errors). */
const SPRITE_EVENT_NAMES = new Set([
  'mousedown', 'mouseup', 'mousemove', 'mouseenter', 'mouseleave', 'mousewithin', 'mouseupoutside',
  'keydown', 'keyup',
]);

/** Shared empty globals set for callHandler call sites that pass no extra
 *  globals (every engine tick / object dispatch). callHandler only reads it
 *  (spreads it when non-empty), never mutates it, so sharing is safe. */
export const NO_GLOBALS: ReadonlySet<string> = new Set();

/** Lowercased `property` names of a script, computed once per script (parsed
 *  once per cast load, never mutated). Shared by the interpreter's prop-owner
 *  walks and the engine's `the X of me` walk — a Set probe replaces the
 *  per-lookup `.some()` that lowercased every prop on every read. */
const scriptPropsLowerCache = new WeakMap<Script, Set<string>>();
export function scriptPropsLower(script: Script): Set<string> {
  let s = scriptPropsLowerCache.get(script);
  if (!s) {
    s = new Set(script.props.map((p) => p.toLowerCase()));
    scriptPropsLowerCache.set(script, s);
  }
  return s;
}

/** Line/paragraph separator (Director splits lines on CR; CRLF and bare LF
 *  tolerated for cross-platform text) — hoisted so both the split and the
 *  count-only paths reuse one regex instance. The /g flag is REQUIRED: the
 *  count-only path drives it with exec()+lastIndex, which a non-global
 *  regex ignores (it would re-match the first separator forever). String
 *  split() behaves identically with a global regex. */
const LINE_SEP_RE = /\r\n|\r|\n/g;

/** Count non-overlapping matches of a separator regex (line/paragraph chunk
 *  counts) without building the split array. */
function countRegexRuns(s: string, re: RegExp): number {
  let n = 0;
  re.lastIndex = 0;
  for (;;) {
    const m = re.exec(s);
    if (!m) break;
    n++;
    if (m.index === re.lastIndex) re.lastIndex++; // zero-length guard (not hit by LINE_SEP_RE)
  }
  re.lastIndex = 0;
  return n;
}

/** Count non-overlapping occurrences of a literal delimiter — JS split()
 *  semantics: the piece count is occurrences + 1 (a trailing delimiter still
 *  yields a trailing empty piece). */
function countSubstringRuns(s: string, sub: string): number {
  if (sub === '') return s.length + 1;
  let n = 0;
  let i = 0;
  for (;;) {
    const at = s.indexOf(sub, i);
    if (at < 0) break;
    n++;
    i = at + sub.length;
  }
  return n + 1;
}

export class Env {
  me: LObject | null = null;
  vars = new Map<string, LVal>();
  constructor(public parent: Env | null = null, public globals: Set<string> = new Set()) {}

  get(name: string): LVal | undefined {
    return this.getLower(name.toLowerCase());
  }

  /** get with an already-lowercased key (evalIdent computes it once). */
  getLower(key: string): LVal | undefined {
    if (this.vars.has(key)) return this.vars.get(key);
    if (this.parent) return this.parent.getLower(key);
    return undefined;
  }

  set(name: string, value: LVal): void {
    this.vars.set(name.toLowerCase(), value);
  }

  /** set with an already-lowercased key. */
  setLower(key: string, value: LVal): void {
    this.vars.set(key, value);
  }

  has(name: string): boolean {
    return this.hasLower(name.toLowerCase());
  }

  hasLower(key: string): boolean {
    if (this.vars.has(key)) return true;
    if (this.parent) return this.parent.hasLower(key);
    return false;
  }
}

const MAX_LOOP_ITERATIONS = 2_000_000;
export const MAX_CALL_DEPTH = 2500;

export class Interpreter {
  /** Script currently executing (for intra-file bare handler calls). */
  currentScript: Script | null = null;
  /** Env of the expression currently being evaluated (for host callbacks). */
  curEnv: Env | null = null;
  /** Call-argument stack for param() / the paramCount. */
  private argStack: LVal[][] = [];
  /** Expression-nesting depth (guards runaway AST recursion; diagnostic). */
  private evalDepth = 0;
  /** Current handler-call nesting (guard against runaway recursion). */
  private callDepth = 0;
  /** Current handler-call stack, exposed so the engine can tag its warnings. */
  callTrail: string[] = [];
  /** Undefined identifiers logged once per name — Director reads them as VOID,
   *  and we keep a trace so typos stay diagnosable without per-frame spam. */
  private warnedUndefined = new Set<string>();
  /** (script, handler) pairs already warned as missing — silence the rest. */
  private missingHandlerWarned = new Set<string>();

  /** Lowercased script-level `global` names, computed once per script (parsed
   *  once per cast load, never mutated) — callHandlerInner builds the per-call
   *  Env from this instead of lowercasing the array on every call. */
  private scriptGlobalsLower = new WeakMap<Script, Set<string>>();
  private globalsLowerOf(script: Script): Set<string> {
    let s = this.scriptGlobalsLower.get(script);
    if (!s) {
      s = new Set(script.globals.map((g) => g.toLowerCase()));
      this.scriptGlobalsLower.set(script, s);
    }
    return s;
  }

  /** See the module-level scriptPropsLower — the instance method keeps the
   *  call sites terse and shares the same per-script cache. */
  private propsLowerOf(script: Script): Set<string> {
    return scriptPropsLower(script);
  }

  constructor(public host: InterpreterHost) {}

  /** Args of the innermost running handler (for param()/the paramCount). */
  currentArgs(): LVal[] {
    return this.argStack.length > 0 ? this.argStack[this.argStack.length - 1] : [];
  }

  param(i: number): LVal {
    const args = this.currentArgs();
    return args[i - 1] ?? VOID;
  }

  // ------------------------------------------------------------ entry point

  callHandler(
    script: Script,
    handler: Handler,
    args: LVal[],
    instance: LObject | null,
    scriptGlobals: ReadonlySet<string>,
  ): LVal {
    if (++this.callDepth > 120) {
      this.callDepth--;
      const trail = this.callTrail.slice(-12).join(' <- ');
      this.host.warn(`call depth exceeded in #${handler.name} (script ${script.name}); trail: ${trail}`);
      return VOID;
    }
    // Handler-scoped floatness state: value marks are also wiped per statement
    // (execBody), so this covers single-expression evals and the boundary
    // between handlers — a handler's float() marks never leak into another.
    this.floatVals.clear();
    this.floatNames.clear();
    this.callTrail.push(`#${handler.name}@${script.name}`);
    // DIAG: normal window builds legitimately reach ~25-50 frames deep (the
    // merge -> buildVisual -> CreateElement chain), so only log near the hard
    // cap (120) where recursion is genuinely runaway.
    if (this.callDepth >= 100 && this.callDepth % 25 === 0) {
      this.host.warn(`DEPTH ${this.callDepth}: ${this.callTrail.slice(-8).join(' <- ')}`);
    }
    try {
      return this.callHandlerInner(script, handler, args, instance, scriptGlobals);
    } finally {
      this.callDepth--;
      this.callTrail.pop();
    }
  }

  private callHandlerInner(
    script: Script,
    handler: Handler,
    args: LVal[],
    instance: LObject | null,
    scriptGlobals: ReadonlySet<string>,
  ): LVal {
    // currentScript must reflect the innermost executing handler; restore the
    // caller's script on exit so stale references never leak across calls.
    const prevScript = this.currentScript;
    this.currentScript = script;
    // SOUND DIAG: confirm the machine state arrives and playback is attempted
    // (verifies the sound-machine song fix in the browser).
    if (handler.name.toLowerCase() === 'soundmachinesetstate') {
      const d = args[0];
      const id = d && typeof d === 'object' && (d as LPropListClass).props ? (d as LPropListClass).props.get('id') : undefined;
      const on = d && typeof d === 'object' && (d as LPropListClass).props ? (d as LPropListClass).props.get('furniOn') : undefined;
      const obj = instance as LObject | null;
      const playing = obj ? obj.props.get('pSongPlaying') : undefined;
      const ready = obj ? obj.props.get('pTimeLineReady') : undefined;
      this.host.log(`DBG song: soundMachineSetState id=${String(id)} on=${String(on)} pSongPlaying=${String(playing)} pTimeLineReady=${String(ready)}`);
    }
    if (handler.name.toLowerCase() === 'playsong') {
      const obj = instance as LObject | null;
      const len = obj ? obj.props.get('pSongLength') : undefined;
      const playing = obj ? obj.props.get('pSongPlaying') : undefined;
      const furniOn = obj ? obj.props.get('pSoundMachineFurniOn') : undefined;
      this.host.log(`DBG song: playSong pSongLength=${String(len)} pSongPlaying=${String(playing)} furniOn=${String(furniOn)}`);
    }

    // Globals set: precomputed lowercase script globals, extended only when
    // the caller passed extras (engine ticks pass an empty set). globalDecl
    // statements copy-on-write, so the cached base set stays immutable.
    const baseGlobals = this.globalsLowerOf(script);
    const env = new Env(null, scriptGlobals && scriptGlobals.size > 0 ? new Set([...baseGlobals, ...scriptGlobals]) : baseGlobals);
    env.me = instance;
    // `on bump me, x` — when called as obj.bump(4) / call(#bump, obj, 4), the
    // `me` param is bound to the instance and args fill the remaining params.
    let offset = 0;
    if (instance && handler.params.length > 0 && handler.params[0].toLowerCase() === 'me') {
      env.vars.set('me', instance);
      offset = 1;
    }
    for (let i = offset; i < handler.params.length; i++) {
      env.setLower(handler.params[i].toLowerCase(), args[i - offset] ?? VOID);
    }
    if (instance && offset === 0) env.setLower('me', instance);
    // Bare self-calls like `searchTask(me, ...)` inside a parent script dispatch
    // through resolveGlobalHandler with instance=null, so `me` arrives as a
    // regular param. Promote it to env.me so property reads (`pX` bare) and the
    // `me` keyword resolve against the instance, not VOID.
    if (!env.me && handler.params[0]?.toLowerCase() === 'me') {
      const m = env.vars.get('me');
      if (m instanceof LObjectClass) env.me = m;
    }
    this.argStack.push(args);
    try {
      this.execBody(handler.body, env);
    } catch (e) {
      if (e instanceof ReturnSignal) return e.value;
      if (e instanceof ExitSignal) return VOID;
      throw e;
    } finally {
      this.argStack.pop();
      this.currentScript = prevScript;
    }
    return VOID;
  }

  /** Create an object instance from a script. */
  makeInstance(script: Script, id = ''): LObject {
    const handlers = new Map<string, Handler>();
    for (const h of script.handlers) handlers.set(h.name.toLowerCase(), h);
    return new LObjectClass(script.name, script, handlers, new Map(), id);
  }

  /** new(script "X", ...): create the instance and run its `new` handler if
   *  it has one. `construct` is NOT auto-run — Habbo always calls it
   *  explicitly (gCore = script(tClass).new(); gCore.construct()), and
   *  auto-running it before the assignment stores the instance would let a
   *  re-entrant construct see the global still unset and recurse forever. */
  newInstance(script: Script, args: LVal[]): LObject {
    const obj = this.makeInstance(script);
    const hNew = obj.handlers.get('new');
    if (hNew) this.callHandler(script, hNew, args, obj, NO_GLOBALS);
    return obj;
  }

  /** call(#handler, targetOrList, ...) — maps over object lists (Habbo convention). */
  callBuiltin(args: LVal[]): LVal {
    const handlerName = this.handlerNameOf(args[0]);
    if (handlerName === undefined) {
      // Director/LibreShockwave: call() with a VOID handler name is a silent
      // no-op — Object Base Class executeDelay fires `call(tTask[#method],
      // ...)` where tTask is VOID when a timeout outlived its owner (the
      // corpus's deconstruct forget() passes the task LIST instead of the
      // delay key, so the real timeout survives and fires stale). Keep the
      // warn for genuinely invalid non-VOID args.
      if (args[0] === null || args[0] === undefined) return VOID;
      this.host.warn(`call(): invalid handler ${toLingoString(args[0])}`);
      return VOID;
    }
    const target = args[1] ?? VOID;
    const rest = args.slice(2);
    // FUSE convention: `call(#handler, proplist, ...)` maps over the proplist's
    // *values* (name -> instance maps like pTaskList), like the list form.
    const targets: LVal[] =
      target instanceof LListClass ? target.items :
      target instanceof LPropListClass ? [...target.props.values()] :
      [target];
    let last: LVal = VOID;
    for (const t of targets) {
      if (t instanceof LObjectClass) last = this.callObjectHandler(t, handlerName, rest);
      else if (t instanceof LSpriteRefClass) {
        // Director: call(#handler, sprite n, ...) dispatches to the sprite's
        // behavior scripts (scriptInstanceList). The Room Interface registers
        // the floor click chain with `call(#registerProcedure, tSprList, ...)`
        // where the visualizer's sprite list holds SPRITE REFS — without this
        // branch every room sprite warned "target is not an object" and the
        // Event Broker pProcList stayed empty, so floor clicks did nothing
        // (no walking). spriteMethod itself dispatches to the channel's
        // behavior instances first, then applies the FUSE sprite API.
        last = this.host.spriteMethod(t, handlerName, rest);
      } else if (t instanceof LListClass || t instanceof LPropListClass) last = this.callBuiltin([args[0], t, ...rest]);
      else if (t !== null) {
        this.host.warn(`call(#${handlerName}, ${toLingoString(t)}): target is not an object`);
        last = VOID;
      }
    }
    return last;
  }

  /** Find an object or ancestor's handler (Lingo #ancestor inheritance). */
  private findHandler(obj: LObject, name: string): { script: Script; handler: Handler } | null {
    const lower = name.toLowerCase();
    let cur: LObject | null = obj;
    let hops = 0;
    while (cur && cur.script) {
      const h = cur.handlers.get(lower);
      if (h) return { script: cur.script, handler: h };
      if (++hops > 32) return null;
      const anc = cur.props.get('ancestor');
      cur = anc instanceof LObjectClass ? anc : null;
    }
    return null;
  }

  /** The object in the ancestor chain declaring `name` as a property, if any. */
  private instancePropOwnerLower(env: Env, _name: string, lower: string): LObject | null {
    let me: LObject | null = env.me;
    let hops = 0;
    while (me && me.script) {
      if (this.propsLowerOf(me.script).has(lower)) return me;
      if (++hops > 32) return null;
      const anc = me.props.get('ancestor');
      me = anc instanceof LObjectClass ? anc : null;
    }
    return null;
  }

  private handlerNameOf(v: LVal): string | undefined {
    if (v instanceof LSymbol) return v.name;
    if (typeof v === 'string') return v;
    return undefined;
  }

  callObjectHandler(obj: LObject, name: string, args: LVal[]): LVal {
    // Method dispatch walks the ancestor chain (Lingo #ancestor inheritance).
    const found = this.findHandler(obj, name);
    if (found) {
      return this.callHandler(found.script, found.handler, args, obj, NO_GLOBALS);
    }
    const lower = name.toLowerCase();
    // getProperty/setProperty are the Window API spellings of getaProp/setaProp
    // (elements: `getElement("drag").getProperty(#buffer).image`).
    if (lower === 'get' || lower === 'getaprop' || lower === 'getproperty') {
      return obj.props.get(keyOf(args[0]) ?? '') ?? VOID;
    }
    if (lower === 'set' || lower === 'setaprop' || lower === 'setproperty') {
      const key = keyOf(args[0]);
      if (key !== undefined) {
        const value = args[1] ?? VOID;
        if (key === 'ancestor' && (value === null || value === undefined)) {
          // Same as index-assign: never clear an existing ancestor with VOID.
          if (!(obj.props.get('ancestor') instanceof LObjectClass)) obj.props.set(key, value);
        } else obj.props.set(key, value);
      }
      return VOID;
    }
    if (lower === 'getid') return obj.id;
    if (lower === 'handler') {
      return this.findHandler(obj, keyOf(args[0]) ?? '') ? 1 : 0;
    }
    // Director: sprite EVENT messages with no handler are silently ignored
    // (the Event Broker redirects every mouse/key event to window elements —
    // e.g. a Field Wrapper with no #keyDown — and real Lingo doesn't error).
    if (SPRITE_EVENT_NAMES.has(lower)) return VOID;
    if (obj.lenient) return VOID;
    // Director silently no-ops a missing object handler. Object Manager
    // prepareFrame calls #update on every bare Active Object each frame — warn
    // once per (script, handler) so a real gap stays traceable without spam.
    const warnKey = `${obj.scriptName ?? '?'}:${lower}`;
    if (this.missingHandlerWarned.has(warnKey)) return VOID;
    this.missingHandlerWarned.add(warnKey);
    this.host.warn(`object(${obj.scriptName}) has no handler #${name}`);
    return VOID;
  }

  // ------------------------------------------------------------ statements

  execBody(stmts: Stmt[], env: Env): void {
    for (const stmt of stmts) {
      // Statement-scoped VALUE marks: float()/decimal-literal marks live only
      // for the current statement, so the Variable Container's transient
      // `float(tValue)` marks (GetValue parses every boot variable) can never
      // leak into a division in a later statement or handler (session 54 boot
      // break: leaked marks float-divided the wire encoders' int math and the
      // broker-manager error-reporting recursion followed). Stored floats
      // survive via floatNames (handler-scoped) instead.
      this.floatVals.clear();
      this.execStmt(stmt, env);
    }
  }

  execStmt(stmt: Stmt, env: Env): void {
    switch (stmt.kind) {
      case 'assign': {
        const v = this.evalExpr(stmt.value, env);
        this.noteFloatAssign(stmt.target, stmt.value);
        this.execAssign(stmt.target, v, env);
        return;
      }
      case 'put':
        if (stmt.into) {
          if (stmt.mode === 'after' || stmt.mode === 'before') {
            // Director: `put x after y` appends, `put x before y` prepends.
            const cur = this.evalExpr(stmt.into, env);
            const val = this.evalExpr(stmt.value, env);
            if (stmt.mode === 'after' && cur instanceof LListClass) {
              // List target: `put x after tList` appends an ITEM (not a string).
              const list = new LListClass([...cur.items, val]);
              this.execAssign(stmt.into, list, env);
              return;
            }
            if (stmt.mode === 'before' && cur instanceof LListClass) {
              const list = new LListClass([val, ...cur.items]);
              this.execAssign(stmt.into, list, env);
              return;
            }
            const newVal = stmt.mode === 'after'
              ? lingoConcat(cur) + lingoConcat(val)
              : lingoConcat(val) + lingoConcat(cur);
            this.execAssign(stmt.into, newVal, env);
          } else {
            this.execAssign(stmt.into, this.evalExpr(stmt.value, env), env);
          }
        } else {
          const out = toLingoString(this.evalExpr(stmt.value, env));
          // FUSE's Error Manager prints every raised error via `put "Error:" & ...`.
          // "Writer already exists: X" is a known-benign corpus quirk (U84): the
          // Spectator System (room thread) and the Dialog Thread both create the
          // same-named "dialog_writer_bold" writer, and the Writer Manager's own
          // guard raises on the second create. The real client logs it in its
          // debugger; keep it out of the game log.
          if (!(out.startsWith('Error:') && out.includes('Writer already exists'))) this.host.log(out);
        }
        return;
      case 'delete': {
        // Director `delete <chunkExpr>`: removes the chunk range from the
        // string variable. Implemented as compute-and-reassign (strings are
        // immutable), same pattern as `put x after y`. This terminates FUSE's
        // replaceChunks `repeat while tString contains tChunkA` loop.
        const target = stmt.target;
        if (target.kind === 'chunk') {
          const base = this.evalExpr(target.obj, env);
          if (typeof base === 'string') {
            const parts = this.chunkParts(base, target.chunk);
            if (parts !== null) {
              const n = parts.length;
              const rawFrom = target.from !== undefined ? Math.round(asNum(this.evalExpr(target.from, env))) : 1;
              const rawTo = target.to !== undefined ? Math.round(asNum(this.evalExpr(target.to, env))) : rawFrom;
              // Director: negative indexes count from the end (`char -1` = the
              // last char); an index resolving before char 1 is out of range
              // and delete no-ops (no clamp — the old clamp to char 1 ate the
              // first letter of the first room name). EXCEPTION: the compiler
              // encodes "the last element" as a chunk index of -30000
              // (`delete the last char of t` -> `delete char -30000 of t`),
              // which the corpus ships as -30003 in the navigator — that
              // deletes the LAST chunk (strips the trailing RETURN the build
              // loops leave, so the breadcrumb tabs don't render N+1 rows).
              if (rawFrom <= -30000) {
                // delete the last chunk only
                const sep = target.chunk === 'char' ? '' : target.chunk === 'word' ? ' ' : target.chunk === 'line' || target.chunk === 'paragraph' ? '\r' : this.host.itemDelimiter();
                this.execAssign(target.obj, parts.slice(0, n - 1).join(sep), env);
                return;
              }
              let from = rawFrom < 0 ? n + rawFrom + 1 : rawFrom;
              let to = rawTo < 0 ? n + rawTo + 1 : rawTo;
              if (from < 1 || to < 1) return;
              from = Math.min(n, from);
              to = Math.min(n, to);
              if (from <= to) {
                const kept = parts.slice(0, from - 1).concat(parts.slice(to));
                const sep = target.chunk === 'char' ? '' : target.chunk === 'word' ? ' ' : target.chunk === 'line' || target.chunk === 'paragraph' ? '\r' : this.host.itemDelimiter();
                this.execAssign(target.obj, kept.join(sep), env);
              }
            }
          } else {
            // Director silently ignores chunk deletion on non-strings (FUSE
            // Navigator deletes chars off an unset tNodeInfo — the identifier
            // already reads as VOID, so this is a plain no-op).
          }
        } else {
          this.host.warn(`delete unsupported on ${target.kind} target`);
        }
        return;
      }
      case 'if': {
        const branch = isTruthy(this.evalExpr(stmt.cond, env)) ? stmt.then : stmt.els;
        this.execBody(branch, env);
        return;
      }
      case 'case': {
        const subject = this.evalExpr(stmt.subject, env);
        // Lingo `case` branches are EXCLUSIVE: the matched branch's statements
        // run, then execution continues after `end case` (the decompiled .ls
        // drops the end-of-branch jumps/`exit`s the original bytecode emits —
        // FUSE's flatAccessResult has an EMPTY success branch followed by the
        // error-UI branch, and Entry Interface activateIcon has non-returning
        // branches, both of which would misbehave under C-style fallthrough).
        // A branch ending without an explicit exit means the trailing code
        // after `end case` runs (e.g. Navigator updateState's benign
        // "Unknown state:" error after its no-return openNavigator branch).
        for (const branch of stmt.branches) {
          const hit = branch.match === undefined ||
            branch.match.some((m) => lingoEquals(subject, this.evalExpr(m, env)));
          if (hit) {
            this.execBody(branch.body, env);
            return;
          }
        }
        return;
      }
      case 'repeatWith': {
        const from = Math.round(asNum(this.evalExpr(stmt.from, env)));
        const to = Math.round(asNum(this.evalExpr(stmt.to, env)));
        const step = stmt.down ? -1 : 1;
        const key = stmt.varName.toLowerCase();
        // Director semantics: the loop variable is a REAL variable — if the
        // body reassigns it (deobfuscate does `i = i + 1` to step by pairs),
        // the change sticks and the loop condition reads it back.
        env.vars.set(key, from);
        let iter = 0;
        while (true) {
          const i = asNum(env.vars.get(key) ?? 0);
          if (stmt.down ? i < to : i > to) break;
          if (++iter > MAX_LOOP_ITERATIONS) {
            this.host.warn('repeat loop guard hit');
            break;
          }
          try {
            this.execBody(stmt.body, env);
          } catch (e) {
            if (e instanceof ExitRepeatSignal) break;
            if (e instanceof NextRepeatSignal) {
              env.vars.set(key, asNum(env.vars.get(key) ?? 0) + step);
              continue;
            }
            throw e;
          }
          env.vars.set(key, asNum(env.vars.get(key) ?? 0) + step);
        }
        return;
      }
      case 'repeatIn': {
        const list = this.evalExpr(stmt.list, env);
        // Director: `repeat with x in proplist` iterates the proplist's VALUES
        // in insertion order (Window Instance buildVisual relies on this to
        // create members/sprites from the Layout Parser's element defs).
        const items =
          list instanceof LListClass ? list.items :
          list instanceof LPropListClass ? [...list.props.values()] :
          [];
        let iter = 0;
        for (const item of items) {
          if (++iter > MAX_LOOP_ITERATIONS) break;
          env.vars.set(stmt.varName.toLowerCase(), item);
          try {
            this.execBody(stmt.body, env);
          } catch (e) {
            if (e instanceof ExitRepeatSignal) break;
            if (e instanceof NextRepeatSignal) continue;
            throw e;
          }
        }
        return;
      }
      case 'repeatWhile': {
        let iter = 0;
        while (isTruthy(this.evalExpr(stmt.cond, env))) {
          if (++iter > MAX_LOOP_ITERATIONS) {
            this.host.warn('repeat loop guard hit');
            break;
          }
          try {
            this.execBody(stmt.body, env);
          } catch (e) {
            if (e instanceof ExitRepeatSignal) break;
            if (e instanceof NextRepeatSignal) continue;
            throw e;
          }
        }
        return;
      }
      case 'exit':
        throw new ExitSignal();
      case 'exitRepeat':
        throw new ExitRepeatSignal();
      case 'nextRepeat':
        throw new NextRepeatSignal();
      case 'return':
        // Multi-value return (`return RETURN, error(me, ...)` — sparkd's
        // rendering of the R31 compiler's return-with-error-call bytecode):
        // evaluate every expression in order (side effects fire, the error()
        // warns) and return the LAST value — identical to the sibling
        // `return error(...)` form in the same scripts (U135).
        if (stmt.values && stmt.values.length > 1) {
          let last: LVal = VOID;
          for (const v of stmt.values) last = this.evalExpr(v, env);
          throw new ReturnSignal(last);
        }
        throw new ReturnSignal(stmt.value ? this.evalExpr(stmt.value, env) : VOID);
      case 'expr':
        this.evalExpr(stmt.expr, env);
        return;
      case 'globalDecl':
        for (const name of stmt.names) {
          const lower = name.toLowerCase();
          // Copy-on-write: env.globals is usually the script's shared cached
          // set (callHandlerInner) — a runtime `global` decl must not leak
          // into other calls, so detach before adding.
          if (!env.globals.has(lower)) {
            const s = new Set(env.globals);
            s.add(lower);
            env.globals = s;
          }
          if (this.host.globalGet(name) === undefined) this.host.globalSet(name, VOID);
        }
        return;
    }
  }

  /** Whole-number values that are FLOAT-typed (float(x), decimal literals
   *  like 14.0, results of float arithmetic). JS numbers can't distinguish 14
   *  from 14.0, so `/` consults this set: float operands divide as floats,
   *  int/int truncates (the corpus's @-encoded wire encoders depend on it). */
  private floatVals = new Set<number>();

  /** Per-handler names whose current value is float-typed (assigned from a
   *  float()/decimal-literal expression). Survives statements so a stored
   *  float can be divided later in the SAME handler, but is cleared at
   *  handler entry so one handler's marks never leak into another's int math. */
  private floatNames = new Map<string, boolean>();

  /** Instance properties that currently hold a FLOAT-typed value. Director
   *  datums keep their type when stored in object properties, so a LATER
   *  handler's arithmetic on the prop float-divides (Room Geometry
   *  getWorldCoordinate relied on this or the hiliter snapped to the wrong
   *  tile). Cleared when the property is reassigned; GC'd with the object. */
  private objectFloatProps = new WeakMap<LObject, Set<string>>();

  /** Record whether an object property currently holds a float-typed value
   *  (see objectFloatProps). Called at assignment time while the RHS value
   *  mark is still live (floatVals is only cleared at the next statement). */
  private notePropFloat(obj: LObject, name: string, isFloat: boolean): void {
    const lower = name.toLowerCase();
    let set = this.objectFloatProps.get(obj);
    if (isFloat) {
      if (!set) {
        set = new Set();
        this.objectFloatProps.set(obj, set);
      }
      set.add(lower);
    } else if (set) {
      set.delete(lower);
    }
  }

  /** Mark a whole number as float-typed; non-numbers pass through. */
  markFloatValue(v: LVal): LVal {
    if (typeof v === 'number' && Number.isInteger(v)) this.floatVals.add(v);
    return v;
  }

  /** Director floatp(): true for non-integers and marked whole floats. */
  isFloatValue(v: LVal): boolean {
    return typeof v === 'number' && (!Number.isInteger(v) || this.floatVals.has(v));
  }

  /** Record float-typedness of an assigned name from its RHS expression. */
  private noteFloatAssign(target: Expr, rhs: Expr): void {
    const name = target.kind === 'ident' || target.kind === 'prop' ? target.name.toLowerCase() : null;
    if (name) this.floatNames.set(name, this.isFloatExpr(rhs));
  }

  /** Static float-typedness of an expression: decimal literals, float()
   *  calls, and arithmetic on them. Identifiers/properties resolve via
   *  floatNames (recorded at assignment, cleared at handler entry). */
  private isFloatExpr(e: Expr): boolean {
    switch (e.kind) {
      case 'num':
        return !!e.float;
      case 'call':
        return e.callee.kind === 'ident' && e.callee.name.toLowerCase() === 'float';
      case 'binary':
        return this.isFloatExpr(e.left) || this.isFloatExpr(e.right);
      case 'unary':
        return e.op === '-' || e.op === '+' ? this.isFloatExpr(e.arg) : false;
      default:
        return false;
    }
  }

  private exprIsFloatName(e: Expr): boolean {
    if (e.kind === 'ident' || e.kind === 'prop') {
      return this.floatNames.get(e.name.toLowerCase()) ?? false;
    }
    return false;
  }

  /** Float-typed arithmetic: a float()/decimal-literal VALUE mark, a
   *  non-integer value, or a name assigned a float-typed expression in this
   *  handler (floatNames). Used by + - * / so a stored float propagates
   *  through any arithmetic (tM = float(250); tM * 2 / 3 divides as float). */
  private isFloatArith(l: LVal, r: LVal, leftE: Expr, rightE: Expr): boolean {
    return (
      this.isFloatValue(l) ||
      this.isFloatValue(r) ||
      this.exprIsFloatName(leftE) ||
      this.exprIsFloatName(rightE)
    );
  }

  /** integer(x)/trunc(x): an INT result, never float-typed — unmark the value
   *  so a later `x / 64` in the wire encoders can't float-divide on a stale
   *  mark from an unrelated float() call. */
  clearFloatMark(v: LVal): LVal {
    if (typeof v === 'number') this.floatVals.delete(v);
    return v;
  }

  private execAssign(target: Expr, value: LVal, env: Env): void {
    switch (target.kind) {
      case 'ident': {
        const name = target.name;
        const lower = name.toLowerCase();
        if (lower === 'me') {
          this.host.warn('cannot assign to me');
          return;
        }
        if (env.globals.has(lower)) this.host.globalSet(name, value);
        else {
          // Declared instance property (this object or an ancestor): the
          // assignment sticks to the object that declares it.
          const owner = this.instancePropOwnerLower(env, name, lower);
          if (owner) {
            owner.props.set(name, value);
            // Director: a float assigned to a property stays a Float datum
            // across handlers (pXOffset = getLocalFloat(...) float-divides in
            // getWorldCoordinate later). Record it so reads re-mark the value.
            this.notePropFloat(owner, name, this.isFloatValue(value));
          } else {
            env.set(name, value);
          }
        }
        return;
      }
      case 'prop': {
        // `tmember.char[1..n].font = v` — a property applied to a character
        // range of a text member (Balloon Manager createballoonImg bolds the
        // speaker name). Director applies the prop to the chunk: resolve the
        // base member and route the range + prop to the member chunk-prop
        // setter. Without this the chunk evaluated to a plain string and the
        // set warned "cannot set font on Jem:".
        if (target.obj.kind === 'chunk') {
          const base = this.evalExpr(target.obj.obj, env);
          if (base instanceof LMemberRefClass) {
            const from = target.obj.from ? Math.round(asNum(this.evalExpr(target.obj.from, env))) : undefined;
            const to = target.obj.to ? Math.round(asNum(this.evalExpr(target.obj.to, env))) : from;
            this.host.setMemberChunkProp(base, target.obj.chunk, from, to, target.name, value);
            return;
          }
        }
        const obj = this.evalExpr(target.obj, env);
        this.setPropValue(obj, target.name, value);
        if (obj instanceof LObjectClass) this.notePropFloat(obj, target.name, this.isFloatValue(value));
        return;
      }
      case 'index': {
        const obj = this.evalExpr(target.obj, env);
        const idx = this.evalExpr(target.index, env);
        this.setIndexValue(obj, idx, value);
        return;
      }
      case 'chunk': {
        // Lingo chunk assignment on a string: compute the new string and
        // write it back to the target expression (strings are immutable, so
        // this is compute-and-reassign — the same pattern as `put x after y`
        // and `delete char ... of t`). Visualizer Instance Class buildVisual
        // does `put "x" into (tLayoutName).char[7]` for the private-room
        // model_x.room check (U134).
        const obj = this.evalExpr(target.obj, env);
        const from = target.from ? Math.round(asNum(this.evalExpr(target.from, env))) : undefined;
        const to = target.to ? Math.round(asNum(this.evalExpr(target.to, env))) : from;
        const newVal = this.setChunkValue(obj, target.chunk, from, to, value);
        if (newVal !== null) this.execAssign(target.obj, newVal, env);
        return;
      }
      case 'the':
        this.host.setThe(target.head, target.chain, value);
        return;
      default:
        this.host.warn(`unsupported assignment target: ${target.kind}`);
    }
  }

  // ------------------------------------------------------------ expressions

  evalExpr(expr: Expr, env: Env): LVal {
    if (++this.evalDepth > 400) {
      this.evalDepth = 0;
      const kind = expr.kind;
      const trail = this.callTrail.slice(-10).join(' <- ');
      const src = JSON.stringify(expr).slice(0, 160);
      throw new Error(`EVALOVERFLOW kind=${kind} trail=[${trail}] expr=${src}`);
    }
    try {
      return this.evalExprInner(expr, env);
    } finally {
      this.evalDepth--;
    }
  }

  private evalExprInner(expr: Expr, env: Env): LVal {
    this.curEnv = env;
    switch (expr.kind) {
      case 'num':
        // Decimal/exponent literals are float-typed and mark their value; a
        // plain integer literal UNMARKS it (JS values are shared by number,
        // so without the unmark a later `250 / 500` would inherit floatness
        // from an earlier float(250)).
        if (expr.float) this.markFloatValue(expr.value);
        else this.floatVals.delete(expr.value);
        return expr.value;
      case 'str':
        return expr.value;
      case 'symbol':
        return new LSymbol(expr.name);
      case 'ident':
        return this.evalIdent(expr.name, env);
      case 'list':
        return new LListClass(expr.items.map((i) => this.evalExpr(i, env)));
      case 'proplist': {
        // Real Lingo appends each pair IN ORDER and keeps duplicate keys — the
        // FUSE wire encoder builds [#integer: mask, #integer: nodeId, ...]
        // param lists and walks them positionally (a Map backing would
        // collapse the duplicates and kepler would drop the frames).
        const props = new PropPairsClass();
        for (const [k, v] of expr.pairs) {
          // Lingo: a bare identifier key in `[a: 1, b: 2]` is a *literal*
          // string key — evaluating it as a variable would turn every
          // undeclared key into VOID and collapse the whole proplist.
          const key =
            k.kind === 'ident' || k.kind === 'symbol'
              ? k.name
              : keyOf(this.evalExpr(k, env)) ?? toLingoString(this.evalExpr(k, env));
          props.append(key, this.evalExpr(v, env));
        }
        return new LPropListClass(props);
      }
      case 'unary': {
        const v = this.evalExpr(expr.arg, env);
        if (expr.op === 'not') return isTruthy(v) ? 0 : 1;
        if (expr.op === '-') {
          // DirPlayer inv parity: points/rects/lists negate element-wise
          // (Bodypart Class EX getLocation: `-tRegPoint + tCntrPoint`).
          const neg = lingoNegate(v);
          return neg !== null ? neg : -asNum(v);
        }
        return asNum(v);
      }
      case 'binary':
        return this.evalBinary(expr.op, expr.left, expr.right, env);
      case 'call':
        return this.evalCall(expr, env);
      case 'prop':
        return this.getPropValue(this.evalExpr(expr.obj, env), expr.name);
      case 'index': {
        const obj = this.evalExpr(expr.obj, env);
        const idx = this.evalExpr(expr.index, env);
        return this.getIndexValue(obj, idx);
      }
      case 'chunk': {
        const obj = this.evalExpr(expr.obj, env);
        const from = expr.from ? Math.round(asNum(this.evalExpr(expr.from, env))) : undefined;
        const to = expr.to ? Math.round(asNum(this.evalExpr(expr.to, env))) : from;
        return this.getChunkValue(obj, expr.chunk, from, to);
      }
      case 'chunkCount': {
        const obj = this.evalExpr(expr.obj, env);
        return this.chunkCount(obj, expr.chunk);
      }
      case 'the':
        return this.host.getThe(expr.head, expr.chain);
      case 'empty':
        return LEMPTY;
    }
  }

  private evalIdent(name: string, env: Env): LVal {
    const lower = name.toLowerCase();
    if (lower === 'me') return env.me ?? VOID;
    if (lower === 'empty') return LEMPTY;
    if (lower === 'void') return VOID;
    if (lower === 'true') return 1;
    if (lower === 'false') return 0;
    if (lower === 'pi') return Math.PI;
    // Director character constants: RETURN = chr(13) CR, ENTER = chr(3),
    // TAB = chr(9), QUOTE = chr(34), SPACE = chr(32). RETURN must be CR —
    // the corpus joins multi-line text (navigator room names) with it, and
    // canvas fillText doesn't break on CR.
    if (lower === 'return') return '\r';
    if (lower === 'tab') return '\t';
    if (lower === 'enter') return '\x03';
    if (lower === 'space') return ' ';
    if (lower === 'quote') return '"';
    const local = env.getLower(lower);
    if (local !== undefined) return local;
    const global = this.host.globalGetLower ? this.host.globalGetLower(lower, name) : this.host.globalGet(name);
    if (global !== undefined) return global;
    // Instance property: `property pX` at the top of a parent script makes pX
    // readable by bare name inside its handlers (resolved against me.props).
    const prop = this.instancePropOfLower(env, name, lower);
    if (prop !== undefined) return prop;
    // Lingo: a declared-but-unset global (or any unset variable) reads as VOID.
    if (env.globals.has(lower)) return VOID;
    // Director: an undeclared identifier reads as VOID. The authoring-time
    // "variable not defined" dialog is non-fatal and the corpus relies on
    // flow continuing (FUSE Navigator's tNodeInfo is unset on some paths and
    // `delete char ... of tNodeInfo` must no-op). Log once per name so typos
    // stay diagnosable without the per-frame warn.
    if (!this.warnedUndefined.has(lower)) {
      this.warnedUndefined.add(lower);
      this.host?.log?.(`note: undeclared identifier read as VOID (once): ${name}`);
    }
    return VOID;
  }

  /**
   * A declared property on the current instance or its ancestor chain
   * (Lingo `#ancestor` inheritance), if any (case-insensitive).
   */
  private instancePropOf(env: Env, name: string): LVal | undefined {
    return this.instancePropOfLower(env, name, name.toLowerCase());
  }

  private instancePropOfLower(env: Env, name: string, lower: string): LVal | undefined {
    let me: LObject | null = env.me;
    let hops = 0;
    while (me && me.script) {
      if (this.propsLowerOf(me.script).has(lower)) {
        const v =
          me.props.has(name) ? me.props.get(name) : me.props.has(lower) ? me.props.get(lower) : undefined;
        if (v === undefined) return VOID; // declared but never assigned → VOID, no warning
        // Float-typed property (assigned from float()/a float literal): the
        // read re-marks the value so a later division in THIS statement
        // float-divides — Director keeps the property as a Float datum.
        if (this.objectFloatProps.get(me)?.has(lower)) return this.markFloatValue(v);
        return v;
      }
      if (++hops > 32) return undefined;
      const anc = me.props.get('ancestor');
      me = anc instanceof LObjectClass ? anc : null;
    }
    return undefined;
  }

  private evalBinary(op: string, leftE: Expr, rightE: Expr, env: Env): LVal {
    const l = this.evalExpr(leftE, env);
    const r = this.evalExpr(rightE, env);
    switch (op) {
      case '=':
        return lingoEquals(l, r) ? 1 : 0;
      case '<>':
        return lingoEquals(l, r) ? 0 : 1;
      case 'is':
        return lingoEquals(l, r) ? 1 : 0;
      case '<':
        return this.compareLingo(l, r) < 0 ? 1 : 0;
      case '>':
        return this.compareLingo(l, r) > 0 ? 1 : 0;
      case '<=':
        return this.compareLingo(l, r) <= 0 ? 1 : 0;
      case '>=':
        return this.compareLingo(l, r) >= 0 ? 1 : 0;
      case 'contains':
        return typeof l === 'string' && typeof r === 'string' && l.includes(r) ? 1 : 0;
      case 'starts':
        return typeof l === 'string' && typeof r === 'string' && l.startsWith(r) ? 1 : 0;
      case '&':
        return lingoConcat(l) + lingoConcat(r);
      case '&&':
        return lingoConcat(l) + ' ' + lingoConcat(r);
      case '+': {
        const out = lingoAdd(l, r) ?? asNum(l) + asNum(r);
        return this.isFloatArith(l, r, leftE, rightE) ? this.markFloatValue(out) : out;
      }
      case '-': {
        const out = lingoSubtract(l, r) ?? asNum(l) - asNum(r);
        return this.isFloatArith(l, r, leftE, rightE) ? this.markFloatValue(out) : out;
      }
      case '*':
        // DirPlayer multiply_datums parity: list/point/rect * scalar (and
        // scalar * list) is ELEMENT-WISE — Human Class 0002:540 lerps the
        // walk with `(pDestLScreen - pStartLScreen) * tFactor`; without it
        // the product was asNum(list)=0 and the avatar teleported per status
        // message instead of gliding between tiles. Floatness propagates
        // (Swimmer Class `pMoveTime * 1.0` must stay float).
        const mulOut = lingoMultiply(l, r) ?? asNum(l) * asNum(r);
        return this.isFloatArith(l, r, leftE, rightE) ? this.markFloatValue(mulOut) : mulOut;
      case '/': {
        // Lingo: integer / integer truncates (14 / 4 = 3); a float operand
        // forces float division (14.0 / 4 = 3.5). The @-encoded wire encoders
        // depend on the truncation; the Human Class walk lerp needs the float
        // (float(the milliSeconds - pMoveStart) / pMoveTime). VOID coerces to
        // 0 and a zero divisor to 1 (DirPlayer/ScummVM parity) — JS `/` would
        // yield Infinity/NaN and poison downstream math.
        const floatDiv = this.isFloatArith(l, r, leftE, rightE);
        if (l === VOID || r === VOID) return 0;
        const a = asNum(l);
        const b = asNum(r);
        const divisor = b === 0 ? 1 : b;
        const out = floatDiv ? a / divisor : Math.trunc(a / divisor);
        return floatDiv ? this.markFloatValue(out) : out;
      }
      case 'mod':
      case 'div': {
        // DirPlayer/ScummVM parity: VOID coerces to 0, a zero divisor yields
        // 0 for mod and x/1 = x for div; list operands mod element-wise (a
        // 0 anim counter must read 0, not NaN — NaN poisoned the pet part's
        // whole update chain).
        if (op === 'mod') {
          const modOut = lingoMod(l, r);
          if (modOut !== null) return modOut;
          if (l === VOID || r === VOID) return 0;
          const b = asNum(r);
          const out = b === 0 ? 0 : asNum(l) % b;
          return this.isFloatArith(l, r, leftE, rightE) ? this.markFloatValue(out) : out;
        }
        const a = asNum(l);
        if (l === VOID || r === VOID) return 0;
        const b = asNum(r);
        const divisor = b === 0 ? 1 : b;
        return Math.trunc(a / divisor);
      }
      case 'and':
        return isTruthy(l) && isTruthy(r) ? 1 : 0;
      case 'or':
        return isTruthy(l) || isTruthy(r) ? 1 : 0;
      default:
        this.host.warn(`unknown operator ${op}`);
        return VOID;
    }
  }

  /** Lingo relational comparison: numbers and numeric strings compare
   *  numerically; a mixed string/number comparison coerces the number to a
   *  string and compares lexicographically (the classic Lingo rule that
   *  `"abc" > 0` is TRUE — Manager Template's exists() depends on it). */
  private compareLingo(a: LVal, b: LVal): number {
    // VOID/EMPTY read as 0 (asNum semantics) — never stringify them: 'VOID' >
    // '0' would make every `member(...).number > 0` gate pass on missing
    // members.
    const aNull = a === null;
    const bNull = b === null;
    const na = Number(a);
    const nb = Number(b);
    const aNum = typeof a === 'number' || aNull || (typeof a === 'string' && a !== '' && Number.isFinite(na));
    const bNum = typeof b === 'number' || bNull || (typeof b === 'string' && b !== '' && Number.isFinite(nb));
    if (aNum && bNum) return na - nb;
    // Lingo coerces a symbol to its NAME (no '#') when compared with a
    // non-symbol — `#info > 0` is TRUE. Manager Template exists() /
    // Object Manager existence gates all rely on `getOne(tid) > 0` where
    // getOne returns the matched tid SYMBOL; stringifying with the '#'
    // (0x23 < '0') made every such gate false.
    const strOf = (v: LVal): string => (v instanceof LSymbol ? v.name : toLingoString(v));
    const sa = strOf(a);
    const sb = strOf(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  }

  private evalCall(call: Extract<Expr, { kind: 'call' }>, env: Env): LVal {
    const args = call.args.map((a) => this.evalExpr(a, env));
    const callee = call.callee;

    if (callee.kind === 'ident') {
      const name = callee.name;
      const lower = name.toLowerCase();
      if (lower === 'call') return this.callBuiltin(args);
      // `new(...)` is a Director keyword/builtin and must not be shadowable by
      // a script's `on new` handler (a movie script's `on new me` used to
      // hijack `new(script "X")` and return null instead of an instance).
      const global = lower === 'new' ? null : this.host.resolveGlobalHandler(name);
      if (global) {
        // DirPlayer LocalCall parity: a bare call to a handler of the CURRENT
        // script runs with the current scope's receiver (`me`). Two forms:
        //   * `searchTask(me, ...)` — me passed EXPLICITLY as the first arg
        //     (me is a normal param, no arg shift — binding the instance here
        //     would shift every arg).
        //   * `getInterstitial()` — no me arg (DirPlayer falls back to the
        //     scope receiver; without it me read VOID and objectExists(VOID)=0
        //     reported "Interstitial manager not found").
        const selfCall = global.script === this.currentScript;
        let instance: LObject | null = null;
        if (selfCall) {
          const firstHasHandler = args[0] instanceof LObjectClass && this.findHandler(args[0], name) !== null;
          if (!firstHasHandler && env.me instanceof LObjectClass) instance = env.me;
        }
        return this.callHandler(global.script, global.handler, args, instance, new Set());
      }
      const b = this.host.builtin(name, args, this);
      if (b !== undefined) return b;
      this.host.warn(`unresolved handler/builtin: ${name}`);
      return VOID;
    }

    if (callee.kind === 'prop') {
      const obj = this.evalExpr(callee.obj, env);
      return this.dispatchMethod(obj, callee.name, args);
    }

    this.host.warn('cannot call a non-method expression');
    return VOID;
  }

  private dispatchMethod(obj: LVal, name: string, args: LVal[]): LVal {
    if (obj instanceof LScriptRefClass) {
      const lower = name.toLowerCase();
      if (lower === 'new' || lower === 'construct') return this.newInstance(obj.script, args);
      // Shockwave JavaScript integration (Statistics Broker constructs a
      // JavaScriptProxy); a lenient stub keeps the boot quiet.
      if (lower === 'newjavascriptproxy') return this.host.xtraInstance('JavaScriptProxy');
      this.host.warn(`script(${obj.script.name}).${name}(): unsupported`);
      return VOID;
    }
    if (obj instanceof LObjectClass && obj.scriptName.startsWith('xtra:')) {
      const lower = name.toLowerCase();
      if (lower === 'new' || lower === 'construct') {
        // xtra("Multiuser").new() — instantiate an Xtra (stubbed): return a
        // fresh lenient instance so downstream .send()/.close() calls no-op.
        const name = obj.props.get('name') ?? obj.scriptName.slice(5);
        return this.host.xtraInstance(toLingoString(name));
      }
      // Real Multiuser Xtra contract. The engine's WebSocket-backed
      // implementation (DirectorEngine.xtraMethod) handles these when present;
      // otherwise they return 0 on success — Connection Instance's connect()
      // gates on `setNetMessageHandler(...) = 0` and would report "Creation of
      // callback failed" on any other value.
      if (['setnetbufferlimits', 'setnetmessagehandler', 'connecttonetserver', 'sendnetmessage', 'closenetconnection', 'disconnect', 'flushnetmessages', 'isconnected', 'getnumberwaitingnetmessages', 'checknetmessages', 'getnetmessage'].includes(lower)) {
        if (this.host.xtraMethod) return this.host.xtraMethod(obj, name, args);
        return 0;
      }
      // Real xmlparser Xtra (FUSE Figure System/Data parse partsets.xml,
      // draworder.xml, animation.xml and figuredata.xml through it — without
      // it every `*.loaded` flag flips to 1 with an empty child tree and the
      // human.parts/partset variables never get built).
      if ((obj.props.get('name') as string | undefined)?.toLowerCase() === 'xmlparser') {
        if (this.host.xmlParserMethod) return this.host.xmlParserMethod(obj, name, args);
        return VOID;
      }
      return this.callObjectHandler(obj, name, args);
    }
    if (obj instanceof LObjectClass && obj.scriptName.startsWith('sound:')) {
      if (this.host.soundChannelMethod) return this.host.soundChannelMethod(obj, name, args);
      return this.callObjectHandler(obj, name, args);
    }
    if (obj instanceof LObjectClass && obj.scriptName.startsWith('timeout:')) {
      const lower = name.toLowerCase();
      if (lower === 'new') {
        // timeout(name).new(period, #handler, target) — register a timer and
        // sync the object's props so `timeoutObj.period` reads back the period.
        const period = Math.max(0, Math.round(asNum(args[0])));
        const handler = args[1] instanceof LSymbol ? args[1].name : toLingoString(args[1]);
        const target = args[2];
        if (target instanceof LObjectClass) {
          obj.props.set('period', period);
          obj.props.set('handler', handler);
          obj.props.set('target', target);
          this.host.registerTimeout(obj, period, handler, target);
        } else this.host.warn('timeout().new(): target is not an object');
        return obj;
      }
      if (lower === 'forget') {
        this.host.forgetTimeout(obj);
        return VOID;
      }
    }
    if (obj instanceof LObjectClass) {
      const lower = name.toLowerCase();
      // `me.delay(ms, #handler, args...)` / `me.Cancel(id)` — one-shot delayed
      // handler calls. Corpus-wide (33 uses): CastLoad Manager schedules
      // removeCastLoadInstance 50ms after each download; DropDown schedules
      // #mouseUpOutSide and cancels it on mouseWithin. Director itself has no
      // such API, but the Habbo corpus's decompiled form uses exactly this
      // shape (an object method returning a cancelable ID).
      if (lower === 'delay' && this.host.scheduleDelay && !this.findHandler(obj, name)) {
        const ms = Math.max(0, Math.round(asNum(args[0])) || 0);
        const handler = args[1] instanceof LSymbol ? args[1].name : toLingoString(args[1]);
        if (!handler) {
          this.host.warn('me.delay(): missing handler symbol');
          return VOID;
        }
        return this.host.scheduleDelay(obj, ms, handler, args.slice(2));
      }
      if (lower === 'cancel' && this.host.cancelDelay && !this.findHandler(obj, name)) {
        this.host.cancelDelay(Math.round(asNum(args[0])));
        return 1;
      }
      return this.callObjectHandler(obj, name, args);
    }
    if (obj instanceof LListClass) return this.listMethod(obj, name, args);
    if (obj instanceof LPropListClass) return this.propListMethod(obj, name, args);
    if (obj instanceof LSpriteRefClass) return this.host.spriteMethod(obj, name, args);
    if (obj instanceof LMemberRefClass) return this.host.memberMethod(obj, name, args);
    if (obj instanceof LWindowRefClass) return this.host.windowMethod(obj, name, args);
    if (obj instanceof LImageClass) return this.imageMethod(obj, name, args);
    if (obj instanceof LColorClass) return this.colorMethod(obj, name, args);
    if (obj instanceof LPointClass) {
      // Director point method: point.inside(rect) — half-open rect test
      // (C++ OpcodeRegistry: x>=left && x<right && y>=top && y<bottom).
      const pl = name.toLowerCase();
      if (pl === 'inside') {
        const r = args[0];
        if (r instanceof LRectClass) {
          return obj.locH >= r.left && obj.locH < r.right && obj.locV >= r.top && obj.locV < r.bottom ? 1 : 0;
        }
        return 0;
      }
      return VOID;
    }
    // Director duplicate() copies ANY value — duplicateValue deep-copies
    // lists/proplists/images and returns strings/scalars/symbols as-is
    // (`session.GET("user_figure").duplicate()` may still be the raw server
    // figure string before Figure_System's part list loads).
    if (name.toLowerCase() === 'duplicate') return duplicateValue(obj);
    // A method call on VOID/EMPTY is a SILENT no-op returning VOID (Libre-
    // Shockwave dispatchObjectMethod falls through every type check to
    // voidValue). The Download Manager update loop iterates pActiveTasks by
    // a count captured before the loop, but a task completing mid-loop
    // deleteAt()s itself and shifts the list, so a later index reads VOID
    // and `tTask.getProperty(#url)` lands here — warn-free, like Director.
    if (obj === null || obj === undefined || obj instanceof LEmptyValue) return VOID;
    this.host.warn(`method ${name} called on ${toLingoString(obj)} (unsupported)`);
    return VOID;
  }

  // ------------------------------------------------------------ list methods

  private listMethod(list: LList, name: string, args: LVal[]): LVal {
    const lower = name.toLowerCase();
    switch (lower) {
      case 'add':
      case 'append':
        list.items.push(args[0] ?? VOID);
        return VOID;
      case 'addat': {
        const i = Math.round(asNum(args[0]));
        if (i >= 1) list.items.splice(Math.min(i - 1, list.items.length), 0, args[1] ?? VOID);
        return VOID;
      }
      case 'deleteat': {
        const i = Math.round(asNum(args[0]));
        if (i >= 1 && i <= list.items.length) list.items.splice(i - 1, 1);
        return VOID;
      }
      case 'getat':
        return list.items[Math.round(asNum(args[0])) - 1] ?? VOID;
      case 'setat': {
        const i = Math.round(asNum(args[0]));
        if (i >= 1) {
          while (list.items.length < i) list.items.push(VOID);
          list.items[i - 1] = args[1] ?? VOID;
        }
        return VOID;
      }
      case 'getone': {
        for (const item of list.items) if (lingoEquals(item, args[0] ?? VOID)) return item;
        return 0; // Lingo: getOne returns 0 when not found
      }
      case 'findpos':
      case 'getpos': {
        for (let i = 0; i < list.items.length; i++) {
          if (lingoEquals(list.items[i], args[0] ?? VOID)) return i + 1;
        }
        return 0;
      }
      case 'getlast':
        return list.items.length > 0 ? list.items[list.items.length - 1] : VOID;
      case 'deleteone': {
        const target = args[0] ?? VOID;
        for (let i = 0; i < list.items.length; i++) {
          if (lingoEquals(list.items[i], target)) {
            list.items.splice(i, 1);
            break;
          }
        }
        return VOID;
      }
      case 'duplicate':
        return duplicateValue(list);
      case 'count':
        // Lingo list.count() — SoundMachine Component getSoundListPageCount
        // pages its set list with `pSoundSetInventoryList.count()`.
        return list.items.length;
      case 'sort':
        list.items.sort(lingoListCompare);
        return list;
      default:
        this.host.warn(`list method ${name} not implemented`);
        return VOID;
    }
  }

  private propListMethod(pl: LPropList, name: string, args: LVal[]): LVal {
    const lower = name.toLowerCase();
    const key = keyOf(args[0]);
    switch (lower) {
      case 'addprop':
        // C++ appendProperty: ALWAYS append (duplicates kept) — pTaskQueue/
        // wire param lists accumulate repeated keys this way.
        if (key !== undefined) (pl.props as PropPairsClass).append(key, args[1] ?? VOID);
        return VOID;
      case 'setprop':
      case 'setaprop':
        // C++ putTyped: replace the FIRST match, else append.
        if (key !== undefined) pl.props.set(key, args[1] ?? VOID);
        return VOID;
      case 'getprop':
      case 'getaprop':
        return this.propGet(pl, key) ?? VOID;
      case 'getpropat': {
        // Director: getPropAt(index) returns the *key* at that position
        // (getPropAt(2) on [#breakfast:"Waffles", #lunch:"Tofu Burger"] ->
        // #lunch). Keys are stored normalized as strings (keyOf), so return
        // the raw key — wrapping it in LSymbol corrupted string keys.
        const i = Math.round(asNum(args[0]));
        const keys = [...pl.props.keys()];
        return i >= 1 && i <= keys.length ? keys[i - 1] : VOID;
      }
      case 'deleteprop':
        if (key !== undefined) pl.props.delete(key);
        return VOID;
      case 'getat': {
        const i = Math.round(asNum(args[0]));
        const values = [...pl.props.values()];
        return values[i - 1] ?? VOID;
      }
      case 'getlast': {
        // Director: proplist.getLast() returns the last element's value.
        // (CastLoad Manager's getAvailableEmptyCast pops pAvailableDynCasts.)
        const values = [...pl.props.values()];
        return values.length > 0 ? values[values.length - 1] : VOID;
      }
      case 'setat': {
        // Positional by INSERTION ORDER (C++ ListBuiltins::setAt) — keyed set
        // here would hit the FIRST match of a duplicated key, not position i.
        const i = Math.round(asNum(args[0]));
        if (i >= 1 && i <= pl.props.size) pl.setAt(i, args[1] ?? VOID);
        return VOID;
      }
      case 'deleteat': {
        const i = Math.round(asNum(args[0]));
        if (i >= 1 && i <= pl.props.size) pl.deleteAt(i);
        return VOID;
      }
      case 'duplicate':
        return duplicateValue(pl);
      case 'count':
        // Director: count(proplist) / proplist.count = number of pairs. The
        // DropDown define chain (UpdateImageObjects -> CreateElement) counts a
        // propList and previously warned "propList method count not
        // implemented" every time the room bar was built.
        return pl.props.size;
      case 'getone': {
        // Director: proplist.getOne(value) returns the KEY whose value matches
        // (raw key — string keys stay strings, matching getPropAt), or 0 when
        // not found. Object Manager / Manager Template existence checks gate
        // on `getOne(tid) <> 0` / `getOne(tid) > 0`.
        for (const [k, v] of pl.props) {
          if (lingoEquals(v, args[0] ?? VOID)) return k;
        }
        return 0;
      }
      case 'getpos': {
        // DirPlayer PropList getPos: 1-based position of the first pair whose
        // VALUE equals the arg, or 0 when absent. FUSE's convertSpecialChars
        // pairs chars as VALUES and reads them back via getPropAt — so getPos
        // matches the value, like the plain-list getPos.
        const values = [...pl.props.values()];
        const target = args[0] ?? VOID;
        for (let i = 0; i < values.length; i++) {
          if (lingoEquals(values[i], target)) return i + 1;
        }
        return 0;
      }
      case 'findpos': {
        // Director: proplist.findPos(prop) returns the 1-based position of the
        // property KEY (Answers.findPos(#c) on [#a:10,#b:12,#c:15] -> 3), and
        // VOID when absent (CastLoad Manager gates on
        // `voidp(pTaskList.findPos(tid))`).
        const k = keyOf(args[0]);
        const keys = [...pl.props.keys()];
        for (let i = 0; i < keys.length; i++) {
          if (k !== undefined && keys[i] === k) return i + 1;
          if (lingoEquals(keys[i], args[0] ?? VOID)) return i + 1;
        }
        return VOID;
      }
      case 'sort':
        // C++ ListBuiltins::sort returns VOID for proplists (only plain lists sort).
        return VOID;
      default:
        this.host.warn(`propList method ${name} not implemented`);
        return VOID;
    }
  }

  // ------------------------------------------------------------ image methods

  /** Director image.draw/fill/setPixel/crop — real RGBA painting. */
  /** `(the stage).image` SOURCE reads must see the composited scene, not the
   *  Lingo paint surface the Loading Bar fills (Director's stage image IS the
   *  display). Any image that IS the stage image gets the adapter's renderer
   *  readback substituted when one is available. */
  private readStageImage(img: LImage): LImage {
    if (img !== this.host.stageImage()) return img;
    return this.host.stageComposite?.() ?? img;
  }

  private imageMethod(img: LImage, name: string, args: LVal[]): LVal {
    const lower = name.toLowerCase();
    if (lower === 'duplicate') {
      return duplicateValue(img);
    }
    if (lower === 'fill') {
      const region = this.imageRegion(img, args);
      if (region) {
        img.fillRect(region.x1, region.y1, region.x2, region.y2, this.imageColor(args));
        this.host.imageMutated?.(img);
      }
      return img;
    }
    if (lower === 'draw') {
      const region = this.imageRegion(img, args);
      if (region) {
        const props = args.find((a) => a instanceof LPropListClass) as LPropListClass | undefined;
        const shapeV = props ? props.props.get('shapetype') : undefined;
        const shape = shapeV instanceof LSymbol ? shapeV.name.toLowerCase() : toLingoString(shapeV ?? '').toLowerCase();
        const color = props ? colorFrom(props.props.get('color') ?? VOID) : null;
        const bg = props ? colorFrom(props.props.get('bgcolor') ?? VOID) : null;
        const ls = props ? asNum(props.props.get('linesize') ?? 1) : 1;
        if (bg) img.fillRect(region.x1, region.y1, region.x2, region.y2, bg);
        if (shape === 'oval' || shape === 'circle') {
          img.drawOval(region.x1, region.y1, region.x2, region.y2, color, ls);
        } else if (shape === 'line') {
          img.drawLine(region.x1, region.y1, region.x2, region.y2, color);
        } else {
          img.drawRect(region.x1, region.y1, region.x2, region.y2, color, ls);
        }
        this.host.imageMutated?.(img);
      }
      return img;
    }
    if (lower === 'setpixel') {
      const color = colorFrom(args[args.length - 1] ?? VOID);
      if (args[0] instanceof LPointClass) {
        img.fillRect(args[0].locH, args[0].locV, args[0].locH + 1, args[0].locV + 1, color);
      } else {
        img.fillRect(asNum(args[0]), asNum(args[1]), asNum(args[0]) + 1, asNum(args[1]) + 1, color);
      }
      this.host.imageMutated?.(img);
      return img;
    }
    if (lower === 'crop') {
      const region = this.imageRegion(img, args);
      const src = this.readStageImage(img);
      return region ? src.crop(region.x1, region.y1, region.x2, region.y2) : new LImageClass(0, 0);
    }
    if (lower === 'getpixel') {
      // Director image.getPixel(h, v[, #integer]) / getPixel(point[, #integer])
      // — a COLOR (rgb(r,g,b)) by default, or the pixel's native integer with
      // #integer (palette index for 8-bit/palette art, 24-bit RGB otherwise).
      // Room Interface validateEvent gates `if not tPixel` and compares
      // `tPixel.hexString() = "#FFFFFF"` to click through matte white.
      const firstIsPoint = args[0] instanceof LPointClass;
      const pt = firstIsPoint ? (args[0] as LPointClass) : null;
      const h = Math.round(pt ? pt.locH : asNum(args[0]));
      const v = Math.round(pt ? pt.locV : asNum(args[1]));
      const flag = firstIsPoint ? args[1] : args[2];
      const returnInteger =
        flag instanceof LSymbol ? flag.name.toLowerCase() === 'integer' : toLingoString(flag ?? '').toLowerCase() === 'integer';
      const w = Math.round(img.width);
      const hh = Math.round(img.height);
      // DirPlayer get_pixel_color_ref: OUT OF BOUNDS returns the bitmap's
      // BACKGROUND color — palette index 0 for palette art, white RGB for
      // 32-bit — never VOID. validateEvent and Object Mover gate on it, so a
      // click on a sprite's edge/margin reads as background white (click-
      // through), not a dead click.
      if (h < 0 || v < 0 || h >= w || v >= hh) {
        const bg = img.palette && img.palette.length > 0 ? img.palette[0] : [255, 255, 255];
        if (returnInteger) {
          if (img.palette && img.palette.length > 0) return 0;
          return (bg[0] << 16) | (bg[1] << 8) | bg[2];
        }
        const bgColor = new LColorClass(bg[0], bg[1], bg[2]);
        if (img.palette && img.palette.length > 0) bgColor.paletteIndex = 0;
        return bgColor;
      }
      const data = img.ensure();
      const o = (v * w + h) * 4;
      const pr = data[o];
      const pg = data[o + 1];
      const pb = data[o + 2];
      if (returnInteger) {
        if (img.palette && img.palette.length > 1) {
          for (let i = 0; i < img.palette.length; i++) {
            const [r, g, b] = img.palette[i];
            if (r === pr && g === pg && b === pb) return i;
          }
        }
        return (pr << 16) | (pg << 8) | pb;
      }
      const color = new LColorClass(pr, pg, pb);
      if (img.palette && img.palette.length > 1) {
        let best = 0;
        let bestDist = Infinity;
        for (let i = 0; i < img.palette.length; i++) {
          const [r, g, b] = img.palette[i];
          const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
          if (d < bestDist) {
            bestDist = d;
            best = i;
          }
        }
        color.paletteIndex = best;
      }
      return color;
    }
    if (lower === 'trimwhitespace') {
      // Director: image.trimWhiteSpace() removes the transparent/white border
      // and returns a cropped image. FUSE getTextWidth/setButtonImage chain
      // uses it to tighten rendered part images before compositing.
      return this.imageTrimWhiteSpace(img);
    }
    if (lower === 'copypixels') {
      // Director image.copyPixels(srcImage, destRect, srcRect, [#ink: n,
      // #blend: pct, #bgColor: color, #maskImage: img]). destRect may be a
      // 4-point QUAD list (Human Class flipHorizontal) — axis-aligned quads
      // map to a rect copy with flipH/flipV.
      // `(the stage).image` as the SOURCE must be the composited scene (FUSE
      // screen camera, Photo Interface cam shot), not the Lingo paint surface.
      const srcArg = args[0];
      const src = srcArg instanceof LImageClass ? this.readStageImage(srcArg) : srcArg;
      if (src instanceof LImageClass && args[2] instanceof LRectClass) {
        const params = args.find((a) => a instanceof LPropListClass) as LPropListClass | undefined;
        const ink = params ? Math.round(asNum(params.props.get('ink') ?? 0)) : 0;
        // #blend is Director percent (0-100) -> copyPixels' 0-255 alpha;
        // #bgColor is the ink-36/8 background key (LColor or RGB integer);
        // #maskImage is the alpha mask (createMatte) that keys the source bg.
        let blend = 255;
        let bgColor = 0xffffff;
        let bgExplicit = false;
        let foreColor = 0x000000;
        let fgExplicit = false;
        let mask: LImageClass | null = null;
        if (params) {
          const blendV = params.props.get('blend') ?? params.props.get('Blend');
          if (blendV !== undefined) {
            blend = Math.max(0, Math.min(255, Math.round((asNum(blendV) * 255) / 100)));
          }
          const bgV = params.props.get('bgColor') ?? params.props.get('bgcolor') ?? params.props.get('BgColor');
          if (bgV !== undefined) bgExplicit = true;
          if (bgV instanceof LColorClass) {
            bgColor = (bgV.red << 16) | (bgV.green << 8) | bgV.blue;
          } else if (typeof bgV === 'number' && Number.isFinite(bgV)) {
            bgColor = bgV;
          }
          // #color: Director's foreColor for the grayscale tint (FUSE element
          // render passes the layout #color when it differs from black — the
          // purse title's #663300 turns the black text-member glyphs brown).
          const fgV = params.props.get('color') ?? params.props.get('Color');
          if (fgV !== undefined) fgExplicit = true;
          if (fgV instanceof LColorClass) {
            foreColor = (fgV.red << 16) | (fgV.green << 8) | fgV.blue;
          } else if (typeof fgV === 'number' && Number.isFinite(fgV)) {
            foreColor = fgV;
          }
          const maskV = params.props.get('maskImage') ?? params.props.get('maskimage') ?? params.props.get('MaskImage');
          if (maskV instanceof LImageClass) mask = maskV;
        }
        let destRect: LRectClass | null = null;
        let flipH = false;
        let flipV = false;
        if (args[1] instanceof LRectClass) {
          destRect = args[1];
        } else if (
          args[1] instanceof LListClass &&
          args[1].items.length === 4 &&
          args[1].items.every((p) => p instanceof LPointClass)
        ) {
          // Quad: TL, TR, BR, BL (Director's documented corner order). An
          // axis-aligned box is one of 8 orientations: identity, the three
          // mirrors (Human Class flipHorizontal), the 90/270° rotations
          // (dropmenu/scrollbar #rotate 9-slice rebuilds), and the diagonal
          // reflections. Mirrors keep the pixel-exact flipH/flipV path;
          // rotations/reflections sample through the inverse affine
          // (DirPlayer copy_pixels_quad). A rotation quad misread as a plain
          // mirror rendered the dropmenu's topmiddle/bottommiddle strips
          // wrong (black).
          const pts = args[1].items as LPointClass[];
          const xs = pts.map((p) => p.locH);
          const ys = pts.map((p) => p.locV);
          const minX = Math.min(...xs);
          const maxX = Math.max(...xs);
          const minY = Math.min(...ys);
          const maxY = Math.max(...ys);
          const destW = maxX - minX;
          const destH = maxY - minY;
          const axisAligned = pts.every((p) => (p.locH === minX || p.locH === maxX) && (p.locV === minY || p.locV === maxY));
          if (!axisAligned) {
            this.host.warn('copyPixels: non-axis-aligned quad — bounding-box fallback');
            destRect = new LRectClass(minX, minY, maxX, maxY);
            flipH = pts[0].locH === maxX;
            flipV = pts[0].locV === maxY;
          } else if (destW > 0 && destH > 0) {
            // Normalized src→dest affine from the corner mapping:
            // X' = a·x' + b·y' + c ; Y' = d·x' + e·y' + f, all coords in [0,1]
            // (src TL→q0, TR→q1, BR→q2, BL→q3).
            const c = (pts[0].locH - minX) / destW;
            const f = (pts[0].locV - minY) / destH;
            const a = (pts[1].locH - pts[0].locH) / destW;
            const d = (pts[1].locV - pts[0].locV) / destH;
            const b = (pts[3].locH - pts[0].locH) / destW;
            const e = (pts[3].locV - pts[0].locV) / destH;
            const eps = 1e-9;
            const pureMirror = Math.abs(b) < eps && Math.abs(d) < eps && Math.abs(Math.abs(a) - 1) < eps && Math.abs(Math.abs(e) - 1) < eps;
            destRect = new LRectClass(minX, minY, maxX, maxY);
            if (pureMirror) {
              flipH = pts[0].locH === maxX;
              flipV = pts[0].locV === maxY;
            } else {
              img.copyPixels(src, destRect, args[2], ink, blend, bgColor, mask, false, false, foreColor, fgExplicit, bgExplicit, { a, b, c, d, e, f });
              this.host.imageMutated?.(img);
              return img;
            }
          } else {
            this.host.warn('copyPixels: degenerate quad');
            return img;
          }
        } else {
          this.host.warn('copyPixels: unsupported dest rect form');
          return img;
        }
        img.copyPixels(src, destRect, args[2], ink, blend, bgColor, mask, flipH, flipV, foreColor, fgExplicit, bgExplicit);
        this.host.imageMutated?.(img);
      }
      return img;
    }
    if (lower === 'setalpha') {
      const r = this.imageSetAlpha(img, args);
      this.host.imageMutated?.(img);
      return r;
    }
    if (lower === 'creatematte' || lower === 'createmask') {
      // C++ Drawing::createMatte: native-alpha sources -> alpha threshold
      // matte; fully-opaque sources -> edge-connected flood-fill matte. The
      // returned mask is alpha-keyed so copyPixels' #maskImage consumes it
      // (Human Class body parts rely on it to drop the white backdrop).
      const w = Math.max(0, Math.round(img.width));
      const h = Math.max(0, Math.round(img.height));
      const mask = new LImageClass(w, h);
      const m = mask.ensure();
      const s = img.ensure();
      let hasTransparent = false;
      for (let i = 0; i < w * h && !hasTransparent; i++) {
        if (s[i * 4 + 3] === 0) hasTransparent = true;
      }
      if (hasTransparent) {
        // C++ createAlphaMatte: pixels at/below the threshold are matte
        // (skip); the default threshold 0 keys fully-transparent pixels.
        const thresh = args[0] !== undefined ? Math.round(asNum(args[0])) : 0;
        for (let i = 0; i < w * h; i++) {
          m[i * 4 + 3] = s[i * 4 + 3] > thresh ? 255 : 0;
        }
      } else {
        // Raw palette indices make the flood key palette INDEX 0 (DirPlayer
        // compute_edge_matte_mask_indexed) so same-colored art at other
        // indices (the fuzzy floor tile's white dither squares) survives.
        const flood = matteRegionMask(s, w, h, 0, 0, w, h, img.palette, img.indices);
        if (flood) {
          for (let i = 0; i < w * h; i++) m[i * 4 + 3] = flood[i] === 1 ? 0 : 255;
        } else {
          // No resolvable background — keep everything.
          for (let i = 0; i < w * h; i++) m[i * 4 + 3] = 255;
        }
      }
      mask.dirty = true;
      return mask;
    }
    // copy/scale/flip: not implemented — stay silent so UI scripts don't warn.
    if (['copy', 'scale', 'flip', 'fliph', 'flipv', 'rotate'].includes(lower)) return img;
    this.host.warn(`image method ${name} is a no-op stub`);
    return img;
  }

  /** Director image.setAlpha(level | alphaImage) — a port of LibreShockwave's
   *  imageSetAlpha (OpcodeRegistry): the image must be 32-bit. A number arg
   *  sets a flat 0-255 alpha on every pixel; an image arg must be 8-bit and
   *  same-sized, and its LUMA becomes the alpha channel — inverted to
   *  255-luma when the mask has "matte polarity" (any transparent pixel, or a
   *  mostly-white edge with a dark interior, or white corners + dark pixels),
   *  because then the mask's WHITE is the keyed background. Either form
   *  enables useAlpha and returns TRUE; 0 on any condition failure.
   *  fakeAlphaRender builds tFakeAlpha (8-bit, black glyphs on the opaque
   *  white palette-0 fill) and calls `tOut.setAlpha(tFakeAlpha)` — the white
   *  background inverts to alpha 0, the glyphs stay opaque. */
  private imageSetAlpha(img: LImageClass, args: LVal[]): LVal {
    if (img.depth !== 32 || args.length === 0) return 0;
    const w = Math.max(0, Math.round(img.width));
    const h = Math.max(0, Math.round(img.height));
    const first = args[0];
    let mattePolarity = false;
    if (first instanceof LImageClass) {
      const alpha = first;
      if (alpha.depth !== 8 || alpha.width !== img.width || alpha.height !== img.height) return 0;
      const a = alpha.ensure();
      if (w > 0 && h > 0) {
        // imageAlphaHasTransparency: any pixel with alpha < 255.
        let hasTransparency = false;
        let hasDark = false;
        let edgeWhite = 0;
        let edgeTotal = 0;
        let whiteCorners = 0;
        let cornerCount = 0;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const o = (y * w + x) * 4;
            if (a[o + 3] < 255) hasTransparency = true;
            const luma = ((77 * a[o] + 150 * a[o + 1] + 29 * a[o + 2] + 128) >> 8) & 0xff;
            if (luma < 250) hasDark = true;
            const onEdge = x === 0 || y === 0 || x === w - 1 || y === h - 1;
            if (onEdge) {
              edgeTotal++;
              if (luma >= 250) edgeWhite++;
            }
            const onCorner =
              (x === 0 || x === w - 1) && (y === 0 || y === h - 1);
            if (onCorner) {
              cornerCount++;
              if (luma >= 250) whiteCorners++;
            }
          }
        }
        mattePolarity =
          hasTransparency ||
          (hasDark && edgeTotal > 0 && edgeWhite * 4 >= edgeTotal * 3) ||
          (cornerCount > 0 && whiteCorners === cornerCount && hasDark);
      }
      const d = img.ensure();
      img.dirty = true;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const o = (y * w + x) * 4;
          let level = ((77 * a[o] + 150 * a[o + 1] + 29 * a[o + 2] + 128) >> 8) & 0xff;
          if (mattePolarity) level = 255 - level;
          d[o + 3] = level;
        }
      }
      img.useAlpha = true;
      return 1;
    }
    // Flat level form.
    const level = Math.max(0, Math.min(255, Math.round(asNum(first))));
    const d = img.ensure();
    img.dirty = true;
    for (let i = 3; i < w * h * 4; i += 4) d[i] = level;
    img.useAlpha = true;
    return 1;
  }

  /** Director color methods: hexString() — "#RRGGBB" (Room Interface
   *  validateEvent compares `tPixel.hexString() = "#FFFFFF"` to click through
   *  matte white). */
  private colorMethod(c: LColorClass, name: string, _args: LVal[]): LVal {
    const lower = name.toLowerCase();
    if (lower === 'hexstring') {
      const hex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0').toUpperCase();
      return `#${hex(c.red)}${hex(c.green)}${hex(c.blue)}`;
    }
    if (lower === 'paletteindex') return c.paletteIndex ?? VOID;
    this.host.warn(`color method ${name} is a no-op stub`);
    return VOID;
  }

  private imageRegion(img: LImage, args: LVal[]): { x1: number; y1: number; x2: number; y2: number } | null {
    const a = args[0];
    if (a instanceof LRectClass) return { x1: a.left, y1: a.top, x2: a.right, y2: a.bottom };
    if (a instanceof LPointClass && args[1] instanceof LPointClass) {
      return { x1: a.locH, y1: a.locV, x2: args[1].locH, y2: args[1].locV };
    }
    if (
      typeof a === 'number' && typeof args[1] === 'number' &&
      typeof args[2] === 'number' && typeof args[3] === 'number'
    ) {
      return { x1: a, y1: args[1], x2: args[2], y2: args[3] };
    }
    return null;
  }

  private imageColor(args: LVal[]): LColorClass | null {
    const last = args[args.length - 1];
    if (last instanceof LPropListClass) return colorFrom(last.props.get('color') ?? VOID);
    return colorFrom(last ?? VOID);
  }

  /** Director image.trimWhiteSpace(): trim fully-transparent OR pure-white
   *  outer rows/cols and return the cropped image (LibreShockwave Bitmap::
   *  trimWhiteSpace: `alpha == 0 || rgb == 0xFFFFFF` are both empty). FUSE uses
   *  it to tighten rendered part images before getTextWidth / copyPixels
   *  compositing — the button text member is white-filled (bgColor) so without
   *  the white trim every button measured its full 300px box width. */
  private imageTrimWhiteSpace(img: LImage): LImage {
    const d = img.ensure();
    const w = Math.max(0, Math.round(img.width));
    const h = Math.max(0, Math.round(img.height));
    let x1 = w, y1 = h, x2 = -1, y2 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        if (d[o + 3] === 0) continue;
        if ((d[o] << 16 | d[o + 1] << 8 | d[o + 2]) === 0xffffff) continue;
        if (x < x1) x1 = x; if (x > x2) x2 = x;
        if (y < y1) y1 = y; if (y > y2) y2 = y;
      }
    }
    if (x2 < 0) return new LImageClass(0, 0);
    return img.crop(x1, y1, x2 + 1, y2 + 1);
  }

  // ------------------------------------------------------------ properties

  getPropValue(obj: LVal, name: string): LVal {
    const lower = name.toLowerCase();
    if (obj === null || obj instanceof LEmptyValue) {
      // Director: `x.ilk` works on every value (void → #void, empty → #empty).
      if (lower === 'ilk') return ilkOf(obj);
      return VOID;
    }
    if (typeof obj === 'string') {
      // Director: string.length / string.ilk (FUSE obfuscate/deobfuscate,
      // chars(), and removeCastLoadInstance's `tFile.ilk <> #string` gate).
      if (lower === 'length') return obj.length;
      if (lower === 'ilk') return ilkOf(obj);
      return VOID;
    }
    if (typeof obj === 'number' || obj instanceof LSymbol) {
      // Director: 0.ilk → #integer, 1.5.ilk → #float, #foo.ilk → #symbol.
      // FUSE gates depend on these: registerListener's `tid.ilk <> #symbol`
      // (header ids default to #info/#mus symbols) and setLogMode's
      // `tMode.ilk <> #integer`.
      if (lower === 'ilk') return ilkOf(obj);
      return VOID;
    }
    if (obj instanceof LPointClass) {
      if (lower === 'loch') return obj.locH;
      if (lower === 'locv') return obj.locV;
      if (lower === 'ilk') return ilkOf(obj);
      return VOID;
    }
    if (obj instanceof LRectClass) {
      if (lower === 'left') return obj.left;
      if (lower === 'top') return obj.top;
      if (lower === 'right') return obj.right;
      if (lower === 'bottom') return obj.bottom;
      if (lower === 'width') return obj.width;
      if (lower === 'height') return obj.height;
      if (lower === 'ilk') return ilkOf(obj);
      return VOID;
    }
    if (obj instanceof LListClass) {
      if (lower === 'count') return obj.items.length;
      if (lower === 'ilk') return ilkOf(obj);
      return VOID;
    }
    if (obj instanceof LPropListClass) {
      if (lower === 'count') return obj.props.size;
      if (lower === 'ilk') {
        // FUSE structs are proplists that self-identify via a stored
        // `# ilk:#struct` key (struct.font.* in external_vars). Writer's
        // setFont gates on `tStruct.ilk <> #struct`, so the stored key wins.
        const stored = obj.props.get('ilk');
        return stored !== undefined ? stored : ilkOf(obj);
      }
      const lHit = this.propGet(obj, lower);
      if (lHit !== undefined) return lHit;
      return this.propGet(obj, name) ?? VOID;
    }
    if (obj instanceof LObjectClass) {
      if (lower === 'ilk') return ilkOf(obj);
      // Explicit `me.prop` access must walk the #ancestor chain exactly like
      // bare identifiers do (e.g. `me.pItemList` where pItemList is declared
      // on an ancestor class). Resolution is declaration-based on both read
      // and write so they can never disagree: the first object in the chain
      // whose script declares the property owns it.
      let cur: LObjectClass | null = obj;
      let hops = 0;
      while (cur) {
        if (cur.script && this.propsLowerOf(cur.script).has(lower)) {
          const v =
            cur.props.has(name) ? cur.props.get(name) : cur.props.has(lower) ? cur.props.get(lower) : undefined;
          if (v === undefined) return VOID; // declared but never assigned → VOID (Lingo semantics)
          // Float-typed property → re-mark the value on read so divisions in
          // this statement float-divide (Director keeps the prop as a Float
          // datum; see objectFloatProps).
          if (this.objectFloatProps.get(cur)?.has(lower)) return this.markFloatValue(v);
          return v;
        }
        if (++hops > 32) break;
        const anc = cur.props.get('ancestor');
        cur = anc instanceof LObjectClass ? anc : null;
      }
      // No declaring script (lenient engine-made stubs): read the value map.
      if (obj.props.has(name)) {
        const v = obj.props.get(name)!;
        return this.objectFloatProps.get(obj)?.has(lower) ? this.markFloatValue(v) : v;
      }
      if (obj.props.has(lower)) {
        const v = obj.props.get(lower)!;
        return this.objectFloatProps.get(obj)?.has(lower) ? this.markFloatValue(v) : v;
      }
      return VOID;
    }
    if (obj instanceof LMemberRefClass) return this.host.getMemberProp(obj, name);
    if (obj instanceof LSpriteRefClass) return this.host.getSpriteProp(obj, name);
    if (obj instanceof LCastLibRefClass) return this.host.getCastLibProp(obj, name);
    if (obj instanceof LWindowRefClass) return this.host.getWindowProp(obj, name);
    if (obj instanceof LImageClass) {
      if (lower === 'width') return obj.width;
      if (lower === 'height') return obj.height;
      if (lower === 'rect') return new LRectClass(0, 0, obj.width, obj.height);
      if (lower === 'depth') return obj.depth ?? 32;
      if (lower === 'paletteref') return obj.paletteRef ?? VOID;
      if (lower === 'usealpha') return obj.useAlpha ? 1 : 0;
      if (lower === 'ilk') return ilkOf(obj);
      return VOID;
    }
    if (obj instanceof LColorClass) {
      if (lower === 'red') return obj.red;
      if (lower === 'green') return obj.green;
      if (lower === 'blue') return obj.blue;
      if (lower === 'paletteindex') return obj.paletteIndex ?? VOID;
      if (lower === 'ilk') return ilkOf(obj);
      return VOID;
    }
    if (obj instanceof LStageRefClass) {
      if (lower === 'width') return obj.width;
      if (lower === 'height') return obj.height;
      if (lower === 'rect') return new LRectClass(0, 0, obj.width, obj.height);
      if (lower === 'image') return this.host.stageImage();
      if (lower === 'bgcolor') return this.host.stageBgColor();
      return VOID;
    }
    return VOID;
  }

  private setPropValue(obj: LVal, name: string, value: LVal): void {
    const lower = name.toLowerCase();
    if (obj === null || obj instanceof LEmptyValue) {
      // Director: setting a property on VOID/EMPTY is a silent no-op. Entry
      // Interface animSign does `tSpr.locV = tSpr.locV + 30` over pSignSprList
      // entries that are VOID when the visual def lacks the sprite id.
      return;
    }
    if (obj instanceof LPointClass) {
      if (lower === 'loch') obj.locH = asNum(value);
      if (lower === 'locv') obj.locV = asNum(value);
      return;
    }
    if (obj instanceof LRectClass) {
      if (lower === 'left') obj.left = asNum(value);
      if (lower === 'top') obj.top = asNum(value);
      if (lower === 'right') obj.right = asNum(value);
      if (lower === 'bottom') obj.bottom = asNum(value);
      return;
    }
    if (obj instanceof LObjectClass) {
      // Property declared on an ancestor goes to the declaring object, so a
      // parent instance sees `me.pX` writes through the chain. Mirrors the
      // read path exactly (declaration-based ownership).
      let cur: LObjectClass | null = obj;
      let hops = 0;
      while (cur && cur.script) {
        if (this.propsLowerOf(cur.script).has(lower)) {
          cur.props.set(name, value);
          return;
        }
        if (++hops > 32) break;
        const anc = cur.props.get('ancestor');
        cur = anc instanceof LObjectClass ? anc : null;
      }
      obj.props.set(name, value);
      // `sound(n).volume = v` — the raw channel's gain (the Sound Channel
      // Class mirrors its pVolume into the channel before/after play).
      if (obj.scriptName.startsWith('sound:') && lower === 'volume') {
        this.host.soundChannelMethod?.(obj, 'setVolume', [value]);
      }
      return;
    }
    if (obj instanceof LPropListClass) {
      obj.props.set(name, value);
      return;
    }
    if (obj instanceof LColorClass) {
      // `tBalloonColorDarken.red = tBalloonColor.red * 0.9` — color channels
      // are settable in Director, clamped to 0-255 (Balloon Manager darkens
      // bright bubble colors; a no-op left the bubble black on bots/pets).
      // A channel write detaches the color from its palette index.
      const clamp255 = (v: LVal): number => Math.max(0, Math.min(255, Math.round(asNum(v))));
      if (lower === 'red') { obj.red = clamp255(value); obj.paletteIndex = undefined; return; }
      if (lower === 'green') { obj.green = clamp255(value); obj.paletteIndex = undefined; return; }
      if (lower === 'blue') { obj.blue = clamp255(value); obj.paletteIndex = undefined; return; }
      this.host.warn(`cannot set ${name} on ${toLingoString(obj)}`);
      return;
    }
    if (obj instanceof LMemberRefClass) return this.host.setMemberProp(obj, name, value);
    if (obj instanceof LSpriteRefClass) return this.host.setSpriteProp(obj, name, value);
    if (obj instanceof LCastLibRefClass) return this.host.setCastLibProp(obj, name, value);
    if (obj instanceof LWindowRefClass) return this.host.setWindowProp(obj, name, value);
    if (obj instanceof LImageClass) {
      // `image.paletteRef = member(...)` — the palette behind an 8-bit image
      // (Unique Element define 0057: `if pimage.paletteRef <> pPalette then
      // pimage.paletteRef = pPalette`). Store the ref so the corpus's
      // `<>` comparison and `the paletteRef of image` read it back; the
      // table below also feeds the ink-8 copyPixels matte (palette index 0)
      // and any later `paletteRef` assignment chains through remapPalette.
      if (lower === 'paletteref') {
        obj.paletteRef = value;
        // Director remaps an 8-bit image's pixels through the palette it
        // points at (the messenger's `#palette: "interface palette_messenger"`
        // turns its teal chrome gold). Indices are recovered by matching each
        // RGB against the image's source palette, then taking that index from
        // the target table.
        const target = this.host.resolvePaletteTable(value);
        if (target) {
          obj.remapPalette(target);
          // Members without a .pal companion have RGB baked by the export, so
          // remapPalette no-ops and the image stays palette-less; the ink-8
          // matte then falls back to the pixel-(0,0) heuristic and black/gray
          // corners get keyed away. Attach the target table so the matte keys
          // palette[0] exactly — but ONLY when the image has no palette at
          // all: SYSTEM_PALETTE (the [[255,255,255]] singleton) is a real
          // keying palette and must survive (the flipped purse_sd1 shadow
          // keys white through it).
          if (!obj.palette) obj.palette = target;
        }
        return;
      }
      if (lower === 'usealpha') {
        // Director image.useAlpha — native-alpha flag (LibreShockwave
        // setImageProp: bitmap.setNativeAlpha(truthy)). fakeAlphaRender sets
        // `tOut.useAlpha = 1` before setAlpha to say "the alpha channel is
        // live".
        obj.useAlpha = isTruthy(value);
        return;
      }
      this.host.warn(`cannot set ${name} on ${toLingoString(obj)}`);
      return;
    }
    if (obj instanceof LStageRefClass) {
      // `(the stage).title = ...` — benign window-title no-op.
      if (lower === 'title') return;
      this.host.warn(`cannot set ${name} on ${toLingoString(obj)}`);
      return;
    }
    this.host.warn(`cannot set ${name} on ${toLingoString(obj)}`);
  }

  /** Proplist key read that also tries the underscore/space spelling variant:
   *  the decompiler underscored member filenames ("habbo_basic.window") while
   *  proplists built from `tmember.name` store the real Director name ("habbo
   *  basic.window"). Exact key always wins; variants only when the key has
   *  _ or space. */
  private propGet(pl: LPropList, key: string | undefined): LVal | undefined {
    if (key === undefined) return undefined;
    if (pl.props.has(key)) return pl.props.get(key)!;
    // Director treats spaces/underscores in names as equivalent — a name can
    // mix both ("pool_a Class"), so try every combination.
    const variants: string[] = [];
    if (key.includes(' ')) variants.push(key.replaceAll(' ', '_'));
    if (key.includes('_')) variants.push(key.replaceAll('_', ' '));
    if (key.includes(' ') && key.includes('_')) variants.push(key.replaceAll(' ', '_').replaceAll('_', ' '));
    for (const variant of variants) {
      if (pl.props.has(variant)) return pl.props.get(variant)!;
    }
    // Layout margin keys only: dropmenu1.element stores #marginh/#marginv
    // (all lowercase) while the DropDown Class reads #marginH/#marginV
    // (capital H/V) — a miss left the dropdown text flush at x=0. These are
    // the ONLY keys the corpus mixes casing on, so the case-insensitive
    // fallback is scoped to exactly them (every other lookup stays
    // byte-identical to a fully case-sensitive engine).
    if (key === 'marginH' || key === 'marginV' || key === 'marginbottom') {
      const lower = key.toLowerCase();
      for (const [k, v] of pl.props) {
        if (k.toLowerCase() === lower) return v;
      }
    }
    return undefined;
  }

  private getIndexValue(obj: LVal, index: LVal): LVal {
    if (obj instanceof LListClass) {
      const i = Math.round(asNum(index));
      return obj.items[i - 1] ?? VOID;
    }
    if (obj instanceof LPropListClass) {
      const numeric =
        typeof index === 'number' ||
        (index !== null && typeof index === 'object' && ilkOf(index).name === 'integer');
      if (!numeric) {
        // Director/C++ getAt: string/symbol index addresses the prop by KEY.
        const key = keyOf(index);
        const hit = this.propGet(obj, key);
        if (hit !== undefined) return hit;
        // Window TITLE elements author their text colors as #color/#bgColor
        // (the Layout Parser only maps those to #txtColor/#txtBgColor for
        // OLD version-less defs), so an absent #txtColor/#txtBgColor read
        // falls back to the authored #color/#bgColor (read-only — no key is
        // created; elements without explicit colors are unaffected since the
        // parser defaults #color to black and #bgColor to white first).
        if (key !== undefined) {
          const k = key.toLowerCase();
          if (k === 'txtcolor' || k === 'txtbgcolor') {
            const want = k === 'txtcolor' ? 'color' : 'bgcolor';
            for (const [pk, pv] of obj.props) {
              if (pk.toLowerCase() === want) return pv;
            }
          }
        }
        return VOID;
      }
      // Director/C++ getAt: a NUMBER index addresses the i-th prop by
      // INSERTION ORDER (out-of-range falls back to the numeric key) — must
      // mirror setIndexValue's positional write. Connection Manager
      // registerListener pairs getPropAt(i) (key at pos i) with tMsgList[i]
      // (value at pos i) over message-id-keyed propLists; a key-first lookup
      // here shifted every registration by one and the HELLO handshake never
      // started.
      const i = Math.round(asNum(index));
      const value = obj.getAt(i);
      if (value !== undefined) return value;
      const key = keyOf(index);
      if (key !== undefined) {
        const hit = this.propGet(obj, key);
        if (hit !== undefined) return hit;
      }
      return VOID;
    }
    if (typeof obj === 'string') {
      const i = Math.round(asNum(index));
      return i >= 1 && i <= obj.length ? obj[i - 1] : VOID;
    }
    if (obj instanceof LPointClass) {
      const i = Math.round(asNum(index));
      return i === 1 ? obj.locH : i === 2 ? obj.locV : VOID;
    }
    if (obj instanceof LRectClass) {
      const i = Math.round(asNum(index));
      return i === 1 ? obj.left : i === 2 ? obj.top : i === 3 ? obj.right : i === 4 ? obj.bottom : VOID;
    }
    if (obj instanceof LObjectClass) {
      const key = keyOf(index);
      if (key !== undefined && obj.props.has(key)) return obj.props.get(key)!;
      return VOID;
    }
    return VOID;
  }

  private setIndexValue(obj: LVal, index: LVal, value: LVal): void {
    if (obj instanceof LListClass) {
      const i = Math.round(asNum(index));
      if (i >= 1) {
        while (obj.items.length < i) obj.items.push(VOID);
        obj.items[i - 1] = value;
      }
      return;
    }
    if (obj instanceof LPropListClass) {
      if (typeof index === 'number' || (index !== null && typeof index === 'object' && ilkOf(index).name === 'integer')) {
        // Director: `proplist[i] = value` addresses the i-th prop by INSERTION
        // ORDER (Event Broker registerProcedure rewrites every event slot
        // with `pProcList[i] = [getPropAt(i), client]`; string-keying the
        // number left the symbol slots without a client and clicks dead-ended
        // at redirectEvent).
        const i = Math.round(asNum(index));
        if (i >= 1 && i <= obj.props.size) obj.setAt(i, value);
        return;
      }
      const key = keyOf(index);
      if (key !== undefined) obj.props.set(key, value);
      return;
    }
    if (obj instanceof LRectClass) {
      // Director: `tRect[1] = x` sets the left/top/right/bottom corner
      // (Window Instance buildVisual grows an inverted sentinel rect
      // rect(2000,2000,-2000,-2000) with tElemRect[n] = ... per element).
      const i = Math.round(asNum(index));
      if (i === 1) obj.left = asNum(value);
      else if (i === 2) obj.top = asNum(value);
      else if (i === 3) obj.right = asNum(value);
      else if (i === 4) obj.bottom = asNum(value);
      return;
    }
    if (obj instanceof LObjectClass) {
      const key = keyOf(index);
      if (key !== undefined) {
        if (key === 'ancestor' && (value === null || value === undefined)) {
          // Director: assigning VOID to #ancestor keeps an existing link
          // (Thread Manager buildThreadObj pre-links tBase, then a chain loop
          // writes VOID to #ancestor — components must still reach the
          // thread's handlers through the chain).
          if (!(obj.props.get('ancestor') instanceof LObjectClass)) obj.props.set(key, value);
          return;
        }
        obj.props.set(key, value);
      }
      return;
    }
    if (typeof obj === 'string') {
      const i = Math.round(asNum(index));
      if (i >= 1 && i <= obj.length && typeof value === 'string') {
        (obj as string) = obj.slice(0, i - 1) + value[0] + obj.slice(i);
      }
      return;
    }
    this.host.warn(`cannot index-assign on ${toLingoString(obj)} [${this.callTrail.slice(-4).join(' <- ')}]`);
  }

  // ------------------------------------------------------------ chunks

  private chunkParts(obj: LVal, chunk: string): string[] | null {
    let str: string | null = typeof obj === 'string' ? obj : null;
    if (str === null) {
      if (chunk === 'item' && obj instanceof LListClass) return obj.items.map(toLingoString);
      // U91: Director chunk expressions on a MEMBER REF read the member's
      // text (`pTextMem.char.count` in the Text Wrapper sizes centered window
      // titles via charPosToLoc(char.count).locH + 16 — returning 0 clamped
      // charPosToLoc to char 1, so "Habbo Console" measured as 5px and the
      // title box collapsed to 21px, clipping the header text).
      if (obj instanceof LMemberRefClass) {
        const t = this.host.getMemberProp(obj, 'text');
        if (typeof t === 'string') str = t;
      }
      if (str === null) return null;
    }
    switch (chunk) {
      case 'char':
        return str.split('');
      case 'word':
        // Director splits words on whitespace AND ASCII control characters
        // (dirplayer is_director_whitespace). Wire frames carry the v14
        // string terminator char(2) inside content — "59.0\x02".word[1] must
        // be "59.0" or the wallet balance parses as 0.
        return str.split(/[\s\x00-\x1f\x7f]+/).filter((w) => w.length > 0);
      case 'line':
        // Director line chunks split on CR (chr 13) — the corpus joins text
        // with RETURN and old-Mac files use bare CR; CRLF and bare LF are
        // tolerated so cross-platform text chunks predictably.
        return str.split(LINE_SEP_RE);
      case 'item':
        return str.split(this.host.itemDelimiter());
      case 'paragraph':
        return str.split(LINE_SEP_RE);
      default:
        return null;
    }
  }

  getChunkValue(obj: LVal, chunk: string, from?: number, to?: number): LVal {
    const parts = this.chunkParts(obj, chunk);
    if (parts === null) return VOID;
    // Director: negative indexes count from the end (`char -1` = last char);
    // an index resolving before char 1 is out of range and reads EMPTY
    // (`char -30003 of "abc"` = ''), never clamped to char 1. Out-of-range
    // HIGH ends clamp (e.g. `char 2 to 10 of "abc"` = "bc").
    const rawStart = from ?? 1;
    const rawEnd = to ?? rawStart;
    // DirPlayer vm_range_to_host parity: a chunk index <= -30000 is the
    // compiler's "last element" sentinel (`char -30000 of "abc"` = "c", the
    // corpus ships -30003). Only for the single-element read.
    if (rawStart <= -30000) return parts[parts.length - 1] ?? '';
    const start = rawStart < 0 ? parts.length + rawStart + 1 : rawStart;
    const end = rawEnd < 0 ? parts.length + rawEnd + 1 : rawEnd;
    if (start < 1 || start > parts.length || start > end) return '';
    const slice = parts.slice(start - 1, Math.min(parts.length, end));
    if (start === end) return slice[0];
    const sep = chunk === 'char' ? '' : chunk === 'word' ? ' ' : chunk === 'line' || chunk === 'paragraph' ? '\r' : this.host.itemDelimiter();
    return slice.join(sep);
  }

  /** The separator chunk parts are joined with (mirror of getChunkValue). */
  private chunkJoin(parts: string[], chunk: string): string {
    const sep =
      chunk === 'char' ? '' : chunk === 'word' ? ' ' : chunk === 'line' || chunk === 'paragraph' ? '\r' : this.host.itemDelimiter();
    return parts.join(sep);
  }

  /** Lingo chunk assignment (`char/word/item/line/paragraph N of s = x` and
   *  `put x into ...`): strings ARE chunk-assignable. Returns the NEW string
   *  so the caller (execAssign 'chunk') writes it back to the target variable
   *  — the old code assigned the local parameter and warned 'no effect'.
   *  Returns null when the target isn't a string or the range is out of
   *  bounds (Director silently no-ops those). */
  setChunkValue(obj: LVal, chunk: string, from: number | undefined, to: number | undefined, value: LVal): string | null {
    if (typeof obj !== 'string') {
      this.host.warn('chunk assignment only supported on strings');
      return null;
    }
    if (from === undefined) return null;
    const parts = this.chunkParts(obj, chunk);
    if (parts === null) return null;
    const rawStart = from;
    const rawEnd = to ?? from;
    // Compiler "the last word/char of t" sentinel (same as delete/get).
    if (rawStart <= -30000) {
      if (parts.length === 0) return null;
      parts.splice(parts.length - 1, 1, toLingoString(value));
      return this.chunkJoin(parts, chunk);
    }
    const start = rawStart < 0 ? parts.length + rawStart + 1 : rawStart;
    const end = rawEnd < 0 ? parts.length + rawEnd + 1 : rawEnd;
    if (start < 1 || start > parts.length || start > end) return null;
    const replacement = toLingoString(value);
    // char assignment splices per-character ("XYZ" into char 2 grows the
    // string); word/item/line/paragraph replace the whole chunk as one unit.
    const slice = chunk === 'char' ? replacement.split('') : [replacement];
    parts.splice(start - 1, end - start + 1, ...slice);
    return this.chunkJoin(parts, chunk);
  }

  /** Count-only chunk reads (`tText.line.count`, `tPkt.item.count`) are the
   *  corpus's most common chunk probe (323 call sites) — the full split()
   *  materialized an array just to count. These scan without allocating;
   *  semantics mirror the split() the array path uses (line/item keep a
   *  trailing empty piece, so "a\r" counts 2; words drop empties). */
  chunkCount(obj: LVal, chunk: string): number {
    let str: string | null = typeof obj === 'string' ? obj : null;
    if (str === null) {
      if (chunk === 'item' && obj instanceof LListClass) return obj.items.length;
      if (obj instanceof LMemberRefClass) {
        const t = this.host.getMemberProp(obj, 'text');
        if (typeof t === 'string') str = t;
      }
      if (str === null) return 0;
    }
    switch (chunk) {
      case 'char':
        return str.length;
      case 'word':
        // Token runs between [\s\x00-\x1f\x7f]+ separators (matches the
        // split + filter in chunkParts).
        let words = 0;
        let inTok = false;
        for (let i = 0; i < str.length; i++) {
          const c = str.charCodeAt(i);
          const sep = c === 32 || (c >= 0 && c <= 31) || c === 127;
          if (sep) inTok = false;
          else if (!inTok) {
            inTok = true;
            words++;
          }
        }
        return words;
      case 'line':
      case 'paragraph':
        // split(LINE_SEP_RE) keeps a trailing empty piece: count = 1 + runs.
        return 1 + countRegexRuns(str, LINE_SEP_RE);
      case 'item': {
        const delim = this.host.itemDelimiter();
        return delim ? countSubstringRuns(str, delim) : 0;
      }
      default:
        return 0;
    }
  }

  /** Evaluate a literal expression string (backs value()). */
  evalExpressionString(src: string): LVal {
    try {
      const expr = parseExpr(src);
      // Director: an unknown bare word in value() is a literal string
      // (FUSE relies on this: value("core") -> "core", value("123") -> 123).
      if (expr.kind === 'ident') return expr.name;
      const env = new Env();
      return this.evalExpr(expr, env);
    } catch (e) {
      // Lenient like Director: a string that is not a valid Lingo expression
      // (e.g. a version "0.2.0") evaluates to itself, not VOID.
      return src;
    }
  }
}
