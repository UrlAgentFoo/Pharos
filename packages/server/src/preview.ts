/**
 * Previews of artifacts for data windows: images and labels as TIFF (which
 * the browser's image viewer reads), and a summary of OpenFOAM cases.
 *
 * OME-Zarr is read here directly (NGFF 0.4, Zarr format 2, uncompressed or
 * zstd, which is what Pharos's ships write); other compressors answer with
 * a clear "can't preview" rather than a wrong picture.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import type { Artifact, CaseSummary } from "@pharos/contracts";
import { type DType, type Image, type PixelArray, createImage, writeTiff } from "@pharos/core";

export class PreviewError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Largest image to send to the browser in one piece. */
const MAX_PREVIEW_BYTES = 1024 ** 3;

// ------------------------------------------------------------ images

export async function imageAsTiff(a: Artifact): Promise<Uint8Array> {
  if (a.kind !== "volume" && a.kind !== "labels") throw new PreviewError(415, `${a.kind} data isn't an image`);
  if (a.format === "tiff" || a.format === "ome-tiff") return readFile(a.uri);
  if (a.format === "ome-zarr") return writeTiff(await readOmeZarr(a.uri, a.name));
  throw new PreviewError(415, `Pharos can't preview ${a.format} images yet; convert them to OME-Zarr first (bio-utils › convert)`);
}

const DTYPES: Record<string, { read: (b: Buffer, o: number) => number; size: number }> = {
  "|u1": { read: (b, o) => b.readUInt8(o), size: 1 },
  "|i1": { read: (b, o) => b.readInt8(o), size: 1 },
  "<u2": { read: (b, o) => b.readUInt16LE(o), size: 2 },
  ">u2": { read: (b, o) => b.readUInt16BE(o), size: 2 },
  "<i2": { read: (b, o) => b.readInt16LE(o), size: 2 },
  "<u4": { read: (b, o) => b.readUInt32LE(o), size: 4 },
  "<i4": { read: (b, o) => b.readInt32LE(o), size: 4 },
  "<f4": { read: (b, o) => b.readFloatLE(o), size: 4 },
  ">f4": { read: (b, o) => b.readFloatBE(o), size: 4 },
  "<f8": { read: (b, o) => b.readDoubleLE(o), size: 8 },
};

/** The image viewer's types: 8- and 16-bit stay as they are, everything else becomes float. */
function viewerType(dtype: string): DType {
  return dtype === "|u1" ? "uint8" : dtype === "<u2" || dtype === ">u2" ? "uint16" : "float32";
}

async function json(path: string): Promise<Record<string, unknown> | null> {
  return readFile(path, "utf8").then((t) => JSON.parse(t) as Record<string, unknown>, () => null);
}

export async function readOmeZarr(dir: string, name?: string): Promise<Image> {
  const attrs = await json(join(dir, ".zattrs"));
  if (!attrs) throw new PreviewError(415, (await json(join(dir, "zarr.json"))) ? "Zarr format 3 previews aren't supported yet" : "not an OME-Zarr folder (no .zattrs)");
  const ms = (attrs.multiscales as { axes: (string | { name: string; unit?: string })[]; datasets: { path: string; coordinateTransformations?: { type: string; scale?: number[] }[] }[] }[])?.[0];
  if (!ms) throw new PreviewError(415, "no OME multiscales metadata");
  const axes = ms.axes.map((a) => (typeof a === "string" ? a : a.name)).join("");
  const level = ms.datasets[0];
  const arrayDir = join(dir, level.path);
  const meta = await json(join(arrayDir, ".zarray"));
  if (!meta) throw new PreviewError(415, `no array at ${level.path}`);
  const shape = meta.shape as number[];
  const chunks = meta.chunks as number[];
  const dtype = meta.dtype as string;
  const codec = (meta.compressor as { id: string } | null)?.id ?? null;
  const sep = (meta.dimension_separator as string | undefined) ?? ".";
  const fill = Number(meta.fill_value ?? 0) || 0;
  const reader = DTYPES[dtype];
  if (!reader) throw new PreviewError(415, `unsupported data type ${dtype}`);
  if (codec && codec !== "zstd") throw new PreviewError(415, `this Zarr is ${codec}-compressed; Pharos previews uncompressed or zstd Zarr`);
  if ((meta.order ?? "C") !== "C") throw new PreviewError(415, "only C-ordered Zarr arrays can be previewed");
  if (meta.filters) throw new PreviewError(415, "Zarr filters aren't supported in previews");
  const total = shape.reduce((a, b) => a * b, 1);
  if (total * 4 > MAX_PREVIEW_BYTES) throw new PreviewError(413, "this image is too large to preview in one piece");

  // read every chunk into one C-ordered array of numbers
  const values = new Float64Array(total).fill(fill);
  const grid = shape.map((n, i) => Math.ceil(n / chunks[i]));
  const strides = shape.map((_, i) => shape.slice(i + 1).reduce((a, b) => a * b, 1));
  const index = new Array<number>(shape.length).fill(0);
  for (;;) {
    const raw = await readFile(join(arrayDir, index.join(sep))).catch(() => null);
    if (raw) {
      const buf = codec === "zstd" ? zstdDecompressSync(raw) : raw;
      const chunkStrides = chunks.map((_, i) => chunks.slice(i + 1).reduce((a, b) => a * b, 1));
      const count = chunks.reduce((a, b) => a * b, 1);
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
        if (inside) values[at] = reader.read(buf, k * reader.size);
      }
    }
    let d = shape.length - 1;
    while (d >= 0 && ++index[d] >= grid[d]) index[d--] = 0;
    if (d < 0) break;
  }

  // to the viewer's model: planes of y × x, channel fastest, then z, then t
  const size = (a: string) => (axes.includes(a) ? shape[axes.indexOf(a)] : 1);
  const [T, C, Z, Y, X] = ["t", "c", "z", "y", "x"].map(size);
  const type = viewerType(dtype);
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
  const scale = level.coordinateTransformations?.find((c) => c.type === "scale")?.scale ?? [];
  const step = (a: string) => (axes.includes(a) ? (scale[axes.indexOf(a)] ?? 1) : 1);
  const unit = ms.axes.find((a): a is { name: string; unit?: string } => typeof a !== "string" && a.name === "x")?.unit;
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

// ------------------------------------------------------------ OpenFOAM cases


const entry = (text: string, key: string) => text.match(new RegExp(`^\\s*${key}\\s+([^;]+);`, "m"))?.[1].trim();

export async function caseSummary(a: Artifact): Promise<CaseSummary> {
  if (a.format !== "openfoam-case") throw new PreviewError(415, `${a.format} isn't an OpenFOAM case`);
  const dir = a.uri;
  const read = (p: string) => readFile(join(dir, p), "utf8").catch(() => "");
  const control = await read("system/controlDict");
  const names = await readdir(dir);
  const times = (
    await Promise.all(names.filter((n) => /^\d+(\.\d+)?(e[-+]?\d+)?$/.test(n)).map(async (n) => ((await stat(join(dir, n))).isDirectory() ? Number(n) : null)))
  )
    .filter((t): t is number => t !== null)
    .sort((x, y) => x - y);
  const last = times.length ? names.find((n) => Number(n) === times[times.length - 1])! : undefined;
  const fields = last ? (await readdir(join(dir, last))).filter((f) => !f.startsWith(".")).sort() : [];

  // patches: from the mesh when it exists, otherwise from blockMeshDict's boundary section
  const boundary = await read("constant/polyMesh/boundary");
  const patches: CaseSummary["patches"] = [];
  const source = boundary || (await read("system/blockMeshDict")).split(/^boundary\b/m)[1] || "";
  for (const m of source.matchAll(/^\s*([A-Za-z_][\w]*)\s*\{\s*type\s+(\w+)\s*;/gm)) {
    if (!patches.some((p) => p.name === m[1])) patches.push({ name: m[1], type: m[2] });
  }
  const owner = await read("constant/polyMesh/owner");
  const cells = Number(owner.match(/nCells:\s*(\d+)/)?.[1]) || undefined;
  const u = await read("0/U");
  const inlet = u.match(/inlet\s*\{[^}]*value\s+uniform\s*\(\s*([-\d.e+]+)/)?.[1];
  const nu = entry(await read("constant/transportProperties"), "nu");
  const end = entry(control, "endTime");
  return {
    ...(entry(control, "application") ? { application: entry(control, "application") } : {}),
    ...(end ? { endTime: Number(end) } : {}),
    ...(cells ? { cells } : {}),
    patches,
    times,
    fields,
    ...(inlet ? { inletSpeed: Number(inlet) } : {}),
    ...(nu ? { viscosity: Number(nu.split(/\s+/).pop()) } : {}),
    solved: times.some((t) => t > 0),
  };
}
