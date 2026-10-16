/**
 * Talks to the local Pharos server when the page was opened by `pharos`
 * (the launch URL carries the token in its #fragment). Without a server the
 * app runs in browser-only mode.
 */
import type { Artifact, WorkspaceInfo } from "@pharos/contracts";

export interface ServerInfo {
  version: string;
  platform: string;
  home: string;
  separator: string;
  capabilities: { filesystem: boolean; batch: boolean; ai?: boolean; python: { available: boolean; via?: string } };
}

export interface AiConfig {
  models: readonly { id: string; label: string; note: string }[];
  model: string;
  keySource: "settings" | "environment" | null;
  keyHint?: string;
}

export interface ChatReply {
  sessionId: string;
  text: string;
  steps: { command: string; params: Record<string, unknown> }[];
  open?: string;
  controls?: { title: string; commands: string[] };
  skipped: string[];
  model: string;
}

export interface AiContext {
  image?: { name?: string; dtype: string; width: number; height: number; channels: number; slices: number; frames: number; unit?: string; pixelWidth?: number };
  steps?: { command: string; params: unknown; enabled: boolean }[];
  shortcuts?: { title: string; shortcut: string }[];
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

  async batch(job: { input: string; output: string; steps: { command: string; params: unknown }[] }) {
    return (await this.json("/api/batch", "POST", job)) as { processed: { file: string; ms: number }[]; failed: { file: string; error: string }[] };
  }

  async aiConfig(): Promise<AiConfig> {
    return (await this.call("/api/ai/config")).json();
  }

  /** `apiKey: null` removes the saved key. */
  async setAiConfig(update: { model?: string; apiKey?: string | null }): Promise<AiConfig> {
    return (await this.json("/api/ai/config", "PUT", update)) as AiConfig;
  }

  /** One chat turn. Throws an Error with `status` 404 when the session has expired. */
  async chat(req: { sessionId?: string; message: string; context: AiContext; outcome?: "applied" | "dismissed" }): Promise<ChatReply> {
    return (await this.json("/api/ai/chat", "POST", req)) as ChatReply;
  }

  // ---------------------------------------------------------- workspaces and artifacts

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

  async content(workspace: string, id: string): Promise<ArrayBuffer> {
    return (await this.call(`${artifactsPath(workspace)}/${id}/content`)).arrayBuffer();
  }

  private async json(path: string, method: string, body: unknown): Promise<unknown> {
    return (await this.call(path, { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } })).json();
  }
}

const artifactsPath = (workspace: string) => `/api/workspaces/${encodeURIComponent(workspace)}/artifacts`;
