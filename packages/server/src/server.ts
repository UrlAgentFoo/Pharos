import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, platform } from "node:os";
import { basename, extname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { type Kernels, findCommand, loadKernels, parseParams, readTiff, runSteps, writeTiff } from "@pharos/core";
import {
  AiError,
  type AiClientFactory,
  ChatStore,
  type ChatRequest,
  configDir,
  configView,
  defaultClientFactory,
  loadSettings,
  chatTurn,
  saveSettings,
  updateSettings,
} from "./ai.js";
import { SECURITY_HEADERS, isAllowedHost, isAllowedOrigin, newToken, tokenMatches } from "./security.js";

export const VERSION = "0.1.0";

export interface ServerOptions {
  /** 0 picks a free port. */
  port?: number;
  /** Directory with the built UI (index.html + assets). */
  uiDir: string;
  /** Path to pharos_kernels.wasm. */
  wasmPath: string;
  /** Fixed token, for tests. A random one is generated otherwise. */
  token?: string;
  /** Where settings (including a saved API key) live. Defaults to ~/.config/pharos. */
  configDir?: string;
  /** Creates the Anthropic client; tests pass a fake. */
  aiClient?: AiClientFactory;
}

export interface RunningServer {
  url: string;
  /** URL including the token, which is what the browser should open. */
  launchUrl: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
};

const TIFF_EXT = new Set([".tif", ".tiff"]);
const MAX_JSON_BODY = 1 << 20;
const MAX_FILE_BODY = 4 * 1024 ** 3;

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const token = opts.token ?? newToken();
  const wasm = await readFile(opts.wasmPath);
  const kernels = await loadKernels(wasm);
  const settingsDir = opts.configDir ?? configDir();
  const makeClient = opts.aiClient ?? defaultClientFactory;
  const chats = new ChatStore();
  let port = 0;

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const status = err instanceof HttpError || err instanceof AiError ? err.status : 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
      else res.destroy();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    if (!isAllowedHost(req.headers.host, port)) throw new HttpError(421, "unexpected Host header");
    if (!isAllowedOrigin(req.headers.origin, port)) throw new HttpError(403, "cross-origin request refused");

    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      if (!tokenMatches(req, token)) throw new HttpError(401, "missing or invalid token");
      res.setHeader("Cache-Control", "no-store");
      return api(req, res, url);
    }
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "method not allowed");
    if (url.pathname === "/kernels.wasm") return sendBytes(res, wasm, MIME[".wasm"]);
    return serveStatic(res, url.pathname);
  }

  async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
    const route = `${req.method} ${url.pathname}`;
    switch (route) {
      case "GET /api/info":
        return sendJson(res, 200, {
          name: "Pharos",
          version: VERSION,
          mode: "local",
          platform: platform(),
          home: homedir(),
          separator: sep,
          capabilities: { filesystem: true, batch: true, ai: true, python: detectPython() },
        });
      case "GET /api/fs/list": {
        const dir = requirePath(url.searchParams.get("path") ?? homedir());
        const entries = await readdir(dir, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => {
          throw new HttpError(e.code === "ENOENT" ? 404 : 400, `cannot list ${dir}: ${e.code ?? e.message}`);
        });
        const items = await Promise.all(
          entries
            .filter((e) => !e.name.startsWith("."))
            .map(async (e) => {
              const p = join(dir, e.name);
              const isDir = e.isDirectory();
              const size = isDir ? 0 : await stat(p).then((s) => s.size, () => 0);
              return { name: e.name, path: p, isDir, size };
            }),
        );
        items.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
        return sendJson(res, 200, { path: dir, parent: resolve(dir, ".."), entries: items });
      }
      case "GET /api/fs/read": {
        const file = requirePath(url.searchParams.get("path"));
        const s = await stat(file).catch(() => {
          throw new HttpError(404, `not found: ${file}`);
        });
        if (!s.isFile()) throw new HttpError(400, `not a file: ${file}`);
        res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": s.size });
        createReadStream(file).pipe(res);
        return;
      }
      case "PUT /api/fs/write": {
        const file = requirePath(url.searchParams.get("path"));
        const overwrite = url.searchParams.get("overwrite") === "1";
        const body = await readBody(req, MAX_FILE_BODY);
        await writeFile(file, body, { flag: overwrite ? "w" : "wx" }).catch((e: NodeJS.ErrnoException) => {
          throw new HttpError(e.code === "EEXIST" ? 409 : 400, e.code === "EEXIST" ? `already exists: ${file}` : `cannot write ${file}: ${e.code}`);
        });
        return sendJson(res, 200, { path: file, bytes: body.length });
      }
      case "POST /api/batch": {
        const job = await readJson<BatchRequest>(req);
        return sendJson(res, 200, await runBatch(kernels, job));
      }
      case "GET /api/ai/config":
        return sendJson(res, 200, configView(await loadSettings(settingsDir)));
      case "PUT /api/ai/config": {
        const next = updateSettings(await loadSettings(settingsDir), await readJson(req));
        await saveSettings(settingsDir, next);
        return sendJson(res, 200, configView(next));
      }
      case "POST /api/ai/chat": {
        const body = await readJson<ChatRequest>(req);
        const settings = await loadSettings(settingsDir);
        let client;
        try {
          client = makeClient(settings.apiKey);
        } catch {
          throw new HttpError(400, "No API key configured. Add one in Settings.");
        }
        return sendJson(res, 200, await chatTurn(client, chats, settings.model, body));
      }
      default:
        throw new HttpError(404, `no route ${route}`);
    }
  }

  async function serveStatic(res: ServerResponse, pathname: string) {
    const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
    const file = resolve(opts.uiDir, rel || "index.html");
    if (file !== resolve(opts.uiDir) && !file.startsWith(resolve(opts.uiDir) + sep)) throw new HttpError(403, "forbidden");
    const s = await stat(file).catch(() => null);
    const target = s?.isFile() ? file : join(opts.uiDir, "index.html"); // SPA fallback
    const ext = extname(target);
    res.setHeader("Cache-Control", ext === ".html" ? "no-cache" : "public, max-age=3600");
    return sendBytes(res, await readFile(target), MIME[ext] ?? "application/octet-stream");
  }

  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(opts.port ?? 0, "127.0.0.1", () => ok());
  });
  port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    launchUrl: `${url}/#token=${token}`,
    port,
    token,
    close: () =>
      new Promise((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}

// ---------------------------------------------------------------- batch

export interface BatchRequest {
  input: string;
  output: string;
  /** The steps to run on every image, e.g. a timeline's recipe. */
  steps: { command: string; params?: unknown }[];
}

export interface BatchResult {
  processed: { file: string; output: string; ms: number }[];
  failed: { file: string; error: string }[];
}

/** Applies one operation to every TIFF in `input`, writing results to `output`. */
export async function runBatch(kernels: Kernels, job: BatchRequest): Promise<BatchResult> {
  const input = requirePath(job.input);
  const output = requirePath(job.output);
  if (resolve(input) === resolve(output)) throw new HttpError(400, "output folder must differ from input folder");
  if (!Array.isArray(job.steps) || job.steps.length === 0) throw new HttpError(400, "steps must be a non-empty list");
  // validate the whole recipe before touching any file
  for (const s of job.steps) {
    const cmd = findCommand(s?.command);
    if (!cmd) throw new HttpError(400, `unknown command ${String(s?.command)}`);
    try {
      parseParams(cmd, s.params);
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : String(e));
    }
  }
  const files = (await readdir(input).catch(() => {
    throw new HttpError(404, `cannot read folder ${input}`);
  })).filter((f) => TIFF_EXT.has(extname(f).toLowerCase()));
  await mkdir(output, { recursive: true });

  const result: BatchResult = { processed: [], failed: [] };
  for (const f of files.sort()) {
    const t0 = performance.now();
    try {
      const img = await readTiff(await readFile(join(input, f)), f);
      const out = join(output, basename(f));
      await writeFile(out, writeTiff(runSteps(img, job.steps, { kernels })));
      result.processed.push({ file: f, output: out, ms: Math.round(performance.now() - t0) });
    } catch (e) {
      if (e instanceof HttpError) throw e;
      result.failed.push({ file: f, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}

// ---------------------------------------------------------------- helpers

function requirePath(p: string | null | undefined): string {
  if (!p) throw new HttpError(400, "missing path");
  if (!isAbsolute(p)) throw new HttpError(400, `path must be absolute: ${p}`);
  return resolve(p);
}

let pythonCache: { available: boolean; via?: string } | undefined;
function detectPython() {
  if (!pythonCache) {
    const uv = spawnSync("uv", ["--version"], { encoding: "utf8" });
    pythonCache = uv.status === 0 ? { available: true, via: uv.stdout.trim() } : { available: false };
  }
  return pythonCache;
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  try {
    return JSON.parse((await readBody(req, MAX_JSON_BODY)).toString("utf8")) as T;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, "invalid JSON body");
  }
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": data.length });
  res.end(data);
}

function sendBytes(res: ServerResponse, data: Buffer, type: string) {
  res.writeHead(200, { "Content-Type": type, "Content-Length": data.length });
  res.end(data);
}
