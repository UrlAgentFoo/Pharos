import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { AUTHOR_HELP, runAuthorCommand } from "./author.js";
import { MCP_HELP, runMcp } from "./mcp-cli.js";
import type { Example, Plan } from "@pharos/contracts";
import { VERSION, defaultDataDir, startServer } from "./server.js";

const HELP = `Pharos ${VERSION}: scientific tools, one local app

Usage: pharos [options]

Options:
  -p, --port <n>   port to listen on (default 7860; 0 = any free port)
  -d, --data <dir> where workspaces live (default $PHAROS_HOME or ~/Pharos)
  -l, --library <dir>
                   a folder with ships/ and books/ to load (repeatable); the
                   data folder's own ships/ and books/ are always loaded
      --no-open    don't open a browser window
  -v, --version    print the version
  -h, --help       show this help

The server only listens on 127.0.0.1 and requires the secret token in the
launch URL, so other users and websites cannot reach your files.

${AUTHOR_HELP}
Examples:
  pharos warm [-l <dir>] [-d <dir>]       run every example with a \`run:\` once, so it opens instantly

${MCP_HELP}`;

function findUiDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, "..", "ui"), join(here, "..", "..", "ui", "dist")];
  const found = candidates.find((d) => existsSync(join(d, "index.html")));
  if (!found) throw new Error("Pharos UI not found. Run `npm run build` first.");
  return found;
}

function openBrowser(url: string) {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  spawn(cmd, args, { stdio: "ignore", detached: true })
    .on("error", () => console.log("Could not open a browser; open the URL above manually."))
    .unref();
}

/**
 * `pharos warm`: runs every example that says how to run itself, so their
 * results are in the (shared) cache and open instantly in the app. For
 * demo preparation and authors; it runs containers, so it's never automatic.
 */
async function warm(argv: string[]) {
  const { values } = parseArgs({ args: argv, options: { data: { type: "string", short: "d" }, library: { type: "string", short: "l", multiple: true } } });
  const server = await startServer({
    port: 0,
    uiDir: findUiDir(),
    dataDir: values.data ? resolve(values.data) : defaultDataDir(),
    libraryDirs: (values.library ?? ["."]).map((d) => resolve(d)),
  });
  const token = new URL(server.launchUrl).hash.replace(/^#token=/, "");
  const api = async <T>(path: string, method = "GET"): Promise<T> => {
    const r = await fetch(`${server.url}${path}`, { method, headers: { "x-pharos-token": token, "content-type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}) });
    const body = (await r.json()) as T & { error?: string };
    if (!r.ok) throw new Error(body.error ?? `${r.status}`);
    return body;
  };
  let failed = 0;
  try {
    const examples = (await api<Example[]>("/api/examples")).filter((e) => e.run);
    if (!examples.length) console.log("No example says how to run it (a `run:` in examples.yaml).");
    for (const e of examples) {
      const started = Date.now();
      process.stdout.write(`${e.title}: `);
      try {
        let plan = await api<Plan>(`/api/examples/${encodeURIComponent(e.id)}/prepare`, "POST");
        if (plan.status === "proposed") throw new Error(plan.problems.map((p) => p.message).join("; "));
        while (!["done", "failed", "cancelled"].includes(plan.status)) {
          await new Promise((ok) => setTimeout(ok, 1000));
          plan = await api<Plan>(`/api/plans/${plan.id}`);
        }
        if (plan.status !== "done") throw new Error(plan.error ?? plan.status);
        console.log(`ready (${Math.round((Date.now() - started) / 1000)} s)`);
      } catch (err) {
        failed++;
        console.log(`failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  } finally {
    await server.close();
  }
  process.exitCode = failed ? 1 : 0;
}

export async function main(argv = process.argv.slice(2)) {
  if (argv[0] === "mcp") return runMcp(argv.slice(1));
  if (argv[0] === "warm") return warm(argv.slice(1));
  const code = await runAuthorCommand(argv);
  if (code !== null) {
    process.exitCode = code;
    return;
  }
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: "string", short: "p", default: "7860" },
      data: { type: "string", short: "d" },
      library: { type: "string", short: "l", multiple: true },
      open: { type: "boolean", default: true },
      "no-open": { type: "boolean", default: false },
      version: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return console.log(HELP);
  if (values.version) return console.log(VERSION);

  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid port: ${values.port}`);
  const opts = {
    uiDir: findUiDir(),
    dataDir: values.data ? resolve(values.data) : defaultDataDir(),
    libraryDirs: (values.library ?? []).map((d) => resolve(d)),
  };

  let server;
  try {
    server = await startServer({ ...opts, port });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE" || port === 0) throw e;
    console.log(`Port ${port} is busy, using a free one.`);
    server = await startServer({ ...opts, port: 0 });
  }

  console.log(`Pharos ${VERSION} running at ${server.url}`);
  console.log(`Open: ${server.launchUrl}`);
  console.log(`Data: ${opts.dataDir}`);
  console.log("Press Ctrl+C to stop.");
  if (values.open && !values["no-open"]) openBrowser(server.launchUrl);

  const stop = () => {
    console.log("\nStopping Pharos.");
    server.close().then(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
