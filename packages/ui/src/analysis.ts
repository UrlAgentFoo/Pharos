/**
 * The analysis workflow on top of the core ports: Measure, the Threshold
 * dialog with a live red preview, Analyze Particles and Set Scale from a
 * line selection. Image changes go through the command registry (so they
 * land in the history); measurements go to the Results table.
 */
import {
  type Image,
  type Params,
  type Roi,
  THRESHOLD_METHODS,
  type ThresholdMethod,
  analyzeParticles,
  autoThreshold,
  getPlane,
  measure,
  type PixelArray,
  dtypeOf,
  minMax,
  roiBounds,
  roiLength,
  roiMask,
  thresholdHistogram,
} from "@pharos/core";
import { escapeHtml, showDialog } from "./dialogs.js";
import { icon } from "./icons.js";
import type { ResultRow, Results } from "./results.js";
import type { Doc, Workspace } from "./workspace.js";

export interface AnalysisContext {
  ws: Workspace;
  results: Results;
  /** Re-renders a window (after a preview or overlay change). */
  render(doc: Doc): void;
  /** Applies a registry command as a step (to the image's group too, if it shares steps). */
  apply(doc: Doc, command: string, params: Params): Promise<void>;
  notify(text: string): void;
  lastParams: Map<string, Params>;
}

/** "z3", "c2 z3", … for stacks; empty for a single plane. */
export function sliceLabel(img: Image, pos: { c: number; z: number; t: number }): string {
  const { channels, slices, frames } = img.shape;
  return [channels > 1 && `c${pos.c + 1}`, slices > 1 && `z${pos.z + 1}`, frames > 1 && `t${pos.t + 1}`].filter(Boolean).join(" ");
}

const unitLabel = (img: Image) => (img.calibration.unit === "pixel" ? "pixels" : img.calibration.unit);

/** True if the image is a mask: 8-bit with only 0 and 255. */
function isMask(img: Image): boolean {
  return img.dtype === "uint8" && img.planes.every((p) => p.every((v) => v === 0 || v === 255));
}

// ------------------------------------------------------------ Measure

/** Analyze › Measure: the selection (or whole slice) on the shown plane, as one Results row. */
export function measureDoc(ctx: AnalysisContext, doc: Doc) {
  const img = doc.timeline.current();
  const { width, height } = img.shape;
  const pos = doc.view.pos;
  const plane = getPlane(img, pos.c, pos.z, pos.t);
  const roi = doc.layers.roi;
  let values: Record<string, number>;
  if (roi?.type === "line") {
    // ImageJ measures a straight line's length and angle
    values = { Length: roiLength(roi, img.calibration), Angle: (Math.atan2(roi.y1 - roi.y2, roi.x2 - roi.x1) * 180) / Math.PI };
  } else {
    values = measure(plane, width, height, img.calibration, roi);
  }
  ctx.results.add([{ doc: doc.id, image: doc.name, slice: sliceLabel(img, pos), values, roi }]);
}

// ------------------------------------------------------------ Threshold

function histogramSvg(hist: ArrayLike<number>): string {
  let max = 0;
  for (let i = 0; i < hist.length; i++) if (hist[i] > max) max = hist[i];
  // a log-ish scale keeps small peaks visible next to a large background
  const h = (v: number) => (max ? (Math.log1p(v) / Math.log1p(max)) * 60 : 0);
  let d = "M0 60";
  for (let i = 0; i < hist.length; i++) d += `L${i} ${(60 - h(hist[i])).toFixed(1)}L${i + 1} ${(60 - h(hist[i])).toFixed(1)}`;
  return `<path d="${d}L256 60Z" fill="var(--hist)"/>`;
}

/**
 * Image › Adjust › Threshold: pick an automatic method (or drag the range by
 * hand) while the image shows in red what counts as foreground, then Apply
 * makes a mask (Process › Binary › Convert to Mask) as a history step.
 */
export async function thresholdDialog(ctx: AnalysisContext, doc: Doc, initial?: Params) {
  const img = doc.timeline.current();
  const pos = doc.view.pos;
  const plane = getPlane(img, pos.c, pos.z, pos.t);
  const { histogram } = thresholdHistogram(plane);
  const [dataMin, dataMax] = img.dtype === "uint8" ? [0, 255] : minMax(plane);
  const isFloat = img.dtype === "float32";
  const step = isFloat ? (dataMax - dataMin) / 1000 || 0.001 : 1;
  const p = { method: "Default", dark: true, ...(initial ?? ctx.lastParams.get("convert-to-mask") ?? {}) } as { method: string; dark: boolean };
  const methods = [...THRESHOLD_METHODS, "Manual"];
  const fmt = (v: number) => (isFloat ? Number(v.toPrecision(5)) : Math.round(v));
  const html = `<form method="dialog" class="thr">
      <h2 class="with-icon">${icon("threshold", 20)} Threshold</h2>
      <p class="muted">Red shows what will be white in the mask. Pick a method, or drag the range by hand.</p>
      <div class="thr-hist">
        <svg viewBox="0 0 256 60" preserveAspectRatio="none" aria-hidden="true">${histogramSvg(histogram)}<rect class="thr-range" y="0" height="60"/></svg>
        <div class="thr-scale"><span>${fmt(dataMin)}</span><span>${fmt(dataMax)}</span></div>
      </div>
      <div class="thr-sliders">
        <label class="thr-row"><span>Lower</span><input type="range" name="loR" min="${dataMin}" max="${dataMax}" step="${step}"/><input type="number" name="lo" step="any"/></label>
        <label class="thr-row"><span>Upper</span><input type="range" name="hiR" min="${dataMin}" max="${dataMax}" step="${step}"/><input type="number" name="hi" step="any"/></label>
      </div>
      <div class="thr-opts">
        <label class="field">Method<select name="method">${methods.map((m) => `<option${m === p.method ? " selected" : ""}>${m}</option>`).join("")}</select></label>
        <label class="check"><input type="checkbox" name="dark"${p.dark ? " checked" : ""}/> Dark background</label>
      </div>
      <p class="thr-stat muted"></p>
      <footer><button type="button" data-cancel>Cancel</button><button class="primary">Apply: make mask</button></footer>
    </form>`;
  const chosen = await showDialog<Params | null>(
    html,
    (done, el) => {
      el.classList.add("side");
      const form = el.querySelector("form")!;
      const q = <T extends HTMLElement>(n: string) => form.querySelector<T>(`[name="${n}"]`)!;
      const method = q<HTMLSelectElement>("method");
      const dark = q<HTMLInputElement>("dark");
      const lo = q<HTMLInputElement>("lo");
      const hi = q<HTMLInputElement>("hi");
      const loR = q<HTMLInputElement>("loR");
      const hiR = q<HTMLInputElement>("hiR");
      const range = form.querySelector<SVGRectElement>(".thr-range")!;
      const stat = form.querySelector<HTMLElement>(".thr-stat")!;
      let lower = 0;
      let upper = 0;
      const show = () => {
        lo.value = String(fmt(lower));
        hi.value = String(fmt(upper));
        loR.value = String(Math.max(dataMin, lower));
        hiR.value = String(Math.min(dataMax, upper));
        const x = (v: number) => (dataMax > dataMin ? ((Math.min(dataMax, Math.max(dataMin, v)) - dataMin) / (dataMax - dataMin)) * 256 : 0);
        range.setAttribute("x", String(x(lower)));
        range.setAttribute("width", String(Math.max(0.5, x(upper) - x(lower))));
        let n = 0;
        for (let i = 0; i < plane.length; i++) if (plane[i] >= lower && plane[i] <= upper) n++;
        stat.textContent = `${((100 * n) / plane.length).toFixed(1)}% of the ${sliceLabel(img, pos) ? "slice" : "image"} is foreground`;
        doc.layers.preview = [lower, upper];
        ctx.render(doc);
      };
      const auto = () => {
        if (method.value === "Manual") return show();
        [lower, upper] = autoThreshold(plane, method.value as ThresholdMethod, dark.checked);
        show();
      };
      const manual = (l: number, u: number) => {
        method.value = "Manual";
        lower = Math.min(l, u);
        upper = Math.max(l, u);
        show();
      };
      method.addEventListener("change", auto);
      dark.addEventListener("change", () => {
        if (method.value === "Manual") {
          // flip to the other side of the histogram
          [lower, upper] = lower <= dataMin ? [upper, dataMax] : [dataMin, lower];
          show();
        } else auto();
      });
      loR.addEventListener("input", () => manual(Number(loR.value), upper));
      hiR.addEventListener("input", () => manual(lower, Number(hiR.value)));
      lo.addEventListener("change", () => manual(Number(lo.value), upper));
      hi.addEventListener("change", () => manual(lower, Number(hi.value)));
      if (p.method === "Manual" && initial) [lower, upper] = [Number(initial.lower), Number(initial.upper)];
      else if (p.method === "Manual") [lower, upper] = autoThreshold(plane, "Default", p.dark);
      auto();
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        done({ method: method.value, dark: dark.checked, lower, upper });
      });
    },
    null,
  );
  document.getElementById("dialog")!.classList.remove("side");
  doc.layers.preview = null;
  ctx.render(doc);
  if (!chosen) return;
  ctx.lastParams.set("convert-to-mask", chosen);
  await ctx.apply(doc, "convert-to-mask", chosen);
}

// ------------------------------------------------------------ Analyze Particles

/**
 * Analyze › Analyze Particles: counts and measures the objects in a mask (or
 * in a thresholded image), optionally measuring intensities in another image
 * of the same size, e.g. the original before thresholding.
 */
export async function particlesDialog(ctx: AnalysisContext, doc: Doc) {
  const img = doc.timeline.current();
  const { width, height } = img.shape;
  const mask = isMask(img);
  const unit = unitLabel(img);
  // same-size images to measure intensities in: other windows, and this image before its mask step
  const before = doc.timeline.steps.slice(0, doc.timeline.marker).findLastIndex((s) => s.command === "convert-to-mask" && s.enabled);
  const sources: { id: string; label: string; image: () => Image }[] = [{ id: "self", label: `${doc.name} (as shown)`, image: () => img }];
  if (before >= 0) sources.push({ id: "before", label: `${doc.name}, before Convert to Mask`, image: () => doc.timeline.imageAt(before) });
  for (const d of ctx.ws.docs) {
    const di = d.timeline.current();
    if (d !== doc && di.shape.width === width && di.shape.height === height) sources.push({ id: d.id, label: d.name, image: () => d.timeline.current() });
  }
  const last = (ctx.lastParams.get("analyze-particles") ?? {}) as Record<string, unknown>;
  const v = <T>(k: string, dflt: T): T => (last[k] as T) ?? dflt;
  const methodField = mask
    ? `<p class="muted">Objects are the white areas of this mask.</p>`
    : `<label class="field">Objects (threshold)<select name="method">${THRESHOLD_METHODS.map((m) => `<option${m === v("method", "Default") ? " selected" : ""}>${m}</option>`).join("")}</select></label>
       <label class="check"><input type="checkbox" name="dark"${v("dark", true) ? " checked" : ""}/> Dark background (bright objects)</label>`;
  const chosen = await showDialog<Record<string, string | boolean> | null>(
    `<form method="dialog"><h2 class="with-icon">${icon("particles", 20)} Analyze Particles</h2>
      <p class="muted">Counts and measures each separate object${mask ? "" : ", found by thresholding"}. Results go to the Results table; outlines are drawn on the image.</p>
      ${methodField}
      <div class="field-row">
        <label class="field">Size min (${escapeHtml(unit)}²)<input name="minSize" type="number" min="0" step="any" value="${v("minSize", 0)}"/></label>
        <label class="field">Size max<input name="maxSize" type="text" value="${escapeHtml(String(v("maxSize", "Infinity")))}"/></label>
      </div>
      <div class="field-row">
        <label class="field">Circularity min<input name="minCirc" type="number" min="0" max="1" step="0.05" value="${v("minCirc", 0)}"/></label>
        <label class="field">Circularity max<input name="maxCirc" type="number" min="0" max="1" step="0.05" value="${v("maxCirc", 1)}"/></label>
      </div>
      <label class="field">Measure intensities in<select name="redirect">${sources.map((s) => `<option value="${s.id}"${s.id === (before >= 0 ? "before" : "self") ? " selected" : ""}>${escapeHtml(s.label)}</option>`).join("")}</select></label>
      <label class="check"><input type="checkbox" name="exclude"${v("exclude", false) ? " checked" : ""}/> Exclude objects on edges</label>
      <label class="check"><input type="checkbox" name="holes"${v("holes", false) ? " checked" : ""}/> Include holes</label>
      <label class="check"><input type="checkbox" name="outlines"${v("outlines", true) ? " checked" : ""}/> Show outlines on the image</label>
      <p class="error" hidden></p>
      <footer><button type="button" data-cancel>Cancel</button><button class="primary">Analyze</button></footer></form>`,
    (done, el) => {
      const form = el.querySelector("form")!;
      const err = el.querySelector<HTMLElement>(".error")!;
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const out: Record<string, string | boolean> = {};
        for (const input of form.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[name]")) out[input.name] = input instanceof HTMLInputElement && input.type === "checkbox" ? input.checked : input.value;
        const max = String(out.maxSize).trim().toLowerCase();
        if (max !== "infinity" && !(Number(max) >= 0)) {
          err.hidden = false;
          err.textContent = "Size max must be a number or Infinity";
          return;
        }
        done(out);
      });
    },
    null,
  );
  if (!chosen) return;
  ctx.lastParams.set("analyze-particles", chosen);

  const pos = doc.view.pos;
  const full = getPlane(img, pos.c, pos.z, pos.t);
  const [lower, upper] = mask ? [255, 255] : autoThreshold(full, chosen.method as ThresholdMethod, chosen.dark as boolean);
  // as in ImageJ, an area selection limits the analysis to the objects inside it
  const roi = doc.layers.roi && doc.layers.roi.type !== "line" ? doc.layers.roi : null;
  const plane = roi ? outsideCleared(full, width, height, roi, lower, upper) : full;
  const target = sources.find((s) => s.id === chosen.redirect) ?? sources[0];
  const tImg = target.image();
  const tPlane = getPlane(tImg, Math.min(pos.c, tImg.shape.channels - 1), Math.min(pos.z, tImg.shape.slices - 1), Math.min(pos.t, tImg.shape.frames - 1));
  const cal = img.calibration;
  const px = cal.pixelWidth * cal.pixelHeight;
  const maxSize = String(chosen.maxSize).trim().toLowerCase() === "infinity" ? Infinity : Number(chosen.maxSize);
  const res = analyzeParticles(
    plane,
    width,
    height,
    cal,
    {
      lower,
      upper,
      // sizes are given in calibrated units; the analysis counts pixels
      minSize: Number(chosen.minSize) / px,
      maxSize: maxSize / px,
      minCircularity: Number(chosen.minCirc),
      maxCircularity: Number(chosen.maxCirc),
      excludeEdges: chosen.exclude as boolean,
      includeHoles: chosen.holes as boolean,
    },
    tPlane,
  );
  const label = sliceLabel(img, pos);
  const run = ctx.results.newRun();
  const rows: ResultRow[] = res.particles.map((p) => ({ doc: doc.id, image: doc.name, slice: label, values: p.measurement, roi: p.roi as Roi, run }));
  doc.layers.overlay = chosen.outlines ? res.particles.map((p) => p.roi) : [];
  ctx.render(doc);
  ctx.results.add(rows, { doc: doc.id, image: doc.name, slice: label, values: res.summary, run });
  ctx.notify(`${res.particles.length} particle${res.particles.length === 1 ? "" : "s"} found${roi ? " inside the selection" : ""}${target.id === "self" ? "" : `, intensities from ${target.label}`}`);
}

/** A copy of `plane` with everything outside `roi` set outside [lower, upper], so no objects are found there. */
function outsideCleared(plane: PixelArray, width: number, height: number, roi: Roi, lower: number, upper: number): PixelArray {
  const type = dtypeOf(plane);
  const top = type === "uint8" ? 255 : type === "uint16" ? 65535 : Infinity;
  const bottom = type === "float32" ? -Infinity : 0;
  const off = lower > bottom ? bottom : upper < top ? top : null;
  if (off === null) return plane; // the whole value range is foreground
  const out = plane.slice();
  const b = roiBounds(roi);
  const m = roiMask(roi);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ix = x - b.x;
      const iy = y - b.y;
      const inside = ix >= 0 && iy >= 0 && ix < b.width && iy < b.height && (!m || m[iy * b.width + ix] !== 0);
      if (!inside) out[y * width + x] = off;
    }
  }
  return out;
}

// ------------------------------------------------------------ Set Scale

/** Initial Set Scale values: the line selection's length in pixels, if there is one. */
export function setScaleInitial(doc: Doc, last: Params | undefined): Params {
  const img = doc.timeline.current();
  const cal = img.calibration;
  const r = doc.layers.roi;
  const known = (last?.known as number) ?? 1;
  const unit = (last?.unit as string) ?? (cal.unit === "pixel" ? "µm" : cal.unit);
  if (r?.type === "line") return { distance: Number(Math.hypot(r.x2 - r.x1, r.y2 - r.y1).toFixed(2)), known, unit };
  // otherwise show the current scale
  if (cal.unit !== "pixel" && cal.pixelWidth) return { distance: Number((1 / cal.pixelWidth).toFixed(4)), known: 1, unit: cal.unit };
  return { distance: 0, known, unit };
}
