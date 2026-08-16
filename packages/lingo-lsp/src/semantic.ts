// Maps the runtime tokenizer's tokens (plus an overlay for comments, which the
// tokenizer skips) onto LSP semantic-token types.

import type { Token } from '@habbo/runtime/dist/lingo/tokenizer.js';
import { KEYWORDS } from './keywords.js';

// Order matters: these indices are what the legend sent in initialize refers to.
export const TOKEN_TYPES = [
  'keyword', 'variable', 'function', 'property',
  'string', 'number', 'comment', 'symbol',
] as const;

export type TokenTypeName = (typeof TOKEN_TYPES)[number];
export const typeIndex = (t: TokenTypeName): number => TOKEN_TYPES.indexOf(t);

// Control-flow words only — `me`, `the`, chunk kinds etc. stay variable-ish.
const KW = new Set(KEYWORDS.map((k) => k.name.toLowerCase()).filter((n) =>
  !['me', 'the', 'of', 'in', 'to', 'down', 'with', 'new', 'char', 'word', 'line', 'item', 'paragraph'].includes(n)));

export interface SemTok {
  line: number;      // 0-based
  char: number;      // 0-based
  length: number;
  type: TokenTypeName;
}

/** Name sets the classifier uses to spot call sites: lowercased builtin names
 *  and lowercased workspace global (Movie Script) handler names. */
export interface SemClassify {
  builtins: ReadonlySet<string>;
  globals: ReadonlySet<string>;
}

const NO_NAMES: ReadonlySet<string> = new Set();

/** `--` line comments and `--[[ ... ]]` blocks, honoring string literals. */
function commentRanges(src: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '"') {
      i++;
      while (i < n) {
        if (src[i] === '"') {
          if (src[i + 1] === '"') { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === '-' && src[i + 1] === '-') {
      const start = i;
      if (src[i + 2] === '[' && src[i + 3] === '[') {
        const end = src.indexOf(']]', i + 4);
        i = end === -1 ? n : end + 2;
      } else {
        while (i < n && src[i] !== '\n') i++;
      }
      out.push({ start, end: i });
      continue;
    }
    i++;
  }
  return out;
}

/** Turn a source string into absolute-position semantic tokens. Calls to
 *  known builtins / workspace globals come out as `function` so they get a
 *  color instead of blending into plain identifiers. */
export function semanticTokens(
  src: string,
  tokens: Token[],
  classify: SemClassify = { builtins: NO_NAMES, globals: NO_NAMES },
): SemTok[] {
  const out: SemTok[] = [];
  const lineStart: number[] = [0];
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\n') lineStart.push(i + 1);
  }
  const lineOf = (pos: number) => {
    let lo = 0, hi = lineStart.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStart[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    return lo;
  };

  for (const r of commentRanges(src)) {
    const line = lineOf(r.start);
    out.push({ line, char: r.start - lineStart[line], length: r.end - r.start, type: 'comment' });
  }

  let prev: Token | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'eof') continue;
    const line = lineOf(t.pos);
    if (t.type === 'punct') {
      prev = t;
      continue;
    }
    const char = t.pos - lineStart[line];
    const next = tokens[i + 1];
    let type: TokenTypeName;
    if (t.type === 'str') type = 'string';
    else if (t.type === 'num') type = 'number';
    else if (t.type === 'symbol') type = 'symbol';
    else {
      const lower = t.value.toLowerCase();
      if (KW.has(lower)) type = 'keyword';
      else if (prev && prev.type === 'ident' && prev.value.toLowerCase() === 'on') type = 'function';
      else if (prev && prev.type === 'ident' && prev.value.toLowerCase() === 'end') type = 'function';
      else if (prev && prev.type === 'ident' && prev.value.toLowerCase() === 'the') type = 'property';
      else if (prev && prev.type === 'punct' && prev.value === '.') type = 'property';
      else if (next && next.type === 'punct' && next.value === '('
        && (classify.builtins.has(lower) || classify.globals.has(lower))) type = 'function';
      else type = 'variable';
    }
    out.push({ line, char, length: t.value.length, type });
    prev = t;
  }
  return out;
}
