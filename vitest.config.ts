import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Test against sources, so `npm test` needs no TypeScript build first.
    alias: [{ find: /^@pharos\/core$/, replacement: fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)) }],
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 300_000,
  },
});
