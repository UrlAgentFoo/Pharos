/**
 * The open images ("documents"), one per window. Each has its own timeline
 * and view state, and remembers which image it was branched from so the
 * overview can show related images together.
 *
 * Images can also be put in a group, so they share controls: zoom and pan,
 * slice, contrast, and (optionally) every step applied to one of them.
 */
import type { Artifact, Params } from "@pharos/contracts";
import { type CommandContext, type Image, Timeline } from "@pharos/core";
import { type ViewState, type ViewerLayers, newViewState } from "./viewer.js";

export interface Doc {
  readonly id: string;
  name: string;
  readonly timeline: Timeline;
  readonly view: ViewState;
  /** Folder and file name when the image came from the local file system. */
  file: { dir: string; name: string } | null;
  /** The image this one was branched from, and after how many of its steps. */
  readonly parent?: { id: string; name: string; step: number };
  /** Control panels the assistant suggested for this image, shown in its Controls drawer. */
  panels: { title: string; commands: string[] }[];
  /** How the window is laid out: Controls drawer open, history line full or slim. */
  ui: { controls: boolean; history: "full" | "slim" };
  /** The group this image belongs to, if any. */
  group?: string;
  /** The selection, overlay outlines and threshold preview drawn on the image. */
  layers: ViewerLayers;
}

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
  book?: { id: string; title: string };
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
 * A dataset in its own window (an OpenFOAM case, a time-lapse, a table):
 * its history of processes along the bottom, and the body showing the
 * data as of the selected step, like an image and its timeline.
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
  /** As for images, plus which view fills the body: the history's selected step, or every result as a grid. */
  ui: { controls: boolean; history: "full" | "slim"; mode?: "history" | "results" };
}

/** Images that share controls, for example the same field in several conditions. */
export interface Group {
  readonly id: string;
  name: string;
  color: string;
  /** What members share. */
  sync: { view: boolean; slice: boolean; contrast: boolean; steps: boolean };
}

const GROUP_COLORS = ["#c96f53", "#4f7f6a", "#6a55b8", "#2f5d8a", "#b08a3e"];
let nextDoc = 0;
let nextGroup = 0;

export class Workspace {
  private _docs: Doc[] = [];
  private _data: DataDoc[] = [];
  private _activeId: string | null = null;
  private _groups = new Map<string, Group>();
  private listeners = new Set<() => void>();

  constructor(private readonly ctx: () => CommandContext) {}

  get docs(): readonly Doc[] {
    return this._docs;
  }

  /** The active window when it shows an image (null for a data window, or none). */
  get active(): Doc | null {
    return this._docs.find((d) => d.id === this._activeId) ?? null;
  }

  get dataDocs(): readonly DataDoc[] {
    return this._data;
  }

  /** The active window when it shows a dataset. */
  get activeData(): DataDoc | null {
    return this._data.find((d) => d.id === this._activeId) ?? null;
  }

  getData(id: string): DataDoc | undefined {
    return this._data.find((d) => d.id === id);
  }

  /** Opens a dataset in its own window, or brings its window forward if it's open. */
  openData(source: Artifact, workspace: string): DataDoc {
    const open = this._data.find((d) => d.source.id === source.id && d.workspace === workspace);
    if (open) {
      this.activate(open.id);
      return open;
    }
    const doc: DataDoc = { kind: "data", id: `d${++nextDoc}`, name: source.name ?? source.id.slice(0, 12), workspace, source, steps: [], marker: 0, ui: { controls: true, history: "full" } };
    this._data.push(doc);
    this._activeId = doc.id;
    this.emit();
    return doc;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get(id: string): Doc | undefined {
    return this._docs.find((d) => d.id === id);
  }

  /** Adds an image as a new tab and makes it active. */
  open(img: Image, file: Doc["file"] = null): Doc {
    const timeline = new Timeline(img, { ctx: this.ctx() });
    return this.add({ id: `d${++nextDoc}`, name: img.name ?? "untitled", timeline, view: newViewState(img), file, panels: [], ui: { controls: true, history: "full" }, layers: { roi: null, overlay: [], preview: null } });
  }

  /** Opens a copy of `doc` after its first `step` steps in a new tab, keeping those steps editable. */
  branch(doc: Doc, step = doc.timeline.marker): Doc {
    const timeline = doc.timeline.fork(step);
    const view: ViewState = { ...doc.view, pos: { ...doc.view.pos }, ranges: doc.view.ranges.map((r) => [...r] as [number, number]), hidden: [...doc.view.hidden], placed: false };
    const name = this.uniqueName(doc.name);
    return this.add(
      { id: `d${++nextDoc}`, name, timeline, view, file: null, parent: { id: doc.id, name: doc.name, step }, panels: doc.panels.map((p) => ({ ...p })), ui: { ...doc.ui }, layers: { roi: doc.layers.roi, overlay: [], preview: null } },
      this._docs.indexOf(doc) + 1,
    );
  }

  activate(id: string) {
    if (this._activeId === id || (!this.get(id) && !this.getData(id))) return;
    this._activeId = id;
    this.emit();
  }

  /** No image is active (e.g. every window is minimised). */
  deactivate() {
    if (this._activeId === null) return;
    this._activeId = null;
    this.emit();
  }

  /** Activates the tab `delta` places away, wrapping around. */
  cycle(delta: number) {
    if (!this._docs.length) return;
    const i = this._docs.findIndex((d) => d.id === this._activeId);
    this.activate(this._docs[(i + delta + this._docs.length) % this._docs.length].id);
  }

  close(id: string) {
    const di = this._data.findIndex((d) => d.id === id);
    if (di >= 0) {
      this._data.splice(di, 1);
      if (this._activeId === id) this._activeId = this._data[Math.min(di, this._data.length - 1)]?.id ?? this._docs.at(-1)?.id ?? null;
      this.emit();
      return;
    }
    const i = this._docs.findIndex((d) => d.id === id);
    if (i < 0) return;
    const [doc] = this._docs.splice(i, 1);
    if (doc.group) this.prune(doc.group);
    if (this._activeId === id) this._activeId = this._docs[Math.min(i, this._docs.length - 1)]?.id ?? null;
    this.emit();
  }

  /** Moves a tab to position `to` (drag and drop). */
  move(id: string, to: number) {
    const from = this._docs.findIndex((d) => d.id === id);
    if (from < 0) return;
    const [doc] = this._docs.splice(from, 1);
    this._docs.splice(Math.max(0, Math.min(this._docs.length, to)), 0, doc);
    this.emit();
  }

  rename(id: string, name: string) {
    const doc = this.get(id);
    if (!doc || !name.trim()) return;
    doc.name = name.trim();
    this.emit();
  }

  /**
   * Images grouped by lineage for the overview: each group is a root image
   * followed by everything branched from it (depth-first), in tab order.
   */
  lineage(): { doc: Doc; depth: number }[][] {
    const children = new Map<string, Doc[]>();
    const roots: Doc[] = [];
    for (const d of this._docs) {
      if (d.parent && this.get(d.parent.id)) children.set(d.parent.id, [...(children.get(d.parent.id) ?? []), d]);
      else roots.push(d);
    }
    const walk = (d: Doc, depth: number, out: { doc: Doc; depth: number }[]) => {
      out.push({ doc: d, depth });
      for (const c of children.get(d.id) ?? []) walk(c, depth + 1, out);
      return out;
    };
    return roots.map((r) => walk(r, 0, []));
  }

  // ------------------------------------------------------------ groups

  get groups(): Group[] {
    return [...this._groups.values()];
  }

  groupOf(doc: Doc): Group | undefined {
    return doc.group ? this._groups.get(doc.group) : undefined;
  }

  /** The other images in `doc`'s group. */
  peers(doc: Doc): Doc[] {
    return doc.group ? this._docs.filter((d) => d !== doc && d.group === doc.group) : [];
  }

  /** Puts `docs` in a new group; images already in a group move over. Needs at least two. */
  createGroup(docs: Doc[]): Group | undefined {
    if (docs.length < 2) return undefined;
    const used = new Set(this.groups.map((g) => g.color));
    const n = ++nextGroup;
    const g: Group = {
      id: `g${n}`,
      name: `Group ${String.fromCharCode(64 + (((n - 1) % 26) + 1))}`,
      color: GROUP_COLORS.find((c) => !used.has(c)) ?? GROUP_COLORS[n % GROUP_COLORS.length],
      sync: { view: true, slice: true, contrast: false, steps: false },
    };
    this._groups.set(g.id, g);
    for (const d of docs) this.join(d, g.id, false);
    this.emit();
    return g;
  }

  join(doc: Doc, groupId: string, emit = true) {
    const old = doc.group;
    doc.group = groupId;
    if (old && old !== groupId) this.prune(old);
    if (emit) this.emit();
  }

  leave(doc: Doc) {
    const g = doc.group;
    if (!g) return;
    doc.group = undefined;
    this.prune(g);
    this.emit();
  }

  ungroup(groupId: string) {
    for (const d of this._docs) if (d.group === groupId) d.group = undefined;
    this._groups.delete(groupId);
    this.emit();
  }

  setSync(groupId: string, key: keyof Group["sync"], on: boolean) {
    const g = this._groups.get(groupId);
    if (!g) return;
    g.sync[key] = on;
    this.emit();
  }

  /** A group of one is no group: dissolve it. */
  private prune(groupId: string) {
    const members = this._docs.filter((d) => d.group === groupId);
    if (members.length >= 2) return;
    for (const d of members) d.group = undefined;
    this._groups.delete(groupId);
  }

  /** Re-renders anything showing images (call after a timeline or view change). */
  touch() {
    this.emit();
  }

  private add(doc: Doc, at = this._docs.length): Doc {
    this._docs.splice(at, 0, doc);
    this._activeId = doc.id;
    doc.timeline.subscribe(() => this.emit());
    this.emit();
    return doc;
  }

  /** ImageJ-style duplicate names: cells.tif → cells-1.tif, cells-2.tif, … */
  private uniqueName(name: string): string {
    const m = name.match(/^(.*?)(?:-\d+)?(\.[^.]+)?$/)!;
    const base = m[1] || name;
    const ext = m[2] ?? "";
    const taken = new Set(this._docs.map((d) => d.name));
    for (let i = 1; ; i++) {
      const candidate = `${base}-${i}${ext}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }
}
