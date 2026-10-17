import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Library } from "@pharos/books";
import type { DataSummary } from "@pharos/contracts";
import { createImage, writeTiff } from "@pharos/core";
import { CatalogueIndex, type MatchableBook, McpServer, acceptProblems, ftsQuery, inspect, matchBooks, sniff } from "@pharos/catalogue";

let root: string;
let lib: Library;
let index: CatalogueIndex;
let books: MatchableBook[];

const files: Record<string, string> = {
  "ships/bio-utils/ship.yaml": `id: bio-utils
version: 0.1.0
image: pharos/bio-utils:0.1.0
summary: Converts, inspects and measures microscopy data.
tags: [microscopy]
operations:
  convert:
    summary: Converts TIFF and vendor microscopy files to OME-Zarr.
    command: convert {in.image}
    inputs: [{ name: image, kind: volume, formats: [tiff, ome-tiff, czi, nd2] }]
    outputs: [{ name: zarr, kind: volume, format: ome-zarr, path: /out/image.zarr }]
  measure:
    summary: Measures area and intensity of each labelled object.
    command: measure
    inputs:
      - { name: labels, kind: labels, formats: [ome-zarr] }
      - { name: image, kind: volume, formats: [ome-zarr] }
    outputs: [{ name: table, kind: table, format: csv, path: /out/table.csv }]
`,
  "ships/cellpose/ship.yaml": `id: cellpose
version: 0.1.0
image: pharos/cellpose:0.1.0
summary: Deep-learning segmentation of cells and nuclei.
tags: [microscopy, segmentation]
requires: { gpu: { vendor: nvidia, optional: true } }
operations:
  segment:
    summary: Segments cells or nuclei in 2D or 3D fluorescence images.
    command: seg {diameter}
    inputs: [{ name: image, kind: volume, formats: [ome-zarr] }]
    parameters: [{ name: diameter, type: number, default: 30 }]
    outputs: [{ name: masks, kind: labels, format: ome-zarr, path: /out/masks.zarr }]
`,
  "books/segment-measure/book.yaml": `id: segment-measure
version: 0.1.0
title: Segment and measure nuclei
summary: Finds every nucleus in a 3D stack and measures its size and brightness.
tags: [microscopy, segmentation]
ships: { bio-utils: ^0.1, cellpose: ^0.1 }
actions:
  measure:
    title: Count and measure
    inputs: [{ name: image, accepts: { kind: volume, axes: zyx, channels: 1-2 } }]
    steps:
      - { id: convert, run: bio-utils.convert, in: { image: $image } }
      - { id: segment, run: cellpose.segment, in: { image: convert.zarr } }
      - { id: measure, run: bio-utils.measure, in: { labels: segment.masks, image: convert.zarr } }
    outputs: { table: measure.table }
`,
  "books/segment-measure/GUIDE.md": "# Segment and measure\n## When to use\nCounting nuclei, nuclear volume.\n## When not to use\n## Parameters\n## Example\n",
  "books/cell-tracking/book.yaml": `id: cell-tracking
version: 0.1.0
title: Track cells over time
summary: Segments nuclei in every frame and links them into tracks.
tags: [microscopy, tracking]
ships: { bio-utils: ^0.1, cellpose: ^0.1 }
actions:
  track:
    title: Track over time
    inputs: [{ name: movie, accepts: { kind: volume, axes: tzyx } }]
    steps:
      - { id: convert, run: bio-utils.convert, in: { image: $movie } }
      - { id: segment, run: cellpose.segment, in: { image: convert.zarr } }
    outputs: { masks: segment.masks }
`,
  "ships/openfoam/ship.yaml": `id: openfoam
version: 0.1.0
image: openfoam/openfoam:12
summary: Computational fluid dynamics.
tags: [cfd]
operations:
  solve:
    summary: Simulates flow past an obstacle.
    command: solve {speed}
    parameters: [{ name: speed, type: number, default: 1 }]
    outputs: [{ name: case, kind: sim-case, format: openfoam-case, path: /out/case }]
`,
  "books/fluid-sim/book.yaml": `id: fluid-sim
version: 0.1.0
title: Simulate flow past an obstacle
summary: Runs a fluid dynamics simulation of air or water flowing around a cylinder.
tags: [cfd, simulation]
ships: { openfoam: ^0.1 }
actions:
  simulate:
    title: Simulate the flow
    parameters: [{ name: speed, type: number, default: 1, sets: solve.speed }]
    steps: [{ id: solve, run: openfoam.solve }]
    outputs: { case: solve.case }
`,
};

const summary = (s: Partial<DataSummary>): DataSummary => ({ kind: "volume", format: "tiff", name: "x.tif", sizeBytes: 1000, axes: "zyx", channels: 1, dtype: "uint16", ...s });

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "pharos-cat-"));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), text);
  }
  const verified = new Set(["ship:bio-utils@0.1.0", "ship:cellpose@0.1.0", "book:segment-measure@0.1.0"]);
  lib = await Library.load([root], (type, id, version) => (verified.has(`${type}:${id}@${version}`) ? "verified" : undefined));
  expect(lib.issues().filter((i) => i.problems.some((p) => p.severity === "error"))).toEqual([]);
  index = new CatalogueIndex();
  index.rebuild(lib);
  books = lib.bookEntries().map((entry) => {
    const b = lib.book(entry.id, entry.version)!;
    return { entry, manifest: b.manifest!, accepts: b.accepts!, guide: b.guide };
  });
});

afterAll(async () => {
  index.close();
  await rm(root, { recursive: true, force: true });
});

describe("inspect", () => {
  it("reads an ImageJ hyperstack TIFF's axes, shape, channels, frames and voxel size", async () => {
    const img = createImage({ dtype: "uint16", width: 16, height: 8, channels: 2, slices: 3, frames: 4, calibration: { pixelWidth: 0.5, pixelHeight: 0.5, pixelDepth: 2, unit: "µm", frameInterval: 30, timeUnit: "sec" } });
    const path = join(root, "movie.tif");
    await writeFile(path, writeTiff(img));
    const s = await inspect({ uri: path, kind: "volume", format: "tiff" });
    expect(s).toMatchObject({ name: "movie.tif", axes: "tczyx", shape: [4, 2, 3, 8, 16], dtype: "uint16", channels: 2, timepoints: 4, voxelSize: { x: 0.5, y: 0.5, z: 2, unit: "µm" } });
  });

  it("reads the voxel size of ImageJ TIFFs written with unit=um", async () => {
    const path = join(root, "um.tif");
    await writeFile(path, writeTiff(createImage({ dtype: "uint8", width: 4, height: 4, slices: 2, calibration: { pixelWidth: 0.5, pixelHeight: 0.5, pixelDepth: 2, unit: "um" } })));
    expect((await inspect({ uri: path, kind: "volume", format: "tiff" })).voxelSize).toMatchObject({ x: 0.5, unit: "µm" });
  });

  it("squeezes axes of length one", async () => {
    const path = join(root, "stack.tif");
    await writeFile(path, writeTiff(createImage({ dtype: "uint8", width: 4, height: 4, slices: 5 })));
    expect(await inspect({ uri: path, kind: "volume", format: "tiff" })).toMatchObject({ axes: "zyx", shape: [5, 4, 4], channels: 1, timepoints: 1 });
  });

  it("reads OME-Zarr multiscales metadata", async () => {
    const z = join(root, "m.zarr");
    await mkdir(join(z, "0"), { recursive: true });
    await writeFile(join(z, ".zattrs"), JSON.stringify({ multiscales: [{ axes: [{ name: "t" }, { name: "c" }, { name: "z" }, { name: "y" }, { name: "x", unit: "micrometer" }], datasets: [{ path: "0", coordinateTransformations: [{ type: "scale", scale: [1, 1, 2, 0.3, 0.3] }] }] }] }));
    await writeFile(join(z, "0", ".zarray"), JSON.stringify({ shape: [10, 1, 20, 256, 256], dtype: "<u2" }));
    expect(await inspect({ uri: z, kind: "volume", format: "ome-zarr" })).toMatchObject({ axes: "tzyx", shape: [10, 20, 256, 256], dtype: "uint16", channels: 1, timepoints: 10, voxelSize: { x: 0.3, z: 2, unit: "µm" } });
  });

  it("reads a v3 OME-Zarr with capitalised axes and its GEFF ground truth, as the Biohub challenge ships them", async () => {
    const example = fileURLToPath(new URL("../../../books/cell-imaging/example/", import.meta.url));
    expect(sniff("44b6_e28840c6.geff", true)).toEqual({ kind: "tracks", format: "geff" });
    expect(await inspect({ uri: join(example, "timelapse.zarr"), kind: "volume", format: "ome-zarr" })).toMatchObject({ axes: "tzyx", shape: [12, 24, 96, 96], dtype: "uint16", timepoints: 12, voxelSize: { x: 0.40625, z: 1.625, unit: "µm" } });
    expect(await inspect({ uri: join(example, "truth.geff"), kind: "tracks", format: "geff" })).toMatchObject({ axes: "tzyx", columns: ["t", "z", "y", "x"], rows: 72, timepoints: 12 });
  });

  it("reads other tools' Zarr: bioformats2raw's layout and named plain arrays; an array that names nothing keeps its axes unknown", async () => {
    const put = async (dir: string, file: string, json: unknown) => {
      await mkdir(join(root, dir), { recursive: true });
      await writeFile(join(root, dir, file), JSON.stringify(json));
    };
    const zarr = (name: string) => inspect({ uri: join(root, name), kind: "volume", format: "ome-zarr" });
    // bioformats2raw: the image in 0/, with capital axis names
    await put("b2r.zarr", ".zattrs", { "bioformats2raw.layout": 3 });
    await put("b2r.zarr/0", ".zattrs", { multiscales: [{ axes: ["T", "C", "Z", "Y", "X"].map((name) => ({ name })), datasets: [{ path: "0" }] }] });
    await put("b2r.zarr/0/0", ".zarray", { shape: [12, 1, 1, 96, 96], dtype: "<u2" });
    expect(await zarr("b2r.zarr")).toMatchObject({ axes: "tyx", shape: [12, 96, 96], dtype: "uint16", timepoints: 12 });
    // xarray's way (Zarr 2) and Zarr 3's dimension names
    await put("named.zarr", ".zarray", { shape: [12, 96, 96], dtype: "|u1" });
    await put("named.zarr", ".zattrs", { _ARRAY_DIMENSIONS: ["time", "y", "x"] });
    expect(await zarr("named.zarr")).toMatchObject({ axes: "tyx", shape: [12, 96, 96], dtype: "uint8", timepoints: 12, channels: 1 });
    await put("named3.zarr", "zarr.json", { zarr_format: 3, node_type: "array", shape: [2, 12, 96, 96], data_type: "uint16", dimension_names: ["c", "t", "y", "x"] });
    expect(await zarr("named3.zarr")).toMatchObject({ axes: "ctyx", channels: 2, timepoints: 12 });
    // nothing named: no axes (so a book that needs a movie still offers itself), but its data type
    await put("bare.zarr", "zarr.json", { zarr_format: 3, node_type: "array", shape: [12, 96, 96], data_type: "uint16" });
    const bare = await zarr("bare.zarr");
    expect(bare).toMatchObject({ dtype: "uint16" });
    expect(bare.axes).toBeUndefined();
    expect(acceptProblems({ kind: "volume", axes: "tyx" }, bare)).toEqual([]);
    // a group of arrays without OME metadata: its largest
    await put("group.zarr", ".zgroup", { zarr_format: 2 });
    await put("group.zarr/mask", ".zarray", { shape: [1, 96, 96], dtype: "|u1" });
    await put("group.zarr/mask", ".zattrs", { _ARRAY_DIMENSIONS: ["t", "y", "x"] });
    await put("group.zarr/movie", ".zarray", { shape: [12, 96, 96], dtype: "<u2" });
    await put("group.zarr/movie", ".zattrs", { _ARRAY_DIMENSIONS: ["t", "y", "x"] });
    expect(await zarr("group.zarr")).toMatchObject({ axes: "tyx", shape: [12, 96, 96], dtype: "uint16" });
  });

  it("reads a CSV's columns and rows, and falls back to kind and size for the rest", async () => {
    await writeFile(join(root, "t.csv"), "label,\"area\"\n1,2\n3,4\n\n");
    expect(await inspect({ uri: join(root, "t.csv"), kind: "table", format: "csv" })).toMatchObject({ columns: ["label", "area"], rows: 2, sizeBytes: 22 });
    await writeFile(join(root, "x.czi"), "not really");
    expect(await inspect({ uri: join(root, "x.czi"), kind: "volume", format: "czi" })).toEqual({ kind: "volume", format: "czi", name: "x.czi", sizeBytes: 10 });
  });
});

describe("matching", () => {
  it("explains why data doesn't fit", () => {
    expect(acceptProblems({ kind: "volume", axes: "tzyx" }, summary({}))).toEqual(["needs axes tzyx, this has zyx (no t)"]);
    expect(acceptProblems({ kind: "volume", channels: "1-2" }, summary({ channels: 3 }))).toEqual(["takes 1-2 channel(s), this has 3"]);
    expect(acceptProblems({ kind: "volume", dtype: ["uint8"] }, summary({}))).toEqual(["takes uint8 data, this is uint16"]);
    expect(acceptProblems({ kind: "table" }, summary({}))).toEqual(["needs table data, this is volume"]);
  });

  it("ranks direct matches first, keeps reasons for exclusions, and uses the request's words", () => {
    const m = matchBooks(books, [summary({})], { text: "measure nuclei size", gpu: false });
    expect(m[0]).toMatchObject({ book: { id: "segment-measure" }, tier: "direct", actions: ["measure"], reasons: ["image ← x.tif", 'matches "measure, nuclei, size"'] });
    expect(m.slice(1).map((x) => [x.tier, x.actions])).toEqual([["excluded", []], ["excluded", []]]);
    expect(m.find((x) => x.book.id === "cell-tracking")?.reasons).toEqual(["x.tif: needs axes tzyx, this has zyx (no t)"]);
  });

  it("marks data a converter can read, and picks parameter-only books from words alone", () => {
    const m = matchBooks(books, [summary({ format: "ome-zarr", name: "m.zarr" })], { gpu: false });
    expect(m.find((x) => x.book.id === "segment-measure")).toMatchObject({ tier: "excluded" }); // convert reads files, not ome-zarr
    const sim = matchBooks(books, [], { text: "simulate airflow around a cylinder", gpu: false });
    expect(sim[0]).toMatchObject({ book: { id: "fluid-sim" }, tier: "direct", actions: ["simulate"] });
  });

  it("fits a book when any of its actions fits, and lists only those", () => {
    const measure = books.find((b) => b.entry.id === "segment-measure")!;
    const track = books.find((b) => b.entry.id === "cell-tracking")!;
    const cells: MatchableBook = {
      entry: { ...measure.entry, id: "cells", title: "Cells" },
      manifest: { ...measure.manifest, id: "cells", title: "Cells", actions: { ...measure.manifest.actions, ...track.manifest.actions } },
      accepts: [...measure.accepts, ...track.accepts],
    };
    expect(matchBooks([cells], [summary({})], { gpu: false })[0]).toMatchObject({ tier: "direct", actions: ["measure"] });
    expect(matchBooks([cells], [summary({ axes: "tzyx", channels: 1 })], { gpu: false })[0]).toMatchObject({ tier: "direct", actions: ["measure", "track"] });
    expect(matchBooks([cells], [summary({ kind: "table" })], { gpu: false })[0]).toMatchObject({ tier: "excluded", actions: [], reasons: ["x.tif: needs volume data, this is table"] });
  });
});

describe("catalogue index", () => {
  it("searches text with prefixes, ranking verified first", () => {
    expect(ftsQuery("Track nuclei, 3D!")).toBe('"track"* OR "nuclei"* OR "3d"*');
    const r = index.search({ text: "nuclei", type: "book" });
    expect(r.map((e) => e.id)).toEqual(["segment-measure", "cell-tracking"]);
    expect(index.search({ text: "fluid" }).map((e) => e.id).sort()).toEqual(["fluid-sim", "openfoam"]);
    expect(index.search({ type: "ship", trust: "verified" }).map((e) => e.id).sort()).toEqual(["bio-utils", "cellpose"]);
    expect(index.search({ tag: "cfd", type: "book" }).map((e) => e.id)).toEqual(["fluid-sim"]);
    expect(index.search({ text: "segmentation", type: "ship" }).map((e) => e.id)).toEqual(["cellpose"]);
  });

  it("returns manifests, counts and gaps", () => {
    expect(index.manifest("book", "fluid-sim")).toMatchObject({ entry: { id: "fluid-sim" }, manifest: { actions: { simulate: { steps: [{ run: "openfoam.solve" }] } } } });
    expect(index.manifest("ship", "nope")).toBeNull();
    expect(index.stats()).toMatchObject({ ships: { verified: 2, imported: 1 }, books: { verified: 1, imported: 2 }, byDomain: { microscopy: 4, cfd: 2 } });
    const gaps = index.gaps();
    expect(gaps.unreadFormats).toContain("csv");
    expect(gaps.unreadFormats).not.toContain("tiff");
    expect(gaps.unproducedKinds).toContain("sim-case"); // openfoam isn't verified
    expect(gaps.noConverter).toContain("table");
  });
});

describe("MCP server", () => {
  const mcp = () => new McpServer(async () => ({ index, books, gpu: false }));

  it("initializes and lists the six tools", async () => {
    const init = await mcp().handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    expect(init).toMatchObject({ id: 1, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } } });
    expect(await mcp().handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    const list = (await mcp().handle({ jsonrpc: "2.0", id: 2, method: "tools/list" })) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((t) => t.name)).toEqual(["search_books", "search_ships", "match_file", "get_manifest", "catalogue_stats", "find_gaps"]);
    expect(await mcp().handle({ jsonrpc: "2.0", id: 3, method: "nope" })).toMatchObject({ error: { code: -32601 } });
  });

  it("matches a file by path over stdio", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: string[] = [];
    output.on("data", (d) => lines.push(...d.toString().split("\n").filter(Boolean)));
    const done = mcp().serveStdio(input, output);
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "match_file", arguments: { path: join(root, "stack.tif"), text: "count nuclei" } } }) + "\n");
    input.write("not json\n");
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "get_manifest", arguments: { type: "book", id: "nope" } } }) + "\n");
    input.end();
    await done;
    const [match, bad, missing] = lines.map((l) => JSON.parse(l));
    expect(match.result.structuredContent.result.matches[0]).toMatchObject({ book: { id: "segment-measure" }, tier: "direct" });
    expect(bad).toMatchObject({ error: { code: -32700 } });
    expect(missing).toMatchObject({ id: 8, result: { isError: true } });
  });
});
