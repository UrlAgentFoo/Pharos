import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { BookManifest } from "@pharos/contracts";
import { Library, acceptedFormats, checkBook, checkShip, converters, dependencies, newBook, newShip, planProblems, resolveBook, stepParams } from "@pharos/books";

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
title: Cell tracking
summary: Segments nuclei in every frame, links them into tracks and measures each cell.
tags: [microscopy, tracking]
ships: { bio-utils: ^0.1, cellpose: ^0.1, ultrack: ^0.6 }
actions:
  track:
    title: Track over time
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
/** The book's one action, as tests change it. */
const track = (b: BookManifest) => b.actions.track;

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
  await put("ships/broken/ship.yaml", "id: broken\nversion: 0.1.0\nimage: x\noperations:\n  run:\n    summary: s\n    command: c {nope}\n    outputs: [{ name: o, kind: Picture, format: csv, path: /out/o }]\n");
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

  it("checks that the Controls design places the action's own parameters", () => {
    const b = book();
    track(b).controls = [
      { title: "Nuclei", params: ["diameter"] },
      { title: "Stain", params: ["diameter", "colour"], when: { has: ["channels"] } },
    ];
    expect(problems(b)).toEqual([
      'warning /actions/track/controls/1/params/0: "diameter" is already in an earlier section',
      'error /actions/track/controls/1/params/1: "track" has no parameter "colour"',
    ]);
  });

  it("catches kind and format mismatches on wires", () => {
    const b = book();
    track(b).steps[2].in = { labels: "convert.zarr" }; // a volume into a labels port
    track(b).steps[1].in = { image: "$movie" };
    track(b).inputs![0].accepts.formats = ["czi"]; // cellpose can't read czi
    expect(problems(b)).toEqual(
      expect.arrayContaining([
        'error /actions/track/steps/2/in/labels: "labels" needs labels, but convert.zarr is volume',
        'error /actions/track/steps/1/in/image: "image" reads ome-zarr, tiff, but $movie is czi',
      ]),
    );
  });

  it("catches wires to later steps, unknown steps, inputs and outputs", () => {
    const b = book();
    track(b).steps[1].in = { image: "measure.table" };
    track(b).steps[3].in = { labels: "nope.labels", image: "$film" };
    track(b).outputs.tracks = "track.trax";
    const p = problems(b);
    expect(p).toContain(`error /actions/track/steps/1/in/image: step "measure" runs later; a step can only use earlier steps' outputs`);
    expect(p).toContain('error /actions/track/steps/3/in/labels: no step "nope"');
    expect(p).toContain('error /actions/track/steps/3/in/image: no input "film" (inputs: movie)');
    expect(p).toContain('error /actions/track/outputs/tracks: step "track" has no output "trax" (it has: tracks, labels)');
  });

  it("catches unconnected inputs, unknown ports and missing ships without follow-on noise", () => {
    const b = book();
    track(b).steps[3].in = { labels: "track.labels", extra: "convert.zarr" };
    track(b).steps[2].run = "ultrack.trak";
    const p = problems(b);
    expect(p).toContain("error /actions/track/steps/2/run: ship \"ultrack\" 0.6.1 has no operation \"trak\" (it has: track)");
    expect(p).toContain("error /actions/track/steps/3/in/extra: bio-utils.measure has no input \"extra\" (it has: labels, image)");
    expect(p).toContain('error /actions/track/steps/3/in: required input "image" of bio-utils.measure isn\'t connected');
    // the wire from the failed step and the output pointing at it aren't reported again
    expect(p.filter((x) => x.includes("track."))).toEqual([]);

    const c = book();
    track(c).steps.push({ id: "extra", run: "napari.view", in: { image: "convert.zarr" } });
    expect(problems(c)).toEqual(expect.arrayContaining([
      'error /actions/track/steps/4/run: ship "napari" isn\'t listed under ships',
      'error /actions/track/steps/4/run: needs ship "napari", which isn\'t in the library',
    ]));
  });

  it("checks parameter values, targets and conflicts", () => {
    const b = book();
    track(b).steps[1].with = { model: "cyto9", sigma: 2 };
    track(b).parameters!.push({ name: "d2", type: "number", sets: "segment.diameter" });
    track(b).parameters!.push({ name: "m", type: "enum", options: ["nuclei", "tissue"], sets: ["segment.model", "segment.nope"] });
    track(b).parameters![0].default = 0;
    const p = problems(b);
    expect(p).toEqual(
      expect.arrayContaining([
        'error /actions/track/steps/1/with/model: "model" must be one of cyto3, nuclei',
        "error /actions/track/steps/1/with/sigma: cellpose.segment has no parameter \"sigma\"",
        'error /actions/track/parameters/1/sets: "segment.diameter" is already set by parameter "diameter"',
        "error /actions/track/parameters/2/sets: segment.model doesn't accept tissue",
        "error /actions/track/parameters/2/sets: \"segment.model\" is also fixed in the step's \"with\"",
        "error /actions/track/parameters/2/sets: cellpose.segment has no parameter \"nope\"",
        "error /actions/track/parameters/0/default: default for segment.diameter must be between 1 and ∞",
      ]),
    );
  });

  it("warns about steps whose outputs nothing uses", () => {
    const b = book();
    track(b).steps.push({ id: "again", run: "cellpose.segment", in: { image: "convert.zarr" } });
    expect(problems(b)).toEqual(['warning /actions/track/steps/4: nothing uses the outputs of step "again"']);
  });
});

describe("books with several actions", () => {
  it("checks each action on its own, with paths into it, and warns about ships no action uses", () => {
    const b = book();
    b.actions.measure = {
      title: "Count and measure",
      inputs: [{ name: "image", accepts: { kind: "volume" } }],
      steps: [{ id: "segment", run: "cellpose.segment", in: { image: "$movie" } }],
      outputs: { masks: "segment.masks" },
    };
    b.ships.render = "^0.1";
    const p = checkBook(b, lib).map((x) => `${x.severity} ${x.path}: ${x.message}`);
    expect(p).toContain('error /actions/measure/steps/0/in/image: no input "movie" (inputs: image)');
    expect(p).toContain('warning /ships/render: no action uses ship "render"');
    expect(p.filter((x) => x.includes("/actions/track/"))).toEqual([]);
    b.actions.measure.steps[0].in = { image: "$image" };
    const formats = acceptedFormats(b, lib, converters(lib.shipManifests()));
    expect(formats.map((f) => `${f.action}.${f.input}`)).toEqual(["track.movie", "measure.image"]);
    expect(formats[1].direct).toEqual(["ome-zarr", "tiff"]);
  });

  it("checks what opens with the data and what comes next", () => {
    const b = book();
    b.actions.measure = {
      title: "Count and measure",
      inputs: [{ name: "image", accepts: { kind: "volume" } }],
      steps: [{ id: "segment", run: "cellpose.segment", in: { image: "$image" } }],
      outputs: { masks: "segment.masks" },
      next: ["track", "trace", "measure"],
    };
    b.opens_with = "measure";
    const p = checkBook(b, lib).map((x) => `${x.severity} ${x.path}: ${x.message}`);
    expect(p).toContain('error /actions/measure/next/1: the book has no action "trace"');
    expect(p).toContain('warning /actions/measure/next/2: "measure" offers itself next; its own Controls already re-run it');
    expect(p).toContain('warning /opens_with: "measure" isn\'t marked quick, so opening data only proposes it');
    b.actions.measure.quick = true;
    b.opens_with = "count";
    expect(checkBook(b, lib).map((x) => `${x.severity} ${x.path}: ${x.message}`)).toContain('error /opens_with: the book has no action "count"');
  });
});

describe("views", () => {
  it("take one input and make something a window can show", () => {
    const ship = parse(CELLPOSE);
    ship.operations.segment.view = true;
    ship.operations.segment.outputs[0].format = "parquet";
    expect(checkShip(ship).map((p) => p.message)).toContain("a view makes one output a window can show (tiff, ome-tiff, ome-zarr, csv, ply, mp4, html, json)");
    ship.operations.segment.outputs = [{ name: "page", kind: "report", format: "html", path: "/out/view.html" }];
    expect(checkShip(ship).filter((p) => p.severity === "error")).toEqual([]);
    ship.operations.segment.inputs.push({ name: "other", kind: "volume", formats: ["tiff"] });
    expect(checkShip(ship).map((p) => p.message)).toContain("a view takes exactly one input: the data it shows");
  });
});

describe("formats", () => {
  it("adds the formats ships declare, and warns about ones nobody declares", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pharos-fmt-"));
    try {
      const ship = (id: string, formats: string) => `id: ${id}
version: 0.1.0
image: x/${id}:1
${formats}operations:
  run:
    summary: s
    command: c
    inputs: [{ name: cells, kind: single-cell, formats: [h5ad] }]
    outputs: [{ name: table, kind: table, format: loom, path: /out/t.loom }]
`;
      await mkdir(join(dir, "ships/scanpy"), { recursive: true });
      await writeFile(join(dir, "ships/scanpy/ship.yaml"), ship("scanpy", "formats:\n  h5ad: { kind: single-cell, title: AnnData, extensions: [.h5ad] }\n"));
      const l = await Library.load([dir]);
      expect(l.formats().h5ad).toEqual({ kind: "single-cell", title: "AnnData", extensions: [".h5ad"] });
      expect(l.formats().tiff.title).toBe("TIFF");
      const warnings = l.issues().flatMap((i) => i.problems.map((p) => p.message));
      expect(warnings).toEqual(['format "loom" isn\'t built in and no ship declares it under formats, so files in it won\'t be recognised']);
      expect(l.shipManifests().map((s) => s.id)).toEqual(["scanpy"]); // warnings don't keep it out
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("acceptedFormats", () => {
  it("takes the formats of the steps an input feeds, plus what a converter makes readable", () => {
    const b = book();
    expect(acceptedFormats(b, lib, converters(lib.shipManifests()))).toEqual([
      { action: "track", input: "movie", kind: "volume", direct: ["tiff", "ome-tiff", "czi", "nd2", "lif"], converted: [] },
    ]);
    // without the convert step, the movie feeds cellpose (ome-zarr, tiff) and measure (ome-zarr):
    // only ome-zarr is read directly, and bio-utils.convert makes the rest readable
    track(b).steps = track(b).steps.filter((s) => s.id !== "convert");
    track(b).steps[0].in = { image: "$movie" };
    track(b).steps[2].in = { labels: "track.labels", image: "$movie" };
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
    expect(stepParams(track(b).steps[1], track(b).parameters!, {})).toEqual({ model: "nuclei", diameter: 30 });
    expect(stepParams(track(b).steps[1], track(b).parameters!, { diameter: 12 })).toEqual({ model: "nuclei", diameter: 12 });
    expect(stepParams(track(b).steps[0], track(b).parameters!, { diameter: 12 })).toEqual({});
  });

  it("knows which steps a step waits for", () => {
    expect(dependencies(track(book()).steps[3])).toEqual(["track", "convert"]);
    expect(dependencies(track(book()).steps[0])).toEqual([]);
  });

  it("checks the data given and the parameter values", () => {
    const b = book();
    const ctx = { ships: lib, inventory: { has: () => false }, machine: { gpu: false }, artifacts: { a1: artifact("a1", "volume"), t1: artifact("t1", "table") } };
    const recipe = { book: b, action: track(b) };
    expect(planProblems({ steps: track(b).steps, inputs: { movie: "a1" }, parameters: {} }, recipe, ctx)).toEqual([]);
    expect(planProblems({ steps: track(b).steps, inputs: { movie: "t1" }, parameters: {} }, recipe, ctx).map((p) => p.message)).toContain('"movie" needs volume data, this is table');
    expect(planProblems({ steps: track(b).steps, inputs: {}, parameters: { diameter: "big" } }, recipe, ctx).map((p) => p.message)).toEqual(['no data chosen for "movie"', '"diameter" must be a number']);
    const extra = planProblems({ steps: track(b).steps, inputs: { movie: "a1" }, parameters: {} }, recipe, { ...ctx, inputProblems: () => ["needs axes tzyx"] });
    expect(extra.map((p) => p.message)).toEqual(["needs axes tzyx"]);
  });
});
