import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { BUILT_IN_FORMATS, PUBLISHED_SCHEMAS, type Plan, bookAction, sniffFormat, validateBook, validatePlan, validateShip } from "@pharos/contracts";

const fixture = (name: string) => parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

describe("ship.yaml", () => {
  it("accepts the cellpose example", () => {
    const r = validateShip(fixture("cellpose.ship.yaml"));
    expect(r).toMatchObject({ ok: true });
  });

  it("reports unknown fields, bad kinds and outputs outside /out with their paths", () => {
    const ship = fixture("cellpose.ship.yaml");
    ship.colour = "blue";
    ship.operations.segment.inputs[0].kind = "Picture!";
    ship.operations.segment.outputs[0].path = "/tmp/masks.zarr";
    const r = validateShip(ship);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const paths = r.problems.map((p) => p.path);
    expect(r.problems).toContainEqual({ path: "/", message: 'unknown field "colour"' });
    expect(paths).toContain("/operations/segment/inputs/0/kind");
    expect(paths).toContain("/operations/segment/outputs/0/path");
  });

  it("takes kinds and formats Pharos doesn't know, and formats a ship declares", () => {
    const ship = fixture("cellpose.ship.yaml");
    ship.operations.segment.inputs[0] = { name: "cells", kind: "single-cell", formats: ["h5ad"] };
    ship.formats = { h5ad: { kind: "single-cell", title: "AnnData", extensions: [".h5ad"] } };
    expect(validateShip(ship)).toMatchObject({ ok: true });
    ship.formats.h5ad.extensions = ["h5ad"]; // needs the dot
    expect(validateShip(ship).ok).toBe(false);
  });

  it("rejects bad ids, versions and operation names", () => {
    const ship = fixture("cellpose.ship.yaml");
    ship.id = "Cellpose";
    ship.version = "1.0";
    ship.operations["Bad Op"] = ship.operations.segment;
    const r = validateShip(ship);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const paths = r.problems.map((p) => p.path);
    expect(paths).toEqual(expect.arrayContaining(["/id", "/version"]));
    expect(r.problems).toContainEqual({ path: "/operations", message: '"Bad Op" is not a valid name here' });
  });
});

describe("book.yaml", () => {
  it("accepts the cell tracking example", () => {
    expect(validateBook(fixture("cell-tracking.book.yaml"))).toMatchObject({ ok: true });
  });

  it("checks step references, wiring and parameter targets", () => {
    const book = fixture("cell-tracking.book.yaml");
    const track = book.actions.track;
    track.steps[0].run = "bio-utils"; // no operation
    track.steps[1].in.image = "convert"; // no output name
    track.parameters[0].sets = "diameter"; // no step
    const r = validateBook(book);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const paths = r.problems.map((p) => p.path);
    expect(paths).toEqual(expect.arrayContaining(["/actions/track/steps/0/run", "/actions/track/steps/1/in/image"]));
    expect(paths.some((p) => p.startsWith("/actions/track/parameters/0/sets"))).toBe(true);
  });

  it("rejects ship ids, action names and output names that don't match the naming rules", () => {
    const book = fixture("cell-tracking.book.yaml");
    book.ships.Ultrack = "^0.6";
    book.actions.track.outputs["Tracks!"] = "track.tracks";
    book.actions["Do It"] = book.actions.measure;
    const r = validateBook(book);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems.map((p) => p.path)).toEqual(expect.arrayContaining(["/ships", "/actions/track/outputs", "/actions"]));
  });

  it("needs at least one action, each with a title and steps", () => {
    const book = fixture("cell-tracking.book.yaml");
    expect(validateBook({ ...book, actions: {} }).ok).toBe(false);
    delete book.actions.measure.title;
    expect(validateBook(book).ok).toBe(false);
  });

  it("allows actions that start from parameters alone", () => {
    const book = fixture("cell-tracking.book.yaml");
    delete book.actions.track.inputs;
    expect(validateBook(book).ok).toBe(true);
  });

  it("finds an action by name, or the first", () => {
    const book = fixture("cell-tracking.book.yaml");
    expect(bookAction(book)).toMatchObject({ name: "track", title: "Track over time" });
    expect(bookAction(book, "measure")).toMatchObject({ name: "measure" });
    expect(bookAction(book, "nope")).toBeUndefined();
  });
});

describe("formats", () => {
  it("recognises built-in formats, longest extension first, and folders by their contents", () => {
    expect(sniffFormat("a.ome.tif", false)).toEqual({ kind: "volume", format: "ome-tiff" });
    expect(sniffFormat("A.TIF", false)).toEqual({ kind: "volume", format: "tiff" });
    expect(sniffFormat("nuclei.zarr", true)).toEqual({ kind: "volume", format: "ome-zarr" });
    expect(sniffFormat("nuclei.zarr", false)).toBeNull();
    expect(sniffFormat("cylinder", true, ["0", "constant", "system"])).toEqual({ kind: "sim-case", format: "openfoam-case" });
    expect(sniffFormat("notes.txt", false)).toBeNull();
  });

  it("recognises formats ships declare", () => {
    const formats = { ...BUILT_IN_FORMATS, h5ad: { kind: "single-cell", extensions: [".h5ad"] } };
    expect(sniffFormat("pbmc.h5ad", false, [], formats)).toEqual({ kind: "single-cell", format: "h5ad" });
    expect(sniffFormat("pbmc.h5ad", false)).toBeNull();
  });

  it("prefers the folder format that names the most of its entries", () => {
    const formats = {
      ...BUILT_IN_FORMATS,
      "photo-set": { kind: "photos", folder: true, contains: ["images"] },
      colmap: { kind: "sfm", folder: true, contains: ["images", "sparse"] },
    };
    expect(sniffFormat("garden", true, ["images", "sparse"], formats)).toEqual({ kind: "sfm", format: "colmap" });
    expect(sniffFormat("garden", true, ["images"], formats)).toEqual({ kind: "photos", format: "photo-set" });
    expect(sniffFormat("scene.splat.ply", false, [], { ...formats, "splat-ply": { kind: "splat", extensions: [".splat.ply"] } })).toEqual({ kind: "splat", format: "splat-ply" });
  });
});

describe("plans", () => {
  it("validates a plan built from a book", () => {
    const book = fixture("cell-tracking.book.yaml");
    const plan: Plan = {
      id: "p1",
      workspace: "w",
      source: "book",
      book: { id: book.id, version: book.version, action: "track" },
      title: book.title,
      inputs: { movie: "a1" },
      parameters: { diameter: 24 },
      steps: book.actions.track.steps,
      ships: [{ id: "cellpose", version: "0.1.0", image: "pharos/cellpose@sha256:00", downloaded: false, gpu: "optional" }],
      problems: [],
      status: "proposed",
      createdAt: new Date().toISOString(),
    };
    expect(validatePlan(plan).ok).toBe(true);
    expect(validatePlan({ ...plan, status: "maybe" }).ok).toBe(false);
    expect(validatePlan({ ...plan, book: { id: book.id, version: book.version } }).ok).toBe(false); // which action

  });
});

describe("published schemas", () => {
  it("match the committed JSON files (run `npm run build -w @pharos/contracts` to update)", () => {
    for (const [file, schema] of Object.entries(PUBLISHED_SCHEMAS)) {
      const committed = JSON.parse(readFileSync(new URL(`../schemas/${file}`, import.meta.url), "utf8"));
      expect(committed, file).toEqual(JSON.parse(JSON.stringify(schema)));
    }
  });
});
