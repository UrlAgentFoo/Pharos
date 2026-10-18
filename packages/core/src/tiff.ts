/**
 * TIFF I/O. Reading uses geotiff (handles compression, tiling, both byte
 * orders). Writing produces uncompressed little-endian TIFF with an ImageJ
 * ImageDescription, so stacks, hyperstacks and calibration round-trip
 * through ImageJ 1.x.
 */
import { fromArrayBuffer } from "geotiff";
import { type Calibration, type DType, type Image, type PixelArray, bytesPerPixel, createImage, planeCount } from "./image.js";

const SAMPLE_UINT = 1;
const SAMPLE_INT = 2;
const SAMPLE_FLOAT = 3;

/** Parses ImageJ's `key=value` ImageDescription, or returns null if it is not one. */
export function parseImageJDescription(desc: string | undefined): Record<string, string> | null {
  if (!desc || !desc.startsWith("ImageJ=")) return null;
  const out: Record<string, string> = {};
  for (const line of desc.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

function dtypeFor(bits: number, format: number): DType {
  if (bits === 8 && format !== SAMPLE_FLOAT) return "uint8";
  if (bits === 16 && format !== SAMPLE_FLOAT) {
    if (format === SAMPLE_INT) throw new Error("signed 16-bit TIFF is not supported yet");
    return "uint16";
  }
  if (bits === 32 && format === SAMPLE_FLOAT) return "float32";
  throw new Error(`unsupported TIFF sample type: ${bits}-bit, SampleFormat=${format}`);
}

function rationalToNumber(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (Array.isArray(v) || ArrayBuffer.isView(v)) {
    const a = Array.from(v as ArrayLike<number>);
    if (a.length >= 2 && a[1]) return a[0] / a[1];
    if (a.length === 1) return a[0];
  }
  return undefined;
}

export async function readTiff(data: ArrayBuffer | Uint8Array, name?: string): Promise<Image> {
  const buf =
    data instanceof Uint8Array ? (data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer) : data;
  const tiff = await fromArrayBuffer(buf);
  const count = await tiff.getImageCount();
  const first = await tiff.getImage(0);
  const width = first.getWidth();
  const height = first.getHeight();
  const samples = first.getSamplesPerPixel();
  const dtype = dtypeFor(first.getBitsPerSample(0), first.getSampleFormat(0) ?? SAMPLE_UINT);
  if (samples !== 1 && !(samples === 3 && dtype === "uint8")) {
    throw new Error(`unsupported TIFF: ${samples} samples per pixel of ${dtype}`);
  }

  const ij = parseImageJDescription(await first.fileDirectory.loadValue("ImageDescription"));
  // ImageJ may write a single IFD followed by contiguous planes ("images=N"); geotiff
  // only sees the IFDs, so read the remaining planes by offset in that case.
  const declared = ij?.images ? parseInt(ij.images, 10) : count;

  const planes: PixelArray[] = [];
  for (let i = 0; i < count; i++) {
    const img = i === 0 ? first : await tiff.getImage(i);
    if (img.getWidth() !== width || img.getHeight() !== height) break; // e.g. a thumbnail IFD
    const rasters = await img.readRasters({ interleave: false });
    for (let s = 0; s < samples; s++) planes.push(rasters[s] as PixelArray);
  }
  if (samples === 1 && declared > planes.length) {
    planes.push(...(await readContiguousPlanes(buf, first, declared - planes.length, dtype, width, height)));
  }

  let channels = samples;
  let slices = planes.length / samples;
  let frames = 1;
  if (ij && samples === 1) {
    const c = parseInt(ij.channels ?? "1", 10);
    const z = parseInt(ij.slices ?? "1", 10);
    const t = parseInt(ij.frames ?? "1", 10);
    if (c * z * t === planes.length) [channels, slices, frames] = [c, z, t];
  }

  const calibration: Partial<Calibration> = {};
  const xres = rationalToNumber(await first.fileDirectory.loadValue("XResolution"));
  const yres = rationalToNumber(await first.fileDirectory.loadValue("YResolution"));
  if (ij) {
    if (xres) calibration.pixelWidth = 1 / xres;
    if (yres) calibration.pixelHeight = 1 / yres;
    if (ij.unit) calibration.unit = ij.unit === "micron" ? "µm" : ij.unit;
    if (ij.spacing) calibration.pixelDepth = parseFloat(ij.spacing);
    if (ij.finterval) calibration.frameInterval = parseFloat(ij.finterval);
  }
  return createImage({ dtype, width, height, channels, slices, frames, planes: planes.slice(0, channels * slices * frames), calibration, name });
}

async function readContiguousPlanes(
  buf: ArrayBuffer,
  first: Awaited<ReturnType<Awaited<ReturnType<typeof fromArrayBuffer>>["getImage"]>>,
  extra: number,
  dtype: DType,
  width: number,
  height: number,
): Promise<PixelArray[]> {
  const offsets = (await first.fileDirectory.loadValue("StripOffsets")) as ArrayLike<number> | number;
  const compression = (await first.fileDirectory.loadValue("Compression")) ?? 1;
  if (compression !== 1) return [];
  const start = typeof offsets === "number" ? offsets : offsets[0];
  const planeBytes = width * height * bytesPerPixel(dtype);
  const view = new DataView(buf);
  const little = first.littleEndian;
  const out: PixelArray[] = [];
  for (let p = 1; p <= extra; p++) {
    const base = start + p * planeBytes;
    if (base + planeBytes > buf.byteLength) break;
    const n = width * height;
    if (dtype === "uint8") out.push(new Uint8Array(buf.slice(base, base + n)));
    else if (dtype === "uint16") {
      const a = new Uint16Array(n);
      for (let i = 0; i < n; i++) a[i] = view.getUint16(base + 2 * i, little);
      out.push(a);
    } else {
      const a = new Float32Array(n);
      for (let i = 0; i < n; i++) a[i] = view.getFloat32(base + 4 * i, little);
      out.push(a);
    }
  }
  return out;
}

// ---------------------------------------------------------------- writing

const T_SHORT = 3;
const T_LONG = 4;
const T_RATIONAL = 5;
const T_ASCII = 2;

interface Entry {
  tag: number;
  type: number;
  values: number[] | string;
}

function imagejDescription(img: Image): string {
  const { channels, slices, frames } = img.shape;
  const n = planeCount(img.shape);
  const lines = ["ImageJ=1.54u", `images=${n}`];
  if (channels > 1) lines.push(`channels=${channels}`);
  if (slices > 1) lines.push(`slices=${slices}`);
  if (frames > 1) lines.push(`frames=${frames}`);
  if (channels > 1 || (slices > 1 && frames > 1)) lines.push("hyperstack=true");
  const cal = img.calibration;
  if (cal.unit && cal.unit !== "pixel") lines.push(`unit=${cal.unit === "µm" ? "micron" : cal.unit}`);
  if (slices > 1 && cal.pixelDepth !== 1) lines.push(`spacing=${cal.pixelDepth}`);
  if (frames > 1 && cal.frameInterval) lines.push(`finterval=${cal.frameInterval}`);
  return lines.join("\n") + "\n\0";
}

function toRational(v: number): [number, number] {
  const den = 1_000_000;
  return [Math.round(v * den), den];
}

/** Encodes `img` as an uncompressed little-endian TIFF, one IFD per plane. */
export function writeTiff(img: Image): Uint8Array {
  const { width, height } = img.shape;
  const bpp = bytesPerPixel(img.dtype);
  const planeBytes = width * height * bpp;
  const n = img.planes.length;
  const desc = imagejDescription(img);
  const descBytes = new TextEncoder().encode(desc);
  const cal = img.calibration;
  const calibrated = cal.unit !== "pixel" || cal.pixelWidth !== 1 || cal.pixelHeight !== 1;

  const header = 8;
  const pixelStart = header;
  const pixelEnd = pixelStart + n * planeBytes;
  let cursor = pixelEnd + (pixelEnd % 2); // IFDs start on a word boundary
  const descOffset = cursor;
  cursor += descBytes.length + (descBytes.length % 2);
  const resOffset = cursor;
  cursor += calibrated ? 16 : 0;

  const entriesFor = (i: number): Entry[] => {
    const e: Entry[] = [
      { tag: 254, type: T_LONG, values: [0] },
      { tag: 256, type: T_LONG, values: [width] },
      { tag: 257, type: T_LONG, values: [height] },
      { tag: 258, type: T_SHORT, values: [bpp * 8] },
      { tag: 259, type: T_SHORT, values: [1] },
      { tag: 262, type: T_SHORT, values: [1] },
    ];
    if (i === 0) e.push({ tag: 270, type: T_ASCII, values: desc });
    e.push(
      { tag: 273, type: T_LONG, values: [pixelStart + i * planeBytes] },
      { tag: 277, type: T_SHORT, values: [1] },
      { tag: 278, type: T_LONG, values: [height] },
      { tag: 279, type: T_LONG, values: [planeBytes] },
    );
    if (calibrated) {
      e.push({ tag: 282, type: T_RATIONAL, values: [] }, { tag: 283, type: T_RATIONAL, values: [] }, { tag: 296, type: T_SHORT, values: [1] });
    }
    e.push({ tag: 339, type: T_SHORT, values: [img.dtype === "float32" ? SAMPLE_FLOAT : SAMPLE_UINT] });
    return e;
  };

  const ifdSize = (i: number) => 2 + entriesFor(i).length * 12 + 4;
  const ifdOffsets: number[] = [];
  for (let i = 0; i < n; i++) {
    ifdOffsets.push(cursor);
    cursor += ifdSize(i);
  }

  const out = new Uint8Array(cursor);
  const dv = new DataView(out.buffer);
  out.set([0x49, 0x49], 0); // "II"
  dv.setUint16(2, 42, true);
  dv.setUint32(4, ifdOffsets[0], true);

  for (let i = 0; i < n; i++) {
    const plane = img.planes[i];
    const base = pixelStart + i * planeBytes;
    if (plane instanceof Uint8Array) out.set(plane, base);
    else if (plane instanceof Uint16Array) for (let j = 0; j < plane.length; j++) dv.setUint16(base + 2 * j, plane[j], true);
    else for (let j = 0; j < plane.length; j++) dv.setFloat32(base + 4 * j, plane[j], true);
  }
  out.set(descBytes, descOffset);
  if (calibrated) {
    const [xn, xd] = toRational(1 / cal.pixelWidth);
    const [yn, yd] = toRational(1 / cal.pixelHeight);
    dv.setUint32(resOffset, xn, true);
    dv.setUint32(resOffset + 4, xd, true);
    dv.setUint32(resOffset + 8, yn, true);
    dv.setUint32(resOffset + 12, yd, true);
  }

  for (let i = 0; i < n; i++) {
    const entries = entriesFor(i);
    let p = ifdOffsets[i];
    dv.setUint16(p, entries.length, true);
    p += 2;
    for (const e of entries) {
      dv.setUint16(p, e.tag, true);
      dv.setUint16(p + 2, e.type, true);
      if (e.type === T_ASCII) {
        dv.setUint32(p + 4, descBytes.length, true);
        dv.setUint32(p + 8, descOffset, true);
      } else if (e.type === T_RATIONAL) {
        dv.setUint32(p + 4, 1, true);
        dv.setUint32(p + 8, resOffset + (e.tag === 282 ? 0 : 8), true);
      } else {
        const v = (e.values as number[])[0];
        dv.setUint32(p + 4, 1, true);
        if (e.type === T_SHORT) dv.setUint16(p + 8, v, true);
        else dv.setUint32(p + 8, v, true);
      }
      p += 12;
    }
    dv.setUint32(p, i + 1 < n ? ifdOffsets[i + 1] : 0, true);
  }
  return out;
}
