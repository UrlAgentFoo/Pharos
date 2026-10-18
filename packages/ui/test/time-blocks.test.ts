import { describe, expect, it } from "vitest";
import { type DataDoc, type DataStep, blockAt, timeBlocks } from "../src/workspace.js";

const step = (id: string, extra: Partial<DataStep> = {}): DataStep => ({ id, run: "image-ops.gaussian_blur", in: {}, with: {}, status: "done", ...extra });
const doc = (steps: DataStep[], marker = steps.length) => ({ steps, marker }) as unknown as DataDoc;
const book = { id: "nuclei", title: "Segment and measure", action: "measure" };

describe("timeBlocks", () => {
  it("makes one block per run, however many steps it added", () => {
    const d = doc([step("a", { block: "r1" }), step("b", { block: "r2", book }), step("c", { block: "r2", book }), step("d", { block: "r2", book }), step("e", { block: "r3" })]);
    expect(timeBlocks(d).map((b) => [b.first, b.last, b.title])).toEqual([
      [0, 0, "Gaussian blur"],
      [1, 3, "Segment and measure"],
      [4, 4, "Gaussian blur"],
    ]);
  });

  it("keeps two runs of the same book apart", () => {
    expect(timeBlocks(doc([step("a", { block: "r1", book }), step("b", { block: "r2", book })]))).toHaveLength(2);
  });

  it("groups steps saved without run ids by their book action", () => {
    expect(timeBlocks(doc([step("a", { book }), step("b", { book }), step("c"), step("d")])).map((b) => [b.first, b.last])).toEqual([
      [0, 1],
      [2, 2],
      [3, 3],
    ]);
  });

  it("gives a run the status of what's under way, then what went wrong", () => {
    const run = (statuses: DataStep["status"][]) => timeBlocks(doc(statuses.map((s, i) => step(`s${i}`, { block: "r", status: s }))))[0].status;
    expect(run(["done", "running", "proposed"])).toBe("running");
    expect(run(["done", "failed", "stale"])).toBe("failed");
    expect(run(["done", "done"])).toBe("done");
  });
});

describe("blockAt", () => {
  it("finds the run holding a step, and -1 for the data itself", () => {
    const blocks = timeBlocks(doc([step("a", { block: "r1" }), step("b", { block: "r2" }), step("c", { block: "r2" })]));
    expect([0, 1, 2, 3].map((m) => blockAt(blocks, m))).toEqual([-1, 0, 1, 1]);
  });
});
