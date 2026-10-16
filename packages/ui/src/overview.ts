/**
 * The overview: press Tab and every image window glides into a grid, Mission
 * Control style, grouped by lineage (images branched from one another sit
 * together). The search field on top doubles as the command palette, and
 * anything it cannot find can go to the assistant.
 */
import { escapeHtml } from "./dialogs.js";
import { icon } from "./icons.js";
import { formatShortcut } from "./keys.js";
import type { WindowManager } from "./windows.js";
import type { Doc, Workspace } from "./workspace.js";

/** Anything the palette can run: app actions and image commands alike. */
export interface Action {
  id: string;
  title: string;
  /** Menu path shown as context, e.g. "Process › Filters". */
  section: string;
  icon: string;
  shortcut?: string;
  keywords?: string[];
  description?: string;
  enabled(): boolean;
  run(): unknown;
}

export interface OverviewHooks {
  workspace: Workspace;
  windows: WindowManager;
  actions(): Action[];
  /** Sends a request to the assistant (opens the chat). */
  ask(request: string): void;
  aiUnavailable(): string | null;
  closeDoc(doc: Doc): void;
  openFiles(files: File[]): void;
  dtypeLabel(dtype: string): string;
}

interface Item {
  el: HTMLElement;
  activate(): void;
}

/** Scores how well `query` matches; 0 means no match. */
function score(query: string, title: string, extra: string): number {
  const q = query.toLowerCase().trim();
  const t = title.toLowerCase();
  if (!q) return 1;
  if (t.startsWith(q)) return 100 - t.length / 100;
  if (t.split(/[\s›(.-]+/).some((w) => w.startsWith(q))) return 80;
  if (t.includes(q)) return 60;
  const hay = `${t} ${extra.toLowerCase()}`;
  return q.split(/\s+/).every((w) => hay.includes(w)) ? 40 : 0;
}

const SEARCH_TOP = 150;

export class Overview {
  private readonly root: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly results: HTMLElement;
  private readonly labels: HTMLElement;
  private order: Doc[] = [];
  private items: Item[] = [];
  private sel = 0;
  private returnFocus: HTMLElement | null = null;

  constructor(private readonly hooks: OverviewHooks) {
    this.root = document.createElement("div");
    this.root.className = "overview";
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="ov-scrim"></div>
      <div class="ov-labels"></div>
      <div class="ov-top" role="dialog" aria-label="Overview and command palette">
        <label class="ov-search">${icon("search", 20)}
          <input type="text" spellcheck="false" autocomplete="off" placeholder="Search images and commands, or ask the assistant…" aria-label="Search" />
          <kbd>esc</kbd>
        </label>
        <div class="ov-results" hidden></div>
      </div>`;
    document.body.append(this.root);
    this.input = this.root.querySelector("input")!;
    this.results = this.root.querySelector(".ov-results")!;
    this.labels = this.root.querySelector(".ov-labels")!;

    this.root.querySelector(".ov-scrim")!.addEventListener("click", () => this.close());
    this.input.addEventListener("input", () => {
      this.sel = 0;
      this.render();
    });
    this.input.addEventListener("keydown", (e) => this.onKey(e));
    hooks.workspace.subscribe(() => {
      if (this.isOpen) this.layout();
    });
    window.addEventListener("resize", () => this.isOpen && this.layout());

    // while open, a click on a window picks it
    document.addEventListener("click", (e) => {
      if (!this.isOpen) return;
      const win = (e.target as HTMLElement).closest<HTMLElement>(".win");
      if (!win) return;
      e.stopPropagation();
      e.preventDefault();
      this.pick(win.dataset.doc!);
    }, true);

    // drop files on the overview to open them
    this.root.addEventListener("dragover", (e) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    });
    this.root.addEventListener("drop", (e) => {
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      e.stopPropagation();
      hooks.openFiles([...e.dataTransfer.files]);
    });
  }

  get isOpen() {
    return !this.root.hidden;
  }

  open(query = "") {
    if (!this.isOpen) this.returnFocus = document.activeElement as HTMLElement | null;
    this.root.hidden = false;
    this.input.value = query;
    this.layout();
    const active = this.hooks.workspace.active;
    if (!query && active) this.select(Math.max(0, this.order.indexOf(active)));
    this.input.focus();
  }

  close() {
    if (!this.isOpen) return;
    this.root.hidden = true;
    this.labels.innerHTML = "";
    this.hooks.windows.exitOverview();
    if (this.returnFocus?.isConnected) this.returnFocus.focus?.();
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  private pick(docId: string) {
    const ws = this.hooks.workspace;
    this.close();
    if (this.hooks.windows.isMinimized(docId)) this.hooks.windows.restore(docId);
    else ws.activate(docId);
  }

  /** Arranges the windows, draws their labels and lineage groups, then the search results. */
  private layout() {
    const ws = this.hooks.workspace;
    const groups = ws.lineage();
    this.order = groups.flat().map((g) => g.doc);
    const rects = this.hooks.windows.layoutOverview(this.order, SEARCH_TOP);
    this.labels.innerHTML = "";
    if (!this.order.length) {
      this.labels.innerHTML = `<div class="ov-empty">${icon("image", 30)}<p>No images open</p><p class="muted">Drop TIFF files here, or search for a command such as <em>Open</em>.</p></div>`;
    }
    // a soft outline around images that belong together (when they share a row)
    for (const g of groups) {
      if (g.length < 2) continue;
      const rs = g.map((x) => rects.get(x.doc.id)!);
      const mid = (r: { y: number; h: number }) => r.y + r.h / 2;
      if (!rs.every((r) => Math.abs(mid(r) - mid(rs[0])) < rs[0].h / 2)) continue;
      const x0 = Math.min(...rs.map((r) => r.x)) - 14;
      const y0 = Math.min(...rs.map((r) => r.y)) - 14;
      const x1 = Math.max(...rs.map((r) => r.x + r.w)) + 14;
      const y1 = Math.max(...rs.map((r) => r.y + r.h)) + 52;
      this.labels.insertAdjacentHTML("beforeend", `<div class="ov-group" style="left:${x0}px;top:${y0}px;width:${x1 - x0}px;height:${y1 - y0}px"></div>`);
    }
    for (const doc of this.order) {
      const r = rects.get(doc.id)!;
      const img = doc.timeline.current();
      const t = doc.timeline;
      const minimized = this.hooks.windows.isMinimized(doc.id);
      if (minimized) {
        // minimised windows show here too, faded, with a way back
        const restore = document.createElement("button");
        restore.className = "ov-restore";
        restore.style.cssText = `left:${r.x + r.w / 2}px;top:${r.y + r.h / 2}px`;
        restore.innerHTML = `${icon("expand", 14)}<span>Expand</span>`;
        restore.title = `Bring back ${doc.name}`;
        restore.addEventListener("click", (e) => {
          e.stopPropagation();
          this.pick(doc.id);
        });
        this.labels.append(restore);
      }
      const label = document.createElement("div");
      label.className = `ov-label${minimized ? " minimized" : ""}`;
      label.dataset.doc = doc.id;
      label.style.cssText = `left:${r.x}px;top:${r.y + r.h + 10}px;width:${r.w}px`;
      label.innerHTML = `
        <strong>${doc.parent ? icon("branch", 13) : ""}${escapeHtml(doc.name)}</strong>
        <small>${img.shape.width}×${img.shape.height} · ${this.hooks.dtypeLabel(img.dtype)}${t.steps.length ? ` · ${t.marker}/${t.steps.length} steps` : ""}</small>
        ${minimized ? `<small class="ov-min-tag">Minimised</small>` : ""}
        ${doc.parent ? `<small class="ov-parent">from ${escapeHtml(doc.parent.name)}, step ${doc.parent.step}</small>` : ""}
        <button class="ov-close" title="Close ${escapeHtml(doc.name)}" aria-label="Close ${escapeHtml(doc.name)}">${icon("close", 12)}</button>`;
      label.querySelector(".ov-close")!.addEventListener("click", (e) => {
        e.stopPropagation();
        this.hooks.closeDoc(doc);
      });
      label.addEventListener("click", () => this.pick(doc.id));
      this.labels.append(label);
    }
    this.render();
  }

  private render() {
    const q = this.input.value.trim();
    this.items = [];
    this.results.innerHTML = "";
    this.results.hidden = !q;
    if (!q) {
      // arrow keys move between windows
      for (const doc of this.order) {
        const el = this.hooks.windows.windowElement(doc.id)!;
        el.classList.remove("ov-dim");
        this.items.push({ el, activate: () => this.pick(doc.id) });
      }
    } else this.renderResults(q);
    this.select(Math.min(this.sel, Math.max(0, this.items.length - 1)));
  }

  private renderResults(q: string) {
    const ws = this.hooks.workspace;
    // dim windows that do not match
    for (const doc of this.order) this.hooks.windows.windowElement(doc.id)!.classList.toggle("ov-dim", score(q, doc.name, "") === 0);
    const images = ws.docs.filter((d) => score(q, d.name, "") > 0).slice(0, 5);
    const actions = this.hooks
      .actions()
      .map((a) => ({ a, s: score(q, a.title, `${a.section} ${(a.keywords ?? []).join(" ")} ${a.description ?? ""}`) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || Number(b.a.enabled()) - Number(a.a.enabled()))
      .slice(0, 8);
    if (actions.length) {
      this.results.append(this.heading("Commands"));
      for (const { a } of actions) {
        this.results.append(
          this.row(a.icon, a.title, a.section, a.shortcut, () => {
            if (!a.enabled()) return;
            this.close();
            void a.run();
          }, a.enabled() ? "" : "disabled"),
        );
      }
    }
    if (images.length) {
      this.results.append(this.heading("Images"));
      for (const d of images) this.results.append(this.row("image", d.name, `${d.timeline.steps.length} steps`, undefined, () => this.pick(d.id)));
    }
    this.results.append(this.heading("Assistant"));
    const why = this.hooks.aiUnavailable();
    this.results.append(
      this.row("sparkle", `Ask the assistant: “${q}”`, why ?? "Suggests steps for you to review", undefined, () => {
        this.close();
        this.hooks.ask(q);
      }, "ai"),
    );
  }

  private heading(text: string) {
    const h = document.createElement("h3");
    h.textContent = text;
    return h;
  }

  private row(iconName: string, title: string, subtitle: string, shortcut: string | undefined, activate: () => void, cls = "") {
    const el = document.createElement("button");
    el.type = "button";
    el.className = `ov-row ${cls}`;
    el.tabIndex = -1;
    el.innerHTML = `<span class="ov-row-icon">${icon(iconName)}</span><span class="ov-row-text"><span>${escapeHtml(title)}</span><small>${escapeHtml(subtitle)}</small></span>${shortcut ? `<kbd>${formatShortcut(shortcut)}</kbd>` : ""}`;
    el.addEventListener("click", activate);
    el.addEventListener("pointermove", () => {
      const i = this.items.findIndex((it) => it.el === el);
      if (i !== this.sel) this.select(i);
    });
    this.items.push({ el, activate });
    return el;
  }

  private select(i: number) {
    this.items[this.sel]?.el.classList.remove("ov-sel");
    this.labels.querySelectorAll(".ov-label.ov-sel").forEach((l) => l.classList.remove("ov-sel"));
    this.sel = i;
    const it = this.items[i];
    if (!it) return;
    it.el.classList.add("ov-sel");
    if (it.el.classList.contains("win")) this.labels.querySelector(`.ov-label[data-doc="${it.el.dataset.doc}"]`)?.classList.add("ov-sel");
    else it.el.scrollIntoView({ block: "nearest" });
  }

  private onKey(e: KeyboardEvent) {
    const q = this.input.value;
    if (e.key === "Escape") {
      e.preventDefault();
      if (q) {
        this.input.value = "";
        this.render();
      } else this.close();
      return;
    }
    if (e.key === "Tab" && !e.shiftKey && !q) {
      e.preventDefault();
      this.close();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      this.items[this.sel]?.activate();
      return;
    }
    const grid = !q;
    const cols = grid ? this.columns() : 1;
    const delta = { ArrowDown: cols, ArrowUp: -cols, ArrowRight: grid ? 1 : 0, ArrowLeft: grid ? -1 : 0 }[e.key];
    if (!delta || !this.items.length) return;
    e.preventDefault();
    this.select(Math.max(0, Math.min(this.items.length - 1, this.sel + delta)));
  }

  /** Windows per row in the overview grid, for arrow-key navigation. */
  private columns(): number {
    const labels = [...this.labels.querySelectorAll<HTMLElement>(".ov-label")];
    if (labels.length < 2) return 1;
    const top = labels[0].offsetTop;
    const n = labels.findIndex((l) => Math.abs(l.offsetTop - top) > 20 && l.offsetTop > top);
    return n < 0 ? labels.length : n;
  }
}
