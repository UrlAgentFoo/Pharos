// `npm run dev`: Pharos with live changes. Vite serves the UI from its sources, so edits
// to packages/ui (and to core and contracts, which it imports as sources) show at once,
// and it passes /api to the local server. An edit to a package the server runs rebuilds
// that package and restarts the server with the same token, so the open page carries on.
//
//   npm run dev [-- --data <dir>] [-- --no-open]
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, statSync, watch } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createServer } from "vite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({ options: { data: { type: "string", short: "d" }, "no-open": { type: "boolean", default: false } } });

// what the server runs, in build order: [folder, package name]
const BACKEND = [
  ["contracts", "@pharos/contracts"],
  ["books", "@pharos/books"],
  ["orchestrator", "@pharos/orchestrator"],
  ["core", "@pharos/core"],
  ["catalogue", "@pharos/catalogue"],
  ["server", "pharos-lab"],
];

const run = (cmd, args) =>
  new Promise((done) => spawn(cmd, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" }).on("exit", (code) => done(code === 0)));

const newest = (dir) =>
  !existsSync(dir) ? 0 : Math.max(0, ...readdirSync(dir, { recursive: true }).map((f) => statSync(join(dir, String(f))).mtimeMs));

/** Builds these packages, in build order; false when one fails. */
async function build(folders) {
  for (const [folder, name] of BACKEND.filter(([f]) => folders.includes(f))) {
    console.log(`dev: building ${name}…`);
    // the server's own build also copies the built UI in, for `npm start`; here Vite serves the UI
    const ok = folder === "server" ? await run(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", "packages/server"]) : await run("npm", ["run", "build", "-w", name]);
    if (!ok) return false;
  }
  return true;
}

// first, rebuild any package whose sources are newer than its build
const stale = BACKEND.map(([f]) => f).filter((f) => newest(join(root, "packages", f, "src")) > newest(join(root, "packages", f, "dist")));
if (!(await build(stale))) {
  console.error("dev: the build failed; fix the errors above and run `npm run dev` again.");
  process.exit(1);
}

// one port and token for the whole session, so the page keeps working across restarts
const token = randomBytes(24).toString("base64url");
const apiPort = await new Promise((done) => {
  const probe = createNetServer().listen(0, "127.0.0.1", () => {
    const { port } = probe.address();
    probe.close(() => done(port));
  });
});

let api = null;
function startApi() {
  api = spawn(process.execPath, [join(root, "scripts", "dev-server.mjs")], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, PHAROS_DEV_PORT: String(apiPort), PHAROS_DEV_TOKEN: token, ...(values.data ? { PHAROS_DEV_DATA: resolve(values.data) } : {}) },
  });
}
function stopApi() {
  const child = api;
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((done) => {
    child.once("exit", done);
    child.kill("SIGTERM");
  });
}
startApi();

/** Whether an Origin header is the dev page's own (loopback, on the port Vite got). */
function isPage(origin) {
  try {
    const u = new URL(origin);
    return ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) && u.port === String(vite.httpServer?.address()?.port);
  } catch {
    return false;
  }
}

const vite = await createServer({
  root: join(root, "packages", "ui"),
  configFile: join(root, "packages", "ui", "vite.config.ts"),
  server: {
    host: "127.0.0.1",
    open: values["no-open"] ? false : `/#token=${token}`,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
        // the server refuses other origins: the page's own requests pass as the server's, any other origin stays as it is
        configure: (proxy) =>
          proxy.on("proxyReq", (req) => {
            const origin = req.getHeader("origin");
            if (typeof origin === "string" && isPage(origin)) req.setHeader("origin", `http://127.0.0.1:${apiPort}`);
          }),
      },
    },
  },
});
await vite.listen();
console.log(`\nPharos (dev) at ${vite.resolvedUrls.local[0]}#token=${token}`);
console.log("UI changes show at once; server-side changes rebuild that package and restart the server. Ctrl+C stops.\n");

// server-side sources: rebuild what changed (dependents load its new build at runtime), then restart
const changed = new Set();
let timer = null;
let rebuilding = false;
async function rebuild() {
  if (rebuilding) return;
  rebuilding = true;
  while (changed.size) {
    const folders = [...changed];
    changed.clear();
    if (await build(folders)) {
      await stopApi();
      startApi();
      console.log("dev: server restarted");
    } else console.log("dev: the build failed; the server keeps running the last good build");
  }
  rebuilding = false;
}
for (const [folder] of BACKEND)
  watch(join(root, "packages", folder, "src"), { recursive: true }, () => {
    changed.add(folder);
    clearTimeout(timer);
    timer = setTimeout(rebuild, 200);
  });

const stop = async () => {
  await Promise.all([stopApi(), vite.close()]);
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
