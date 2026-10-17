/**
 * The inside of a data window: a dataset and the processes applied to it,
 * laid out like an image window.
 *
 * - The body shows the data as of the selected history step, with the
 *   viewer for its kind: images and labels in the image viewer (slices,
 *   frames and channels), videos played, tables as tables, OpenFOAM cases
 *   as a summary of the case.
 * - The history strip along the bottom holds the dataset and one node per
 *   process (Fusion-style), each with the icon of what it makes: click a
 *   node to see the data at that point.
 * - Results mode swaps the body for a grid of every result so far (two by
 *   two on screen, scrolling for more); click a tile to step to it.
 * - The Controls drawer shows the selected step's settings (change them and
 *   it re-runs from there), or for the dataset itself, what it is and the
 *   recipes and operations that fit it.
 */
import type { Artifact, ParamSpec, Params } from "@pharos/contracts";
import type { Image } from "@pharos/core";
import type { LocalServer } from "./api.js";
import { type Loaded, type Mounted, loadView, mountView, releaseView } from "./data-views.js";
import { escapeHtml, formatSize } from "./dialogs.js";
import { icon } from "./icons.js";
import { manifestParamFields, readManifestParams } from "./run-dialog.js";
import type { DataDoc, DataStep } from "./workspace.js";

/** Something that can be applied to the shown data: a recipe (book) or a single ship operation. */
export type Suggestion =
  | { type: "book"; id: string; title: string; summary: string; fit: string; trust: string }
  | { type: "op"; id: string; title: string; summary: string; trust: string };

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
  approve(doc: DataDoc): void;
  rerun(doc: DataDoc): void;
  cancel(doc: DataDoc): void;
  updateStep(doc: DataDoc, index: number, params: Params): void;
  removeStep(doc: DataDoc, index: number): void;
  apply(doc: DataDoc, s: Suggestion): void;
  suggestions(doc: DataDoc, artifact: Artifact): Promise<Suggestion[]>;
  stepSpec(run: string): StepSpec | undefined;
  /** Opens an artifact in a window of its own. */
  openSeparately(doc: DataDoc, artifact: Artifact): void;
  /** Opens an image in the image editor (with its tools and timeline). */
  openAsImage(artifact: Artifact, image: Image): void;
  notify(text: string): void;
}

export const KIND_ICON: Record<Artifact["kind"], string> = {
  volume: "image",
  labels: "binary",
  tracks: "link",
  table: "table",
  mesh: "cube",
  splat: "sparkle",
  "sim-case": "plane",
  video: "layout",
};

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
  private readonly grid: HTMLElement;
  private readonly bar: HTMLElement;
  readonly drawer: HTMLElement;
  private mounted: Mounted | null = null;
  private tiles: Mounted[] = [];
  private gridKey = "";
  private readonly loaded = new Map<string, Loaded | Promise<Loaded>>();
  private readonly artifacts = new Map<string, Artifact>();
  private shownKey = "";
  private drawerKey = "";

  constructor(
    private readonly doc: DataDoc,
    body: HTMLElement,
    bar: HTMLElement,
    private readonly hooks: DataWindowHooks,
  ) {
    this.body = body;
    this.body.classList.add("data-body");
    this.body.innerHTML = `<div class="dv-outputs"></div><div class="dv-stage"></div><div class="dv-status" hidden></div><div class="dv-grid" hidden></div>`;
    this.stage = this.body.querySelector(".dv-stage")!;
    this.grid = this.body.querySelector(".dv-grid")!;
    this.bar = bar;
    this.drawer = document.createElement("aside");
    this.drawer.className = "ctl-drawer data-drawer";
    this.body.addEventListener("click", (e) => this.onClick(e));
    this.drawer.addEventListener("click", (e) => this.onClick(e));
    this.drawer.addEventListener("submit", (e) => e.preventDefault());
    this.bar.addEventListener("click", (e) => this.onClick(e));
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
    const results = this.doc.ui.mode === "results";
    this.body.classList.toggle("results-mode", results);
    this.grid.hidden = !results;
    this.renderBar();
    if (results) void this.renderGrid();
    else {
      this.clearGrid();
      void this.renderBody();
    }
    void this.renderDrawer();
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
      const pct = step.progress !== undefined ? Math.round(step.progress * 100) : undefined;
      status.innerHTML = `<div class="dv-status-card ${step.status}">
        <strong>${escapeHtml(this.title(step))}</strong>
        <span>${escapeHtml(step.status === "failed" ? (step.error ?? "failed") : step.status === "proposed" ? "Proposed: approve to run it" : (step.message ?? STATUS_LABEL[step.status]))}</span>
        ${step.status === "running" || step.status === "queued" ? `<span class="job-bar"><span style="width:${pct ?? 0}%"></span></span>` : ""}
        ${step.status === "proposed" ? `<button class="primary" data-act="approve">${icon("batch", 14)} Approve and run</button>` : ""}
        ${step.status === "running" || step.status === "queued" ? `<button data-act="cancel">Cancel</button>` : ""}
      </div>`;
    }
    const key = `${artifactId}|${busy ? step!.status : "ok"}`;
    if (key === this.shownKey) return;
    this.shownKey = key;
    this.unmount();
    if (!artifactId || busy) {
      this.stage.innerHTML = "";
      return;
    }
    if (!(this.loaded.get(artifactId) && !(this.loaded.get(artifactId) instanceof Promise))) this.stage.innerHTML = `<p class="dv-loading">Loading…</p>`;
    const entry = await this.entry(artifactId);
    if (this.shownKey !== key) return; // the selection moved on while loading
    this.mounted = mountView(this.stage, entry, await this.artifact(artifactId));
  }

  private unmount() {
    this.mounted?.destroy();
    this.mounted = null;
    this.stage.classList.remove("has-image", "has-model");
  }

  // ---------------------------------------------------------- results grid

  /** Every result so far, step by step: [step index (1-based), output name, artifact id]. */
  private results(): [number, string, string][] {
    return this.doc.steps.flatMap((s, i) => (s.status === "done" ? Object.entries(s.outputs ?? {}).map(([n, id]) => [i + 1, n, id] as [number, string, string]) : []));
  }

  private async renderGrid() {
    // the stage's viewer would keep drawing underneath: free it while the grid is up
    this.unmount();
    this.shownKey = "";
    this.stage.innerHTML = "";
    this.body.querySelector<HTMLElement>(".dv-outputs")!.hidden = true;
    this.body.querySelector<HTMLElement>(".dv-status")!.hidden = true;
    const items = this.results();
    const key = items.map((r) => r.join(":")).join("|");
    if (key === this.gridKey) return;
    this.clearGrid();
    this.gridKey = key;
    this.grid.dataset.count = String(Math.min(items.length, 4));
    if (!items.length) {
      this.grid.innerHTML = `<p class="dv-grid-empty">No results yet. Add a process from ⋯; what it makes appears here.</p>`;
      return;
    }
    this.grid.innerHTML = items
      .map(([index, name, id]) => {
        const step = this.doc.steps[index - 1];
        return `<figure class="dv-tile">
          <figcaption><button class="dv-tile-go" data-index="${index}" data-output="${escapeHtml(name)}" title="Show in the history">${escapeHtml(this.title(step))} <small>${escapeHtml(name)}</small></button>
          <button class="icon-btn" data-separate="${escapeHtml(id)}" title="Open in its own window">${icon("expand", 13)}</button></figcaption>
          <div class="dv-stage" data-tile="${escapeHtml(id)}"><p class="dv-loading">Loading…</p></div></figure>`;
      })
      .join("");
    await Promise.all(
      items.map(async ([, , id]) => {
        const entry = await this.entry(id);
        const host = this.grid.querySelector<HTMLElement>(`[data-tile="${CSS.escape(id)}"]`);
        if (this.gridKey !== key || !host) return;
        this.tiles.push(mountView(host, entry, await this.artifact(id), true));
      }),
    );
  }

  private clearGrid() {
    for (const t of this.tiles) t.destroy();
    this.tiles = [];
    this.gridKey = "";
    this.grid.innerHTML = "";
  }

  // ---------------------------------------------------------- history strip

  title(step: DataStep): string {
    return this.hooks.stepSpec(step.run)?.title ?? step.run;
  }

  private renderBar() {
    const d = this.doc;
    // steps from one recipe sit together under a slim bracket; its name is the bracket's tooltip
    const runs: { book?: DataStep["book"]; items: [DataStep, number][] }[] = [];
    d.steps.forEach((s, i) => {
      const last = runs[runs.length - 1];
      if (last && s.book && last.book?.id === s.book.id) last.items.push([s, i]);
      else runs.push({ book: s.book, items: [[s, i]] });
    });
    const node = (s: DataStep, i: number) => {
      const makes = this.hooks.stepSpec(s.run)?.makes;
      const pct = s.status === "running" && s.progress !== undefined ? ` style="--p:${Math.round(s.progress * 100)}%"` : "";
      const badge = s.status === "failed" ? "warning" : s.status === "done" ? "check" : s.status === "proposed" ? "sparkle" : "";
      return `<button class="tl-node tl-step data-step status-${s.status} ${d.marker === i + 1 ? "selected" : ""}" data-index="${i + 1}" title="${escapeHtml(this.title(s))}: ${STATUS_LABEL[s.status]}${s.cached ? " (cached)" : ""}"${pct}>${icon(makes ? KIND_ICON[makes] : "batch", 15)}${badge ? `<span class="tl-badge">${icon(badge, 9)}</span>` : ""}</button>`;
    };
    const link = `<span class="tl-link" aria-hidden="true"></span>`;
    const nodes = runs
      .map((r) => {
        const inner = r.items.map(([s, i]) => node(s, i)).join(link);
        return r.book && r.items.length > 1 ? `<span class="tl-groupbox" title="Recipe: ${escapeHtml(r.book.title)}">${inner}</span>` : inner;
      })
      .join(link);
    const selected = d.marker > 0 ? d.steps[d.marker - 1] : null;
    const proposed = d.steps.some((s) => s.status === "proposed");
    const active = d.steps.some((s) => s.status === "running" || s.status === "queued");
    const redo = d.steps.some((s) => s.status === "stale" || s.status === "failed" || s.status === "cancelled");
    this.bar.innerHTML = `
      <div class="tl-controls">
        <button class="icon-btn" data-step="0" title="The data itself">${icon("first")}</button>
        <button class="icon-btn" data-step="${Math.max(0, d.marker - 1)}" title="Previous step">${icon("undo")}</button>
        <button class="icon-btn" data-step="${Math.min(d.steps.length, d.marker + 1)}" title="Next step">${icon("redo")}</button>
        <button class="icon-btn" data-step="${d.steps.length}" title="Latest result">${icon("last")}</button>
      </div>
      <div class="tl-track" role="list" aria-label="History">
        <button class="tl-node tl-source ${d.marker === 0 ? "selected" : ""}" data-index="0" title="The data: ${escapeHtml(d.source.name ?? "")}">${icon(KIND_ICON[d.source.kind], 16)}</button>
        ${d.steps.length ? `${link}${nodes}` : `<span class="tl-empty">Processes you add from ⋯ land here: click one to see its result</span>`}
      </div>
      <div class="tl-info">${selected ? `${escapeHtml(this.title(selected))} · ${STATUS_LABEL[selected.status]}${selected.cached ? " (cached)" : ""}` : escapeHtml(d.source.kind === "sim-case" ? "case" : d.source.format)}</div>
      <div class="tl-actions">
        ${proposed ? `<button class="tl-text primary-text" data-act="approve">${icon("batch", 14)}<span>Approve</span></button>` : ""}
        ${active ? `<button class="tl-text" data-act="cancel">Cancel</button>` : ""}
        ${redo && !active ? `<button class="tl-text" data-act="rerun">${icon("redo", 14)}<span>Re-run</span></button>` : ""}
      </div>`;
  }

  // ---------------------------------------------------------- drawer

  private async renderDrawer() {
    const d = this.doc;
    const step = d.marker > 0 ? d.steps[d.marker - 1] : null;
    const key = `${d.marker}|${step ? `${step.status}|${JSON.stringify(step.with)}|${step.error ?? ""}` : d.steps.map((s) => s.status).join()}|${d.rationale ?? ""}`;
    if (key === this.drawerKey) return;
    this.drawerKey = key;
    if (!step) {
      const proposed = d.steps.some((s) => s.status === "proposed");
      const a = d.source;
      const summary = a.meta.summary as Record<string, unknown> | undefined;
      const facts = summary
        ? [summary.axes && `axes ${summary.axes}`, Array.isArray(summary.shape) && (summary.shape as number[]).join(" × "), summary.dtype, (summary.timepoints as number) > 1 && `${summary.timepoints} time points`].filter(Boolean).join(" · ")
        : "";
      this.drawer.innerHTML = `
        <p class="ctl-summary">${escapeHtml(a.kind)} · ${escapeHtml(a.format)} · ${formatSize(a.sizeBytes ?? 0)}${facts ? `<br/>${escapeHtml(facts)}` : ""}</p>
        ${d.rationale ? `<section class="ctl-sec"><p class="dv-why">${icon("sparkle", 13)} ${escapeHtml(d.rationale)}</p>${proposed ? `<button class="primary dv-approve" data-act="approve">${icon("batch", 14)} Approve and run</button>` : ""}</section>` : ""}
        <section class="ctl-sec"><p class="ctl-sec-title">Suggested for this data</p><div class="dv-suggest"><p class="muted small">Looking…</p></div></section>`;
      const list = await this.hooks.suggestions(d, a).catch(() => []);
      if (this.drawerKey !== key) return;
      const box = this.drawer.querySelector(".dv-suggest");
      if (!box) return;
      box.innerHTML = list.length
        ? list
            .map(
              (s, i) => `<button class="dv-suggestion" data-suggest="${i}"><span>${icon(s.type === "book" ? "script" : "plug", 14)} <strong>${escapeHtml(s.title)}</strong></span>
                <small>${escapeHtml(s.type === "book" ? `Recipe · ${s.fit}` : "Operation")}${s.trust === "verified" ? " · verified" : ""}</small><small>${escapeHtml(s.summary)}</small></button>`,
            )
            .join("")
        : `<p class="muted small">Nothing in the library takes this data yet.</p>`;
      box.querySelectorAll<HTMLButtonElement>("[data-suggest]").forEach((b) => b.addEventListener("click", () => this.hooks.apply(d, list[Number(b.dataset.suggest)])));
      return;
    }
    const spec = this.hooks.stepSpec(step.run);
    const outputs = Object.entries(step.outputs ?? {});
    const editable = step.status !== "running" && step.status !== "queued";
    this.drawer.innerHTML = `
      <p class="ctl-summary">${step.book ? `${escapeHtml(step.book.title)} › ` : ""}${escapeHtml(step.run)}<br/>${escapeHtml(STATUS_LABEL[step.status])}${step.cached ? " (cached result)" : ""}</p>
      ${spec ? `<p class="muted small">${escapeHtml(spec.summary)}</p>` : ""}
      ${step.error ? `<p class="chat-warn">${escapeHtml(step.error)}</p>` : ""}
      ${spec?.params.length ? `<section class="ctl-sec"><p class="ctl-sec-title">Settings</p><form class="dv-params" ${editable ? "" : "inert"}>${manifestParamFields(spec.params, step.with)}
        <button type="button" class="primary" data-act="update">${icon("redo", 14)} Apply and re-run</button></form></section>` : ""}
      ${outputs.length ? `<section class="ctl-sec"><p class="ctl-sec-title">Results</p>${outputs
        .map(([n, id]) => `<div class="dv-out"><button class="chip ${(d.output ?? outputs[0][0]) === n ? "on" : ""}" data-output="${escapeHtml(n)}">${escapeHtml(n)}</button><button class="link" data-separate="${escapeHtml(id)}">own window</button></div>`)
        .join("")}</section>` : ""}
      <section class="ctl-sec"><button class="link danger" data-act="remove">Remove this step${d.steps.slice(d.marker).length ? " and the ones that use it" : ""}</button></section>`;
  }

  // ---------------------------------------------------------- clicks

  private onClick(e: Event) {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-index],[data-step],[data-act],[data-output],[data-separate]");
    if (!el) return;
    const d = this.doc;
    if (el.dataset.index !== undefined) {
      // a results tile steps to its result in the history view
      if (d.ui.mode === "results" && this.grid.contains(el)) d.ui.mode = "history";
      return this.hooks.select(d, Number(el.dataset.index), el.dataset.output);
    }
    if (el.dataset.step !== undefined) return this.hooks.select(d, Number(el.dataset.step));
    if (el.dataset.output !== undefined) return this.hooks.select(d, d.marker, el.dataset.output);
    if (el.dataset.separate !== undefined) {
      void this.artifact(el.dataset.separate).then((a) => this.hooks.openSeparately(d, a));
      return;
    }
    switch (el.dataset.act) {
      case "approve":
        return this.hooks.approve(d);
      case "cancel":
        return this.hooks.cancel(d);
      case "rerun":
        return this.hooks.rerun(d);
      case "remove":
        return this.hooks.removeStep(d, d.marker - 1);
      case "update": {
        const spec = this.hooks.stepSpec(d.steps[d.marker - 1].run);
        const form = this.drawer.querySelector<HTMLFormElement>(".dv-params");
        if (spec && form) this.hooks.updateStep(d, d.marker - 1, readManifestParams(spec.params, form));
        return;
      }
    }
  }

  /** The image on view, if the window shows one (for "open in the image editor"). */
  shownImage(): { image: Image; artifactId: string } | null {
    const { artifactId } = this.shown();
    const entry = artifactId ? this.loaded.get(artifactId) : undefined;
    return entry && !(entry instanceof Promise) && entry.type === "image" && artifactId ? { image: entry.image, artifactId } : null;
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
