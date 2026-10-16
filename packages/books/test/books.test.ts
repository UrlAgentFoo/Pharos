import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { BookManifest } from "@pharos/contracts";
import { Library, acceptedFormats, checkBook, converters, dependencies, newBook, newShip, planProblems, resolveBook, stepParams } from "@pharos/books";

const BIO_UTILS = `id: bio-utils
version: 0.1.0
image: pharos/bio-utils@sha256:aa
operations:
  convert:
    summary: Converts microscopy files to OME-Zarr.
    command: convert --in /in/image --out /out/image.zarr
    inputs: [{ name: image, kind: volume, formats: [tiff, ome-tiff, czi, nd2, lif] }]
    outputs: [{ name: zarr, kind: volume, format: ome-zarr, path: /out/image.zarr }]
    cache: { deterministic: true }
  measure:
    summary: Measures each labelled object.
    command: measure --labels /in/labels --image /in/image
    inputs:
      - { name: labels, kind: labels, formats: [ome-zarr] }
      - { name: image, kind: volume, formats: [ome-zarr] }
    outputs: [{ name: table, kind: table, format: csv, path: /out/table.csv }]
`;

const CELLPOSE = `id: cellpose
version: 0.1.0
image: pharos/cellpose@sha256:bb
requires: { gpu: { vendor: nvidia, optional: true }, memory_gb: 16 }
operations:
  segment:
    summary: Segments nuclei.
    command: cellpose-run --model {model} --diameter {diameter}
    inputs: [{ name: image, kind: volume, formats: [ome-zarr, tiff] }]
    parameters:
      - { name: model, type: enum, options: [cyto3, nuclei], default: cyto3 }
      - { name: diameter, type: number, unit: px, default: 30, min: 1 }
    outputs: [{ name: masks, kind: labels, format: ome-zarr, path: /out/masks.zarr }]
`;

const ULTRACK = (version: string, gpu: "true" | "false") => `id: ultrack
version: ${version}
image: royerlab/ultrack:${version}
requires: { gpu: { vendor: nvidia, optional: ${gpu} } }
operations:
  track:
    summary: Links labels over time into tracks.
    command: ultrack-run
    inputs: [{ name: labels, kind: labels, formats: [ome-zarr] }]
    outputs:
      - { name: tracks, kind: tracks, format: csv, path: /out/tracks.csv }
      - { name: labels, kind: labels, format: ome-zarr, path: /out/labels.zarr }
`;

const BOOK = `id: cell-tracking
version: 0.1.0
title: Track cells in a 3D time-lapse
summary: Segments nuclei in every frame, links them into tracks and measures each cell.
tags: [microscopy, tracking]
ships: { bio-utils: ^0.1, cellpose: ^0.1, ultrack: ^0.6 }
inputs:
  - name: movie
    accepts: { kind: volume, axes: tzyx, channels: 1-4 }
parameters:
  - { name: diameter, type: number, unit: px, default: 30, sets: segment.diameter }
steps:
  - { id: convert, run: bio-utils.convert, in: { image: $movie } }
  - { id: segment, run: cellpose.segment, in: { image: convert.zarr }, with: { model: nuclei } }
  - { id: track,   run: ultrack.track,    in: { labels: segment.masks } }
  - { id: measure, run: bio-utils.measure, in: { labels: track.labels, image: convert.zarr } }
outputs: { tracks: track.tracks, table: measure.table }
`;

const GUIDE = "# Cell tracking\n\n## When to use\n\n## When not to use\n\n## Parameters\n\n## Example\n";

let root: string;
let lib: Library;
const book = (): BookManifest => parse(BOOK);

async function put(path: string, text: string) {
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), text);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "pharos-lib-"));
  await put("ships/bio-utils/ship.yaml", BIO_UTILS);
  await put("ships/cellpose/ship.yaml", CELLPOSE);
  await put("ships/ultrack@0.6.1/ship.yaml", ULTRACK("0.6.1", "true"));
  await put("ships/ultrack@0.7.0/ship.yaml", ULTRACK("0.7.0", "false"));
  await put("books/cell-tracking/book.yaml", BOOK);
  await put("books/cell-tracking/GUIDE.md", GUIDE);
  // broken ones, reported as issues
  await put("ships/broken/ship.yaml", "id: broken\nversion: 0.1.0\nimage: x\noperations:\n  run:\n    summary: s\n    command: c {nope}\n    outputs: [{ name: o, kind: picture, format: csv, path: /out/o }]\n");
  await put("ships/wrong-folder/ship.yaml", BIO_UTILS.replace("version: 0.1.0", "version: 0.2.0"));
  await put("books/bad-yaml/book.yaml", "id: bad\nsteps: [\n");
  await put("books/no-guide/book.yaml", BOOK.replace("id: cell-tracking", "id: no-guide"));
  await put("ships/not-a-ship/README.md", "just a folder");
  lib = await Library.load([root]);
});

afterAll(() => rm(root, { recursive: true, force: true }));

describe("Library", () => {
  it("loads valid ships and books, and picks the newest version a range allows", () => {
    expect(lib.shipManifests().map((s) => `${s.id}@${s.version}`).sort()).toEqual(["bio-utils@0.1.0", "cellpose@0.1.0", "ultrack@0.6.1", "ultrack@0.7.0"]);
    expect(lib.versions("ultrack")).toEqual(["0.7.0", "0.6.1"]);
    expect(lib.ship("ultrack", "^0.6")?.version).toBe("0.6.1");
    expect(lib.ship("ultrack")?.version).toBe("0.7.0");
    expect(lib.ship("ultrack", "^1")).toBeUndefined();
    expect(lib.book("cell-tracking")?.problems).toEqual([]);
    expect(lib.book("no-guide")?.problems).toEqual([expect.objectContaining({ severity: "warning", message: expect.stringMatching(/GUIDE.md is missing/) })]);
  });

  it("reports broken manifests with file and line, and keeps them out", () => {
    const issues = lib.issues();
    const broken = issues.find((i) => i.id === "broken")!;
    expect(broken.problems).toContainEqual(expect.objectContaining({ path: "/operations/run/outputs/0/kind", line: 8, severity: "error" }));
    const folder = issues.find((i) => i.id === "bio-utils" && i.dir.endsWith("wrong-folder"))!;
    expect(folder.problems).toContainEqual(expect.objectContaining({ message: expect.stringMatching(/should be named "bio-utils"/), line: 1 }));
    const yaml = issues.find((i) => i.dir.endsWith("bad-yaml"))!;
    expect(yaml.problems[0]).toMatchObject({ severity: "error", line: expect.any(Number) });
    expect(issues.some((i) => i.dir.endsWith("not-a-ship"))).toBe(false);
    expect(lib.shipManifests().some((s) => s.id === "broken")).toBe(false);
    // errors sort before warnings
    expect(issues.findIndex((i) => i.id === "no-guide")).toBeGreaterThan(issues.findIndex((i) => i.id === "broken"));
  });

  it("checks command placeholders against parameters", async () => {
    const r = await Library.load([root]);
    const broken = r.issues().find((i) => i.id === "broken")!;
    // schema errors stop further checks, so fix the kind and look again
    await put("ships/broken/ship.yaml", "id: broken\nversion: 0.1.0\nimage: x\noperations:\n  run:\n    summary: s\n    command: c {nope}\n    outputs: [{ name: o, kind: table, format: csv, path: /out/o }]\n");
    const again = (await Library.load([root])).issues().find((i) => i.id === "broken")!;
    expect(broken.problems.length).toBeGreaterThan(0);
    expect(again.problems).toContainEqual(expect.objectContaining({ path: "/operations/run/command", message: "uses {nope}, which isn't one of its parameters", line: 7 }));
  });

  it("lists catalogue entries with GPU needs", () => {
    const entries = lib.bookEntries();
    expect(entries).toEqual([
      expect.objectContaining({ id: "cell-tracking", gpu: "optional", trust: "imported", installed: true }),
      expect.objectContaining({ id: "no-guide" }),
    ]);
    expect(lib.shipEntries().find((s) => s.id === "ultrack" && s.version === "0.6.1")?.gpu).toBe("optional");
  });
});

describe("checkBook", () => {
  const problems = (b: BookManifest) => checkBook(b, lib).map((p) => `${p.severity} ${p.path}: ${p.message}`);

  it("passes the cell tracking book", () => {
    expect(problems(book())).toEqual([]);
  });

  it("catches kind and format mismatches on wires", () => {
    const b = book();
    b.steps[2].in = { labels: "convert.zarr" }; // a volume into a labels port
    b.steps[1].in = { image: "$movie" };
    b.inputs![0].accepts.formats = ["czi"]; // cellpose can't read czi
    expect(problems(b)).toEqual(
      expect.arrayContaining([
        'error /steps/2/in/labels: "labels" needs labels, but convert.zarr is volume',
        'error /steps/1/in/image: "image" reads ome-zarr, tiff, but $movie is czi',
      ]),
    );
  });

  it("catches wires to later steps, unknown steps, inputs and outputs", () => {
    const b = book();
    b.steps[1].in = { image: "measure.table" };
    b.steps[3].in = { labels: "nope.labels", image: "$film" };
    b.outputs.tracks = "track.trax";
    const p = problems(b);
    expect(p).toContain(`error /steps/1/in/image: step "measure" runs later; a step can only use earlier steps' outputs`);
    expect(p).toContain('error /steps/3/in/labels: no step "nope"');
    expect(p).toContain('error /steps/3/in/image: no input "film" (inputs: movie)');
    expect(p).toContain('error /outputs/tracks: step "track" has no output "trax" (it has: tracks, labels)');
  });

  it("catches unconnected inputs, unknown ports and missing ships without follow-on noise", () => {
    const b = book();
    b.steps[3].in = { labels: "track.labels", extra: "convert.zarr" };
    b.steps[2].run = "ultrack.trak";
    const p = problems(b);
    expect(p).toContain("error /steps/2/run: ship \"ultrack\" 0.6.1 has no operation \"trak\" (it has: track)");
    expect(p).toContain("error /steps/3/in/extra: bio-utils.measure has no input \"extra\" (it has: labels, image)");
    expect(p).toContain('error /steps/3/in: required input "image" of bio-utils.measure isn\'t connected');
    // the wire from the failed step and the output pointing at it aren't reported again
    expect(p.filter((x) => x.includes("track."))).toEqual([]);

    const c = book();
    c.steps.push({ id: "extra", run: "napari.view", in: { image: "convert.zarr" } });
    expect(problems(c)).toEqual(expect.arrayContaining([
      'error /steps/4/run: ship "napari" isn\'t listed under ships',
      'error /steps/4/run: needs ship "napari", which isn\'t in the library',
    ]));
  });

  it("checks parameter values, targets and conflicts", () => {
    const b = book();
    b.steps[1].with = { model: "cyto9", sigma: 2 };
    b.parameters!.push({ name: "d2", type: "number", sets: "segment.diameter" });
    b.parameters!.push({ name: "m", type: "enum", options: ["nuclei", "tissue"], sets: ["segment.model", "segment.nope"] });
    b.parameters![0].default = 0;
    const p = problems(b);
    expect(p).toEqual(
      expect.arrayContaining([
        'error /steps/1/with/model: "model" must be one of cyto3, nuclei',
        "error /steps/1/with/sigma: cellpose.segment has no parameter \"sigma\"",
        'error /parameters/1/sets: "segment.diameter" is already set by parameter "diameter"',
        "error /parameters/2/sets: segment.model doesn't accept tissue",
        "error /parameters/2/sets: \"segment.model\" is also fixed in the step's \"with\"",
        "error /parameters/2/sets: cellpose.segment has no parameter \"nope\"",
        "error /parameters/0/default: default for segment.diameter must be between 1 and ∞",
      ]),
    );
  });

  it("warns about steps whose outputs nothing uses", () => {
    const b = book();
    b.steps.push({ id: "again", run: "cellpose.segment", in: { image: "convert.zarr" } });
    expect(problems(b)).toEqual(['warning /steps/4: nothing uses the outputs of step "again"']);
  });
});

describe("acceptedFormats", () => {
  it("takes the formats of the steps an input feeds, plus what a converter makes readable", () => {
    const b = book();
    expect(acceptedFormats(b, lib, converters(lib.shipManifests()))).toEqual([
      { input: "movie", kind: "volume", direct: ["tiff", "ome-tiff", "czi", "nd2", "lif"], converted: [] },
    ]);
    // without the convert step, the movie feeds cellpose (ome-zarr, tiff) and measure (ome-zarr):
    // only ome-zarr is read directly, and bio-utils.convert makes the rest readable
    b.steps = b.steps.filter((s) => s.id !== "convert");
    b.steps[0].in = { image: "$movie" };
    b.steps[2].in = { labels: "track.labels", image: "$movie" };
    expect(checkBook(b, lib).filter((p) => p.severity === "error")).toEqual([]);
    const [a] = acceptedFormats(b, lib, converters(lib.shipManifests()));
    expect(a.direct).toEqual(["ome-zarr"]);
    expect(a.converted).toEqual([
      { format: "tiff", via: "bio-utils.convert" },
      { format: "ome-tiff", via: "bio-utils.convert" },
      { format: "czi", via: "bio-utils.convert" },
      { format: "nd2", via: "bio-utils.convert" },
      { format: "lif", via: "bio-utils.convert" },
    ]);
  });
});

describe("resolveBook", () => {
  it("lists ships, what's downloaded and the download size, counting shared images once", () => {
    const sizes: Record<string, number> = { "pharos/bio-utils@sha256:aa": 1e9, "pharos/cellpose@sha256:bb": 5e9, "royerlab/ultrack:0.6.1": 3e9 };
    const r = resolveBook(book(), lib, { has: (i) => i.includes("bio-utils"), sizeBytes: (i) => sizes[i] }, { gpu: false });
    expect(r.runnable).toBe(true);
    expect(r.ships.map((s) => [s.id, s.version, s.downloaded, s.gpu])).toEqual([
      ["bio-utils", "0.1.0", true, "none"],
      ["cellpose", "0.1.0", false, "optional"],
      ["ultrack", "0.6.1", false, "optional"],
    ]);
    expect(r.downloadBytes).toBe(8e9);
  });

  it("is not runnable without a required GPU or a matching ship version", () => {
    const b = book();
    b.ships.ultrack = "^0.7";
    const lib2 = { ship: (id: string, range?: string) => lib.ship(id, range), versions: (id: string) => lib.versions(id) };
    // ultrack 0.7.0 requires the GPU (0.6.1 only prefers it)
    const gpuLess = resolveBook(b, lib2, { has: () => false }, { gpu: false });
    expect(gpuLess.runnable).toBe(false);
    expect(gpuLess.problems.map((p) => p.message)).toEqual(['"ultrack" needs an NVIDIA GPU, and this machine has none available to Docker']);
    expect(resolveBook(b, lib2, { has: () => false }, { gpu: true }).runnable).toBe(true);
    const strict = { ...lib2, ship: (id: string, range?: string) => (id === "ultrack" ? undefined : lib.ship(id, range)) };
    const r = resolveBook(b, strict, { has: () => false }, { gpu: false });
    expect(r.runnable).toBe(false);
    expect(r.problems.map((p) => p.message)).toContain('no version of "ultrack" in the library matches ^0.7 (have 0.7.0, 0.6.1)');
  });
});

describe("scaffold", () => {
  it("creates a ship and a book that load without errors", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pharos-new-"));
    try {
      await newShip(dir, "my-tool");
      await newBook(dir, "my-book", "my-tool");
      const fresh = await Library.load([dir]);
      expect(fresh.issues().flatMap((i) => i.problems.filter((p) => p.severity === "error"))).toEqual([]);
      expect(fresh.book("my-book")?.manifest?.ships).toEqual({ "my-tool": "^0.1" });
      await expect(newShip(dir, "my-tool")).rejects.toThrow(/already exists/);
      await expect(newShip(dir, "My Tool")).rejects.toThrow(/isn't a valid id/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("plans", () => {
  const artifact = (id: string, kind: "volume" | "table") => ({ id, kind, format: "tiff" as const, uri: `/x/${id}`, meta: {}, createdAt: "" });

  it("fills a step's parameters from its own values and the book parameters that set it", () => {
    const b = book();
    expect(stepParams(b.steps[1], b.parameters!, {})).toEqual({ model: "nuclei", diameter: 30 });
    expect(stepParams(b.steps[1], b.parameters!, { diameter: 12 })).toEqual({ model: "nuclei", diameter: 12 });
    expect(stepParams(b.steps[0], b.parameters!, { diameter: 12 })).toEqual({});
  });

  it("knows which steps a step waits for", () => {
    expect(dependencies(book().steps[3])).toEqual(["track", "convert"]);
    expect(dependencies(book().steps[0])).toEqual([]);
  });

  it("checks the data given and the parameter values", () => {
    const b = book();
    const ctx = { ships: lib, inventory: { has: () => false }, machine: { gpu: false }, artifacts: { a1: artifact("a1", "volume"), t1: artifact("t1", "table") } };
    expect(planProblems({ steps: b.steps, inputs: { movie: "a1" }, parameters: {} }, b, ctx)).toEqual([]);
    expect(planProblems({ steps: b.steps, inputs: { movie: "t1" }, parameters: {} }, b, ctx).map((p) => p.message)).toContain('"movie" needs volume data, this is table');
    expect(planProblems({ steps: b.steps, inputs: {}, parameters: { diameter: "big" } }, b, ctx).map((p) => p.message)).toEqual(['no data chosen for "movie"', '"diameter" must be a number']);
    const extra = planProblems({ steps: b.steps, inputs: { movie: "a1" }, parameters: {} }, b, { ...ctx, inputProblems: () => ["needs axes tzyx"] });
    expect(extra.map((p) => p.message)).toEqual(["needs axes tzyx"]);
  });
});
