// Bundles the Lingo language server into a single self-contained file the
// extension ships: packages/lingo-lsp/src/server.ts + the runtime's
// tokenizer/parser/keywords + vscode-languageserver, all in one .cjs.
// That way the .vsix needs no workspace packages, no symlinks, nothing.
// Output: apps/lingo-vscode/server/server.cjs
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const outDir = join(here, '..', 'server');
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [join(repo, 'packages', 'lingo-lsp', 'src', 'server.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  outfile: join(outDir, 'server.cjs'),
  logLevel: 'info',
});

console.log(`bundled server -> ${join(outDir, 'server.cjs')}`);
