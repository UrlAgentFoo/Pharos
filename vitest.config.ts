import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Test against sources, so `npm test` needs no TypeScript build first.
    alias: [
      { find: /^@pharos\/core$/, replacement: fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)) },
      { find: /^@pharos\/contracts$/, replacement: fileURLToPath(new URL("./packages/contracts/src/index.ts", import.meta.url)) },
      { find: /^@pharos\/books$/, replacement: fileURLToPath(new URL("./packages/books/src/index.ts", import.meta.url)) },
      { find: /^@pharos\/orchestrator$/, replacement: fileURLToPath(new URL("./packages/orchestrator/src/index.ts", import.meta.url)) },
      { find: /^@pharos\/catalogue$/, replacement: fileURLToPath(new URL("./packages/catalogue/src/index.ts", import.meta.url)) },
    ],
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 300_000,
  },
});
