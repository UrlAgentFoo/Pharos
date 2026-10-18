/**
 * Previews of artifacts for data windows: images and labels as TIFF (which
 * the browser's image viewer reads), and a summary of OpenFOAM cases.
 *
 * Zarr is read here directly, as Pharos's ships and other tools write it
 * (zarr.ts); what isn't read answers with a clear "can't preview" rather
 * than a wrong picture.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Artifact, CaseSummary } from "@pharos/contracts";
import { type Image, writeTiff } from "@pharos/core";
import { type PreviewSampling, ZarrError, readZarrImage } from "./zarr.js";

export class PreviewError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// ------------------------------------------------------------ images

export async function imageAsTiff(a: Artifact): Promise<Uint8Array> {
  return (await imagePreview(a)).tiff;
}

/**
 * An image or labels as TIFF for the window, with a note when it's a preview of something larger (which frames,
 * which pixels), and its sampling: how its pixels and frames map to the full image's.
 */
export async function imagePreview(a: Artifact): Promise<{ tiff: Uint8Array; note?: string; sampling?: PreviewSampling }> {
  if (a.kind !== "volume" && a.kind !== "labels") throw new PreviewError(415, `${a.kind} data isn't an image`);
  if (a.format === "tiff" || a.format === "ome-tiff") return { tiff: await readFile(a.uri) };
  if (a.format === "ome-zarr") {
    const { image, note, sampling } = await zarrPreview(a.uri, a.name);
    return { tiff: writeTiff(image), sampling, ...(note ? { note } : {}) };
  }
  throw new PreviewError(415, `Pharos can't preview ${a.format} images yet; convert them to OME-Zarr first (bio-utils › convert)`);
}

/** An OME-Zarr folder's image, or any other Zarr's (see zarr.ts), as much of it as a preview holds. */
export async function readOmeZarr(dir: string, name?: string): Promise<Image> {
  return (await zarrPreview(dir, name)).image;
}

async function zarrPreview(dir: string, name?: string): Promise<{ image: Image; note?: string; sampling: PreviewSampling }> {
  try {
    return await readZarrImage(dir, name);
  } catch (e) {
    if (e instanceof ZarrError) throw new PreviewError(e.status, e.message);
    // a chunk that doesn't decode: say so rather than show a wrong picture
    throw new PreviewError(415, `this Zarr couldn't be read for a preview: ${e instanceof Error ? e.message : String(e)}`);
  }
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
