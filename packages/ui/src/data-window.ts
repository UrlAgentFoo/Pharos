/**
 * The inside of a data window: a dataset and the processes applied to it,
 * laid out like an image window.
 *
 * - The body shows the data as of the selected history step, with the
 *   viewer for its kind: images and labels in the image viewer (slices,
 *   frames and channels), videos played, tables as tables, OpenFOAM cases
 *   as a summary of the case.
 * - The history strip along the bottom holds the dataset and one node per
 *   process (Fusion-style): click a node to see the data at that point.
 * - The Controls drawer shows the selected step's settings (change them and
 *   it re-runs from there), or for the dataset itself, what it is and the
 *   recipes and operations that fit it.
 */
import type { Artifact, CaseSummary, ParamSpec, Params } from "@pharos/contracts";
import { type Image, readTiff } from "@pharos/core";
import type { LocalServer } from "./api.js";
import { parseCsv } from "./csv.js";
import { escapeHtml, formatSize } from "./dialogs.js";
import { icon } from "./icons.js";
import { manifestParamFields, readManifestParams } from "./run-dialog.js";
import { type ViewState, Viewer, newViewState } from "./viewer.js";
import type { DataDoc, DataStep } from "./workspace.js";

/** Something that can be applied to the shown data: a recipe (book) or a single ship operation. */
export type Suggestion =
  | { type: "book"; id: string; title: string; summary: string; fit: string; trust: string }
  | { type: "op"; id: string; title: string; summary: string; trust: string };

export interface StepSpec {
  title: string;
  summary: string;
  params: ParamSpec[];
}

export interface DataWindowHooks {
  server(): LocalServer | null;
  /** Shows step `marker` (0 = the data itself), and which of its outputs. */
  select(doc: DataDoc, marker: number, output?: string): void;
  /** Opens the add-a-process menu under `anchor`. */
  addProcess(doc: DataDoc, anchor: DOMRect): void;
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

/** What a body shows for one artifact, kept while its window is open so switching steps is instant. */
type Loaded =
  | { type: "image"; image: Image; view: ViewState }
  | { type: "table"; rows: string[][]; total: number }
  | { type: "video"; url: string }
  | { type: "case"; summary: CaseSummary }
  | { type: "text"; text: string }
  | { type: "info" }
  | { type: "error"; message: string };

export class DataWindow {
  private readonly body: HTMLElement;
  private readonly stage: HTMLElement;
  private readonly bar: HTMLElement;
  readonly drawer: HTMLElement;
  private viewer: Viewer | null = null;
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
    this.body.innerHTML = `<div class="dv-outputs"></div><div class="dv-stage"></div><div class="dv-status" hidden></div>`;
    this.stage = this.body.querySelector(".dv-stage")!;
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
    this.renderBar();
    void this.renderBody();
    void this.renderDrawer();
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
    if (!artifactId || busy) {
      this.showLoaded(null);
      return;
    }
    let entry = this.loaded.get(artifactId);
    if (!entry) {
      entry = this.load(artifactId);
      this.loaded.set(artifactId, entry);
    }
    if (entry instanceof Promise) {
      this.stage.innerHTML = `<p class="dv-loading">Loading…</p>`;
      entry = await entry;
      this.loaded.set(artifactId, entry);
      if (this.shownKey !== key) return; // the selection moved on while loading
    }
    this.showLoaded(entry, await this.artifact(artifactId));
  }

  private async load(id: string): Promise<Loaded> {
    const s = this.hooks.server()!;
    try {
      const a = await this.artifact(id);
      if (a.kind === "volume" || a.kind === "labels") {
        const image = await readTiff(await s.artifactImage(this.doc.workspace, id), a.name);
        const view = newViewState(image);
        view.labels = a.kind === "labels";
        return { type: "image", image, view };
      }
      if (a.format === "csv") {
        const text = new TextDecoder().decode(await s.content(this.doc.workspace, id));
        const rows = parseCsv(text, 501);
        return { type: "table", rows, total: text.split("\n").filter((l) => l.trim()).length - 1 };
      }
      if (a.format === "mp4") return { type: "video", url: URL.createObjectURL(new Blob([await s.content(this.doc.workspace, id)], { type: "video/mp4" })) };
      if (a.format === "openfoam-case") return { type: "case", summary: await s.caseSummary(this.doc.workspace, id) };
      if (a.format === "json") return { type: "text", text: new TextDecoder().decode(await s.content(this.doc.workspace, id)) };
      return { type: "info" };
    } catch (e) {
      return { type: "error", message: e instanceof Error ? e.message : String(e) };
    }
  }

  private showLoaded(entry: Loaded | null, a?: Artifact) {
    if (!entry || entry.type !== "image") {
      this.viewer = null;
      this.stage.classList.remove("has-image");
    }
    if (!entry || !a) {
      this.stage.innerHTML = "";
      return;
    }
    switch (entry.type) {
      case "image": {
        const { slices, frames, channels } = entry.image.shape;
        this.stage.classList.add("has-image");
        this.stage.innerHTML = `<div class="dv-canvas"><canvas tabindex="0"></canvas><div class="win-readout"></div></div>
          <div class="dv-sliders">${[["z", slices, "Slice"], ["t", frames, "Frame"], ["c", channels, "Channel"]]
            .filter(([, n]) => (n as number) > 1)
            .map(([axis, n, label]) => `<label>${label}<input type="range" min="0" max="${(n as number) - 1}" value="${entry.view.pos[axis as "z" | "t" | "c"]}" data-axis="${axis}"/><output>${entry.view.pos[axis as "z" | "t" | "c"] + 1}/${n}</output></label>`)
            .join("")}</div>`;
        const readout = this.stage.querySelector<HTMLElement>(".win-readout")!;
        this.viewer = new Viewer(this.stage.querySelector("canvas")!, (info) => (readout.textContent = info || `${a.kind === "labels" ? "labels" : a.format} · ${this.viewer?.zoomPercent ?? 100}%`));
        this.viewer.show(entry.image, entry.view);
        this.stage.querySelectorAll<HTMLInputElement>("input[data-axis]").forEach((input) =>
          input.addEventListener("input", () => {
            const axis = input.dataset.axis as "z" | "t" | "c";
            entry.view.pos[axis] = Number(input.value);
            input.nextElementSibling!.textContent = `${Number(input.value) + 1}/${input.max === "0" ? 1 : Number(input.max) + 1}`;
            this.viewer?.render();
          }),
        );
        break;
      }
      case "table":
        this.stage.innerHTML = `<div class="dv-table artifact-table"><table><thead><tr>${(entry.rows[0] ?? []).map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>
          <tbody>${entry.rows.slice(1).map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
          <p class="dv-foot">${entry.total} rows${entry.total > 500 ? " · first 500 shown" : ""} · ${formatSize(a.sizeBytes ?? 0)}</p>`;
        break;
      case "video":
        this.stage.innerHTML = `<video class="dv-video" src="${entry.url}" controls autoplay loop muted playsinline></video>`;
        break;
      case "case": {
        const c = entry.summary;
        const times = c.times.filter((t) => t > 0);
        this.stage.innerHTML = `<div class="dv-card">
          <p class="eyebrow">OpenFOAM case${c.solved ? " · solved" : ""}</p>
          <h3>${escapeHtml(a.name ?? "case")}</h3>
          <dl>
            ${c.application ? `<dt>Solver</dt><dd>${escapeHtml(c.application)}</dd>` : ""}
            ${c.cells ? `<dt>Mesh</dt><dd>${c.cells.toLocaleString()} cells</dd>` : `<dt>Mesh</dt><dd>made when it runs (blockMesh)</dd>`}
            ${c.inletSpeed !== undefined ? `<dt>Inlet speed</dt><dd>${c.inletSpeed} m/s</dd>` : ""}
            ${c.viscosity !== undefined ? `<dt>Viscosity</dt><dd>${c.viscosity} m²/s</dd>` : ""}
            ${c.endTime !== undefined ? `<dt>End time</dt><dd>${c.endTime} s</dd>` : ""}
            <dt>Saved times</dt><dd>${times.length ? `${times.length} (${times[0]}-${times[times.length - 1]} s)` : "none yet"}</dd>
            <dt>Fields</dt><dd>${escapeHtml(c.fields.join(", ") || "none")}</dd>
            <dt>Boundaries</dt><dd>${c.patches.map((p) => `${escapeHtml(p.name)} <small>${escapeHtml(p.type)}</small>`).join(", ")}</dd>
          </dl>
          <p class="muted small">${c.solved ? "Add a process (⋯) to visualise it, e.g. a vorticity video." : "Add a process (⋯) to run it, e.g. the flow simulation recipe."}</p>
        </div>`;
        break;
      }
      case "text":
        this.stage.innerHTML = `<pre class="code dv-text">${escapeHtml(entry.text)}</pre>`;
        break;
      case "error":
        this.stage.innerHTML = `<div class="dv-card"><p class="eyebrow">Can't show this</p><p>${escapeHtml(entry.message)}</p></div>`;
        break;
      default:
        this.stage.innerHTML = `<div class="dv-card"><p class="eyebrow">${escapeHtml(a.kind)} · ${escapeHtml(a.format)}</p><h3>${escapeHtml(a.name ?? a.id)}</h3>
          <p class="muted">Pharos can't show this kind of data inside a window yet. It's stored at:</p><pre class="code">${escapeHtml(a.uri)}</pre></div>`;
    }
  }

  // ---------------------------------------------------------- history strip

  title(step: DataStep): string {
    return this.hooks.stepSpec(step.run)?.title ?? step.run;
  }

  private renderBar() {
    const d = this.doc;
    let lastBook = "";
    const nodes = d.steps
      .map((s, i) => {
        const group = s.book && s.book.id !== lastBook ? `<span class="tl-group" title="Recipe: ${escapeHtml(s.book.title)}">${escapeHtml(s.book.title)}</span>` : "";
        lastBook = s.book?.id ?? "";
        const glyph = s.status === "failed" ? "warning" : s.status === "done" ? "check" : s.status === "proposed" ? "sparkle" : "batch";
        const pct = s.status === "running" && s.progress !== undefined ? ` style="--p:${Math.round(s.progress * 100)}%"` : "";
        return `${group}<button class="tl-node tl-step data-step status-${s.status} ${d.marker === i + 1 ? "selected" : ""}" data-index="${i + 1}" title="${escapeHtml(this.title(s))}: ${STATUS_LABEL[s.status]}${s.cached ? " (cached)" : ""}"${pct}>${icon(glyph, 15)}</button>`;
      })
      .join(`<span class="tl-link" aria-hidden="true"></span>`);
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
        ${d.steps.length ? `<span class="tl-link" aria-hidden="true"></span>${nodes}` : `<span class="tl-empty">Processes you add from ⋯ land here: click one to see its result</span>`}
      </div>
      <div class="tl-info">${selected ? `${escapeHtml(this.title(selected))} · ${STATUS_LABEL[selected.status]}${selected.cached ? " (cached)" : ""}` : escapeHtml(d.source.kind === "sim-case" ? "case" : d.source.format)}</div>
      <div class="tl-actions">
        ${proposed ? `<button class="tl-text primary-text" data-act="approve">${icon("batch", 14)}<span>Approve</span></button>` : ""}
        ${active ? `<button class="tl-text" data-act="cancel">Cancel</button>` : ""}
        ${redo && !active ? `<button class="tl-text" data-act="rerun">${icon("redo", 14)}<span>Re-run</span></button>` : ""}
        <button class="tl-text" data-act="add">${icon("plus", 14)}<span>Process</span></button>
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
    if (el.dataset.index !== undefined) return this.hooks.select(d, Number(el.dataset.index));
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
      case "add":
        return this.hooks.addProcess(d, el.getBoundingClientRect());
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
    for (const entry of this.loaded.values()) if (!(entry instanceof Promise) && entry.type === "video") URL.revokeObjectURL(entry.url);
  }
}
