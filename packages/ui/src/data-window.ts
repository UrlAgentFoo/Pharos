/**
 * The inside of a data window: a dataset and the processes applied to it,
 * laid out like an image window.
 *
 * - The body shows the data as of the selected history step, with the
 *   viewer for its kind: images and labels in the image viewer (slices,
 *   frames and channels), videos played, tables as tables, OpenFOAM cases
 *   as a summary of the case.
 * - The history strip along the bottom is a timeline: the dataset, then one
 *   block per run (a book action's steps, or one operation), each with the
 *   icon of what it makes. Click a block, or drag the blue marker, to see
 *   the data at that point in time.
 * - The Controls drawer shows the selected step's settings (change them and
 *   it re-runs from there), or for the dataset itself, what it is.
 * - Suggested, beside Fork, lists the books and operations that take what's
 *   on view, so each result can feed the next run.
 * - Under the controls, a folded Results section holds what the run on view
 *   made, step by step; click one to show it.
 */
import type { Artifact, ParamSpec, Params } from "@pharos/contracts";
import type { Image } from "@pharos/core";
import type { LocalServer } from "./api.js";
import { type Loaded, type Mounted, loadView, mountView, releaseView } from "./data-views.js";
import { thumbnailElement } from "./viewer.js";
import { escapeHtml, formatSize } from "./dialogs.js";
import { icon } from "./icons.js";
import { manifestParamFields, readManifestParams } from "./param-fields.js";
import { barHtml, clockHtml, progressHtml } from "./progress.js";
import { type DataDoc, type DataStep, type TimeBlock, blockAt, stepTitle, timeBlocks } from "./workspace.js";

/** Something that can be applied to the shown data: one of a book's actions, or a single ship operation. */
export type Suggestion =
  | { type: "book"; id: string; action: string; book: string; title: string; summary: string; fit: string; trust: string }
  | { type: "op"; id: string; title: string; summary: string; trust: string };

/** The Controls for a run of a book action: its design's sections for the window's data, and the run's values. */
export interface RunControls {
  sections: { title: string; note?: string; params: ParamSpec[]; folded?: boolean }[];
  values: Params;
}

/** A book action the Controls offer to run next, laid out by its design, with its defaults. */
export interface NextAction extends RunControls {
  book: { id: string; title: string };
  action: string;
  title: string;
  summary?: string;
}

export interface StepSpec {
  title: string;
  summary: string;
  params: ParamSpec[];
  /** The kind of data the step makes (its first output), for its icon in the history. */
  makes?: Artifact["kind"];
}

export interface DataWindowHooks {
  server(): LocalServer | null;
  /** Shows step `marker` (0 = the data itself), and which of its outputs. */
  select(doc: DataDoc, marker: number, output?: string): void;
  /** Opens a new window with the history up to the step on view. */
  fork(doc: DataDoc): void;
  approve(doc: DataDoc): void;
  rerun(doc: DataDoc): void;
  cancel(doc: DataDoc): void;
  /** Shows a job's log. */
  showLog(jobId: string): void;
  /** Ship operations marked as views that can show `artifact`. */
  viewsFor(artifact: Artifact): Promise<{ tool: string; title: string; summary: string }[]>;
  /** Runs a view on `artifact` (cached like any operation) and returns what it made. */
  runView(doc: DataDoc, artifact: Artifact, tool: string): Promise<Artifact>;
  updateStep(doc: DataDoc, index: number, params: Params): void;
  /** The Controls for the book run starting at step `first` (0-based); null for a run of one operation. */
  runControls(doc: DataDoc, first: number): Promise<RunControls | null>;
  /** Sets a book run's parameters; what changed runs again. */
  updateRun(doc: DataDoc, first: number, values: Params): void;
  /** What the Controls offer to run next on what's on view: the actions that fit the data, or a run's `next`. */
  nextActions(doc: DataDoc): Promise<NextAction[]>;
  /** Runs one of those with the values set in the Controls. */
  runNext(doc: DataDoc, book: string, action: string, values: Params): void;
  removeStep(doc: DataDoc, index: number): void;
  /** Opens the menu of what fits the data on view, under `anchor`. */
  suggestMenu(doc: DataDoc, anchor: DOMRect): void;
  stepSpec(run: string): StepSpec | undefined;
  notify(text: string): void;
}

const KIND_ICON: Record<string, string> = {
  volume: "image",
  labels: "binary",
  tracks: "link",
  table: "table",
  mesh: "cube",
  splat: "sparkle",
  "sim-case": "plane",
  video: "layout",
};

/** The icon for a kind of data; kinds that ships bring get a plain file icon. */
export const kindIcon = (kind: string): string => KIND_ICON[kind] ?? "file";

const STATUS_LABEL: Record<DataStep["status"], string> = {
  proposed: "proposed",
  stale: "changed",
  queued: "waiting",
  running: "running",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
};

export class DataWindow {
  private readonly body: HTMLElement;
  private readonly stage: HTMLElement;
  private readonly bar: HTMLElement;
  readonly drawer: HTMLElement;
  /** The drawer's controls, redrawn as the selection changes; the results section below them stays put. */
  private readonly ctl: HTMLElement;
  private readonly resultsSec: HTMLDetailsElement;
  private readonly grid: HTMLElement;
  private mounted: Mounted | null = null;
  private tiles: Mounted[] = [];
  private gridKey = "";
  private readonly loaded = new Map<string, Loaded | Promise<Loaded>>();
  /** Data Pharos can't draw itself → what a ship's view made of it, once asked for. */
  private readonly viewed = new Map<string, string>();
  private readonly artifacts = new Map<string, Artifact>();
  private shownKey = "";
  private drawerKey = "";
  /** The history marker is being dragged: the strip isn't redrawn under the pointer. */
  private scrubbing = false;
  private refocusMarker = false;
  /** The Controls on show for a book run, so Apply reads its fields. */
  private runCtl: { first: number; specs: ParamSpec[] } | null = null;
  /** The actions the Controls offer to run next, as drawn. */
  private nextCtl: NextAction[] = [];
  /** "View log" stays open as the drawer redraws during a run. */
  private logOpen = false;

  constructor(
    private readonly doc: DataDoc,
    body: HTMLElement,
    bar: HTMLElement,
    private readonly hooks: DataWindowHooks,
  ) {
    this.body = body;
    this.body.classList.add("data-body");
    this.body.innerHTML = `<div class="dv-outputs"></div><div class="dv-stage"></div><div class="dv-status" hidden></div>`;
    this.stage = this.body.querySelector(".dv-stage")!;
    this.bar = bar;
    this.drawer = document.createElement("aside");
    this.drawer.className = "ctl-drawer data-drawer";
    this.drawer.innerHTML = `<div class="dv-ctl"></div>
      <details class="ctl-sec dv-results"${doc.ui.results ? " open" : ""}><summary class="ctl-sec-title">${icon("chevron-right", 12)}Results <small></small></summary><div class="dv-grid"></div></details>`;
    this.ctl = this.drawer.querySelector(".dv-ctl")!;
    this.resultsSec = this.drawer.querySelector(".dv-results")!;
    this.grid = this.drawer.querySelector(".dv-grid")!;
    // tiles hold viewers, so they exist only while the section is open
    this.resultsSec.addEventListener("toggle", () => {
      doc.ui.results = this.resultsSec.open;
      if (this.resultsSec.open) void this.renderGrid();
      else this.clearGrid();
    });
    this.body.addEventListener("click", (e) => this.onClick(e));
    this.drawer.addEventListener("click", (e) => this.onClick(e));
    this.drawer.addEventListener("submit", (e) => e.preventDefault());
    this.bar.addEventListener("click", (e) => this.onClick(e));
    // drag the marker, or press anywhere on the track between runs to jump it there
    this.bar.addEventListener("pointerdown", (e) => {
      const t = e.target as HTMLElement;
      if (e.button === 0 && (t.matches(".tl-marker, .tl-track, .tl-link"))) this.scrub(e);
    });
    this.bar.addEventListener("keydown", (e) => {
      if (!(e.target as HTMLElement).matches(".tl-marker")) return;
      const stops = this.stops();
      const pos = blockAt(timeBlocks(this.doc), this.doc.marker) + 1;
      const to = { ArrowLeft: pos - 1, ArrowRight: pos + 1, Home: 0, End: stops.length - 1 }[e.key];
      if (to === undefined) return;
      e.preventDefault();
      this.refocusMarker = true;
      this.hooks.select(this.doc, stops[Math.max(0, Math.min(stops.length - 1, to))]);
    });
  }

  /** The artifact the window shows now: the data itself, or one output of the selected step. */
  private shown(): { artifactId: string | null; step: DataStep | null } {
    const d = this.doc;
    if (d.marker === 0) return { artifactId: d.source.id, step: null };
    const step = d.steps[d.marker - 1];
    if (!step) return { artifactId: d.source.id, step: null };
    const outputs = Object.entries(step.outputs ?? {});
    const chosen = outputs.find(([name]) => name === d.output) ?? outputs[0];
    return { artifactId: chosen?.[1] ?? null, step };
  }

  private async artifact(id: string): Promise<Artifact> {
    if (id === this.doc.source.id) return this.doc.source;
    const known = this.artifacts.get(id);
    if (known) return known;
    const a = await this.hooks.server()!.artifact(this.doc.workspace, id);
    this.artifacts.set(id, a);
    return a;
  }

  render() {
    this.renderBar();
    void this.renderBody();
    void this.renderDrawer();
    const count = this.results().length;
    this.resultsSec.querySelector("small")!.textContent = count ? String(count) : "";
    if (this.resultsSec.open) void this.renderGrid().then(() => this.markTiles());
  }

  /** An artifact's viewer data, loaded once per window. */
  private async entry(id: string): Promise<Loaded> {
    let entry = this.loaded.get(id);
    if (!entry) {
      entry = this.artifact(id).then((a) => loadView(this.hooks.server()!, this.doc.workspace, a));
      this.loaded.set(id, entry);
    }
    if (entry instanceof Promise) {
      const done = await entry;
      this.loaded.set(id, done);
      return done;
    }
    return entry;
  }

  // ---------------------------------------------------------- body

  private async renderBody() {
    const d = this.doc;
    const { artifactId, step } = this.shown();
    const outputs = this.body.querySelector<HTMLElement>(".dv-outputs")!;
    const names = Object.keys(step?.outputs ?? {});
    outputs.hidden = names.length < 2;
    outputs.innerHTML = names
      .map((n) => `<button class="chip ${(d.output ?? names[0]) === n ? "on" : ""}" data-output="${escapeHtml(n)}">${escapeHtml(n)}</button>`)
      .join("");

    const status = this.body.querySelector<HTMLElement>(".dv-status")!;
    const busy = step && step.status !== "done";
    status.hidden = !busy;
    if (busy && step) {
      const live = step.status === "running" || step.status === "queued";
      // a step waiting on earlier ones shows the one actually working
      const working = live && step.status === "queued" && (step.live?.phase ?? "waiting") === "waiting" ? (d.steps.find((s) => s.status === "running") ?? d.steps.find((s) => s.status === "queued" && s.live && s.live.phase !== "waiting")) : undefined;
      const focus = working ?? step;
      // the run as a whole: how many of the steps that ran or run this time are done
      const run = d.steps.filter((s) => s.status !== "proposed" && s.status !== "stale");
      const done = run.filter((s) => s.status === "done").length;
      const title = `${this.stepOf(d.steps.indexOf(focus) + 1)} · ${this.title(focus)}`;
      status.innerHTML = `<div class="dv-status-card ${step.status}">
        ${
          live
            ? `${progressHtml(focus.live ?? { phase: focus.status === "running" ? "starting" : "waiting" }, { title, logAction: focus.jobId ? `<button class="link-btn" data-act="log" data-job="${escapeHtml(focus.jobId)}">View log</button>` : "" })}
               ${run.length > 1 ? `<span class="pg-overall">${done} of ${run.length} steps done</span>` : ""}
               <button data-act="cancel">Cancel</button>`
            : `<strong>${escapeHtml(title)}</strong>
               <span>${escapeHtml(step.status === "failed" ? (step.error ?? "failed") : step.status === "proposed" ? "Proposed: approve to run it" : (step.message ?? STATUS_LABEL[step.status]))}</span>
               ${step.status === "failed" && step.jobId ? `<button class="link-btn" data-act="log" data-job="${escapeHtml(step.jobId)}">View log</button>` : ""}
               ${step.status === "proposed" ? `<button class="primary" data-act="approve">${icon("batch", 14)} Approve and run</button>` : ""}`
        }
      </div>`;
    }
    const key = `${artifactId}|${busy ? step!.status : "ok"}|${artifactId ? (this.viewed.get(artifactId) ?? "") : ""}`;
    if (key === this.shownKey) return;
    this.shownKey = key;
    this.unmount();
    if (!artifactId || busy) {
      this.stage.innerHTML = "";
      return;
    }
    const showId = this.viewed.get(artifactId) ?? artifactId;
    if (!(this.loaded.get(showId) && !(this.loaded.get(showId) instanceof Promise))) this.stage.innerHTML = `<p class="dv-loading">Loading…</p>`;
    const entry = await this.entry(showId);
    if (this.shownKey !== key) return; // the selection moved on while loading
    const artifact = await this.artifact(showId);
    this.mounted = mountView(this.stage, entry, artifact);
    if (entry.type === "info") void this.offerViews(artifact);
  }

  /** For data Pharos can't draw: the ship views that can show it, as buttons on its card. */
  private async offerViews(a: Artifact) {
    const key = this.shownKey;
    const views = await this.hooks.viewsFor(a);
    if (!views.length || this.shownKey !== key) return;
    const card = this.stage.querySelector(".dv-card");
    const note = card?.querySelector(".muted");
    if (note) note.textContent = "Pharos can't draw this itself, but a ship can show it. It's stored at:";
    card?.insertAdjacentHTML(
      "beforeend",
      `<div class="dv-views">${views.map((v) => `<button class="chip primary-chip" data-view="${escapeHtml(v.tool)}" title="${escapeHtml(v.summary)}">${icon("ship", 13)} Show with ${escapeHtml(v.title)}</button>`).join("")}</div>`,
    );
  }

  /** Runs a ship's view of the data on show and puts what it made in its place. */
  private async showWith(tool: string) {
    const { artifactId } = this.shown();
    if (!artifactId) return;
    const a = await this.artifact(artifactId);
    const box = this.stage.querySelector(".dv-views");
    if (box) box.innerHTML = `<span class="pg"><span class="pg-head"><span class="pg-phase">Preparing the view</span>${clockHtml(Date.now())}</span>${barHtml()}</span>`;
    try {
      const out = await this.hooks.runView(this.doc, a, tool);
      this.artifacts.set(out.id, out);
      this.viewed.set(artifactId, out.id);
      this.shownKey = "";
      await this.renderBody();
    } catch (e) {
      this.hooks.notify(e instanceof Error ? e.message : String(e));
      this.shownKey = "";
      await this.renderBody();
    }
  }

  private unmount() {
    this.mounted?.destroy();
    this.mounted = null;
    this.stage.classList.remove("has-image", "has-model");
  }

  // ---------------------------------------------------------- results of the run on view

  /** The results of the run on view, step by step: [step index (1-based), output name, artifact id]. */
  private results(): [number, string, string][] {
    const blocks = timeBlocks(this.doc);
    const b = blocks[blockAt(blocks, this.doc.marker)];
    if (!b) return [];
    return this.doc.steps
      .slice(b.first, b.last + 1)
      .flatMap((s, j) => (s.status === "done" ? Object.entries(s.outputs ?? {}).map(([n, id]) => [b.first + j + 1, n, id] as [number, string, string]) : []));
  }

  private async renderGrid() {
    const items = this.results();
    const key = `${this.doc.marker > 0}|${items.map((r) => r.join(":")).join("|")}`;
    if (key === this.gridKey) return;
    this.clearGrid();
    this.gridKey = key;
    if (!items.length) {
      this.grid.innerHTML = `<p class="dv-grid-empty">${this.doc.marker > 0 ? "This run hasn't made anything yet." : "Pick a run in the history: what it made shows here."}</p>`;
      return;
    }
    this.grid.innerHTML = items
      .map(([index, name, id]) => {
        const step = this.doc.steps[index - 1];
        return `<figure class="dv-tile">
          <figcaption><button class="dv-tile-go" data-index="${index}" data-output="${escapeHtml(name)}" title="Show it in the window">${escapeHtml(this.title(step))} <small>${escapeHtml(name)}</small></button></figcaption>
          <div class="dv-stage" data-tile="${escapeHtml(id)}"><p class="dv-loading">Loading…</p></div></figure>`;
      })
      .join("");
    this.markTiles();
    await Promise.all(
      items.map(async ([, , id]) => {
        const entry = await this.entry(id);
        const host = this.grid.querySelector<HTMLElement>(`[data-tile="${CSS.escape(id)}"]`);
        if (this.gridKey !== key || !host) return;
        this.tiles.push(mountView(host, entry, await this.artifact(id), true));
      }),
    );
  }

  /** Marks the tile of the result on view. */
  private markTiles() {
    const d = this.doc;
    const shown = this.shown().artifactId;
    this.grid.querySelectorAll<HTMLElement>(".dv-tile").forEach((t) => {
      const on = d.marker > 0 && t.querySelector<HTMLElement>("[data-tile]")?.dataset.tile === shown;
      t.classList.toggle("on", on);
      t.querySelector(".dv-tile-go")?.toggleAttribute("aria-current", on);
    });
  }

  private clearGrid() {
    for (const t of this.tiles) t.destroy();
    this.tiles = [];
    this.gridKey = "";
    this.grid.innerHTML = "";
  }

  // ---------------------------------------------------------- history: one block per run, and the marker

  title(step: DataStep): string {
    return stepTitle(step);
  }

  /** "Run 2 of 3 · Segment and measure", plus the step when the run has several ("· step 3 of 5: Measure"). */
  private where(marker: number): string {
    const blocks = timeBlocks(this.doc);
    const k = blockAt(blocks, marker);
    const b = blocks[k];
    if (!b) return "The data itself";
    const n = b.last - b.first + 1;
    return `Run ${k + 1} of ${blocks.length} · ${b.title}${n > 1 ? ` · step ${marker - b.first} of ${n}: ${this.title(this.doc.steps[marker - 1])}` : ""}`;
  }

  /** Where the marker can stop: the data itself (0), then the end of each run. */
  private stops(): number[] {
    return [0, ...timeBlocks(this.doc).map((b) => b.last + 1)];
  }

  private renderBar() {
    if (this.scrubbing) return;
    const d = this.doc;
    const blocks = timeBlocks(d);
    const on = blockAt(blocks, d.marker);
    const node = (b: TimeBlock, k: number) => {
      const steps = d.steps.slice(b.first, b.last + 1);
      const makes = this.hooks.stepSpec(steps[steps.length - 1].run)?.makes;
      // a running run fills its ring by the steps done, plus the one under way
      const done = steps.filter((s) => s.status === "done").length;
      const pct = b.status === "running" ? ` style="--p:${Math.round(((done + (steps.find((s) => s.status === "running")?.progress ?? 0)) / steps.length) * 100)}%"` : "";
      const badge = b.status === "failed" ? "warning" : b.status === "done" ? "check" : b.status === "proposed" ? "sparkle" : "";
      const label = `Run ${k + 1}: ${b.title}, ${STATUS_LABEL[b.status]}${steps.length > 1 ? `, ${steps.length} steps` : ""}${steps.every((s) => s.cached) ? " (cached)" : ""}`;
      return `<button class="tl-node tl-step data-step status-${b.status}${k === on ? " selected" : ""}${k > on ? " later" : ""}" data-index="${b.last + 1}" title="${escapeHtml(label)}"${pct}>${icon(makes ? kindIcon(makes) : "batch", 15)}${badge ? `<span class="tl-badge">${icon(badge, 9)}</span>` : ""}</button>`;
    };
    const link = `<span class="tl-link" aria-hidden="true"></span>`;
    const stops = this.stops();
    const pos = on + 1;
    const proposed = d.steps.some((s) => s.status === "proposed");
    const active = d.steps.some((s) => s.status === "running" || s.status === "queued");
    const redo = d.steps.some((s) => s.status === "stale" || s.status === "failed" || s.status === "cancelled");
    const b = blocks[on];
    this.bar.innerHTML = `
      <div class="tl-controls">
        <button class="icon-btn" data-step="0" title="The data itself">${icon("first")}</button>
        <button class="icon-btn" data-step="${stops[Math.max(0, pos - 1)]}" title="Previous run">${icon("undo")}</button>
        <button class="icon-btn" data-step="${stops[Math.min(stops.length - 1, pos + 1)]}" title="Next run">${icon("redo")}</button>
        <button class="icon-btn" data-step="${stops[stops.length - 1]}" title="Latest run">${icon("last")}</button>
      </div>
      <div class="tl-track" role="list" aria-label="History">
        <button class="tl-node tl-source ${d.marker === 0 ? "selected" : ""}" data-index="0" title="The data: ${escapeHtml(d.source.name ?? "")}">${icon(kindIcon(d.source.kind), 16)}</button>
        ${blocks.length ? `${link}${blocks.map(node).join(link)}` : `<span class="tl-empty">Each run you add from ⋯ lands here as one block: click it to see what it made</span>`}
        ${blocks.length ? `<span class="tl-marker" role="slider" tabindex="0" aria-label="Point in history" title="Drag to go back and forth in time" aria-valuemin="0" aria-valuemax="${blocks.length}"></span>` : ""}
      </div>
      <div class="tl-actions">
        ${proposed ? `<button class="tl-text primary-text" data-act="approve">${icon("batch", 14)}<span>Approve</span></button>` : ""}
        ${active ? `<button class="tl-text" data-act="cancel">Cancel</button>` : ""}
        ${redo && !active ? `<button class="tl-text" data-act="rerun">${icon("redo", 14)}<span>Re-run</span></button>` : ""}
        ${blocks.length ? `<button class="tl-text" data-act="fork" title="Open a new window with the history up to here">${icon("branch", 14)}<span>Fork</span></button>` : ""}
        <button class="tl-text" data-act="suggest" aria-haspopup="menu" title="Books and operations that take what's on view">${icon("sparkle", 14)}<span>Suggest</span><span class="caret" aria-hidden="true">▾</span></button>
      </div>`;
    const marker = this.bar.querySelector<HTMLElement>(".tl-marker");
    if (!marker) return;
    this.placeMarker(marker, this.markerXs()[pos], pos);
    if (this.refocusMarker) {
      this.refocusMarker = false;
      marker.focus({ preventScroll: true });
    }
  }

  /** The marker's x at each stop, in the track: in the gap just after the data, then after each run. */
  private markerXs(): number[] {
    return [...this.bar.querySelectorAll<HTMLElement>(".tl-track .tl-node")].map((n) => n.offsetLeft + n.offsetWidth + 7);
  }

  /** Moves the marker to `x` and shows stop `pos` as the point in history: the runs after it are later. */
  private placeMarker(marker: HTMLElement, x: number, pos: number) {
    marker.style.setProperty("--x", `${x}px`);
    marker.setAttribute("aria-valuenow", String(pos));
    marker.setAttribute("aria-valuetext", this.where(this.stops()[pos]));
    this.bar.querySelectorAll<HTMLElement>(".tl-track .tl-node").forEach((n, i) => {
      n.classList.toggle("selected", i === pos);
      if (i > 0) n.classList.toggle("later", i > pos);
    });
  }

  /** Drags the marker (or jumps it to a press on the track); the window follows as it passes each run. */
  private scrub(e: PointerEvent) {
    const track = this.bar.querySelector<HTMLElement>(".tl-track");
    const marker = track?.querySelector<HTMLElement>(".tl-marker");
    if (!track || !marker) return;
    e.preventDefault();
    const xs = this.markerXs();
    const stops = this.stops();
    let pos = blockAt(timeBlocks(this.doc), this.doc.marker) + 1;
    marker.setPointerCapture(e.pointerId);
    marker.focus({ preventScroll: true });
    marker.classList.add("dragging");
    this.scrubbing = true;
    const move = (ev: PointerEvent) => {
      // the marker follows the pointer; the point in history is the nearest stop
      const x = Math.max(xs[0], Math.min(xs[xs.length - 1], ev.clientX - track.getBoundingClientRect().left + track.scrollLeft));
      const near = xs.reduce((best, v, i) => (Math.abs(v - x) < Math.abs(xs[best] - x) ? i : best), 0);
      this.placeMarker(marker, x, near);
      if (near === pos) return;
      pos = near;
      this.hooks.select(this.doc, stops[pos]);
    };
    const up = () => {
      marker.removeEventListener("pointermove", move);
      marker.removeEventListener("pointerup", up);
      marker.removeEventListener("pointercancel", up);
      marker.classList.remove("dragging");
      this.scrubbing = false;
      this.refocusMarker = true;
      this.renderBar();
    };
    marker.addEventListener("pointermove", move);
    marker.addEventListener("pointerup", up);
    marker.addEventListener("pointercancel", up);
    move(e);
  }

  // ---------------------------------------------------------- drawer

  private async renderDrawer() {
    const d = this.doc;
    const step = d.marker > 0 ? d.steps[d.marker - 1] : null;
    const block = timeBlocks(d)[blockAt(timeBlocks(d), d.marker)];
    const run = block ? d.steps.slice(block.first, block.last + 1) : [];
    const key = `${d.marker}|${step ? `${step.status}|${d.output ?? ""}|${step.error ?? ""}|${JSON.stringify(run.map((s) => [s.status, s.with]))}` : d.steps.map((s) => s.status).join()}|${d.rationale ?? ""}`;
    if (key === this.drawerKey) return;
    this.drawerKey = key;
    this.runCtl = null;
    this.nextCtl = [];
    if (!step) {
      const proposed = d.steps.some((s) => s.status === "proposed");
      const a = d.source;
      const summary = a.meta.summary as Record<string, unknown> | undefined;
      const facts = summary
        ? [summary.axes && `axes ${summary.axes}`, Array.isArray(summary.shape) && (summary.shape as number[]).join(" × "), summary.dtype, (summary.timepoints as number) > 1 && `${summary.timepoints} time points`].filter(Boolean).join(" · ")
        : "";
      this.ctl.innerHTML = `
        <p class="ctl-summary">${escapeHtml(a.kind)} · ${escapeHtml(a.format)} · ${formatSize(a.sizeBytes ?? 0)}${facts ? `<br/>${escapeHtml(facts)}` : ""}</p>
        ${d.rationale ? `<section class="ctl-sec"><p class="dv-why">${icon("sparkle", 13)} ${escapeHtml(d.rationale)}</p>${proposed ? `<button class="primary dv-approve" data-act="approve">${icon("batch", 14)} Approve and run</button>` : ""}</section>` : ""}`;
      // then every book action that fits the data, ready to run from here
      const next = await this.hooks.nextActions(d).catch(() => []);
      if (this.drawerKey !== key || !next.length) return;
      this.nextCtl = next;
      this.ctl.insertAdjacentHTML("beforeend", this.nextHtml(next, "Available actions"));
      return;
    }
    const editable = run.every((s) => s.status !== "running" && s.status !== "queued");
    // a book's run shows the book's design for this data; a run of one operation, its settings
    const [ctl, next] = await Promise.all([block && step.book ? this.hooks.runControls(d, block.first) : null, this.hooks.nextActions(d).catch(() => [])]);
    if (this.drawerKey !== key) return;
    this.nextCtl = next;
    const spec = ctl ? undefined : this.hooks.stepSpec(step.run);
    const apply = `<button type="button" class="primary" data-act="update">${icon("redo", 14)} Apply and re-run</button>`;
    let settings = "";
    if (ctl) {
      this.runCtl = { first: block!.first, specs: ctl.sections.flatMap((sec) => sec.params) };
      const section = (sec: RunControls["sections"][number]) => {
        const body = `${sec.note ? `<p class="muted small">${escapeHtml(sec.note)}</p>` : ""}${manifestParamFields(sec.params, ctl.values)}`;
        return sec.folded
          ? `<details class="ctl-sec dv-more"><summary class="ctl-sec-title">${icon("chevron-right", 12)}${escapeHtml(sec.title)}</summary>${body}</details>`
          : `<section class="ctl-sec"><p class="ctl-sec-title">${escapeHtml(sec.title)}</p>${body}</section>`;
      };
      settings = `<form class="dv-params" ${editable ? "" : "inert"}>${ctl.sections.map(section).join("")}${this.runCtl.specs.length ? apply : ""}</form>`;
    } else if (spec?.params.length) {
      settings = `<section class="ctl-sec"><p class="ctl-sec-title">Settings</p><form class="dv-params" ${editable ? "" : "inert"}>${manifestParamFields(spec.params, step.with)}${apply}</form></section>`;
    } else settings = `<p class="muted small">This step has no settings to change.</p>`;
    this.ctl.innerHTML = `
      <div class="dv-head"><p class="ctl-summary">${escapeHtml(this.stepOf(d.marker))} · ${escapeHtml(STATUS_LABEL[step.status])}</p></div>
      <details class="dv-log"${this.logOpen ? " open" : ""}><summary class="link-btn">View log</summary>
        <p class="ctl-summary">${escapeHtml(this.where(d.marker))}<br/>${escapeHtml(STATUS_LABEL[step.status])}${step.cached ? " (cached result)" : ""}</p>
        ${step.jobId ? `<button type="button" class="link-btn" data-act="log" data-job="${escapeHtml(step.jobId)}">Open the full log</button>` : `<p class="muted small">No log yet: this step hasn't run.</p>`}
      </details>
      ${spec ? `<p class="muted small">${escapeHtml(spec.summary)}</p>` : ""}
      ${step.error ? `<p class="chat-warn">${escapeHtml(step.error)}</p>` : ""}
      ${settings}
      ${this.nextHtml(next, "Next")}
      <section class="ctl-sec"><button class="link danger" data-act="remove">${block && block.last > block.first ? "Remove this run" : "Remove this step"}${block && d.steps.length - 1 > block.last ? " and the ones that use it" : ""}</button></section>`;
    this.ctl.querySelector<HTMLDetailsElement>(".dv-log")!.addEventListener("toggle", (e) => (this.logOpen = (e.currentTarget as HTMLDetailsElement).open));
  }

  /**
   * Actions to run from the Controls: each laid out by its book's design (its sections that fit
   * this data, with their notes), its defaults filled in, and one button named for what it does.
   * With several, the first is open and the rest fold away.
   */
  private nextHtml(list: NextAction[], heading: string): string {
    if (!list.length) return "";
    const one = (a: NextAction, i: number) => {
      const sections = a.sections
        .map((sec) => {
          const body = `${sec.note ? `<p class="muted small">${escapeHtml(sec.note)}</p>` : ""}${manifestParamFields(sec.params, a.values)}`;
          return sec.folded
            ? `<details class="dv-more"><summary class="ctl-sec-title">${icon("chevron-right", 12)}${escapeHtml(sec.title)}</summary>${body}</details>`
            : `<div class="dv-next-sec"><p class="dv-next-sub">${escapeHtml(sec.title)}</p>${body}</div>`;
        })
        .join("");
      return `<form class="dv-next-form">${a.summary ? `<p class="muted small">${escapeHtml(a.summary)}</p>` : ""}${sections}
        <button type="button" class="primary" data-act="next" data-next="${i}">${escapeHtml(a.title)}</button></form>`;
    };
    const items = list.map((a, i) =>
      list.length === 1
        ? `<p class="dv-next-title">${escapeHtml(a.title)} <small>${escapeHtml(a.book.title)}</small></p>${one(a, i)}`
        : `<details class="dv-more dv-next-item"${i === 0 ? " open" : ""}><summary class="ctl-sec-title">${icon("chevron-right", 12)}${escapeHtml(a.title)} <small>${escapeHtml(a.book.title)}</small></summary>${one(a, i)}</details>`,
    );
    return `<section class="ctl-sec dv-next"><p class="ctl-sec-title">${escapeHtml(heading)}</p>${items.join("")}</section>`;
  }

  /** "Step 2 of 3": the step's place in its run. */
  private stepOf(marker: number): string {
    const b = timeBlocks(this.doc)[blockAt(timeBlocks(this.doc), marker)];
    return b ? `Step ${marker - b.first} of ${b.last - b.first + 1}` : "The data itself";
  }

  // ---------------------------------------------------------- clicks

  private onClick(e: Event) {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-index],[data-step],[data-act],[data-output],[data-view]");
    if (!el) return;
    const d = this.doc;
    if (el.dataset.index !== undefined) return this.hooks.select(d, Number(el.dataset.index), el.dataset.output);
    if (el.dataset.step !== undefined) return this.hooks.select(d, Number(el.dataset.step));
    if (el.dataset.output !== undefined) return this.hooks.select(d, d.marker, el.dataset.output);
    if (el.dataset.view !== undefined) return void this.showWith(el.dataset.view);
    switch (el.dataset.act) {
      case "approve":
        return this.hooks.approve(d);
      case "cancel":
        return this.hooks.cancel(d);
      case "log":
        return this.hooks.showLog(el.dataset.job!);
      case "rerun":
        return this.hooks.rerun(d);
      case "fork":
        return this.hooks.fork(d);
      case "suggest":
        return this.hooks.suggestMenu(d, el.getBoundingClientRect());
      case "remove": {
        // a run goes as a whole
        const b = timeBlocks(d)[blockAt(timeBlocks(d), d.marker)];
        return this.hooks.removeStep(d, b ? b.first : d.marker - 1);
      }
      case "next": {
        const a = this.nextCtl[Number(el.dataset.next)];
        const form = el.closest("form");
        if (!a || !form?.reportValidity()) return;
        return this.hooks.runNext(d, a.book.id, a.action, readManifestParams(a.sections.flatMap((sec) => sec.params), form));
      }
      case "update": {
        const form = this.ctl.querySelector<HTMLFormElement>(".dv-params");
        if (!form) return;
        if (this.runCtl) return this.hooks.updateRun(d, this.runCtl.first, readManifestParams(this.runCtl.specs, form));
        const spec = this.hooks.stepSpec(d.steps[d.marker - 1].run);
        if (spec) this.hooks.updateStep(d, d.marker - 1, readManifestParams(spec.params, form));
        return;
      }
    }
  }

  /** The image on view, if the window shows one. */
  shownImage(): { image: Image; artifactId: string } | null {
    const { artifactId } = this.shown();
    const entry = artifactId ? this.loaded.get(artifactId) : undefined;
    return entry && !(entry instanceof Promise) && entry.type === "image" && artifactId ? { image: entry.image, artifactId } : null;
  }

  /**
   * A small picture of what the window shows now, for the minimised-window shelf: the image
   * at the slice, frame and contrast on view, the video's current frame, or the model as
   * turned. Null for what has no picture (a table, a case's summary).
   */
  thumbnail(max: number): HTMLCanvasElement | null {
    const { artifactId } = this.shown();
    if (!artifactId) return null;
    // a ship's view of the data, when one is shown in its place
    const entry = this.loaded.get(this.viewed.get(artifactId) ?? artifactId);
    if (entry && !(entry instanceof Promise) && entry.type === "image") return thumbnailElement(entry.image, entry.view, max);
    return this.mounted?.snapshot?.(max) ?? null;
  }

  /** The kind of what the window shows now (the data's, or a result's), for an icon when there's no picture. */
  shownKind(): string {
    const { artifactId } = this.shown();
    return (artifactId && this.artifacts.get(this.viewed.get(artifactId) ?? artifactId)?.kind) || this.doc.source.kind;
  }

  /** The artifact on view, once known. */
  async shownArtifact(): Promise<Artifact | null> {
    const { artifactId } = this.shown();
    return artifactId ? this.artifact(artifactId) : null;
  }

  destroy() {
    this.unmount();
    this.clearGrid();
    for (const entry of this.loaded.values()) if (!(entry instanceof Promise)) releaseView(entry);
  }
}
