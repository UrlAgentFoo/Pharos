import { describe, expect, it } from "vitest";
import { parseCsv } from "../src/csv.js";
import { tailStrength } from "../src/track-views.js";
import { fastSpeed, motionColour, parseTracks, placeAt, trail, trailColour } from "../src/tracks.js";

describe("tracks tables", () => {
  it("read the space-time field's tracks: cells by frame and by track, with their parents", () => {
    const t = parseTracks(parseCsv("cell_id,t,z,y,x,parent_id\n1,0,5,10,20,-1\n1,1,5,12,22,-1\n2,2,6,14,30,1\n3,2,4,11,19,1\n"));
    expect(t.hasZ).toBe(true);
    expect(t.byT.get(2)?.map((p) => p.id)).toEqual([2, 3]);
    expect(t.byId.get(1)?.get(1)).toMatchObject({ x: 22, y: 12, z: 5 });
    // the daughters of a division know their mother, for an arrow from where she was
    expect(t.parent.get(2)).toBe(1);
    expect(t.parent.has(1)).toBe(false);
  });

  it("read 2D tracks as other trackers write them, and nothing from a table that isn't tracks", () => {
    const flat = parseTracks(parseCsv("track_id,t,y,x\n7,0,1.5,2.5\n7,1,2,3\n"));
    expect(flat.hasZ).toBe(false);
    expect(flat.byId.get(7)?.size).toBe(2);
    expect(parseTracks(parseCsv("label,area\n1,20\n")).byT.size).toBe(0);
  });
});

describe("tracks drawn", () => {
  const v = { x: 0.5, y: 0.5, z: 2 };

  it("follow a cell back through its last frames, into its mother's before it divided", () => {
    const t = parseTracks(parseCsv("track_id,t,z,y,x,parent_track_id\n1,0,0,0,0,-1\n1,1,0,0,2,-1\n2,2,0,1,4,1\n2,3,0,2,6,1\n"));
    expect(trail(t, 2, 3, 10).map((p) => p.x)).toEqual([0, 2, 4, 6]);
    expect(trail(t, 2, 3, 1).map((p) => p.x)).toEqual([4, 6]);
    expect(placeAt(t, 1, 3)).toBeUndefined();
  });

  it("colour a still cell grey and a moving one by its direction, at its strongest for a fast one", () => {
    const [r, g, b] = motionColour(0, 0, 0, 1);
    expect(r).toBeCloseTo(g);
    expect(g).toBeCloseTo(b);
    const right = motionColour(1, 0, 1, 1);
    const down = motionColour(0, 1, 1, 1);
    expect(right[0]).toBeGreaterThan(right[2]); // red-ish
    expect(down[1]).toBeGreaterThan(down[0]); // the wheel's next third: green-ish
    const slow = motionColour(1, 0, 0.2, 1);
    expect(right[0] - right[2]).toBeGreaterThan(slow[0] - slow[2]);
  });

  it("measure moves in the movie's units: a fast cell's speed, and a trail's colour", () => {
    const t = parseTracks(parseCsv("track_id,t,z,y,x\n1,0,0,0,0\n1,1,0,0,2\n1,2,1,0,2\n"));
    // steps of 2 px × 0.5 µm and 1 slice × 2 µm: the faster, 2 µm a frame
    expect(fastSpeed(t, v)).toBeCloseTo(2);
    const [r, , b] = trailColour(trail(t, 1, 1, 10), v, 1);
    expect(r).toBeGreaterThan(b);
  });
});

describe("tails", () => {
  it("keep their full colour for the newest steps from the cell, then fade to a quarter at the oldest", () => {
    const steps = 10;
    expect([0, 1, 2].map((b) => tailStrength(b, steps))).toEqual([1, 1, 1]);
    expect(tailStrength(3, steps)).toBeLessThan(1);
    expect(tailStrength(steps - 1, steps)).toBeCloseTo(0.25);
    // a short tail is solid all along
    expect(tailStrength(1, 2)).toBe(1);
  });
});
