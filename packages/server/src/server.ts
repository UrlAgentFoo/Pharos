import { spawnSync } from "node:child_process";
import { type FSWatcher, createReadStream, watch } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, platform } from "node:os";
import { basename, extname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { Library, type TrustLookup, hasErrors, resolveBook } from "@pharos/books";
import type { ChatTurn, ControlsLayout, Step } from "@pharos/contracts";
import { layoutControls } from "./controls.js";
import { AiError, type AiClientFactory, apiKeyFor, configDir, configView, defaultClientFactory, loadSettings, saveSettings, updateSettings } from "./ai.js";
import { SECURITY_HEADERS, isAllowedHost, isAllowedOrigin, newToken, tokenMatches } from "./security.js";
import { CatalogueHolder, bookCards } from "./catalogue.js";
import { Orchestration, OrchestrationError, TrustStore } from "./orchestration.js";
import { ExampleError, exampleImage, examplePlan, loadExample, loadExamples, publicExample } from "./examples.js";
import { installFrom } from "./install.js";
import { PreviewError, caseSummary, imageAsTiff } from "./preview.js";
import { Plans } from "./plans.js";
import { WorkspaceError, WorkspaceStore } from "./workspaces.js";

export const VERSION = "0.1.0";

export interface ServerOptions {
  /** 0 picks a free port. */
  port?: number;
  /** Directory with the built UI (index.html + assets). */
  uiDir: string;
  /** Fixed token, for tests. A random one is generated otherwise. */
  token?: string;
  /** Where settings (including a saved API key) live. Defaults to ~/.config/pharos. */
  configDir?: string;
  /** Creates the Anthropic client; tests pass a fake. */
  aiClient?: AiClientFactory;
  /** A `.env` file whose ANTHROPIC_API_KEY counts when neither Settings nor the environment has a key; read each time it's needed. */
  envFile?: string;
  /** Where workspaces (artifacts, runs, cache) live. Defaults to $PHAROS_HOME or ~/Pharos. */
  dataDir?: string;
  /**
   * Folders holding `ships/` and `books/`, searched in order before the data
   * folder's own. Earlier folders win when two hold the same version.
   */
  libraryDirs?: string[];
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
};

/** Content types for artifact downloads, by format. */
const FORMAT_MIME: Record<string, string> = {
  tiff: "image/tiff",
  "ome-tiff": "image/tiff",
  csv: "text/csv; charset=utf-8",
  json: "application/json",
  mp4: "video/mp4",
};

/** Default data folder: $PHAROS_HOME, or ~/Pharos. */
export function defaultDataDir(): string {
  return process.env.PHAROS_HOME ?? join(homedir(), "Pharos");
}

const MAX_JSON_BODY = 1 << 20;
const MAX_FILE_BODY = 4 * 1024 ** 3;

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const token = opts.token ?? newToken();
  const settingsDir = opts.configDir ?? configDir();
  const makeClient = opts.aiClient ?? defaultClientFactory;
  /** The assistant's Controls layouts, by book version, action, artifact, request and model. */
  const controlLayouts = new Map<string, Promise<{ layout: ControlsLayout; model?: string }>>();
  const dataDir = opts.dataDir ?? defaultDataDir();
  // library is set up just below; files are only imported once the server runs
  const workspaces = new WorkspaceStore(dataDir, async () => (await library.get()).formats());
  const trust = await TrustStore.load(dataDir);
  const libraryDirs = [...(opts.libraryDirs ?? []), dataDir].map((d) => resolve(d));
  const library = new LibraryHolder(libraryDirs, trust.get);
  const orch = new Orchestration(dataDir, workspaces, () => library.get(), trust);
  const catalogue = new CatalogueHolder(() => library.get(), trust, () => orch.gpu());
  const plans = new Plans(dataDir, workspaces, () => library.get(), catalogue, orch);
  void orch.refreshStatus();
  let port = 0;

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const known = err instanceof HttpError || err instanceof AiError || err instanceof WorkspaceError || err instanceof OrchestrationError || err instanceof ExampleError || err instanceof PreviewError;
      const status = known ? err.status : 500;
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
          capabilities: { filesystem: true, ai: true, python: detectPython() },
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
      case "GET /api/ai/config":
        return sendJson(res, 200, configView(await loadSettings(settingsDir), opts.envFile));
      case "PUT /api/ai/config": {
        const next = updateSettings(await loadSettings(settingsDir), await readJson(req));
        await saveSettings(settingsDir, next);
        return sendJson(res, 200, configView(next, opts.envFile));
      }
      case "GET /api/workspaces":
        return sendJson(res, 200, await workspaces.list());
      case "POST /api/workspaces": {
        const { name } = await readJson<{ name?: unknown }>(req);
        if (typeof name !== "string") throw new HttpError(400, "name must be a string");
        return sendJson(res, 200, await workspaces.create(name.trim()));
      }
      case "GET /api/library/books":
        return sendJson(res, 200, (await library.get()).bookEntries());
      case "GET /api/library/cards": {
        const lib = await library.get();
        return sendJson(res, 200, bookCards(lib, await orch.inventory(lib.shipManifests())));
      }
      case "GET /api/library/formats":
        return sendJson(res, 200, (await library.get()).formats());
      case "POST /api/library/books": {
        const { source } = await readJson<{ source?: unknown }>(req);
        if (typeof source !== "string") throw new HttpError(400, "source is required: a folder or a git URL");
        const installed = await installFrom(source.trim(), dataDir, await library.get());
        orch.emit({ type: "library", change: "books" });
        return sendJson(res, 200, { installed });
      }
      case "GET /api/library/ships":
        return sendJson(res, 200, (await library.get()).shipEntries());
      case "GET /api/library/issues":
        return sendJson(res, 200, (await library.get()).issues());
      case "GET /api/catalogue/stats":
        return sendJson(res, 200, (await catalogue.get()).index.stats());
      case "GET /api/catalogue/search": {
        const p = url.searchParams;
        const type = p.get("type");
        return sendJson(res, 200, (await catalogue.get()).index.search({
          text: p.get("text") ?? undefined,
          type: type === "ship" || type === "book" ? type : undefined,
          tag: p.get("tag") ?? undefined,
          limit: Math.min(100, Number(p.get("limit") ?? 50)),
        }));
      }
      case "POST /api/inspect": {
        const { workspace, artifact } = await readJson<{ workspace?: unknown; artifact?: unknown }>(req);
        if (typeof workspace !== "string" || typeof artifact !== "string") throw new HttpError(400, "workspace and artifact are required");
        return sendJson(res, 200, await catalogue.summary(workspaces, workspace, artifact));
      }
      case "POST /api/match": {
        const { workspace, artifacts, text } = await readJson<{ workspace?: unknown; artifacts?: unknown; text?: unknown }>(req);
        if (typeof workspace !== "string" || !Array.isArray(artifacts)) throw new HttpError(400, "workspace and artifacts are required");
        return sendJson(res, 200, await catalogue.match(workspaces, workspace, artifacts.map(String), typeof text === "string" ? text : undefined));
      }
      case "POST /api/plans": {
        const body = await readJson<{ workspace?: unknown; from?: unknown; book?: unknown; version?: unknown; action?: unknown; inputs?: unknown; parameters?: unknown }>(req);
        if (typeof body.workspace !== "string") throw new HttpError(400, "workspace is required");
        if (body.from === "steps") {
          const b = body as { title?: unknown; inputs?: unknown; steps?: unknown };
          if (!Array.isArray(b.steps) || !b.steps.length) throw new HttpError(400, "steps are required");
          const plan = await plans.improvised({ workspace: body.workspace, title: typeof b.title === "string" ? b.title : "Steps", inputs: (b.inputs ?? {}) as Record<string, string>, steps: b.steps as Step[] });
          return sendJson(res, 200, plan);
        }
        if (body.from !== "book" || typeof body.book !== "string") throw new HttpError(400, 'make plans { from: "book" } or { from: "steps" }');
        const plan = await plans.fromBook(body.workspace, body.book, (body.inputs ?? {}) as Record<string, string>, (body.parameters ?? {}) as Record<string, number | string | boolean>, typeof body.version === "string" ? body.version : undefined, typeof body.action === "string" ? body.action : undefined);
        return sendJson(res, 200, plan);
      }
      case "GET /api/examples":
        return sendJson(res, 200, (await loadExamples(libraryDirs)).map(publicExample));
      case "POST /api/assistant/plan": {
        const body = await readJson<{ workspace?: unknown; text?: unknown; artifacts?: unknown; history?: unknown }>(req);
        if (typeof body.workspace !== "string" || typeof body.text !== "string" || !Array.isArray(body.artifacts)) throw new HttpError(400, "workspace, text and artifacts are required");
        // the conversation so far: its last turns, each kept short
        const history: ChatTurn[] = (Array.isArray(body.history) ? body.history : [])
          .flatMap((t: { role?: unknown; text?: unknown }): ChatTurn[] =>
            (t?.role === "user" || t?.role === "assistant") && typeof t.text === "string" && t.text.trim() ? [{ role: t.role, text: t.text.trim().slice(0, 4000) }] : [],
          )
          .slice(-20);
        const settings = await loadSettings(settingsDir);
        let client;
        try {
          client = makeClient(apiKeyFor(settings, opts.envFile));
        } catch {
          throw new HttpError(400, "No API key configured. Add one in Settings.");
        }
        return sendJson(res, 200, await plans.withAssistant(body.workspace, body.text.trim().slice(0, 4000), body.artifacts.map(String), { client, model: settings.model }, history));
      }
      case "POST /api/assistant/controls": {
        const body = await readJson<{ workspace?: unknown; artifact?: unknown; book?: unknown; action?: unknown; request?: unknown }>(req);
        if (typeof body.workspace !== "string" || typeof body.artifact !== "string" || typeof body.book !== "string" || typeof body.action !== "string") {
          throw new HttpError(400, "workspace, artifact, book and action are required");
        }
        const loaded = (await library.get()).book(body.book);
        if (!loaded?.manifest) throw new HttpError(404, `no book "${body.book}"`);
        const settings = await loadSettings(settingsDir);
        const request = typeof body.request === "string" ? body.request.trim().slice(0, 2000) : undefined;
        // artifact ids are content hashes, so one layout serves the same data wherever it opens
        const key = JSON.stringify([loaded.manifest.id, loaded.manifest.version, body.action, body.artifact, request ?? "", settings.model]);
        let laid = controlLayouts.get(key);
        if (!laid) {
          let client;
          try {
            client = makeClient(apiKeyFor(settings, opts.envFile));
          } catch {
            throw new HttpError(400, "No API key configured. Add one in Settings.");
          }
          const summary = await catalogue.summary(workspaces, body.workspace, body.artifact).catch(() => undefined);
          laid = layoutControls(client, settings.model, { book: loaded.manifest, action: body.action, guide: loaded.guide, summary, request });
          laid.catch(() => controlLayouts.delete(key)); // a failure isn't kept
          controlLayouts.set(key, laid);
        }
        return sendJson(res, 200, await laid);
      }
      case "GET /api/status":
        return sendJson(res, 200, await orch.refreshStatus());
      case "GET /api/events":
        return events(req, res);
      case "GET /api/jobs":
        return sendJson(res, 200, orch.jobs());
      case "POST /api/jobs": {
        const body = await readJson<{ workspace?: unknown; tool?: unknown; version?: unknown; inputs?: unknown; params?: unknown; force?: unknown }>(req);
        if (typeof body.workspace !== "string" || typeof body.tool !== "string") throw new HttpError(400, "workspace and tool are required");
        const job = await orch.run({
          workspace: body.workspace,
          tool: body.tool,
          version: typeof body.version === "string" ? body.version : undefined,
          inputs: (body.inputs ?? {}) as Record<string, string>,
          params: (body.params ?? {}) as Record<string, number | string | boolean>,
          force: body.force === true,
        });
        return sendJson(res, 200, job);
      }
      case "GET /api/storage":
        return sendJson(res, 200, await orch.storage());
      case "DELETE /api/cache":
        return sendJson(res, 200, await orch.clearCache());
      default: {
        const prepare = url.pathname.match(/^\/api\/examples\/([^/]+)\/prepare$/);
        if (prepare && req.method === "POST") {
          const plan = await examplePlan(libraryDirs, decodeURIComponent(prepare[1]), workspaces, plans, await library.get());
          return sendJson(res, 200, hasErrors(plan.problems) ? plan : (await plans.approve(plan.id)).plan);
        }
        const picture = url.pathname.match(/^\/api\/examples\/([^/]+)\/image$/);
        if (picture && req.method === "GET") {
          const { data, type } = await exampleImage(libraryDirs, decodeURIComponent(picture[1]));
          return sendBytes(res, data, type);
        }
        const example = url.pathname.match(/^\/api\/examples\/([^/]+)\/load$/);
        if (example && req.method === "POST") {
          const { workspace } = await readJson<{ workspace?: unknown }>(req);
          if (typeof workspace !== "string") throw new HttpError(400, "workspace is required");
          return sendJson(res, 200, await loadExample(libraryDirs, decodeURIComponent(example[1]), workspaces, workspace));
        }
        if (url.pathname.startsWith("/api/jobs/")) return jobApi(req, res, url, route);
        if (url.pathname.startsWith("/api/plans/")) return planApi(req, res, url, route);
        if (/^\/api\/(library|books|ships)\//.test(url.pathname)) return libraryApi(req, res, url, route);
        return workspaceApi(req, res, url, route);
      }
    }
  }

  /** Routes for one ship or book. */
  async function libraryApi(req: IncomingMessage, res: ServerResponse, url: URL, route: string) {
    const lib = await library.get();
    let m = url.pathname.match(/^\/api\/library\/(books|ships)\/([^/]+)$/);
    if (m && req.method === "GET") {
      const id = decodeURIComponent(m[2]);
      const version = url.searchParams.get("version") ?? undefined;
      if (m[1] === "books") {
        const book = lib.book(id, version);
        if (!book?.manifest) throw new HttpError(404, `no book "${id}"${version ? ` ${version}` : ""} in the library`);
        const entry = lib.bookEntries().find((e) => e.id === id && e.version === book.manifest!.version)!;
        return sendJson(res, 200, { manifest: book.manifest, guide: book.guide ?? "", entry, accepts: book.accepts ?? [] });
      }
      const ship = lib.ship(id, version);
      if (!ship) throw new HttpError(404, `no ship "${id}"${version ? ` ${version}` : ""} in the library`);
      return sendJson(res, 200, { manifest: ship, entry: lib.shipEntries().find((e) => e.id === id && e.version === ship.version)! });
    }
    m = url.pathname.match(/^\/api\/books\/([^/]+)\/resolve$/);
    if (m && req.method === "POST") {
      const { version } = await readJson<{ version?: string }>(req);
      const book = lib.book(decodeURIComponent(m[1]), version);
      if (!book?.manifest) throw new HttpError(404, `no book "${decodeURIComponent(m[1])}" in the library`);
      const inventory = await orch.inventory(Object.entries(book.manifest.ships).flatMap(([id, range]) => lib.ship(id, range) ?? []));
      return sendJson(res, 200, resolveBook(book.manifest, lib, inventory, { gpu: orch.gpu() }));
    }
    m = url.pathname.match(/^\/api\/books\/([^/]+)\/get-ready$/);
    if (m && req.method === "POST") {
      const { version } = await readJson<{ version?: string }>(req);
      return sendJson(res, 200, await orch.getReady(decodeURIComponent(m[1]), version));
    }
    m = url.pathname.match(/^\/api\/books\/([^/]+)\/test$/);
    if (m && req.method === "POST") {
      const { version } = await readJson<{ version?: string }>(req);
      return sendJson(res, 200, await plans.testBook(decodeURIComponent(m[1]), version));
    }
    m = url.pathname.match(/^\/api\/ships\/([^/]+)\/test$/);
    if (m && req.method === "POST") {
      const { version } = await readJson<{ version?: string }>(req);
      return sendJson(res, 200, await orch.testShip(decodeURIComponent(m[1]), version));
    }
    m = url.pathname.match(/^\/api\/ships\/([^/]+)\/([^/]+)$/);
    if (m && req.method === "DELETE") {
      return sendJson(res, 200, await orch.removeShip(decodeURIComponent(m[1]), decodeURIComponent(m[2]), url.searchParams.get("force") === "1"));
    }
    throw new HttpError(404, `no route ${route}`);
  }

  async function planApi(req: IncomingMessage, res: ServerResponse, url: URL, route: string) {
    const m = url.pathname.match(/^\/api\/plans\/([^/]+)(?:\/(approve|cancel|save-as-book))?$/);
    if (!m) throw new HttpError(404, `no route ${route}`);
    const id = decodeURIComponent(m[1]);
    if (req.method === "GET" && !m[2]) return sendJson(res, 200, plans.get(id));
    if (req.method === "PUT" && !m[2]) return sendJson(res, 200, await plans.update(id, await readJson(req)));
    if (req.method === "POST" && m[2] === "approve") return sendJson(res, 200, await plans.approve(id));
    if (req.method === "POST" && m[2] === "cancel") return sendJson(res, 200, await plans.cancel(id));
    if (req.method === "POST" && m[2] === "save-as-book") {
      const body = await readJson<{ id?: unknown; title?: unknown; summary?: unknown; action?: { name?: unknown; title?: unknown } }>(req);
      if (typeof body.id !== "string" || typeof body.title !== "string" || typeof body.summary !== "string") throw new HttpError(400, "id, title and summary are required");
      const action = body.action;
      if (typeof action?.name !== "string" || typeof action.title !== "string") throw new HttpError(400, "action needs a name and a title");
      return sendJson(res, 200, await plans.saveAsBook(id, { id: body.id, title: body.title, summary: body.summary, action: { name: action.name, title: action.title } }));
    }
    throw new HttpError(404, `no route ${route}`);
  }

  async function jobApi(req: IncomingMessage, res: ServerResponse, url: URL, route: string) {
    const m = url.pathname.match(/^\/api\/jobs\/([^/]+)(?:\/(cancel|rerun))?$/);
    if (!m) throw new HttpError(404, `no route ${route}`);
    if (req.method === "GET" && !m[2]) return sendJson(res, 200, orch.job(m[1]));
    if (req.method === "POST" && m[2] === "cancel") return sendJson(res, 200, orch.cancel(m[1]));
    if (req.method === "POST" && m[2] === "rerun") return sendJson(res, 200, orch.rerun(m[1]));
    throw new HttpError(404, `no route ${route}`);
  }

  /** Server-sent events: one JSON ServerEvent per message, for as long as the page is open. */
  function events(req: IncomingMessage, res: ServerResponse) {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    res.write(": connected\n\n");
    const send = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 20_000);
    orch.events.on("event", send);
    req.on("close", () => {
      clearInterval(heartbeat);
      orch.events.off("event", send);
    });
  }

  /** Routes under /api/workspaces/:name/artifacts. */
  async function workspaceApi(req: IncomingMessage, res: ServerResponse, url: URL, route: string) {
    const m = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/artifacts(?:\/([^/]+)(\/content|\/image|\/case)?)?$/);
    if (!m) throw new HttpError(404, `no route ${route}`);
    const name = decodeURIComponent(m[1]);
    const [id, content] = [m[2], m[3] === "/content"];
    if (req.method === "GET" && id && m[3] === "/image") {
      const tiff = await imageAsTiff(await workspaces.get(name, id));
      return sendBytes(res, Buffer.from(tiff.buffer, tiff.byteOffset, tiff.byteLength), "image/tiff");
    }
    if (req.method === "GET" && id && m[3] === "/case") return sendJson(res, 200, await caseSummary(await workspaces.get(name, id)));
    if (req.method === "GET" && !id) return sendJson(res, 200, await workspaces.artifacts(name));
    if (req.method === "POST" && !id) {
      const body = await readJson<{ path?: unknown; name?: unknown }>(req);
      const path = requirePath(typeof body.path === "string" ? body.path : null);
      return sendJson(res, 200, await workspaces.importPath(name, path, typeof body.name === "string" ? body.name : undefined));
    }
    if (req.method === "PUT" && id === "upload" && !content) {
      const filename = url.searchParams.get("name") ?? "";
      const declared = Number(req.headers["content-length"] ?? 0);
      if (declared > MAX_FILE_BODY) throw new HttpError(413, "file too large to upload; add it by path instead");
      return sendJson(res, 200, await workspaces.importStream(name, filename, req));
    }
    if (req.method === "GET" && id && !content) return sendJson(res, 200, await workspaces.get(name, id));
    if (req.method === "GET" && id && content) {
      const a = await workspaces.get(name, id);
      const s = await stat(a.uri);
      if (!s.isFile()) throw new HttpError(400, `${a.name ?? a.id} is a folder (${a.format}); open it with a viewer that reads folders`);
      res.writeHead(200, { "Content-Type": FORMAT_MIME[a.format] ?? "application/octet-stream", "Content-Length": s.size });
      createReadStream(a.uri).pipe(res);
      return;
    }
    throw new HttpError(404, `no route ${route}`);
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
        library.close();
        catalogue.close();
        server.closeAllConnections();
        // warm containers go too, so none outlive the server
        server.close(() => void orch.close().finally(ok));
      }),
  };
}

// ---------------------------------------------------------------- library

/**
 * Keeps the loaded library, reloading it after a ship or book changes on
 * disk. Where a folder can't be watched (or doesn't exist yet) it reloads
 * on every request instead, which is cheap for a local library.
 */
class LibraryHolder {
  private loading: Promise<Library> | undefined;
  private readonly watchers: FSWatcher[] = [];
  private watched = true;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly dirs: string[],
    private readonly trust: TrustLookup,
  ) {
    for (const dir of dirs) {
      for (const sub of ["ships", "books"]) {
        try {
          const w = watch(join(dir, sub), { recursive: true }, () => this.changed());
          w.on("error", () => (this.watched = false));
          this.watchers.push(w);
        } catch {
          // a folder that doesn't exist yet (or can't be watched) may appear later: just reload each time
          this.watched = false;
        }
      }
    }
  }

  get(): Promise<Library> {
    if (!this.watched) this.loading = undefined;
    this.loading ??= Library.load(this.dirs, this.trust);
    return this.loading;
  }

  private changed() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => (this.loading = undefined), 100);
  }

  close() {
    clearTimeout(this.timer);
    for (const w of this.watchers) w.close();
  }
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
