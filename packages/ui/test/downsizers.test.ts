import { readFileSync } from "node:fs";
import type { ShipManifest } from "@pharos/contracts";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { downsizers } from "../src/large-data.js";

const ship = (id: string) => parse(readFileSync(new URL(`../../../ships/${id}/ship.yaml`, import.meta.url), "utf8")) as ShipManifest;
const ships = ["media-ops", "mesh-ops", "colmap", "image-ops"].map(ship);
const ids = (kind: string, format: string) => downsizers(ships, { kind, format }).map((s) => s.id);

describe("making large data smaller", () => {
  it("offers the operations of downsample ships that give back the same kind", () => {
    expect(ids("video", "mp4")).toEqual(["media-ops.resize-video"]);
    expect(ids("video", "mov")).toEqual(["media-ops.resize-video"]);
    expect(ids("photos", "photo-set")).toEqual(["media-ops.resize-photos"]);
    expect(ids("mesh", "ply")).toEqual(["mesh-ops.decimate"]);
    expect(ids("splat", "splat-ply")).toEqual(["mesh-ops.thin-splat"]);
  });

  it("leaves out operations that change the kind, and data nothing can shrink", () => {
    // colmap.frames turns a video into photos: not a smaller video
    expect(ids("video", "mp4")).not.toContain("colmap.frames");
    expect(ids("table", "csv")).toEqual([]);
  });
});
