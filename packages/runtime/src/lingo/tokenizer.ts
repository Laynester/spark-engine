export type TokenType = 'ident' | 'num' | 'str' | 'symbol' | 'punct' | 'eof';

export interface Token {
  type: TokenType;
  value: string;
  line: number;
  pos: number;
}

export class LingoSyntaxError extends Error {
  constructor(message: string, public line: number) {
    super(`${message} (line ${line})`);
    this.name = 'LingoSyntaxError';
  }
}

const PUNCTUATORS = ['&&', '..', '<>', '<=', '>=', '(', ')', '[', ']', ',', ':', '.', '=', '+', '-', '*', '/', '<', '>', '&'];

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  const n = src.length;

  while (i < n) {
    const c = src[i];

    if (c === '\n') {
      line++;
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }

    if (c === '-' && src[i + 1] === '-') {
      if (src[i + 2] === '[' && src[i + 3] === '[') {
        const end = src.indexOf(']]', i + 4);
        if (end === -1) throw new LingoSyntaxError('unterminated block comment', line);
        i = end + 2;
      } else {
        while (i < n && src[i] !== '\n') i++;
      }
      continue;
    }

    if (c === '"') {
      const pos = i;
      let value = '';
      i++;
      let closed = false;
      while (i < n) {
        if (src[i] === '"') {
          if (src[i + 1] === '"') {
            value += '"';
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        if (src[i] === '\n') line++;
        value += src[i];
        i++;
      }
      if (!closed) throw new LingoSyntaxError('unterminated string literal', line);
      tokens.push({ type: 'str', value, line, pos });
      continue;
    }

    if (c === '#') {
      const pos = i;
      let value = '';
      i++;
      let j = i;
      while (j < n && (src[j] === ' ' || src[j] === '\t')) j++;
      while (j < n && /[A-Za-z0-9_.-]/.test(src[j])) {
        value += src[j];
        j++;
      }
      i = j;
      tokens.push({ type: 'symbol', value, line, pos });
      continue;
    }

    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const pos = i;
      let value = '';
      while (i < n && /[0-9]/.test(src[i])) {
        value += src[i];
        i++;
      }
      if (src[i] === '.' && /[0-9]/.test(src[i + 1] ?? '')) {
        value += '.';
        i++;
        while (i < n && /[0-9]/.test(src[i])) {
          value += src[i];
          i++;
        }
      }
      tokens.push({ type: 'num', value, line, pos });
      continue;
    }

    if (/[A-Za-z_]/.test(c)) {
      const pos = i;
      let value = '';
      while (i < n && /[A-Za-z0-9_]/.test(src[i])) {
        value += src[i];
        i++;
      }
      tokens.push({ type: 'ident', value, line, pos });
      continue;
    }

    let matched: string | undefined;
    for (const p of PUNCTUATORS) {
      if (src.startsWith(p, i)) {
        matched = p;
        break;
      }
    }
    if (matched) {
      tokens.push({ type: 'punct', value: matched, line, pos: i });
      i += matched.length;
      continue;
    }

    throw new LingoSyntaxError(`unexpected character ${JSON.stringify(c)}`, line);
  }

  tokens.push({ type: 'eof', value: '', line, pos: i });
  return tokens;
}
