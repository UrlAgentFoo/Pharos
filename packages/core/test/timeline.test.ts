import { describe, expect, it } from "vitest";
import { COMMANDS, Timeline, autoThreshold, defaultParams, erode, fillHoles, flipHorizontal, getCommand, invert, parseParams, paramsJsonSchema, rotate90, runSteps } from "@pharos/core";
import { syntheticImage, testKernels } from "./helpers.js";

const ctx = { kernels: await testKernels() };
const src = () => syntheticImage("uint8", 16, 8, 1, 7);

describe("command registry", () => {
  it("has unique ids and valid defaults", () => {
    expect(new Set(COMMANDS.map((c) => c.id)).size).toBe(COMMANDS.length);
    for (const c of COMMANDS) expect(parseParams(c, {})).toEqual(defaultParams(c));
  });

  it("validates untrusted parameters", () => {
    const blur = getCommand("gaussian-blur");
    expect(parseParams(blur, { sigma: "3" })).toEqual({ sigma: 3 });
    expect(() => parseParams(blur, { sigma: -1 })).toThrow(/at least/);
    expect(() => parseParams(blur, { sigma: "x" })).toThrow(/number/);
    expect(() => getCommand("nope")).toThrow(/unknown command/);
  });

  it("describes parameters as strict JSON Schema", () => {
    expect(paramsJsonSchema(getCommand("gaussian-blur"))).toMatchObject({ required: ["sigma"], additionalProperties: false });
  });

  it("thresholds to a mask, then runs binary commands on it", () => {
    const img = src();
    const [lo, hi] = autoThreshold(img.planes[0], "Otsu", true);
    const mask = runSteps(img, [{ command: "convert-to-mask", params: { method: "Otsu", dark: true } }], ctx);
    expect(mask.dtype).toBe("uint8");
    expect(Array.from(mask.planes[0])).toEqual(Array.from(img.planes[0], (v) => (v >= lo && v <= hi ? 255 : 0)));
    const manual = runSteps(img, [{ command: "convert-to-mask", params: { method: "Manual", lower: 100, upper: 200 } }], ctx);
    expect(manual.planes[0].every((v, i) => v === (img.planes[0][i] >= 100 && img.planes[0][i] <= 200 ? 255 : 0))).toBe(true);
    const { width, height } = img.shape;
    const eroded = runSteps(mask, [{ command: "erode", params: { iterations: 2, count: 3 } }, { command: "fill-holes" }], ctx);
    expect(eroded.planes[0]).toEqual(fillHoles(erode(mask.planes[0] as Uint8Array, width, height, 3, 2), width, height));
    expect(() => runSteps(img, [{ command: "erode" }], ctx)).toThrow(/needs a mask/);
  });

  it("sets the scale like ImageJ", () => {
    const out = runSteps(src(), [{ command: "set-scale", params: { distance: 50, known: 10, unit: "µm" } }], ctx);
    expect(out.calibration).toMatchObject({ pixelWidth: 0.2, pixelHeight: 0.2, pixelDepth: 0.2, unit: "µm" });
    expect(runSteps(out, [{ command: "set-scale", params: { distance: 0 } }], ctx).calibration.unit).toBe("pixel");
  });

  it("runs a recipe of steps", () => {
    const out = runSteps(src(), [{ command: "invert" }, { command: "flip-horizontal" }], ctx);
    expect(out.planes[0]).toEqual(flipHorizontal(invert(src())).planes[0]);
  });
});

describe("timeline", () => {
  it("applies, undoes and redoes without losing steps", () => {
    const t = new Timeline(src(), { ctx });
    t.apply("invert");
    t.apply("flip-horizontal");
    expect(t.marker).toBe(2);
    expect(t.undo()).toBe(true);
    expect(t.current().planes[0]).toEqual(invert(src()).planes[0]);
    expect(t.redo()).toBe(true);
    expect(t.current().planes[0]).toEqual(flipHorizontal(invert(src())).planes[0]);
    t.seek(0);
    expect(t.current()).toBe(t.source);
    expect(t.steps).toHaveLength(2);
  });

  it("inserts at the marker and replays later steps on top", () => {
    const t = new Timeline(src(), { ctx });
    t.apply("invert");
    t.undo();
    t.apply("rotate-right");
    expect(t.steps.map((s) => s.command)).toEqual(["rotate-right", "invert"]);
    expect(t.marker).toBe(1);
    t.redo();
    expect(t.current().planes[0]).toEqual(invert(rotate90(src(), "right")).planes[0]);
  });

  it("re-runs downstream steps when a step is edited, suppressed, moved or removed", () => {
    const t = new Timeline(src(), { ctx });
    const blur = t.apply("gaussian-blur", { sigma: 1 });
    t.apply("invert");
    const before = t.current();
    t.edit(blur.id, { sigma: 3 });
    expect(t.current().planes[0]).not.toEqual(before.planes[0]);
    t.setEnabled(blur.id, false);
    expect(t.current().planes[0]).toEqual(invert(src()).planes[0]);
    t.setEnabled(blur.id, true);
    t.move(blur.id, 1);
    expect(t.steps.map((s) => s.command)).toEqual(["invert", "gaussian-blur"]);
    t.remove(blur.id);
    expect(t.marker).toBe(1);
    expect(t.current().planes[0]).toEqual(invert(src()).planes[0]);
  });

  it("exports the applied, enabled steps as a recipe", () => {
    const t = new Timeline(src(), { ctx });
    t.apply("gaussian-blur", { sigma: 2 });
    const inv = t.apply("invert");
    t.apply("flip-vertical");
    t.setEnabled(inv.id, false);
    t.undo();
    expect(t.recipe().steps).toEqual([{ command: "gaussian-blur", params: { sigma: 2 } }]);
  });

  it("recomputes evicted intermediates within a memory budget", () => {
    const t = new Timeline(src(), { ctx, budgetBytes: 16 * 8 * 2 });
    t.apply("invert");
    t.apply("flip-horizontal");
    t.apply("flip-vertical");
    expect(t.cachedBytes()).toBeLessThanOrEqual(16 * 8 * 2);
    expect(t.imageAt(1).planes[0]).toEqual(invert(src()).planes[0]);
  });

  it("forks into an independent timeline that keeps the steps editable", () => {
    const t = new Timeline(src(), { ctx });
    t.apply("invert");
    t.apply("flip-horizontal");
    const f = t.fork(1);
    expect(f.steps.map((s) => s.command)).toEqual(["invert"]);
    expect(f.marker).toBe(1);
    expect(f.steps[0].id).not.toBe(t.steps[0].id);
    f.setEnabled(f.steps[0].id, false);
    expect(f.current().planes[0]).toEqual(src().planes[0]);
    expect(t.current().planes[0]).toEqual(flipHorizontal(invert(src())).planes[0]);
  });

  it("notifies listeners", () => {
    const t = new Timeline(src(), { ctx });
    let n = 0;
    const off = t.subscribe(() => n++);
    t.apply("invert");
    t.undo();
    off();
    t.redo();
    expect(n).toBe(2);
  });
});
