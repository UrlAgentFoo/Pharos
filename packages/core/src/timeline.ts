/**
 * Timeline: a parametric, non-destructive history for one image, modelled on
 * the feature timelines in CAD tools such as Fusion and Inventor.
 *
 * The timeline stores the source image plus a list of steps (command + params),
 * never a pile of anonymous snapshots. A marker says how many steps are
 * applied. Because every command is a pure function, any step can be edited,
 * suppressed, reordered or deleted and the steps after it simply re-run.
 *
 * - Undo/redo move the marker; nothing is thrown away.
 * - A new command is inserted at the marker. Steps after it (rolled back) are
 *   kept and replay on top when the marker moves forward again.
 * - Intermediate results are cached within a memory budget and recomputed
 *   from the nearest cached step when evicted.
 */
import { type CommandContext, type Params, getCommand, parseParams } from "./commands.js";
import type { Image } from "./image.js";

export type StepOrigin = "user" | "ai";

export interface Step {
  readonly id: string;
  readonly command: string;
  readonly params: Params;
  /** Suppressed steps stay in the timeline but pass their input through. */
  readonly enabled: boolean;
  readonly origin: StepOrigin;
  /** Set when the step failed during the last replay (its input passes through). */
  readonly error?: string;
  /** Milliseconds the step took the last time it ran. */
  readonly ms?: number;
}

/** A serialisable timeline, e.g. for batch processing or saving a session. */
export interface Recipe {
  steps: { command: string; params: Params }[];
}

export interface TimelineOptions {
  ctx: CommandContext;
  /** Memory for cached intermediate images; the source and current image are always kept. */
  budgetBytes?: number;
}

const DEFAULT_BUDGET = 768 * 1024 ** 2;
let nextId = 0;

function imageBytes(img: Image): number {
  return img.planes.reduce((n, p) => n + p.byteLength, 0);
}

export class Timeline {
  private _steps: Step[] = [];
  private _marker = 0;
  /** cache[i] is the image after the first i steps; cache[0] is the source. */
  private cache: (Image | undefined)[];
  private lastUsed: number[] = [];
  private clock = 0;
  private listeners = new Set<() => void>();
  private readonly ctx: CommandContext;
  private readonly budget: number;

  constructor(
    readonly source: Image,
    opts: TimelineOptions,
  ) {
    this.ctx = opts.ctx;
    this.budget = opts.budgetBytes ?? DEFAULT_BUDGET;
    this.cache = [source];
  }

  get steps(): readonly Step[] {
    return this._steps;
  }

  /** Number of applied steps (0 = the source image). */
  get marker(): number {
    return this._marker;
  }

  get canUndo(): boolean {
    return this._marker > 0;
  }

  get canRedo(): boolean {
    return this._marker < this._steps.length;
  }

  /** Listens for any change; returns an unsubscribe function. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The image at the marker. */
  current(): Image {
    return this.imageAt(this._marker);
  }

  /**
   * Runs `command` on the current image and inserts it at the marker. Throws
   * (leaving the timeline unchanged) if the command fails.
   */
  apply(command: string, params: unknown = {}, origin: StepOrigin = "user"): Step {
    const cmd = getCommand(command);
    const p = parseParams(cmd, params);
    const input = this.current();
    const t0 = performance.now();
    const output = { ...cmd.run(input, p, this.ctx), name: input.name };
    const step: Step = { id: `s${++nextId}`, command, params: p, enabled: true, origin, ms: Math.round(performance.now() - t0) };
    const at = this._marker;
    this._steps.splice(at, 0, step);
    this.invalidateFrom(at);
    this.cache.splice(at + 1, 0, output);
    this.lastUsed.splice(at + 1, 0, ++this.clock);
    this._marker = at + 1;
    this.evict();
    this.emit();
    return step;
  }

  undo(): boolean {
    if (!this.canUndo) return false;
    this.seek(this._marker - 1);
    return true;
  }

  redo(): boolean {
    if (!this.canRedo) return false;
    this.seek(this._marker + 1);
    return true;
  }

  /** Moves the marker so that the first `n` steps are applied. */
  seek(n: number) {
    const m = Math.max(0, Math.min(this._steps.length, Math.round(n)));
    if (m === this._marker) return;
    this._marker = m;
    this.emit();
  }

  /** Changes a step's parameters; later steps re-run on next access. */
  edit(id: string, params: unknown) {
    const i = this.indexOf(id);
    const step = this._steps[i];
    this._steps[i] = { ...step, params: parseParams(getCommand(step.command), params), error: undefined };
    this.invalidateFrom(i);
    this.emit();
  }

  /** Suppresses or restores a step. */
  setEnabled(id: string, enabled: boolean) {
    const i = this.indexOf(id);
    this._steps[i] = { ...this._steps[i], enabled, error: undefined };
    this.invalidateFrom(i);
    this.emit();
  }

  remove(id: string) {
    const i = this.indexOf(id);
    this._steps.splice(i, 1);
    this.invalidateFrom(i);
    this.cache.length = Math.min(this.cache.length, this._steps.length + 1);
    if (this._marker > i) this._marker--;
    this.emit();
  }

  /** Moves a step to a new position (0-based, among the steps). The marker keeps its count. */
  move(id: string, to: number) {
    const from = this.indexOf(id);
    const target = Math.max(0, Math.min(this._steps.length - 1, to));
    if (from === target) return;
    const [step] = this._steps.splice(from, 1);
    this._steps.splice(target, 0, step);
    // keep the moved step on the same side of the marker as where it was dropped
    if (from < this._marker && target >= this._marker) this._marker--;
    else if (from >= this._marker && target < this._marker) this._marker++;
    this.invalidateFrom(Math.min(from, target));
    this.emit();
  }

  /** The image after the first `n` steps, computed from the nearest cached step. */
  imageAt(n: number): Image {
    const target = Math.max(0, Math.min(this._steps.length, n));
    let k = target;
    while (!this.cache[k]) k--;
    let img = this.cache[k]!;
    this.lastUsed[k] = ++this.clock;
    let errorsChanged = false;
    for (let i = k; i < target; i++) {
      const step = this._steps[i];
      if (step.enabled) {
        const t0 = performance.now();
        try {
          img = { ...getCommand(step.command).run(img, step.params, this.ctx), name: img.name };
          if (step.error) errorsChanged = true;
          this._steps[i] = { ...step, error: undefined, ms: Math.round(performance.now() - t0) };
        } catch (e) {
          // like a failed feature in a CAD timeline: flag it and pass the input through
          this._steps[i] = { ...step, error: e instanceof Error ? e.message : String(e) };
          errorsChanged = true;
        }
      }
      this.cache[i + 1] = img;
      this.lastUsed[i + 1] = ++this.clock;
    }
    if (target > k) this.evict();
    if (errorsChanged) queueMicrotask(() => this.emit());
    return img;
  }

  /**
   * A new timeline with the same source and the first `upTo` steps (all
   * applied), sharing cached results. Used to branch an image into a new tab
   * while keeping every step editable.
   */
  fork(upTo = this._marker): Timeline {
    const n = Math.max(0, Math.min(this._steps.length, upTo));
    const t = new Timeline(this.source, { ctx: this.ctx, budgetBytes: this.budget });
    t._steps = this._steps.slice(0, n).map((s) => ({ ...s, id: `s${++nextId}` }));
    t.cache = this.cache.slice(0, n + 1);
    t.lastUsed = this.lastUsed.slice(0, n + 1);
    t._marker = n;
    return t;
  }

  /** The applied, enabled steps as a recipe (for batch processing). */
  recipe(upTo = this._marker): Recipe {
    return {
      steps: this._steps
        .slice(0, upTo)
        .filter((s) => s.enabled)
        .map((s) => ({ command: s.command, params: { ...s.params } })),
    };
  }

  /** Bytes held by cached images (shared references counted once). */
  cachedBytes(): number {
    const seen = new Set<Image>();
    let n = 0;
    for (const img of this.cache) {
      if (img && !seen.has(img)) {
        seen.add(img);
        n += imageBytes(img);
      }
    }
    return n;
  }

  private indexOf(id: string): number {
    const i = this._steps.findIndex((s) => s.id === id);
    if (i < 0) throw new RangeError(`no step ${id}`);
    return i;
  }

  /** Drops cached results that depend on step `i` or later. */
  private invalidateFrom(i: number) {
    for (let k = i + 1; k < this.cache.length; k++) this.cache[k] = undefined;
  }

  /** Evicts least-recently-used intermediates until under budget. */
  private evict() {
    while (this.cachedBytes() > this.budget) {
      let victim = -1;
      for (let k = 1; k < this.cache.length; k++) {
        if (!this.cache[k] || k === this._marker) continue;
        if (victim < 0 || (this.lastUsed[k] ?? 0) < (this.lastUsed[victim] ?? 0)) victim = k;
      }
      if (victim < 0) return;
      this.cache[victim] = undefined;
    }
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }
}
