/**
 * Progress, the same everywhere: a step in a window's history, the run as a
 * whole, the activity list in the toolbar and the busy line at the bottom.
 *
 * Long work must never look frozen, so progress has a phase (waiting,
 * downloading or building a ship, starting, running), a bar that animates
 * when nothing reports a fraction yet, a clock that keeps ticking, and a
 * warning when a running step has printed nothing for a while.
 */
import { escapeHtml, formatSize } from "./format.js";

export type Phase = "waiting" | "downloading" | "building" | "starting" | "running";

/** What one running or waiting piece of work looks like right now. */
export interface Progress {
  phase: Phase;
  /** 0-1, when known. */
  fraction?: number;
  /** The tool's own words ("t = 12 of 60 s"), or a ship's latest build line. */
  message?: string;
  /** When this work started (ms since epoch), for the clock. */
  since?: number;
  /** When it last printed anything (ms), for the quiet warning. */
  lastOutput?: number;
  /** Bytes, while a ship downloads. */
  bytes?: { received: number; total?: number };
  /** The ship being downloaded or built. */
  ship?: string;
  /** The job doing the work, so log lines can reset the quiet warning without a redraw. */
  job?: string;
}

/** After this long without output, a running step says so. */
export const QUIET_MS = 30_000;

/** The phase in a few words: "Downloading cellpose · 312 MB of 1.4 GB". */
export function phaseText(p: Progress): string {
  const pct = p.fraction !== undefined ? `${Math.round(p.fraction * 100)}%` : "";
  switch (p.phase) {
    case "waiting":
      return "Waiting for its turn";
    case "downloading":
      return `Downloading ${p.ship ?? "the ship"}${p.bytes?.received ? ` · ${formatSize(p.bytes.received)}${p.bytes.total ? ` of ${formatSize(p.bytes.total)}` : ""}` : ""}`;
    case "building":
      return `Setting up ${p.ship ?? "the ship"} (first use only)`;
    case "starting":
      return "Starting";
    case "running":
      return ["Running", pct, p.message].filter(Boolean).join(" · ");
  }
}

/** A bar: filled to `fraction`, or a sweeping stripe when the fraction isn't known. */
export function barHtml(fraction?: number): string {
  return fraction === undefined
    ? `<span class="pg-bar indeterminate" role="progressbar"><span></span></span>`
    : `<span class="pg-bar" role="progressbar" aria-valuenow="${Math.round(fraction * 100)}"><span style="width:${Math.max(2, Math.round(fraction * 100))}%"></span></span>`;
}

/** Elapsed time that keeps ticking (see `startClock`). */
export function clockHtml(since?: number): string {
  return since ? `<span class="pg-clock" data-since="${since}">${duration(Date.now() - since)}</span>` : "";
}

/** "No output for 45 s", shown by the clock once a running step goes quiet. */
export function quietHtml(p: Progress, logAction = ""): string {
  if (p.phase !== "running" && p.phase !== "starting") return "";
  const from = p.lastOutput ?? p.since;
  if (!from) return "";
  return `<span class="pg-quiet" data-quiet-since="${from}"${p.job ? ` data-quiet-job="${escapeHtml(p.job)}"` : ""} hidden>No output for <span class="pg-quiet-for"></span>; it may just be slow.${logAction ? ` ${logAction}` : ""}</span>`;
}

/** The whole block: phase line with clock, bar, and the quiet warning. */
export function progressHtml(p: Progress, opts: { title?: string; logAction?: string } = {}): string {
  const bar = p.phase === "downloading" && p.bytes?.total ? p.bytes.received / p.bytes.total : p.phase === "running" ? p.fraction : undefined;
  const detail = p.phase === "building" && p.message ? `<span class="pg-detail">${escapeHtml(p.message)}</span>` : "";
  const phase = phaseText(p);
  return `<span class="pg">
    ${opts.title ? `<strong class="pg-title" title="${escapeHtml(opts.title)}">${escapeHtml(opts.title)}</strong>` : ""}
    <span class="pg-head"><span class="pg-phase" title="${escapeHtml(phase)}">${escapeHtml(phase)}</span>${clockHtml(p.since)}</span>
    ${barHtml(bar)}${detail}${quietHtml(p, opts.logAction)}</span>`;
}

/** 1:05, or 12 s under a minute, or 1:02:03 over an hour. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** A job printed something: its quiet warnings start counting again. */
export function heardFrom(job: string) {
  const now = String(Date.now());
  for (const el of document.querySelectorAll<HTMLElement>(`[data-quiet-job="${CSS.escape(job)}"]`)) {
    el.dataset.quietSince = now;
    el.hidden = true;
  }
}

let clock: ReturnType<typeof setInterval> | null = null;

/** Once a second: advances every clock on the page and shows quiet warnings that are due. */
export function startClock() {
  clock ??= setInterval(() => {
    const now = Date.now();
    for (const el of document.querySelectorAll<HTMLElement>("[data-since]")) el.textContent = duration(now - Number(el.dataset.since));
    for (const el of document.querySelectorAll<HTMLElement>("[data-quiet-since]")) {
      const quiet = now - Number(el.dataset.quietSince);
      el.hidden = quiet < QUIET_MS;
      const span = el.querySelector(".pg-quiet-for");
      if (span && !el.hidden) span.textContent = duration(quiet);
    }
  }, 1000);
}
