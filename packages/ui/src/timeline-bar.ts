/**
 * The timeline bar along the bottom of the window, in the style of the
 * feature timeline in Fusion or Inventor: one icon per step, a marker you
 * drag to roll back, and steps you can click to edit, suppress, branch or
 * delete, or drag to reorder (or onto another tab to copy them there).
 */
import { type Step, getCommand, parseParams } from "@pharos/core";
import { escapeHtml, paramFields, readParamFields } from "./dialogs.js";
import { icon } from "./icons.js";
import type { Doc } from "./workspace.js";

/** Drag data type for a timeline step (copy it to another image by dropping on a tab). */
export const STEP_MIME = "application/x-pharos-step";

export interface StepPayload {
  docId: string;
  stepId: string;
  command: string;
  params: Record<string, unknown>;
}

export interface TimelineBarHooks {
  /** Runs a possibly slow change with a busy indicator and error reporting. */
  run(label: string, fn: () => void): Promise<void>;
  branch(doc: Doc, step: number): void;
  batch(doc: Doc): void;
}

export function stepTitle(s: Step): string {
  const cmd = getCommand(s.command);
  const summary = cmd.summary?.(s.params);
  return cmd.title.replace(/…$/, "") + (summary ? ` (${summary})` : "");
}

export class TimelineBar {
  private doc: Doc | null = null;
  private selected: string | null = null;
  private markerDrag = false;
  private readonly track: HTMLElement;
  private readonly popover: HTMLElement;

  constructor(
    private readonly root: HTMLElement,
    private readonly hooks: TimelineBarHooks,
  ) {
    root.innerHTML = `
      <div class="tl-controls">
        <button class="icon-btn" data-tl="first" title="Roll back to the original">${icon("first")}</button>
        <button class="icon-btn" data-tl="undo" title="Step back (undo)">${icon("undo")}</button>
        <button class="icon-btn" data-tl="redo" title="Step forward (redo)">${icon("redo")}</button>
        <button class="icon-btn" data-tl="last" title="Apply all steps">${icon("last")}</button>
      </div>
      <div class="tl-track" role="list" aria-label="Timeline"></div>
      <div class="tl-info"></div>
      <div class="tl-actions">
        <button class="tl-text" data-tl="batch" title="Run these steps on every image in a folder">${icon("batch", 15)}<span>Run on folder</span></button>
      </div>`;
    this.track = root.querySelector(".tl-track")!;
    this.popover = document.createElement("div");
    this.popover.className = "tl-popover";
    this.popover.hidden = true;
    document.body.append(this.popover);

    root.querySelector(".tl-controls")!.addEventListener("click", (e) => {
      const t = this.doc?.timeline;
      const what = (e.target as HTMLElement).closest<HTMLElement>("[data-tl]")?.dataset.tl;
      if (!t || !what) return;
      void this.hooks.run("Updating", () => {
        if (what === "first") t.seek(0);
        if (what === "undo") t.undo();
        if (what === "redo") t.redo();
        if (what === "last") t.seek(t.steps.length);
      });
    });
    root.querySelector(".tl-actions")!.addEventListener("click", (e) => {
      const what = (e.target as HTMLElement).closest<HTMLElement>("[data-tl]")?.dataset.tl;
      if (!this.doc || !what) return;
      if (what === "batch") this.hooks.batch(this.doc);
    });

    this.wireTrack();
    document.addEventListener("pointerdown", this.onOutside);
    document.addEventListener("keydown", this.onEscape, true);
  }

  private readonly onOutside = (e: PointerEvent) => {
    if (!this.popover.hidden && !this.popover.contains(e.target as Node) && !(e.target as HTMLElement).closest(".tl-node")) this.closePopover();
  };

  private readonly onEscape = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !this.popover.hidden) {
      e.stopPropagation();
      this.closePopover();
    }
  };

  /** Removes the step editor and global listeners (when the window closes). */
  destroy() {
    this.popover.remove();
    document.removeEventListener("pointerdown", this.onOutside);
    document.removeEventListener("keydown", this.onEscape, true);
  }

  setDoc(doc: Doc | null) {
    if (doc !== this.doc) this.closePopover();
    this.doc = doc;
    this.render();
  }

  render() {
    const doc = this.doc;
    this.root.classList.toggle("empty", !doc);
    const t = doc?.timeline;
    this.root.querySelectorAll<HTMLButtonElement>(".tl-controls button, .tl-actions button").forEach((b) => {
      if (!b.dataset.tl) return;
      const what = b.dataset.tl;
      b.disabled = !t || (what === "first" || what === "undo" ? !t.canUndo : what === "redo" || what === "last" ? !t.canRedo : what === "batch" ? !t.recipe().steps.length : false);
    });
    if (this.markerDrag) return this.updateStates();
    if (!doc || !t) {
      this.track.innerHTML = `<span class="tl-empty">No steps yet</span>`;
      this.root.querySelector(".tl-info")!.textContent = "";
      return;
    }
    if (!t.steps.length) {
      this.track.innerHTML = `<span class="tl-node tl-source" title="Original image">${icon(doc.parent ? "branch" : "image", 16)}</span><span class="tl-empty">History: every step you apply lands here, editable</span>`;
      this.root.querySelector(".tl-info")!.textContent = "";
      return;
    }
    const parts: string[] = [
      `<button class="tl-node tl-source" data-index="0" title="Original: ${escapeHtml(t.source.name ?? doc.name)}${doc.parent ? ` (branched from ${escapeHtml(doc.parent.name)})` : ""}">${icon(doc.parent ? "branch" : "image")}</button>`,
    ];
    t.steps.forEach((s, i) => {
      if (i === t.marker) parts.push(this.markerHtml());
      parts.push(`<span class="tl-link"></span>`);
      parts.push(
        `<button class="tl-node tl-step" draggable="true" role="listitem" data-id="${s.id}" data-index="${i + 1}">${icon(getCommand(s.command).icon)}${s.origin === "ai" ? `<span class="tl-badge" aria-label="suggested by AI">${icon("sparkle", 10)}</span>` : ""}</button>`,
      );
    });
    if (t.marker === t.steps.length) parts.push(this.markerHtml());
    this.track.innerHTML = parts.join("");
    this.updateStates();
    if (this.selected && !t.steps.some((s) => s.id === this.selected)) this.closePopover();
    else if (this.selected) this.positionPopover();
    // keep the marker in view on long timelines
    this.track.querySelector(".tl-marker")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  private markerHtml() {
    return `<span class="tl-marker" title="Drag to roll back or forward" role="slider" aria-label="Timeline position" tabindex="0"></span>`;
  }

  /** Updates per-step classes and tooltips without rebuilding (safe during a marker drag). */
  private updateStates() {
    const t = this.doc?.timeline;
    if (!t) return;
    const marker = this.markerIndex();
    this.track.querySelectorAll<HTMLElement>(".tl-step").forEach((el) => {
      const i = Number(el.dataset.index);
      const s = t.steps[i - 1];
      if (!s) return;
      el.classList.toggle("rolled", i > marker);
      el.classList.toggle("off", !s.enabled);
      el.classList.toggle("error", !!s.error);
      el.classList.toggle("selected", s.id === this.selected);
      const notes = [s.ms !== undefined && s.enabled ? `${s.ms} ms` : "", s.origin === "ai" ? "suggested by AI" : "", !s.enabled ? "suppressed" : "", i > marker ? "rolled back" : "", s.error ? `failed: ${s.error}` : ""].filter(Boolean);
      el.title = `${i}. ${stepTitle(s)}${notes.length ? ` · ${notes.join(" · ")}` : ""}`;
      el.setAttribute("aria-label", el.title);
    });
    const marker$ = this.track.querySelector<HTMLElement>(".tl-marker");
    marker$?.setAttribute("aria-valuenow", String(marker));
    marker$?.setAttribute("aria-valuemax", String(t.steps.length));
    const applied = t.steps.slice(0, marker).filter((s) => s.enabled).length;
    this.root.querySelector(".tl-info")!.textContent = t.steps.length ? `${applied}/${t.steps.length} applied` : "";
  }

  /** The marker's position as shown (while dragging it can differ from the timeline's). */
  private markerIndex(): number {
    const m = this.track.querySelector(".tl-marker");
    if (!m) return this.doc?.timeline.marker ?? 0;
    let n = 0;
    for (let el = m.previousElementSibling; el; el = el.previousElementSibling) if (el.classList.contains("tl-step")) n++;
    return n;
  }

  private wireTrack() {
    const track = this.track;

    // click a step to open its editor; double-click to roll the marker to it
    track.addEventListener("click", (e) => {
      const node = (e.target as HTMLElement).closest<HTMLElement>(".tl-node");
      const t = this.doc?.timeline;
      if (!node || !t) return;
      if (node.classList.contains("tl-source")) {
        void this.hooks.run("Rolling back", () => t.seek(0));
        return;
      }
      const id = node.dataset.id!;
      if (this.selected === id) this.closePopover();
      else this.openPopover(id);
    });
    track.addEventListener("dblclick", (e) => {
      const node = (e.target as HTMLElement).closest<HTMLElement>(".tl-step");
      const t = this.doc?.timeline;
      if (node && t) void this.hooks.run("Rolling", () => t.seek(Number(node.dataset.index)));
    });

    // drag the marker to roll back and forward, previewing as it moves
    track.addEventListener("pointerdown", (e) => {
      const marker = (e.target as HTMLElement).closest<HTMLElement>(".tl-marker");
      const t = this.doc?.timeline;
      if (!marker || !t) return;
      e.preventDefault();
      // capture on the track: the marker element itself moves around the DOM while dragging
      track.setPointerCapture(e.pointerId);
      this.markerDrag = true;
      marker.classList.add("dragging");
      const move = (ev: PointerEvent) => {
        const n = this.gapAt(ev.clientX);
        if (n === this.markerIndex()) return;
        const nodes = [...track.querySelectorAll<HTMLElement>(".tl-node")];
        nodes[n].after(marker);
        t.seek(n);
        this.updateStates();
      };
      const up = () => {
        track.removeEventListener("pointermove", move);
        track.removeEventListener("pointerup", up);
        track.removeEventListener("pointercancel", up);
        this.markerDrag = false;
        this.render();
      };
      track.addEventListener("pointermove", move);
      track.addEventListener("pointerup", up);
      track.addEventListener("pointercancel", up);
    });
    track.addEventListener("keydown", (e) => {
      const t = this.doc?.timeline;
      if (!t || !(e.target as HTMLElement).classList.contains("tl-marker")) return;
      if (e.key === "ArrowLeft") t.undo();
      else if (e.key === "ArrowRight") t.redo();
      else return;
      e.preventDefault();
      queueMicrotask(() => this.track.querySelector<HTMLElement>(".tl-marker")?.focus());
    });

    // drag steps to reorder them, or onto a tab to copy them there
    track.addEventListener("dragstart", (e) => {
      const node = (e.target as HTMLElement).closest<HTMLElement>(".tl-step");
      const doc = this.doc;
      if (!node || !doc || !e.dataTransfer) return;
      const s = doc.timeline.steps.find((x) => x.id === node.dataset.id)!;
      const payload: StepPayload = { docId: doc.id, stepId: s.id, command: s.command, params: s.params };
      e.dataTransfer.setData(STEP_MIME, JSON.stringify(payload));
      e.dataTransfer.effectAllowed = "copyMove";
      node.classList.add("dragging");
      document.body.classList.add("dragging-step");
      this.closePopover();
    });
    track.addEventListener("dragend", () => {
      track.querySelectorAll(".dragging, .drop-before, .drop-after").forEach((el) => el.classList.remove("dragging", "drop-before", "drop-after"));
      document.body.classList.remove("dragging-step");
    });
    track.addEventListener("dragover", (e) => {
      if (!e.dataTransfer?.types.includes(STEP_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const to = this.stepSlotAt(e.clientX);
      const steps = [...track.querySelectorAll<HTMLElement>(".tl-step")];
      steps.forEach((el, i) => {
        el.classList.toggle("drop-before", i === to);
        el.classList.toggle("drop-after", to === steps.length && i === steps.length - 1);
      });
    });
    track.addEventListener("drop", (e) => {
      const raw = e.dataTransfer?.getData(STEP_MIME);
      const doc = this.doc;
      if (!raw || !doc) return;
      e.preventDefault();
      e.stopPropagation(); // the window around this line would otherwise copy it too
      const p = JSON.parse(raw) as StepPayload;
      const slot = this.stepSlotAt(e.clientX);
      if (p.docId === doc.id) {
        const from = doc.timeline.steps.findIndex((s) => s.id === p.stepId);
        void this.hooks.run("Reordering", () => doc.timeline.move(p.stepId, slot > from ? slot - 1 : slot));
      } else {
        // dropped from another image's timeline: insert a copy here
        void this.hooks.run("Copying step", () => {
          doc.timeline.seek(slot);
          doc.timeline.apply(p.command, p.params);
        });
      }
    });
  }

  /** The marker gap (number of steps before it) nearest to clientX. */
  private gapAt(x: number): number {
    const nodes = [...this.track.querySelectorAll<HTMLElement>(".tl-node")];
    let best = 0;
    nodes.forEach((n, i) => {
      const r = n.getBoundingClientRect();
      if (x > r.left + r.width / 2) best = i;
    });
    return best;
  }

  /** Insertion slot among steps (0..steps.length) for a drop at clientX. */
  private stepSlotAt(x: number): number {
    const steps = [...this.track.querySelectorAll<HTMLElement>(".tl-step")];
    const i = steps.findIndex((n) => {
      const r = n.getBoundingClientRect();
      return x < r.left + r.width / 2;
    });
    return i < 0 ? steps.length : i;
  }

  // ------------------------------------------------------------ step editor

  private openPopover(id: string) {
    const doc = this.doc;
    if (!doc) return;
    const t = doc.timeline;
    const i = t.steps.findIndex((s) => s.id === id);
    const s = t.steps[i];
    const cmd = getCommand(s.command);
    this.selected = id;
    const hasParams = Object.keys(cmd.params).length > 0;
    this.popover.innerHTML = `
      <header>${icon(cmd.icon, 20)}<div><strong>${escapeHtml(cmd.title.replace(/…$/, ""))}</strong><small>Step ${i + 1} of ${t.steps.length}${s.origin === "ai" ? " · suggested by AI" : ""}${s.ms !== undefined ? ` · ${s.ms} ms` : ""}</small></div></header>
      ${s.error ? `<p class="error">${icon("warning", 14)} ${escapeHtml(s.error)}</p>` : ""}
      ${hasParams ? `<form class="tl-params">${paramFields(cmd, s.params)}<p class="muted small">Later steps re-run when you change this.</p></form>` : `<p class="muted small">${escapeHtml(cmd.description)}</p>`}
      <div class="tl-pop-actions">
        <button data-act="toggle" title="${s.enabled ? "Suppress: skip this step but keep it" : "Restore this step"}">${icon(s.enabled ? "eye-off" : "eye", 16)}<span>${s.enabled ? "Suppress" : "Restore"}</span></button>
        <button data-act="roll" title="Move the marker to just after this step">${icon("rollback", 16)}<span>Roll here</span></button>
        <button data-act="branch" title="Open the image at this step in a new tab, keeping its steps">${icon("branch", 16)}<span>New tab</span></button>
        <button data-act="delete" class="danger" title="Delete this step">${icon("trash", 16)}<span>Delete</span></button>
      </div>`;
    this.popover.hidden = false;
    this.positionPopover();
    this.updateStates();

    const form = this.popover.querySelector<HTMLFormElement>(".tl-params");
    form?.addEventListener("change", () => {
      const values = readParamFields(cmd, form);
      try {
        parseParams(cmd, values);
      } catch (e) {
        form.querySelector(".error")?.remove();
        form.insertAdjacentHTML("beforeend", `<p class="error">${escapeHtml(e instanceof Error ? e.message : String(e))}</p>`);
        return;
      }
      form.querySelector(".error")?.remove();
      void this.hooks.run(`Re-running from step ${i + 1}`, () => t.edit(id, values));
    });
    form?.addEventListener("submit", (e) => e.preventDefault());
    this.popover.querySelector(".tl-pop-actions")!.addEventListener("click", (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
      if (!act) return;
      const idx = t.steps.findIndex((x) => x.id === id);
      if (act === "toggle") {
        void this.hooks.run("Re-running", () => t.setEnabled(id, !t.steps[idx].enabled)).then(() => this.openPopover(id));
        return;
      }
      this.closePopover();
      if (act === "roll") void this.hooks.run("Rolling", () => t.seek(idx + 1));
      if (act === "branch") this.hooks.branch(doc, idx + 1);
      if (act === "delete") void this.hooks.run("Re-running", () => t.remove(id));
    });
  }

  private positionPopover() {
    const node = this.track.querySelector<HTMLElement>(`.tl-step[data-id="${this.selected}"]`);
    if (!node || this.popover.hidden) return;
    const r = node.getBoundingClientRect();
    const w = this.popover.offsetWidth;
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2));
    this.popover.style.left = `${left}px`;
    this.popover.style.bottom = `${window.innerHeight - this.root.getBoundingClientRect().top + 8}px`;
  }

  private closePopover() {
    this.selected = null;
    this.popover.hidden = true;
    this.updateStates();
  }
}
