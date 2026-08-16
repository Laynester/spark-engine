import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// Resolve @habbo/runtime straight to its TypeScript source. Vite (esbuild)
// transpiles the runtime on the fly, so edits under packages/runtime/src/**
// hot-reload in the demo without rebuilding dist first.
const runtimeSrc = fileURLToPath(new URL('../../packages/runtime/src/index.ts', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@habbo/runtime': runtimeSrc,
    },
  },
  server: {
    port: 5173,
  },
});
