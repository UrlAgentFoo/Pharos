/**
 * Canvas image viewer: zoom (wheel), pan (drag), pixel readout, and the
 * display range and colours. It only shows images; changing them is what
 * ship operations are for.
 */
import { type Image, LUTS, type Lut, autoContrast, getPlane, minMax, renderComposite, renderGray, renderLabels } from "@pharos/core";

const CHANNEL_LUTS: Lut[] = [LUTS.red, LUTS.green, LUTS.blue, LUTS.cyan, LUTS.magenta, LUTS.yellow];

export interface Position {
  c: number;
  z: number;
  t: number;
}

/** How one image is shown. Each view owns one, so switching back restores zoom, slice and contrast. */
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
  /** True once the user sets the display range by hand. */
  manualRange: boolean;
  /** Channels switched off in the composite. */
  hidden: boolean[];
  /** A label image: every object id in its own colour, background black. */
  labels?: boolean;
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

/** Display ranges for the slice on show: auto contrast, or the full range of the data. */
export function setRanges(view: ViewState, img: Image, how: "auto" | "full") {
  const { z, t } = view.pos;
  view.ranges = Array.from({ length: img.shape.channels }, (_, c) => {
    const plane = getPlane(img, c, z, t);
    return how === "auto" ? autoContrast(plane) : img.dtype === "uint8" ? [0, 255] : minMax(plane);
  });
  view.manualRange = true;
}

/** Renders the plane(s) at the view's position into RGBA pixels. */
function renderPixels(img: Image, view: ViewState): ImageData {
  const { width, height, channels } = img.shape;
  const data = new ImageData(width, height);
  const { z, t, c } = view.pos;
  if (view.labels) {
    renderLabels(getPlane(img, c, z, t), data.data);
    return data;
  }
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

/** A small rendering of an image (for notes and minimised windows), as a fresh canvas. */
export function thumbnailElement(img: Image, view: ViewState, max = 240): HTMLCanvasElement {
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
  return canvas;
}

export class Viewer {
  image: Image | null = null;
  view: ViewState | null = null;

  private bitmap: HTMLCanvasElement = document.createElement("canvas");
  private readonly ctx: CanvasRenderingContext2D;
  private drag: { x: number; y: number; ox: number; oy: number } | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onHover: (info: string) => void,
    private readonly onViewChange: () => void = () => {},
  ) {
    this.ctx = canvas.getContext("2d")!;
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement!);
    canvas.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    canvas.addEventListener("pointerdown", (e) => {
      if (!this.view || e.button !== 0) return;
      this.canvas.focus({ preventScroll: true });
      this.drag = { x: e.clientX, y: e.clientY, ox: this.view.offX, oy: this.view.offY };
      canvas.setPointerCapture(e.pointerId);
      canvas.classList.add("panning");
    });
    canvas.addEventListener("pointermove", (e) => {
      if (this.drag && this.view) {
        this.view.fitted = false;
        this.view.offX = this.drag.ox + (e.clientX - this.drag.x);
        this.view.offY = this.drag.oy + (e.clientY - this.drag.y);
        this.draw();
        this.onViewChange();
      }
      this.hover(e);
    });
    const end = () => {
      this.drag = null;
      canvas.classList.remove("panning");
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
    canvas.addEventListener("pointerleave", () => this.onHover(""));
    canvas.addEventListener("dblclick", () => this.fit());
  }

  /** Shows `img` with `view`, or clears the viewer. */
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

  /** Re-renders the image pixels into the backing bitmap (after a range or position change). */
  render() {
    if (!this.image || !this.view) return;
    this.bitmap.getContext("2d")!.putImageData(renderPixels(this.image, this.view), 0, 0);
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
    ctx.imageSmoothingEnabled = view.zoom < 1; // crisp pixels when zoomed in
    ctx.drawImage(this.bitmap, view.offX, view.offY, image.shape.width * view.zoom, image.shape.height * view.zoom);
  }

  private onWheel(e: WheelEvent) {
    const view = this.view;
    if (!this.image || !view) return;
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const next = Math.min(64, Math.max(1 / 64, view.zoom * Math.exp(-e.deltaY * 0.0015)));
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
