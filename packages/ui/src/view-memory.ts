/**
 * What stays in memory: every window's loaded views (decoded images,
 * models, splats, tables) share one budget. Past it, the least recently
 * shown go first (what's on screen never does), and load again from the
 * server's copy on disk if they're shown again. Videos stream from disk and
 * hold nothing here.
 */
import type { Loaded } from "./data-views.js";

/** The most every window's loaded views may hold together. */
const BUDGET = 512 * 1024 ** 2;

interface Held {
  bytes: number;
  used: number;
  onScreen(): boolean;
  drop(): void;
}

const held = new Map<string, Held>();

/** Roughly what an entry holds in this page, in bytes. */
export function weight(entry: Loaded): number {
  switch (entry.type) {
    case "image":
      return entry.image.planes.reduce((n, p) => n + p.byteLength, 0);
    case "tracks":
      // the movie, unless it's the window's own data's, held already, and the tracks (a few numbers a point,
      // held twice: by frame and by track)
      return (entry.shared ? 0 : entry.image.planes.reduce((n, p) => n + p.byteLength, 0)) + entry.total * 2 * 64;
    case "model":
    case "splat":
      return entry.ply.byteLength;
    case "page":
      return entry.bytes;
    case "table":
      return entry.rows.reduce((n, r) => n + r.reduce((m, c) => m + c.length * 2, 0), 0);
    case "text":
      return entry.text.length * 2;
    default:
      return 0;
  }
}

/** Counts a loaded entry against the budget; `drop` lets it go when the budget needs the room. */
export function holdView(key: string, entry: Loaded, onScreen: () => boolean, drop: () => void) {
  held.set(key, { bytes: weight(entry), used: performance.now(), onScreen, drop });
  trimViews();
}

/** Marks an entry as just shown, so it goes last. */
export function touchView(key: string) {
  const h = held.get(key);
  if (h) h.used = performance.now();
}

/** Stops counting an entry (its window closed). */
export function forgetView(key: string) {
  held.delete(key);
}

function trimViews() {
  let total = 0;
  for (const h of held.values()) total += h.bytes;
  if (total <= BUDGET) return;
  for (const [key, h] of [...held].sort((a, b) => a[1].used - b[1].used)) {
    if (total <= BUDGET) break;
    if (h.onScreen()) continue;
    held.delete(key);
    total -= h.bytes;
    h.drop();
  }
}
