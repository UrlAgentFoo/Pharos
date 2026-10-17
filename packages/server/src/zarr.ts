/**
 * Zarr, read straight from its files for window previews, as other tools
 * write it: Zarr format 2 or 3; uncompressed, Blosc (blosclz, LZ4, zlib,
 * zstd; byte or bit shuffled), gzip, zlib, zstd or LZ4; Zarr 3 sharded or
 * not. The image is found where it is: OME-Zarr's multiscales (at the top,
 * or in 0/ as bioformats2raw writes it), else a plain array (or a group's
 * largest), whose axes come from its dimension names or a guess. Of a
 * pyramid, the first level small enough to preview is read.
 */
import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { gunzipSync, inflateSync, zstdDecompressSync } from "node:zlib";
import { type DType, type Image, type PixelArray, createImage } from "@pharos/core";
import { blosc } from "./blosc.js";
import { numcodecsLz4 } from "./lz4.js";

/** Why a store can't be previewed: 415 for what isn't read here, 413 for what's too large. */
export class ZarrError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Json = Record<string, unknown>;
const json = (path: string): Promise<Json | null> => readFile(path, "utf8").then((t) => JSON.parse(t) as Json, () => null);

/** Axis names other tools give plain arrays (xarray's _ARRAY_DIMENSIONS, Zarr 3's dimension_names). */
const DIM_NAMES: Record<string, string> = { t: "t", time: "t", frame: "t", frames: "t", c: "c", ch: "c", channel: "c", channels: "c", z: "z", depth: "z", y: "y", x: "x" };

interface Found {
  /** One letter per array axis, in the array's order. */
  axes: string;
  levels: { dir: string; scale?: number[] }[];
  unit?: string;
}

// ------------------------------------------------------------ finding the image

/** Attributes, Zarr 2 (.zattrs) or 3 (zarr.json's attributes, OME under "ome"). */
async function attributes(dir: string): Promise<Json | null> {
  const v3 = await json(join(dir, "zarr.json"));
  if (v3) {
    const a = (v3.attributes ?? {}) as Json;
    return ((a.ome as Json | undefined) ?? a) as Json;
  }
  return json(join(dir, ".zattrs"));
}

async function isArray(dir: string): Promise<boolean> {
  const v3 = await json(join(dir, "zarr.json"));
  return v3 ? v3.node_type === "array" : !!(await json(join(dir, ".zarray")));
}

function omeFound(dir: string, attrs: Json): Found | null {
  const ms = (attrs.multiscales as { axes?: (string | { name: string; unit?: string })[]; datasets: { path: string; coordinateTransformations?: { type: string; scale?: number[] }[] }[] }[] | undefined)?.[0];
  if (!ms?.datasets?.length) return null;
  const axes = (ms.axes ?? ["t", "c", "z", "y", "x"]).map((a) => (typeof a === "string" ? a : a.name).toLowerCase()).join("");
  const x = ms.axes?.find((a): a is { name: string; unit?: string } => typeof a !== "string" && a.name.toLowerCase() === "x");
  return { axes, levels: ms.datasets.map((d) => ({ dir: join(dir, d.path), scale: d.coordinateTransformations?.find((c) => c.type === "scale")?.scale })), ...(x?.unit ? { unit: x.unit } : {}) };
}

async function plainFound(dir: string, storeName: string): Promise<Found> {
  const v3 = await json(join(dir, "zarr.json"));
  const meta = v3 ?? (await json(join(dir, ".zarray")))!;
  const shape = (meta.shape as number[]) ?? [];
  const dims = (v3 ? meta.dimension_names : (await json(join(dir, ".zattrs")))?._ARRAY_DIMENSIONS) as (string | null)[] | undefined;
  let axes = Array.isArray(dims) && dims.length === shape.length && dims.every((d) => typeof d === "string" && DIM_NAMES[d.toLowerCase()]) ? dims.map((d) => DIM_NAMES[d!.toLowerCase()]).join("") : "";
  // nothing named: a movie when its name says so, else a stack; that's all the window needs to page through it
  if (!axes) axes = { 2: "yx", 3: /time|movie|lapse|track|frame|video/i.test(storeName) ? "tyx" : "zyx", 4: "tzyx", 5: "tczyx" }[shape.length] ?? "";
  if (!axes) throw new ZarrError(415, `can't tell the axes of this ${shape.length}-dimensional array`);
  return { axes, levels: [{ dir }] };
}

async function find(dir: string): Promise<Found> {
  const attrs = await attributes(dir);
  const ome = attrs && omeFound(dir, attrs);
  if (ome) return ome;
  if (await isArray(dir)) return plainFound(dir, basename(dir));
  // bioformats2raw keeps each image in a numbered group, with OME metadata of its own
  const inner = await attributes(join(dir, "0"));
  const innerOme = inner && omeFound(join(dir, "0"), inner);
  if (innerOme) return innerOme;
  // a group of arrays without OME metadata: its largest
  let best: { dir: string; size: number } | null = null;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory() || !(await isArray(join(dir, e.name)))) continue;
    const meta = (await json(join(dir, e.name, "zarr.json"))) ?? (await json(join(dir, e.name, ".zarray")));
    const size = ((meta?.shape as number[]) ?? []).reduce((a, b) => a * b, 1);
    if (!best || size > best.size) best = { dir: join(dir, e.name), size };
  }
  if (best) return plainFound(best.dir, basename(dir));
  throw new ZarrError(415, "no image in this Zarr store (no OME metadata and no arrays)");
}

// ------------------------------------------------------------ reading an array

interface ElementType {
  size: number;
  read(view: DataView, at: number): number;
  viewer: DType;
}

function elementType(kind: string, bits: number, little: boolean): ElementType | null {
  const size = bits / 8;
  const viewer: DType = kind === "u" && bits === 8 ? "uint8" : kind === "u" && bits === 16 ? "uint16" : "float32";
  const read: Record<string, (v: DataView, at: number) => number> = {
    u8: (v, at) => v.getUint8(at),
    i8: (v, at) => v.getInt8(at),
    u16: (v, at) => v.getUint16(at, little),
    i16: (v, at) => v.getInt16(at, little),
    u32: (v, at) => v.getUint32(at, little),
    i32: (v, at) => v.getInt32(at, little),
    f32: (v, at) => v.getFloat32(at, little),
    f64: (v, at) => v.getFloat64(at, little),
  };
  const r = read[`${kind}${bits}`];
  return r ? { size, read: r, viewer } : null;
}

/** "<u2" (Zarr 2) or "uint16" (Zarr 3, its endianness from the bytes codec) as an element type. */
function dtypeOf(dtype: string, little = true): ElementType {
  const v2 = /^([<>|])([uif])(\d)$/.exec(dtype);
  const v3 = /^(u?int|float)(8|16|32|64)$/.exec(dtype);
  const t = v2 ? elementType(v2[2], Number(v2[3]) * 8, v2[1] !== ">") : v3 ? elementType(v3[1] === "uint" ? "u" : v3[1] === "int" ? "i" : "f", Number(v3[2]), little) : null;
  if (!t) throw new ZarrError(415, `unsupported data type ${dtype}`);
  return t;
}

type Decode = (raw: Buffer) => Buffer;

/** Zarr 2's compressor, by its numcodecs id. */
function v2Decode(compressor: { id: string } | null): Decode {
  if (!compressor) return (b) => b;
  const id = compressor.id;
  if (id === "blosc") return blosc;
  if (id === "zstd") return (b) => zstdDecompressSync(b);
  if (id === "gzip") return (b) => gunzipSync(b);
  if (id === "zlib") return (b) => inflateSync(b);
  if (id === "lz4") return numcodecsLz4;
  throw new ZarrError(415, `this Zarr is ${id}-compressed, which previews don't read yet`);
}

/** Zarr 3's bytes-to-bytes codecs, applied in reverse order to decode. */
function v3Decode(codecs: { name: string }[]): Decode {
  const steps: Decode[] = codecs.map((c) => {
    if (c.name === "zstd") return (b) => zstdDecompressSync(b);
    if (c.name === "gzip") return (b) => gunzipSync(b);
    if (c.name === "blosc") return blosc;
    if (c.name === "crc32c") return (b) => b.subarray(0, b.length - 4); // a checksum on the end, not checked here
    throw new ZarrError(415, `Zarr 3's ${c.name} codec isn't read by previews yet`);
  });
  return (b) => steps.reduceRight((acc, step) => step(acc), b);
}

/** An array's metadata, and a reader for its chunks (each one whole, C-ordered, decoded; null when missing). */
interface ArrayReader {
  shape: number[];
  chunks: number[];
  type: ElementType;
  fill: number;
  chunk(index: number[]): Promise<Buffer | null>;
}

const fillValue = (v: unknown) => (typeof v === "number" ? v : v === "NaN" ? Number.NaN : 0);

async function openArray(dir: string): Promise<ArrayReader> {
  const v3 = await json(join(dir, "zarr.json"));
  if (!v3) {
    const meta = await json(join(dir, ".zarray"));
    if (!meta) throw new ZarrError(415, `no array in ${basename(dir)}`);
    if ((meta.order ?? "C") !== "C") throw new ZarrError(415, "only C-ordered Zarr arrays can be previewed");
    if (Array.isArray(meta.filters) && meta.filters.length) throw new ZarrError(415, "Zarr filters aren't read by previews yet");
    const sep = (meta.dimension_separator as string | undefined) ?? ".";
    const decode = v2Decode(meta.compressor as { id: string } | null);
    return {
      shape: meta.shape as number[],
      chunks: meta.chunks as number[],
      type: dtypeOf(meta.dtype as string),
      fill: fillValue(meta.fill_value),
      chunk: async (index) => {
        const raw = await readFile(join(dir, index.join(sep))).catch(() => null);
        return raw && decode(raw);
      },
    };
  }
  const shape = v3.shape as number[];
  const grid = (v3.chunk_grid as { configuration: { chunk_shape: number[] } }).configuration.chunk_shape;
  const keys = v3.chunk_key_encoding as { name: string; configuration?: { separator?: string } } | undefined;
  const key = (index: number[]) =>
    keys?.name === "v2" ? (index.length ? index : [0]).join(keys.configuration?.separator ?? ".") : ["c", ...index].join(keys?.configuration?.separator ?? "/");
  const codecs = v3.codecs as { name: string; configuration?: Json }[];
  if (codecs.some((c) => c.name === "transpose")) throw new ZarrError(415, "transposed Zarr arrays aren't read by previews yet");
  const sharding = codecs.find((c) => c.name === "sharding_indexed");
  const endian = (list: { name: string; configuration?: Json }[]) => (list.find((c) => c.name === "bytes")?.configuration?.endian ?? "little") !== "big";
  if (!sharding) {
    const decode = v3Decode(codecs.filter((c) => c.name !== "bytes"));
    return {
      shape,
      chunks: grid,
      type: dtypeOf(v3.data_type as string, endian(codecs)),
      fill: fillValue(v3.fill_value),
      chunk: async (index) => {
        const raw = await readFile(join(dir, key(index))).catch(() => null);
        return raw && decode(raw);
      },
    };
  }
  // sharded: each file holds a grid of inner chunks, and an index of where each one is
  const conf = sharding.configuration as { chunk_shape: number[]; codecs: { name: string; configuration?: Json }[]; index_codecs?: { name: string }[]; index_location?: string };
  const inner = conf.chunk_shape;
  const per = grid.map((n, i) => n / inner[i]);
  const count = per.reduce((a, b) => a * b, 1);
  const indexBytes = count * 16 + ((conf.index_codecs ?? []).some((c) => c.name === "crc32c") ? 4 : 0);
  const decode = v3Decode(conf.codecs.filter((c) => c.name !== "bytes"));
  const shards = new Map<string, Promise<Buffer | null>>();
  return {
    shape,
    chunks: inner,
    type: dtypeOf(v3.data_type as string, endian(conf.codecs)),
    fill: fillValue(v3.fill_value),
    chunk: async (index) => {
      const shardIndex = index.map((n, i) => Math.floor(n / per[i]));
      const k = key(shardIndex);
      if (!shards.has(k)) shards.set(k, readFile(join(dir, k)).catch(() => null));
      const shard = await shards.get(k)!;
      if (!shard) return null;
      const at = index.reduce((acc, n, i) => acc * per[i] + (n % per[i]), 0);
      const table = conf.index_location === "start" ? shard.subarray(0, indexBytes) : shard.subarray(shard.length - indexBytes);
      const offset = table.readBigUInt64LE(at * 16);
      const nbytes = table.readBigUInt64LE(at * 16 + 8);
      if (offset === 0xffffffffffffffffn && nbytes === 0xffffffffffffffffn) return null;
      return decode(shard.subarray(Number(offset), Number(offset + nbytes)));
    },
  };
}

/** Every value of the array, C-ordered, as numbers. */
async function readValues(a: ArrayReader): Promise<Float64Array> {
  const { shape, chunks, type } = a;
  const total = shape.reduce((x, y) => x * y, 1);
  const values = new Float64Array(total).fill(a.fill);
  const grid = shape.map((n, i) => Math.ceil(n / chunks[i]));
  const strides = shape.map((_, i) => shape.slice(i + 1).reduce((x, y) => x * y, 1));
  const chunkStrides = chunks.map((_, i) => chunks.slice(i + 1).reduce((x, y) => x * y, 1));
  const count = chunks.reduce((x, y) => x * y, 1);
  const index = new Array<number>(shape.length).fill(0);
  if (!total) return values;
  for (;;) {
    const buf = await a.chunk(index);
    if (buf) {
      if (buf.length < count * type.size) throw new ZarrError(415, `a chunk of this Zarr is ${buf.length} bytes, not the ${count * type.size} its shape needs`);
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      for (let k = 0; k < count; k++) {
        let at = 0;
        let inside = true;
        for (let d = 0; d < shape.length; d++) {
          const pos = index[d] * chunks[d] + (Math.floor(k / chunkStrides[d]) % chunks[d]);
          if (pos >= shape[d]) {
            inside = false;
            break;
          }
          at += pos * strides[d];
        }
        if (inside) values[at] = type.read(view, k * type.size);
      }
    }
    let d = shape.length - 1;
    while (d >= 0 && ++index[d] >= grid[d]) index[d--] = 0;
    if (d < 0) break;
  }
  return values;
}

// ------------------------------------------------------------ the image

/** The image in a Zarr store, at the first level of its pyramid that fits in `maxBytes`. */
export async function readZarrImage(dir: string, name?: string, maxBytes = 1024 ** 3): Promise<Image> {
  const found = await find(dir);
  const axes = found.axes;
  if (new Set(axes).size !== axes.length || [...axes].some((a) => !"tczyx".includes(a))) throw new ZarrError(415, `can't preview axes ${axes}`);
  let picked: { reader: ArrayReader; scale?: number[] } | null = null;
  for (const level of found.levels) {
    const reader = await openArray(level.dir);
    if (reader.shape.length !== axes.length) throw new ZarrError(415, `the array has ${reader.shape.length} axes but its metadata names ${axes.length}`);
    if (reader.shape.reduce((x, y) => x * y, 1) * 4 <= maxBytes) {
      picked = { reader, scale: level.scale };
      break;
    }
  }
  if (!picked) throw new ZarrError(413, "this image is too large to preview, even at its smallest level");
  const { reader, scale = [] } = picked;
  const values = await readValues(reader);
  const shape = reader.shape;
  const strides = shape.map((_, i) => shape.slice(i + 1).reduce((x, y) => x * y, 1));
  // to the viewer's model: planes of y × x, channel fastest, then z, then t
  const size = (a: string) => (axes.includes(a) ? shape[axes.indexOf(a)] : 1);
  const [T, C, Z, Y, X] = ["t", "c", "z", "y", "x"].map(size);
  const type = reader.type.viewer;
  const planes: PixelArray[] = [];
  for (let t = 0; t < T; t++)
    for (let z = 0; z < Z; z++)
      for (let c = 0; c < C; c++) {
        const plane = type === "uint8" ? new Uint8Array(X * Y) : type === "uint16" ? new Uint16Array(X * Y) : new Float32Array(X * Y);
        for (let y = 0; y < Y; y++)
          for (let x = 0; x < X; x++) {
            let at = 0;
            for (const [a, v] of [["t", t], ["c", c], ["z", z], ["y", y], ["x", x]] as const) if (axes.includes(a)) at += v * strides[axes.indexOf(a)];
            plane[y * X + x] = values[at];
          }
        planes.push(plane);
      }
  const step = (a: string) => (axes.includes(a) ? (scale[axes.indexOf(a)] ?? 1) : 1);
  const unit = found.unit;
  return createImage({
    dtype: type,
    width: X,
    height: Y,
    channels: C,
    slices: Z,
    frames: T,
    planes,
    ...(name ? { name } : {}),
    calibration: {
      pixelWidth: step("x"),
      pixelHeight: step("y"),
      pixelDepth: step("z"),
      unit: unit === "micrometer" ? "µm" : unit === "nanometer" ? "nm" : (unit ?? "pixel"),
      frameInterval: axes.includes("t") ? step("t") : 0,
    },
  });
}
