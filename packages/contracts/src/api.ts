/**
 * The server API: every route the UI and the `pharos` command line call,
 * and the events the server pushes over `GET /api/events` (server-sent
 * events, one JSON `ServerEvent` per message).
 *
 * All routes need the launch token in the `x-pharos-token` header.
 */
import type { Artifact, DataSummary } from "./artifact.js";
import type { BookManifest } from "./book.js";
import type { BookMatch, CatalogueEntry, CatalogueStats } from "./catalogue.js";
import type { Job } from "./job.js";
import type { Params } from "./params.js";
import type { Plan, PlanProblem, ShipNeed } from "./plan.js";
import type { ShipManifest } from "./ship.js";

export interface SystemStatus {
  docker: { available: boolean; version?: string; error?: string };
  gpu: { available: boolean; runtime?: "nvidia"; devices?: string[]; error?: string };
  disk: { freeBytes: number; path: string };
}

/** A book resolved against this machine: what it needs and what is missing. */
export interface Resolution {
  book: { id: string; version: string };
  ships: (ShipNeed & { range: string })[];
  /** Total size of the ships still to download. */
  downloadBytes: number;
  /** False when something can't be satisfied here (missing ship version, GPU required). */
  runnable: boolean;
  problems: PlanProblem[];
}

/** A ship or book manifest with problems; errors keep it out of the library. */
export interface LibraryIssue {
  type: "ship" | "book";
  id: string;
  dir: string;
  problems: (PlanProblem & { file?: string; line?: number })[];
}

export interface StorageReport {
  ships: { id: string; version: string; image: string; sizeBytes: number; usedBy: string[] }[];
  cache: { usedBytes: number; limitBytes: number };
  artifactsBytes: number;
}

export interface TestResult {
  target: { type: "ship" | "book"; id: string; version: string };
  passed: boolean;
  /** One entry per operation (ships) or per example (books). */
  cases: { name: string; passed: boolean; message?: string; jobId?: string }[];
}

export interface WorkspaceInfo {
  name: string;
  path: string;
  artifacts: number;
}

/** What `POST /api/plans` takes: a book to run on workspace data. */
export type PlanRequest = { workspace: string; from: "book"; book: string; version?: string; inputs: Record<string, string>; parameters?: Params };

/** Example data offered on the start screen. */
export interface Example {
  id: string;
  title: string;
  /** What kind of data, e.g. "Microscopy time-lapse". */
  kind: string;
  description: string;
  /** A suggested problem statement. */
  prompt: string;
  /** The names the files get in the workspace. */
  files: string[];
}

/** What the assistant proposes for some data and a request; `plan` is null when nothing fits. */
export interface AssistantPlan {
  plan: Plan | null;
  message: string;
  matches: BookMatch[];
  model?: string;
}

/**
 * Route → request and response bodies. `:name` segments are path
 * parameters. `void` means no body.
 */
export interface ApiRoutes {
  "GET /api/status": { req: void; res: SystemStatus };

  "GET /api/library/books": { req: void; res: CatalogueEntry[] };
  /** `?version=` picks a version; the newest otherwise. `accepts` lists the formats each input takes, directly or after conversion. */
  "GET /api/library/books/:id": {
    req: void;
    res: {
      manifest: BookManifest;
      guide: string;
      entry: CatalogueEntry;
      accepts: { input: string; kind: string; direct: string[]; converted: { format: string; via: string }[] }[];
    };
  };
  /** Installs a book folder, or a library (ships/ + books/) from a folder or git URL, into the data folder. */
  "POST /api/library/books": { req: { source: string }; res: { installed: string[] } };
  "GET /api/library/ships": { req: void; res: CatalogueEntry[] };
  "GET /api/library/ships/:id": { req: void; res: { manifest: ShipManifest; entry: CatalogueEntry } };
  "GET /api/catalogue/stats": { req: void; res: CatalogueStats };
  /** `?text=&type=ship|book&tag=&limit=`: full-text search, verified first. */
  "GET /api/catalogue/search": { req: void; res: CatalogueEntry[] };
  "GET /api/library/issues": { req: void; res: LibraryIssue[] };

  "POST /api/books/:id/resolve": { req: { version?: string }; res: Resolution };
  /** Starts downloading the ships a book needs that aren't here yet; progress arrives as `pull` events. */
  "POST /api/books/:id/get-ready": { req: { version?: string }; res: { pulling: { id: string; version: string; image: string }[] } };
  "POST /api/books/:id/test": { req: { version?: string }; res: TestResult };
  "POST /api/ships/:id/test": { req: { version?: string }; res: TestResult };
  /** Answers 409 while an installed book uses the ship, unless `?force=1`. */
  "DELETE /api/ships/:id/:version": { req: void; res: { freedBytes: number } };

  "GET /api/storage": { req: void; res: StorageReport };
  "DELETE /api/cache": { req: void; res: { freedBytes: number } };

  "GET /api/workspaces": { req: void; res: WorkspaceInfo[] };
  "POST /api/workspaces": { req: { name: string }; res: WorkspaceInfo };
  "GET /api/workspaces/:name/artifacts": { req: void; res: Artifact[] };
  "POST /api/workspaces/:name/artifacts": { req: { path: string; name?: string }; res: Artifact };
  /** Raw file bytes as the body; `?name=<file name>` gives the name and, from its extension, the kind. */
  "PUT /api/workspaces/:name/artifacts/upload": { req: ArrayBuffer; res: Artifact };
  "GET /api/workspaces/:name/artifacts/:id": { req: void; res: Artifact };
  /** The artifact's bytes (files only; folders such as OME-Zarr answer 400). */
  "GET /api/workspaces/:name/artifacts/:id/content": { req: void; res: ArrayBuffer };

  /** Reads an artifact's metadata once and keeps it in `meta.summary`. */
  "POST /api/inspect": { req: { workspace: string; artifact: string }; res: DataSummary };
  /** Shortlists books for workspace data: direct matches, then after conversion, then excluded with reasons. */
  "POST /api/match": { req: { workspace: string; artifacts: string[]; text?: string }; res: { summaries: DataSummary[]; matches: BookMatch[] } };

  "POST /api/plans": { req: PlanRequest; res: Plan };
  /** The assistant picks a book for the data (or improvises), proposing a plan to approve. */
  "GET /api/examples": { req: void; res: Example[] };
  /** Copies an example's files into the workspace, as if they'd been dropped in. */
  "POST /api/examples/:id/load": { req: { workspace: string }; res: Artifact[] };
  "POST /api/assistant/plan": { req: { workspace: string; text: string; artifacts: string[] }; res: AssistantPlan };
  "GET /api/plans/:id": { req: void; res: Plan };
  "PUT /api/plans/:id": { req: Pick<Plan, "parameters" | "steps" | "inputs">; res: Plan };
  /** Answers 422 with the problems while the plan has errors. */
  "POST /api/plans/:id/approve": { req: void; res: { plan: Plan; jobs: Job[] } };
  /** Cancels a proposed plan, or the running jobs of an approved one. */
  "POST /api/plans/:id/cancel": { req: void; res: Plan };
  "POST /api/plans/:id/save-as-book": { req: { id: string; title: string; summary: string }; res: CatalogueEntry };

  "GET /api/jobs": { req: void; res: Job[] };
  /** Runs one ship operation (`tool` is `<ship>.<operation>`) on workspace artifacts. */
  "POST /api/jobs": {
    req: { workspace: string; tool: string; version?: string; inputs: Record<string, string>; params?: Params; force?: boolean };
    res: Job;
  };
  "GET /api/jobs/:id": { req: void; res: Job & { log: string } };
  "POST /api/jobs/:id/cancel": { req: void; res: Job };
  "POST /api/jobs/:id/rerun": { req: void; res: Job };
}

export type ApiRoute = keyof ApiRoutes;
export type ApiRequest<R extends ApiRoute> = ApiRoutes[R]["req"];
export type ApiResponse<R extends ApiRoute> = ApiRoutes[R]["res"];

/** Error bodies, for any non-2xx response. */
export interface ApiError {
  error: string;
  problems?: PlanProblem[];
}

/** Pushed over `GET /api/events`. */
export type ServerEvent =
  | { type: "job"; job: Job }
  | { type: "job-log"; jobId: string; line: string }
  /** Download progress, or for ships built from their Dockerfile, the latest build line in `message`. */
  | { type: "pull"; ship: string; version: string; receivedBytes: number; totalBytes?: number; done: boolean; error?: string; message?: string }
  | { type: "plan"; plan: Plan }
  | { type: "status"; status: SystemStatus }
  | { type: "library"; change: "books" | "ships" }
  | { type: "catalogue"; stats: CatalogueStats };

export type ServerEventType = ServerEvent["type"];
