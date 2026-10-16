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

/** What `POST /api/plans` takes: a book to load, or a request for the assistant. */
export type PlanRequest =
  | { from: "book"; book: string; version?: string; inputs: Record<string, string>; parameters?: Params }
  | { from: "assistant"; text: string; inputs: Record<string, string> };

/**
 * Route → request and response bodies. `:name` segments are path
 * parameters. `void` means no body.
 */
export interface ApiRoutes {
  "GET /api/status": { req: void; res: SystemStatus };

  "GET /api/library/books": { req: void; res: CatalogueEntry[] };
  "GET /api/library/books/:id": { req: void; res: { manifest: BookManifest; guide: string; entry: CatalogueEntry } };
  "POST /api/library/books": { req: { source: string }; res: CatalogueEntry };
  "GET /api/library/ships": { req: void; res: CatalogueEntry[] };
  "GET /api/library/ships/:id": { req: void; res: { manifest: ShipManifest; entry: CatalogueEntry } };
  "GET /api/catalogue/stats": { req: void; res: CatalogueStats };

  "POST /api/books/:id/resolve": { req: { version?: string }; res: Resolution };
  "POST /api/books/:id/get-ready": { req: { version?: string }; res: { jobs: Job[] } };
  "POST /api/books/:id/test": { req: { version?: string }; res: TestResult };
  "POST /api/ships/:id/test": { req: { version?: string }; res: TestResult };
  "DELETE /api/ships/:id/:version": { req: void; res: { freedBytes: number } };

  "GET /api/storage": { req: void; res: StorageReport };
  "DELETE /api/cache": { req: void; res: { freedBytes: number } };

  "GET /api/workspaces": { req: void; res: WorkspaceInfo[] };
  "POST /api/workspaces": { req: { name: string }; res: WorkspaceInfo };
  "GET /api/workspaces/:name/artifacts": { req: void; res: Artifact[] };
  "POST /api/workspaces/:name/artifacts": { req: { path: string; name?: string }; res: Artifact };

  "POST /api/inspect": { req: { artifact: string }; res: DataSummary };
  "POST /api/match": { req: { artifacts: string[]; text?: string }; res: BookMatch[] };

  "POST /api/plans": { req: PlanRequest; res: Plan };
  "GET /api/plans/:id": { req: void; res: Plan };
  "PUT /api/plans/:id": { req: Pick<Plan, "parameters" | "steps" | "inputs">; res: Plan };
  "POST /api/plans/:id/approve": { req: void; res: { plan: Plan; jobs: Job[] } };
  "POST /api/plans/:id/save-as-book": { req: { id: string; title: string; summary: string }; res: CatalogueEntry };

  "GET /api/jobs": { req: void; res: Job[] };
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
  | { type: "pull"; ship: string; version: string; receivedBytes: number; totalBytes?: number; done: boolean; error?: string }
  | { type: "plan"; plan: Plan }
  | { type: "status"; status: SystemStatus }
  | { type: "library"; change: "books" | "ships" }
  | { type: "catalogue"; stats: CatalogueStats };

export type ServerEventType = ServerEvent["type"];
