import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// Build the spark.js artifact straight from the runtime's TS source (same
// alias as vite.config.ts), so the embeddable bundle also never needs a
// pre-built runtime dist.
const runtimeSrc = fileURLToPath(new URL('../../packages/runtime/src/index.ts', import.meta.url));

// Builds src/spark.ts into a SINGLE self-contained public/spark.js (runtime +
// PixiJS inlined) — the embeddable artifact websites drop in next to the
// <spark> custom element. No app shell, no code splitting.
export default defineConfig({
  resolve: {
    alias: {
      '@habbo/runtime': runtimeSrc,
    },
  },
  build: {
    outDir: 'public',
    emptyOutDir: false,
    // The output lives IN public/ (so the dev server and dist copy serve it),
    // so don't also copy public onto itself.
    publicDir: false,
    lib: {
      entry: resolve('src/spark.ts'),
      formats: ['iife'],
      name: 'Spark',
      fileName: () => 'spark.js',
    },
    minify: false,
  },
});
