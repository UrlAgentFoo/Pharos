/**
 * The jobs panel: every ship operation queued, downloading, running or
 * finished, with live progress and logs from the server's event stream,
 * and Cancel, Re-run and Open for each.
 */
import type { Job, ServerEvent } from "@pharos/contracts";
import { escapeHtml, formatSize } from "./dialogs.js";
import { icon } from "./icons.js";

export interface JobsHooks {
  cancel(id: string): Promise<unknown>;
  rerun(id: string): Promise<unknown>;
  /** Full log so far, for a job whose lines arrived before the panel saw them. */
  log(id: string): Promise<string>;
  /** Opens an output artifact in its viewer. */
  openOutput(workspace: string, artifactId: string): void;
  /** Called whenever the number of active jobs changes. */
  onActive(count: number): void;
  notify(text: string): void;
}

const ACTIVE: Job["state"][] = ["queued", "downloading", "running"];
const STATE_LABEL: Record<Job["state"], string> = {
  queued: "Waiting",
  downloading: "Downloading",
  running: "Running",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

export class JobsPanel {
  readonly el: HTMLElement;
  private readonly list: HTMLElement;
  private readonly jobs = new Map<string, Job>();
  private readonly logs = new Map<string, string[]>();
  private readonly openLogs = new Set<string>();
  private readonly pulls = new Map<string, { receivedBytes: number; totalBytes?: number }>();
  private renderQueued = false;

  constructor(private readonly hooks: JobsHooks) {
    this.el = document.createElement("aside");
    this.el.className = "chat jobs";
    this.el.hidden = true;
    this.el.setAttribute("aria-label", "Jobs");
    this.el.innerHTML = `
      <header class="chat-head">
        <span class="chat-mark jobs-mark">${icon("batch", 15)}</span><strong>Jobs</strong>
        <span class="spacer"></span>
        <button class="icon-btn" data-jobs="clear" title="Clear finished" aria-label="Clear finished">${icon("trash", 16)}</button>
        <button class="icon-btn" data-jobs="close" title="Close" aria-label="Close">${icon("close", 16)}</button>
      </header>
      <ol class="jobs-list" aria-live="polite"></ol>
      <p class="chat-foot">Ships run in containers on this computer, without network access, and only see the data you give them.</p>`;
    document.body.append(this.el);
    this.list = this.el.querySelector(".jobs-list")!;
    this.el.querySelector(".chat-head")!.addEventListener("click", (e) => {
      const what = (e.target as HTMLElement).closest<HTMLElement>("[data-jobs]")?.dataset.jobs;
      if (what === "close") this.el.hidden = true;
      if (what === "clear") {
        for (const [id, j] of this.jobs) if (!ACTIVE.includes(j.state)) this.jobs.delete(id);
        this.render();
      }
    });
    this.list.addEventListener("click", (e) => void this.act(e));
  }

  toggle() {
    this.el.hidden = !this.el.hidden;
    if (!this.el.hidden) this.render();
  }

  show() {
    this.el.hidden = false;
    this.render();
  }

  /** Starts with the jobs the server already has (e.g. after a page reload). */
  load(jobs: Job[]) {
    for (const j of jobs) this.jobs.set(j.id, j);
    this.changed();
  }

  handle(e: ServerEvent) {
    if (e.type === "job") {
      const before = this.jobs.get(e.job.id)?.state;
      this.jobs.set(e.job.id, e.job);
      if (before && before !== e.job.state && e.job.state === "failed") this.hooks.notify(`${e.job.ship}.${e.job.operation} failed: ${e.job.error ?? ""}`);
      this.changed();
    } else if (e.type === "job-log") {
      const lines = this.logs.get(e.jobId) ?? [];
      lines.push(e.line);
      if (lines.length > 2000) lines.splice(0, lines.length - 2000);
      this.logs.set(e.jobId, lines);
      if (this.openLogs.has(e.jobId)) this.changed();
    } else if (e.type === "pull") {
      const key = `${e.ship}@${e.version}`;
      if (e.done) this.pulls.delete(key);
      else this.pulls.set(key, e);
      if (e.error) this.hooks.notify(`Couldn't download ${e.ship}: ${e.error}`);
      this.changed();
    }
  }

  private changed() {
    this.hooks.onActive([...this.jobs.values()].filter((j) => ACTIVE.includes(j.state)).length);
    if (this.el.hidden || this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  private async act(e: Event) {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-act]");
    const id = b?.closest<HTMLElement>("[data-job]")?.dataset.job;
    if (!b || !id) return;
    const job = this.jobs.get(id)!;
    try {
      if (b.dataset.act === "cancel") await this.hooks.cancel(id);
      if (b.dataset.act === "rerun") await this.hooks.rerun(id);
      if (b.dataset.act === "open" && job.workspace) this.hooks.openOutput(job.workspace, b.dataset.artifact!);
      if (b.dataset.act === "log") {
        if (this.openLogs.has(id)) this.openLogs.delete(id);
        else {
          this.openLogs.add(id);
          if (!this.logs.has(id)) this.logs.set(id, (await this.hooks.log(id)).split("\n").filter(Boolean));
        }
        this.render();
      }
    } catch (err) {
      this.hooks.notify(err instanceof Error ? err.message : String(err));
    }
  }

  private render() {
    const jobs = [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (!jobs.length) {
      this.list.innerHTML = `<li class="jobs-empty">No jobs yet. In the Workspace, pick your data and choose <strong>Run…</strong> to run a ship on it.</li>`;
      return;
    }
    this.list.innerHTML = jobs.map((j) => this.item(j)).join("");
    for (const pre of this.list.querySelectorAll("pre")) pre.scrollTop = pre.scrollHeight;
  }

  private item(j: Job): string {
    const active = ACTIVE.includes(j.state);
    const pull = j.state === "downloading" ? this.pulls.get(`${j.ship}@${j.version}`) : undefined;
    const progress = pull?.totalBytes ? pull.receivedBytes / pull.totalBytes : j.state === "running" ? (j.progress ?? 0) : j.state === "done" ? 1 : undefined;
    const message = pull ? `Downloading ${j.ship}: ${formatSize(pull.receivedBytes)}${pull.totalBytes ? ` of ${formatSize(pull.totalBytes)}` : ""}` : (j.error ?? j.message ?? "");
    const outputs = j.state === "done" ? Object.entries(j.outputs ?? {}) : [];
    const log = this.openLogs.has(j.id) ? `<pre class="code jobs-log">${escapeHtml((this.logs.get(j.id) ?? []).join("\n") || "(no output yet)")}</pre>` : "";
    return `<li class="job state-${j.state}" data-job="${escapeHtml(j.id)}">
      <div class="job-top"><strong>${escapeHtml(j.ship)}.${escapeHtml(j.operation)}</strong>
        <span class="job-state">${STATE_LABEL[j.state]}${j.cached ? " · cached" : ""}${j.gpu ? " · GPU" : ""}</span></div>
      ${progress !== undefined && active ? `<div class="job-bar" role="progressbar" aria-valuenow="${Math.round(progress * 100)}" aria-valuemin="0" aria-valuemax="100"><span style="width:${(progress * 100).toFixed(1)}%"></span></div>` : ""}
      ${message ? `<p class="job-msg">${escapeHtml(message)}</p>` : ""}
      <div class="job-actions">
        ${active ? `<button class="chip" data-act="cancel">Cancel</button>` : `<button class="chip" data-act="rerun" title="Run again, ignoring any cached result">Re-run</button>`}
        <button class="chip" data-act="log">${this.openLogs.has(j.id) ? "Hide log" : "Log"}</button>
        ${outputs.map(([name, id]) => `<button class="chip" data-act="open" data-artifact="${escapeHtml(id)}">${icon("open", 13)} ${escapeHtml(name)}</button>`).join("")}
      </div>
      ${log}
    </li>`;
  }
}
