import { describe, expect, it } from "vitest";
import { upAxis } from "../src/model-view.js";

const ply = (header: string[]) => new TextEncoder().encode(["ply", "format binary_little_endian 1.0", ...header, "element vertex 0", "end_header", ""].join("\n")).buffer as ArrayBuffer;

describe("which way is up in a 3D model", () => {
  it("reads the PLY's own say, signed", () => {
    expect(upAxis(ply(["comment up z"]))?.toArray()).toEqual([0, 0, 1]);
    expect(upAxis(ply(["comment made by Pharos", "comment up -y"]))?.toArray()).toEqual([0, -1, 0]);
  });

  it("is none when the header doesn't say, or only after it ends", () => {
    expect(upAxis(ply(["comment upright"]))).toBeNull();
    const after = new TextEncoder().encode("ply\nend_header\ncomment up z\n").buffer as ArrayBuffer;
    expect(upAxis(after)).toBeNull();
  });
});
