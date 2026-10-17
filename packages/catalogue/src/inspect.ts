/**
 * The data inspector: reads an artifact's metadata (shape, axes, data
 * type, channels, time points, voxel size; columns and rows for tables)
 * without loading its data. This summary is all the assistant ever sees.
 *
 * TIFF (ImageJ and OME), OME-Zarr (v2 and v3), GEFF track graphs and CSV
 * are read here.
 * Other formats report their kind, format and size; a converter ship's
 * `inspect` operation can fill in the rest.
 */
import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { fromFile } from "geotiff";
import { type Artifact, type ArtifactKind, type DataSummary, type Format, type FormatInfo, sniffFormat } from "@pharos/contracts";
import { parseImageJDescription } from "@pharos/core";

/**
 * Guesses an artifact's kind and format from its name (and, for folders,
 * what they contain): the built-in formats, plus any `formats` ships declare.
 */
export function sniff(name: string, isDir: boolean, entries: string[] = [], formats?: Record<string, FormatInfo>): { kind: ArtifactKind; format: Format } | null {
  return sniffFormat(name, isDir, entries, formats);
}

const DTYPES: Record<string, string> = { "1:8": "uint8", "1:16": "uint16", "1:32": "uint32", "2:8": "int8", "2:16": "int16", "2:32": "int32", "3:32": "float32", "3:64": "float64" };

export async function inspect(artifact: Pick<Artifact, "uri" | "kind" | "format" | "name">): Promise<DataSummary> {
  const s = await stat(artifact.uri);
  const base: DataSummary = { kind: artifact.kind, format: artifact.format, name: artifact.name ?? basename(artifact.uri), sizeBytes: s.isFile() ? s.size : await folderSize(artifact.uri) };
  try {
    if (artifact.format === "tiff" || artifact.format === "ome-tiff") return { ...base, ...(await inspectTiff(artifact.uri)) };
    if (artifact.format === "ome-zarr") return { ...base, ...(await inspectZarr(artifact.uri)) };
    if (artifact.format === "geff") return { ...base, ...(await inspectGeff(artifact.uri)) };
    if (artifact.format === "csv") return { ...base, ...(await inspectCsv(artifact.uri)) };
  } catch {
    // unreadable metadata: the kind and size are still worth reporting
  }
  return base;
}

/** Keeps only the axes with more than one element, plus y and x: e.g. tczyx of (5,1,30,512,512) → tzyx. */
function squeeze(axes: string, shape: number[]): { axes: string; shape: number[] } {
  const keep = [...axes].map((a, i) => a === "y" || a === "x" || shape[i] > 1);
  return { axes: [...axes].filter((_, i) => keep[i]).join(""), shape: shape.filter((_, i) => keep[i]) };
}

function rationalToNumber(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (Array.isArray(v) || ArrayBuffer.isView(v)) {
    const a = Array.from(v as ArrayLike<number>);
    return a.length >= 2 && a[1] ? a[0] / a[1] : a[0];
  }
  return undefined;
}

async function inspectTiff(path: string): Promise<Partial<DataSummary>> {
  const tiff = await fromFile(path);
  const first = await tiff.getImage(0);
  const width = first.getWidth();
  const height = first.getHeight();
  const bits = first.getBitsPerSample(0);
  const dtype = DTYPES[`${first.getSampleFormat(0) ?? 1}:${bits}`];
  const desc = (await first.fileDirectory.loadValue("ImageDescription")) as string | undefined;
  let [t, c, z] = [1, first.getSamplesPerPixel(), 1];
  let voxel: DataSummary["voxelSize"];
  let frame: DataSummary["frameInterval"];

  const ome = desc?.includes("<OME") ? desc : undefined;
  const ij = parseImageJDescription(desc);
  if (ome) {
    const attr = (name: string) => ome.match(new RegExp(`<Pixels[^>]*\\s${name}="([^"]+)"`))?.[1];
    [t, c, z] = [Number(attr("SizeT") ?? 1), Number(attr("SizeC") ?? 1), Number(attr("SizeZ") ?? 1)];
    const px = Number(attr("PhysicalSizeX"));
    if (px) voxel = { x: px, y: Number(attr("PhysicalSizeY") ?? px), ...(attr("PhysicalSizeZ") ? { z: Number(attr("PhysicalSizeZ")) } : {}), unit: attr("PhysicalSizeXUnit") ?? "µm" };
    const dt = Number(attr("TimeIncrement"));
    if (dt) frame = { value: dt, unit: attr("TimeIncrementUnit") ?? "s" };
  } else if (ij) {
    [t, c, z] = [Number(ij.frames ?? 1), Number(ij.channels ?? 1), Number(ij.slices ?? 1)];
    if (t * c * z === 1 && ij.images) z = Number(ij.images);
    const xr = rationalToNumber(await first.fileDirectory.loadValue("XResolution"));
    const unit = ["micron", "um", "\\u00B5m"].includes(ij.unit ?? "") ? "µm" : (ij.unit ?? "pixel");
    if (xr) voxel = { x: 1 / xr, y: 1 / xr, ...(ij.spacing ? { z: Number(ij.spacing) } : {}), unit };
    if (ij.finterval) frame = { value: Number(ij.finterval), unit: ij.tunit ?? "s" };
  } else {
    z = (await tiff.getImageCount()) || 1;
  }
  const { axes, shape } = squeeze("tczyx", [t, c, z, height, width]);
  return { axes, shape, ...(dtype ? { dtype } : {}), channels: c, timepoints: t, ...(voxel ? { voxelSize: voxel } : {}), ...(frame ? { frameInterval: frame } : {}) };
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  return readFile(path, "utf8").then((t) => JSON.parse(t) as Record<string, unknown>, () => null);
}

const ZARR_DTYPES: Record<string, string> = { "|u1": "uint8", "<u2": "uint16", ">u2": "uint16", "<u4": "uint32", "<f4": "float32", ">f4": "float32", "<f8": "float64", "|i1": "int8", "<i2": "int16" };

async function inspectZarr(path: string): Promise<Partial<DataSummary>> {
  // v3 keeps attributes in zarr.json under "attributes" (OME under "ome"); v2 in .zattrs
  const v3 = await readJson(join(path, "zarr.json"));
  const attrs = (v3 ? ((v3.attributes as Record<string, unknown>)?.ome ?? v3.attributes) : await readJson(join(path, ".zattrs"))) as Record<string, unknown> | null;
  const ms = (attrs?.multiscales as { axes?: (string | { name: string })[]; datasets: { path: string; coordinateTransformations?: { type: string; scale?: number[] }[] }[] }[] | undefined)?.[0];
  if (!ms) return {};
  // some writers name axes in capitals (T, Z, Y, X)
  const names = (ms.axes ?? ["t", "c", "z", "y", "x"]).map((a) => (typeof a === "string" ? a : a.name).toLowerCase()).join("");
  const level0 = ms.datasets[0];
  const array = v3 ? await readJson(join(path, level0.path, "zarr.json")) : await readJson(join(path, level0.path, ".zarray"));
  const fullShape = (array?.shape as number[] | undefined) ?? [];
  const rawType = (v3 ? array?.data_type : array?.dtype) as string | undefined;
  const { axes, shape } = squeeze(names, fullShape);
  const scale = level0.coordinateTransformations?.find((c) => c.type === "scale")?.scale;
  const at = (a: string) => names.indexOf(a);
  const unitOf = (ms.axes?.find((a) => typeof a !== "string" && a.name === "x") as { unit?: string } | undefined)?.unit;
  return {
    axes,
    shape,
    ...(rawType ? { dtype: ZARR_DTYPES[rawType] ?? rawType } : {}),
    channels: at("c") >= 0 ? fullShape[at("c")] : 1,
    timepoints: at("t") >= 0 ? fullShape[at("t")] : 1,
    ...(scale && at("x") >= 0
      ? { voxelSize: { x: scale[at("x")], y: scale[at("y")], ...(at("z") >= 0 ? { z: scale[at("z")] } : {}), unit: (unitOf ?? "micrometer").replace("micrometer", "µm") } }
      : {}),
  };
}

/** A GEFF graph (a zarr group of nodes and edges): its axes, node count and node properties, from metadata alone. */
async function inspectGeff(path: string): Promise<Partial<DataSummary>> {
  const v3 = await readJson(join(path, "zarr.json"));
  const geff = ((v3?.attributes as Record<string, unknown> | undefined) ?? (await readJson(join(path, ".zattrs"))))?.geff as
    | { axes?: { name: string; type?: string; min?: number | null; max?: number | null }[]; node_props_metadata?: Record<string, unknown> }
    | undefined;
  if (!geff) return {};
  const ids = (await readJson(join(path, "nodes", "ids", "zarr.json"))) ?? (await readJson(join(path, "nodes", "ids", ".zarray")));
  const axes = (geff.axes ?? []).map((a) => a.name.toLowerCase()).join("");
  const time = geff.axes?.find((a) => a.type === "time");
  return {
    ...(/^[tczyx]+$/.test(axes) ? { axes } : {}),
    columns: Object.keys(geff.node_props_metadata ?? {}),
    ...(Array.isArray(ids?.shape) ? { rows: (ids.shape as number[])[0] } : {}),
    ...(time && typeof time.min === "number" && typeof time.max === "number" ? { timepoints: time.max - time.min + 1 } : {}),
  };
}

async function inspectCsv(path: string): Promise<Partial<DataSummary>> {
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let header: string | undefined;
  let rows = 0;
  for await (const line of lines) {
    if (header === undefined) header = line;
    else if (line.trim()) rows++;
  }
  return { columns: header ? header.split(",").map((c) => c.trim().replace(/^"|"$/g, "")) : [], rows };
}

async function folderSize(dir: string): Promise<number> {
  let n = 0;
  for (const e of await readdir(dir, { recursive: true, withFileTypes: true })) if (e.isFile()) n += (await stat(join(e.parentPath, e.name))).size;
  return n;
}
