// The local server for `npm run dev`, which starts it and restarts it after a rebuild:
// this repo's ships/ and books/, the usual data folder, and the port and token dev.mjs
// chose, so the open page carries on across restarts.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// as in bin/pharos.js: node:sqlite's "experimental" warning isn't news, so drop it before the server loads
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) =>
  String(warning?.message ?? warning).includes("SQLite is an experimental feature") ? undefined : emitWarning.call(process, warning, ...rest);

const { defaultDataDir, startServer } = await import("../packages/server/dist/server.js");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const server = await startServer({
  port: Number(process.env.PHAROS_DEV_PORT),
  token: process.env.PHAROS_DEV_TOKEN,
  uiDir: join(root, "packages", "ui"), // never served: Vite serves the page
  dataDir: process.env.PHAROS_DEV_DATA || defaultDataDir(),
  libraryDirs: [root],
  envFile: join(root, ".env"), // an Anthropic key there counts when Settings and the environment have none
});
process.on("SIGTERM", () => void server.close().then(() => process.exit(0)));
