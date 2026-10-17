import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { zstdCompressSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Artifact } from "@pharos/contracts";
import { getPlane, readTiff } from "@pharos/core";
import { caseSummary, imageAsTiff, readOmeZarr } from "../src/preview.js";

const CASE = fileURLToPath(new URL("../../../books/fluid-flow/example/case", import.meta.url));
let tmp: string;

const artifact = (uri: string, a: Partial<Artifact>): Artifact => ({ id: "x", kind: "volume", format: "ome-zarr", uri, meta: {}, createdAt: "", ...a });

/** Writes a t,z,y,x uint16 OME-Zarr whose value at each voxel encodes its position, in uneven chunks. */
async function zarr(dir: string, compressor: "zstd" | null) {
  const shape = [2, 3, 5, 7];
  const chunks = [1, 2, 4, 4];
  await mkdir(join(dir, "0"), { recursive: true });
  await writeFile(
    join(dir, ".zattrs"),
    JSON.stringify({ multiscales: [{ version: "0.4", axes: [{ name: "t" }, { name: "z" }, { name: "y" }, { name: "x", unit: "micrometer" }], datasets: [{ path: "0", coordinateTransformations: [{ type: "scale", scale: [30, 2, 0.5, 0.5] }] }] }] }),
  );
  await writeFile(join(dir, "0", ".zarray"), JSON.stringify({ shape, chunks, dtype: "<u2", order: "C", fill_value: 0, filters: null, dimension_separator: ".", compressor: compressor && { id: "zstd", level: 3 }, zarr_format: 2 }));
  const grid = shape.map((n, i) => Math.ceil(n / chunks[i]));
  for (let a = 0; a < grid[0]; a++)
    for (let b = 0; b < grid[1]; b++)
      for (let c = 0; c < grid[2]; c++)
        for (let d = 0; d < grid[3]; d++) {
          const buf = Buffer.alloc(chunks.reduce((x, y) => x * y, 1) * 2);
          let k = 0;
          for (let t = 0; t < chunks[0]; t++)
            for (let z = 0; z < chunks[1]; z++)
              for (let y = 0; y < chunks[2]; y++)
                for (let x = 0; x < chunks[3]; x++) {
                  const [T, Z, Y, X] = [a * chunks[0] + t, b * chunks[1] + z, c * chunks[2] + y, d * chunks[3] + x];
                  buf.writeUInt16LE(T * 1000 + Z * 100 + Y * 10 + X, 2 * k++);
                }
          await writeFile(join(dir, "0", `${a}.${b}.${c}.${d}`), compressor ? zstdCompressSync(buf) : buf);
        }
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pharos-preview-"));
  await zarr(join(tmp, "z.zarr"), "zstd");
  await zarr(join(tmp, "raw.zarr"), null);
});

afterAll(() => rm(tmp, { recursive: true, force: true }));

describe("OME-Zarr previews", () => {
  it("reads zstd and uncompressed chunks, including partial edge chunks, into the viewer's model", async () => {
    for (const name of ["z.zarr", "raw.zarr"]) {
      const img = await readOmeZarr(join(tmp, name));
      expect(img.shape).toEqual({ width: 7, height: 5, channels: 1, slices: 3, frames: 2 });
      expect(img.dtype).toBe("uint16");
      expect(img.calibration).toMatchObject({ pixelWidth: 0.5, pixelDepth: 2, unit: "µm", frameInterval: 30 });
      const plane = getPlane(img, 0, 2, 1);
      expect(plane[4 * 7 + 6]).toBe(1000 + 200 + 40 + 6);
      expect(plane[0]).toBe(1200);
    }
  });

  it("serves it as a TIFF the browser can read, and refuses compressors it can't decode", async () => {
    const tiff = await imageAsTiff(artifact(join(tmp, "z.zarr"), {}));
    expect((await readTiff(tiff)).shape).toMatchObject({ width: 7, slices: 3, frames: 2 });
    await writeFile(join(tmp, "z.zarr", "0", ".zarray"), JSON.stringify({ shape: [2, 3, 5, 7], chunks: [1, 2, 4, 4], dtype: "<u2", order: "C", compressor: { id: "blosc" }, zarr_format: 2 }));
    await expect(readOmeZarr(join(tmp, "z.zarr"))).rejects.toThrow(/blosc-compressed/);
    await expect(imageAsTiff(artifact("/x.csv", { kind: "table", format: "csv" }))).rejects.toThrow(/isn't an image/);
  });
});

describe("OpenFOAM case summary", () => {
  it("reads the solver, end time, patches, inlet speed and viscosity of an unsolved case", async () => {
    const s = await caseSummary(artifact(CASE, { kind: "sim-case", format: "openfoam-case" }));
    expect(s).toMatchObject({ application: "pimpleFoam", endTime: 60, inletSpeed: 1, viscosity: 0.01, solved: false, times: [0], fields: ["U", "p"] });
    expect(s.patches.map((p) => p.name)).toEqual(["inlet", "outlet", "bottom", "top", "obstacle", "frontAndBack"]);
  });
});
