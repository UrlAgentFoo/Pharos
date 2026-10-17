import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { ChainError, Library, expandChain } from "@pharos/books";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
let lib: Library;
beforeAll(async () => {
  lib = await Library.load([REPO]);
});

describe("chains of book actions and operations", () => {
  it("expands a book link into its steps, renamed and wired through, and an operation link into one step", () => {
    const { steps, links } = expandChain(
      [
        { id: "test", book: "printed-parts", action: "test", in: { part: "$part" }, parameters: { load: 147 }, why: "A 15 kg shelf on one bracket." },
        { id: "slice", run: "slicer.slice", in: { model: "test.stress" }, parameters: { up: "y" }, why: "The print time." },
      ],
      lib,
    );
    expect(steps).toEqual([
      { id: "test_test", run: "fea.load-test", in: { part: "$part" }, with: { load: 147, material: "pla", target: 2 } },
      { id: "slice", run: "slicer.slice", in: { model: "test_test.stress" }, with: { up: "y" } },
    ]);
    expect(links).toEqual([
      { id: "test", title: "Printed parts › Load-test it", book: { id: "printed-parts", version: "0.1.0", action: "test" }, why: "A 15 kg shelf on one bracket.", steps: ["test_test"] },
      { id: "slice", title: "Slice", run: "slicer.slice", why: "The print time.", steps: ["slice"] },
    ]);
  });

  it("wires a later book link to an earlier one's outputs by their names in the book", () => {
    const { steps } = expandChain(
      [
        { id: "redesign", book: "printed-parts", action: "strengthen", in: { part: "$part" } },
        { id: "check", book: "printed-parts", action: "test", in: { part: "redesign.solid" } },
      ],
      lib,
    );
    expect(steps.map((s) => s.id)).toEqual(["redesign_design", "redesign_test", "redesign_slice", "check_test"]);
    expect(steps[1].in).toEqual({ part: "redesign_design.solid" });
    expect(steps[3].in).toEqual({ part: "redesign_design.solid" });
  });

  it("says what's wrong in words the assistant can act on", () => {
    const fails = (links: Parameters<typeof expandChain>[0]) => {
      try {
        expandChain(links, lib);
      } catch (e) {
        expect(e).toBeInstanceOf(ChainError);
        return (e as Error).message;
      }
      throw new Error("expected the chain to be rejected");
    };
    expect(fails([{ id: "a", run: "slicer.slice", in: { model: "b.stress" } }])).toContain('no earlier link is called "b"');
    expect(fails([{ id: "a", book: "printed-parts", action: "test", in: { part: "$part" } }, { id: "b", run: "slicer.slice", in: { model: "a.mesh" } }])).toContain('"a" makes "stress", "results"');
    expect(fails([{ id: "a", book: "printed-parts", action: "test" }])).toContain('needs its input "part"');
    expect(fails([{ id: "a", book: "printed-parts", action: "test", in: { part: "$p", extra: "$p" } }])).toContain('has no input "extra"');
    expect(fails([{ id: "a", book: "printed-parts", action: "nope", in: {} }])).toContain('has no action "nope"');
    expect(fails([{ id: "Bad", run: "slicer.slice" }])).toContain("lowercase_snake");
    expect(fails([{ id: "a", run: "slicer.slice", in: { model: "$m" } }, { id: "a", run: "slicer.slice", in: { model: "$m" } }])).toContain('two links are called "a"');
    expect(fails([{ id: "a" }])).toContain("runs nothing");
    expect(fails([])).toContain("no links");
  });
});
