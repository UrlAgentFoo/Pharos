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
import type { Step } from "./book.js";
import type { ShipManifest } from "./ship.js";
import type { FormatInfo } from "./vocabulary.js";

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

/** The formats a book's action input takes: read directly, or after one conversion step. */
export interface AcceptedFormats {
  action: string;
  input: string;
  kind: string;
  direct: string[];
  converted: { format: string; via: string }[];
}

/**
 * A book as its card shows it: what it's called, how to use it, what it
 * can do, the files it takes and the ships it needs (downloaded or not).
 */
export interface BookCard {
  entry: CatalogueEntry;
  howToUse: string;
  actions: { name: string; title: string; summary?: string }[];
  /** Every format any action takes, directly or after conversion, by title ("OME-Zarr", "OpenFOAM case"). */
  accepts: { format: string; title: string; converted: boolean }[];
  ships: { id: string; version?: string; downloaded: boolean; sizeBytes?: number }[];
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

/** What `POST /api/plans` takes: a book to run on workspace data, or steps (as a data window's history holds them). */
export type PlanRequest =
  | { workspace: string; from: "book"; book: string; version?: string; action?: string; inputs: Record<string, string>; parameters?: Params }
  | { workspace: string; from: "steps"; title: string; inputs: Record<string, string>; steps: Step[] };

export interface CaseSummary {
  application?: string;
  endTime?: number;
  cells?: number;
  patches: { name: string; type: string }[];
  times: number[];
  fields: string[];
  inletSpeed?: number;
  viscosity?: number;
  solved: boolean;
}

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
  /** Whether it has a picture for its card, at `GET /api/examples/:id/image`. */
  image?: boolean;
  /**
   * How to run it quickly: a book action and parameter values small enough
   * to finish in seconds (a short simulated time, say). Its files fill the
   * action's inputs by kind, in order.
   */
  run?: { book: string; action?: string; params?: Params };
}

/**
 * The assistant's layout of the Controls panel for one book action on a
 * window's data, for the panel's Suggested tab: what the action does there,
 * the one or two settings worth changing, and the rest folded away.
 */
export interface ControlsLayout {
  /** What the action does to this data, in about eight words. */
  summary: string;
  /** The settings shown at once, at most two, each with a hint of about eight words. */
  shown: { param: string; hint: string }[];
  /** Every other setting, folded under More settings in titled groups. */
  more: { title: string; params: string[] }[];
  /** Values it suggests for this data, where the defaults won't do. */
  values: Params;
  /** Why those values, in one sentence; empty when it suggests none. */
  rationale: string;
}

/** One earlier message in the conversation with the assistant, oldest first. */
export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

/** What the assistant says to a message, and the plan it proposes when asked to do something; `plan` is null otherwise. */
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
  /** Every book as its card shows it, in one request. */
  "GET /api/library/cards": { req: void; res: BookCard[] };
  /** Every format Pharos recognises: built in, plus those ships declare. */
  "GET /api/library/formats": { req: void; res: Record<string, FormatInfo> };
  /** `?version=` picks a version; the newest otherwise. `accepts` lists the formats each action input takes, directly or after conversion. */
  "GET /api/library/books/:id": {
    req: void;
    res: { manifest: BookManifest; guide: string; entry: CatalogueEntry; accepts: AcceptedFormats[] };
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
  /** Saves a project (the UI's project.json) as one .pharos file with the data it uses; `results` adds what its steps made. */
  "POST /api/projects/export": {
    req: { project: Record<string, unknown>; path: string; results?: boolean; overwrite?: boolean };
    res: { path: string; bytes: number; objects: number; missing: string[] };
  };
  /** Opens a .pharos file: its data goes back into the windows' workspaces, each checked against its hash. */
  "POST /api/projects/import": {
    req: { path: string };
    res: { project: Record<string, unknown>; imported: number; reused: number; missing: string[] };
  };
  "GET /api/workspaces/:name/artifacts": { req: void; res: Artifact[] };
  "POST /api/workspaces/:name/artifacts": { req: { path: string; name?: string }; res: Artifact };
  /** Raw file bytes as the body; `?name=<file name>` gives the name and, from its extension, the kind. */
  "PUT /api/workspaces/:name/artifacts/upload": { req: ArrayBuffer; res: Artifact };
  "GET /api/workspaces/:name/artifacts/:id": { req: void; res: Artifact };
  /** The artifact's bytes (files only; folders such as OME-Zarr answer 400). */
  "GET /api/workspaces/:name/artifacts/:id/content": { req: void; res: ArrayBuffer };
  /**
   * A media link for an artifact's file: `/api/media/<secret>`, which a
   * <video> can stream (in byte ranges) without the token header. It serves
   * only that file, for as long as the server runs.
   */
  "POST /api/workspaces/:name/artifacts/:id/link": { req: void; res: { url: string } };
  /** The file behind a media link; honours Range requests. */
  "GET /api/media/:link": { req: void; res: ArrayBuffer };
  /** An image or labels artifact as TIFF for the viewer (TIFF as is; OME-Zarr uncompressed or zstd converted). */
  "GET /api/workspaces/:name/artifacts/:id/image": { req: void; res: ArrayBuffer };
  /** An OpenFOAM case's solver, mesh size, patches, saved times and inlet speed. */
  "GET /api/workspaces/:name/artifacts/:id/case": { req: void; res: CaseSummary };

  /** Reads an artifact's metadata once and keeps it in `meta.summary`. */
  "POST /api/inspect": { req: { workspace: string; artifact: string }; res: DataSummary };
  /** Shortlists books for workspace data: direct matches, then after conversion, then excluded with reasons. */
  "POST /api/match": { req: { workspace: string; artifacts: string[]; text?: string }; res: { summaries: DataSummary[]; matches: BookMatch[] } };

  "POST /api/plans": { req: PlanRequest; res: Plan };
  /** The assistant picks a book for the data (or improvises), proposing a plan to approve. */
  "GET /api/examples": { req: void; res: Example[] };
  /** An example's picture (PNG, JPEG or WebP); 404 when it has none. */
  "GET /api/examples/:id/image": { req: void; res: ArrayBuffer };
  /** Copies an example's files into the workspace, as if they'd been dropped in. */
  "POST /api/examples/:id/load": { req: { workspace: string }; res: Artifact[] };
  /**
   * Runs an example's `run` in the "examples" workspace, so its results are
   * cached (the cache is shared) and opening it later is instant. Only when
   * asked: nothing runs without approval.
   */
  "POST /api/examples/:id/prepare": { req: void; res: Plan };
  /**
   * The assistant answers a message about the active window's data, with the
   * conversation so far in `history`; when asked to do something it proposes a plan.
   */
  "POST /api/assistant/plan": { req: { workspace: string; text: string; artifacts: string[]; history?: ChatTurn[] }; res: AssistantPlan };
  /**
   * The assistant lays out the Controls for a book action on an artifact,
   * starting from the book's own design; `request` is what the user asked
   * for, when the action answers a message. Kept while the server runs.
   */
  "POST /api/assistant/controls": { req: { workspace: string; artifact: string; book: string; action: string; request?: string }; res: { layout: ControlsLayout; model?: string } };
  "GET /api/plans/:id": { req: void; res: Plan };
  "PUT /api/plans/:id": { req: Pick<Plan, "parameters" | "steps" | "inputs">; res: Plan };
  /** Answers 422 with the problems while the plan has errors. */
  "POST /api/plans/:id/approve": { req: void; res: { plan: Plan; jobs: Job[] } };
  /** Cancels a proposed plan, or the running jobs of an approved one. */
  "POST /api/plans/:id/cancel": { req: void; res: Plan };
  /**
   * Saves a plan that worked as a book: a new book with one action, or, when
   * `id` names a book in the data folder, a new action in it.
   */
  "POST /api/plans/:id/save-as-book": { req: { id: string; title: string; summary: string; action: { name: string; title: string } }; res: CatalogueEntry };

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
