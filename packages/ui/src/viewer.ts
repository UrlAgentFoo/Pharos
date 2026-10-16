/**
 * Canvas image viewer: zoom (wheel), pan (hand tool, or Space-drag), pixel
 * readout, display range and LUTs, selections drawn with the current tool,
 * overlays (particle outlines) and a live threshold preview.
 */
import { type Image, LUTS, type Lut, type Roi, autoContrast, getPlane, minMax, renderComposite, renderGray, roiBounds, roiMask } from "@pharos/core";

/** Canvas tools, shared by every window (as ImageJ's toolbar). */
export type Tool = "hand" | "rect" | "oval" | "polygon" | "freehand" | "line";

export const TOOLS: { id: Tool; label: string; key: string }[] = [
  { id: "hand", label: "Move the view (or hold Space)", key: "Space" },
  { id: "rect", label: "Rectangle selection", key: "R" },
  { id: "oval", label: "Oval selection", key: "O" },
  { id: "polygon", label: "Polygon selection: click corners, double-click to finish", key: "G" },
  { id: "freehand", label: "Freehand selection", key: "D" },
  { id: "line", label: "Straight line: lengths and Set Scale", key: "L" },
];

let currentTool: Tool = "rect";
const toolListeners = new Set<(t: Tool) => void>();

export function getTool(): Tool {
  return currentTool;
}

export function setTool(t: Tool) {
  currentTool = t;
  for (const fn of toolListeners) fn(t);
}

export function onToolChange(fn: (t: Tool) => void) {
  toolListeners.add(fn);
}

/** Where a window's selection, overlay and threshold preview live (the document). */
export interface ViewerLayers {
  roi: Roi | null;
  /** Outlines drawn over the image, e.g. the particles found by Analyze Particles. */
  overlay: Roi[];
  /** Values in [lower, upper] are painted red: the Threshold dialog's live preview. */
  preview: [number, number] | null;
}

/** Whether a pointer is held for panning: the hand tool or Space. */
let spaceDown = false;
addEventListener("keydown", (e) => {
  const t = e.target as HTMLElement | null;
  if (e.code === "Space" && !(t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(t.tagName)))) {
    spaceDown = true;
    if (!e.repeat) document.body.classList.add("space-pan");
    e.preventDefault();
  }
});
addEventListener("keyup", (e) => {
  if (e.code === "Space") {
    spaceDown = false;
    document.body.classList.remove("space-pan");
  }
});

const CHANNEL_LUTS: Lut[] = [LUTS.red, LUTS.green, LUTS.blue, LUTS.cyan, LUTS.magenta, LUTS.yellow];
/** Display colour of each channel in a composite, matching CHANNEL_LUTS. */
export const CHANNEL_COLORS = ["#e5484d", "#30a46c", "#3e63dd", "#12a594", "#d6409f", "#e2a336"];

export interface Position {
  c: number;
  z: number;
  t: number;
}

/** How one image is shown. Each tab owns one, so switching tabs restores zoom, slice and contrast. */
export interface ViewState {
  pos: Position;
  /** Display range per channel. */
  ranges: [number, number][];
  composite: boolean;
  zoom: number;
  offX: number;
  offY: number;
  /** False until the view has been fitted to the canvas once. */
  placed: boolean;
  /** True while the image is fitted to the window; resizing the window then refits it. */
  fitted: boolean;
  /** True once the user sets the display range by hand; it is then kept across timeline changes. */
  manualRange: boolean;
  /** Channels switched off in the composite. */
  hidden: boolean[];
}

export function newViewState(img: Image): ViewState {
  const view: ViewState = { pos: { c: 0, z: 0, t: 0 }, ranges: [], composite: false, zoom: 1, offX: 0, offY: 0, placed: false, fitted: true, manualRange: false, hidden: [] };
  resetRanges(view, img);
  return view;
}

/** Picks display ranges for `img` from the slice on show: full range for 8-bit gray, auto contrast otherwise. */
export function resetRanges(view: ViewState, img: Image) {
  const { channels, slices, frames } = img.shape;
  const sameChannels = view.ranges.length === channels;
  const z = Math.min(view.pos.z, slices - 1);
  const t = Math.min(view.pos.t, frames - 1);
  view.ranges = Array.from({ length: channels }, (_, c) => {
    const plane = getPlane(img, c, z, t);
    return img.dtype === "uint8" && channels === 1 ? [0, 255] : autoContrast(plane);
  });
  if (!sameChannels) {
    view.composite = channels > 1 && channels <= CHANNEL_LUTS.length;
    view.hidden = [];
  }
  view.manualRange = false;
}

/**
 * Brings a view in line with a new version of its image (after a timeline
 * change): clamps the position and re-picks the display range, as ImageJ
 * does after a command, unless the user set it by hand for the same kind of image.
 */
export function adaptView(view: ViewState, prev: Image | null, img: Image) {
  const { channels, slices, frames } = img.shape;
  view.pos = { c: Math.min(view.pos.c, channels - 1), z: Math.min(view.pos.z, slices - 1), t: Math.min(view.pos.t, frames - 1) };
  const sameKind = prev && prev.dtype === img.dtype && prev.shape.channels === channels;
  if (!sameKind || !view.manualRange) resetRanges(view, img);
  if (prev && (prev.shape.width !== img.shape.width || prev.shape.height !== img.shape.height)) view.placed = false;
}

/** Renders the plane(s) at the view's position into RGBA pixels. */
function renderPixels(img: Image, view: ViewState): ImageData {
  const { width, height, channels } = img.shape;
  const data = new ImageData(width, height);
  const { z, t, c } = view.pos;
  if (view.composite && channels > 1) {
    const shown = Array.from({ length: channels }, (_, ch) => ch).filter((ch) => !view.hidden[ch]);
    if (!shown.length) {
      for (let i = 3; i < data.data.length; i += 4) data.data[i] = 255; // all channels off: black
      return data;
    }
    renderComposite(
      shown.map((ch) => getPlane(img, ch, z, t)),
      shown.map((ch) => view.ranges[ch]),
      shown.map((ch) => CHANNEL_LUTS[ch]),
      data.data,
    );
  } else {
    const lut = channels > 1 ? CHANNEL_LUTS[c % CHANNEL_LUTS.length] : LUTS.grays;
    const [lo, hi] = view.ranges[c] ?? minMax(getPlane(img, c, z, t));
    renderGray(getPlane(img, c, z, t), lo, hi, lut, data.data);
  }
  return data;
}

/** Per image version, per size: the last thumbnail and the view it was rendered with. */
const thumbCache = new WeakMap<Image, Map<number, { key: string; canvas: HTMLCanvasElement }>>();

/** A small rendering of an image for tabs and the overview, cached per image version and view. */
function thumbnail(img: Image, view: ViewState, max: number): HTMLCanvasElement {
  const key = `${view.composite}|${view.hidden.join()}|${view.pos.c},${view.pos.z},${view.pos.t}|${view.ranges.flat().join(",")}`;
  let sizes = thumbCache.get(img);
  if (!sizes) thumbCache.set(img, (sizes = new Map()));
  const hit = sizes.get(max);
  if (hit && hit.key === key) return hit.canvas;
  const { width, height } = img.shape;
  const full = document.createElement("canvas");
  full.width = width;
  full.height = height;
  full.getContext("2d")!.putImageData(renderPixels(img, view), 0, 0);
  const scale = Math.min(1, max / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(full, 0, 0, canvas.width, canvas.height);
  sizes.set(max, { key, canvas });
  return canvas;
}

/** A thumbnail as a fresh canvas element (a canvas element can only be in one place). */
export function thumbnailElement(img: Image, view: ViewState, max = 240): HTMLCanvasElement {
  const src = thumbnail(img, view, max);
  const c = document.createElement("canvas");
  c.width = src.width;
  c.height = src.height;
  c.getContext("2d")!.drawImage(src, 0, 0);
  return c;
}

/** `r` moved by (dx, dy) pixels. */
export function moveRoi(r: Roi, dx: number, dy: number): Roi {
  if (r.type === "rect" || r.type === "oval") return { ...r, x: r.x + dx, y: r.y + dy };
  if (r.type === "line") return { ...r, x1: r.x1 + dx, y1: r.y1 + dy, x2: r.x2 + dx, y2: r.y2 + dy };
  return { ...r, points: r.points.map(([x, y]) => [x + dx, y + dy] as [number, number]) };
}

export class Viewer {
  image: Image | null = null;
  view: ViewState | null = null;

  /** The document's selection, overlay and preview; set by the window. */
  layers: ViewerLayers = { roi: null, overlay: [], preview: null };

  private bitmap: HTMLCanvasElement = document.createElement("canvas");
  private readonly ctx: CanvasRenderingContext2D;
  private drag: { x: number; y: number; ox: number; oy: number } | null = null;
  /** A selection being drawn or moved. */
  private shaping:
    | { kind: "new"; tool: Exclude<Tool, "hand" | "polygon">; x0: number; y0: number; points: [number, number][] }
    | { kind: "move"; from: Roi; x0: number; y0: number }
    | null = null;
  /** Polygon corners placed so far, and where the pointer is. */
  private polygon: { points: [number, number][]; hover: [number, number] | null } | null = null;
  private ants = 0;
  private antsTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onHover: (info: string) => void,
    private readonly onViewChange: () => void = () => {},
    /** The selection changed (drawn, moved or cleared) by the user. */
    private readonly onRoiChange: (roi: Roi | null) => void = () => {},
  ) {
    this.ctx = canvas.getContext("2d")!;
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement!);
    canvas.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    canvas.addEventListener("pointerdown", (e) => this.down(e));
    canvas.addEventListener("pointermove", (e) => {
      if (this.drag && this.view) {
        this.view.fitted = false;
        this.view.offX = this.drag.ox + (e.clientX - this.drag.x);
        this.view.offY = this.drag.oy + (e.clientY - this.drag.y);
        this.draw();
        this.onViewChange();
      } else if (this.shaping) this.reshape(e);
      else if (this.polygon) {
        this.polygon.hover = this.imagePoint(e, true);
        this.draw();
      }
      this.hover(e);
      this.updateCursor(e);
    });
    const end = (e: PointerEvent) => {
      this.drag = null;
      canvas.classList.remove("panning");
      if (this.shaping) this.finishShape(e);
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
    canvas.addEventListener("pointerleave", () => this.onHover(""));
    canvas.addEventListener("dblclick", () => this.closePolygon());
    canvas.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.polygon) {
        this.polygon = null;
        this.draw();
        e.stopPropagation();
      }
    });
    onToolChange(() => {
      this.polygon = null;
      this.draw();
      canvas.dataset.tool = currentTool;
    });
    canvas.dataset.tool = currentTool;
  }

  // ------------------------------------------------------------ selections

  /** Image coordinates under the pointer; `snap` rounds to pixel corners, as ImageJ's area tools do. */
  private imagePoint(e: { clientX: number; clientY: number }, snap: boolean): [number, number] {
    const v = this.view!;
    const rect = this.canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left - v.offX) / v.zoom;
    const y = (e.clientY - rect.top - v.offY) / v.zoom;
    return snap ? [Math.round(x), Math.round(y)] : [x, y];
  }

  /** True if image point (x, y) is on the current selection (inside an area, or near a line). */
  private onRoi(x: number, y: number): boolean {
    const r = this.layers.roi;
    if (!r || !this.view) return false;
    if (r.type === "line") {
      const dx = r.x2 - r.x1;
      const dy = r.y2 - r.y1;
      const len2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - r.x1) * dx + (y - r.y1) * dy) / len2));
      return Math.hypot(r.x1 + t * dx - x, r.y1 + t * dy - y) * this.view.zoom < 6;
    }
    const b = roiBounds(r);
    const ix = Math.floor(x) - b.x;
    const iy = Math.floor(y) - b.y;
    if (ix < 0 || iy < 0 || ix >= b.width || iy >= b.height) return false;
    const m = roiMask(r);
    return !m || m[iy * b.width + ix] !== 0;
  }

  private down(e: PointerEvent) {
    if (!this.view || !this.image || e.button !== 0) return;
    this.canvas.focus({ preventScroll: true });
    const tool = currentTool;
    if (tool === "hand" || spaceDown || e.altKey) {
      this.drag = { x: e.clientX, y: e.clientY, ox: this.view.offX, oy: this.view.offY };
      this.canvas.setPointerCapture(e.pointerId);
      this.canvas.classList.add("panning");
      return;
    }
    if (tool === "polygon") {
      const p = this.imagePoint(e, true);
      if (!this.polygon) {
        const [fx, fy] = this.imagePoint(e, false);
        if (this.onRoi(fx, fy)) return this.startMove(e);
        this.polygon = { points: [p], hover: p };
      } else {
        const first = this.polygon.points[0];
        // a click on the first corner closes the polygon
        if (this.polygon.points.length > 2 && Math.hypot(first[0] - p[0], first[1] - p[1]) * this.view.zoom < 8) return this.closePolygon();
        const last = this.polygon.points[this.polygon.points.length - 1];
        if (last[0] !== p[0] || last[1] !== p[1]) this.polygon.points.push(p);
      }
      this.draw();
      return;
    }
    const [fx, fy] = this.imagePoint(e, false);
    if (this.onRoi(fx, fy)) return this.startMove(e);
    const [x0, y0] = this.imagePoint(e, tool !== "line");
    this.shaping = { kind: "new", tool, x0: tool === "line" ? fx : x0, y0: tool === "line" ? fy : y0, points: [[x0, y0]] };
    this.canvas.setPointerCapture(e.pointerId);
  }

  private startMove(e: PointerEvent) {
    const [x0, y0] = this.imagePoint(e, true);
    this.shaping = { kind: "move", from: this.layers.roi!, x0, y0 };
    this.canvas.setPointerCapture(e.pointerId);
  }

  private closePolygon() {
    const poly = this.polygon;
    if (!poly) return;
    this.polygon = null;
    // a double-click adds the same corner twice; drop repeats
    const pts = poly.points.filter((p, i, a) => i === 0 || p[0] !== a[i - 1][0] || p[1] !== a[i - 1][1]);
    this.setRoi(pts.length > 2 ? { type: "polygon", points: pts } : null);
  }

  private reshape(e: PointerEvent) {
    const s = this.shaping!;
    if (s.kind === "move") {
      const [x, y] = this.imagePoint(e, true);
      this.layers.roi = moveRoi(s.from, x - s.x0, y - s.y0);
    } else if (s.tool === "freehand") {
      const p = this.imagePoint(e, true);
      const last = s.points[s.points.length - 1];
      if (p[0] !== last[0] || p[1] !== last[1]) s.points.push(p);
      this.layers.roi = { type: "freehand", points: [...s.points] };
    } else if (s.tool === "line") {
      const [x, y] = this.imagePoint(e, false);
      this.layers.roi = { type: "line", x1: s.x0, y1: s.y0, x2: x, y2: y };
    } else {
      let [x, y] = this.imagePoint(e, true);
      if (e.shiftKey) {
        // Shift: square or circle
        const d = Math.max(Math.abs(x - s.x0), Math.abs(y - s.y0));
        x = s.x0 + Math.sign(x - s.x0 || 1) * d;
        y = s.y0 + Math.sign(y - s.y0 || 1) * d;
      }
      this.layers.roi = { type: s.tool, x: Math.min(x, s.x0), y: Math.min(y, s.y0), width: Math.abs(x - s.x0), height: Math.abs(y - s.y0) };
    }
    this.draw();
  }

  private finishShape(e: PointerEvent) {
    const s = this.shaping!;
    this.shaping = null;
    const r = this.layers.roi;
    if (s.kind === "move") return this.setRoi(r);
    // a click without a drag clears the selection, as in ImageJ
    const empty =
      !r ||
      (r.type === "rect" || r.type === "oval" ? r.width < 1 || r.height < 1 : r.type === "line" ? Math.hypot(r.x2 - r.x1, r.y2 - r.y1) * this.view!.zoom < 3 : r.points.length < 3);
    this.setRoi(empty ? null : r);
    this.updateCursor(e);
  }

  /** Sets the selection (null clears it) and tells the window. */
  setRoi(roi: Roi | null) {
    this.layers.roi = roi;
    this.draw();
    this.onRoiChange(roi);
  }

  private updateCursor(e: PointerEvent) {
    if (!this.view || this.drag || this.shaping || currentTool === "hand") return;
    const [x, y] = this.imagePoint(e, false);
    this.canvas.classList.toggle("over-roi", !this.polygon && this.onRoi(x, y));
  }

  /** Shows `img` with `view` (a tab's own view state), or clears the viewer. */
  show(img: Image | null, view: ViewState | null) {
    this.image = img;
    this.view = view;
    if (!img || !view) {
      this.draw();
      return;
    }
    this.bitmap.width = img.shape.width;
    this.bitmap.height = img.shape.height;
    this.render();
    if (!view.placed) this.fit();
  }

  /** Re-renders the image pixels into the backing bitmap (after data, range, position or preview changes). */
  render() {
    if (!this.image || !this.view) return;
    const data = renderPixels(this.image, this.view);
    const pv = this.layers.preview;
    if (pv) {
      // ImageJ's threshold preview: values in range painted red
      const { c, z, t } = this.view.pos;
      const plane = getPlane(this.image, this.view.composite ? 0 : c, z, t);
      const px = data.data;
      for (let i = 0; i < plane.length; i++) {
        const v = plane[i];
        if (v >= pv[0] && v <= pv[1]) {
          px[i * 4] = 255;
          px[i * 4 + 1] = 0;
          px[i * 4 + 2] = 0;
        }
      }
    }
    this.bitmap.getContext("2d")!.putImageData(data, 0, 0);
    this.draw();
  }

  fit() {
    const { image, view } = this;
    if (!image || !view) return;
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    if (!cw || !ch) return; // not laid out yet; fits on the next resize
    const { width, height } = image.shape;
    view.zoom = Math.min(cw / width, ch / height) * 0.95;
    view.placed = true;
    view.fitted = true;
    this.center();
  }

  actualSize() {
    if (!this.view) return;
    this.view.zoom = 1;
    this.view.fitted = false;
    this.center();
  }

  /** The image point shown at the centre of the canvas. */
  centre(): { x: number; y: number } | null {
    const v = this.view;
    if (!v) return null;
    return { x: (this.canvas.clientWidth / 2 - v.offX) / v.zoom, y: (this.canvas.clientHeight / 2 - v.offY) / v.zoom };
  }

  /** Shows image point `c` at the canvas centre, at `zoom` (to follow another window). */
  lookAt(c: { x: number; y: number }, zoom: number) {
    const v = this.view;
    if (!v) return;
    v.zoom = zoom;
    v.offX = this.canvas.clientWidth / 2 - c.x * zoom;
    v.offY = this.canvas.clientHeight / 2 - c.y * zoom;
    v.placed = true;
    v.fitted = false;
    this.draw();
  }

  get zoomPercent() {
    return Math.round((this.view?.zoom ?? 1) * 100);
  }

  private center() {
    const { image, view } = this;
    if (!image || !view) return;
    view.offX = (this.canvas.clientWidth - image.shape.width * view.zoom) / 2;
    view.offY = (this.canvas.clientHeight - image.shape.height * view.zoom) / 2;
    this.draw();
    this.onViewChange();
  }

  /** Canvas size at the last resize, to keep the view centred when it changes. */
  private size = { w: 0, h: 0 };

  /**
   * The window changed size: a fitted image is refitted; one the user zoomed
   * or panned keeps its zoom and the same point stays in the middle.
   */
  private resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    const view = this.view;
    if (view && (!view.placed || view.fitted)) this.fit();
    else if (view && this.size.w && this.size.h) {
      view.offX += (w - this.size.w) / 2;
      view.offY += (h - this.size.h) / 2;
    }
    this.size = { w, h };
    this.draw();
  }

  private draw() {
    const { ctx, canvas, image, view } = this;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!image || !view) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = view.zoom < 1; // crisp pixels when zoomed in, like ImageJ
    ctx.drawImage(this.bitmap, view.offX, view.offY, image.shape.width * view.zoom, image.shape.height * view.zoom);
    this.drawLayers();
  }

  /** Overlay outlines, then the selection with marching ants, in screen space so lines stay thin. */
  private drawLayers() {
    const { ctx, view } = this;
    if (!view) return;
    const toScreen = (x: number, y: number): [number, number] => [view.offX + x * view.zoom, view.offY + y * view.zoom];
    const path = (r: Roi) => {
      ctx.beginPath();
      if (r.type === "rect") {
        const [x, y] = toScreen(r.x, r.y);
        ctx.rect(x, y, r.width * view.zoom, r.height * view.zoom);
      } else if (r.type === "oval") {
        const [x, y] = toScreen(r.x + r.width / 2, r.y + r.height / 2);
        ctx.ellipse(x, y, (r.width * view.zoom) / 2, (r.height * view.zoom) / 2, 0, 0, Math.PI * 2);
      } else if (r.type === "line") {
        ctx.moveTo(...toScreen(r.x1, r.y1));
        ctx.lineTo(...toScreen(r.x2, r.y2));
      } else {
        r.points.forEach(([x, y], i) => (i ? ctx.lineTo(...toScreen(x, y)) : ctx.moveTo(...toScreen(x, y))));
        ctx.closePath();
      }
    };
    const { overlay } = this.layers;
    if (overlay.length) {
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(0, 220, 255, 0.95)";
      for (const r of overlay) {
        path(r);
        ctx.stroke();
      }
      if (view.zoom >= 1 && overlay.length <= 500) {
        ctx.font = "10px ui-monospace, Menlo, monospace";
        ctx.fillStyle = "rgba(0, 220, 255, 0.95)";
        overlay.forEach((r, i) => {
          const b = roiBounds(r);
          if (Math.min(b.width, b.height) * view.zoom < 14) return; // too small to label legibly
          const [x, y] = toScreen(b.x + b.width / 2, b.y + b.height / 2);
          ctx.fillText(String(i + 1), x - 3, y + 3);
        });
      }
    }
    const shape: Roi | null = this.polygon
      ? { type: "polygon", points: this.polygon.hover ? [...this.polygon.points, this.polygon.hover] : this.polygon.points }
      : this.layers.roi;
    if (!shape) return this.stopAnts();
    ctx.lineWidth = 1;
    if (this.polygon && shape.type === "polygon") {
      ctx.beginPath();
      shape.points.forEach(([x, y], i) => (i ? ctx.lineTo(...toScreen(x, y)) : ctx.moveTo(...toScreen(x, y))));
    } else path(shape);
    ctx.setLineDash([]);
    ctx.strokeStyle = "#000";
    ctx.stroke();
    ctx.setLineDash([4, 4]);
    ctx.lineDashOffset = -this.ants;
    ctx.strokeStyle = "#fff";
    ctx.stroke();
    ctx.setLineDash([]);
    if (shape.type === "line") {
      for (const [x, y] of [toScreen(shape.x1, shape.y1), toScreen(shape.x2, shape.y2)]) {
        ctx.fillStyle = "#fff";
        ctx.fillRect(x - 2.5, y - 2.5, 5, 5);
        ctx.strokeStyle = "#000";
        ctx.strokeRect(x - 2.5, y - 2.5, 5, 5);
      }
    }
    if (!this.antsTimer)
      this.antsTimer = setInterval(() => {
        this.ants = (this.ants + 1) % 8;
        this.draw();
      }, 120);
  }

  private stopAnts() {
    clearInterval(this.antsTimer);
    this.antsTimer = undefined;
  }

  private onWheel(e: WheelEvent) {
    const view = this.view;
    if (!this.image || !view) return;
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = Math.exp(-e.deltaY * 0.0015);
    const next = Math.min(64, Math.max(1 / 64, view.zoom * factor));
    // keep the pixel under the cursor fixed
    view.offX = mx - ((mx - view.offX) * next) / view.zoom;
    view.offY = my - ((my - view.offY) * next) / view.zoom;
    view.zoom = next;
    view.fitted = false;
    this.draw();
    this.onViewChange();
  }

  private hover(e: PointerEvent) {
    const { image: img, view } = this;
    if (!img || !view) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left - view.offX) / view.zoom);
    const y = Math.floor((e.clientY - rect.top - view.offY) / view.zoom);
    const { width, height, channels } = img.shape;
    if (x < 0 || y < 0 || x >= width || y >= height) return this.onHover("");
    const fmt = (v: number) => (img.dtype === "float32" ? v.toPrecision(5) : String(v));
    const { c, z, t } = view.pos;
    const values =
      channels > 1 && view.composite
        ? Array.from({ length: channels }, (_, ch) => fmt(getPlane(img, ch, z, t)[y * width + x])).join(", ")
        : fmt(getPlane(img, c, z, t)[y * width + x]);
    const cal = img.calibration;
    const where = cal.unit === "pixel" ? `x=${x}, y=${y}` : `x=${(x * cal.pixelWidth).toFixed(2)}, y=${(y * cal.pixelHeight).toFixed(2)} ${cal.unit} (${x}, ${y})`;
    this.onHover(`${where}, value=${values}`);
  }
}
