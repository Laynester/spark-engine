// Bundles the extension client into a single dist/extension.js with
// vscode-languageclient (and its whole dep tree) inlined — only the `vscode`
// module stays external because VS Code provides it at runtime. Result: the
// .vsix ships no node_modules at all.
import { build } from 'esbuild';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

await build({
  entryPoints: [join(root, 'src', 'extension.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  outfile: join(root, 'dist', 'extension.js'),
  logLevel: 'info',
});

console.log(`bundled client -> ${join(root, 'dist', 'extension.js')}`);
