/**
 * A window's history as a chain: the data, then each step as a node, wired
 * left to right by what it passed on (STEP model, PLY, …), with each run
 * framed as a group carrying why it ran (the assistant's reason, or what
 * the book action does). Read-only: clicking a node shows its result in the
 * window. No DOM here, so the model and the layout are tested in Node.
 */
import { escapeHtml } from "./format.js";
import { icon } from "./icons.js";
import { type DataDoc, type DataStep, stepTitle, timeBlocks, underWay } from "./workspace.js";

/** One box: the data itself, or a step. */
export interface ChainNode {
  /** "data", or the step's id. */
  key: string;
  /** What the window shows when it's clicked: 0 the data, n step n. */
  marker: number;
  title: string;
  /** The ship that ran it, or the data's format. */
  tool: string;
  status: DataStep["status"] | "data";
  /** What it made: a table's first value and one more, or the kinds of its outputs. */
  result?: string;
  detail?: string;
  /** The run it belongs to (an index into the runs); -1 for the data. */
  run: number;
  /** What it takes, from where, labelled by the format passed. */
  inputs: { from: string; label: string }[];
}

export interface ChainRun {
  title: string;
  status: DataStep["status"];
  /** The assistant's reason for it, when it chose it. */
  reason?: string;
  /** What the book action does, for runs nobody explained. */
  summary?: string;
}

/** What the model needs from the library: a step's outputs, and how to name formats and kinds. */
export interface ChainLookups {
  outputs(run: string): { name: string; kind: string; format: string }[];
  formatTitle(format: string): string;
  kindTitle(kind: string): string;
  /** A done step's table, summed up (see `tableLine`), by step id. */
  tables?: Record<string, { result: string; detail?: string }>;
  /** What a book action does, by "book/action". */
  summaries?: Record<string, string>;
}

/** The window's history as nodes and runs, in history order (the runs as its history bar numbers them). */
export function chainModel(doc: DataDoc, look: ChainLookups): { nodes: ChainNode[]; runs: ChainRun[] } {
  const blocks = timeBlocks(doc).filter((b) => !underWay(doc, b));
  const runs: ChainRun[] = blocks.map((b) => {
    const first = doc.steps[b.first];
    const summary = first.book?.action ? look.summaries?.[`${first.book.id}/${first.book.action}`] : undefined;
    return { title: b.title, status: b.status, ...(first.reason ? { reason: first.reason } : summary ? { summary } : {}) };
  });
  const nodes: ChainNode[] = [{ key: "data", marker: 0, title: doc.source.name ?? doc.name, tool: look.formatTitle(doc.source.format), status: "data", result: look.kindTitle(doc.source.kind), run: -1, inputs: [] }];
  const formatOf = (wire: string) => {
    if (wire.startsWith("$")) return look.formatTitle(doc.source.format);
    const [id, output] = wire.split(".");
    const step = doc.steps.find((s) => s.id === id);
    const out = step && look.outputs(step.run).find((o) => o.name === output);
    return out ? look.formatTitle(out.format) : output;
  };
  blocks.forEach((b, run) => {
    for (let i = b.first; i <= b.last; i++) {
      const s = doc.steps[i];
      // one link per step it takes from, naming every format passed along it
      const from = new Map<string, string[]>();
      for (const wire of Object.values(s.in)) {
        const key = wire.startsWith("$") ? "data" : wire.split(".")[0];
        const label = formatOf(wire);
        if (!from.get(key)?.includes(label)) from.set(key, [...(from.get(key) ?? []), label]);
      }
      const table = look.tables?.[s.id];
      const made = look.outputs(s.run).map((o) => look.kindTitle(o.kind));
      nodes.push({
        key: s.id,
        marker: i + 1,
        title: stepTitle(s),
        tool: s.run.split(".")[0],
        status: s.status,
        ...(table ? { result: table.result, ...(table.detail ? { detail: table.detail } : {}) } : made.length ? { result: [...new Set(made)].join(" · ") } : {}),
        run,
        inputs: [...from].map(([key, labels]) => ({ from: key, label: labels.join(", ") })),
      });
    }
  });
  return { nodes, runs };
}

// ---------------------------------------------------------------- results

/** Column-name endings that are units: "peak_stress_mpa" reads "peak stress … MPa". */
const UNITS: [RegExp, string][] = [
  [/_mpa$/, " MPa"],
  [/_mm$/, " mm"],
  [/_px$/, " px"],
  [/_n$/, " N"],
  [/_g$/, " g"],
  [/_m$/, " m"],
  [/_s$/, " s"],
  [/_percent$/, " %"],
];

function cell(name: string, value: string): { label: string; text: string } {
  for (const [end, unit] of UNITS) if (end.test(name)) return { label: name.replace(end, "").replace(/_/g, " "), text: `${value}${unit}` };
  return { label: name.replace(/_/g, " "), text: value };
}

/** Splits a CSV line, keeping quoted commas. */
function fields(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === "," && !quoted) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((f) => f.trim());
}

/**
 * A results table in a line: a one-row table's first value ("would break")
 * and its second, named ("safety factor 0.63"); a longer table's size.
 */
export function tableLine(csv: string): { result: string; detail?: string } | undefined {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return lines.length ? { result: "No rows" } : undefined;
  const head = fields(lines[0]);
  if (lines.length > 2) return { result: `${lines.length - 1} rows`, detail: `${head.length} columns` };
  const row = fields(lines[1]);
  const first = cell(head[0] ?? "", row[0] ?? "");
  const second = head.length > 1 ? cell(head[1], row[1] ?? "") : undefined;
  return { result: first.text, ...(second ? { detail: `${second.label} ${second.text}` } : {}) };
}

// ---------------------------------------------------------------- layout

export const NODE_W = 220;
export const NODE_H = 74;
const COL_GAP = 76;
const ROW_GAP = 16;
const HEAD = 74; // a run's title and up to three lines of reason, above its nodes
const PAD = 14;
const BAND_GAP = 20;
const MARGIN = 16;
const MIN_GROUP_W = 540;

export interface ChainLayout {
  nodes: (ChainNode & { x: number; y: number })[];
  edges: { from: string; to: string; label: string; path: string; lx: number; ly: number }[];
  groups: (ChainRun & { index: number; x: number; y: number; w: number; h: number })[];
  width: number;
  height: number;
}

/**
 * Columns by how far each node is from the data (its longest chain of
 * inputs); each run a band of its own, its nodes stacked where they share a
 * column; the data in the first column, level with the middle of the runs.
 */
export function layoutChain(nodes: ChainNode[], runs: ChainRun[]): ChainLayout {
  const depth = new Map<string, number>([["data", 0]]);
  for (const n of nodes) if (n.key !== "data") depth.set(n.key, 1 + Math.max(0, ...n.inputs.map((i) => depth.get(i.from) ?? 0)));
  const x = (col: number) => MARGIN + col * (NODE_W + COL_GAP);
  const placed = new Map<string, { x: number; y: number }>();
  const groups: ChainLayout["groups"] = [];
  let top = MARGIN;
  runs.forEach((run, index) => {
    const mine = nodes.filter((n) => n.run === index);
    const rows = new Map<number, number>(); // column → nodes placed in it so far
    for (const n of mine) {
      const col = depth.get(n.key)!;
      const row = rows.get(col) ?? 0;
      rows.set(col, row + 1);
      placed.set(n.key, { x: x(col), y: top + HEAD + PAD + row * (NODE_H + ROW_GAP) });
    }
    const cols = mine.map((n) => depth.get(n.key)!);
    const height = HEAD + 2 * PAD + Math.max(1, ...rows.values()) * (NODE_H + ROW_GAP) - ROW_GAP;
    const left = x(Math.min(...cols, 1)) - PAD;
    const right = Math.max(x(Math.max(...cols, 1)) + NODE_W + PAD, left + MIN_GROUP_W);
    groups.push({ ...run, index, x: left, y: top, w: right - left, h: height });
    top += height + BAND_GAP;
  });
  const bottom = groups.length ? top - BAND_GAP : MARGIN + NODE_H;
  // the data, level with the middle of the runs' nodes
  const firstRow = groups.length ? groups[0].y + HEAD + PAD : MARGIN;
  const lastRow = groups.length ? groups[groups.length - 1].y + groups[groups.length - 1].h - PAD - NODE_H : MARGIN;
  placed.set("data", { x: x(0), y: Math.round((firstRow + lastRow) / 2) });

  const edges: ChainLayout["edges"] = [];
  for (const n of nodes) {
    const to = placed.get(n.key)!;
    for (const input of n.inputs) {
      const from = placed.get(input.from);
      if (!from) continue;
      const [x1, y1, x2, y2] = [from.x + NODE_W, from.y + NODE_H / 2, to.x, to.y + NODE_H / 2];
      const dx = Math.max(32, (x2 - x1) / 2);
      // the label sits on the curve's middle (a cubic Bézier's point at t = 0.5)
      edges.push({ from: input.from, to: n.key, label: input.label, path: `M${x1} ${y1} C${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`, lx: (x1 + 3 * (x1 + dx) + 3 * (x2 - dx) + x2) / 8, ly: (y1 + 3 * y1 + 3 * y2 + y2) / 8 });
    }
  }
  const width = Math.max(...[...placed.values()].map((p) => p.x + NODE_W), ...groups.map((g) => g.x + g.w)) + MARGIN;
  return { nodes: nodes.map((n) => ({ ...n, ...placed.get(n.key)! })), edges, groups, width, height: Math.max(bottom, placed.get("data")!.y + NODE_H) + MARGIN };
}

// ---------------------------------------------------------------- drawing

const STATUS: Record<ChainNode["status"], { icon?: string; text: string }> = {
  data: { text: "the data" },
  done: { icon: "check", text: "done" },
  failed: { icon: "warning", text: "failed" },
  proposed: { icon: "sparkle", text: "waiting for approval" },
  stale: { text: "waiting to run" },
  queued: { text: "queued" },
  running: { text: "running" },
  cancelled: { text: "cancelled" },
};

/** The chain as HTML: the runs' frames, the links (an SVG beneath), and a button per node. */
export function chainHtml(layout: ChainLayout): string {
  const groups = layout.groups
    .map(
      (g) => `<div class="cg-group status-${g.status}" style="left:${g.x}px;top:${g.y}px;width:${g.w}px;height:${g.h}px">
        <p class="cg-group-title"><span class="cg-run">Run ${g.index + 1}</span> ${escapeHtml(g.title)}</p>
        ${g.reason ? `<p class="cg-why">${icon("sparkle", 12)}<span>${escapeHtml(g.reason)}</span></p>` : g.summary ? `<p class="cg-about">${escapeHtml(g.summary)}</p>` : ""}
      </div>`,
    )
    .join("");
  const edges = layout.edges
    .map((e) => `<path d="${e.path}" marker-end="url(#cg-arrow)"/><text x="${e.lx.toFixed(1)}" y="${(e.ly - 6).toFixed(1)}" text-anchor="middle">${escapeHtml(e.label)}</text>`)
    .join("");
  const nodes = layout.nodes
    .map((n) => {
      const st = STATUS[n.status];
      const said = [n.title, n.tool, n.result, n.detail, st.text].filter(Boolean).join(", ");
      return `<button type="button" class="cg-node status-${n.status}" data-marker="${n.marker}" style="left:${n.x}px;top:${n.y}px;width:${NODE_W}px;height:${NODE_H}px" aria-label="${escapeHtml(`${said}. Show it`)}">
        <span class="cg-tool">${escapeHtml(n.tool)}${st.icon ? `<span class="cg-status" title="${st.text}">${icon(st.icon, 11)}</span>` : ""}</span>
        <span class="cg-title">${escapeHtml(n.title)}</span>
        ${n.result ? `<span class="cg-result"><strong>${escapeHtml(n.result)}</strong>${n.detail ? ` · ${escapeHtml(n.detail)}` : ""}</span>` : ""}
      </button>`;
    })
    .join("");
  return `<div class="cg" role="group" aria-label="The chain" style="width:${layout.width}px;height:${layout.height}px">
    ${groups}
    <svg class="cg-links" width="${layout.width}" height="${layout.height}" aria-hidden="true">
      <defs><marker id="cg-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L8 4 L0 8 z"/></marker></defs>
      ${edges}
    </svg>
    ${nodes}
  </div>`;
}
