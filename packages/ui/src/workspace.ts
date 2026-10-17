/**
 * The open windows: one per dataset, each with the history of processes
 * (ship operations and recipes) applied to it. Every tool runs in a window,
 * on that window's data.
 */
import type { Artifact, Params } from "@pharos/contracts";
import type { Progress } from "./progress.js";

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
  /** The run that added the step: a book action's steps share one, and show as one block in the history. */
  block?: string;
  /** proposed: waiting for Approve; stale: changed, re-runs on the next run. */
  status: "proposed" | "stale" | "queued" | "running" | "done" | "failed" | "cancelled";
  progress?: number;
  message?: string;
  /** Live progress while queued or running: the phase, the clock, downloads (not saved). */
  live?: Progress;
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
  /** Its number, shown in its title and cited by the assistant as [n]; never reused while the page is open, so old citations stay right. */
  readonly ref: number;
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
  /**
   * A book action the assistant suggests running here (asked for in the chat):
   * it waits in the Controls' Suggested tab, not in the history, until it's
   * run or dismissed.
   */
  suggestion?: { book: { id: string; title: string }; action: string; title?: string; values: Params; rationale?: string; request?: string };
  /** The book action the data came to try (an example's `run`): first in the Controls, in bold, with these settings. */
  prefer?: { book: string; action?: string; values?: Params };
  /** Side panel open, history line full or slim, the Controls' results section open, and which Controls tab shows. */
  ui: { controls: boolean; history: "full" | "slim"; results?: boolean; controlsTab?: "manual" | "suggested" };
}

let nextDoc = 0;

export class Workspace {
  private _docs: DataDoc[] = [];
  private _activeId: string | null = null;
  private lastRef = 0;
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
  restore(doc: Omit<DataDoc, "id" | "kind" | "ref">): DataDoc {
    return this.add({ ...doc, kind: "data", id: `d${++nextDoc}` });
  }

  /** The window cited as [ref], if it's open. */
  byRef(ref: number): DataDoc | undefined {
    return this._docs.find((d) => d.ref === ref);
  }

  /** Numbers windows from 1 again: for a new project, once its windows have closed (and the conversation citing them is gone). */
  resetRefs() {
    if (!this._docs.length) this.lastRef = 0;
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

  private add(fields: Omit<DataDoc, "ref">): DataDoc {
    const doc: DataDoc = { ...fields, ref: ++this.lastRef };
    this._docs.push(doc);
    this._activeId = doc.id;
    this.emit();
    return doc;
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }
}

/** One run in a window's history: the steps one action added, shown as a single block. */
export interface TimeBlock {
  /** Its steps, as indices into `doc.steps`. */
  first: number;
  last: number;
  title: string;
  status: DataStep["status"];
}

/** A new run's id, shared by the steps it adds. */
export const newBlock = (): string => Math.random().toString(36).slice(2, 10);

/** The window's history as runs, in order. Steps saved before runs had ids group by the book action they came from. */
export function timeBlocks(doc: DataDoc): TimeBlock[] {
  const out: TimeBlock[] = [];
  const key = (s: DataStep) => s.block ?? (s.book ? `${s.book.id}/${s.book.action ?? ""}` : undefined);
  doc.steps.forEach((s, i) => {
    const prev = out[out.length - 1];
    if (prev && key(s) !== undefined && key(s) === key(doc.steps[prev.last])) prev.last = i;
    else out.push({ first: i, last: i, title: "", status: s.status });
  });
  for (const b of out) {
    const steps = doc.steps.slice(b.first, b.last + 1);
    b.title = steps[0].book?.title ?? stepTitle(steps[0]);
    b.status = blockStatus(steps);
  }
  return out;
}

/** A run that has started but not yet finished once: it joins the timeline when it's done (unless it's already on view). */
export function underWay(doc: DataDoc, b: TimeBlock): boolean {
  const onView = doc.marker - 1 >= b.first && doc.marker - 1 <= b.last;
  return (b.status === "queued" || b.status === "running") && !onView && doc.steps.slice(b.first, b.last + 1).some((s) => !s.outputs);
}

/** The run that holds step `marker` (1-based); -1 for the data itself. */
export function blockAt(blocks: TimeBlock[], marker: number): number {
  return marker === 0 ? -1 : blocks.findIndex((b) => marker - 1 >= b.first && marker - 1 <= b.last);
}

/** A step's name for people: its operation, in words ("gaussian blur"). */
export function stepTitle(step: DataStep): string {
  const op = step.run.split(".")[1] ?? step.run;
  const words = op.replace(/[-_]+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A run's status: what's under way first, then what went wrong, then what's waiting. */
function blockStatus(steps: DataStep[]): DataStep["status"] {
  for (const s of ["running", "queued", "failed", "proposed", "stale", "cancelled"] as const) if (steps.some((x) => x.status === s)) return s;
  return "done";
}
