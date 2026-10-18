// Writes the published JSON Schemas (ship, book, plan) from the built
// @pharos/contracts into packages/contracts/schemas, for editors and tools
// outside TypeScript. A test checks the committed files stay in sync.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = join(root, "packages", "contracts");
const { PUBLISHED_SCHEMAS } = await import(join(pkg, "dist", "index.js"));
mkdirSync(join(pkg, "schemas"), { recursive: true });
for (const [file, schema] of Object.entries(PUBLISHED_SCHEMAS)) {
  writeFileSync(join(pkg, "schemas", file), JSON.stringify(schema, null, 2) + "\n");
}
console.log(`schemas: wrote ${Object.keys(PUBLISHED_SCHEMAS).join(", ")}`);
