/**
 * Selections (ImageJ "ROIs") and measurements on them.
 *
 * Masks, perimeters and statistics follow ImageJ 1.x exactly (OvalRoi,
 * PolygonFiller, PolygonRoi, Analyzer, ImageStatistics), so Measure gives
 * the same numbers as ImageJ.
 *
 * Coordinates are in pixels. Polygon vertices lie on pixel corners: (0,0) is
 * the top-left corner of pixel (0,0), as in ImageJ.
 */
import type { Calibration, PixelArray } from "./image.js";

export type Roi =
  | { type: "rect"; x: number; y: number; width: number; height: number }
  | { type: "oval"; x: number; y: number; width: number; height: number }
  /** Drawn with the polygon tool: straight edges between vertices. */
  | { type: "polygon"; points: [number, number][] }
  /** Drawn freehand; the perimeter is smoothed, as in ImageJ. */
  | { type: "freehand"; points: [number, number][] }
  /** Traced outline (the wand, particle analysis): perimeter counts corners. */
  | { type: "traced"; points: [number, number][] }
  /** A straight line, for lengths, profiles and Set Scale. */
  | { type: "line"; x1: number; y1: number; x2: number; y2: number };

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const isAreaRoi = (r: Roi) => r.type !== "line";

export function roiBounds(r: Roi): Bounds {
  switch (r.type) {
    case "rect":
    case "oval":
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    case "line": {
      const x = Math.min(r.x1, r.x2);
      const y = Math.min(r.y1, r.y2);
      return { x, y, width: Math.abs(r.x2 - r.x1), height: Math.abs(r.y2 - r.y1) };
    }
    default: {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const [x, y] of r.points) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
      return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    }
  }
}

/**
 * The selection's mask over its bounding box: 255 inside, 0 outside, with
 * `width * height` bytes. Null for rectangles (every pixel is inside).
 */
export function roiMask(r: Roi): Uint8Array | null {
  const b = roiBounds(r);
  if (r.type === "rect" || r.type === "line") return null;
  if (r.type === "oval") return ovalMask(b.width, b.height);
  const xs = r.points.map((p) => p[0] - b.x);
  const ys = r.points.map((p) => p[1] - b.y);
  return polygonMask(xs, ys, b.width, b.height);
}

/** OvalRoi.getMask: pixel centres inside the ellipse inscribed in the bounds. */
function ovalMask(width: number, height: number): Uint8Array {
  const mask = new Uint8Array(width * height);
  let a = width / 2;
  let b = height / 2;
  const a2 = a * a;
  const b2 = b * b;
  a -= 0.5;
  b -= 0.5;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const xx = x - a;
      const yy = y - b;
      if ((xx * xx) / a2 + (yy * yy) / b2 <= 1.0) mask[y * width + x] = 255;
    }
  }
  return mask;
}

/**
 * PolygonFiller (integer vertices): scan-line fill where pixel (x,y) is
 * inside when its centre (x+0.5, y+0.5) is; ties resolved as in ImageJ.
 */
export function polygonMask(xp: number[], yp: number[], width: number, height: number): Uint8Array {
  const mask = new Uint8Array(width * height);
  const n = xp.length;
  const ex: number[] = [];
  const ey1: number[] = [];
  const ey2: number[] = [];
  const eslope: number[] = [];
  let yMin = Infinity;
  let yMax = -Infinity;
  for (let i = 0; i < n; i++) {
    const j = i === n - 1 ? 0 : i + 1;
    let y1 = yp[i];
    let y2 = yp[j];
    let x1 = xp[i];
    let x2 = xp[j];
    if (y1 === y2) continue; // horizontal edges do not matter
    if (y1 > y2) {
      [y1, y2] = [y2, y1];
      [x1, x2] = [x2, x1];
    }
    const slope = (x2 - x1) / (y2 - y1);
    ex.push(x1 + 0.5 * slope + 1e-8); // x at the centre of row y1
    ey1.push(y1);
    ey2.push(y2);
    eslope.push(slope);
    if (y1 < yMin) yMin = y1;
    if (y2 > yMax) yMax = y2;
  }
  const edges = ex.length;
  let active: number[] = [];
  const sortActive = () => active.sort((a, b) => ex[a] - ex[b]);
  const yStart = yMin > 0 ? yMin : 0;
  if (yMin !== 0) {
    for (let i = 0; i < edges; i++) {
      if (ey1[i] < yStart && ey2[i] >= yStart) {
        ex[i] += eslope[i] * (yStart - ey1[i]);
        active.push(i);
      }
    }
    sortActive();
  }
  for (let y = yStart; y < Math.min(height, yMax + 1); y++) {
    active = active.filter((e) => !(y < ey1[e] || y >= ey2[e]));
    for (let e = 0; e < edges; e++) {
      if (y !== ey1[e]) continue;
      let at = 0;
      while (at < active.length && ex[e] > ex[active[at]]) at++;
      active.splice(at, 0, e);
    }
    const row = y * width;
    for (let i = 0; i + 1 < active.length; i += 2) {
      let x1 = Math.trunc(ex[active[i]] + 0.5);
      let x2 = Math.trunc(ex[active[i + 1]] + 0.5);
      if (x1 < 0) x1 = 0;
      if (x1 > width) x1 = width;
      if (x2 < 0) x2 = 0;
      if (x2 > width) x2 = width;
      for (let x = x1; x < x2; x++) mask[row + x] = 255;
    }
    let sorted = true;
    let prev = -Number.MAX_VALUE;
    for (const e of active) {
      ex[e] += eslope[e];
      if (ex[e] < prev) sorted = false;
      prev = ex[e];
    }
    if (!sorted) sortActive();
  }
  return mask;
}

/** Perimeter (area selections) or length (lines), in calibrated units, as ImageJ's Roi.getLength. */
export function roiLength(r: Roi, cal: Pick<Calibration, "pixelWidth" | "pixelHeight">): number {
  const pw = cal.pixelWidth;
  const ph = cal.pixelHeight;
  switch (r.type) {
    case "rect":
      return 2 * r.width * pw + 2 * r.height * ph;
    case "oval": {
      // Ramanujan's approximation for the circumference of an ellipse
      const a = 0.5 * r.width * pw;
      const b = 0.5 * r.height * ph;
      return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
    }
    case "line":
      return Math.sqrt(((r.x2 - r.x1) * pw) ** 2 + ((r.y2 - r.y1) * ph) ** 2);
    case "traced":
      return tracedPerimeter(r.points, pw, ph);
    case "freehand":
      return r.points.length > 2 ? smoothedPerimeter(r.points, pw, ph) : polygonLength(r.points, pw, ph);
    case "polygon":
      return polygonLength(r.points, pw, ph);
  }
}

function polygonLength(p: [number, number][], pw: number, ph: number): number {
  let length = 0;
  for (let i = 0; i < p.length; i++) {
    const [x1, y1] = p[i];
    const [x2, y2] = p[(i + 1) % p.length];
    length += Math.sqrt(((x2 - x1) * pw) ** 2 + ((y2 - y1) * ph) ** 2);
  }
  return p.length < 2 ? 0 : length;
}

/** PolygonRoi.getSmoothedPerimeter: a 3-point running average, then closed. */
function smoothedPerimeter(p: [number, number][], pw: number, ph: number): number {
  const n = p.length;
  const w2 = pw * pw;
  const h2 = ph * ph;
  const x = p.map((q) => q[0]);
  const y = p.map((q) => q[1]);
  let dx = (x[0] + x[1] + x[2]) / 3.0 - x[0];
  let dy = (y[0] + y[1] + y[2]) / 3.0 - y[0];
  let length = Math.sqrt(dx * dx * w2 + dy * dy * h2);
  for (let i = 1; i < n - 2; i++) {
    dx = (x[i + 2] - x[i - 1]) / 3.0;
    dy = (y[i + 2] - y[i - 1]) / 3.0;
    length += Math.sqrt(dx * dx * w2 + dy * dy * h2);
  }
  dx = x[n - 1] - (x[n - 3] + x[n - 2] + x[n - 1]) / 3.0;
  dy = y[n - 1] - (y[n - 3] + y[n - 2] + y[n - 1]) / 3.0;
  length += Math.sqrt(dx * dx * w2 + dy * dy * h2);
  dx = x[n - 1] - x[0];
  dy = y[n - 1] - y[0];
  return length + Math.sqrt(dx * dx * w2 + dy * dy * h2);
}

/** PolygonRoi.getTracedPerimeter: straight edges count 1, corners sqrt(2). */
function tracedPerimeter(p: [number, number][], w: number, h: number): number {
  const n = p.length;
  if (n < 4) return 0;
  let sumdx = 0;
  let sumdy = 0;
  let nCorners = 0;
  let dx1 = p[0][0] - p[n - 1][0];
  let dy1 = p[0][1] - p[n - 1][1];
  let side1 = Math.abs(dx1) + Math.abs(dy1);
  let corner = false;
  for (let i = 0; i < n; i++) {
    const next = i + 1 === n ? 0 : i + 1;
    const dx2 = p[next][0] - p[i][0];
    const dy2 = p[next][1] - p[i][1];
    sumdx += Math.abs(dx1);
    sumdy += Math.abs(dy1);
    const side2 = Math.abs(dx2) + Math.abs(dy2);
    if (side1 > 1 || !corner) {
      corner = true;
      nCorners++;
    } else corner = false;
    dx1 = dx2;
    dy1 = dy2;
    side1 = side2;
  }
  return sumdx * w + sumdy * h - nCorners * (w + h - Math.sqrt(w * w + h * h));
}

// ---------------------------------------------------------------- measurements

/** One row of measurements, with ImageJ's column names. */
export type Measurement = Record<string, number>;

/** The columns Measure fills, in ImageJ's order. */
export const MEASURE_COLUMNS = ["Area", "Mean", "StdDev", "Min", "Max", "X", "Y", "BX", "BY", "Width", "Height", "Perim.", "Circ.", "IntDen", "RawIntDen"] as const;

/**
 * Measures a plane within a selection (or the whole plane), like
 * Analyze › Measure: area, mean, standard deviation, min, max, centroid,
 * bounding rectangle, perimeter, circularity and integrated density.
 * Uses `mask` (over `bounds`) when given instead of the selection's own.
 */
export function measure(
  plane: PixelArray,
  width: number,
  height: number,
  cal: Pick<Calibration, "pixelWidth" | "pixelHeight">,
  roi: Roi | null,
  opts: { mask?: Uint8Array | null; bounds?: Bounds } = {},
): Measurement {
  const b = opts.bounds ?? (roi && isAreaRoi(roi) ? roiBounds(roi) : { x: 0, y: 0, width, height });
  const mask = opts.mask !== undefined ? opts.mask : roi ? roiMask(roi) : null;
  let n = 0;
  let sum = 0;
  let sum2 = 0;
  let min = Infinity;
  let max = -Infinity;
  let xsum = 0;
  let ysum = 0;
  for (let y = b.y, my = 0; y < b.y + b.height; y++, my++) {
    if (y < 0 || y >= height) continue;
    for (let x = b.x, mx = 0; x < b.x + b.width; x++, mx++) {
      if (x < 0 || x >= width) continue;
      if (mask && mask[my * b.width + mx] === 0) continue;
      const v = plane[y * width + x];
      if (v !== v) continue; // NaN pixels do not count, as in ImageJ
      n++;
      sum += v;
      sum2 += v * v;
      if (v < min) min = v;
      if (v > max) max = v;
      xsum += x;
      ysum += y;
    }
  }
  const pw = cal.pixelWidth;
  const ph = cal.pixelHeight;
  const area = n * pw * ph;
  const mean = n ? sum / n : NaN;
  const variance = n > 1 ? (n * sum2 - sum * sum) / n / (n - 1) : 0;
  const perimeter = roi ? roiLength(roi, cal) : width * 2 + height * 2;
  let circularity = perimeter === 0 ? 0 : (4 * Math.PI * area) / (perimeter * perimeter);
  if (circularity > 1) circularity = 1;
  return {
    Area: area,
    Mean: mean,
    StdDev: Math.sqrt(Math.max(0, variance)),
    Min: n ? min : NaN,
    Max: n ? max : NaN,
    X: n ? (xsum / n + 0.5) * pw : NaN,
    Y: n ? (ysum / n + 0.5) * ph : NaN,
    BX: b.x * pw,
    BY: b.y * ph,
    Width: b.width * pw,
    Height: b.height * ph,
    "Perim.": perimeter,
    "Circ.": circularity,
    IntDen: area * mean,
    RawIntDen: n * mean,
  };
}
