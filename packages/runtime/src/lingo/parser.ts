import type { ChunkKind, Expr, Handler, Script, Stmt, TheSegment } from './ast.js';
import { LingoSyntaxError, tokenize, type Token } from './tokenizer.js';

const CHUNK_KWS = new Set(['char', 'word', 'line', 'item', 'paragraph']);

const CHUNK_COUNT_KWS = new Set(['items', 'lines', 'words', 'chars']);

const COMMAND_FUNCS = new Set([
  'field', 'member', 'sprite', 'castlib', 'window', 'go', 'call', 'new', 'symbol', 'value',
  'string', 'integer', 'float', 'abs', 'sqrt', 'length', 'random', 'min', 'max', 'list', 'point', 'rect',
  'getnettext', 'preloadnetthing', 'netdone', 'neterror', 'nettextresult', 'netabort', 'getmemnum',
  'getobject', 'removeobject', 'objectexists', 'getvariable', 'getvariablevalue', 'setvariable',
  'variableexists', 'dumpvariablefield', 'dumptextfield', 'gettext', 'getuniqueid',
  'executemessage', 'createwindow', 'removewindow', 'windowexists', 'getconnection', 'connectionexists',
  'removeconnection', 'registerlistener', 'registercommands', 'unregisterlistener',
  'getobjectmanager', 'getresourcemanager', 'getvisualizer', 'getsystemmanager', 'getspriteManager',
  'getthreadmanager', 'getdownloadmanager', 'getcastloadmanager', 'getmultiusermanager', 'newobject',
  'puppetsprite', 'puppetsound', 'sound', 'movetofront', 'movetoback', 'error', 'warning', 'alert',
  'beep', 'delay', 'quit', 'halt', 'restart',
]);
const BINARY_PRECEDENCE: Record<string, number> = {
  or: 1,
  and: 2,
  '=': 3, '<>': 3, '<': 3, '>': 3, '<=': 3, '>=': 3, is: 3, contains: 3, starts: 3,
  '&': 4, '&&': 4,
  '+': 5, '-': 5,
  '*': 6, '/': 6, mod: 6, div: 6,
};

export class Parser {
  private pos = 0;
  private noOf = false;
  private parenDepth = 0;

  constructor(private tokens: Token[]) {}

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private isPunct(v: string): boolean {
    const t = this.peek();
    return t.type === 'punct' && t.value === v;
  }

  private isKw(v: string): boolean {
    const t = this.peek();
    return t.type === 'ident' && t.value.toLowerCase() === v;
  }

  private expectPunct(v: string): void {
    if (!this.isPunct(v)) throw this.err(`expected "${v}"`);
    this.next();
  }

  private expectKw(v: string): void {
    if (!this.isKw(v)) throw this.err(`expected "${v}"`);
    this.next();
  }

  private err(message: string): LingoSyntaxError {
    return new LingoSyntaxError(`${message} (near ${JSON.stringify(this.peek().value || 'end of file')})`, this.peek().line);
  }

  private parseIdent(): string {
    const t = this.next();
    if (t.type !== 'ident') throw this.err('expected identifier');
    return t.value;
  }


  parseScript(): Script {
    const handlers: Handler[] = [];
    const props: string[] = [];
    const globals: string[] = [];

    while (this.peek().type !== 'eof') {
      if (this.isKw('property')) {
        this.next();
        props.push(...this.parseNameList());
      } else if (this.isKw('global')) {
        this.next();
        globals.push(...this.parseNameList());
      } else if (this.isKw('on')) {
        handlers.push(this.parseHandler());
      } else {
        throw this.err(`unexpected token at script level (expected "on", "property" or "global")`);
      }
    }
    return { name: '', type: 'unknown', props, globals, handlers, source: '' };
  }

  private parseNameList(): string[] {
    const names: string[] = [];
    for (;;) {
      if (this.peek().type === 'ident' && !['property', 'global', 'on'].includes(this.peek().value.toLowerCase())) {
        names.push(this.parseIdent());
      } else {
        break;
      }
      if (this.isPunct(',')) this.next();
      else break;
    }
    return names;
  }

  private parseHandler(): Handler {
    this.expectKw('on');
    const nameTok = this.next();
    if (nameTok.type !== 'ident') throw this.err('expected handler name after on');
    const name = nameTok.value;
    const params: string[] = [];
    if (this.peek().type === 'ident' && this.peek().line === nameTok.line) {
      while (this.peek().type === 'ident' && !['end', 'property', 'global', 'on'].includes(this.peek().value.toLowerCase())) {
        params.push(this.parseIdent());
        if (this.isPunct(',')) this.next();
        else break;
      }
    }
    const body = this.parseBlock(new Set(['end']));
    const endTok = this.next();
    if (endTok.type !== 'ident' || endTok.value.toLowerCase() !== 'end') throw this.err('expected "end"');
    if (this.peek().type === 'ident' && this.peek().line === endTok.line) {
      this.next();
    }
    return { name, params, body };
  }


  private parseBlock(terminators: Set<string>): Stmt[] {
    const stmts: Stmt[] = [];
    for (;;) {
      const t = this.peek();
      if (t.type === 'eof') throw this.err('unexpected end of file inside block');
      if (t.type === 'ident' && terminators.has(t.value.toLowerCase())) break;
      stmts.push(this.parseStmt());
    }
    return stmts;
  }


  private parseStmt(): Stmt {
    const t = this.peek();

    if (t.type === 'ident') {
      const kw = t.value.toLowerCase();
      if (kw === 'if') return this.parseIf();
      if (kw === 'case') return this.parseCase();
      if (kw === 'repeat') return this.parseRepeat();
      if (kw === 'exit') {
        this.next();
        if (this.isKw('repeat') && this.peek().line === t.line) {
          this.next();
          return { kind: 'exitRepeat' };
        }
        return { kind: 'exit' };
      }
      if (kw === 'next') {
        this.next();
        if (this.isKw('repeat')) this.next();
        return { kind: 'nextRepeat' };
      }
      if (kw === 'return') {
        this.next();
        if (this.atStatementEnd()) return { kind: 'return' };
        const values = [this.parseExpr(0)];
        while (this.isPunct(',')) {
          this.next();
          values.push(this.parseExpr(0));
        }
        return values.length === 1 ? { kind: 'return', value: values[0] } : { kind: 'return', value: values[0], values };
      }
      if (kw === 'put') {
        const putLine = this.next().line;
        if (this.peek().line !== putLine) return { kind: 'put', value: { kind: 'str', value: '' } };
        const values = [this.parseExpr(0)];
        while (this.isPunct(',')) {
          this.next();
          values.push(this.parseExpr(0));
        }
        if (this.isKw('into') || this.isKw('after') || this.isKw('before')) {
          const mode = this.next().value.toLowerCase() as 'into' | 'after' | 'before';
          const into = this.parseChain();
          return { kind: 'put', value: values[0], into, mode };
        }
        return { kind: 'put', value: values.length === 1 ? values[0] : { kind: 'list', items: values } };
      }
      if (kw === 'delete') {
        this.next();
        return { kind: 'delete', target: this.parseChain() };
      }
      if (kw === 'set') {
        this.next();
        const target = this.parseChain();
        if (this.isPunct('=')) this.next();
        else if (this.isKw('to')) this.next();
        else throw this.err('expected "=" or "to" after set target');
        return { kind: 'assign', target, value: this.parseExpr(0) };
      }
      if (kw === 'global') {
        this.next();
        return { kind: 'globalDecl', names: this.parseNameList() };
      }
      if (kw === 'go') {
        this.next();
        if (this.isKw('to')) this.next();
        let target: Expr;
        if (this.isPunct('(')) target = this.parseArgs()[0];
        else target = this.parseExpr(0);
        return { kind: 'expr', expr: { kind: 'call', callee: { kind: 'ident', name: 'go' }, args: [target] } };
      }
    }

    const chain = this.parseChain();
    if (this.isPunct('=')) {
      this.next();
      return { kind: 'assign', target: chain, value: this.parseExpr(0) };
    }
    return { kind: 'expr', expr: chain };
  }

  private atStatementEnd(): boolean {
    const t = this.peek();
    if (t.type === 'eof') return true;
    if (t.type !== 'ident') return false;
    const kw = t.value.toLowerCase();
    return ['end', 'else', 'then', 'otherwise', 'to', 'into', 'down'].includes(kw);
  }

  private parseIf(): Stmt {
    const line = this.next().line;
    const cond = this.parseExpr(0);
    this.expectKw('then');
    const thenLine = this.peek().line;

    if (thenLine === line) {
      const stmts = [this.parseStmt()];
      let els: Stmt[] = [];
      if (this.isKw('else')) {
        this.next();
        if (this.isKw('if')) els = [this.parseIf()];
        else els = [this.parseStmt()];
      }
      return { kind: 'if', cond, then: stmts, els };
    }

    const then = this.parseBlock(new Set(['end', 'else']));
    let els: Stmt[] = [];      if (this.isKw('else')) {
        const elseTok = this.next();
        if (this.isKw('if') && this.peek().line === elseTok.line) {
          return { kind: 'if', cond, then, els: [this.parseIf()] };
      }
      els = this.parseBlock(new Set(['end']));
    }
    this.expectKw('end');
    if (this.isKw('if')) this.next();
    return { kind: 'if', cond, then, els };
  }

  private parseCase(): Stmt {
    this.expectKw('case');
    const savedNoOf = this.noOf;
    this.noOf = true;
    let subject: Expr;
    try {
      subject = this.parseExpr(0);
    } finally {
      this.noOf = savedNoOf;
    }
    this.expectKw('of');
    const branches: { match?: Expr[]; body: Stmt[] }[] = [];

    for (;;) {
      if (this.isKw('end')) {
        this.next();
        if (this.isKw('case')) this.next();
        break;
      }
      if (this.isKw('otherwise')) {
        this.next();
        this.expectPunct(':');
        branches.push({ match: undefined, body: this.parseCaseBody() });
        continue;
      }
      const matches = [this.parseExpr(0)];
      while (this.isPunct(',')) {
        this.next();
        matches.push(this.parseExpr(0));
      }
      this.expectPunct(':');
      branches.push({ match: matches, body: this.parseCaseBody() });
    }
    return { kind: 'case', subject, branches };
  }

  private parseCaseBody(): Stmt[] {
    const stmts: Stmt[] = [];
    for (;;) {
      const t = this.peek();
      if (t.type === 'eof') throw this.err('unexpected end of file in case block');
      if (t.type === 'ident' && ['end', 'otherwise'].includes(t.value.toLowerCase())) break;
      if (this.lineEndsWithLabelColon()) break;
      stmts.push(this.parseStmt());
    }
    return stmts;
  }

  private lineEndsWithLabelColon(): boolean {
    const line = this.peek().line;
    let depth = 0;
    for (let i = this.pos; i < this.tokens.length; i++) {
      const t = this.tokens[i];
      if (t.line !== line) return false;
      if (t.type === 'eof') return false;
      if (t.type === 'punct') {
        if (t.value === '(' || t.value === '[') depth++;
        else if (t.value === ')' || t.value === ']') depth--;
        else if (t.value === ':' && depth === 0) return true;
      }
    }
    return false;
  }

  private parseRepeat(): Stmt {
    this.expectKw('repeat');
    if (this.isKw('while')) {
      this.next();
      const cond = this.parseExpr(0);
      const body = this.parseBlock(new Set(['end']));
      this.expectKw('end');
      if (this.isKw('repeat')) this.next();
      return { kind: 'repeatWhile', cond, body };
    }
    this.expectKw('with');
    const varName = this.parseIdent();
    if (this.isKw('in')) {
      this.next();
      const list = this.parseExpr(0);
      const body = this.parseBlock(new Set(['end']));
      this.expectKw('end');
      if (this.isKw('repeat')) this.next();
      return { kind: 'repeatIn', varName, list, body };
    }
    this.expectPunct('=');
    const from = this.parseExpr(0);
    let down = false;
    if (this.isKw('down')) {
      this.next();
      down = true;
    }
    if (!this.isKw('to')) throw this.err('expected "to" in repeat-with range');
    this.next();
    const to = this.parseExpr(0);
    const body = this.parseBlock(new Set(['end']));
    this.expectKw('end');
    if (this.isKw('repeat')) this.next();
    return { kind: 'repeatWith', varName, from, to, down, body };
  }


  private parseExpr(minPrec = 0): Expr {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      let op: string | undefined;
      if (t.type === 'punct' && BINARY_PRECEDENCE[t.value] !== undefined) op = t.value;
      else if (t.type === 'ident' && BINARY_PRECEDENCE[t.value.toLowerCase()] !== undefined) op = t.value.toLowerCase();
      if (!op) break;
      if (t.line !== this.tokens[this.pos - 1].line) break;
      const prec = BINARY_PRECEDENCE[op];
      if (prec < minPrec) break;
      this.next();
      const right = this.parseExpr(prec + 1);
      left = { kind: 'binary', op, left, right };
    }
    return left;
  }

  parseTopLevelExpr(): Expr {
    const expr = this.parseExpr(0);
    if (this.peek().type !== 'eof') throw this.err('trailing tokens after expression');
    return expr;
  }

  private parseUnary(): Expr {
    const t = this.peek();
    if (t.type === 'ident') {
      const kw = t.value.toLowerCase();
      if (kw === 'not') {
        this.next();
        return { kind: 'unary', op: 'not', arg: this.parseExpr(7) };
      }
    }
    if (t.type === 'punct' && (t.value === '-' || t.value === '+')) {
      this.next();
      return { kind: 'unary', op: t.value as '-' | '+', arg: this.parseUnary() };
    }
    return this.parseChain();
  }

  private parseChain(): Expr {
    const expr = this.parsePrimary();
    return this.parseChainTail(expr, this.tokens[this.pos - 1].line);
  }

  private parseChainTail(expr: Expr, startLine: number, indexOnly = false): Expr {
    for (;;) {
      const sameLine = this.peek().line === startLine;
      if (!indexOnly && this.isPunct('.') && sameLine) {
        this.next();
        const name = this.parseIdent();
        const lower = name.toLowerCase();
        if (CHUNK_KWS.has(lower)) {
          expr = { kind: 'chunk', obj: expr, chunk: lower as ChunkKind };
          if (this.isPunct('[')) {
            const range = this.parseRange();
            if (range.from) expr = { ...expr, from: range.from };
            if (range.to) expr = { ...expr, to: range.to };
          }
          continue;
        }
        if (lower === 'count' && expr.kind === 'chunk') {
          expr = { kind: 'chunkCount', obj: expr.obj, chunk: expr.chunk };
          continue;
        }
        expr = { kind: 'prop', obj: expr, name };
        if (this.isPunct('(')) {
          const args = this.parseArgs();
          expr = { kind: 'call', callee: expr, args };
        }
        continue;
      }
      if (this.isPunct('[') && sameLine) {
        this.next();
        const index = this.parseExpr(0);
        if (this.isPunct('..')) {
          this.next();
          const to = this.parseExpr(0);
          this.expectPunct(']');
          expr = { kind: 'chunk', obj: expr, chunk: 'item', from: index, to };
        } else {
          this.expectPunct(']');
          expr = { kind: 'index', obj: expr, index };
        }
        continue;
      }
      if (!indexOnly && this.isPunct('(') && sameLine) {
        const args = this.parseArgs();
        expr = { kind: 'call', callee: expr, args };
        continue;
      }
      if (sameLine && expr.kind === 'ident' && COMMAND_FUNCS.has(expr.name.toLowerCase()) && this.startsCommandArg()) {
        expr = { kind: 'call', callee: expr, args: this.parseCommandArgs() };
        continue;
      }
      break;
    }
    return expr;
  }

  private startsCommandArg(): boolean {
    return this.startsAtom();
  }

  private parseCommandArgs(): Expr[] {
    const args: Expr[] = [];
    for (;;) {
      args.push(this.parseExpr(0));
      if (this.parenDepth === 0 && this.isPunct(',')) {
        this.next();
        continue;
      }
      break;
    }
    return args;
  }

  private parseRange(): { from?: Expr; to?: Expr } {
    this.expectPunct('[');
    const first = this.parseExpr(0);
    if (this.isPunct('..')) {
      this.next();
      const to = this.parseExpr(0);
      this.expectPunct(']');
      return { from: first, to };
    }
    this.expectPunct(']');
    return { from: first };
  }

  private parseArgs(): Expr[] {
    this.expectPunct('(');
    this.parenDepth++;
    const args: Expr[] = [];
    try {
      if (!this.isPunct(')')) {
        args.push(this.parseExpr(0));
        while (this.isPunct(',')) {
          this.next();
          args.push(this.parseExpr(0));
        }
      }
    } finally {
      this.parenDepth--;
    }
    this.expectPunct(')');
    return args;
  }

  private parsePrimary(): Expr {
    const t = this.next();
    switch (t.type) {
      case 'num':
        return { kind: 'num', value: parseFloat(t.value), float: /[.eE]/.test(t.value) };
      case 'str':
        return { kind: 'str', value: t.value };
      case 'symbol':
        return { kind: 'symbol', name: t.value };
      case 'punct':
        if (t.value === '(') {
          const inner = this.parseExpr(0);
          this.expectPunct(')');
          return inner;
        }
        if (t.value === '[') return this.parseListLiteral();
        throw this.err(`unexpected "${t.value}"`);
      case 'ident': {
        const kw = t.value.toLowerCase();
        if (kw === 'the') return this.parseThe();
        if (CHUNK_KWS.has(kw)) return this.parseBareChunk(t.value as ChunkKind);
        return { kind: 'ident', name: t.value };
      }
      default:
        throw this.err('expected an expression');
    }
  }

  private parseThe(): Expr {
    let head = this.parseIdent();
    const headLine = this.tokens[this.pos - 1].line;
    let qualifier: string | undefined;
    const headLower = head.toLowerCase();
    if (['first', 'last', 'middle'].includes(headLower) && this.peek().type === 'ident' && CHUNK_KWS.has(this.peek().value.toLowerCase())) {
      qualifier = headLower;
      head = this.parseIdent();
    }
    if (['long', 'short', 'abbrev'].includes(headLower) && this.peek().type === 'ident' && this.peek().line === headLine) {
      head = headLower + this.parseIdent();
    }
    if (CHUNK_KWS.has(head.toLowerCase()) || qualifier) {
      let subject: Expr | undefined;
      if (this.isKw('of') || this.isKw('in')) {
        this.next();
        if (this.startsAtom()) {
          subject = this.parsePrimary();
          subject = this.parseChainTail(subject, this.tokens[this.pos - 1].line, true);
        }
      }
      return { kind: 'the', head: 'chunk', chain: [{ op: 'of', name: head.toLowerCase(), arg: subject, qualifier }] };
    }
    const chain: TheSegment[] = [];
    if (headLower === 'number' && (this.isKw('of') || this.isKw('in')) &&
        this.peek(1).type === 'ident' && CHUNK_COUNT_KWS.has(this.peek(1).value.toLowerCase())) {
      const op = this.next().value.toLowerCase() as 'of' | 'in';
      const ck = this.parseIdent();
      chain.push({ op, name: ck, arg: undefined });
      if (this.isKw('of') || this.isKw('in')) {
        const op2 = this.next().value.toLowerCase() as 'of' | 'in';
        const nameLine = this.peek().line;
        const name = this.parseIdent();
        let arg: Expr | undefined;
        if (this.isPunct('(')) {
          arg = { kind: 'call', callee: { kind: 'ident', name }, args: this.parseArgs() };
        } else if (this.startsAtom(nameLine)) {
          arg = this.parsePrimary();
        }
        chain.push({ op: op2, name, arg });
      }
      return { kind: 'the', head, chain };
    }
    while (!this.noOf && (this.isKw('of') || this.isKw('in'))) {
      const op = this.next().value.toLowerCase() as 'of' | 'in';
      if (this.isKw('the')) {
        chain.push({ op, name: 'the', arg: this.parsePrimary() });
        continue;
      }
      const nameLine = this.peek().line;
      const name = this.parseIdent();
      let arg: Expr | undefined;
      if (this.isPunct('(')) {
        arg = { kind: 'call', callee: { kind: 'ident', name }, args: this.parseArgs() };
      } else      if (this.isPunct('[')) {
        arg = this.parseChainTail({ kind: 'ident', name }, nameLine, true);
      } else if (this.startsAtom(nameLine)) {
        arg = this.parsePrimary();
      }
      chain.push({ op, name, arg });
    }
    return { kind: 'the', head, chain };
  }

  private startsAtom(sameLine?: number): boolean {
    const t = this.peek();
    if (sameLine !== undefined && t.line !== sameLine) return false;
    if (t.type === 'num' || t.type === 'str' || t.type === 'symbol') return true;
    if (t.type === 'punct') return t.value === '(' || t.value === '[';
    if (t.type !== 'ident') return false;
    const kw = t.value.toLowerCase();
    return ![
      'of', 'in', 'end', 'else', 'then', 'otherwise', 'to', 'down', 'is', 'contains',
      'if', 'case', 'repeat', 'while', 'return', 'exit', 'next', 'put', 'set', 'go', 'delete',
      'global', 'property', 'on', 'and', 'or', 'not', 'mod', 'div',
    ].includes(kw);
  }

  private parseBareChunk(kw: ChunkKind): Expr {
    const saved = this.noOf;
    this.noOf = true;
    try {
      let from: Expr | undefined;
      let to: Expr | undefined;
      if (!this.isKw('of') && !this.isKw('in')) {
        from = this.parseExpr(0);
        if (this.isKw('to')) {
          this.next();
          to = this.parseExpr(0);
        }
      }
      let subject: Expr | undefined;
      if (this.isKw('of') || this.isKw('in')) {
        this.next();
        if (this.startsAtom()) {
          subject = this.parsePrimary();
          subject = this.parseChainTail(subject, this.tokens[this.pos - 1].line, true);
        }
      }
      return { kind: 'chunk', obj: subject ?? from ?? { kind: 'empty' }, chunk: kw, from: subject ? from : undefined, to: subject ? to : undefined };
    } finally {
      this.noOf = saved;
    }
  }

  private parseListLiteral(): Expr {
    if (this.isPunct(']')) {
      this.next();
      return { kind: 'list', items: [] };
    }
    if (this.isPunct(':')) {
      this.next();
      this.expectPunct(']');
      return { kind: 'proplist', pairs: [] };
    }
    const first = this.parseExpr(0);
    if (this.isPunct(':')) {
      this.next();
      const pairs: [Expr, Expr][] = [[first, this.parseExpr(0)]];
      while (this.isPunct(',')) {
        this.next();
        if (this.isPunct(':')) {
          this.next();
          this.expectPunct(']');
          return { kind: 'proplist', pairs };
        }
        const key = this.parseExpr(0);
        this.expectPunct(':');
        pairs.push([key, this.parseExpr(0)]);
      }
      this.expectPunct(']');
      return { kind: 'proplist', pairs };
    }
    const items = [first];
    while (this.isPunct(',')) {
      this.next();
      items.push(this.parseExpr(0));
    }
    this.expectPunct(']');
    return { kind: 'list', items };
  }
}

export function parseLingo(source: string): Script {
  const tokens = tokenize(source);
  return new Parser(tokens).parseScript();
}

const SCRIPT_TYPE_RE = /^--\s*Type:\s*(\w+)/m;

/** Infer the Director script type from the `-- Type:` header the exporter
 *  writes above each cast script. `parseLingo` leaves type 'unknown'; the
 *  engine (and the bundle-time compiler) stamp it from this header. */
export function inferScriptType(source: string): Script['type'] {
  const tm = SCRIPT_TYPE_RE.exec(source);
  if (tm) {
    const type = tm[1].toLowerCase();
    return type === 'parent' || type === 'movie' || type === 'score' || type === 'behavior' ? type : 'unknown';
  }
  return 'unknown';
}

export function parseExpr(source: string): Expr {
  const tokens = tokenize(source);
  return new Parser(tokens).parseTopLevelExpr();
}
