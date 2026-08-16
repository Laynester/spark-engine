// Workspace index: every `.ls` file under the workspace gets parsed (with the
// runtime's real parser) and its `on <handler>` definitions are indexed by
// lowercased name, so a call in one file resolves to its definition in
// another. Also caches each file's tokens + line starts so find-references
// doesn't re-tokenize the corpus on every request.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseLingo } from '@habbo/runtime/dist/lingo/parser.js';
import { tokenize, type Token } from '@habbo/runtime/dist/lingo/tokenizer.js';

/** Skip build/vendored dirs when walking (the corpus lives elsewhere). */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build']);

/**
 * Script types whose handlers are BARE-callable globals. The corpus exporter
 * writes a `-- Type: X` header line; Parent/Behavior/Score scripts are invoked
 * through instances (me/script("X").new()) and their handler names (exitFrame,
 * mouseDown…) are NOT cross-file callables, so only Movie Scripts feed the
 * index — that's where the 33 *_API files (String_Services_API, Object_API…)
 * with global functions live.
 */
const GLOBAL_SCRIPT_TYPES = new Set(['movie script', 'movie']);

/** The `-- Type: X` header of a script, or null when it has none. */
function scriptType(src: string): string | null {
  const m = /^--\s*Type:\s*([A-Za-z ]+)/m.exec(src.slice(0, 512));
  return m ? m[1].trim().toLowerCase() : null;
}

/** Where a handler's `on <name>` starts, found by scanning the source lines. */
export interface HandlerPos {
  line: number; // 0-based
  char: number; // 0-based
}

export interface HandlerDef extends HandlerPos {
  /** Original-case handler name. */
  name: string;
  params: string[];
  /** file:// URI of the defining script. */
  uri: string;
  /** End of the `on <name>` token (for selection ranges). */
  endChar: number;
}

/** `on <name>` positions per file — shared with the outline (documentSymbol). */
export function handlerPositions(src: string): Map<string, HandlerPos> {
  const out = new Map<string, HandlerPos>();
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*on\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(lines[i]);
    if (m && !out.has(m[1].toLowerCase())) {
      out.set(m[1].toLowerCase(), { line: i, char: lines[i].indexOf('on ') });
    }
  }
  return out;
}

/** Character offset of each line start (line 0 starts at 0). */
function lineStarts(src: string): number[] {
  const out = [0];
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\n') out.push(i + 1);
  }
  return out;
}

export class WorkspaceIndex {
  /** lower(handler name) -> definitions (usually one). */
  private defs = new Map<string, HandlerDef[]>();
  /** uri -> the handler names that file defines (for incremental updates). */
  private byFile = new Map<string, Set<string>>();
  /** uri -> cached tokens, used for find-references. */
  private tokens = new Map<string, Token[]>();
  /** uri -> line-start offsets, to convert token offsets into columns. */
  private lines = new Map<string, number[]>();
  private roots: string[] = [];
  private scanning = false;

  /** Where to look for `.ls` files (workspace folders from initialize). */
  setRoots(roots: string[]): void {
    this.roots = roots;
  }

  lookup(name: string): HandlerDef[] {
    return this.defs.get(name.toLowerCase()) ?? [];
  }

  handlerNames(): IterableIterator<string> {
    return this.defs.keys();
  }

  tokensOf(uri: string): Token[] {
    return this.tokens.get(uri) ?? [];
  }

  lineStartsOf(uri: string): number[] {
    return this.lines.get(uri) ?? [0];
  }

  indexedUris(): IterableIterator<string> {
    return this.byFile.keys();
  }

  /**
   * Parse a file into the index. Pass `src` for open documents so unsaved
   * edits are indexed; otherwise the file is re-read from disk.
   */
  indexFile(uri: string, src?: string): void {
    this.dropFile(uri);
    if (src === undefined) {
      try {
        src = readFileSync(fileURLToPath(uri), 'utf8');
      } catch {
        return;
      }
    }
    this.tokens.set(uri, safeTokens(src));
    this.lines.set(uri, lineStarts(src));
    // Only global-function scripts (Movie Scripts) contribute definitions;
    // everything else is still token-cached for find-references.
    if (!GLOBAL_SCRIPT_TYPES.has(scriptType(src) ?? '')) return;
    let script;
    try {
      script = parseLingo(src);
    } catch {
      return; // parse errors are surfaced via diagnostics on open; skip here
    }
    const positions = handlerPositions(src);
    const names = new Set<string>();
    for (const h of script.handlers) {
      const pos = positions.get(h.name.toLowerCase());
      if (!pos) continue;
      const lower = h.name.toLowerCase();
      names.add(lower);
      const def: HandlerDef = {
        name: h.name,
        params: h.params,
        uri,
        line: pos.line,
        char: pos.char,
        endChar: pos.char + h.name.length + 3,
      };
      const arr = this.defs.get(lower) ?? [];
      arr.push(def);
      this.defs.set(lower, arr);
    }
    this.byFile.set(uri, names);
  }

  /** Remove every definition a file contributed. */
  dropFile(uri: string): void {
    const names = this.byFile.get(uri);
    if (names) {
      for (const n of names) {
        const arr = this.defs.get(n);
        if (!arr) continue;
        const rest = arr.filter((d) => d.uri !== uri);
        if (rest.length) this.defs.set(n, rest);
        else this.defs.delete(n);
      }
    }
    this.byFile.delete(uri);
    this.tokens.delete(uri);
    this.lines.delete(uri);
  }

  /**
   * Full workspace scan. Walks the roots collecting `.ls` files, then indexes
   * them in batches so the message loop stays responsive (600+ corpus files).
   */
  async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    const files: string[] = [];
    const walk = (dir: string): void => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) walk(full);
        } else if (e.isFile() && e.name.endsWith('.ls')) {
          files.push(full);
        }
      }
    };
    for (const r of this.roots) {
      try {
        walk(fileURLToPath(r));
      } catch {
        // root not readable (deleted / not a file URL) — skip it
      }
    }
    for (let i = 0; i < files.length; i += 40) {
      const batch = files.slice(i, i + 40);
      for (const f of batch) this.indexFile(pathToFileURL(f).href);
      // Yield so pending requests (hover, diagnostics…) aren't starved.
      await new Promise((r) => setTimeout(r, 0));
    }
    this.scanning = false;
  }
}

function safeTokens(src: string): Token[] {
  try {
    return tokenize(src);
  } catch {
    return [];
  }
}
