import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { PUBLISHED_SCHEMAS, type Plan, validateBook, validatePlan, validateShip } from "@pharos/contracts";

const fixture = (name: string) => parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

describe("ship.yaml", () => {
  it("accepts the cellpose example", () => {
    const r = validateShip(fixture("cellpose.ship.yaml"));
    expect(r).toMatchObject({ ok: true });
  });

  it("reports unknown fields, bad kinds and outputs outside /out with their paths", () => {
    const ship = fixture("cellpose.ship.yaml");
    ship.colour = "blue";
    ship.operations.segment.inputs[0].kind = "picture";
    ship.operations.segment.outputs[0].path = "/tmp/masks.zarr";
    const r = validateShip(ship);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const paths = r.problems.map((p) => p.path);
    expect(r.problems).toContainEqual({ path: "/", message: 'unknown field "colour"' });
    expect(paths).toContain("/operations/segment/inputs/0/kind");
    expect(paths).toContain("/operations/segment/outputs/0/path");
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
    book.steps[0].run = "bio-utils"; // no operation
    book.steps[1].in.image = "convert"; // no output name
    book.parameters[0].sets = "diameter"; // no step
    const r = validateBook(book);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const paths = r.problems.map((p) => p.path);
    expect(paths).toEqual(expect.arrayContaining(["/steps/0/run", "/steps/1/in/image"]));
    expect(paths.some((p) => p.startsWith("/parameters/0/sets"))).toBe(true);
  });

  it("rejects ship ids and output names that don't match the naming rules", () => {
    const book = fixture("cell-tracking.book.yaml");
    book.ships.Ultrack = "^0.6";
    book.outputs["Tracks!"] = "track.tracks";
    const r = validateBook(book);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems.map((p) => p.path)).toEqual(expect.arrayContaining(["/ships", "/outputs"]));
  });

  it("allows books that start from parameters alone", () => {
    const book = fixture("cell-tracking.book.yaml");
    delete book.inputs;
    expect(validateBook(book).ok).toBe(true);
  });
});

describe("plans", () => {
  it("validates a plan built from a book", () => {
    const book = fixture("cell-tracking.book.yaml");
    const plan: Plan = {
      id: "p1",
      workspace: "w",
      source: "book",
      book: { id: book.id, version: book.version },
      title: book.title,
      inputs: { movie: "a1" },
      parameters: { diameter: 24 },
      steps: book.steps,
      ships: [{ id: "cellpose", version: "0.1.0", image: "pharos/cellpose@sha256:00", downloaded: false, gpu: "optional" }],
      problems: [],
      status: "proposed",
      createdAt: new Date().toISOString(),
    };
    expect(validatePlan(plan).ok).toBe(true);
    expect(validatePlan({ ...plan, status: "maybe" }).ok).toBe(false);
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
