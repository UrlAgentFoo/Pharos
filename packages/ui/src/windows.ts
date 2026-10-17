/**
 * Image windows, in the style of macOS: a title bar with the image name and
 * close / minimise / zoom buttons, free placement, resizing and stacking.
 * Each window carries its own image's Controls drawer (right) and history
 * line (bottom), both collapsible, because both belong to that image.
 * New windows cascade like a stack of cards; minimised ones collect in a
 * small card stack in the corner. The overview (Tab) lays the real windows
 * out in a grid, Mission Control style.
 */
import type { Image } from "@pharos/core";
import { Controls, type ControlsHooks } from "./controls.js";
import { escapeHtml } from "./dialogs.js";
import { icon } from "./icons.js";
import { STEP_MIME, type StepPayload, TimelineBar, type TimelineBarHooks } from "./timeline-bar.js";
import { Viewer, adaptView, thumbnailElement } from "./viewer.js";
import { DataWindow, type DataWindowHooks, KIND_ICON } from "./data-window.js";
import type { DataDoc, Doc, Workspace } from "./workspace.js";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What every window has, image or data: its element and where it sits. */
interface Frame {
  el: HTMLElement;
  rect: Rect;
  z: number;
  minimized: boolean;
  /** The rect to restore when un-zooming. */
  zoomedFrom: Rect | null;
}

/** A dataset's window. */
interface DataWin extends Frame {
  doc: DataDoc;
  view: DataWindow;
}

interface Win {
  doc: Doc;
  el: HTMLElement;
  viewer: Viewer;
  timeline: TimelineBar;
  controls: Controls;
  /** What the controls were last built from, to skip needless rebuilds. */
  shownKey: string;
  controlsImage: Image | null;
  image: Image | null;
  rect: Rect;
  z: number;
  minimized: boolean;
  /** The rect to restore when un-zooming. */
  zoomedFrom: Rect | null;
  readout: HTMLElement;
}

export type Layout = "stack" | "columns" | "grid" | "focus";

export interface WindowHooks {
  /** The window's view moved or zoomed (grouped windows may follow). */
  viewChanged(doc: Doc): void;
  /** Slice, channel or contrast changed in the window's controls (grouped windows may follow). */
  viewEdited(doc: Doc): void;
  /** Opens the window's ⋯ menu, or the group settings, under `anchor`. */
  windowMenu(doc: Doc, anchor: DOMRect): void;
  /** The user drew, moved or cleared the window's selection. */
  roiChanged(doc: Doc): void;
  /** Cites the window, as it looks now, in the project notes. */
  addToNotes(doc: Doc): void;
  groupMenu(anchor: DOMRect): void;
  copyStep(doc: Doc, step: StepPayload): void;
  dtypeLabel(dtype: string): string;
  /** Space other floating UI keeps for itself (toolbar), so windows avoid it. */
  insets(): { top: number; right: number; bottom: number; left: number };
  /** The area an expanded window fills: everything below the top bar. */
  expandArea(): Rect;
  timeline: TimelineBarHooks;
  controls: Omit<ControlsHooks, "redraw">;
  /** Opens a data window's ⋯ menu under `anchor`. */
  dataMenu(doc: DataDoc, anchor: DOMRect): void;
  data: DataWindowHooks;
}

/** Parts of a window that do something when clicked; citing never takes these clicks. */
const INTERACTIVE = "button, a, input, select, textarea, label, [contenteditable='true'], .win-resize, .tl-marker, .tl-node, .hist";

const TITLE_H = 36;
const HISTORY_H = { full: 52, slim: 32 };
const DRAWER_W = 252;
const MIN_W = 300;
const MIN_H = 220;

export class WindowManager {
  private wins = new Map<string, Win>();
  private dwins = new Map<string, DataWin>();
  private topZ = 10;
  private overviewOn = false;
  private lastOrder: Doc[] = [];
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
      for (const w of [...this.wins.values(), ...this.dwins.values()]) this.place(w, w.zoomedFrom ? this.hooks.expandArea() : this.clampRect(w.rect));
      if (this.overviewOn) this.layoutOverview(this.lastOrder);
    });
  }

  /** Brings windows in line with the workspace: creates, removes, retitles and re-renders. */
  sync() {
    const docs = this.ws.docs;
    for (const [id, w] of this.wins) {
      if (!docs.includes(w.doc)) {
        w.timeline.destroy();
        w.el.remove();
        this.wins.delete(id);
      }
    }
    for (const doc of docs) {
      const w = this.wins.get(doc.id) ?? this.create(doc);
      // layout classes first, so a first fit sees the real canvas size
      w.el.classList.toggle("controls-open", doc.ui.controls);
      w.el.classList.toggle("history-slim", doc.ui.history === "slim");
      const img = doc.timeline.current();
      if (img !== w.image) {
        if (w.image) adaptView(doc.view, w.image, img);
        // outlines found on another size of image no longer fit
        if (w.image && (w.image.shape.width !== img.shape.width || w.image.shape.height !== img.shape.height)) {
          doc.layers.overlay = [];
          doc.layers.roi = null;
        }
        w.viewer.show(img, doc.view);
        w.image = img;
      }
      w.el.querySelector(".win-title-text")!.textContent = doc.name;
      w.el.setAttribute("aria-label", doc.name);
      w.el.querySelector<HTMLElement>(".win-branch")!.hidden = !doc.parent;
      const group = this.ws.groupOf(doc);
      const chip = w.el.querySelector<HTMLElement>(".win-group")!;
      chip.hidden = !group;
      if (group) {
        chip.innerHTML = `<span class="dot" style="background:${group.color}"></span>${escapeHtml(group.name)}`;
        chip.title = `${group.name}: shares ${Object.entries(group.sync).filter(([, on]) => on).map(([k]) => k).join(", ") || "nothing yet"}`;
      }
      w.el.style.setProperty("--group", group?.color ?? "transparent");
      w.el.classList.toggle("grouped", !!group);
      const toggle = w.el.querySelector("[data-win=\"controls\"]")!;
      toggle.textContent = doc.ui.controls ? "Hide controls" : "Show controls";
      toggle.setAttribute("aria-pressed", String(doc.ui.controls));
      const measured = this.hooks.controls.measurements(doc).length;
      const key = `${doc.timeline.marker}|${doc.timeline.steps.length}|${doc.panels.length}|${doc.name}|${measured}`;
      if (doc.ui.controls && (key !== w.shownKey || img !== w.controlsImage)) {
        w.controls.update();
        w.shownKey = key;
        w.controlsImage = img;
      }
      w.timeline.render();
      this.setReadout(w);
    }
    this.syncData();
    const active = this.ws.active ?? this.ws.activeData;
    if (active) {
      const w = this.frame(active.id)!;
      if (w.minimized && !this.overviewOn) this.restore(active.id);
      if (w.z !== this.topZ) w.z = ++this.topZ;
    }
    for (const w of [...this.wins.values(), ...this.dwins.values()]) {
      w.el.classList.toggle("active", w.doc === active);
      w.el.classList.toggle("minimized", w.minimized);
      if (!this.overviewOn) w.el.style.zIndex = String(w.z);
    }
    this.renderShelf();
    this.markExpanded();
  }

  private frame(id: string): (Win | DataWin) | undefined {
    return this.wins.get(id) ?? this.dwins.get(id);
  }

  /** Creates, removes and re-renders data windows to match the workspace. */
  private syncData() {
    const docs = this.ws.dataDocs;
    for (const [id, w] of this.dwins) {
      if (!docs.includes(w.doc)) {
        w.view.destroy();
        w.el.remove();
        this.dwins.delete(id);
      }
    }
    for (const doc of docs) {
      const w = this.dwins.get(doc.id) ?? this.createData(doc);
      w.el.classList.toggle("controls-open", doc.ui.controls);
      w.el.classList.toggle("history-slim", doc.ui.history === "slim");
      w.el.querySelector(".win-title-text")!.textContent = doc.name;
      w.el.setAttribute("aria-label", doc.name);
      const toggle = w.el.querySelector("[data-win=\"controls\"]")!;
      toggle.textContent = doc.ui.controls ? "Hide controls" : "Show controls";
      toggle.setAttribute("aria-pressed", String(doc.ui.controls));
      w.view.render();
    }
  }

  /** The data window's own view, e.g. to read the image it shows. */
  dataView(id: string): DataWindow | undefined {
    return this.dwins.get(id)?.view;
  }

  private createData(doc: DataDoc): DataWin {
    const el = document.createElement("section");
    el.className = "win data-win";
    el.dataset.doc = doc.id;
    el.setAttribute("role", "dialog");
    el.innerHTML = `
      <header class="win-title">
        <div class="win-left">
          <div class="win-name"><span class="win-kind">${icon(KIND_ICON[doc.source.kind], 13)}</span><span class="win-title-text">${escapeHtml(doc.name)}</span></div>
        </div>
        <div class="win-center">
          <button class="win-ctl-toggle" data-win="controls"></button>
        </div>
        <div class="win-right">
          <button class="win-icon" data-win="menu" title="Processes and more" aria-label="Processes and more">${icon("more", 16)}</button>
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
    const w: DataWin = { doc, el, view, rect: { x: 0, y: 0, w: 0, h: 0 }, z: ++this.topZ, minimized: false, zoomedFrom: null };
    w.rect = this.dataRect();
    this.dwins.set(doc.id, w);
    this.place(w, w.rect);
    this.wireFrame(w, (what, anchor) => {
      if (what === "menu") this.hooks.dataMenu(doc, anchor);
      if (what === "controls") {
        doc.ui.controls = !doc.ui.controls;
        this.ws.touch();
      }
      if (what === "history") {
        doc.ui.history = doc.ui.history === "full" ? "slim" : "full";
        this.ws.touch();
      }
    });
    requestAnimationFrame(() => el.classList.add("shown"));
    return w;
  }

  /** A data window opens large, cascading from the newest window like images do. */
  private dataRect(): Rect {
    const free = this.free();
    const w = Math.min(980, free.w * 0.78);
    const h = Math.min(660, free.h * 0.82);
    const last = [...this.wins.values(), ...this.dwins.values()].filter((x) => !x.minimized).sort((a, b) => b.z - a.z)[0];
    let x = last ? last.rect.x + 32 : free.x + (free.w - w) / 2;
    let y = last ? last.rect.y + TITLE_H + 6 : free.y + Math.max(0, (free.h - h) / 2);
    if (y + TITLE_H * 3 > free.y + free.h) y = free.y;
    if (x + 120 > free.x + free.w) x = free.x;
    return this.clampRect({ x, y, w, h });
  }

  /** Lets floating UI step aside (the search field) while a window fills the desktop. */
  private markExpanded() {
    document.body.classList.toggle("has-expanded", [...this.wins.values()].some((w) => w.zoomedFrom && !w.minimized));
  }

  viewerFor(id: string): Viewer | undefined {
    return this.wins.get(id)?.viewer;
  }

  /** Re-renders the active window's pixels and controls (after a display change). */
  renderActive() {
    const w = this.ws.active && this.wins.get(this.ws.active.id);
    if (!w) return;
    w.viewer.render();
    if (w.doc.ui.controls) w.controls.update();
    this.setReadout(w);
  }

  /**
   * Opens or closes a window's Controls drawer. The window keeps its size:
   * the image area gives way to the drawer, or grows into the space it leaves
   * (a fitted image refits as the image area changes size).
   */
  toggleControls(id: string) {
    const w = this.wins.get(id);
    if (!w) return;
    w.doc.ui.controls = !w.doc.ui.controls;
    w.shownKey = "";
    this.ws.touch();
  }

  /** Switches a window's history line between full and slim. */
  toggleHistory(id: string) {
    const w = this.wins.get(id);
    if (!w) return;
    const slim = w.doc.ui.history === "full";
    w.doc.ui.history = slim ? "slim" : "full";
    this.place(w, this.clampRect({ ...w.rect, h: w.rect.h + (slim ? HISTORY_H.slim - HISTORY_H.full : HISTORY_H.full - HISTORY_H.slim) }), true);
    this.ws.touch();
  }

  /** Stops the "just cited" animation on every window. */
  clearNoted() {
    for (const w of this.wins.values()) w.el.classList.remove("noted");
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

  /** Re-renders one window (after a grouped peer changed its slice or contrast). */
  renderDoc(id: string) {
    const w = this.wins.get(id);
    if (!w) return;
    w.viewer.render();
    if (w.doc.ui.controls) w.controls.update();
    this.setReadout(w);
  }

  /** True while windows are following another, so their changes are not echoed back. */
  private following = false;

  /**
   * Makes every window in `docs` show what `source` shows. If `source` is
   * fitted, they fit their own windows too (and keep refitting as they
   * resize); otherwise they take the same zoom and centre point.
   */
  follow(source: Doc, docs: Doc[]) {
    const from = this.wins.get(source.id);
    const c = from?.viewer.centre();
    if (!from || !c) return;
    this.following = true;
    try {
      for (const d of docs) {
        const w = this.wins.get(d.id);
        if (!w || w.minimized) continue;
        if (source.view.fitted) w.viewer.fit();
        else w.viewer.lookAt(c, source.view.zoom);
        this.setReadout(w);
      }
    } finally {
      this.following = false;
    }
  }

  /**
   * Arranges the visible windows in the free desktop area: a cascading
   * stack, side by side, a grid, or the active window filling the space.
   */
  arrange(layout: Layout) {
    const visible: (Win | DataWin)[] = [...this.ws.docs.map((d) => this.wins.get(d.id)!), ...this.ws.dataDocs.map((d) => this.dwins.get(d.id)!)].filter((w) => w && !w.minimized);
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
        const r = "view" in w ? this.dataRect() : this.initialRect(w.doc);
        this.place(w, this.clampRect({ ...r, x: f.x + 24 + i * 30, y: f.y + i * 26 }), true);
      } else if (layout === "columns") {
        const cols = Math.min(visible.length, 3);
        this.place(w, cell(cols, Math.ceil(visible.length / cols), i), true);
      } else if (layout === "grid") {
        const cols = Math.ceil(Math.sqrt(visible.length));
        this.place(w, cell(cols, Math.ceil(visible.length / cols), i), true);
      } else if (w.doc === (this.ws.active ?? this.ws.activeData)) {
        w.zoomedFrom = { ...w.rect };
        this.place(w, this.hooks.expandArea(), true);
      }
      this.setZoomButton(w);
    });
  }

  minimize(id: string) {
    const w = this.frame(id);
    if (!w || w.minimized) return;
    w.minimized = true;
    // hand focus to the topmost visible window, or to none if this was the last one
    const next = [...this.wins.values(), ...this.dwins.values()].filter((x) => !x.minimized).sort((a, b) => b.z - a.z)[0];
    if (next) this.ws.activate(next.doc.id);
    else this.ws.deactivate();
    this.sync();
  }

  restore(id: string) {
    const w = this.frame(id);
    if (!w) return;
    w.minimized = false;
    w.z = ++this.topZ;
    this.ws.activate(id);
    this.sync();
  }

  /** Expands a window to fill everything below the top bar, or collapses it back to its size before. */
  toggleZoom(id: string) {
    const w = this.frame(id);
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

  private setZoomButton(w: Frame) {
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
  layoutOverview(order: Doc[], top = 150): Map<string, Rect> {
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

  // ------------------------------------------------------------ creating and placing

  /** The desktop area windows may use. */
  private free() {
    const i = this.hooks.insets();
    return { x: i.left, y: i.top, w: innerWidth - i.left - i.right, h: innerHeight - i.top - i.bottom };
  }

  private create(doc: Doc): Win {
    const el = document.createElement("section");
    el.className = "win";
    el.dataset.doc = doc.id;
    el.setAttribute("role", "dialog");
    el.innerHTML = `
      <header class="win-title">
        <div class="win-left">
          <div class="win-name"><span class="win-branch" hidden>${icon("branch", 13)}</span><span class="win-title-text">${escapeHtml(doc.name)}</span></div>
          <button class="win-group" data-win="group" hidden></button>
        </div>
        <div class="win-center">
          <button class="win-ctl-toggle" data-win="controls"></button>
        </div>
        <div class="win-right">
          <button class="win-icon" data-win="menu" title="Image menu" aria-label="Image menu">${icon("more", 16)}</button>
          <button class="win-icon" data-win="min" title="Minimise (⇧⌘M)" aria-label="Minimise window">${icon("minimize", 15)}</button>
          <button class="win-icon win-zoom" data-win="zoom" title="Expand" aria-label="Expand window">${icon("expand", 15)}</button>
        </div>
      </header>
      <div class="win-main">
        <div class="win-body"><canvas tabindex="0"></canvas><div class="win-readout"></div><span class="win-cite-hint">Click to cite</span></div>
      </div>
      <footer class="win-history">
        <div class="win-history-bar"></div>
        <button class="win-history-toggle" data-win="history" title="Slim or full history" aria-label="Toggle history size">${icon("collapse", 14)}</button>
      </footer>
      <div class="win-resize" aria-hidden="true"></div>`;
    this.desktop.append(el);
    const readout = el.querySelector<HTMLElement>(".win-readout")!;
    // viewer, timeline and controls need `w` itself, so they are attached just below
    const w = { doc, el, image: null, rect: { x: 0, y: 0, w: 0, h: 0 }, z: ++this.topZ, minimized: false, zoomedFrom: null, readout, shownKey: "", controlsImage: null } as unknown as Win;
    w.viewer = new Viewer(
      el.querySelector("canvas")!,
      (info) => this.setReadout(w, info),
      () => {
        this.setReadout(w);
        if (!this.following) this.hooks.viewChanged(doc);
      },
      () => this.hooks.roiChanged(doc),
    );
    w.viewer.layers = doc.layers;
    w.timeline = new TimelineBar(el.querySelector(".win-history-bar")!, this.hooks.timeline);
    w.timeline.setDoc(doc);
    w.controls = new Controls(doc, {
      ...this.hooks.controls,
      redraw: () => {
        w.viewer.render();
        this.hooks.viewEdited(doc);
      },
    });
    el.querySelector(".win-main")!.append(w.controls.el);
    w.rect = this.initialRect(doc);
    this.wins.set(doc.id, w);
    this.place(w, w.rect);
    this.wire(w);
    requestAnimationFrame(() => el.classList.add("shown"));
    return w;
  }

  /**
   * New windows cascade from the centre of the free area, like a stack of
   * cards, sized so the image is large: small images open at 2× to 4×.
   */
  private initialRect(doc: Doc): Rect {
    const free = this.free();
    const img = doc.timeline.current();
    const chromeW = doc.ui.controls ? DRAWER_W : 0;
    const chromeH = TITLE_H + HISTORY_H[doc.ui.history];
    const maxW = free.w * 0.72 - chromeW;
    const maxH = free.h * 0.8 - chromeH;
    let zoom = Math.min(maxW / img.shape.width, maxH / img.shape.height);
    zoom = zoom >= 2 ? Math.min(4, Math.floor(zoom)) : Math.min(1, zoom);
    // the viewer fits images at 95% of the canvas, so leave that margin
    const w = Math.max(MIN_W, Math.ceil((img.shape.width * zoom) / 0.95) + chromeW + 2);
    const h = Math.max(MIN_H, Math.ceil((img.shape.height * zoom) / 0.95) + chromeH);
    // cascade from the newest visible window (or the parent of a branch), one title bar
    // lower, so every earlier window keeps its title in view; the first one is centred
    const parent = doc.parent && this.wins.get(doc.parent.id);
    const last = parent || [...this.wins.values()].filter((x) => !x.minimized).sort((a, b) => b.z - a.z)[0];
    let x = last ? last.rect.x + 32 : free.x + (free.w - w) / 2;
    let y = last ? last.rect.y + TITLE_H + 6 : free.y + Math.max(0, (free.h - h) / 2);
    if (y + TITLE_H * 3 > free.y + free.h) y = free.y; // ran out of room: start again at the top
    if (x + 120 > free.x + free.w) x = free.x;
    return this.clampRect({ x, y, w, h });
  }

  private clampRect(r: Rect): Rect {
    const w = Math.min(Math.max(MIN_W, r.w), innerWidth - 16);
    const h = Math.min(Math.max(MIN_H, r.h), innerHeight - 16);
    // keep the title bar reachable
    const x = Math.min(Math.max(r.x, 8 - w + 120), innerWidth - 120);
    const y = Math.min(Math.max(r.y, 8), innerHeight - TITLE_H - 8);
    return { x, y, w, h };
  }

  private place(w: Frame, r: Rect, animate = false) {
    w.rect = r;
    w.el.classList.toggle("animate", animate);
    Object.assign(w.el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    if (animate) setTimeout(() => w.el.classList.remove("animate"), 260);
  }

  /** A small readout in the image corner: zoom and position, or the pixel under the cursor. */
  private setReadout(w: Win, hover?: string) {
    const img = w.image;
    if (!img) return;
    const { channels, slices, frames } = img.shape;
    const v = w.doc.view;
    const pos = [channels > 1 && !v.composite && `c${v.pos.c + 1}`, slices > 1 && `z${v.pos.z + 1}/${slices}`, frames > 1 && `t${v.pos.t + 1}/${frames}`].filter(Boolean).join(" ");
    w.readout.textContent = hover || `${pos ? `${pos} · ` : ""}${w.viewer.zoomPercent}%`;
    w.readout.classList.toggle("hovering", !!hover);
  }

  private wire(w: Win) {
    const { el, doc } = w;
    this.wireFrame(w, (what, anchor) => {
      if (what === "menu") this.hooks.windowMenu(doc, anchor);
      if (what === "group") this.hooks.groupMenu(anchor);
      if (what === "controls") this.toggleControls(doc.id);
      if (what === "history") this.toggleHistory(doc.id);
    });

    // while writing notes, a click on a non-interactive part of a window (the image,
    // empty space) cites it and the notes keep the cursor; controls work as usual
    const citing = (e: Event) =>
      document.body.classList.contains("noting") && !this.overviewOn && !(e.target as HTMLElement).closest(INTERACTIVE);
    el.addEventListener("mousedown", (e) => {
      if (citing(e)) e.preventDefault(); // keeps focus (and the cursor) in the notes
    }, true);
    el.addEventListener("pointerdown", (e) => {
      if (!citing(e) || e.button !== 0) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      this.hooks.addToNotes(doc);
      el.classList.add("noted"); // marching ants on the cited window, until you type a space
    }, true);
    el.addEventListener("click", (e) => {
      if (citing(e)) e.stopImmediatePropagation();
    }, true);
    // drop a timeline step from another image onto this window to copy it here
    el.addEventListener("dragover", (e) => {
      if (!e.dataTransfer?.types.includes(STEP_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      el.classList.add("drop-target");
    });
    el.addEventListener("dragleave", (e) => {
      if (!el.contains(e.relatedTarget as Node)) el.classList.remove("drop-target");
    });
    el.addEventListener("drop", (e) => {
      el.classList.remove("drop-target");
      const raw = e.dataTransfer?.getData(STEP_MIME);
      if (!raw) return;
      const payload = JSON.parse(raw) as StepPayload;
      if (payload.docId === doc.id) return; // a reorder within this window's own history line
      e.preventDefault();
      e.stopPropagation();
      this.hooks.copyStep(doc, payload);
    });
  }

  /** What every window does: activate on press, title-bar buttons, drag by the title, resize from the corner. */
  private wireFrame(w: Frame & { doc: { id: string } }, button: (what: string, anchor: DOMRect) => void) {
    const { el } = w;
    const id = w.doc.id;
    el.addEventListener("pointerdown", () => {
      if (!this.overviewOn && (this.ws.active ?? this.ws.activeData)?.id !== id) this.ws.activate(id);
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
      else button(what, anchor);
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
    const mins: (Win | DataWin)[] = [...this.wins.values(), ...this.dwins.values()].filter((w) => w.minimized);
    this.shelf.hidden = !mins.length || this.overviewOn;
    this.shelf.innerHTML = "";
    mins.forEach((w, i) => {
      const card = document.createElement("button");
      card.className = "shelf-card";
      card.style.setProperty("--i", String(mins.length - 1 - i));
      card.title = `Restore ${w.doc.name}`;
      card.setAttribute("aria-label", `Restore ${w.doc.name}`);
      if ("view" in w) {
        const glyph = document.createElement("span");
        glyph.className = "shelf-glyph";
        glyph.innerHTML = icon(KIND_ICON[w.doc.source.kind], 28);
        card.append(glyph);
      } else card.append(thumbnailElement(w.doc.timeline.current(), w.doc.view, 120));
      const label = document.createElement("span");
      label.textContent = w.doc.name;
      card.append(label);
      card.addEventListener("click", () => this.restore(w.doc.id));
      this.shelf.append(card);
    });
  }
}
