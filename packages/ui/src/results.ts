/**
 * The project's measurements, kept per window: one row per Measure, or per
 * particle found by Analyze Particles, plus one Summary row per particle
 * analysis. Each window lists its own in its Controls drawer; the Results
 * modal shows every column, one window at a time, with CSV export.
 * Rows remember the image and selection they came from, so clicking a row
 * shows that region again. Saved with the project.
 */
import type { Roi } from "@pharos/core";
import { escapeHtml } from "./dialogs.js";
import { icon } from "./icons.js";

export interface ResultRow {
  /** The image (document id) and its name when measured. */
  doc: string;
  image: string;
  /** Slice label, e.g. "z3" or "c2 z3 t1"; empty for a single plane. */
  slice: string;
  values: Record<string, number>;
  roi: Roi | null;
  /** The Analyze Particles run that found it; absent for Measure rows. */
  run?: number;
}

export interface SummaryRow {
  doc?: string;
  image: string;
  slice: string;
  values: Record<string, number>;
  run?: number;
}

export interface ResultsData {
  rows: ResultRow[];
  summary: SummaryRow[];
}

export interface ResultsHooks {
  /** Open windows, in order, for the rail. */
  docs(): { id: string; name: string }[];
  /** Shows the image and selection a row was measured on. */
  showRow(row: ResultRow): void;
  /** Saves `text` as a file (CSV). */
  save(text: string, filename: string): void;
  changed(): void;
}

const fmt = (v: number | undefined) => (v === undefined ? "" : Number.isNaN(v) ? "NaN" : Number.isInteger(v) ? String(v) : Math.abs(v) >= 1e5 || Math.abs(v) < 1e-3 ? v.toExponential(3) : v.toFixed(3));

function columns(rows: { values: Record<string, number> }[]): string[] {
  const seen = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r.values)) seen.add(k);
  return [...seen];
}

function csvCell(s: string) {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows as CSV with ImageJ's leading index and Label columns. */
function toCsv(rows: { image: string; slice: string; values: Record<string, number> }[]): string {
  const cols = columns(rows);
  const head = [" ", "Label", ...cols];
  const lines = rows.map((r, i) => [String(i + 1), csvCell(r.slice ? `${r.image}:${r.slice}` : r.image), ...cols.map((c) => (r.values[c] === undefined ? "" : String(r.values[c])))].join(","));
  return [head.map(csvCell).join(","), ...lines].join("\n") + "\n";
}

const ALL = "*";

export class Results {
  readonly el: HTMLDialogElement;
  data: ResultsData = { rows: [], summary: [] };
  /** The window shown in the modal, or ALL. */
  private shown = ALL;
  private nextRun = 1;

  constructor(readonly hooks: ResultsHooks) {
    this.el = document.createElement("dialog");
    this.el.className = "results-modal";
    this.el.setAttribute("aria-label", "Results");
    document.body.append(this.el);
    this.el.addEventListener("click", (e) => this.onClick(e));
    // a click on the backdrop closes it
    this.el.addEventListener("pointerdown", (e) => {
      if (e.target === this.el) {
        const r = this.el.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) this.el.close();
      }
    });
  }

  get isOpen() {
    return this.el.open;
  }

  /** Opens the modal on one window's measurements (or every window's). */
  open(docId: string = ALL) {
    this.shown = docId;
    this.render();
    if (!this.el.open) this.el.showModal();
  }

  close() {
    this.el.close();
  }

  forDoc(docId: string): ResultRow[] {
    return this.data.rows.filter((r) => r.doc === docId);
  }

  summariesFor(docId: string): SummaryRow[] {
    return this.data.summary.filter((s) => s.doc === docId);
  }

  /** A new Analyze Particles run id, linking its rows to its summary. */
  newRun(): number {
    return this.nextRun++;
  }

  add(rows: ResultRow[], summary?: SummaryRow) {
    this.data.rows.push(...rows);
    if (summary) this.data.summary.push(summary);
    this.changed();
  }

  remove(row: ResultRow) {
    this.data.rows = this.data.rows.filter((r) => r !== row);
    this.changed();
  }

  /** Replaces everything (opening a project or restoring a session). */
  load(data: ResultsData | undefined) {
    this.data = data ? { rows: [...data.rows], summary: [...data.summary] } : { rows: [], summary: [] };
    this.nextRun = 1 + Math.max(0, ...this.data.rows.map((r) => r.run ?? 0), ...this.data.summary.map((s) => s.run ?? 0));
    if (this.isOpen) this.render();
  }

  private changed() {
    this.hooks.changed();
    if (this.isOpen) this.render();
  }

  /** The windows that have measurements, open ones first in window order, then closed ones. */
  private sources(): { id: string; name: string; open: boolean; n: number }[] {
    const count = (id: string) => this.data.rows.filter((r) => r.doc === id).length + this.data.summary.filter((s) => s.doc === id).length;
    const out = this.hooks.docs().map((d) => ({ ...d, open: true, n: count(d.id) }));
    for (const r of [...this.data.rows, ...this.data.summary]) {
      if (r.doc && !out.some((o) => o.id === r.doc)) out.push({ id: r.doc, name: r.image, open: false, n: count(r.doc) });
    }
    return out;
  }

  private shownRows() {
    const rows = this.shown === ALL ? this.data.rows : this.forDoc(this.shown);
    const summary = this.shown === ALL ? this.data.summary : this.summariesFor(this.shown);
    return { rows, summary };
  }

  private table(rows: { image: string; slice: string; values: Record<string, number> }[], selectable: boolean, withImage: boolean): string {
    const cols = columns(rows);
    return `<table><thead><tr><th class="num"></th>${withImage ? "<th>Image</th>" : ""}<th>Slice</th>${cols.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead><tbody>${rows
      .map(
        (r, i) =>
          `<tr${selectable ? ` data-row="${this.data.rows.indexOf(r as ResultRow)}"` : ""}><td class="num">${i + 1}</td>${withImage ? `<td class="label" title="${escapeHtml(r.image)}">${escapeHtml(r.image)}</td>` : ""}<td class="label">${escapeHtml(r.slice || "–")}</td>${cols
            .map((c) => `<td>${fmt(r.values[c])}</td>`)
            .join("")}</tr>`,
      )
      .join("")}</tbody></table>`;
  }

  render() {
    const sources = this.sources();
    if (this.shown !== ALL && !sources.some((s) => s.id === this.shown)) this.shown = ALL;
    const { rows, summary } = this.shownRows();
    const all = this.shown === ALL;
    const name = all ? "All images" : sources.find((s) => s.id === this.shown)!.name;
    const total = this.data.rows.length + this.data.summary.length;
    const rail = [
      `<button class="rs-src" data-src="${ALL}" aria-pressed="${all}"><span>All images</span><span class="rs-count">${total}</span></button>`,
      ...sources.map(
        (s) =>
          `<button class="rs-src${s.open ? "" : " closed"}" data-src="${escapeHtml(s.id)}" aria-pressed="${s.id === this.shown}" title="${escapeHtml(s.name)}${s.open ? "" : " (closed)"}"><span>${escapeHtml(s.name)}</span><span class="rs-count">${s.n || ""}</span></button>`,
      ),
    ].join("");
    const empty = !rows.length && !summary.length;
    const body = empty
      ? `<p class="rs-empty">${all ? "No measurements yet." : "No measurements on this image yet."} Draw a selection and press <kbd>M</kbd> (Analyze › Measure), or run Analyze Particles.</p>`
      : `${rows.length ? `<h3 class="rs-h">Measurements <span class="rs-count">${rows.length}</span></h3><div class="rs-table">${this.table(rows, true, all)}</div>` : ""}
         ${summary.length ? `<h3 class="rs-h">Particle summaries <span class="rs-count">${summary.length}</span></h3><div class="rs-table">${this.table(summary, false, all)}</div>` : ""}`;
    const dis = empty ? "disabled" : "";
    this.el.innerHTML = `
      <header class="rs-head">
        <h2>Results</h2>
        <button class="win-icon" data-rs="close" title="Close (Esc)" aria-label="Close results">${icon("close", 15)}</button>
      </header>
      <div class="rs-main">
        <nav class="rs-rail" aria-label="Images">${rail}</nav>
        <section class="rs-pane">
          <div class="rs-bar">
            <p class="rs-name">${escapeHtml(name)}</p>
            <div class="rs-actions">
              <button class="tb-text" data-rs="copy" ${dis} title="Copy the measurements (paste into Excel or Prism)">${icon("duplicate", 14)}<span>Copy</span></button>
              <button class="tb-text" data-rs="save" ${dis} title="Save the measurements as CSV">${icon("save", 14)}<span>CSV</span></button>
              <button class="tb-text" data-rs="clear" ${dis} title="Remove these measurements">${icon("trash", 14)}<span>Clear</span></button>
            </div>
          </div>
          <div class="rs-scroll">${body}</div>
        </section>
      </div>`;
  }

  private onClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    const src = t.closest<HTMLElement>("[data-src]")?.dataset.src;
    if (src) {
      this.shown = src;
      return this.render();
    }
    const action = t.closest<HTMLElement>("[data-rs]")?.dataset.rs;
    const { rows, summary } = this.shownRows();
    const base = this.shown === ALL ? "Results" : (this.sources().find((s) => s.id === this.shown)?.name ?? "Results").replace(/\.[^.]+$/, "");
    if (action === "close") return this.close();
    if (action === "copy") return void navigator.clipboard?.writeText(toCsv(rows.length ? rows : summary).replace(/,/g, "\t"));
    if (action === "save") {
      if (rows.length) this.hooks.save(toCsv(rows), `${base}-results.csv`);
      if (summary.length) this.hooks.save(toCsv(summary), `${base}-summary.csv`);
      return;
    }
    if (action === "clear") {
      const gone = new Set<object>([...rows, ...summary]);
      this.data.rows = this.data.rows.filter((r) => !gone.has(r));
      this.data.summary = this.data.summary.filter((s) => !gone.has(s));
      return this.changed();
    }
    const tr = t.closest<HTMLElement>("tr[data-row]");
    if (tr) {
      const row = this.data.rows[Number(tr.dataset.row)];
      if (!row) return;
      this.close();
      this.hooks.showRow(row);
    }
  }
}
