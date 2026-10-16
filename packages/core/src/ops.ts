/**
 * Image operations. Each returns a new image; inputs are never mutated.
 * Semantics follow ImageJ 1.x.
 */
import { type Image, type PixelArray, allocPlane, dtypeOf, mapPlanes } from "./image.js";
import type { Kernels } from "./kernels.js";

export interface Stats {
  count: number;
  min: number;
  max: number;
  mean: number;
  /** Sample standard deviation (n-1), as ImageJ reports it. */
  stdDev: number;
}

export function planeStats(plane: PixelArray): Stats {
  const n = plane.length;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let sum2 = 0;
  for (let i = 0; i < n; i++) {
    const v = plane[i];
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    sum2 += v * v;
  }
  const mean = n ? sum / n : NaN;
  const variance = n > 1 ? (n * sum2 - sum * sum) / n / (n - 1) : 0;
  return { count: n, min, max, mean, stdDev: Math.sqrt(Math.max(0, variance)) };
}

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

/** Histogram with `bins` equal-width bins over [lo, hi]. */
export function histogram(plane: PixelArray, bins = 256, lo?: number, hi?: number): Uint32Array {
  const [mn, mx] = lo === undefined || hi === undefined ? minMax(plane) : [lo, hi];
  const h = new Uint32Array(bins);
  const scale = mx > mn ? bins / (mx - mn) : 0;
  for (let i = 0; i < plane.length; i++) {
    const v = plane[i];
    if (!(v >= mn && v <= mx)) continue;
    h[Math.min(bins - 1, Math.floor((v - mn) * scale))]++;
  }
  return h;
}

/** Converts a plane to float32 (a copy for float input). */
export function toFloat(plane: PixelArray): Float32Array {
  return plane instanceof Float32Array ? plane.slice() : Float32Array.from(plane);
}

/** Converts float results back to `like`'s type: ImageJ rounds (+0.5, truncate) and clamps. */
export function fromFloat(values: Float32Array, dtype: ReturnType<typeof dtypeOf>): PixelArray {
  if (dtype === "float32") return values;
  const max = dtype === "uint8" ? 255 : 65535;
  const out = allocPlane(dtype, values.length);
  for (let i = 0; i < values.length; i++) {
    let v = Math.fround(values[i] + 0.5);
    if (v < 0) v = 0;
    if (v > max) v = max;
    out[i] = Math.trunc(v);
  }
  return out;
}

/**
 * Edit > Invert, per plane. 8-bit: 255 - v. 16-bit and float: max - (v - min)
 * over the plane's data range (ImageJ's default, without full-range 16-bit inversion).
 */
export function invert(img: Image): Image {
  return mapPlanes(img, (plane) => {
    if (plane instanceof Uint8Array) return plane.map((v) => 255 - v);
    const [min, max] = minMax(plane);
    if (plane instanceof Uint16Array) return plane.map((v) => max - (v - min));
    const fmin = Math.fround(min);
    const fmax = Math.fround(max);
    return plane.map((v) => Math.fround(fmax - Math.fround(v - fmin)));
  });
}

export interface GaussianOptions {
  sigmaX: number;
  sigmaY?: number;
  /** Kernel accuracy; defaults to ImageJ's 0.002 for 8-bit and 0.0002 otherwise. */
  accuracy?: number;
}

/** Process > Filters > Gaussian Blur, per plane (ImageJ algorithm, via the wasm kernels). */
export function gaussianBlur(kernels: Kernels, img: Image, opts: GaussianOptions): Image {
  const sigmaX = opts.sigmaX;
  const sigmaY = opts.sigmaY ?? opts.sigmaX;
  if (!(sigmaX >= 0) || !(sigmaY >= 0)) throw new RangeError("sigma must be >= 0");
  const accuracy = opts.accuracy ?? (img.dtype === "uint8" ? 0.002 : 0.0002);
  const { width, height } = img.shape;
  return mapPlanes(img, (plane) => {
    const blurred = kernels.gaussianBlurF32(toFloat(plane), width, height, sigmaX, sigmaY, accuracy);
    return fromFloat(blurred, dtypeOf(plane));
  });
}

/** Image > Transform > Flip Horizontally, per plane. */
export function flipHorizontal(img: Image): Image {
  const { width, height } = img.shape;
  return mapPlanes(img, (plane) => {
    const out = allocPlane(dtypeOf(plane), plane.length);
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) out[row + x] = plane[row + width - 1 - x];
    }
    return out;
  });
}

/** Image > Transform > Flip Vertically, per plane. */
export function flipVertical(img: Image): Image {
  const { width, height } = img.shape;
  return mapPlanes(img, (plane) => {
    const out = allocPlane(dtypeOf(plane), plane.length);
    for (let y = 0; y < height; y++) out.set(plane.subarray((height - 1 - y) * width, (height - y) * width), y * width);
    return out;
  });
}

/**
 * Image > Transform > Rotate 90 Degrees Right (clockwise) or Left. Width and
 * height swap, and so do the pixel width and height, as in ImageJ.
 */
export function rotate90(img: Image, direction: "right" | "left"): Image {
  const { width, height } = img.shape;
  const rotated = mapPlanes(img, (plane) => {
    const out = allocPlane(dtypeOf(plane), plane.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        // new image is height wide; right: (x, y) -> (height-1-y, x); left: (x, y) -> (y, width-1-x)
        const i = direction === "right" ? x * height + (height - 1 - y) : (width - 1 - x) * height + y;
        out[i] = plane[y * width + x];
      }
    }
    return out;
  });
  const cal = img.calibration;
  return {
    ...rotated,
    shape: { ...img.shape, width: height, height: width },
    calibration: { ...cal, pixelWidth: cal.pixelHeight, pixelHeight: cal.pixelWidth },
  };
}
