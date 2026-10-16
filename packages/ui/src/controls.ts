/**
 * The Controls drawer on the right of each image window: the canvas tools
 * (shared by every window), what is shown
 * (channels, slice, frame), how it is shown (contrast, set by dragging on the
 * histogram), what it measures, and any control panels the assistant pinned
 * to this image. Sections fold away; the whole drawer collapses.
 */
import { type PixelArray, autoContrast, getCommand, getPlane, histogram, minMax, parseParams, planeStats } from "@pharos/core";
import { escapeHtml, paramFields, readParamFields } from "./dialogs.js";
import { icon } from "./icons.js";
import type { ResultRow, SummaryRow } from "./results.js";
import { CHANNEL_COLORS, TOOLS, type Tool, getTool, setTool } from "./viewer.js";
import type { Doc } from "./workspace.js";

export interface ControlsHooks {
  /** Re-renders the window's pixels after a display change. */
  redraw(): void;
  applyStep(doc: Doc, command: string, params: Record<string, unknown>): Promise<void>;
  /** Asks the assistant for controls suited to this image, optionally for a described task. */
  suggest(doc: Doc, request: string): void;
  removePanel(doc: Doc, index: number): void;
  dtypeLabel(dtype: string): string;
  /** This image's measurements and particle-analysis summaries, oldest first. */
  measurements(doc: Doc): ResultRow[];
  summaries(doc: Doc): SummaryRow[];
  /** Shows the image, slice and selection a measurement was made on. */
  showRow(row: ResultRow): void;
  /** Opens the Results table on this image. */
  openResults(doc: Doc): void;
  removeRow(row: ResultRow): void;
}

const fmt = (v: number) => (Number.isInteger(v) ? v.toLocaleString("en-US") : Math.abs(v) >= 1000 ? Math.round(v).toLocaleString("en-US") : v.toPrecision(4));

export class Controls {
  readonly el: HTMLElement;
  private folded = new Set<string>(["stats"]);
  /** Measurement count at the last build, to open the list when one is added. */
  private measured = -1;

  constructor(
    private readonly doc: Doc,
    private readonly hooks: ControlsHooks,
  ) {
    this.el = document.createElement("aside");
    this.el.className = "ctl-drawer";
    this.el.setAttribute("aria-label", `Controls for ${doc.name}`);
    this.el.addEventListener("click", (e) => this.onClick(e));
  }

  /** Rebuilds the drawer from the image and its view. */
  update() {
    const { doc } = this;
    const img = doc.timeline.current();
    const { width, height, channels, slices, frames } = img.shape;
    const view = doc.view;
    const cal = img.calibration;
    const scale = cal.unit !== "pixel" ? ` · ${+cal.pixelWidth.toPrecision(3)} ${cal.unit}/px` : "";
    const parts: string[] = [];
    const tool = getTool();
    parts.push(`<div class="tools" role="radiogroup" aria-label="Canvas tool">${TOOLS.map((t) => `<button class="tool" role="radio" data-ctl="tool" data-tool="${t.id}" aria-checked="${t.id === tool}" title="${escapeHtml(t.label)} (${t.key})" aria-label="${escapeHtml(t.label)}">${icon(`tool-${t.id}`, 16)}</button>`).join("")}</div>`);
    parts.push(`<p class="ctl-summary">${width} × ${height}${slices > 1 ? ` × ${slices}` : ""} · ${this.hooks.dtypeLabel(img.dtype)}${scale}</p>`);

    // what is shown
    const view$: string[] = [];
    if (channels > 1) {
      view$.push(`<div class="ch-chips">${Array.from({ length: channels }, (_, c) => {
        const off = view.composite && view.hidden[c];
        const sel = c === view.pos.c;
        return `<span class="ch-chip${sel ? " sel" : ""}${off ? " off" : ""}">
          <button class="ch-dot" data-ctl="toggle-ch" data-c="${c}" title="${off ? "Show" : "Hide"} channel ${c + 1}" aria-label="${off ? "Show" : "Hide"} channel ${c + 1}" style="--ch:${CHANNEL_COLORS[c % CHANNEL_COLORS.length]}"></button>
          <button class="ch-name" data-ctl="pick-ch" data-c="${c}" title="Adjust channel ${c + 1}">Ch ${c + 1}</button></span>`;
      }).join("")}<button class="ch-mode" data-ctl="composite" title="${view.composite ? "Show one channel at a time" : "Overlay all channels"}">${view.composite ? "Overlay" : "Single"}</button></div>`);
    }
    for (const [key, label, n] of [["z", "Slice", slices], ["t", "Frame", frames]] as const) {
      if (n < 2) continue;
      view$.push(`<div class="stepper" data-key="${key}">
        <span class="stepper-label">${label}</span>
        <button class="step-btn" data-ctl="step" data-key="${key}" data-d="-1" aria-label="Previous ${label.toLowerCase()}">‹</button>
        <input type="range" min="1" max="${n}" step="1" value="${view.pos[key] + 1}" aria-label="${label}" />
        <button class="step-btn" data-ctl="step" data-key="${key}" data-d="1" aria-label="Next ${label.toLowerCase()}">›</button>
        <output>${view.pos[key] + 1}<small>/${n}</small></output></div>`);
    }
    if (view$.length) parts.push(this.section("view", "View", view$.join("")));

    // contrast, adjusted on the histogram
    const c = view.pos.c;
    const [min, max] = view.ranges[c];
    parts.push(
      this.section(
        "contrast",
        `Contrast${channels > 1 ? ` · Ch ${c + 1}` : ""}`,
        `<div class="hist-wrap"><canvas class="hist" height="64" aria-label="Histogram: drag the handles to set the display range"></canvas></div>
         <div class="hist-values"><span>${fmt(min)}</span><span class="hist-actions"><button class="chip" data-ctl="auto">Auto</button><button class="chip" data-ctl="reset">Reset</button></span><span>${fmt(max)}</span></div>
         <p class="ctl-note">Display only. Pixel values are unchanged.</p>`,
      ),
    );

    // this window's measurements: one line per Measure, one per Analyze Particles run
    const rows = this.hooks.measurements(doc);
    const added = rows.length > this.measured && this.measured >= 0;
    if (added) this.folded.delete("measure");
    this.measured = rows.length;
    const unit = cal.unit === "pixel" ? "px" : cal.unit;
    const runs = new Map<number, ResultRow[]>();
    const lines: string[] = [];
    rows.forEach((r, i) => {
      if (r.run !== undefined) {
        if (!runs.has(r.run)) {
          runs.set(r.run, []);
          lines.push(`run:${r.run}`);
        }
        runs.get(r.run)!.push(r);
      } else lines.push(`row:${i}`);
    });
    const summaries = this.hooks.summaries(doc);
    const item = (key: string) => {
      const [kind, n] = key.split(":");
      if (kind === "run") {
        const sum = summaries.find((s) => s.run === Number(n));
        const count = runs.get(Number(n))!.length;
        const avg = sum?.values["Average Size"];
        return `<li><button class="ms-row" data-ctl="open-results" title="Show the particles in Results">${icon("particles", 13)}<span class="ms-what">${count} particle${count === 1 ? "" : "s"}${sum?.slice ? ` · ${escapeHtml(sum.slice)}` : ""}</span><span class="ms-val">${avg !== undefined && Number.isFinite(avg) ? `avg ${fmt(avg)} ${unit}²` : ""}</span></button></li>`;
      }
      const r = rows[Number(n)];
      const v = r.values;
      const shape = r.roi ? (r.roi.type === "traced" ? "freehand" : r.roi.type) : null;
      const label = shape ? { rect: "Rectangle", oval: "Oval", polygon: "Polygon", freehand: "Freehand", line: "Line" }[shape] : "Whole slice";
      const what = `<span class="ms-shape" title="${label}">${shape ? icon(`tool-${shape}`, 13) : icon("image", 13)}</span>${r.slice ? escapeHtml(r.slice) : ""}`;
      const val = "Length" in v ? `${fmt(v.Length)} ${unit}` : `${fmt(v.Area)} ${unit}² · ${fmt(v.Mean)}`;
      const valTitle = "Length" in v ? "Length" : "Area · Mean";
      return `<li><button class="ms-row" data-ctl="show-row" data-i="${n}" title="Show this selection again"><span class="ms-n">${rows.slice(0, Number(n) + 1).filter((x) => x.run === undefined).length}</span><span class="ms-what">${what}</span><span class="ms-val" title="${valTitle}">${val}</span></button><button class="ctl-x" data-ctl="remove-row" data-i="${n}" title="Remove" aria-label="Remove measurement">${icon("close", 11)}</button></li>`;
    };
    parts.push(
      this.section(
        "measure",
        "Measure",
        lines.length
          ? `<ul class="ms-list">${lines.map(item).join("")}</ul><button class="chip ms-all" data-ctl="open-results">All columns in Results</button>`
          : `<p class="ctl-note">Draw a selection and press <kbd>M</kbd> (Analyze › Measure). Without one, the whole slice is measured.</p>`,
        rows.length ? `${rows.length}` : undefined,
      ),
    );

    // quick statistics of the shown slice
    const s = planeStats(this.plane());
    const area = width * height * cal.pixelWidth * cal.pixelHeight;
    const stats: [string, string][] = [
      ["Mean", fmt(s.mean)],
      ["Std dev", fmt(s.stdDev)],
      ["Min", fmt(s.min)],
      ["Max", fmt(s.max)],
      ["Area", `${fmt(area)} ${unit}²`],
    ];
    if (slices > 1) stats.push(["Volume", `${fmt(area * slices * cal.pixelDepth)} ${unit}³`]);
    parts.push(
      this.section(
        "stats",
        "Statistics",
        `<dl class="measure">${stats.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>
         <p class="ctl-note">Whole ${slices > 1 ? "slice (area) and stack (volume)" : "image"}, live.</p>`,
        `${fmt(s.mean)} mean`,
      ),
    );

    // panels the assistant suggested for this image
    doc.panels.forEach((p, i) => {
      const rows$ = p.commands
        .map((id) => {
          const cmd = getCommand(id);
          const hasParams = Object.keys(cmd.params).length > 0;
          return `<form class="ctl-cmd" data-cmd="${id}">
            <div class="ctl-cmd-head">${icon(cmd.icon, 15)}<span>${escapeHtml(cmd.title.replace(/…$/, ""))}</span><button class="chip">${hasParams ? "Apply" : "Run"}</button></div>
            ${hasParams ? paramFields(cmd, Object.fromEntries(Object.entries(cmd.params).map(([k, sp]) => [k, sp.default]))) : ""}</form>`;
        })
        .join("");
      parts.push(this.section(`panel-${i}`, p.title, rows$, undefined, i));
    });

    parts.push(`<form class="ctl-suggest" aria-label="Ask the assistant for controls">
      <input name="ask" type="text" autocomplete="off" placeholder="Suggest control interface…" aria-label="Describe what you want to do" />
      <button title="Send to the assistant" aria-label="Send">${icon("plane-solid", 16)}</button>
    </form>`);
    this.el.innerHTML = parts.join("");
    this.wireInputs();
    requestAnimationFrame(() => this.drawHistogram());
    // show a new measurement where it lands, even if the drawer is scrolled elsewhere
    if (added) requestAnimationFrame(() => this.el.querySelector(".ms-list li:last-child")?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  }

  private section(id: string, title: string, body: string, foldedHint?: string, panel?: number) {
    const folded = this.folded.has(id);
    const ai = panel !== undefined;
    return `<section class="ctl-sec${folded ? " folded" : ""}${ai ? " ai" : ""}" data-sec="${id}">
      <header><button class="ctl-sec-head" data-ctl="fold" data-sec="${id}" aria-expanded="${!folded}">
        <span class="chev">${folded ? "▸" : "▾"}</span>${ai ? icon("sparkle", 12) : ""}<span>${escapeHtml(title)}</span>
        ${folded && foldedHint ? `<small>${escapeHtml(foldedHint)}</small>` : ""}</button>
        ${ai ? `<button class="ctl-x" data-ctl="remove-panel" data-i="${panel}" title="Remove this panel" aria-label="Remove panel">${icon("close", 11)}</button>` : ""}</header>
      ${folded ? "" : `<div class="ctl-body">${body}</div>`}</section>`;
  }

  private plane(): PixelArray {
    const img = this.doc.timeline.current();
    const { c, z, t } = this.doc.view.pos;
    return getPlane(img, c, z, t);
  }

  /** The value range the histogram spans: the type's range for integers, the data range for float. */
  private domain(): [number, number] {
    const img = this.doc.timeline.current();
    const [lo, hi] = minMax(this.plane());
    if (img.dtype === "uint8") return [0, 255];
    if (img.dtype === "uint16") return [0, Math.max(hi, this.doc.view.ranges[this.doc.view.pos.c][1], 1)];
    return [Math.min(lo, this.doc.view.ranges[this.doc.view.pos.c][0]), Math.max(hi, this.doc.view.ranges[this.doc.view.pos.c][1])];
  }

  private drawHistogram() {
    const canvas = this.el.querySelector<HTMLCanvasElement>("canvas.hist");
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const W = (canvas.width = Math.round(canvas.clientWidth * dpr) || 200);
    const H = (canvas.height = Math.round(canvas.clientHeight * dpr) || 64);
    const ctx = canvas.getContext("2d")!;
    const [lo, hi] = this.domain();
    const bins = 96;
    const h = histogram(this.plane(), bins, lo, hi);
    // the tallest bin is often a background spike; scale to the second tallest like ImageJ
    const sorted = Array.from(h).sort((a, b) => b - a);
    const peak = Math.max(1, sorted[1] * 1.5 || sorted[0]);
    const css = getComputedStyle(this.el);
    const [min, max] = this.doc.view.ranges[this.doc.view.pos.c];
    const x = (v: number) => ((v - lo) / (hi - lo || 1)) * W;
    ctx.clearRect(0, 0, W, H);
    // shade what falls outside the display range
    ctx.fillStyle = css.getPropertyValue("--well").trim();
    ctx.fillRect(0, 0, x(min), H);
    ctx.fillRect(x(max), 0, W - x(max), H);
    ctx.fillStyle = css.getPropertyValue("--hist").trim();
    for (let i = 0; i < bins; i++) {
      const bh = Math.min(H, (h[i] / peak) * H);
      ctx.fillRect((i * W) / bins, H - bh, W / bins - 0.6 * dpr, bh);
    }
    // the mapping line and its two handles
    ctx.strokeStyle = css.getPropertyValue("--ink").trim();
    ctx.lineWidth = 1.2 * dpr;
    ctx.beginPath();
    ctx.moveTo(x(min), H);
    ctx.lineTo(x(max), 0);
    ctx.stroke();
    for (const v of [min, max]) {
      ctx.fillStyle = css.getPropertyValue("--ink").trim();
      ctx.fillRect(x(v) - 1 * dpr, 0, 2 * dpr, H);
      ctx.beginPath();
      ctx.arc(x(v), H - 5 * dpr, 4.5 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = css.getPropertyValue("--surface").trim();
      ctx.fill();
      ctx.stroke();
    }
  }

  private wireInputs() {
    const view = this.doc.view;
    this.el.querySelectorAll<HTMLElement>(".stepper").forEach((st) => {
      const key = st.dataset.key as "z" | "t";
      const input = st.querySelector("input")!;
      input.addEventListener("input", () => {
        view.pos[key] = Number(input.value) - 1;
        st.querySelector("output")!.firstChild!.textContent = input.value;
        this.hooks.redraw();
        this.refreshLive();
      });
    });

    // drag the display range on the histogram: the nearer handle follows the pointer
    const canvas = this.el.querySelector<HTMLCanvasElement>("canvas.hist");
    canvas?.addEventListener("pointerdown", (e) => {
      const rect = canvas.getBoundingClientRect();
      const [lo, hi] = this.domain();
      const toValue = (clientX: number) => lo + Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * (hi - lo);
      const c = view.pos.c;
      const v0 = toValue(e.clientX);
      const which = Math.abs(v0 - view.ranges[c][0]) <= Math.abs(v0 - view.ranges[c][1]) ? 0 : 1;
      const step = this.doc.timeline.current().dtype === "float32" ? 0 : 1;
      canvas.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        let v = toValue(ev.clientX);
        if (step) v = Math.round(v);
        const r: [number, number] = [...view.ranges[c]];
        r[which] = which === 0 ? Math.min(v, r[1] - (step || (hi - lo) / 1000)) : Math.max(v, r[0] + (step || (hi - lo) / 1000));
        view.ranges[c] = r;
        view.manualRange = true;
        this.hooks.redraw();
        this.drawHistogram();
        const vals = this.el.querySelectorAll(".hist-values > span:not(.hist-actions)");
        vals[0].textContent = fmt(r[0]);
        vals[1].textContent = fmt(r[1]);
      };
      move(e);
      canvas.addEventListener("pointermove", move);
      canvas.addEventListener("pointerup", () => canvas.removeEventListener("pointermove", move), { once: true });
    });

    const ask = this.el.querySelector<HTMLFormElement>("form.ctl-suggest");
    ask?.addEventListener("submit", (e) => {
      e.preventDefault();
      const input = ask.querySelector("input")!;
      this.hooks.suggest(this.doc, input.value.trim());
      input.value = "";
    });

    this.el.querySelectorAll<HTMLFormElement>("form.ctl-cmd").forEach((form) => {
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const cmd = getCommand(form.dataset.cmd!);
        const values = readParamFields(cmd, form);
        form.querySelector(".error")?.remove();
        try {
          parseParams(cmd, values);
        } catch (x) {
          form.insertAdjacentHTML("beforeend", `<p class="error small">${escapeHtml(x instanceof Error ? x.message : String(x))}</p>`);
          return;
        }
        await this.hooks.applyStep(this.doc, cmd.id, values);
      });
    });
  }

  /** Updates the parts that follow the slice without rebuilding the drawer (keeps a slider drag alive). */
  private refreshLive() {
    this.drawHistogram();
    const s = planeStats(this.plane());
    const dds = this.el.querySelectorAll(".measure dd");
    if (dds.length) [s.mean, s.stdDev, s.min, s.max].forEach((v, i) => (dds[i].textContent = fmt(v)));
  }

  private onClick(e: MouseEvent) {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-ctl]");
    if (!el) return;
    const { doc } = this;
    const view = doc.view;
    const img = doc.timeline.current();
    switch (el.dataset.ctl) {
      case "tool":
        return setTool(el.dataset.tool as Tool);
      case "fold": {
        const id = el.dataset.sec!;
        if (this.folded.has(id)) this.folded.delete(id);
        else this.folded.add(id);
        return this.update();
      }
      case "toggle-ch": {
        const c = Number(el.dataset.c);
        if (!view.composite) {
          view.composite = true;
          view.hidden = [];
        }
        view.hidden[c] = !view.hidden[c];
        break;
      }
      case "pick-ch":
        view.pos.c = Number(el.dataset.c);
        if (!view.composite) break;
        if (e.detail === 2) view.hidden = view.hidden.map((_, i) => i !== view.pos.c); // double-click: only this one
        break;
      case "composite":
        view.composite = !view.composite;
        break;
      case "step": {
        const key = el.dataset.key as "z" | "t";
        const n = key === "z" ? img.shape.slices : img.shape.frames;
        view.pos[key] = (view.pos[key] + Number(el.dataset.d) + n) % n;
        break;
      }
      case "auto":
        view.ranges[view.pos.c] = autoContrast(this.plane());
        view.manualRange = true;
        break;
      case "reset":
        view.ranges[view.pos.c] = img.dtype === "uint8" ? [0, 255] : minMax(this.plane());
        view.manualRange = true;
        break;
      case "remove-panel":
        return this.hooks.removePanel(doc, Number(el.dataset.i));
      case "show-row":
        return this.hooks.showRow(this.hooks.measurements(doc)[Number(el.dataset.i)]);
      case "remove-row":
        return this.hooks.removeRow(this.hooks.measurements(doc)[Number(el.dataset.i)]);
      case "open-results":
        return this.hooks.openResults(doc);
      default:
        return;
    }
    this.hooks.redraw();
    this.update();
  }
}
