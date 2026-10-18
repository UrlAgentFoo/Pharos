import { describe, expect, it } from "vitest";
import type { Artifact } from "@pharos/contracts";
import { NODE_W, chainHtml, chainModel, layoutChain, tableLine } from "../src/chain-graph.js";
import type { DataDoc, DataStep } from "../src/workspace.js";

const OUTPUTS: Record<string, { name: string; kind: string; format: string }[]> = {
  "fea.load-test": [
    { name: "stress", kind: "mesh", format: "ply" },
    { name: "results", kind: "table", format: "csv" },
  ],
  "cad.bracket": [
    { name: "solid", kind: "cad", format: "step" },
    { name: "model", kind: "mesh", format: "ply" },
  ],
  "slicer.slice": [
    { name: "toolpath", kind: "mesh", format: "ply" },
    { name: "print", kind: "table", format: "csv" },
  ],
};
const look = {
  outputs: (run: string) => OUTPUTS[run] ?? [],
  formatTitle: (f: string) => ({ step: "STEP model", ply: "PLY", csv: "CSV" })[f] ?? f,
  kindTitle: (k: string) => ({ cad: "CAD part", mesh: "Mesh", table: "Table" })[k] ?? k,
};
const parts = { id: "printed-parts", title: "Printed parts" };
const step = (id: string, run: string, inputs: Record<string, string>, block: string, action: string, extra: Partial<DataStep> = {}): DataStep => ({
  id,
  run,
  in: inputs,
  with: {},
  book: { ...parts, action, title: `Printed parts › ${action}` },
  block,
  status: "done",
  ...extra,
});
/** The demo's window: the part load-tested as it opened, then redesigned, tested and sliced. */
const doc = {
  kind: "data",
  id: "d1",
  ref: 1,
  name: "bracket.step",
  workspace: "w",
  source: { id: "a", kind: "cad", format: "step", name: "bracket.step" } as Artifact,
  steps: [
    step("test", "fea.load-test", { part: "$data" }, "b1", "test"),
    step("design", "cad.bracket", { like: "$data" }, "b2", "strengthen", { reason: "Half of 15 kg per bracket; ribs help most." }),
    step("test_2", "fea.load-test", { part: "design.solid" }, "b2", "strengthen", { reason: "Half of 15 kg per bracket; ribs help most." }),
    step("slice", "slicer.slice", { model: "design.model" }, "b2", "strengthen", { reason: "Half of 15 kg per bracket; ribs help most." }),
  ],
  marker: 4,
  ui: { controls: true, history: "full" },
} as DataDoc;

describe("a window's history as a chain", () => {
  it("makes a node per step, wired by what it takes, and a run per block with its reason", () => {
    const { nodes, runs } = chainModel(doc, {
      ...look,
      tables: { test: { result: "would break", detail: "safety factor 0.63" }, slice: { result: "4h 28m", detail: "filament 43.1 g" } },
      summaries: { "printed-parts/test": "Holds the part by its wall side and loads its top." },
    });
    expect(nodes.map((n) => [n.key, n.marker, n.title, n.tool, n.run])).toEqual([
      ["data", 0, "bracket.step", "STEP model", -1],
      ["test", 1, "Load test", "fea", 0],
      ["design", 2, "Bracket", "cad", 1],
      ["test_2", 3, "Load test", "fea", 1],
      ["slice", 4, "Slice", "slicer", 1],
    ]);
    expect(nodes.find((n) => n.key === "test_2")!.inputs).toEqual([{ from: "design", label: "STEP model" }]);
    expect(nodes.find((n) => n.key === "slice")!.inputs).toEqual([{ from: "design", label: "PLY" }]);
    expect(nodes.find((n) => n.key === "test")).toMatchObject({ result: "would break", detail: "safety factor 0.63" });
    // a step with no table to sum up says what kinds it made
    expect(nodes.find((n) => n.key === "design")!.result).toBe("CAD part · Mesh");
    expect(runs).toEqual([
      { title: "Printed parts › test", status: "done", summary: "Holds the part by its wall side and loads its top." },
      { title: "Printed parts › strengthen", status: "done", reason: "Half of 15 kg per bracket; ribs help most." },
    ]);
  });

  it("lays each run out in its own band, left to right by how far each step is from the data", () => {
    const { nodes, runs } = chainModel(doc, look);
    const layout = layoutChain(nodes, runs);
    const at = (key: string) => layout.nodes.find((n) => n.key === key)!;
    expect(at("data").x).toBeLessThan(at("test").x);
    expect(at("design").x).toBe(at("test").x); // both one step from the data
    expect(at("test_2").x).toBeGreaterThan(at("design").x);
    expect(at("slice").x).toBe(at("test_2").x); // both take from the design: stacked
    expect(at("slice").y).toBeGreaterThan(at("test_2").y);
    const [first, second] = layout.groups;
    expect(at("test").y).toBeGreaterThan(first.y);
    expect(at("test").y + 74).toBeLessThanOrEqual(first.y + first.h);
    expect(second.y).toBeGreaterThanOrEqual(first.y + first.h);
    expect(layout.edges.map((e) => `${e.from}>${e.to}`)).toEqual(["data>test", "data>design", "design>test_2", "design>slice"]);
    expect(layout.width).toBeGreaterThanOrEqual(at("slice").x + NODE_W);
  });

  it("draws nodes as buttons that say what they are, and the reason in the run's frame", () => {
    const { nodes, runs } = chainModel(doc, { ...look, tables: { test: { result: "would break", detail: "safety factor 0.63" } } });
    const html = chainHtml(layoutChain(nodes, runs));
    expect(html.match(/<button[^>]*class="cg-node/g)).toHaveLength(5);
    expect(html).toContain('data-marker="3"');
    expect(html).toContain('aria-label="Load test, fea, would break, safety factor 0.63, done. Show it"');
    expect(html).toContain("Half of 15 kg per bracket; ribs help most.");
    expect(html).toContain(">STEP model</text>");
  });

  it("sums up a results table in a line", () => {
    expect(tableLine("verdict,safety_factor,target\nwould break,0.63,2\n")).toEqual({ result: "would break", detail: "safety factor 0.63" });
    expect(tableLine("print_time,filament_g\n4h 28m,43.1")).toEqual({ result: "4h 28m", detail: "filament 43.1 g" });
    expect(tableLine("peak_stress_mpa\n77.4")).toEqual({ result: "77.4 MPa" });
    expect(tableLine('name,note\n"a, b",c\nd,e\nf,g')).toEqual({ result: "3 rows", detail: "2 columns" });
    expect(tableLine("label\n")).toEqual({ result: "No rows" });
  });
});
