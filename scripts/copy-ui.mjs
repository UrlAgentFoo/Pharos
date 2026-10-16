// Copies the built UI into the server package so `npx pharos` ships it.
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "packages", "ui", "dist");
const dest = join(root, "packages", "server", "ui");
if (!existsSync(join(src, "index.html"))) {
  console.error("UI is not built; run `npm run build -w @pharos/ui` first.");
  process.exit(1);
}
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
console.log(`ui: copied to ${dest}`);
