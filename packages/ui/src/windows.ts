/**
 * Data windows, in the style of macOS: a title bar with the data's name and
 * minimise / zoom buttons, free placement, resizing and stacking. Each
 * window carries its own side panel (right) and history line (bottom), both
 * collapsible, and its ⋯ menu offers the tools that fit what it shows.
 * New windows cascade like a stack of cards; minimised ones collect in a
 * small card stack in the corner. The overview (Tab) lays the real windows
 * out in a grid, Mission Control style.
 */
import { escapeHtml } from "./dialogs.js";
import { icon } from "./icons.js";
import { DataWindow, type DataWindowHooks, kindIcon } from "./data-window.js";
import type { DataDoc, Workspace } from "./workspace.js";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Win {
  doc: DataDoc;
  el: HTMLElement;
  view: DataWindow;
  rect: Rect;
  z: number;
  minimized: boolean;
  /** The rect to restore when un-zooming. */
  zoomedFrom: Rect | null;
}

export type Layout = "stack" | "columns" | "grid" | "focus";

export interface WindowHooks {
  /** Space other floating UI keeps for itself (toolbar), so windows avoid it. */
  insets(): { top: number; right: number; bottom: number; left: number };
  /** The area an expanded window fills: everything below the top bar. */
  expandArea(): Rect;
  /** Opens a window's ⋯ menu under `anchor`. */
  dataMenu(doc: DataDoc, anchor: DOMRect): void;
  data: DataWindowHooks;
}

const TITLE_H = 36;
const MIN_W = 300;
const MIN_H = 220;

export class WindowManager {
  private wins = new Map<string, Win>();
  private topZ = 10;
  private overviewOn = false;
  private lastOrder: DataDoc[] = [];
  private readonly shelf: HTMLElement;

  constructor(
    private readonly desktop: HTMLElement,
    private readonly ws: Workspace,
    private readonly hooks: WindowHooks,
  ) {
    this.shelf = document.createElement("div");
    this.shelf.className = "shelf";
    desktop.append(this.shelf);
    window.addEventListener("resize", () => {
      for (const w of this.wins.values()) this.place(w, w.zoomedFrom ? this.hooks.expandArea() : this.clampRect(w.rect));
      if (this.overviewOn) this.layoutOverview(this.lastOrder);
    });
  }

  /** Brings windows in line with the workspace: creates, removes, retitles and re-renders. */
  sync() {
    const docs = this.ws.docs;
    for (const [id, w] of this.wins) {
      if (!docs.includes(w.doc)) {
        w.view.destroy();
        w.el.remove();
        this.wins.delete(id);
      }
    }
    for (const doc of docs) {
      const w = this.wins.get(doc.id) ?? this.create(doc);
      w.el.classList.toggle("controls-open", doc.ui.controls);
      w.el.classList.toggle("history-slim", doc.ui.history === "slim");
      w.el.querySelector(".win-title-text")!.textContent = doc.name;
      w.el.setAttribute("aria-label", doc.name);
      const results = doc.ui.mode === "results";
      const mode = w.el.querySelector("[data-win=\"mode\"]")!;
      mode.textContent = results ? "View history" : "View results";
      mode.setAttribute("aria-pressed", String(results));
      const side = w.el.querySelector("[data-win=\"controls\"]")!;
      side.setAttribute("aria-pressed", String(doc.ui.controls));
      side.setAttribute("title", doc.ui.controls ? "Hide the side panel" : "Show the side panel");
      w.view.render();
    }
    const active = this.ws.active;
    if (active) {
      const w = this.wins.get(active.id)!;
      if (w.minimized && !this.overviewOn) this.restore(active.id);
      if (w.z !== this.topZ) w.z = ++this.topZ;
    }
    for (const w of this.wins.values()) {
      w.el.classList.toggle("active", w.doc === active);
      w.el.classList.toggle("minimized", w.minimized);
      if (!this.overviewOn) w.el.style.zIndex = String(w.z);
    }
    this.renderShelf();
    this.markExpanded();
  }

  /** A window's own view, e.g. to read the image it shows. */
  dataView(id: string): DataWindow | undefined {
    return this.wins.get(id)?.view;
  }

  private create(doc: DataDoc): Win {
    const el = document.createElement("section");
    el.className = "win data-win";
    el.dataset.doc = doc.id;
    el.setAttribute("role", "dialog");
    el.innerHTML = `
      <header class="win-title">
        <div class="win-left">
          <div class="win-name"><span class="win-kind">${icon(kindIcon(doc.source.kind), 13)}</span><span class="win-title-text">${escapeHtml(doc.name)}</span></div>
        </div>
        <div class="win-center">
          <button class="win-ctl-toggle" data-win="mode" title="Switch between the history and a grid of every result"></button>
        </div>
        <div class="win-right">
          <button class="win-icon" data-win="controls" aria-label="Side panel">${icon("panel", 16)}</button>
          <button class="win-icon" data-win="menu" title="Tools for this data" aria-label="Tools for this data">${icon("more", 16)}</button>
          <button class="win-icon" data-win="min" title="Minimise (⇧⌘M)" aria-label="Minimise window">${icon("minimize", 15)}</button>
          <button class="win-icon win-zoom" data-win="zoom" title="Expand" aria-label="Expand window">${icon("expand", 15)}</button>
        </div>
      </header>
      <div class="win-main">
        <div class="win-body"></div>
      </div>
      <footer class="win-history">
        <div class="win-history-bar"></div>
        <button class="win-history-toggle" data-win="history" title="Slim or full history" aria-label="Toggle history size">${icon("collapse", 14)}</button>
      </footer>
      <div class="win-resize" aria-hidden="true"></div>`;
    this.desktop.append(el);
    const view = new DataWindow(doc, el.querySelector<HTMLElement>(".win-body")!, el.querySelector<HTMLElement>(".win-history-bar")!, this.hooks.data);
    el.querySelector(".win-main")!.append(view.drawer);
    const w: Win = { doc, el, view, rect: { x: 0, y: 0, w: 0, h: 0 }, z: ++this.topZ, minimized: false, zoomedFrom: null };
    w.rect = this.initialRect();
    this.wins.set(doc.id, w);
    this.place(w, w.rect);
    this.wire(w);
    requestAnimationFrame(() => el.classList.add("shown"));
    return w;
  }

  /** A window opens large, cascading from the newest window, one title bar lower so every title stays in view. */
  private initialRect(): Rect {
    const free = this.free();
    const w = Math.min(980, free.w * 0.78);
    const h = Math.min(660, free.h * 0.82);
    const last = [...this.wins.values()].filter((x) => !x.minimized).sort((a, b) => b.z - a.z)[0];
    let x = last ? last.rect.x + 32 : free.x + (free.w - w) / 2;
    let y = last ? last.rect.y + TITLE_H + 6 : free.y + Math.max(0, (free.h - h) / 2);
    if (y + TITLE_H * 3 > free.y + free.h) y = free.y; // ran out of room: start again at the top
    if (x + 120 > free.x + free.w) x = free.x;
    return this.clampRect({ x, y, w, h });
  }

  /** Lets floating UI step aside (the search field) while a window fills the desktop. */
  private markExpanded() {
    document.body.classList.toggle("has-expanded", [...this.wins.values()].some((w) => w.zoomedFrom && !w.minimized));
  }

  /** Opens or closes a window's side panel. */
  toggleControls(id: string) {
    const w = this.wins.get(id);
    if (!w) return;
    w.doc.ui.controls = !w.doc.ui.controls;
    this.ws.touch();
  }

  /** Where a window is and whether it is minimised (for saving a project). */
  placement(id: string): { rect: Rect; minimized: boolean } | undefined {
    const w = this.wins.get(id);
    return w && { rect: { ...(w.zoomedFrom ?? w.rect) }, minimized: w.minimized };
  }

  /** Puts a window back where a project had it. */
  restorePlacement(id: string, rect: Rect | null, minimized: boolean) {
    const w = this.wins.get(id);
    if (!w) return;
    if (rect) this.place(w, this.clampRect(rect));
    if (minimized) this.minimize(id);
  }

  /**
   * Arranges the visible windows in the free desktop area: a cascading
   * stack, side by side, a grid, or the active window filling the space.
   */
  arrange(layout: Layout) {
    const visible = this.ws.docs.map((d) => this.wins.get(d.id)!).filter((w) => w && !w.minimized);
    if (!visible.length) return;
    const f = this.free();
    const gap = 12;
    const cell = (cols: number, rows: number, i: number) => {
      const w = (f.w - gap * (cols - 1)) / cols;
      const h = (f.h - gap * (rows - 1)) / rows;
      return { x: f.x + (i % cols) * (w + gap), y: f.y + Math.floor(i / cols) * (h + gap), w, h };
    };
    visible.forEach((w, i) => {
      w.zoomedFrom = null;
      if (layout === "stack") {
        // back to a cascade of comfortable sizes, newest on top
        const r = this.initialRect();
        this.place(w, this.clampRect({ ...r, x: f.x + 24 + i * 30, y: f.y + i * 26 }), true);
      } else if (layout === "columns") {
        const cols = Math.min(visible.length, 3);
        this.place(w, cell(cols, Math.ceil(visible.length / cols), i), true);
      } else if (layout === "grid") {
        const cols = Math.ceil(Math.sqrt(visible.length));
        this.place(w, cell(cols, Math.ceil(visible.length / cols), i), true);
      } else if (w.doc === this.ws.active) {
        w.zoomedFrom = { ...w.rect };
        this.place(w, this.hooks.expandArea(), true);
      }
      this.setZoomButton(w);
    });
  }

  minimize(id: string) {
    const w = this.wins.get(id);
    if (!w || w.minimized) return;
    w.minimized = true;
    // hand focus to the topmost visible window, or to none if this was the last one
    const next = [...this.wins.values()].filter((x) => !x.minimized).sort((a, b) => b.z - a.z)[0];
    if (next) this.ws.activate(next.doc.id);
    else this.ws.deactivate();
    this.sync();
  }

  restore(id: string) {
    const w = this.wins.get(id);
    if (!w) return;
    w.minimized = false;
    w.z = ++this.topZ;
    this.ws.activate(id);
    this.sync();
  }

  /** Expands a window to fill everything below the top bar, or collapses it back to its size before. */
  toggleZoom(id: string) {
    const w = this.wins.get(id);
    if (!w) return;
    if (w.zoomedFrom) {
      this.place(w, w.zoomedFrom, true);
      w.zoomedFrom = null;
    } else {
      w.zoomedFrom = { ...w.rect };
      this.place(w, this.hooks.expandArea(), true);
    }
    this.setZoomButton(w);
  }

  private setZoomButton(w: Win) {
    const b = w.el.querySelector<HTMLElement>(".win-zoom")!;
    const expanded = !!w.zoomedFrom;
    w.el.classList.toggle("expanded", expanded);
    this.markExpanded();
    b.innerHTML = icon(expanded ? "shrink" : "expand", 15);
    b.title = expanded ? "Collapse" : "Expand";
    b.setAttribute("aria-label", expanded ? "Collapse window" : "Expand window");
  }

  // ------------------------------------------------------------ overview (Mission Control)

  get inOverview() {
    return this.overviewOn;
  }

  /**
   * Lays every window out in a grid inside the area below `top`, in `order`.
   * Returns each window's on-screen rectangle (for labels and hit-testing).
   */
  layoutOverview(order: DataDoc[], top = 150): Map<string, Rect> {
    this.overviewOn = true;
    this.lastOrder = order;
    document.body.classList.add("overview-mode");
    const n = order.length;
    const out = new Map<string, Rect>();
    if (!n) return out;
    const area = { x: 48, y: top, w: innerWidth - 96, h: innerHeight - top - 56 };
    // choose the column count that makes the windows largest
    let best = { cols: 1, scale: 0 };
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const cw = area.w / cols;
      const ch = area.h / rows;
      const scale = Math.min(
        ...order.map((d) => {
          const r = this.wins.get(d.id)!.rect;
          return Math.min((cw * 0.86) / r.w, (ch * 0.78) / r.h, 1);
        }),
      );
      if (scale > best.scale) best = { cols, scale };
    }
    const cols = best.cols;
    const rows = Math.ceil(n / cols);
    const cw = area.w / cols;
    const ch = area.h / rows;
    order.forEach((doc, i) => {
      const w = this.wins.get(doc.id)!;
      const col = i % cols;
      const row = Math.floor(i / cols);
      // centre a partial last row
      const inRow = row === rows - 1 ? n - row * cols : cols;
      const rowOffset = ((cols - inRow) * cw) / 2;
      const s = Math.min((cw * 0.86) / w.rect.w, (ch * 0.78) / w.rect.h, 1);
      const tw = w.rect.w * s;
      const th = w.rect.h * s;
      const tx = area.x + rowOffset + col * cw + (cw - tw) / 2;
      const ty = area.y + row * ch + (ch * 0.86 - th) / 2;
      w.el.style.transform = `translate(${tx - w.rect.x}px, ${ty - w.rect.y}px) scale(${s})`;
      w.el.style.zIndex = String(2000 + i);
      out.set(doc.id, { x: tx, y: ty, w: tw, h: th });
    });
    return out;
  }

  exitOverview() {
    this.overviewOn = false;
    document.body.classList.remove("overview-mode");
    for (const w of this.wins.values()) {
      w.el.style.transform = "";
      w.el.style.zIndex = String(w.z);
    }
    this.sync();
  }

  windowElement(id: string): HTMLElement | undefined {
    return this.wins.get(id)?.el;
  }

  isMinimized(id: string): boolean {
    return !!this.wins.get(id)?.minimized;
  }

  // ------------------------------------------------------------ placing and wiring

  /** The desktop area windows may use. */
  private free() {
    const i = this.hooks.insets();
    return { x: i.left, y: i.top, w: innerWidth - i.left - i.right, h: innerHeight - i.top - i.bottom };
  }

  private clampRect(r: Rect): Rect {
    const w = Math.min(Math.max(MIN_W, r.w), innerWidth - 16);
    const h = Math.min(Math.max(MIN_H, r.h), innerHeight - 16);
    // keep the title bar reachable
    const x = Math.min(Math.max(r.x, 8 - w + 120), innerWidth - 120);
    const y = Math.min(Math.max(r.y, 8), innerHeight - TITLE_H - 8);
    return { x, y, w, h };
  }

  private place(w: Win, r: Rect, animate = false) {
    w.rect = r;
    w.el.classList.toggle("animate", animate);
    Object.assign(w.el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    if (animate) setTimeout(() => w.el.classList.remove("animate"), 260);
  }

  /** Activate on press, title-bar buttons, drag by the title, resize from the corner. */
  private wire(w: Win) {
    const { el, doc } = w;
    const id = doc.id;
    el.addEventListener("pointerdown", () => {
      if (!this.overviewOn && this.ws.active?.id !== id) this.ws.activate(id);
    }, true);

    el.addEventListener("click", (e) => {
      // look the button up first: expand/collapse swaps its icon, detaching the clicked element
      const target = (e.target as HTMLElement).closest<HTMLElement>("[data-win]");
      const what = target?.dataset.win;
      if (!target || !what || this.overviewOn) return;
      e.stopPropagation();
      const anchor = target.getBoundingClientRect();
      if (what === "zoom") this.toggleZoom(id);
      else if (what === "min") this.minimize(id);
      else if (what === "menu") this.hooks.dataMenu(doc, anchor);
      else if (what === "mode") {
        doc.ui.mode = doc.ui.mode === "results" ? "history" : "results";
        this.ws.touch();
      } else if (what === "controls") this.toggleControls(id);
      else if (what === "history") {
        doc.ui.history = doc.ui.history === "full" ? "slim" : "full";
        this.ws.touch();
      }
    });

    // drag by the title bar
    const title = el.querySelector<HTMLElement>(".win-title")!;
    title.addEventListener("pointerdown", (e) => {
      if (this.overviewOn || e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
      const start = { px: e.clientX, py: e.clientY, ...w.rect };
      title.setPointerCapture(e.pointerId);
      el.classList.add("dragging");
      const move = (ev: PointerEvent) => {
        if (w.zoomedFrom) {
          w.zoomedFrom = null;
          this.setZoomButton(w);
        }
        this.place(w, this.clampRect({ ...w.rect, x: start.x + ev.clientX - start.px, y: start.y + ev.clientY - start.py }));
      };
      const up = () => {
        title.removeEventListener("pointermove", move);
        title.removeEventListener("pointerup", up);
        title.removeEventListener("pointercancel", up);
        el.classList.remove("dragging");
      };
      title.addEventListener("pointermove", move);
      title.addEventListener("pointerup", up);
      title.addEventListener("pointercancel", up);
    });
    title.addEventListener("dblclick", (e) => {
      if (!this.overviewOn && !(e.target as HTMLElement).closest("button")) this.toggleZoom(id);
    });

    // resize from the bottom-right corner
    const grip = el.querySelector<HTMLElement>(".win-resize")!;
    grip.addEventListener("pointerdown", (e) => {
      if (this.overviewOn) return;
      e.preventDefault();
      const start = { px: e.clientX, py: e.clientY, ...w.rect };
      grip.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        w.zoomedFrom = null;
        this.place(w, { ...w.rect, w: Math.max(MIN_W, start.w + ev.clientX - start.px), h: Math.max(MIN_H, start.h + ev.clientY - start.py) });
      };
      const up = () => {
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", up);
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", up);
    });
  }

  /** Minimised windows as a small stack of cards in the bottom-left corner. */
  private renderShelf() {
    const mins = [...this.wins.values()].filter((w) => w.minimized);
    this.shelf.hidden = !mins.length || this.overviewOn;
    this.shelf.innerHTML = "";
    mins.forEach((w, i) => {
      const card = document.createElement("button");
      card.className = "shelf-card";
      card.style.setProperty("--i", String(mins.length - 1 - i));
      card.title = `Restore ${w.doc.name}`;
      card.setAttribute("aria-label", `Restore ${w.doc.name}`);
      const thumb = w.view.thumbnail(120);
      if (thumb) card.append(thumb);
      else {
        const glyph = document.createElement("span");
        glyph.className = "shelf-glyph";
        glyph.innerHTML = icon(kindIcon(w.doc.source.kind), 28);
        card.append(glyph);
      }
      const label = document.createElement("span");
      label.textContent = w.doc.name;
      card.append(label);
      card.addEventListener("click", () => this.restore(w.doc.id));
      this.shelf.append(card);
    });
  }
}
