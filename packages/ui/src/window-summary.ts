/**
 * The top of the left column while a window is active: what that window
 * holds and what it takes to run it. Its data in one line; its books (the
 * ones its history uses, or before anything is added, the ones that fit)
 * and the ships they run, each ticked once ready or with what's left to
 * download. What to run lives in the window's Controls. Its steps come first: the one on
 * view ("Step 2/5"), with its status and log, and the rest behind See all,
 * the one on view marked as the window's blue marker shows. It follows the
 * active window and keeps up as ships download.
 */
import type { BookCard, BookMatch, CatalogueEntry, DataSummary, ServerEvent } from "@pharos/contracts";
import type { LocalServer } from "./api.js";
import { escapeHtml } from "./dialogs.js";
import { formatSize } from "./format.js";
import { icon } from "./icons.js";
import { type DataDoc, blockAt, stepTitle, timeBlocks } from "./workspace.js";

type Pull = Extract<ServerEvent, { type: "pull" }>;

export interface SummaryHooks {
  server(): LocalServer | null;
  /** Downloads under way, by ship id. */
  pulls(): ReadonlyMap<string, Pull>;
  /** A format's title ("OME-Zarr") for its id. */
  formatTitle(format: string): string;
  /** Starts getting a book's missing ships; the button that asks says how much they are. */
  getReady(book: CatalogueEntry): void;
  /** Shows the window's data as of step `marker` (0 = the data itself). */
  select(doc: DataDoc, marker: number): void;
  showLog(jobId: string): void;
}

interface Library {
  ships: Map<string, CatalogueEntry>;
  cards: Map<string, BookCard>;
}

/** What a dataset is, and the books that fit it, read once per dataset. */
interface Fit {
  summary?: DataSummary;
  matches: BookMatch[];
}

/** Books to list when nothing has been added yet. */
const FITTING = 3;

const tick = `<span class="ws-tick" role="img" aria-label="Ready">${icon("check", 16)}</span>`;

export class WindowSummary {
  private library: Library | null = null;
  private libraryLoading: Promise<void> | null = null;
  private fits = new Map<string, Fit>();
  private fitsLoading = new Set<string>();
  private doc: DataDoc | null = null;
  /** Windows whose Step section lists every step, not just the one on view. */
  private runsOpen = new Set<string>();
  private place = "";
  private html = "";
  private topHtml = "";

  /** `top` takes the window's name and data, which stay put; `el` the rest, which scrolls. */
  constructor(
    private readonly el: HTMLElement,
    private readonly top: HTMLElement,
    private readonly hooks: SummaryHooks,
  ) {
    el.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const id = target.closest<HTMLButtonElement>("[data-ready]")?.dataset.ready;
      const book = id && this.library?.cards.get(id)?.entry;
      if (book) return hooks.getReady(book);
      const marker = target.closest<HTMLButtonElement>("[data-marker]")?.dataset.marker;
      if (marker !== undefined && this.doc) return hooks.select(this.doc, Number(marker));
      const log = target.closest<HTMLButtonElement>("[data-log]")?.dataset.log;
      if (log) return hooks.showLog(log);
      if (target.closest("[data-runs]") && this.doc) {
        const id = this.doc.id;
        if (!this.runsOpen.delete(id)) this.runsOpen.add(id);
        this.render();
        // the redraw replaced the button; keep keyboard focus on it
        return this.el.querySelector<HTMLButtonElement>("[data-runs]")?.focus();
      }
    });
  }

  /** Shows this window, the `n`th of `of`; null shows nothing. */
  show(doc: DataDoc | null, n = 0, of = 0) {
    this.doc = doc;
    this.place = of > 1 ? `Window · ${n} of ${of}` : "Window";
    this.render();
  }

  /** Ships or books changed (a download finished, the library changed): read them again. */
  invalidate() {
    this.libraryLoading = null;
    this.load();
    this.render();
  }

  /** Redraws from what's known, e.g. as a download moves on. */
  render() {
    const doc = this.doc;
    const top = doc ? this.topOf(doc) : "";
    if (top !== this.topHtml) this.top.innerHTML = this.topHtml = top;
    const html = doc ? this.windowHtml(doc) : "";
    if (html === this.html) return; // no flicker, and focus stays put
    this.html = html;
    this.el.innerHTML = html;
  }

  /** "Window · 2 of 2", its name, and its data in one line. */
  private topOf(doc: DataDoc): string {
    return `<p class="eyebrow">${escapeHtml(this.place)}</p>
      <h2 class="display ws-title">${escapeHtml(doc.name)}</h2>
      <p class="ws-meta">${escapeHtml(this.dataLine(doc, this.fit(doc)?.summary))}</p>`;
  }

  private load() {
    const s = this.hooks.server();
    if (!s || this.libraryLoading) return;
    this.libraryLoading = Promise.all([s.ships(), s.cards()])
      .then(([ships, cards]) => {
        this.library = { ships: new Map(ships.map((e) => [e.id, e])), cards: new Map(cards.map((c) => [c.entry.id, c])) };
      })
      .catch(() => {
        this.libraryLoading = null; // try again next time
      })
      .finally(() => this.render());
  }

  private fit(doc: DataDoc): Fit | null {
    const key = `${doc.workspace}/${doc.source.id}`;
    const s = this.hooks.server();
    if (!this.fits.has(key) && s && !this.fitsLoading.has(key)) {
      this.fitsLoading.add(key);
      void s
        .match(doc.workspace, [doc.source.id])
        .then((r) => this.fits.set(key, { summary: r.summaries[0], matches: r.matches.filter((m) => m.tier !== "excluded") }))
        .catch(() => this.fits.set(key, { matches: [] }))
        .finally(() => {
          this.fitsLoading.delete(key);
          this.render();
        });
    }
    return this.fits.get(key) ?? null;
  }

  private windowHtml(doc: DataDoc): string {
    if (!this.library) this.load();
    const fit = this.fit(doc);
    if (!this.hooks.server()) return `<p class="muted small">Books and ships show here once Pharos's local server is running.</p>`;
    const lib = this.library;
    if (!lib || (!doc.steps.length && !fit)) return `<p class="muted small">Reading what this window needs…</p>`;

    // the books and ships its history runs; with no history yet, the books that fit and theirs
    const used = new Map<string, Set<string>>();
    for (const st of doc.steps) if (st.book) used.set(st.book.id, (used.get(st.book.id) ?? new Set()).add(st.book.action ?? ""));
    const books = doc.steps.length
      ? [...used].map(([id, actions]) => ({ id, actions: [...actions].filter(Boolean) }))
      : fit!.matches.slice(0, FITTING).map((m) => ({ id: m.book.id, actions: m.actions.slice(0, 2) }));
    const ships = doc.steps.length ? new Set(doc.steps.map((st) => st.run.split(".")[0])) : new Set(books.flatMap((b) => lib.cards.get(b.id)?.ships.map((x) => x.id) ?? []));

    const bookRows = books.map((b) => {
      const card = lib.cards.get(b.id);
      const title = card?.entry.title ?? b.id;
      const actions = b.actions.map((a) => card?.actions.find((x) => x.name === a)?.title ?? a);
      const missing = (card?.ships ?? []).filter((x) => !this.shipState(x.id).ready);
      const bytes = missing.reduce((n, x) => n + (lib.ships.get(x.id)?.imageSizeBytes ?? x.sizeBytes ?? 0), 0);
      const state = !card
        ? `<span class="ws-state">Not in the library</span>`
        : missing.length
          ? `<button class="link-btn ws-ready" data-ready="${escapeHtml(b.id)}" title="Downloads or sets up its ships now, so the first run doesn't wait">Get ready${bytes ? ` (${formatSize(bytes)})` : ""}</button>`
          : tick;
      return `<li><span class="ws-name">${escapeHtml(title)}${actions.length ? `<small>${escapeHtml(actions.join(" · "))}</small>` : ""}</span>${state}</li>`;
    });
    const shipRows = [...ships].map((id) => {
      const st = this.shipState(id);
      return `<li><span class="ws-name">${escapeHtml(lib.ships.get(id)?.title ?? id)}</span>${st.ready ? tick : `<span class="ws-state ${st.cls}">${escapeHtml(st.text)}</span>`}</li>`;
    });
    const ready = [...ships].filter((id) => this.shipState(id).ready).length;

    // with no history yet, the books are the ones that fit; when none does, say where to look instead
    const booksHtml = books.length
      ? `<section><p class="ws-head"><span class="eyebrow">${doc.steps.length ? "Books" : "Books for this data"}</span><small>${books.length}</small></p><ul class="ws-list">${bookRows.join("")}</ul></section>`
      : doc.steps.length
        ? ""
        : `<section><p class="ws-head"><span class="eyebrow">Books for this data</span></p><p class="ws-note">No book in the library fits this data yet; the window's ⋯ menu lists every ship operation that takes it.</p></section>`;
    const shipsHtml = ships.size
      ? `<section><p class="ws-head"><span class="eyebrow">Ships</span><small>${ready === ships.size ? "all ready" : `${ready} of ${ships.size} ready`}</small></p><ul class="ws-list">${shipRows.join("")}</ul></section>`
      : "";
    return `${runLog(doc, this.runsOpen.has(doc.id))}${booksHtml}${shipsHtml}`;
  }

  /** Ready, downloading, or what's left to download. */
  private shipState(id: string): { ready: boolean; text: string; cls: string } {
    const pull = this.hooks.pulls().get(id);
    if (pull && !pull.done) return { ready: false, text: pull.totalBytes ? `Downloading ${Math.min(99, Math.round((100 * pull.receivedBytes) / pull.totalBytes))}%` : "Downloading…", cls: "busy" };
    const e = this.library?.ships.get(id);
    if (!e) return { ready: false, text: "Not in the library", cls: "" };
    if (e.installed) return { ready: true, text: "Ready", cls: "ok" };
    return { ready: false, text: e.imageSizeBytes ? `${formatSize(e.imageSizeBytes)} to download` : "Not downloaded", cls: "" };
  }

  /** "OME-Zarr · 96 × 96 × 12 voxels · 10 time points · 2.1 MB" */
  private dataLine(doc: DataDoc, s?: DataSummary): string {
    const parts = [this.hooks.formatTitle(doc.source.format)];
    if (s?.axes && s.shape) {
      const sides = ["x", "y", "z"].filter((a) => s.axes!.includes(a)).map((a) => s.shape![s.axes!.indexOf(a)]);
      if (sides.length) parts.push(`${sides.join(" × ")} ${sides.length > 2 ? "voxels" : "pixels"}`);
      if (s.timepoints && s.timepoints > 1) parts.push(`${s.timepoints} time points`);
      if (s.channels && s.channels > 1) parts.push(`${s.channels} channels`);
    }
    if (s?.rows !== undefined) parts.push(`${s.rows} row${s.rows === 1 ? "" : "s"}`);
    const size = s?.sizeBytes ?? doc.source.sizeBytes;
    if (size) parts.push(formatSize(size));
    return parts.join(" · ");
  }
}

const RUN_STATUS: Record<string, string> = { done: "done", running: "running", queued: "waiting", failed: "failed", proposed: "proposed", stale: "changed", cancelled: "cancelled" };

/**
 * The window's step on view (a run of one book action or ship operation),
 * with its status and log, under "Step 2/5" and See all; `all` lists every
 * step, oldest first, the one on view marked as the window's blue marker shows.
 */
function runLog(doc: DataDoc, all: boolean): string {
  const blocks = timeBlocks(doc);
  const k = blockAt(blocks, doc.marker);
  if (!blocks.length) return `<section><p class="ws-head"><span class="eyebrow">Step</span></p><p class="ws-note">No steps yet: add one with Suggested in the window, or ask the assistant.</p></section>`;
  const row = (on: boolean, marker: number, name: string, note: string, job?: string) =>
    `<li class="ws-run${on ? " on" : ""}"><button class="ws-run-go" data-marker="${marker}"${on ? ' aria-current="step"' : ""}><span class="ws-name">${escapeHtml(name)}<small>${escapeHtml(note)}</small></span></button>${job ? `<button class="link-btn" data-log="${escapeHtml(job)}">Log</button>` : ""}</li>`;
  const rows = blocks.map((b, i) => {
    const steps = doc.steps.slice(b.first, b.last + 1);
    const n = steps.length;
    // the log worth reading: the step that failed, else the last that ran
    const job = (steps.find((s) => s.status === "failed") ?? [...steps].reverse().find((s) => s.jobId))?.jobId;
    // a result picked from the window's Results, rather than the run's main one (its last step's first output)
    const st = doc.steps[doc.marker - 1];
    const out = st ? (doc.output ?? Object.keys(st.outputs ?? {})[0]) : undefined;
    const picked = i === k && st && (doc.marker - 1 !== b.last || out !== Object.keys(st.outputs ?? {})[0]);
    const showing = picked ? `showing result: ${stepTitle(st)}${out ? ` › ${out}` : ""}` : "";
    const note = [RUN_STATUS[b.status], n > 1 ? `${n} steps` : "", steps.every((s) => s.cached) ? "cached" : "", showing].filter(Boolean).join(" · ");
    return row(i === k, b.last + 1, b.title, note, job);
  });
  const list = [row(k < 0, 0, "The data itself", "before any step"), ...rows];
  return `<section class="ws-runs"><p class="ws-head"><span class="eyebrow">Step ${k + 1}/${blocks.length}</span><button class="link-btn" data-runs aria-expanded="${all}" aria-controls="ws-run-list">${all ? "See less" : "See all"}</button></p>
    <ol class="ws-list" id="ws-run-list">${all ? list.join("") : list[k + 1]}</ol></section>`;
}
