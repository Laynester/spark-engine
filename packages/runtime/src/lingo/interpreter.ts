import type { Expr, Handler, Script, Stmt, TheSegment } from './ast.js';
import { parseExpr } from './parser.js';
import {
  asNum, colorFrom, duplicateValue, ilkOf, isTruthy, keyOf, rawKeyOf, LEMPTY, lingoAdd, lingoConcat,
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
import { compileHandlerBody } from './jit.js';

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
  debugCopyOwner(img: unknown): string;
  warn(msg: string): void;
  getMember(number: number, castLibNumber?: number): LMemberRef | null;
  getMemberByName(name: string): LMemberRef | null;
  resolvePaletteTable(value: LVal): number[][] | null;
  newMember(kind: string, castLibNumber: number): LMemberRef | null;
  getSprite(channel: number): LSpriteRef;
  getCastLib(arg: LVal): LCastLibRef | null;
  getWindow(id: string): LWindowRef | null;
  getStage(): LStageRef;
  stageImage(): LImage;
  stageComposite?(): LImage | null;
  imageMutated?(img: LImage): void;
  stageBgColor(): LVal;
  getThe(head: string, chain: TheSegment[]): LVal;
  setThe(head: string, chain: TheSegment[], value: LVal): void;
  itemDelimiter(): string;
  resolveGlobalHandler(name: string): GlobalHandlerRef | null;
  resolveScript(name: string): Script | null;
  globalGet(name: string): LVal | undefined;
  globalGetLower?(key: string, name: string): LVal | undefined;
  globalSet(name: string, value: LVal): void;
  go(frame: LVal): void;
  builtin(name: string, args: LVal[], interp: Interpreter): LVal | undefined;
  memberMethod(m: LMemberRef, name: string, args: LVal[]): LVal;
  spriteMethod(s: LSpriteRef, name: string, args: LVal[]): LVal;
  windowMethod(w: LWindowRef, name: string, args: LVal[]): LVal;
  rollover(): number;
  rolloverSprite?(n: number): boolean;
  setRollover(n: number): void;
  makeObject(script: Script): LObject;
  getObjectById(id: string): LObject | null;
  setObjectById(id: string, obj: LObject): void;
  removeObjectById(id: string): void;
  xtraInstance(name: string): LObject;
  xtraMethod?(obj: LObject, name: string, args: LVal[]): LVal;
  xmlParserMethod?(obj: LObject, name: string, args: LVal[]): LVal;
  soundChannelMethod?(obj: LObject, name: string, args: LVal[]): LVal;
  registerTimeout(obj: LObject, period: number, handler: string, target: LObject): void;
  forgetTimeout(obj: LObject): void;
  scheduleDelay?(obj: LObject, ms: number, handler: string, args: LVal[]): number;
  cancelDelay?(id: number): void;
}

const SPRITE_EVENT_NAMES = new Set([
  'mousedown', 'mouseup', 'mousemove', 'mouseenter', 'mouseleave', 'mousewithin', 'mouseupoutside',
  'keydown', 'keyup',
]);

export const NO_GLOBALS: ReadonlySet<string> = new Set();

const scriptPropsLowerCache = new WeakMap<Script, Set<string>>();
export function scriptPropsLower(script: Script): Set<string> {
  let s = scriptPropsLowerCache.get(script);
  if (!s) {
    s = new Set(script.props.map((p) => p.toLowerCase()));
    scriptPropsLowerCache.set(script, s);
  }
  return s;
}

const LINE_SEP_RE = /\r\n|\r|\n/g;

function countRegexRuns(s: string, re: RegExp): number {
  let n = 0;
  re.lastIndex = 0;
  for (;;) {
    const m = re.exec(s);
    if (!m) break;
    n++;
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  re.lastIndex = 0;
  return n;
}

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
  /** Fast-path local-name set for handler-local assignments (null when the
   *  handler runs with an instance or none was derived). */
  locals: Set<string> | null = null;
  private _vars: Map<string, LVal> | null = null;
  constructor(public parent: Env | null = null, public globals: Set<string> = new Set()) {}

  get(name: string): LVal | undefined {
    return this.getLower(name.toLowerCase());
  }

  getLower(key: string): LVal | undefined {
    let e: Env | null = this;
    while (e) {
      const v = e._vars?.get(key);
      if (v !== undefined) return v;
      e = e.parent;
    }
    return undefined;
  }

  set(name: string, value: LVal): void {
    this.setLower(name.toLowerCase(), value);
  }

  setLower(key: string, value: LVal): void {
    if (!this._vars) this._vars = new Map();
    this._vars.set(key, value === undefined ? VOID : value);
  }

  has(name: string): boolean {
    return this.hasLower(name.toLowerCase());
  }

  hasLower(key: string): boolean {
    if (this._vars?.has(key)) return true;
    if (this.parent) return this.parent.hasLower(key);
    return false;
  }
}

const MAX_LOOP_ITERATIONS = 2_000_000;
export const MAX_CALL_DEPTH = 2500;

export class Interpreter {
  currentScript: Script | null = null;
  curEnv: Env | null = null;
  private argStack: LVal[][] = [];
  private evalDepth = 0;
  private callDepth = 0;
  callTrail: string[] = [];
  private warnedUndefined = new Set<string>();
  private missingHandlerWarned = new Set<string>();
  private scriptGlobalsLower = new WeakMap<Script, Set<string>>();
  private globalsLowerOf(script: Script): Set<string> {
    let s = this.scriptGlobalsLower.get(script);
    if (!s) {
      s = new Set(script.globals.map((g) => g.toLowerCase()));
      this.scriptGlobalsLower.set(script, s);
    }
    return s;
  }

  private propsLowerOf(script: Script): Set<string> {
    return scriptPropsLower(script);
  }

  private identLowerCache = new WeakMap<Expr, string>();
  private identLowerOf(e: Expr): string {
    let s = this.identLowerCache.get(e);
    if (s === undefined) {
      if (e.kind === 'ident' || e.kind === 'prop') s = e.name.toLowerCase();
      else s = '';
      this.identLowerCache.set(e, s);
    }
    return s;
  }

  private handlerLocalsCache = new WeakMap<Handler, Set<string>>();
  private handlerLocalsOf(script: Script, handler: Handler): Set<string> {
    let s = this.handlerLocalsCache.get(handler);
    if (s) return s;
    s = new Set<string>();
    const props = this.propsLowerOf(script);
    const seen = new Set<string>();
    const note = (name: string): void => {
      const lower = name.toLowerCase();
      if (seen.has(lower)) return;
      seen.add(lower);
      if (!props.has(lower)) s.add(lower);
    };
    const walk = (stmts: Stmt[]): void => {
      for (const st of stmts) {
        switch (st.kind) {
          case 'assign':
            if (st.target.kind === 'ident') note(st.target.name);
            break;
          case 'put':
            if (st.into && st.into.kind === 'ident') note(st.into.name);
            break;
          case 'repeatWith':
          case 'repeatIn':
            note(st.varName);
            walk(st.body);
            break;
          case 'if':
            walk(st.then);
            walk(st.els);
            break;
          case 'case':
            for (const b of st.branches) walk(b.body);
            break;
          case 'repeatWhile':
            walk(st.body);
            break;
        }
      }
    };
    for (const p of handler.params) note(p);
    walk(handler.body);
    this.handlerLocalsCache.set(handler, s);
    return s;
  }

  constructor(public host: InterpreterHost) {}

  currentArgs(): LVal[] {
    return this.argStack.length > 0 ? this.argStack[this.argStack.length - 1] : [];
  }

  param(i: number): LVal {
    const args = this.currentArgs();
    return args[i - 1] ?? VOID;
  }


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
    this.floatEpoch++;
    this.floatNames.clear();
    this.callTrail.push(`#${handler.name}@${script.name}`);
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

  private jitCache = new WeakMap<Handler, { fn: Function; nodes: unknown[] } | null>();

  private jitCompiledOf(script: Script, handler: Handler): { fn: Function; nodes: unknown[] } | null {
    let entry = this.jitCache.get(handler);
    if (entry !== undefined) return entry;
    let result: { fn: Function; nodes: unknown[] } | null = null;
    const compiled = compileHandlerBody(handler, this.propsLowerOf(script));
    if (compiled) {
      try {
        result = {
          fn: new Function(
            'env', 'I', 'args', 'N', 'Ret', 'Exit', 'ExitR', 'NextR',
            'LList', 'LPropList', 'PropPairs', 'LSym', 'LEMPTY', 'VOID',
            'asNum', 'isTruthy', 'lingoEquals', 'lingoNegate',
            compiled.src,
          ),
          nodes: compiled.nodes,
        };
      } catch {
        result = null;
      }
    }
    this.jitCache.set(handler, result);
    return result;
  }

  private handlerParamsPropCollide(script: Script, handler: Handler): boolean {
    const props = this.propsLowerOf(script);
    for (const p of handler.params) {
      const lower = p.toLowerCase();
      if (lower !== 'me' && props.has(lower)) return true;
    }
    return false;
  }

  private callHandlerInner(
    script: Script,
    handler: Handler,
    args: LVal[],
    instance: LObject | null,
    scriptGlobals: ReadonlySet<string>,
  ): LVal {
    const prevScript = this.currentScript;
    this.currentScript = script;
    const baseGlobals = this.globalsLowerOf(script);
    const env = new Env(null, scriptGlobals && scriptGlobals.size > 0 ? new Set([...baseGlobals, ...scriptGlobals]) : baseGlobals);
    env.me = instance;
    const compiled = this.jitCompiledOf(script, handler);
    let offset = 0;
    if (instance && handler.params.length > 0 && handler.params[0].toLowerCase() === 'me') offset = 1;
    // Compiled bodies read their locals from V slots; only interpreter bodies
    // (and compiled ones whose params collide with script props, which never
    // get V slots) need params mirrored into env.vars.
    if (!compiled || this.handlerParamsPropCollide(script, handler)) {
      if (instance && offset === 1) env.setLower('me', instance);
      for (let i = offset; i < handler.params.length; i++) {
        env.setLower(handler.params[i].toLowerCase(), args[i - offset] ?? VOID);
      }
      if (instance && offset === 0) env.setLower('me', instance);
    }
    if (!compiled) {
      if (!instance) env.locals = this.handlerLocalsOf(script, handler);
      if (!env.me && handler.params[0]?.toLowerCase() === 'me') {
        const m = env.getLower('me');
        if (m instanceof LObjectClass) env.me = m;
      }
    }
    this.argStack.push(args);
    try {
      if (compiled) {
        const r = compiled.fn(
          env, this, args, compiled.nodes,
          ReturnSignal, ExitSignal, ExitRepeatSignal, NextRepeatSignal,
          LListClass, LPropListClass, PropPairsClass, LSymbol, LEMPTY, VOID,
          asNum, isTruthy, lingoEquals, lingoNegate,
        );
        return r === undefined ? VOID : r;
      }
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

  makeInstance(script: Script, id = ''): LObject {
    const handlers = new Map<string, Handler>();
    for (const h of script.handlers) handlers.set(h.name.toLowerCase(), h);
    return new LObjectClass(script.name, script, handlers, new Map(), id);
  }

  newInstance(script: Script, args: LVal[]): LObject {
    const obj = this.makeInstance(script);
    const hNew = obj.handlers.get('new');
    if (hNew) this.callHandler(script, hNew, args, obj, NO_GLOBALS);
    return obj;
  }

  callBuiltin(args: LVal[]): LVal {
    const handlerName = this.handlerNameOf(args[0]);
    if (handlerName === undefined) {
      if (args[0] === null || args[0] === undefined) return VOID;
      this.host.warn(`call(): invalid handler ${toLingoString(args[0])}`);
      return VOID;
    }
    const target = args[1] ?? VOID;
    const rest = args.slice(2);
    const targets: LVal[] =
      target instanceof LListClass ? target.items :
      target instanceof LPropListClass ? [...target.props.values()] :
      [target];
    let last: LVal = VOID;
    for (const t of targets) {
      if (t instanceof LObjectClass) last = this.callObjectHandler(t, handlerName, rest);
      else if (t instanceof LSpriteRefClass) {
        last = this.host.spriteMethod(t, handlerName, rest);
      } else if (t instanceof LListClass || t instanceof LPropListClass) last = this.callBuiltin([args[0], t, ...rest]);
      else if (t !== null) {
        this.host.warn(`call(#${handlerName}, ${toLingoString(t)}): target is not an object`);
        last = VOID;
      }
    }
    return last;
  }

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

  private propChainStart(me: LObject | null): LObject | null {
    const want = this.currentScript;
    if (!want || !me) return null;
    let cur: LObject | null = me;
    let hops = 0;
    while (cur && cur.script) {
      if (cur.script === want) return cur;
      if (++hops > 32) return null;
      const anc = cur.props.get('ancestor');
      cur = anc instanceof LObjectClass ? anc : null;
    }
    return null;
  }

  private instancePropOwnerLower(env: Env, _name: string, lower: string): LObject | null {
    let cur: LObject | null = this.propChainStart(env.me) ?? env.me;
    let hops = 0;
    while (cur && cur.script) {
      if (this.propsLowerOf(cur.script).has(lower)) return cur;
      if (++hops > 32) return null;
      const anc = cur.props.get('ancestor');
      cur = anc instanceof LObjectClass ? anc : null;
    }
    return null;
  }

  private handlerNameOf(v: LVal): string | undefined {
    if (v instanceof LSymbol) return v.name;
    if (typeof v === 'string') return v;
    return undefined;
  }

  callObjectHandler(obj: LObject, name: string, args: LVal[]): LVal {
    const found = this.findHandler(obj, name);
    if (found) {
      return this.callHandler(found.script, found.handler, args, obj, NO_GLOBALS);
    }
    const lower = name.toLowerCase();
    if (lower === 'get' || lower === 'getaprop' || lower === 'getproperty') {
      return obj.props.get(keyOf(args[0]) ?? '') ?? VOID;
    }
    if (lower === 'set' || lower === 'setaprop' || lower === 'setproperty') {
      const key = keyOf(args[0]);
      if (key !== undefined) {
        const value = args[1] ?? VOID;
        if (key === 'ancestor' && (value === null || value === undefined)) {
          if (!(obj.props.get('ancestor') instanceof LObjectClass)) obj.props.set(key, value);
        } else obj.props.set(key, value);
      }
      return VOID;
    }
    if (lower === 'getid') return obj.id;
    if (lower === 'handler') {
      return this.findHandler(obj, keyOf(args[0]) ?? '') ? 1 : 0;
    }
    if (SPRITE_EVENT_NAMES.has(lower)) return VOID;
    if (obj.lenient) return VOID;
    const warnKey = `${obj.scriptName ?? '?'}:${lower}`;
    if (this.missingHandlerWarned.has(warnKey)) return VOID;
    this.missingHandlerWarned.add(warnKey);
    this.host.warn(`object(${obj.scriptName}) has no handler #${name}`);
    return VOID;
  }


  execBody(stmts: Stmt[], env: Env): void {
    for (const stmt of stmts) {
      this.floatEpoch++;
      this.execStmt(stmt, env);
    }
  }

  private lastAssignExpr: Expr | null = null;

  private exprSrc(e: Expr): string {
    switch (e.kind) {
      case 'ident': return e.name;
      case 'prop': return `${this.exprSrc(e.obj)}.${e.name}`;
      case 'index': return `${this.exprSrc(e.obj)}[${this.exprSrc(e.index)}]`;
      case 'num': return String(e.value);
      case 'str': return JSON.stringify(e.value);
      case 'symbol': return `#${e.name}`;
      default: return e.kind;
    }
  }

  execStmt(stmt: Stmt, env: Env): void {
    switch (stmt.kind) {
      case 'assign': {
        const v = this.evalExpr(stmt.value, env);
        this.noteFloatAssign(stmt.target, stmt.value);
        this.lastAssignExpr = stmt.target;
        this.execAssign(stmt.target, v, env);
        return;
      }
      case 'put':
        if (stmt.into) {
          if (stmt.mode === 'after' || stmt.mode === 'before') {
            const cur = this.evalExpr(stmt.into, env);
            const val = this.evalExpr(stmt.value, env);
            if (stmt.mode === 'after' && cur instanceof LListClass) {
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
          if (!(out.startsWith('Error:') && out.includes('Writer already exists'))) this.host.log(out);
        }
        return;
      case 'delete':
        this.execDelete(stmt.target, env);
        return;
      case 'if': {
        const branch = isTruthy(this.evalExpr(stmt.cond, env)) ? stmt.then : stmt.els;
        this.execBody(branch, env);
        return;
      }
      case 'case': {
        const subject = this.evalExpr(stmt.subject, env);
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
        env.setLower(key, from);
        let iter = 0;
        while (true) {
          const i = asNum(env.getLower(key) ?? 0);
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
              env.setLower(key, asNum(env.getLower(key) ?? 0) + step);
              continue;
            }
            throw e;
          }
          env.setLower(key, asNum(env.getLower(key) ?? 0) + step);
        }
        return;
      }
      case 'repeatIn': {
        const list = this.evalExpr(stmt.list, env);
        const items =
          list instanceof LListClass ? list.items :
          list instanceof LPropListClass ? [...list.props.values()] :
          [];
        let iter = 0;
        for (const item of items) {
          if (++iter > MAX_LOOP_ITERATIONS) break;
          env.setLower(stmt.varName.toLowerCase(), item);
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

  private execDelete(target: Expr, env: Env): void {
    if (target.kind === 'chunk') {
      const base = this.evalExpr(target.obj, env);
      if (typeof base === 'string') {
        const parts = this.chunkParts(base, target.chunk);
        if (parts !== null) {
          const n = parts.length;
          const rawFrom = target.from !== undefined ? Math.round(asNum(this.evalExpr(target.from, env))) : 1;
          const rawTo = target.to !== undefined ? Math.round(asNum(this.evalExpr(target.to, env))) : rawFrom;
          if (rawFrom <= -30000) {
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
      }
    } else {
      this.host.warn(`delete unsupported on ${target.kind} target`);
    }
  }

  private floatMarks = new Map<number, number>();

  floatEpoch = 0;

  private floatNames = new Map<string, boolean>();

  private objectFloatProps = new WeakMap<LObject, Set<string>>();

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

  markFloatValue(v: LVal): LVal {
    if (typeof v === 'number' && Number.isInteger(v)) this.floatMarks.set(v, this.floatEpoch);
    return v;
  }

  isFloatValue(v: LVal): boolean {
    return typeof v === 'number' && (!Number.isInteger(v) || this.floatMarks.get(v) === this.floatEpoch);
  }

  private noteFloatAssign(target: Expr, rhs: Expr): void {
    const name = target.kind === 'ident' || target.kind === 'prop' ? this.identLowerOf(target) : null;
    if (name) this.floatNames.set(name, this.isFloatExpr(rhs));
  }

  private floatExprCache = new WeakMap<Expr, boolean>();

  private isFloatExpr(e: Expr): boolean {
    const cached = this.floatExprCache.get(e);
    if (cached !== undefined) return cached;
    let r: boolean;
    switch (e.kind) {
      case 'num':
        r = !!e.float;
        break;
      case 'call':
        r = e.callee.kind === 'ident' && e.callee.name.toLowerCase() === 'float';
        break;
      case 'binary':
        r = this.isFloatExpr(e.left) || this.isFloatExpr(e.right);
        break;
      case 'unary':
        r = e.op === '-' || e.op === '+' ? this.isFloatExpr(e.arg) : false;
        break;
      default:
        r = false;
    }
    this.floatExprCache.set(e, r);
    return r;
  }

  private exprIsFloatName(e: Expr): boolean {
    if (e.kind === 'ident' || e.kind === 'prop') {
      return this.floatNames.get(this.identLowerOf(e)) ?? false;
    }
    return false;
  }

  private isFloatArith(l: LVal, r: LVal, leftE: Expr, rightE: Expr): boolean {
    return (
      this.isFloatValue(l) ||
      this.isFloatValue(r) ||
      this.exprIsFloatName(leftE) ||
      this.exprIsFloatName(rightE)
    );
  }

  markNum(v: number, isFloat: boolean): LVal {
    if (typeof v === 'number' && Number.isInteger(v)) {
      if (isFloat) this.floatMarks.set(v, this.floatEpoch);
      else this.floatMarks.delete(v);
    }
    return v;
  }

  noteFloatAssign2(target: Expr, rhs: Expr): void {
    this.noteFloatAssign(target, rhs);
  }

  notePropFloat2(obj: LVal, name: string, value: LVal): void {
    if (obj instanceof LObjectClass) this.notePropFloat(obj, name, this.isFloatValue(value));
  }

  notePropFloat3(obj: LVal, name: string, value: LVal, staticFloat: boolean): void {
    if (obj instanceof LObjectClass) this.notePropFloat(obj, name, staticFloat || this.isFloatValue(value));
  }

  noteFloatAssign3(name: string, staticFloat: boolean): void {
    this.floatNames.set(name, !!staticFloat);
  }

  floatNameIs(name: string): boolean {
    return this.floatNames.get(name) ?? false;
  }

  evalIdentFull(expr: { kind: 'ident'; name: string }, env: Env): LVal {
    return this.evalIdent(expr, env);
  }

  listItemsOf(list: LVal): LVal[] {
    return list instanceof LListClass
      ? list.items
      : list instanceof LPropListClass
        ? [...list.props.values()]
        : [];
  }

  indexGet(obj: LVal, index: LVal): LVal {
    return this.getIndexValue(obj, index);
  }

  indexSet(obj: LVal, index: LVal, value: LVal): void {
    this.setIndexValue(obj, index, value);
  }

  invokePropCallee(obj: LVal, name: string, argVals: LVal[]): LVal {
    return this.dispatchMethod(obj, name, argVals);
  }

  invokeIdentCallee(lower: string, name: string, argVals: LVal[], env: Env): LVal {
    if (lower === 'call') return this.callBuiltin(argVals);
    const global = lower === 'new' ? null : this.host.resolveGlobalHandler(name);
    if (global) {
      const selfCall = global.script === this.currentScript;
      let instance: LObject | null = null;
      if (selfCall) {
        const first = argVals[0];
        if (first instanceof LObjectClass && this.findHandler(first, name) !== null) {
          instance = first;
          argVals = argVals.slice(1);
        } else if (env.me instanceof LObjectClass) {
          instance = env.me;
        }
      }
      return this.callHandler(global.script, global.handler, argVals, instance, NO_GLOBALS);
    }
    const b = this.host.builtin(name, argVals, this);
    if (b !== undefined) return b;
    this.host.warn(`unresolved handler/builtin: ${name}`);
    return VOID;
  }

  execAssignNode(target: Expr, value: LVal, env: Env): void {
    this.execAssign(target, value, env);
  }

  clearFloatMark(v: LVal): LVal {
    if (typeof v === 'number') this.floatMarks.delete(v);
    return v;
  }

  private execAssign(target: Expr, value: LVal, env: Env): void {
    switch (target.kind) {
      case 'ident': {
        const name = target.name;
        const lower = this.identLowerOf(target);
        if (lower === 'me') {
          this.host.warn('cannot assign to me');
          return;
        }
        if (env.globals.has(lower)) {
          this.host.globalSet(name, value);
          return;
        }
        // With no instance the prop-owner walk always fails, so a known
        // handler-local assignment is exactly env.set without the walk.
        if (!env.me && env.locals && env.locals.has(lower)) {
          env.setLower(lower, value);
          return;
        }
        const owner = this.instancePropOwnerLower(env, name, lower);
        if (owner) {
          owner.props.set(name, value);
          this.notePropFloat(owner, name, this.isFloatValue(value));
        } else {
          env.set(name, value);
        }
        return;
      }
      case 'prop': {
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
        if (expr.float) this.markFloatValue(expr.value);
        else this.floatMarks.delete(expr.value);
        return expr.value;
      case 'str':
        return expr.value;
      case 'symbol':
        return new LSymbol(expr.name);
      case 'ident':
        return this.evalIdent(expr, env);
      case 'list':
        return new LListClass(expr.items.map((i) => this.evalExpr(i, env)));
      case 'proplist': {
        const props = new PropPairsClass();
        for (const [k, v] of expr.pairs) {
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

  private evalIdent(expr: { kind: 'ident'; name: string }, env: Env): LVal {
    const name = expr.name;
    const lower = this.identLowerOf(expr);
    switch (lower) {
      case 'me': return env.me ?? VOID;
      case 'empty': return LEMPTY;
      case 'void': return VOID;
      case 'true': return 1;
      case 'false': return 0;
      case 'pi': return Math.PI;
      case 'return': return '\r';
      case 'tab': return '\t';
      case 'enter': return '\x03';
      case 'space': return ' ';
      case 'quote': return '"';
    }
    const local = env.getLower(lower);
    if (local !== undefined) return local;
    const global = this.host.globalGetLower ? this.host.globalGetLower(lower, name) : this.host.globalGet(name);
    if (global !== undefined) return global;
    const prop = this.instancePropOfLower(env, name, lower);
    if (prop !== undefined) return prop;
    if (env.globals.has(lower)) return VOID;
    if (!this.warnedUndefined.has(lower)) {
      this.warnedUndefined.add(lower);
      this.host?.log?.(`note: undeclared identifier read as VOID (once): ${name}`);
    }
    return VOID;
  }

  private instancePropOf(env: Env, name: string): LVal | undefined {
    return this.instancePropOfLower(env, name, name.toLowerCase());
  }

  private instancePropOfLower(env: Env, name: string, lower: string): LVal | undefined {
    let cur: LObject | null = this.propChainStart(env.me) ?? env.me;
    let hops = 0;
    while (cur && cur.script) {
      if (this.propsLowerOf(cur.script).has(lower)) {
        const v =
          cur.props.has(name) ? cur.props.get(name) : cur.props.has(lower) ? cur.props.get(lower) : undefined;
        if (v === undefined) return VOID;
        if (this.objectFloatProps.get(cur)?.has(lower)) return this.markFloatValue(v);
        return v;
      }
      if (++hops > 32) return undefined;
      const anc = cur.props.get('ancestor');
      cur = anc instanceof LObjectClass ? anc : null;
    }
    return undefined;
  }

  private evalBinary(op: string, leftE: Expr, rightE: Expr, env: Env): LVal {
    const l = this.evalExpr(leftE, env);
    const r = this.evalExpr(rightE, env);
    return this.binaryOp(op, l, r, leftE, rightE);
  }

  binaryOp(op: string, l: LVal, r: LVal, leftE: Expr, rightE: Expr): LVal {
    return this.binaryOpCore(op, l, r, this.isFloatArith(l, r, leftE, rightE));
  }

  binaryOpF(op: string, l: LVal, r: LVal, fL: boolean | number, fR: boolean | number): LVal {
    return this.binaryOpCore(op, l, r, !!(fL || fR));
  }

  private binaryOpCore(op: string, l: LVal, r: LVal, floatArith: boolean): LVal {
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
        if (typeof l === 'number' && typeof r === 'number') {
          const out = l + r;
          return floatArith ? this.markFloatValue(out) : out;
        }
        const out = lingoAdd(l, r) ?? asNum(l) + asNum(r);
        return floatArith ? this.markFloatValue(out) : out;
      }
      case '-': {
        if (typeof l === 'number' && typeof r === 'number') {
          const out = l - r;
          return floatArith ? this.markFloatValue(out) : out;
        }
        const out = lingoSubtract(l, r) ?? asNum(l) - asNum(r);
        return floatArith ? this.markFloatValue(out) : out;
      }
      case '*': {
        if (typeof l === 'number' && typeof r === 'number') {
          const out = l * r;
          return floatArith ? this.markFloatValue(out) : out;
        }
        const mulOut = lingoMultiply(l, r) ?? asNum(l) * asNum(r);
        return floatArith ? this.markFloatValue(mulOut) : mulOut;
      }
      case '/': {
        if (l === VOID || r === VOID) return 0;
        const a = asNum(l);
        const b = asNum(r);
        const divisor = b === 0 ? 1 : b;
        const out = floatArith ? a / divisor : Math.trunc(a / divisor);
        return floatArith ? this.markFloatValue(out) : out;
      }
      case 'mod':
      case 'div': {
        if (op === 'mod') {
          const modOut = lingoMod(l, r);
          if (modOut !== null) return modOut;
          if (l === VOID || r === VOID) return 0;
          const b = asNum(r);
          const out = b === 0 ? 0 : asNum(l) % b;
          return floatArith ? this.markFloatValue(out) : out;
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

  private compareLingo(a: LVal, b: LVal): number {
    const aNull = a === null;
    const bNull = b === null;
    const na = Number(a);
    const nb = Number(b);
    const aNum = typeof a === 'number' || aNull || (typeof a === 'string' && a !== '' && Number.isFinite(na));
    const bNum = typeof b === 'number' || bNull || (typeof b === 'string' && b !== '' && Number.isFinite(nb));
    if (aNum && bNum) return na - nb;
    const strOf = (v: LVal): string => (v instanceof LSymbol ? v.name : toLingoString(v));
    const sa = strOf(a);
    const sb = strOf(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  }

  private evalCall(call: Extract<Expr, { kind: 'call' }>, env: Env): LVal {
    let args = call.args.map((a) => this.evalExpr(a, env));
    const callee = call.callee;

    if (callee.kind === 'ident') {
      const name = callee.name;
      const lower = name.toLowerCase();
      if (lower === 'call') return this.callBuiltin(args);
      const global = lower === 'new' ? null : this.host.resolveGlobalHandler(name);
      if (global) {
        const selfCall = global.script === this.currentScript;
        let instance: LObject | null = null;
        if (selfCall) {
          const first = args[0];
          if (first instanceof LObjectClass && this.findHandler(first, name) !== null) {
            instance = first;
            args = args.slice(1);
          } else if (env.me instanceof LObjectClass) {
            instance = env.me;
          }
        }
        return this.callHandler(global.script, global.handler, args, instance, NO_GLOBALS);
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
      if (lower === 'newjavascriptproxy') return this.host.xtraInstance('JavaScriptProxy');
      this.host.warn(`script(${obj.script.name}).${name}(): unsupported`);
      return VOID;
    }
    if (obj instanceof LObjectClass && obj.scriptName.startsWith('xtra:')) {
      const lower = name.toLowerCase();
      if (lower === 'new' || lower === 'construct') {
        const name = obj.props.get('name') ?? obj.scriptName.slice(5);
        return this.host.xtraInstance(toLingoString(name));
      }
      if (['setnetbufferlimits', 'setnetmessagehandler', 'connecttonetserver', 'sendnetmessage', 'closenetconnection', 'disconnect', 'flushnetmessages', 'isconnected', 'getnumberwaitingnetmessages', 'checknetmessages', 'getnetmessage'].includes(lower)) {
        if (this.host.xtraMethod) return this.host.xtraMethod(obj, name, args);
        return 0;
      }
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
      const pl = name.toLowerCase();
      if (pl === 'inside') {
        const r = args[0];
        if (r instanceof LRectClass) {
          return obj.locH >= r.left && obj.locH < r.right && obj.locV >= r.top && obj.locV < r.bottom ? 1 : 0;
        }
        return 0;
      }
      if (pl === 'duplicate') return duplicateValue(obj);
      return VOID;
    }
    if (name.toLowerCase() === 'duplicate') return duplicateValue(obj);
    if (obj === null || obj === undefined || obj instanceof LEmptyValue) return VOID;
    this.host.warn(`method ${name} called on ${toLingoString(obj)} (unsupported)`);
    return VOID;
  }


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
        return 0;
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
        if (key !== undefined) (pl.props as PropPairsClass).append(key, args[1] ?? VOID);
        return VOID;
      case 'setprop':
      case 'setaprop':
        if (key !== undefined) pl.props.set(key, args[1] ?? VOID);
        return VOID;
      case 'getprop':
      case 'getaprop':
        return this.propGet(pl, key) ?? VOID;
      case 'getpropat': {
        const i = Math.round(asNum(args[0]));
        const keys = [...pl.props.keys()];
        return i >= 1 && i <= keys.length ? rawKeyOf(keys[i - 1]) : VOID;
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
        const values = [...pl.props.values()];
        return values.length > 0 ? values[values.length - 1] : VOID;
      }
      case 'setat': {
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
        return pl.props.size;
      case 'getone': {
        for (const [k, v] of pl.props) {
          if (lingoEquals(v, args[0] ?? VOID)) return rawKeyOf(k);
        }
        return 0;
      }
      case 'getpos': {
        const values = [...pl.props.values()];
        const target = args[0] ?? VOID;
        for (let i = 0; i < values.length; i++) {
          if (lingoEquals(values[i], target)) return i + 1;
        }
        return 0;
      }
      case 'findpos': {
        const k = keyOf(args[0]);
        const keys = [...pl.props.keys()];
        for (let i = 0; i < keys.length; i++) {
          if (k !== undefined && keys[i] === k) return i + 1;
          if (lingoEquals(keys[i], args[0] ?? VOID)) return i + 1;
        }
        return VOID;
      }
      case 'sort':
        return VOID;
      default:
        this.host.warn(`propList method ${name} not implemented`);
        return VOID;
    }
  }


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
      const firstIsPoint = args[0] instanceof LPointClass;
      const pt = firstIsPoint ? (args[0] as LPointClass) : null;
      const h = Math.round(pt ? pt.locH : asNum(args[0]));
      const v = Math.round(pt ? pt.locV : asNum(args[1]));
      const flag = firstIsPoint ? args[1] : args[2];
      const returnInteger =
        flag instanceof LSymbol ? flag.name.toLowerCase() === 'integer' : toLingoString(flag ?? '').toLowerCase() === 'integer';
      const w = Math.round(img.width);
      const hh = Math.round(img.height);
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
      return this.imageTrimWhiteSpace(img);
    }
    if (lower === 'copypixels') {
      const srcArg = args[0];
      const src = srcArg instanceof LImageClass ? this.readStageImage(srcArg) : srcArg;
      if (src instanceof LImageClass && args[2] instanceof LRectClass) {
        const params = args.find((a) => a instanceof LPropListClass) as LPropListClass | undefined;
        const ink = params ? Math.round(asNum(params.props.get('ink') ?? 0)) : 0;
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
    if (lower === 'createmask') {
      const w = Math.max(0, Math.round(img.width));
      const h = Math.max(0, Math.round(img.height));
      const mask = new LImageClass(w, h);
      const m = mask.ensure();
      const s = img.ensure();
      for (let i = 0; i < w * h; i++) {
        const o = i * 4;
        const luma = (s[o] * 299 + s[o + 1] * 587 + s[o + 2] * 114) / 1000;
        m[o] = 255;
        m[o + 1] = 255;
        m[o + 2] = 255;
        m[o + 3] = luma < 128 ? 255 : 0;
      }
      mask.dirty = true;
      return mask;
    }
    if (lower === 'creatematte') {
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
        const thresh = args[0] !== undefined ? Math.round(asNum(args[0])) : 0;
        for (let i = 0; i < w * h; i++) {
          m[i * 4 + 3] = s[i * 4 + 3] > thresh ? 255 : 0;
        }
      } else {
        const flood = matteRegionMask(s, w, h, 0, 0, w, h, img.palette, img.indices);
        if (flood) {
          for (let i = 0; i < w * h; i++) m[i * 4 + 3] = flood[i] === 1 ? 0 : 255;
        } else {
          for (let i = 0; i < w * h; i++) m[i * 4 + 3] = 255;
        }
      }
      mask.dirty = true;
      return mask;
    }
    if (['copy', 'scale', 'flip', 'fliph', 'flipv', 'rotate'].includes(lower)) return img;
    this.host.warn(`image method ${name} is a no-op stub`);
    return img;
  }

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
          (edgeTotal > 0 && edgeWhite * 4 >= edgeTotal * 3) ||
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
    const level = Math.max(0, Math.min(255, Math.round(asNum(first))));
    const d = img.ensure();
    img.dirty = true;
    for (let i = 3; i < w * h * 4; i += 4) d[i] = level;
    img.useAlpha = true;
    return 1;
  }

  private colorMethod(c: LColorClass, name: string, _args: LVal[]): LVal {
    const lower = name.toLowerCase();
    if (lower === 'duplicate') return duplicateValue(c);
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


  getPropValue(obj: LVal, name: string): LVal {
    const lower = name.toLowerCase();
    if (obj === null || obj instanceof LEmptyValue) {
      if (lower === 'ilk') return ilkOf(obj);
      return VOID;
    }
    if (typeof obj === 'string') {
      if (lower === 'length') return obj.length;
      if (lower === 'ilk') return ilkOf(obj);
      if (lower === 'integer') {
        const m = /^[+-]?\d+/.exec(obj.trim());
        return m ? parseInt(m[0], 10) : VOID;
      }
      if (lower === 'float') {
        const m = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(obj.trim());
        return m ? Number(m[0]) : VOID;
      }
      return VOID;
    }
    if (typeof obj === 'number') {
      if (lower === 'ilk') return ilkOf(obj);
      if (lower === 'integer') return Math.trunc(obj);
      if (lower === 'float') return obj;
      return VOID;
    }
    if (obj instanceof LSymbol) {
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
        const stored = obj.props.get('ilk');
        return stored !== undefined ? stored : ilkOf(obj);
      }
      const lHit = this.propGet(obj, lower);
      if (lHit !== undefined) return lHit;
      return this.propGet(obj, name) ?? VOID;
    }
    if (obj instanceof LObjectClass) {
      if (lower === 'ilk') return ilkOf(obj);
      let cur: LObjectClass | null = obj;
      let hops = 0;
      while (cur) {
        if (cur.script && this.propsLowerOf(cur.script).has(lower)) {
          const v =
            cur.props.has(name) ? cur.props.get(name) : cur.props.has(lower) ? cur.props.get(lower) : undefined;
          if (v === undefined) return VOID;
          if (this.objectFloatProps.get(cur)?.has(lower)) return this.markFloatValue(v);
          return v;
        }
        if (++hops > 32) break;
        const anc = cur.props.get('ancestor');
        cur = anc instanceof LObjectClass ? anc : null;
      }
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
  }  setPropValue(obj: LVal, name: string, value: LVal): void {
    const lower = name.toLowerCase();
    if (obj === null || obj instanceof LEmptyValue) {
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
      if (lower === 'paletteref') {
        obj.paletteRef = value;
        const target = this.host.resolvePaletteTable(value);
        if (target) {
          if (obj.indices && obj.indices.length >= Math.max(0, Math.round(obj.width)) * Math.max(0, Math.round(obj.height))) {
            obj.remapPaletteByIndices(obj.indices, target);
          } else {
            obj.remapPalette(target);
          }
          if (!obj.palette) obj.palette = target;
        }
        return;
      }
      if (lower === 'usealpha') {
        obj.useAlpha = isTruthy(value);
        return;
      }
      this.host.warn(`cannot set ${name} on ${toLingoString(obj)}`);
      return;
    }
    if (obj instanceof LStageRefClass) {
      if (lower === 'title') return;
      this.host.warn(`cannot set ${name} on ${toLingoString(obj)}`);
      return;
    }
    this.host.warn(`cannot set ${name} on ${toLingoString(obj)}`);
  }

  private propGet(pl: LPropList, key: string | undefined): LVal | undefined {
    if (key === undefined) return undefined;
    const direct = pl.props.get(key);
    if (direct !== undefined) return direct;
    const variants: string[] = [];
    if (key.includes(' ')) variants.push(key.replaceAll(' ', '_'));
    if (key.includes('_')) variants.push(key.replaceAll('_', ' '));
    if (key.includes(' ') && key.includes('_')) variants.push(key.replaceAll(' ', '_').replaceAll('_', ' '));
    for (const variant of variants) {
      const v = pl.props.get(variant);
      if (v !== undefined) return v;
    }
    if (key === 'marginH' || key === 'marginV' || key === 'marginbottom') {
      const lower = key.toLowerCase();
      for (const [k, v] of pl.props) {
        if (k.toLowerCase() === lower) return v;
      }
    }
    return undefined;
  }

  getIndexValue(obj: LVal, index: LVal): LVal {
    if (obj instanceof LListClass) {
      const i = Math.round(asNum(index));
      return obj.items[i - 1] ?? VOID;
    }
    if (obj instanceof LPropListClass) {
      const numeric =
        typeof index === 'number' ||
        (index !== null && typeof index === 'object' && ilkOf(index).name === 'integer');
      if (!numeric) {
        const key = keyOf(index);
        const hit = this.propGet(obj, key);
        if (hit !== undefined) return hit;
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

  setIndexValue(obj: LVal, index: LVal, value: LVal): void {
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
        const i = Math.round(asNum(index));
        if (i >= 1 && i <= obj.props.size) obj.setAt(i, value);
        return;
      }
      const key = keyOf(index);
      if (key !== undefined) obj.props.set(key, value);
      return;
    }
    if (obj instanceof LRectClass) {
      const i = Math.round(asNum(index));
      if (i === 1) obj.left = asNum(value);
      else if (i === 2) obj.top = asNum(value);
      else if (i === 3) obj.right = asNum(value);
      else if (i === 4) obj.bottom = asNum(value);
      return;
    }
    if (obj instanceof LPointClass) {
      const i = Math.round(asNum(index));
      if (i === 1) obj.locH = asNum(value);
      else if (i === 2) obj.locV = asNum(value);
      return;
    }
    if (obj instanceof LObjectClass) {
      const key = keyOf(index);
      if (key !== undefined) {
        if (key === 'ancestor' && (value === null || value === undefined)) {
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
    this.host.warn(`cannot index-assign on ${toLingoString(obj)} (${this.lastAssignExpr ? this.exprSrc(this.lastAssignExpr) : ''}) [${this.callTrail.slice(-4).join(' <- ')}]`);
  }


  private chunkParts(obj: LVal, chunk: string): string[] | null {
    let str: string | null = typeof obj === 'string' ? obj : null;
    if (str === null) {
      if (chunk === 'item' && obj instanceof LListClass) return obj.items.map(toLingoString);
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
        return str.split(/[\s\x00-\x1f\x7f]+/).filter((w) => w.length > 0);
      case 'line':
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
    const rawStart = from ?? 1;
    const rawEnd = to ?? rawStart;
    if (rawStart <= -30000) return parts[parts.length - 1] ?? '';
    const start = rawStart < 0 ? parts.length + rawStart + 1 : rawStart;
    const end = rawEnd < 0 ? parts.length + rawEnd + 1 : rawEnd;
    if (start < 1 || start > parts.length || start > end) return '';
    const slice = parts.slice(start - 1, Math.min(parts.length, end));
    if (start === end) return slice[0];
    const sep = chunk === 'char' ? '' : chunk === 'word' ? ' ' : chunk === 'line' || chunk === 'paragraph' ? '\r' : this.host.itemDelimiter();
    return slice.join(sep);
  }

  private chunkJoin(parts: string[], chunk: string): string {
    const sep =
      chunk === 'char' ? '' : chunk === 'word' ? ' ' : chunk === 'line' || chunk === 'paragraph' ? '\r' : this.host.itemDelimiter();
    return parts.join(sep);
  }

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
    if (rawStart <= -30000) {
      if (parts.length === 0) return null;
      parts.splice(parts.length - 1, 1, toLingoString(value));
      return this.chunkJoin(parts, chunk);
    }
    const start = rawStart < 0 ? parts.length + rawStart + 1 : rawStart;
    const end = rawEnd < 0 ? parts.length + rawEnd + 1 : rawEnd;
    if (start < 1 || start > parts.length || start > end) return null;
    const replacement = toLingoString(value);
    const slice = chunk === 'char' ? replacement.split('') : [replacement];
    parts.splice(start - 1, end - start + 1, ...slice);
    return this.chunkJoin(parts, chunk);
  }

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
        return 1 + countRegexRuns(str, LINE_SEP_RE);
      case 'item': {
        const delim = this.host.itemDelimiter();
        return delim ? countSubstringRuns(str, delim) : 0;
      }
      default:
        return 0;
    }
  }

  evalExpressionString(src: string): LVal {
    try {
      const expr = parseExpr(src);
      if (expr.kind === 'ident') return expr.name;
      const env = new Env();
      return this.evalExpr(expr, env);
    } catch (e) {
      return src;
    }
  }
}
