import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@pharos\/core$/, replacement: fileURLToPath(new URL("../core/src/index.ts", import.meta.url)) },
      { find: /^@pharos\/contracts$/, replacement: fileURLToPath(new URL("../contracts/src/index.ts", import.meta.url)) },
    ],
  },
  server: { headers: isolation },
  preview: { headers: isolation },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
});
