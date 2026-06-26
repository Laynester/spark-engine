import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  publicDir: false,
  server: {
    port: 3000,
    open: true,
  },
  build: {
    outDir: "dist",
  },
});
