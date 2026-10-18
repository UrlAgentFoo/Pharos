/**
 * Cell tracks as the trackers write them (a row per cell per frame), read for drawing over the movie they
 * came from (track-views.ts): where each cell was over its last few frames, and a colour for how it moves.
 */

export interface TrackPoint {
  id: number;
  x: number;
  y: number;
  z: number;
}

/** Tracks by frame, and each track's points by frame (for its last steps), in the full movie's pixels. */
export interface Tracks {
  byT: Map<number, TrackPoint[]>;
  byId: Map<number, Map<number, TrackPoint>>;
  parent: Map<number, number>;
  hasZ: boolean;
}

/** Reads a tracks table (a row per cell per frame: its track id, t, x, y and maybe z and parent), as the trackers write it. */
export function parseTracks(rows: string[][]): Tracks {
  const head = rows[0]?.map((h) => h.trim().toLowerCase()) ?? [];
  const col = (...names: string[]) => names.map((n) => head.indexOf(n)).find((i) => i >= 0) ?? -1;
  const [id, t, x, y, z, parent] = [col("track_id", "cell_id", "id"), col("t", "frame"), col("x"), col("y"), col("z"), col("parent_track_id", "parent_id", "parent")];
  const out: Tracks = { byT: new Map(), byId: new Map(), parent: new Map(), hasZ: z >= 0 };
  if (id < 0 || t < 0 || x < 0 || y < 0) return out;
  for (const r of rows.slice(1)) {
    const p = { id: Math.round(Number(r[id])), x: Number(r[x]), y: Number(r[y]), z: z >= 0 ? Number(r[z]) : 0 };
    const f = Math.round(Number(r[t]));
    if (![p.id, f, p.x, p.y].every(Number.isFinite)) continue;
    if (!out.byT.has(f)) out.byT.set(f, []);
    out.byT.get(f)!.push(p);
    if (!out.byId.has(p.id)) out.byId.set(p.id, new Map());
    out.byId.get(p.id)!.set(f, p);
    const up = parent >= 0 ? Math.round(Number(r[parent])) : -1;
    if (up >= 0 && up !== p.id) out.parent.set(p.id, up);
  }
  return out;
}

/** Where track `id` was at frame `f`: its own place, or, before it began (just after a division), its mother's. */
export function placeAt(tracks: Tracks, id: number, f: number): TrackPoint | undefined {
  return tracks.byId.get(id)?.get(f) ?? tracks.byId.get(tracks.parent.get(id) ?? -1)?.get(f);
}

/** Where a cell was over the `frames` frames up to `t`, oldest first and ending where it is at `t` (frames it skipped left out). */
export function trail(tracks: Tracks, id: number, t: number, frames: number): TrackPoint[] {
  const out: TrackPoint[] = [];
  for (let f = t - frames; f <= t; f++) {
    const p = placeAt(tracks, id, f);
    if (p) out.push(p);
  }
  return out;
}

/** The physical size of one of the full movie's pixels (x, y) and slices (z), to measure moves in µm. */
export interface Voxel {
  x: number;
  y: number;
  z: number;
}

/** A fast cell's speed, per frame (the 90th percentile of every step): the speed at which a colour is at its strongest. */
export function fastSpeed(tracks: Tracks, v: Voxel): number {
  const steps: number[] = [];
  for (const own of tracks.byId.values()) {
    for (const [f, p] of own) {
      const q = own.get(f - 1);
      if (q) steps.push(Math.hypot((p.x - q.x) * v.x, (p.y - q.y) * v.y, (p.z - q.z) * v.z));
    }
  }
  if (!steps.length) return 1;
  steps.sort((a, b) => a - b);
  return steps[Math.floor(steps.length * 0.9)] || 1;
}

/**
 * How a cell moves as a colour, red, green and blue from 0 to 1: its hue is the direction of its move across the
 * image (as on the legend's wheel) and its strength its speed, so a cell that stays put is grey and a fast one vivid.
 */
export function motionColour(dx: number, dy: number, speed: number, fast: number): [number, number, number] {
  // most cells move slowly: the square root lets their colour show, not only the fastest cells'
  const s = Math.sqrt(Math.min(1, speed / fast));
  const h = ((Math.atan2(dy, dx) / (2 * Math.PI)) * 360 + 360) % 360;
  // HSL to RGB, bright, to read on the dark stage and on bright nuclei
  const l = 0.7;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r + m, g + m, b + m];
}

/** The colour of a cell's move over its trail (first point to last), with its speed per frame in µm. */
export function trailColour(path: TrackPoint[], v: Voxel, fast: number): [number, number, number] {
  if (path.length < 2) return motionColour(0, 0, 0, fast);
  const a = path[0];
  const b = path[path.length - 1];
  const speed = Math.hypot((b.x - a.x) * v.x, (b.y - a.y) * v.y, (b.z - a.z) * v.z) / (path.length - 1);
  return motionColour((b.x - a.x) * v.x, (b.y - a.y) * v.y, speed, fast);
}
