import type { Expr, Handler, Stmt } from './ast.js';

const MAX_DEPTH = 120;
const MAX_SIZE = 30000;
const MAX_LOOP = 2000000;

function j(v: string): string {
  return JSON.stringify(v);
}

function staticIsFloat(e: Expr): boolean {
  switch (e.kind) {
    case 'num':
      return !!e.float;
    case 'call':
      return e.callee.kind === 'ident' && e.callee.name.toLowerCase() === 'float';
    case 'binary':
      return staticIsFloat(e.left) || staticIsFloat(e.right);
    case 'unary':
      return e.op === '-' || e.op === '+' ? staticIsFloat(e.arg) : false;
    default:
      return false;
  }
}

const IDENT_KEYWORDS = new Set([
  'me', 'empty', 'void', 'true', 'false', 'pi', 'return', 'tab', 'enter', 'space', 'quote',
]);

export interface CompiledBody {
  src: string;
  nodes: unknown[];
}

/** Transpile a handler body into the source of a JS function plus its AST
 *  node table, or null when the handler touches anything the generator
 *  cannot express exactly (the interpreter then runs it). propsLower must be
 *  the script's declared prop names (lower-cased): names that collide with
 *  props are never treated as handler locals, matching the interpreter's own
 *  handler-locals resolution.
 *
 *  The emitted function is called with these parameters in scope:
 *    env, I, args, N, Ret, Exit, ExitR, NextR,
 *    LList, LPropList, PropPairs, LSym, LEMPTY, VOID, asNum, isTruthy,
 *    lingoEquals, lingoNegate
 *  It declares V (value slots) + B (slot-set flags) for handler locals.
 *
 *  Semantics deliberately mirror the interpreter statement-for-statement:
 *    - floatEpoch ticks before each statement — including, per iteration,
 *      for every statement inside loop bodies.
 *    - number literals mark/clear float marks via I.markNum, arithmetic
 *      float-tracking via I.binaryOp, float-name bookkeeping per assignment
 *      via I.noteFloatAssign2.
 *    - return/exit/exitRepeat/nextRepeat throw the same signal classes.
 *    - identifiers that are not handler locals fall through to
 *      I.evalIdentFull(node, env) — identical keyword/global/prop logic.
 *    - calls evaluate their arguments inline and dispatch via
 *      I.invokeIdentCallee / I.invokePropCallee, so no interpreter env reads
 *      occur outside the fallthrough paths above.
 *    - Handlers containing put/delete/globalDecl/the/chunk/chunkCount or
 *      non-embeddable targets compile to null — never partially compiled. */
export function compileHandlerBody(handler: Handler, propsLower: ReadonlySet<string>): CompiledBody | null {
  const c = new Gen(handler, propsLower);
  try {
    return c.run();
  } catch {
    return null;
  }
}

class Gen {
  private out: string[] = [];
  private nodes: unknown[] = [];
  private nodeIdx = new Map<object, number>();
  private slots = new Map<string, number>();
  private slotList: string[] = [];
  private params: string[] = [];
  private meParam = false;
  private tempCount = 0;
  private stmtDepth = 0;

  constructor(private handler: Handler, private propsLower: ReadonlySet<string>) {}

  run(): CompiledBody | null {
    const h = this.handler;
    let offset = 0;
    if (h.params.length > 0 && h.params[0].toLowerCase() === 'me') {
      this.meParam = true;
      offset = 1;
    }
    for (let i = offset; i < h.params.length; i++) {
      const lower = h.params[i].toLowerCase();
      if (!this.propsLower.has(lower) && !this.slots.has(lower)) {
        this.slots.set(lower, this.slotList.length);
        this.slotList.push(lower);
      }
      if (!this.propsLower.has(lower)) this.params.push(h.params[i]);
    }
    if (!this.scan(h.body)) return null;
    if (!this.withIn(h.body)) return null;
    const slots = this.slotList.length;
    let preamble = '';
    if (slots > 0) preamble = `var V = new Array(${slots}); var S = new Uint8Array(${slots});`;
    if (this.tempCount > 0) preamble += `var ${this.temps};`;
    let init = '';
    for (let i = 0; i < this.params.length; i++) {
      const name = this.params[i].toLowerCase();
      const slot = this.slots.get(name)!;
      init += `var a${i} = args[${i}] === undefined ? VOID : args[${i}]; V[${slot}] = a${i}; S[${slot}] = (S[${slot}] & 2) | 1;`;
    }
    const src = preamble + init + this.out.join('');
    if (src.length > MAX_SIZE) return null;
    return { src, nodes: this.nodes };
  }

  private noteSlot(name: string): void {
    const lower = name.toLowerCase();
    if (this.propsLower.has(lower)) return;
    if (!this.slots.has(lower)) {
      this.slots.set(lower, this.slotList.length);
      this.slotList.push(lower);
    }
  }

  /** Verify every statement/expression is embeddable before emitting. */
  private scan(stmts: Stmt[]): boolean {
    for (const s of stmts) {
      switch (s.kind) {
        case 'assign':
          if (s.target.kind === 'ident') {
            if (s.target.name.toLowerCase() !== 'me') this.noteSlot(s.target.name);
          } else if (s.target.kind === 'chunk') {
            return false;
          } else if (s.target.kind === 'prop') {
            // execAssign special-cases chunk-obj prop targets (member chunk
            // styles) before generic setPropValue — keep those interpreted.
            if (s.target.obj.kind === 'chunk') return false;
            if (!this.scanExpr(s.target.obj)) return false;
          } else if (s.target.kind === 'index') {
            if (!this.scanExpr(s.target.obj)) return false;
            if (!this.scanExpr(s.target.index)) return false;
          } else if (s.target.kind === 'the') {
            return false;
          } else {
            return false;
          }
          if (!this.scanExpr(s.value)) return false;
          break;
        case 'put':
        case 'delete':
        case 'globalDecl':
          return false;
        case 'if':
          if (!this.scanExpr(s.cond)) return false;
          if (!this.scan(s.then)) return false;
          if (!this.scan(s.els)) return false;
          break;
        case 'case':
          if (!this.scanExpr(s.subject)) return false;
          for (const br of s.branches) {
            if (br.match) for (const m of br.match) if (!this.scanExpr(m)) return false;
            if (!this.scan(br.body)) return false;
          }
          break;
        case 'repeatWith':
          this.noteSlot(s.varName);
          if (!this.scanExpr(s.from)) return false;
          if (!this.scanExpr(s.to)) return false;
          if (!this.scan(s.body)) return false;
          break;
        case 'repeatIn':
          this.noteSlot(s.varName);
          if (!this.scanExpr(s.list)) return false;
          if (!this.scan(s.body)) return false;
          break;
        case 'repeatWhile':
          if (!this.scanExpr(s.cond)) return false;
          if (!this.scan(s.body)) return false;
          break;
        case 'exit':
        case 'exitRepeat':
        case 'nextRepeat':
          break;
        case 'return':
          if (s.values) for (const v of s.values) if (!this.scanExpr(v)) return false;
          if (s.value && !this.scanExpr(s.value)) return false;
          break;
        case 'expr':
          if (!this.scanExpr(s.expr)) return false;
          break;
        default:
          return false;
      }
    }
    return true;
  }

  private scanExpr(e: Expr): boolean {
    switch (e.kind) {
      case 'num':
      case 'str':
      case 'symbol':
      case 'ident':
      case 'empty':
        return true;
      case 'list':
        return e.items.every((i) => this.scanExpr(i));
      case 'proplist':
        for (const [k, v] of e.pairs) {
          if (k.kind !== 'ident' && k.kind !== 'symbol' && k.kind !== 'str') return false;
          if (!this.scanExpr(v)) return false;
        }
        return true;
      case 'unary':
        return this.scanExpr(e.arg);
      case 'binary':
        return this.scanExpr(e.left) && this.scanExpr(e.right);
      case 'call':
        if (e.callee.kind !== 'ident' && e.callee.kind !== 'prop') return false;
        return e.args.every((a) => this.scanExpr(a)) && (e.callee.kind === 'prop' ? this.scanExpr(e.callee.obj) : true);
      case 'prop':
        return this.scanExpr(e.obj);
      case 'index':
        return this.scanExpr(e.obj) && this.scanExpr(e.index);
      case 'chunk':
        if (!this.scanExpr(e.obj)) return false;
        if (e.from && !this.scanExpr(e.from)) return false;
        if (e.to && !this.scanExpr(e.to)) return false;
        return true;
      case 'chunkCount':
        return this.scanExpr(e.obj);
      case 'the':
        return false;
      default:
        return false;
    }
  }

  private get temps(): string {
    const t: string[] = [];
    for (let i = 0; i < this.tempCount; i++) t.push(`t${i}`);
    return t.join(',');
  }

  private temp(): string {
    return `t${this.tempCount++}`;
  }

  private node(n: unknown): string {
    if (n === null || typeof n !== 'object') return '';
    let i = this.nodeIdx.get(n as object);
    if (i === undefined) {
      i = this.nodes.length;
      this.nodes.push(n);
      this.nodeIdx.set(n as object, i);
    }
    return `N[${i}]`;
  }

  private withIn(stmts: Stmt[]): boolean {
    if (this.stmtDepth > 200) return false;
    this.stmtDepth++;
    for (const s of stmts) {
      if (this.stmt(s) === false) {
        this.stmtDepth--;
        return false;
      }
    }
    this.stmtDepth--;
    return true;
  }

  private stmt(s: Stmt): boolean {
    switch (s.kind) {
      case 'assign': {
        this.emit('I.floatEpoch++;');
        const v = this.temp();
        this.emit(`var ${v} = ${this.expr(s.value)};`);
        return this.assignTarget(s.target, v, s.value);
      }
      case 'if': {
        this.emit('I.floatEpoch++;');
        const c = this.temp();
        this.emit(`var ${c} = ${this.expr(s.cond)};`);
        this.emit(`if (isTruthy(${c})) {`);
        if (this.withIn(s.then) === false) return false;
        this.emit('} else {');
        if (this.withIn(s.els) === false) return false;
        this.emit('}');
        return true;
      }
      case 'case': {
        this.emit('I.floatEpoch++;');
        const subj = this.temp();
        const m = this.temp();
        this.emit(`var ${subj} = ${this.expr(s.subject)};`);
        this.emit(`var ${m} = 0;`);
        for (const br of s.branches) {
          if (br.match === undefined) {
            this.emit(`if (!${m}) { ${m} = 1;`);
          } else {
            const conds: string[] = [];
            for (const mt of br.match) {
              const mv = this.temp();
              this.emit(`var ${mv} = 0;`);
              conds.push(`(!${m} && (${mv} = ${this.expr(mt)}, lingoEquals(${subj}, ${mv})))`);
            }
            this.emit(`if (${conds.join(' || ')}) { ${m} = 1;`);
          }
          if (this.withIn(br.body) === false) return false;
          this.emit('}');
        }
        return true;
      }
      case 'repeatWith': {
        const key = s.varName.toLowerCase();
        if (this.propsLower.has(key) || !this.slots.has(key)) return false;
        const slot = this.slots.get(key)!;
        const from = this.temp();
        const to = this.temp();
        const step = s.down ? -1 : 1;
        const iterV = this.temp();
        this.emit('I.floatEpoch++;');
        this.emit(`var ${from} = Math.round(asNum(${this.expr(s.from)}));`);
        this.emit(`var ${to} = Math.round(asNum(${this.expr(s.to)}));`);
        this.emit(`V[${slot}] = ${from}; S[${slot}] = (S[${slot}] & 2) | 1;`);
        this.emit(`var ${iterV} = 0;`);
        this.emit('while (true) {');
        this.emit(`if (${s.down ? `asNum(V[${slot}] ?? 0) < ${to}` : `asNum(V[${slot}] ?? 0) > ${to}`}) break;`);
        this.emit(`if (++${iterV} > ${MAX_LOOP}) { I.host.warn("repeat loop guard hit"); break; }`);
        this.emit('try {');
        if (this.withIn(s.body) === false) return false;
        this.emit('} catch (e) {');
        this.emit('if (e instanceof ExitR) break;');
        this.emit(`if (e instanceof NextR) { V[${slot}] = asNum(V[${slot}] ?? 0) + ${step}; continue; }`);
        this.emit('throw e;');
        this.emit('}');
        this.emit(`V[${slot}] = asNum(V[${slot}] ?? 0) + ${step};`);
        this.emit('}');
        return true;
      }
      case 'repeatIn': {
        const key = s.varName.toLowerCase();
        if (this.propsLower.has(key) || !this.slots.has(key)) return false;
        const slot = this.slots.get(key)!;
        const itemsT = this.temp();
        const iterT = this.temp();
        const ixt = this.temp();
        this.emit('I.floatEpoch++;');
        const lv = this.temp();
        this.emit(`var ${lv} = ${this.expr(s.list)};`);
        this.emit(`var ${itemsT} = I.listItemsOf(${lv});`);
        this.emit(`var ${iterT} = 0;`);
        this.emit(`for (var ${ixt} = 0; ${ixt} < ${itemsT}.length; ${ixt}++) {`);
        this.emit(`if (++${iterT} > ${MAX_LOOP}) break;`);
        this.emit(`V[${slot}] = ${itemsT}[${ixt}]; S[${slot}] = (S[${slot}] & 2) | 1;`);
        this.emit('try {');
        if (this.withIn(s.body) === false) return false;
        this.emit('} catch (e) {');
        this.emit('if (e instanceof ExitR) break;');
        this.emit('if (e instanceof NextR) continue;');
        this.emit('throw e;');
        this.emit('}');
        this.emit('}');
        return true;
      }
      case 'repeatWhile': {
        const iterT = this.temp();
        this.emit('I.floatEpoch++;');
        this.emit(`var ${iterT} = 0;`);
        this.emit(`while (isTruthy(${this.expr(s.cond)})) {`);
        this.emit(`if (++${iterT} > ${MAX_LOOP}) { I.host.warn("repeat loop guard hit"); break; }`);
        this.emit('try {');
        if (this.withIn(s.body) === false) return false;
        this.emit('} catch (e) {');
        this.emit('if (e instanceof ExitR) break;');
        this.emit('if (e instanceof NextR) continue;');
        this.emit('throw e;');
        this.emit('}');
        this.emit('}');
        return true;
      }
      case 'expr': {
        this.emit('I.floatEpoch++;');
        this.emit(this.expr(s.expr) + ';');
        return true;
      }
      case 'exit':
        this.emit('I.floatEpoch++; return VOID;');
        return true;
      case 'exitRepeat':
        this.emit('I.floatEpoch++; throw new ExitR();');
        return true;
      case 'nextRepeat':
        this.emit('I.floatEpoch++; throw new NextR();');
        return true;
      case 'return': {
        this.emit('I.floatEpoch++;');
        if (s.values && s.values.length > 1) {
          let last = this.temp();
          this.emit(`var ${last} = VOID;`);
          for (const v of s.values) {
            last = this.temp();
            this.emit(`var ${last} = ${this.expr(v)};`);
          }
          this.emit(`return ${last};`);
        } else if (s.value) {
          this.emit(`return ${this.expr(s.value)};`);
        } else {
          this.emit('return VOID;');
        }
        return true;
      }
      default:
        return false;
    }
  }

  private expr(e: Expr): string {
    const s = this.exprInner(e, 0);
    if (s === null) throw new Error('not jittable');
    return s;
  }

  private exprInner(e: Expr, depth: number): string | null {
    if (depth > MAX_DEPTH) return null;
    switch (e.kind) {
      case 'num':
        return `I.markNum(${e.value}, ${e.float ? 1 : 0})`;
      case 'str':
        return j(e.value);
      case 'symbol':
        return `new LSym(${j(e.name)})`;
      case 'ident': {
        const lower = e.name.toLowerCase();
        switch (lower) {
          case 'me': return 'env.me ?? VOID';
          case 'empty': return 'LEMPTY';
          case 'void': return 'VOID';
          case 'true': return '1';
          case 'false': return '0';
          case 'pi': return 'Math.PI';
          case 'return': return j('\r');
          case 'tab': return j('\t');
          case 'enter': return j('\x03');
          case 'space': return j(' ');
          case 'quote': return j('"');
        }
        const slot = this.slots.get(lower);
        if (slot !== undefined) {
          return `((S[${slot}] & 1) ? V[${slot}] : I.evalIdentFull(${this.node(e)}, env))`;
        }
        return `I.evalIdentFull(${this.node(e)}, env)`;
      }
      case 'empty':
        return 'LEMPTY';
      case 'list': {
        const parts: string[] = [];
        for (const i of e.items) {
          const p = this.exprInner(i, depth + 1);
          if (p === null) return null;
          parts.push(p);
        }
        return `(new LList([${parts.join(', ')}]))`;
      }
      case 'proplist': {
        const pp = this.temp();
        const seq: string[] = [];
        for (const [k, v] of e.pairs) {
          const keySrc =
            k.kind === 'ident' || k.kind === 'symbol' ? j(k.name) :
            k.kind === 'str' ? j(k.value) : j(String((k as { value: unknown }).value));
          const kt = this.temp();
          const vt = this.temp();
          const p = this.exprInner(v, depth + 1);
          if (p === null) return null;
          seq.push(`${kt} = ${keySrc}, ${vt} = ${p}, ${pp}.append(${kt}, ${vt})`);
        }
        return `((${[`${pp} = new PropPairs()`, ...seq, `new LPropList(${pp})`].join(', ')}))`;
      }
      case 'unary': {
        const v = this.temp();
        const arg = this.exprInner(e.arg, depth + 1);
        if (arg === null) return null;
        if (e.op === 'not') return `((${v} = ${arg}, isTruthy(${v}) ? 0 : 1))`;
        if (e.op === '-') return `((${v} = ${arg}, (lingoNegate(${v}) ?? -(asNum(${v})))))`;
        return `((${v} = ${arg}, asNum(${v})))`;
      }
      case 'binary': {
        const l = this.temp();
        const r = this.temp();
        const le = this.exprInner(e.left, depth + 1);
        const re = this.exprInner(e.right, depth + 1);
        if (le === null || re === null) return null;
        const fl = this.operandFloat(e.left, l);
        const fr = this.operandFloat(e.right, r);
        return `((${l} = ${le}, ${r} = ${re}, I.binaryOpF(${j(e.op)}, ${l}, ${r}, ${fl}, ${fr})))`;
      }
      case 'call': {
        const parts: string[] = [];
        for (const a of e.args) {
          const at = this.temp();
          const p = this.exprInner(a, depth + 1);
          if (p === null) return null;
          parts.push(`${at} = ${p}`);
        }
        const arr = this.temp();
        const inner = parts.length > 0 ? `[${parts.map((p) => p.split(' = ')[0]).join(', ')}]` : '[]';
        const callee0 = e.callee;
        if (callee0.kind === 'ident') {
          const lower = callee0.name.toLowerCase();
          return `((${parts.length > 0 ? parts.join(', ') + ', ' : ''}${arr} = ${inner}, I.invokeIdentCallee(${j(lower)}, ${j(callee0.name)}, ${arr}, env)))`;
        }
        if (callee0.kind !== 'prop') return null;
        const o = this.temp();
        const oe = this.exprInner(callee0.obj, depth + 1);
        if (oe === null) return null;
        return `((${parts.length > 0 ? parts.join(', ') + ', ' : ''}${o} = ${oe}, ${arr} = ${inner}, I.invokePropCallee(${o}, ${j(callee0.name)}, ${arr})))`;
      }
      case 'prop': {
        const o = this.temp();
        const oe = this.exprInner(e.obj, depth + 1);
        if (oe === null) return null;
        return `((${o} = ${oe}, I.getPropValue(${o}, ${j(e.name)})))`;
      }
      case 'index': {
        const o = this.temp();
        const i = this.temp();
        const oe = this.exprInner(e.obj, depth + 1);
        const ie = this.exprInner(e.index, depth + 1);
        if (oe === null || ie === null) return null;
        return `((${o} = ${oe}, ${i} = ${ie}, I.indexGet(${o}, ${i})))`;
      }
      case 'chunk': {
        const o = this.temp();
        const oe = this.exprInner(e.obj, depth + 1);
        if (oe === null) return null;
        const f = this.temp();
        let fe = 'undefined';
        if (e.from) {
          const fromE = this.exprInner(e.from, depth + 1);
          if (fromE === null) return null;
          fe = `Math.round(asNum(${fromE}))`;
        }
        const t = this.temp();
        let te = f;
        if (e.to) {
          const toE = this.exprInner(e.to, depth + 1);
          if (toE === null) return null;
          te = `Math.round(asNum(${toE}))`;
        }
        return `((${o} = ${oe}, ${f} = ${fe}, ${t} = ${te}, I.getChunkValue(${o}, ${j(e.chunk)}, ${f}, ${t})))`;
      }
      case 'chunkCount': {
        const o = this.temp();
        const oe = this.exprInner(e.obj, depth + 1);
        if (oe === null) return null;
        return `((${o} = ${oe}, I.chunkCount(${o}, ${j(e.chunk)})))`;
      }
      default:
        return null;
    }
  }

  /** Float-flag expression for a binary operand whose value is already in
   *  temp. Mirrors the interpreter's isFloatArith operand channels: the value
   *  channel (isFloatValue) plus the name channel (floatNames) for idents and
   *  props, with V-slot idents reading the tracked F bit instead. */
  private operandFloat(e: Expr, temp: string): string {
    switch (e.kind) {
      case 'ident': {
        const lower = e.name.toLowerCase();
        if (IDENT_KEYWORDS.has(lower)) return '0';
        const slot = this.slots.get(lower);
        if (slot !== undefined) {
          return `(((S[${slot}] & 1) ? ((S[${slot}] & 2) !== 0 || I.isFloatValue(V[${slot}])) : (I.isFloatValue(I.evalIdentFull(${this.node(e)}, env)) || I.floatNameIs(${j(lower)}))))`;
        }
        return `(I.isFloatValue(I.evalIdentFull(${this.node(e)}, env)) || I.floatNameIs(${j(lower)}))`;
      }
      case 'prop':
        return `(I.isFloatValue(${temp}) || I.floatNameIs(${j(e.name.toLowerCase())}))`;
      case 'num':
        return `I.isFloatValue(${e.value})`;
      case 'str':
      case 'symbol':
      case 'empty':
      case 'list':
      case 'proplist':
        return '0';
      default:
        return `I.isFloatValue(${temp})`;
    }
  }

  private assignTarget(t: Expr, v: string, rhs: Expr): boolean {
    const fBit = staticIsFloat(rhs) ? 1 : 0;
    if (t.kind === 'ident') {
      const lower = t.name.toLowerCase();
      if (lower === 'me') {
        this.emit('I.host.warn("cannot assign to me");');
        return true;
      }
      const slot = this.slots.get(lower);
      if (slot !== undefined) {
        this.emit(`if (env.globals.has(${j(lower)})) { I.host.globalSet(${j(t.name)}, ${v} === undefined ? VOID : ${v}); I.noteFloatAssign3(${j(lower)}, ${fBit}); } else {`);
        this.emit(`${v} = ${v} === undefined ? VOID : ${v}; V[${slot}] = ${v}; S[${slot}] = ${1 | (fBit << 1)}; }`);
        return true;
      }
      this.emit(`I.execAssignNode(${this.node(t)}, ${v} === undefined ? VOID : ${v}, env); I.noteFloatAssign3(${j(lower)}, ${fBit});`);
      return true;
    }
    if (t.kind === 'prop') {
      const o = this.temp();
      const oe = this.expr(t.obj);
      this.emit(`((${o} = ${oe}, I.setPropValue(${o}, ${j(t.name)}, ${v} === undefined ? VOID : ${v}), I.notePropFloat3(${o}, ${j(t.name)}, ${v}, ${fBit}), I.noteFloatAssign3(${j(t.name.toLowerCase())}, ${fBit})));`);
      return true;
    }
    if (t.kind === 'index') {
      const o = this.temp();
      const i = this.temp();
      const oe = this.expr(t.obj);
      const ie = this.expr(t.index);
      this.emit(`((${o} = ${oe}, ${i} = ${ie}, I.indexSet(${o}, ${i}, ${v} === undefined ? VOID : ${v})));`);
      return true;
    }
    return false;
  }

  private emit(s: string): void {
    this.out.push(s);
  }
}