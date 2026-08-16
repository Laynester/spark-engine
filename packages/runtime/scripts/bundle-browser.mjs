// Bundles @habbo/runtime into a single-file browser build people can drop on
// a site: dist/lingo-runtime.iife.js (+ .min.js). Everything (pixi, fflate,
// the Lingo engine, the <spark-player> element) is inlined; the custom element
// registers itself on import, so a site just needs:
//   <script src="lingo-runtime.iife.min.js"></script>
//   <spark-player movie="./movie.spark" ...></spark-player>
import { build } from 'esbuild';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const base = {
  entryPoints: [join(root, 'src', 'index.ts')],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  globalName: 'Spark',
  target: 'es2020',
  outdir: join(root, 'dist'),
};

await build({ ...base, entryNames: 'lingo-runtime.iife' });
await build({ ...base, entryNames: 'lingo-runtime.iife.min', minify: true });

console.log(`bundled browser build -> ${join(root, 'dist', 'lingo-runtime.iife(.min).js')}`);
