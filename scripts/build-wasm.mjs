// Builds the Rust kernels to WebAssembly and copies the module into
// @pharos/core, which ships it to both the browser and the Node server.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = join(root, "kernels", "Cargo.toml");
const built = join(root, "kernels", "target", "wasm32-unknown-unknown", "release", "pharos_kernels.wasm");
const dest = join(root, "packages", "core", "wasm", "pharos_kernels.wasm");

execFileSync("cargo", ["build", "--release", "--target", "wasm32-unknown-unknown", "--manifest-path", manifest], {
  stdio: "inherit",
});
mkdirSync(dirname(dest), { recursive: true });
copyFileSync(built, dest);
console.log(`kernels: ${dest} (${(statSync(dest).size / 1024).toFixed(1)} KiB)`);
