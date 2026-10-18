/** Pixel storage types. RGB images are stored as three uint8 channels. */
export type DType = "uint8" | "uint16" | "float32";

export type PixelArray = Uint8Array | Uint16Array | Float32Array;

/** Image dimensions in ImageJ's XYCZT order. */
export interface Shape {
  readonly width: number;
  readonly height: number;
  readonly channels: number;
  readonly slices: number;
  readonly frames: number;
}

/** Physical size of one pixel/voxel and the frame interval. */
export interface Calibration {
  pixelWidth: number;
  pixelHeight: number;
  pixelDepth: number;
  unit: string;
  frameInterval: number;
  timeUnit: string;
}

export const DEFAULT_CALIBRATION: Readonly<Calibration> = Object.freeze({
  pixelWidth: 1,
  pixelHeight: 1,
  pixelDepth: 1,
  unit: "pixel",
  frameInterval: 0,
  timeUnit: "sec",
});

/**
 * An n-dimensional image: a stack of 2D planes, each one typed array of
 * `width * height` pixels in row-major order. Planes are ordered with the
 * channel varying fastest, then slice, then frame (ImageJ hyperstack order).
 *
 * Images are values: operations return new images and never mutate inputs.
 */
export interface Image {
  readonly dtype: DType;
  readonly shape: Shape;
  readonly planes: readonly PixelArray[];
  readonly calibration: Readonly<Calibration>;
  readonly name?: string;
}

export interface CreateImageOptions {
  dtype: DType;
  width: number;
  height: number;
  channels?: number;
  slices?: number;
  frames?: number;
  calibration?: Partial<Calibration>;
  name?: string;
  /** Plane data. Omit for a zero-filled image. */
  planes?: PixelArray[];
}

export function bytesPerPixel(dtype: DType): number {
  return dtype === "uint8" ? 1 : dtype === "uint16" ? 2 : 4;
}

export function allocPlane(dtype: DType, length: number): PixelArray {
  switch (dtype) {
    case "uint8":
      return new Uint8Array(length);
    case "uint16":
      return new Uint16Array(length);
    case "float32":
      return new Float32Array(length);
  }
}

export function dtypeOf(plane: PixelArray): DType {
  if (plane instanceof Uint8Array) return "uint8";
  if (plane instanceof Uint16Array) return "uint16";
  return "float32";
}

export function planeCount(shape: Shape): number {
  return shape.channels * shape.slices * shape.frames;
}

export function createImage(opts: CreateImageOptions): Image {
  const { dtype, width, height } = opts;
  const shape: Shape = {
    width,
    height,
    channels: opts.channels ?? 1,
    slices: opts.slices ?? 1,
    frames: opts.frames ?? 1,
  };
  for (const [k, v] of Object.entries(shape)) {
    if (!Number.isInteger(v) || v < 1) throw new RangeError(`${k} must be a positive integer, got ${v}`);
  }
  const n = planeCount(shape);
  const size = width * height;
  const planes = opts.planes ?? Array.from({ length: n }, () => allocPlane(dtype, size));
  if (planes.length !== n) throw new RangeError(`expected ${n} planes, got ${planes.length}`);
  for (const p of planes) {
    if (p.length !== size) throw new RangeError(`plane has ${p.length} pixels, expected ${size}`);
    if (dtypeOf(p) !== dtype) throw new TypeError(`plane is ${dtypeOf(p)}, expected ${dtype}`);
  }
  return {
    dtype,
    shape,
    planes,
    calibration: { ...DEFAULT_CALIBRATION, ...opts.calibration },
    name: opts.name,
  };
}

/** Index into `planes` for 0-based channel, slice and frame. */
export function planeIndex(shape: Shape, c = 0, z = 0, t = 0): number {
  if (c < 0 || c >= shape.channels || z < 0 || z >= shape.slices || t < 0 || t >= shape.frames) {
    throw new RangeError(`plane (c=${c}, z=${z}, t=${t}) out of range`);
  }
  return c + shape.channels * (z + shape.slices * t);
}

export function getPlane(img: Image, c = 0, z = 0, t = 0): PixelArray {
  return img.planes[planeIndex(img.shape, c, z, t)];
}

/** Returns a copy of `img` with each plane replaced by `fn(plane, index)`. */
export function mapPlanes(img: Image, fn: (plane: PixelArray, index: number) => PixelArray): Image {
  const planes = img.planes.map(fn);
  const dtype = planes.length ? dtypeOf(planes[0]) : img.dtype;
  return { ...img, dtype, planes };
}

/** Largest value storable in `dtype` (Infinity for float). */
export function maxValue(dtype: DType): number {
  return dtype === "uint8" ? 255 : dtype === "uint16" ? 65535 : Infinity;
}
