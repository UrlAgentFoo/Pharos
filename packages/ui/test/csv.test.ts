import { describe, expect, it } from "vitest";
import { parseCsv } from "../src/csv.js";

describe("parseCsv", () => {
  it("splits rows and fields, with or without a trailing newline", () => {
    expect(parseCsv("a,b\n1,2\n")).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseCsv("a,b\r\n1,2")).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseCsv("a,,c\n")).toEqual([["a", "", "c"]]);
  });

  it("handles quoted commas, quotes and newlines", () => {
    expect(parseCsv('name,note\n"Smith, J","said ""hi""\nthen left"\n')).toEqual([
      ["name", "note"],
      ["Smith, J", 'said "hi"\nthen left'],
    ]);
  });

  it("stops after maxRows", () => {
    expect(parseCsv("h\n1\n2\n3\n", 2)).toEqual([["h"], ["1"]]);
  });
});
