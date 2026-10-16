/**
 * The plan panel: a proposed plan to review, edit and approve, then its
 * run step by step. Inputs and parameters can change until it's approved;
 * every change is checked again by the server, and Approve stays disabled
 * while the plan has errors. Ships that will download are listed first.
 */
import type { Artifact, BookManifest, Job, Plan, ServerEvent } from "@pharos/contracts";
import type { LocalServer } from "./api.js";
import { escapeHtml, formatSize, promptDialog } from "./dialogs.js";
import { icon } from "./icons.js";
import { manifestParamFields, readManifestParams } from "./run-dialog.js";

export interface PlanHooks {
  openOutput(workspace: string, artifactId: string): void;
  notify(text: string): void;
  /** Called when a plan starts running, e.g. to show the jobs panel. */
  started(): void;
}

const STEP_STATE: Record<Job["state"], string> = { queued: "waiting", downloading: "downloading", running: "running", done: "done", failed: "failed", cancelled: "cancelled" };

export class PlanPanel {
  readonly el: HTMLElement;
  private readonly body: HTMLElement;
  private plan: Plan | null = null;
  private book: BookManifest | undefined;
  private artifacts: Artifact[] = [];
  private readonly jobs = new Map<string, Job>();
  private saving: ReturnType<typeof setTimeout> | undefined;
  private stale = false;

  constructor(
    private readonly server: () => LocalServer | null,
    private readonly hooks: PlanHooks,
  ) {
    this.el = document.createElement("aside");
    this.el.className = "chat plan-panel";
    this.el.hidden = true;
    this.el.setAttribute("aria-label", "Plan");
    this.el.innerHTML = `
      <header class="chat-head"><span class="chat-mark plan-mark">${icon("layout", 15)}</span><strong>Plan</strong><span class="spacer"></span>
        <button class="icon-btn" data-plan="close" title="Close" aria-label="Close">${icon("close", 16)}</button></header>
      <div class="plan-body"></div>`;
    document.body.append(this.el);
    this.body = this.el.querySelector(".plan-body")!;
    this.el.querySelector("[data-plan=close]")!.addEventListener("click", () => (this.el.hidden = true));
    this.body.addEventListener("click", (e) => void this.act(e));
    this.body.addEventListener("change", (e) => this.edited(e));
    // a re-render while typing would throw the half-typed value away: catch up when the field is left
    this.body.addEventListener("focusout", () => setTimeout(() => this.stale && this.render()));
  }

  /** Shows a plan, loading what it needs to render: its book and the workspace's data. */
  async show(plan: Plan) {
    const s = this.server();
    if (!s) return;
    this.plan = plan;
    [this.book, this.artifacts] = await Promise.all([plan.book ? s.book(plan.book.id, plan.book.version).then((b) => b.manifest) : Promise.resolve(undefined), s.artifacts(plan.workspace)]);
    this.el.hidden = false;
    this.render();
  }

  handle(e: ServerEvent) {
    if (!this.plan) return;
    if (e.type === "plan" && e.plan.id === this.plan.id) {
      this.plan = e.plan;
      this.render();
    } else if (e.type === "job" && e.job.planId === this.plan.id) {
      this.jobs.set(e.job.id, e.job);
      this.render();
    }
  }

  private inputNames(): { name: string; kind: string }[] {
    const p = this.plan!;
    if (this.book) return (this.book.inputs ?? []).map((i) => ({ name: i.name, kind: i.accepts.kind }));
    return Object.keys(p.inputs).map((name) => ({ name, kind: this.artifacts.find((a) => a.id === p.inputs[name])?.kind ?? "" }));
  }

  private render() {
    const p = this.plan;
    if (!p) return;
    const focused = document.activeElement;
    if (focused instanceof HTMLInputElement && this.body.contains(focused)) {
      this.stale = true;
      return;
    }
    this.stale = false;
    const editable = p.status === "proposed";
    const errors = p.problems.filter((x) => x.severity === "error");
    const warnings = p.problems.filter((x) => x.severity === "warning");
    const toDownload = p.ships.filter((s) => !s.downloaded);
    const known = toDownload.reduce((n, s) => n + (s.sizeBytes ?? 0), 0);

    const inputs = this.inputNames()
      .map(({ name, kind }) => {
        const options = this.artifacts.filter((a) => !kind || a.kind === kind);
        const chosen = p.inputs[name];
        return `<label class="field">${escapeHtml(name.replace(/_/g, " "))} <small>${escapeHtml(kind)}</small>
          <select name="input:${escapeHtml(name)}" ${editable ? "" : "disabled"}><option value="">Choose data…</option>${options.map((a) => `<option value="${a.id}" ${a.id === chosen ? "selected" : ""}>${escapeHtml(a.name ?? a.id.slice(0, 12))}</option>`).join("")}</select></label>`;
      })
      .join("");

    const params = this.book?.parameters?.length
      ? `<form class="plan-params" ${editable ? "" : "inert"}>${manifestParamFields(this.book.parameters, p.parameters)}</form>`
      : "";

    const steps = p.steps
      .map((s) => {
        const jobId = p.jobs?.[s.id];
        const job = jobId ? this.jobs.get(jobId) : undefined;
        const state = job ? STEP_STATE[job.state] + (job.cached ? " (cached)" : "") : p.status === "proposed" ? "" : "waiting";
        const bar = job && (job.state === "running" || job.state === "downloading") ? `<span class="job-bar"><span style="width:${((job.progress ?? 0) * 100).toFixed(0)}%"></span></span>` : "";
        return `<li class="plan-step ${job ? `state-${job.state}` : ""}"><span><strong>${escapeHtml(s.id)}</strong> <small>${escapeHtml(s.run)}</small></span><small class="job-state">${escapeHtml(state)}</small>${bar}</li>`;
      })
      .join("");

    const ships = p.ships
      .map((s) => `<li>${s.downloaded ? icon("check", 14) : icon("upload", 14)} ${escapeHtml(s.id)} ${escapeHtml(s.version)} <small>${s.downloaded ? "downloaded" : s.sizeBytes ? `downloads ${formatSize(s.sizeBytes)}` : "will download"}${s.gpu !== "none" ? ` · GPU ${s.gpu}` : ""}</small></li>`)
      .join("");

    const outputs = Object.entries(p.outputs ?? {})
      .map(([name, id]) => `<button class="chip" data-open="${escapeHtml(id)}">${icon("open", 13)} ${escapeHtml(name)}</button>`)
      .join("");

    const footer =
      p.status === "proposed"
        ? `<button data-act="cancel">Discard</button><button class="primary" data-act="approve" ${errors.length ? "disabled" : ""}>${icon("batch", 15)} Approve and run</button>`
        : p.status === "running" || p.status === "approved"
          ? `<button data-act="cancel">Cancel run</button>`
          : p.status === "done"
            ? `<button data-act="save">Save as book…</button>`
            : "";

    this.body.innerHTML = `
      <p class="eyebrow">${p.source === "book" ? `Book · ${escapeHtml(p.book!.id)} ${escapeHtml(p.book!.version)}` : "Improvised pipeline"} · ${escapeHtml(p.status)}</p>
      <h2 class="plan-title">${escapeHtml(p.title)}</h2>
      ${p.rationale ? `<p class="plan-why">${icon("sparkle", 14)} ${escapeHtml(p.rationale)}</p>` : ""}
      ${p.error ? `<p class="chat-warn">${escapeHtml(p.error)}</p>` : ""}
      <h3>Data</h3>${inputs || `<p class="muted small">This plan takes no data.</p>`}
      ${params ? `<h3>Parameters</h3>${params}` : ""}
      <h3>Steps</h3><ol class="plan-steps">${steps}</ol>
      <h3>Ships</h3><ul class="plan-ships">${ships}</ul>
      ${toDownload.length && editable ? `<p class="muted small">Approving downloads ${toDownload.length} ship${toDownload.length === 1 ? "" : "s"}${known ? ` (${formatSize(known)} known so far)` : ""}. Nothing else is downloaded.</p>` : ""}
      ${errors.length ? `<ul class="plan-problems">${errors.map((x) => `<li class="error">${icon("warning", 14)} ${escapeHtml(x.message)}</li>`).join("")}</ul>` : ""}
      ${warnings.length ? `<ul class="plan-problems">${warnings.map((x) => `<li>${escapeHtml(x.message)}</li>`).join("")}</ul>` : ""}
      ${outputs ? `<h3>Results</h3><div class="job-actions">${outputs}</div>` : ""}
      <footer class="plan-foot">${footer}</footer>`;
  }

  /** Inputs and parameters save (and re-check) shortly after each change. */
  private edited(e: Event) {
    const p = this.plan;
    const s = this.server();
    if (!p || !s || p.status !== "proposed") return;
    clearTimeout(this.saving);
    this.saving = setTimeout(async () => {
      const inputs = { ...p.inputs };
      for (const sel of this.body.querySelectorAll<HTMLSelectElement>("select[name^='input:']")) {
        const name = sel.name.slice("input:".length);
        if (sel.value) inputs[name] = sel.value;
        else delete inputs[name];
      }
      const form = this.body.querySelector<HTMLFormElement>(".plan-params");
      const parameters = form && this.book?.parameters ? readManifestParams(this.book.parameters, form) : p.parameters;
      try {
        this.plan = await s.updatePlan(p.id, { inputs, parameters });
        this.render();
      } catch (err) {
        this.hooks.notify(err instanceof Error ? err.message : String(err));
      }
    }, e.target instanceof HTMLSelectElement ? 0 : 400);
  }

  private async act(e: Event) {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
    const p = this.plan;
    const s = this.server();
    if (!b || !p || !s) return;
    try {
      if (b.dataset.open) return this.hooks.openOutput(p.workspace, b.dataset.open);
      if (b.dataset.act === "approve") {
        b.disabled = true;
        const r = await s.approvePlan(p.id);
        this.plan = r.plan;
        for (const j of r.jobs) this.jobs.set(j.id, j);
        this.render();
        this.hooks.started();
      }
      if (b.dataset.act === "cancel") {
        this.plan = await s.cancelPlan(p.id);
        if (this.plan.status === "cancelled") this.el.hidden = true;
        this.render();
      }
      if (b.dataset.act === "save") {
        const id = await promptDialog("Save as book", "Book id (lowercase-with-hyphens)", p.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40));
        if (!id) return;
        const entry = await s.saveAsBook(p.id, { id, title: p.title, summary: p.rationale ?? p.title });
        this.hooks.notify(`Saved "${entry.title}" to your library as ${entry.id}`);
      }
    } catch (err) {
      this.hooks.notify(err instanceof Error ? err.message : String(err));
      this.render();
    }
  }
}
