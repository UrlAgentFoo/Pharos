import { describe, expect, it } from "vitest";
import { isSplatPly, parseSplatPly } from "../src/splat-view.js";

const FIELDS = ["x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"];

/** A binary splat PLY with one row of values per Gaussian, in FIELDS order. */
function ply(rows: number[][]): ArrayBuffer {
  const header = `ply\nformat binary_little_endian 1.0\nelement vertex ${rows.length}\n${FIELDS.map((f) => `property float ${f}`).join("\n")}\nend_header\n`;
  const head = new TextEncoder().encode(header);
  const out = new Uint8Array(head.length + rows.length * FIELDS.length * 4);
  out.set(head);
  const view = new DataView(out.buffer, head.length);
  rows.flat().forEach((v, i) => view.setFloat32(i * 4, v, true));
  return out.buffer;
}

describe("splat PLYs", () => {
  // centred at (1, 2, 3), grey, fully opaque, scales e^0 = 1 along x and e^ln2 = 2 along y, turned 90° about z
  const turned = [1, 2, 3, 0, 0, 0, 0, 0, 0, 20, 0, Math.log(2), 0, Math.SQRT1_2, 0, 0, Math.SQRT1_2];
  // nearly invisible: left out
  const faint = [0, 0, 0, 0, 0, 0, 0, 0, 0, -20, 0, 0, 0, 1, 0, 0, 0];

  it("tells a splat from a mesh or point cloud", () => {
    expect(isSplatPly(ply([turned]))).toBe(true);
    const cloud = new TextEncoder().encode("ply\nformat binary_little_endian 1.0\nelement vertex 0\nproperty float x\nend_header\n").buffer;
    expect(isSplatPly(cloud)).toBe(false);
  });

  it("reads positions, colours and covariances, leaving out transparent Gaussians", () => {
    const s = parseSplatPly(ply([turned, faint]));
    expect(s.count).toBe(1);
    expect([...s.centers]).toEqual([1, 2, 3]);
    expect([...s.colors]).toEqual([128, 128, 128, 255]);
    // turned 90° about z, the long axis (variance 4) lies along x and the short one (1) along y
    const [xx, xy, xz, yy, yz, zz] = s.covariances;
    expect(xx).toBeCloseTo(4);
    expect(yy).toBeCloseTo(1);
    expect(zz).toBeCloseTo(1);
    for (const v of [xy, xz, yz]) expect(v).toBeCloseTo(0);
  });
});
