import { describe, expect, it } from "vitest";
import { type Artifact, type ShipManifest, validateShip } from "@pharos/contracts";
import { COMMANDS, type Image, type ToolContext, ToolRegistry, builtinTool, getCommand, invert, isArtifact, withDefaults } from "@pharos/core";
import { syntheticImage, testKernels } from "./helpers.js";

const kernels = await testKernels();
const src = () => syntheticImage("uint8", 16, 8, 1, 7);

const artifact = (id: string, kind: Artifact["kind"] = "volume"): Artifact => ({
  id,
  kind,
  format: kind === "labels" ? "ome-zarr" : "tiff",
  uri: `/tmp/${id}`,
  meta: {},
  createdAt: new Date(0).toISOString(),
});

const cellpose: ShipManifest = {
  id: "cellpose",
  version: "0.1.0",
  image: "pharos/cellpose@sha256:00",
  operations: {
    segment: {
      summary: "Segment nuclei.",
      command: "cellpose-run --model {model} --diameter {diameter}",
      inputs: [{ name: "image", kind: "volume", formats: ["ome-zarr", "tiff"] }],
      parameters: [
        { name: "model", type: "enum", options: ["cyto3", "nuclei"], default: "cyto3" },
        { name: "diameter", type: "number", unit: "px", default: 30, min: 1 },
      ],
      outputs: [{ name: "masks", kind: "labels", format: "ome-zarr", path: "/out/masks.zarr" }],
      cache: { deterministic: true },
    },
  },
};

describe("built-in tools", () => {
  it("wraps every command with an image in and an image out", () => {
    const reg = new ToolRegistry();
    expect(reg.list()).toHaveLength(COMMANDS.length);
    const blur = reg.get("builtin.gaussian-blur")!;
    expect(blur.inputs).toEqual([{ name: "image", kind: "volume" }]);
    expect(blur.params).toContainEqual(expect.objectContaining({ name: "sigma", type: "number", default: 2, unit: "px" }));
  });

  it("runs in-process on an image", async () => {
    const out = await builtinTool(getCommand("invert")).run({ image: src() }, {}, { kernels });
    expect((out.image as Image).planes[0]).toEqual(invert(src()).planes[0]);
  });

  it("loads an artifact input through the context", async () => {
    const ctx: ToolContext = { kernels, load: async () => src() };
    const out = await builtinTool(getCommand("invert")).run({ image: artifact("a1") }, {}, ctx);
    expect(isArtifact(out.image)).toBe(false);
    await expect(builtinTool(getCommand("invert")).run({ image: artifact("a1") }, {}, { kernels })).rejects.toThrow(/loader/);
  });
});

describe("ship tools", () => {
  it("validates as a ship manifest and becomes one tool per operation", () => {
    expect(validateShip(cellpose).ok).toBe(true);
    const reg = new ToolRegistry([]);
    reg.addShip(cellpose);
    const seg = reg.get("cellpose.segment")!;
    expect(seg.source).toEqual({ type: "ship", ship: "cellpose", version: "0.1.0", operation: "segment" });
    expect(seg.outputs).toEqual([{ name: "masks", kind: "labels", formats: ["ome-zarr"] }]);
    expect(seg.deterministic).toBe(true);
    expect(reg.accepting("volume", "tiff").map((t) => t.id)).toEqual(["cellpose.segment"]);
    expect(reg.accepting("volume", "csv")).toEqual([]);
  });

  it("replaces an older version of the same ship", () => {
    const reg = new ToolRegistry([]);
    reg.addShip(cellpose);
    reg.addShip({ ...cellpose, version: "0.2.0" });
    expect(reg.list().map((t) => t.source)).toEqual([expect.objectContaining({ version: "0.2.0" })]);
  });

  it("hands artifacts and defaulted parameters to the orchestrator", async () => {
    const calls: unknown[] = [];
    const ctx: ToolContext = {
      kernels,
      runShip: async (source, inputs, params) => {
        calls.push({ source, inputs, params });
        return { masks: artifact("m1", "labels") };
      },
    };
    const reg = new ToolRegistry([]);
    reg.addShip(cellpose);
    const out = await reg.get("cellpose.segment")!.run({ image: artifact("a1") }, { model: "nuclei" }, ctx);
    expect(out.masks).toMatchObject({ id: "m1", kind: "labels" });
    expect(calls).toEqual([{ source: expect.objectContaining({ operation: "segment" }), inputs: { image: expect.objectContaining({ id: "a1" }) }, params: { model: "nuclei", diameter: 30 } }]);
  });

  it("stores an in-memory image before handing it to a ship", async () => {
    let stored: string | undefined;
    const ctx: ToolContext = {
      kernels,
      store: async (img, hint) => {
        stored = `${hint.kind}:${img.shape.width}`;
        return artifact("s1");
      },
      runShip: async (_s, inputs) => ({ masks: { ...inputs.image, id: "m2", kind: "labels" } }),
    };
    const reg = new ToolRegistry([]);
    reg.addShip(cellpose);
    await reg.get("cellpose.segment")!.run({ image: src() }, {}, ctx);
    expect(stored).toBe("volume:16");
  });

  it("refuses to run without the orchestrator, or with a missing input", async () => {
    const reg = new ToolRegistry([]);
    reg.addShip(cellpose);
    const seg = reg.get("cellpose.segment")!;
    await expect(seg.run({ image: artifact("a1") }, {}, { kernels })).rejects.toThrow(/local server/);
    await expect(seg.run({}, {}, { kernels, runShip: async () => ({}) })).rejects.toThrow(/missing input "image"/);
  });
});

describe("parameter checking", () => {
  const specs = cellpose.operations.segment.parameters!;
  it("fills defaults and rejects bad values", () => {
    expect(withDefaults(specs, {})).toEqual({ model: "cyto3", diameter: 30 });
    expect(() => withDefaults(specs, { model: "cyto9" })).toThrow(/one of cyto3, nuclei/);
    expect(() => withDefaults(specs, { diameter: "30" })).toThrow(/a number/);
    expect(() => withDefaults(specs, { diameter: 0 })).toThrow(/between 1/);
    expect(() => withDefaults(specs, { sigma: 1 })).toThrow(/unknown parameter "sigma"/);
    expect(() => withDefaults([{ name: "n", type: "integer" }], {})).toThrow(/required/);
  });
});
