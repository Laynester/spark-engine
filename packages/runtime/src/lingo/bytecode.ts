import type { Expr, Script, Stmt, TheSegment } from './ast.js';

// Lingo bytecode (LBC1): a compact binary form of the parsed Lingo AST. The
// bundler compiles each .ls script once and ships the bytes; the runtime
// decodes them instead of tokenizing + parsing the source — the parse step
// disappears from the boot path entirely. Decoding produces the EXACT object
// shapes the interpreter walks (same AST), so interpretation is unchanged.
//
// Format: inline UTF-8 strings (no string table — the bundle deflates one
// stream over everything, so repeated identifiers already compress away),
// u31 variable-length ints, little-endian.
//
//   'LBC1' u8 version
//   u8 type (0 parent 1 movie 2 score 3 behavior 4 unknown)
//   str name
//   str[] props, str[] globals
//   u31 handlerCount, handler*
//     handler: str name, str[] params, stmt[]
//
// Stmt tags: 1 assign 2 put 3 delete 4 if 5 case 6 repeatWith 7 repeatIn
//   8 repeatWhile 9 exit 10 exitRepeat 11 nextRepeat 12 return 13 expr
//   14 globalDecl
// Expr tags: 1 num 2 str 3 symbol 4 ident 5 list 6 proplist 7 unary
//   8 binary 9 call 10 prop 11 index 12 chunk 13 chunkCount 14 the 15 empty

const SCRIPT_TYPES: Record<Script['type'], number> = { parent: 0, movie: 1, score: 2, behavior: 3, unknown: 4 };
const SCRIPT_TYPES_NAMES: Script['type'][] = ['parent', 'movie', 'score', 'behavior', 'unknown'];

const STMT_ASSIGN = 1, STMT_PUT = 2, STMT_DELETE = 3, STMT_IF = 4, STMT_CASE = 5;
const STMT_REPEAT_WITH = 6, STMT_REPEAT_IN = 7, STMT_REPEAT_WHILE = 8;
const STMT_EXIT = 9, STMT_EXIT_REPEAT = 10, STMT_NEXT_REPEAT = 11;
const STMT_RETURN = 12, STMT_EXPR = 13, STMT_GLOBAL_DECL = 14;

const EXPR_NUM = 1, EXPR_STR = 2, EXPR_SYMBOL = 3, EXPR_IDENT = 4, EXPR_LIST = 5, EXPR_PROPLIST = 6;
const EXPR_UNARY = 7, EXPR_BINARY = 8, EXPR_CALL = 9, EXPR_PROP = 10, EXPR_INDEX = 11;
const EXPR_CHUNK = 12, EXPR_CHUNK_COUNT = 13, EXPR_THE = 14, EXPR_EMPTY = 15;

const CHUNKS: Record<string, number> = { char: 0, word: 1, line: 2, item: 3, paragraph: 4 };
const CHUNK_NAMES = ['char', 'word', 'line', 'item', 'paragraph'] as const;
const UNARY_OPS: Record<string, number> = { not: 0, '-': 1, '+': 2 };
const UNARY_OP_NAMES = ['not', '-', '+'] as const;
const SEG_OPS: Record<string, number> = { of: 0, in: 1 };
const SEG_OP_NAMES = ['of', 'in'] as const;

const enc = new TextEncoder();
const dec = new TextDecoder();

class Writer {
  private buf = new Uint8Array(4096);
  private len = 0;

  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  u8(v: number): void {
    this.ensure(1);
    this.buf[this.len++] = v & 0xff;
  }

  u31(v: number): void {
    let x = v >>> 0;
    do {
      let b = x & 0x7f;
      x >>>= 7;
      if (x !== 0) b |= 0x80;
      this.u8(b);
    } while (x !== 0);
  }

  f64(v: number): void {
    const tmp = new DataView(new ArrayBuffer(8));
    tmp.setFloat64(0, v, true);
    for (let i = 0; i < 8; i++) this.u8(tmp.getUint8(i));
  }

  bytes(bytes: Uint8Array): void {
    this.ensure(bytes.length);
    this.buf.set(bytes, this.len);
    this.len += bytes.length;
  }

  str(s: string): void {
    const b = enc.encode(s);
    this.u31(b.length);
    this.bytes(b);
  }

  strs(list: string[]): void {
    this.u31(list.length);
    for (const s of list) this.str(s);
  }

  out(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

class Reader {
  pos = 0;
  constructor(private buf: Uint8Array, private view: DataView) {}

  u8(): number {
    const v = this.view.getUint8(this.pos);
    this.pos += 1;
    return v;
  }

  u31(): number {
    let out = 0;
    let shift = 0;
    for (;;) {
      const b = this.u8();
      out |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return out >>> 0;
      shift += 7;
      if (shift > 28) throw new Error('bytecode: u31 overflow');
    }
  }

  f64(): number {
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  str(): string {
    const n = this.u31();
    if (n === 0) return '';
    const s = dec.decode(this.buf.subarray(this.pos, this.pos + n));
    this.pos += n;
    return s;
  }

  strs(): string[] {
    const out: string[] = [];
    for (let n = this.u31(); n > 0; n--) out.push(this.str());
    return out;
  }
}

function encodeExpr(w: Writer, e: Expr): void {
  switch (e.kind) {
    case 'num':
      w.u8(EXPR_NUM);
      w.u8(e.float ? 1 : 0);
      w.f64(e.value);
      return;
    case 'str':
      w.u8(EXPR_STR);
      w.str(e.value);
      return;
    case 'symbol':
      w.u8(EXPR_SYMBOL);
      w.str(e.name);
      return;
    case 'ident':
      w.u8(EXPR_IDENT);
      w.str(e.name);
      return;
    case 'list':
      w.u8(EXPR_LIST);
      w.u31(e.items.length);
      for (const it of e.items) encodeExpr(w, it);
      return;
    case 'proplist':
      w.u8(EXPR_PROPLIST);
      w.u31(e.pairs.length);
      for (const [k, v] of e.pairs) {
        encodeExpr(w, k);
        encodeExpr(w, v);
      }
      return;
    case 'unary':
      w.u8(EXPR_UNARY);
      w.u8(UNARY_OPS[e.op]);
      encodeExpr(w, e.arg);
      return;
    case 'binary':
      w.u8(EXPR_BINARY);
      w.str(e.op);
      encodeExpr(w, e.left);
      encodeExpr(w, e.right);
      return;
    case 'call':
      w.u8(EXPR_CALL);
      encodeExpr(w, e.callee);
      w.u31(e.args.length);
      for (const a of e.args) encodeExpr(w, a);
      return;
    case 'prop':
      w.u8(EXPR_PROP);
      encodeExpr(w, e.obj);
      w.str(e.name);
      return;
    case 'index':
      w.u8(EXPR_INDEX);
      encodeExpr(w, e.obj);
      encodeExpr(w, e.index);
      return;
    case 'chunk':
      w.u8(EXPR_CHUNK);
      encodeExpr(w, e.obj);
      w.u8(CHUNKS[e.chunk]);
      w.u8(e.from ? 1 : 0);
      if (e.from) encodeExpr(w, e.from);
      w.u8(e.to ? 1 : 0);
      if (e.to) encodeExpr(w, e.to);
      return;
    case 'chunkCount':
      w.u8(EXPR_CHUNK_COUNT);
      encodeExpr(w, e.obj);
      w.u8(CHUNKS[e.chunk]);
      return;
    case 'the':
      w.u8(EXPR_THE);
      w.str(e.head);
      w.u31(e.chain.length);
      for (const seg of e.chain) {
        w.u8(SEG_OPS[seg.op]);
        w.str(seg.name);
        w.u8(seg.arg ? 1 : 0);
        if (seg.arg) encodeExpr(w, seg.arg);
        w.u8(seg.qualifier !== undefined ? 1 : 0);
        if (seg.qualifier !== undefined) w.str(seg.qualifier);
      }
      return;
    case 'empty':
      w.u8(EXPR_EMPTY);
      return;
    default:
      throw new Error(`bytecode: cannot encode expr kind ${(e as { kind: string }).kind}`);
  }
}

function decodeExpr(r: Reader): Expr {
  const tag = r.u8();
  switch (tag) {
    case EXPR_NUM: {
      const isFloat = r.u8() === 1;
      const value = r.f64();
      return { kind: 'num', value, float: isFloat };
    }
    case EXPR_STR:
      return { kind: 'str', value: r.str() };
    case EXPR_SYMBOL:
      return { kind: 'symbol', name: r.str() };
    case EXPR_IDENT:
      return { kind: 'ident', name: r.str() };
    case EXPR_LIST: {
      const items: Expr[] = [];
      for (let n = r.u31(); n > 0; n--) items.push(decodeExpr(r));
      return { kind: 'list', items };
    }
    case EXPR_PROPLIST: {
      const pairs: [Expr, Expr][] = [];
      for (let n = r.u31(); n > 0; n--) pairs.push([decodeExpr(r), decodeExpr(r)]);
      return { kind: 'proplist', pairs };
    }
    case EXPR_UNARY:
      return { kind: 'unary', op: UNARY_OP_NAMES[r.u8()], arg: decodeExpr(r) };
    case EXPR_BINARY:
      return { kind: 'binary', op: r.str(), left: decodeExpr(r), right: decodeExpr(r) };
    case EXPR_CALL: {
      const callee = decodeExpr(r);
      const args: Expr[] = [];
      for (let n = r.u31(); n > 0; n--) args.push(decodeExpr(r));
      return { kind: 'call', callee, args };
    }
    case EXPR_PROP:
      return { kind: 'prop', obj: decodeExpr(r), name: r.str() };
    case EXPR_INDEX:
      return { kind: 'index', obj: decodeExpr(r), index: decodeExpr(r) };
    case EXPR_CHUNK: {
      const obj = decodeExpr(r);
      const chunk = CHUNK_NAMES[r.u8()];
      const from = r.u8() === 1 ? decodeExpr(r) : undefined;
      const to = r.u8() === 1 ? decodeExpr(r) : undefined;
      return { kind: 'chunk', obj, chunk, ...(from ? { from } : {}), ...(to ? { to } : {}) };
    }
    case EXPR_CHUNK_COUNT: {
      const obj = decodeExpr(r);
      const chunk = CHUNK_NAMES[r.u8()];
      return { kind: 'chunkCount', obj, chunk };
    }
    case EXPR_THE: {
      const head = r.str();
      const chain: TheSegment[] = [];
      for (let n = r.u31(); n > 0; n--) {
        const op = SEG_OP_NAMES[r.u8()];
        const name = r.str();
        const arg = r.u8() === 1 ? decodeExpr(r) : undefined;
        const qualifier = r.u8() === 1 ? r.str() : undefined;
        chain.push({ op, name, ...(arg ? { arg } : {}), ...(qualifier !== undefined ? { qualifier } : {}) });
      }
      return { kind: 'the', head, chain };
    }
    case EXPR_EMPTY:
      return { kind: 'empty' };
    default:
      throw new Error(`bytecode: unknown expr tag ${tag}`);
  }
}

function encodeStmt(w: Writer, s: Stmt): void {
  switch (s.kind) {
    case 'assign':
      w.u8(STMT_ASSIGN);
      encodeExpr(w, s.target);
      encodeExpr(w, s.value);
      return;
    case 'put':
      w.u8(STMT_PUT);
      encodeExpr(w, s.value);
      w.u8(s.into ? 1 : 0);
      if (s.into) encodeExpr(w, s.into);
      w.u8(s.mode === 'after' ? 1 : s.mode === 'before' ? 2 : s.mode === 'into' ? 3 : 0);
      return;
    case 'delete':
      w.u8(STMT_DELETE);
      encodeExpr(w, s.target);
      return;
    case 'if':
      w.u8(STMT_IF);
      encodeExpr(w, s.cond);
      encodeStmts(w, s.then);
      encodeStmts(w, s.els);
      return;
    case 'case':
      w.u8(STMT_CASE);
      encodeExpr(w, s.subject);
      w.u31(s.branches.length);
      for (const br of s.branches) {
        w.u8(br.match ? 1 : 0);
        if (br.match) {
          w.u31(br.match.length);
          for (const m of br.match) encodeExpr(w, m);
        }
        encodeStmts(w, br.body);
      }
      return;
    case 'repeatWith':
      w.u8(STMT_REPEAT_WITH);
      w.str(s.varName);
      encodeExpr(w, s.from);
      encodeExpr(w, s.to);
      w.u8(s.down ? 1 : 0);
      encodeStmts(w, s.body);
      return;
    case 'repeatIn':
      w.u8(STMT_REPEAT_IN);
      w.str(s.varName);
      encodeExpr(w, s.list);
      encodeStmts(w, s.body);
      return;
    case 'repeatWhile':
      w.u8(STMT_REPEAT_WHILE);
      encodeExpr(w, s.cond);
      encodeStmts(w, s.body);
      return;
    case 'exit':
      w.u8(STMT_EXIT);
      return;
    case 'exitRepeat':
      w.u8(STMT_EXIT_REPEAT);
      return;
    case 'nextRepeat':
      w.u8(STMT_NEXT_REPEAT);
      return;
    case 'return':
      w.u8(STMT_RETURN);
      if (s.values && s.values.length > 0) {
        w.u8(2);
        w.u31(s.values.length);
        for (const v of s.values) encodeExpr(w, v);
      } else if (s.value !== undefined) {
        w.u8(1);
        encodeExpr(w, s.value);
      } else {
        w.u8(0);
      }
      return;
    case 'expr':
      w.u8(STMT_EXPR);
      encodeExpr(w, s.expr);
      return;
    case 'globalDecl':
      w.u8(STMT_GLOBAL_DECL);
      w.strs(s.names);
      return;
    default:
      throw new Error(`bytecode: cannot encode stmt kind ${(s as { kind: string }).kind}`);
  }
}

function decodeStmt(r: Reader): Stmt {
  const tag = r.u8();
  switch (tag) {
    case STMT_ASSIGN: {
      const target = decodeExpr(r);
      const value = decodeExpr(r);
      return { kind: 'assign', target, value };
    }
    case STMT_PUT: {
      const value = decodeExpr(r);
      const into = r.u8() === 1 ? decodeExpr(r) : undefined;
      const modeByte = r.u8();
      const mode =
        modeByte === 0 ? undefined : modeByte === 1 ? 'after' : modeByte === 2 ? 'before' : 'into';
      return { kind: 'put', value, ...(into ? { into } : {}), ...(mode ? { mode } : {}) };
    }
    case STMT_DELETE:
      return { kind: 'delete', target: decodeExpr(r) };
    case STMT_IF: {
      const cond = decodeExpr(r);
      const then = decodeStmts(r);
      const els = decodeStmts(r);
      return { kind: 'if', cond, then, els };
    }
    case STMT_CASE: {
      const subject = decodeExpr(r);
      const branches = [];
      for (let n = r.u31(); n > 0; n--) {
        const hasMatch = r.u8() === 1;
        let match: Expr[] | undefined;
        if (hasMatch) {
          match = [];
          for (let m = r.u31(); m > 0; m--) match.push(decodeExpr(r));
        }
        const body = decodeStmts(r);
        branches.push(hasMatch ? { match, body } : { body });
      }
      return { kind: 'case', subject, branches };
    }
    case STMT_REPEAT_WITH: {
      const varName = r.str();
      const from = decodeExpr(r);
      const to = decodeExpr(r);
      const down = r.u8() === 1;
      const body = decodeStmts(r);
      return { kind: 'repeatWith', varName, from, to, down, body };
    }
    case STMT_REPEAT_IN: {
      const varName = r.str();
      const list = decodeExpr(r);
      const body = decodeStmts(r);
      return { kind: 'repeatIn', varName, list, body };
    }
    case STMT_REPEAT_WHILE: {
      const cond = decodeExpr(r);
      const body = decodeStmts(r);
      return { kind: 'repeatWhile', cond, body };
    }
    case STMT_EXIT:
      return { kind: 'exit' };
    case STMT_EXIT_REPEAT:
      return { kind: 'exitRepeat' };
    case STMT_NEXT_REPEAT:
      return { kind: 'nextRepeat' };
    case STMT_RETURN: {
      const k = r.u8();
      if (k === 0) return { kind: 'return' };
      if (k === 1) return { kind: 'return', value: decodeExpr(r) };
      const values: Expr[] = [];
      for (let n = r.u31(); n > 0; n--) values.push(decodeExpr(r));
      return { kind: 'return', values };
    }
    case STMT_EXPR:
      return { kind: 'expr', expr: decodeExpr(r) };
    case STMT_GLOBAL_DECL:
      return { kind: 'globalDecl', names: r.strs() };
    default:
      throw new Error(`bytecode: unknown stmt tag ${tag}`);
  }
}

function encodeStmts(w: Writer, list: Stmt[]): void {
  w.u31(list.length);
  for (const s of list) encodeStmt(w, s);
}

function decodeStmts(r: Reader): Stmt[] {
  const out: Stmt[] = [];
  for (let n = r.u31(); n > 0; n--) out.push(decodeStmt(r));
  return out;
}

/** Compile a parsed script to LBC1 bytes. */
export function encodeScript(script: Script): Uint8Array {
  const w = new Writer();
  w.bytes(enc.encode('LBC1'));
  w.u8(1);
  w.u8(SCRIPT_TYPES[script.type] ?? 4);
  w.str(script.name);
  w.strs(script.props);
  w.strs(script.globals);
  w.u31(script.handlers.length);
  for (const h of script.handlers) {
    w.str(h.name);
    w.strs(h.params);
    encodeStmts(w, h.body);
  }
  return w.out();
}

/** Decode LBC1 bytes back into the exact AST shapes the interpreter walks. */
export function decodeScript(bytes: Uint8Array): Script {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const r = new Reader(bytes, view);
  const magic = String.fromCharCode(r.u8(), r.u8(), r.u8(), r.u8());
  if (magic !== 'LBC1') throw new Error('bytecode: bad magic');
  const version = r.u8();
  if (version !== 1) throw new Error(`bytecode: unsupported version ${version}`);
  const type = SCRIPT_TYPES_NAMES[r.u8()] ?? 'unknown';
  const name = r.str();
  const props = r.strs();
  const globals = r.strs();
  const handlers = [];
  for (let n = r.u31(); n > 0; n--) {
    handlers.push({ name: r.str(), params: r.strs(), body: decodeStmts(r) });
  }
  return { name, type, props, globals, handlers, source: '' };
}