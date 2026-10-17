/**
 * Talks to the local Pharos server when the page was opened by `pharos`
 * (the launch URL carries the token in its #fragment). Everything Pharos
 * does goes through it; without one the page can only say how to start it.
 */
import type { AcceptedFormats, Artifact, AssistantPlan, BookCard, ChatTurn, ControlsLayout, CaseSummary, Example, FormatInfo, Step, BookManifest, BookMatch, CatalogueEntry, CatalogueStats, DataSummary, Job, LibraryIssue, Params, Plan, Resolution, ServerEvent, ShipManifest, StorageReport, SystemStatus, TestResult, WorkspaceInfo } from "@pharos/contracts";

export interface ServerInfo {
  version: string;
  platform: string;
  home: string;
  separator: string;
  capabilities: { filesystem: boolean; ai?: boolean; python: { available: boolean; via?: string } };
}

export interface AiConfig {
  models: readonly { id: string; label: string; note: string }[];
  model: string;
  keySource: "settings" | "environment" | "file" | null;
  keyHint?: string;
  /** The `.env` file the key comes from, when it does. */
  keyFile?: string;
  /** The assistant's tokens by model, as the server counted them. */
  usage?: TokenUsage;
}

export interface TokenCount {
  requests: number;
  /** Every input token, the cached ones included. */
  input: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
  /** At list prices, in US dollars. */
  costUsd: number;
  /** Replies from a model the server has no price for, so not in `costUsd`. */
  unpriced: number;
}

export interface TokenUsage {
  /** The first day counted (YYYY-MM-DD), or null before any request. */
  since: string | null;
  today: Record<string, TokenCount>;
  total: Record<string, TokenCount>;
  /** The day the prices were read from Anthropic's pricing page. */
  pricesAsOf: string;
}

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
}

const TOKEN_KEY = "pharos-token";

function takeToken(): string | null {
  const m = location.hash.match(/token=([\w-]+)/);
  if (m) {
    try {
      sessionStorage.setItem(TOKEN_KEY, m[1]);
    } catch {
      /* storage blocked: keep the token in memory only */
    }
    history.replaceState(null, "", location.pathname + location.search); // keep the token out of the address bar
    return m[1];
  }
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export class LocalServer {
  private constructor(
    private readonly token: string,
    readonly info: ServerInfo,
  ) {}

  /** Connects to the server that launched this page, or returns null (browser-only mode). */
  static async connect(): Promise<LocalServer | null> {
    const token = takeToken();
    if (!token) return null;
    try {
      const r = await fetch("/api/info", { headers: { "x-pharos-token": token } });
      if (!r.ok) return null;
      return new LocalServer(token, await r.json());
    } catch {
      return null;
    }
  }

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    const r = await fetch(path, { ...init, headers: { "x-pharos-token": this.token, ...init.headers } });
    if (!r.ok) {
      const body = await r.json().catch(() => ({ error: r.statusText }));
      throw Object.assign(new Error(body.error ?? `HTTP ${r.status}`), { status: r.status });
    }
    return r;
  }

  async list(path?: string): Promise<{ path: string; parent: string; entries: DirEntry[] }> {
    const q = path ? `?path=${encodeURIComponent(path)}` : "";
    return (await this.call(`/api/fs/list${q}`)).json();
  }

  async read(path: string): Promise<ArrayBuffer> {
    return (await this.call(`/api/fs/read?path=${encodeURIComponent(path)}`)).arrayBuffer();
  }

  async write(path: string, data: Uint8Array, overwrite = false): Promise<void> {
    await this.call(`/api/fs/write?path=${encodeURIComponent(path)}${overwrite ? "&overwrite=1" : ""}`, {
      method: "PUT",
      body: data as BufferSource,
    });
  }

  async aiConfig(): Promise<AiConfig> {
    return (await this.call("/api/ai/config")).json();
  }

  /** `apiKey: null` removes the saved key. */
  async setAiConfig(update: { model?: string; apiKey?: string | null }): Promise<AiConfig> {
    return (await this.json("/api/ai/config", "PUT", update)) as AiConfig;
  }

  // ---------------------------------------------------------- workspaces and artifacts

  /** Saves a project as one .pharos file at `path`, with its data (and, with `results`, what its steps made). */
  async exportProject(project: unknown, path: string, results: boolean, overwrite = false): Promise<{ path: string; bytes: number; objects: number; missing: string[] }> {
    return (await this.json("/api/projects/export", "POST", { project, path, results, overwrite })) as { path: string; bytes: number; objects: number; missing: string[] };
  }

  /** Opens a .pharos file on disk: its data goes back into the workspaces, checked against its hashes. */
  async importProject(path: string): Promise<{ project: unknown; imported: number; reused: number; missing: string[] }> {
    return (await this.json("/api/projects/import", "POST", { path })) as { project: unknown; imported: number; reused: number; missing: string[] };
  }

  async workspaces(): Promise<WorkspaceInfo[]> {
    return (await this.call("/api/workspaces")).json();
  }

  /** Creates the workspace, or returns it if it exists. */
  async createWorkspace(name: string): Promise<WorkspaceInfo> {
    return (await this.json("/api/workspaces", "POST", { name })) as WorkspaceInfo;
  }

  async artifacts(workspace: string): Promise<Artifact[]> {
    return (await this.call(`${artifactsPath(workspace)}`)).json();
  }

  /** Copies a file or folder on this computer into the workspace. */
  async importPath(workspace: string, path: string): Promise<Artifact> {
    return (await this.json(artifactsPath(workspace), "POST", { path })) as Artifact;
  }

  /** Uploads a dropped or picked file into the workspace. */
  async upload(workspace: string, file: File): Promise<Artifact> {
    const r = await this.call(`${artifactsPath(workspace)}/upload?name=${encodeURIComponent(file.name)}`, { method: "PUT", body: file });
    return r.json();
  }

  /** An image or labels artifact as TIFF bytes, for the image viewer. */
  async artifactImage(workspace: string, id: string): Promise<ArrayBuffer> {
    return (await this.call(`${artifactsPath(workspace)}/${id}/image`)).arrayBuffer();
  }

  async caseSummary(workspace: string, id: string): Promise<CaseSummary> {
    return (await this.call(`${artifactsPath(workspace)}/${id}/case`)).json();
  }

  async createStepsPlan(workspace: string, title: string, inputs: Record<string, string>, steps: Step[]): Promise<Plan> {
    return (await this.json("/api/plans", "POST", { workspace, from: "steps", title, inputs, steps })) as Plan;
  }

  async artifact(workspace: string, id: string): Promise<Artifact> {
    return (await this.call(`${artifactsPath(workspace)}/${id}`)).json();
  }

  async content(workspace: string, id: string): Promise<ArrayBuffer> {
    return (await this.call(`${artifactsPath(workspace)}/${id}/content`)).arrayBuffer();
  }

  /** A media link for an artifact's file, which a <video> streams from disk without the token header. */
  async artifactLink(workspace: string, id: string): Promise<string> {
    return ((await (await this.call(`${artifactsPath(workspace)}/${id}/link`, { method: "POST" })).json()) as { url: string }).url;
  }

  // ---------------------------------------------------------- ships, jobs and storage

  async status(): Promise<SystemStatus> {
    return (await this.call("/api/status")).json();
  }

  async ships(): Promise<CatalogueEntry[]> {
    return (await this.call("/api/library/ships")).json();
  }

  async ship(id: string, version?: string): Promise<{ manifest: ShipManifest; entry: CatalogueEntry }> {
    return (await this.call(`/api/library/ships/${encodeURIComponent(id)}${version ? `?version=${encodeURIComponent(version)}` : ""}`)).json();
  }

  async runJob(req: { workspace: string; tool: string; version?: string; inputs: Record<string, string>; params?: Params; force?: boolean }): Promise<Job> {
    return (await this.json("/api/jobs", "POST", req)) as Job;
  }

  async jobs(): Promise<Job[]> {
    return (await this.call("/api/jobs")).json();
  }

  async job(id: string): Promise<Job & { log: string }> {
    return (await this.call(`/api/jobs/${encodeURIComponent(id)}`)).json();
  }

  async cancelJob(id: string): Promise<Job> {
    return (await this.json(`/api/jobs/${encodeURIComponent(id)}/cancel`, "POST", {})) as Job;
  }

  async rerunJob(id: string): Promise<Job> {
    return (await this.json(`/api/jobs/${encodeURIComponent(id)}/rerun`, "POST", {})) as Job;
  }

  async storage(): Promise<StorageReport> {
    return (await this.call("/api/storage")).json();
  }

  async clearCache(): Promise<{ freedBytes: number }> {
    return (await this.call("/api/cache", { method: "DELETE" })).json();
  }

  async removeShip(id: string, version: string, force = false): Promise<{ freedBytes: number }> {
    return (await this.call(`/api/ships/${encodeURIComponent(id)}/${encodeURIComponent(version)}${force ? "?force=1" : ""}`, { method: "DELETE" })).json();
  }

  /** Starts downloading (or building) the ships a book needs that aren't here yet. */
  async getReady(id: string): Promise<{ pulling: { id: string; version: string; image: string }[] }> {
    return (await this.json(`/api/books/${encodeURIComponent(id)}/get-ready`, "POST", {})) as { pulling: { id: string; version: string; image: string }[] };
  }

  async testShip(id: string, version?: string): Promise<TestResult> {
    return (await this.json(`/api/ships/${encodeURIComponent(id)}/test`, "POST", { version })) as TestResult;
  }

  // ---------------------------------------------------------- books, catalogue and plans

  async books(): Promise<CatalogueEntry[]> {
    return (await this.call("/api/library/books")).json();
  }

  /** Every book as its card shows it. */
  async cards(): Promise<BookCard[]> {
    return (await this.call("/api/library/cards")).json();
  }

  /** Every format Pharos recognises: built in, plus those ships declare. */
  async formats(): Promise<Record<string, FormatInfo>> {
    return (await this.call("/api/library/formats")).json();
  }

  async book(id: string, version?: string): Promise<{ manifest: BookManifest; guide: string; entry: CatalogueEntry; accepts: AcceptedFormats[] }> {
    return (await this.call(`/api/library/books/${encodeURIComponent(id)}${version ? `?version=${encodeURIComponent(version)}` : ""}`)).json();
  }

  async issues(): Promise<LibraryIssue[]> {
    return (await this.call("/api/library/issues")).json();
  }

  async installBook(source: string): Promise<{ installed: string[] }> {
    return (await this.json("/api/library/books", "POST", { source })) as { installed: string[] };
  }

  async searchCatalogue(text: string, type?: "ship" | "book"): Promise<CatalogueEntry[]> {
    return (await this.call(`/api/catalogue/search?text=${encodeURIComponent(text)}${type ? `&type=${type}` : ""}`)).json();
  }

  async catalogueStats(): Promise<CatalogueStats> {
    return (await this.call("/api/catalogue/stats")).json();
  }

  async resolveBook(id: string): Promise<Resolution> {
    return (await this.json(`/api/books/${encodeURIComponent(id)}/resolve`, "POST", {})) as Resolution;
  }

  async testBook(id: string): Promise<TestResult> {
    return (await this.json(`/api/books/${encodeURIComponent(id)}/test`, "POST", {})) as TestResult;
  }

  async match(workspace: string, artifacts: string[], text?: string): Promise<{ summaries: DataSummary[]; matches: BookMatch[] }> {
    return (await this.json("/api/match", "POST", { workspace, artifacts, text })) as { summaries: DataSummary[]; matches: BookMatch[] };
  }

  async examples(): Promise<Example[]> {
    return (await this.call("/api/examples")).json();
  }

  /** An example's picture for its card (when `image` is set). */
  async exampleImage(id: string): Promise<Blob> {
    return (await this.call(`/api/examples/${encodeURIComponent(id)}/image`)).blob();
  }

  /** Copies an example's files into the workspace. */
  async loadExample(id: string, workspace: string): Promise<Artifact[]> {
    return (await this.json(`/api/examples/${encodeURIComponent(id)}/load`, "POST", { workspace })) as Artifact[];
  }

  async createPlan(workspace: string, book: string, inputs: Record<string, string>, parameters?: Params, action?: string): Promise<Plan> {
    return (await this.json("/api/plans", "POST", { workspace, from: "book", book, action, inputs, parameters })) as Plan;
  }

  /** The assistant's layout of a book action's Controls for an artifact (the Suggested tab). */
  async controlsLayout(workspace: string, artifact: string, book: string, action: string, request?: string): Promise<{ layout: ControlsLayout; model?: string }> {
    return (await this.json("/api/assistant/controls", "POST", { workspace, artifact, book, action, request })) as { layout: ControlsLayout; model?: string };
  }

  /** The assistant's answer to a message, with the conversation so far; a plan when asked to do something. */
  async assistantPlan(workspace: string, text: string, artifacts: string[], history: ChatTurn[] = []): Promise<AssistantPlan> {
    return (await this.json("/api/assistant/plan", "POST", { workspace, text, artifacts, history })) as AssistantPlan;
  }

  async plan(id: string): Promise<Plan> {
    return (await this.call(`/api/plans/${encodeURIComponent(id)}`)).json();
  }

  async updatePlan(id: string, patch: Partial<Pick<Plan, "inputs" | "parameters" | "steps">>): Promise<Plan> {
    return (await this.json(`/api/plans/${encodeURIComponent(id)}`, "PUT", patch)) as Plan;
  }

  async approvePlan(id: string): Promise<{ plan: Plan; jobs: Job[] }> {
    return (await this.json(`/api/plans/${encodeURIComponent(id)}/approve`, "POST", {})) as { plan: Plan; jobs: Job[] };
  }

  async cancelPlan(id: string): Promise<Plan> {
    return (await this.json(`/api/plans/${encodeURIComponent(id)}/cancel`, "POST", {})) as Plan;
  }

  async saveAsBook(id: string, meta: { id: string; title: string; summary: string; action: { name: string; title: string } }): Promise<CatalogueEntry> {
    return (await this.json(`/api/plans/${encodeURIComponent(id)}/save-as-book`, "POST", meta)) as CatalogueEntry;
  }

  /**
   * Follows the server's live events (jobs, logs, downloads, status) until
   * `stop` is called, reconnecting after a dropped connection. Uses fetch
   * rather than EventSource so the token travels in a header.
   */
  events(onEvent: (e: ServerEvent) => void, onConnect?: (reconnect: boolean) => void): { stop: () => void } {
    let connections = 0;
    const abort = new AbortController();
    const loop = async () => {
      while (!abort.signal.aborted) {
        try {
          const res = await this.call("/api/events", { signal: abort.signal });
          // events sent while the stream was down are gone: the caller catches up
          onConnect?.(connections++ > 0);
          const reader = res.body!.getReader();
          const decoder = new TextDecoder();
          let buf = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let i: number;
            while ((i = buf.indexOf("\n\n")) >= 0) {
              const msg = buf.slice(0, i);
              buf = buf.slice(i + 2);
              if (msg.startsWith("data: ")) onEvent(JSON.parse(msg.slice(6)) as ServerEvent);
            }
          }
        } catch {
          /* dropped or refused: try again shortly */
        }
        if (!abort.signal.aborted) await new Promise((r) => setTimeout(r, 2000));
      }
    };
    void loop();
    return { stop: () => abort.abort() };
  }

  private async json(path: string, method: string, body: unknown): Promise<unknown> {
    return (await this.call(path, { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } })).json();
  }
}

const artifactsPath = (workspace: string) => `/api/workspaces/${encodeURIComponent(workspace)}/artifacts`;
