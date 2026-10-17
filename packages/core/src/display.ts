/** Rendering helpers: map pixel values to 8-bit RGBA through a display range and LUT. */
import type { PixelArray } from "./image.js";

/** Min and max over a plane, ignoring NaN. */
export function minMax(plane: PixelArray): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < plane.length; i++) {
    const v = plane[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return [min, max];
}

/** A lookup table of 256 RGB entries. */
export interface Lut {
  readonly name: string;
  readonly r: Uint8Array;
  readonly g: Uint8Array;
  readonly b: Uint8Array;
}

function makeLut(name: string, fn: (i: number) => [number, number, number]): Lut {
  const r = new Uint8Array(256);
  const g = new Uint8Array(256);
  const b = new Uint8Array(256);
  for (let i = 0; i < 256; i++) [r[i], g[i], b[i]] = fn(i);
  return { name, r, g, b };
}

export const LUTS: Record<string, Lut> = {
  grays: makeLut("Grays", (i) => [i, i, i]),
  red: makeLut("Red", (i) => [i, 0, 0]),
  green: makeLut("Green", (i) => [0, i, 0]),
  blue: makeLut("Blue", (i) => [0, 0, i]),
  cyan: makeLut("Cyan", (i) => [0, i, i]),
  magenta: makeLut("Magenta", (i) => [i, 0, i]),
  yellow: makeLut("Yellow", (i) => [i, i, 0]),
};

/**
 * Maps `plane` to 8-bit indices using ImageJ's linear display mapping:
 * `min` maps to 0, `max` to 255, values outside are clamped.
 */
export function toDisplayIndices(plane: PixelArray, min: number, max: number, out = new Uint8Array(plane.length)): Uint8Array {
  const scale = max > min ? 256 / (max - min + (plane instanceof Float32Array ? 0 : 1)) : 0;
  for (let i = 0; i < plane.length; i++) {
    const v = plane[i];
    let idx = Math.floor((v - min) * scale);
    if (!(idx > 0)) idx = 0; // also handles NaN
    if (idx > 255) idx = 255;
    out[i] = idx;
  }
  return out;
}

/** Writes RGBA pixels for a single-channel plane into `rgba` (length 4*n). */
export function renderGray(plane: PixelArray, min: number, max: number, lut: Lut, rgba: Uint8ClampedArray): void {
  const idx = toDisplayIndices(plane, min, max);
  for (let i = 0, j = 0; i < idx.length; i++, j += 4) {
    const k = idx[i];
    rgba[j] = lut.r[k];
    rgba[j + 1] = lut.g[k];
    rgba[j + 2] = lut.b[k];
    rgba[j + 3] = 255;
  }
}

/**
 * A label image (one integer id per object, 0 = background) in distinct
 * colours: each id gets its own hue, so neighbouring objects stand apart.
 */
export function renderLabels(plane: PixelArray, rgba: Uint8ClampedArray): void {
  for (let i = 0, j = 0; i < plane.length; i++, j += 4) {
    const id = Math.round(plane[i]);
    if (id <= 0) {
      rgba[j] = rgba[j + 1] = rgba[j + 2] = 0;
    } else {
      // golden-ratio hues, so consecutive ids are far apart on the colour wheel
      const h = (id * 0.618033988749895) % 1;
      const [r, g, b] = hsv(h, 0.65, 0.95);
      rgba[j] = r;
      rgba[j + 1] = g;
      rgba[j + 2] = b;
    }
    rgba[j + 3] = 255;
  }
}

function hsv(h: number, s: number, v: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h * 6) % 6;
    return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return [f(5), f(3), f(1)];
}

/** Composites channels additively (each with its own LUT and range) into `rgba`. */
export function renderComposite(
  planes: readonly PixelArray[],
  ranges: readonly [number, number][],
  luts: readonly Lut[],
  rgba: Uint8ClampedArray,
): void {
  rgba.fill(0);
  planes.forEach((plane, c) => {
    const idx = toDisplayIndices(plane, ranges[c][0], ranges[c][1]);
    const lut = luts[c];
    for (let i = 0, j = 0; i < idx.length; i++, j += 4) {
      const k = idx[i];
      rgba[j] = Math.min(255, rgba[j] + lut.r[k]);
      rgba[j + 1] = Math.min(255, rgba[j + 1] + lut.g[k]);
      rgba[j + 2] = Math.min(255, rgba[j + 2] + lut.b[k]);
    }
  });
  for (let j = 3; j < rgba.length; j += 4) rgba[j] = 255;
}

/**
 * Auto contrast in the spirit of ImageJ's "Auto" button: saturate `saturated`
 * percent of pixels (split between both ends) using a 256-bin histogram.
 */
export function autoContrast(plane: PixelArray, saturated = 0.35): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < plane.length; i++) {
    const v = plane[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!(hi > lo)) return [lo, hi];
  const bins = 256;
  const hist = new Uint32Array(bins);
  const scale = bins / (hi - lo);
  for (let i = 0; i < plane.length; i++) {
    const v = plane[i];
    if (v === v) hist[Math.min(bins - 1, Math.floor((v - lo) * scale))]++;
  }
  const threshold = (plane.length * saturated) / 200;
  let acc = 0;
  let a = 0;
  while (a < bins - 1 && acc + hist[a] <= threshold) acc += hist[a++];
  acc = 0;
  let b = bins - 1;
  while (b > a && acc + hist[b] <= threshold) acc += hist[b--];
  return [lo + a / scale, lo + (b + 1) / scale];
}
