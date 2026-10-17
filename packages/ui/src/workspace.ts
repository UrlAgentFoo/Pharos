/**
 * The open windows: one per dataset, each with the history of processes
 * (ship operations and recipes) applied to it. Every tool runs in a window,
 * on that window's data.
 */
import type { Artifact, Params } from "@pharos/contracts";

/** One process in a data window's history: a ship operation, wired to the data or earlier steps. */
export interface DataStep {
  /** Step id (lowercase_snake), what later steps' wires refer to. */
  id: string;
  /** `<ship>.<operation>` */
  run: string;
  /** Wires: `$data`, or `<step id>.<output>`. */
  in: Record<string, string>;
  with: Params;
  /** The recipe (book) the step came from, shown as a label over its steps. */
  book?: { id: string; title: string; action?: string };
  /** proposed: waiting for Approve; stale: changed, re-runs on the next run. */
  status: "proposed" | "stale" | "queued" | "running" | "done" | "failed" | "cancelled";
  progress?: number;
  message?: string;
  jobId?: string;
  cached?: boolean;
  /** Output name → artifact id, once done. */
  outputs?: Record<string, string>;
  error?: string;
}

/**
 * A dataset in its own window (an image, a time-lapse, an OpenFOAM case, a
 * table): its history of processes along the bottom, and the body showing
 * the data as of the selected step.
 */
export interface DataDoc {
  readonly kind: "data";
  readonly id: string;
  name: string;
  workspace: string;
  source: Artifact;
  steps: DataStep[];
  /** What the body shows: 0 = the data itself, n = the result of step n. */
  marker: number;
  /** Which output of the shown step is on view, when it has several. */
  output?: string;
  /** Why the assistant proposed these steps, when it did. */
  rationale?: string;
  /** Side panel open, history line full or slim, and which view fills the body: the selected step, or every result as a grid. */
  ui: { controls: boolean; history: "full" | "slim"; mode?: "history" | "results" };
}

let nextDoc = 0;

export class Workspace {
  private _docs: DataDoc[] = [];
  private _activeId: string | null = null;
  private listeners = new Set<() => void>();

  get docs(): readonly DataDoc[] {
    return this._docs;
  }

  /** The active window, if any. */
  get active(): DataDoc | null {
    return this._docs.find((d) => d.id === this._activeId) ?? null;
  }

  get(id: string): DataDoc | undefined {
    return this._docs.find((d) => d.id === id);
  }

  /** Opens a dataset in its own window, or brings its window forward if it's open. */
  open(source: Artifact, workspace: string): DataDoc {
    const open = this._docs.find((d) => d.source.id === source.id && d.workspace === workspace);
    if (open) {
      this.activate(open.id);
      return open;
    }
    return this.add({ kind: "data", id: `d${++nextDoc}`, name: source.name ?? source.id.slice(0, 12), workspace, source, steps: [], marker: 0, ui: { controls: true, history: "full" } });
  }

  /** Adds a window restored from a project, as it was. */
  restore(doc: Omit<DataDoc, "id" | "kind">): DataDoc {
    return this.add({ ...doc, kind: "data", id: `d${++nextDoc}` });
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  activate(id: string) {
    if (this._activeId === id || !this.get(id)) return;
    this._activeId = id;
    this.emit();
  }

  /** No window is active (e.g. every window is minimised). */
  deactivate() {
    if (this._activeId === null) return;
    this._activeId = null;
    this.emit();
  }

  close(id: string) {
    const i = this._docs.findIndex((d) => d.id === id);
    if (i < 0) return;
    this._docs.splice(i, 1);
    if (this._activeId === id) this._activeId = this._docs[Math.min(i, this._docs.length - 1)]?.id ?? null;
    this.emit();
  }

  rename(id: string, name: string) {
    const doc = this.get(id);
    if (!doc || !name.trim()) return;
    doc.name = name.trim();
    this.emit();
  }

  /** Re-renders anything showing windows (call after a change to a document). */
  touch() {
    this.emit();
  }

  private add(doc: DataDoc): DataDoc {
    this._docs.push(doc);
    this._activeId = doc.id;
    this.emit();
    return doc;
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }
}
