export interface Script {
  name: string;
  type: 'parent' | 'movie' | 'score' | 'behavior' | 'unknown';
  props: string[];
  globals: string[];
  handlers: Handler[];
  source: string;
}

export interface Handler {
  name: string;
  params: string[];
  body: Stmt[];
}

export type ChunkKind = 'char' | 'word' | 'line' | 'item' | 'paragraph';

export interface TheSegment {
  op: 'of' | 'in';
  name: string;
  arg?: Expr;
  qualifier?: string;
}

export type Expr =
  | { kind: 'num'; value: number; float?: boolean }
  | { kind: 'str'; value: string }
  | { kind: 'symbol'; name: string }
  | { kind: 'ident'; name: string }
  | { kind: 'list'; items: Expr[] }
  | { kind: 'proplist'; pairs: [Expr, Expr][] }
  | { kind: 'unary'; op: 'not' | '-' | '+'; arg: Expr }
  | { kind: 'binary'; op: string; left: Expr; right: Expr }
  | { kind: 'call'; callee: Expr; args: Expr[] }
  | { kind: 'prop'; obj: Expr; name: string }
  | { kind: 'index'; obj: Expr; index: Expr }
  | { kind: 'chunk'; obj: Expr; chunk: ChunkKind; from?: Expr; to?: Expr }
  | { kind: 'chunkCount'; obj: Expr; chunk: ChunkKind }
  | { kind: 'the'; head: string; chain: TheSegment[] }
  | { kind: 'empty' };

export type Stmt =
  | { kind: 'assign'; target: Expr; value: Expr }
  | { kind: 'put'; value: Expr; into?: Expr; mode?: 'into' | 'after' | 'before' }
  | { kind: 'delete'; target: Expr }
  | { kind: 'if'; cond: Expr; then: Stmt[]; els: Stmt[] }
  | { kind: 'case'; subject: Expr; branches: { match?: Expr[]; body: Stmt[] }[] }
  | { kind: 'repeatWith'; varName: string; from: Expr; to: Expr; down: boolean; body: Stmt[] }
  | { kind: 'repeatIn'; varName: string; list: Expr; body: Stmt[] }
  | { kind: 'repeatWhile'; cond: Expr; body: Stmt[] }
  | { kind: 'exit' }
  | { kind: 'exitRepeat' }
  | { kind: 'nextRepeat' }
  | { kind: 'return'; value?: Expr; values?: Expr[] }
  | { kind: 'expr'; expr: Expr }
  | { kind: 'globalDecl'; names: string[] };

export const VOID_SYMBOL = '#void';
