/**
 * What happens in data windows: applying processes to a dataset and
 * running its history.
 *
 * A process is one ship operation, or a recipe (book) that adds several
 * steps at once: the book is the instructions, the steps it adds land in
 * the window's history like any other. A new step is wired to the result on
 * view (or the most recent earlier result of the right kind).
 *
 * Running sends the whole history as one plan. Unchanged steps come straight
 * from the cache, so only new or changed steps actually run; job events
 * then update each history node as it runs.
 */
import { type Artifact, type BookAction, type BookCard, type BookManifest, type Job, type ParamSpec, type Params, type Plan, type ServerEvent, type ShipManifest, type Step, bookAction } from "@pharos/contracts";
import type { LocalServer } from "./api.js";
import type { DataWindowHooks, StepSpec, Suggestion } from "./data-window.js";
import { escapeHtml, showDialog } from "./dialogs.js";
import { icon } from "./icons.js";
import { manifestParamFields, readManifestParams } from "./param-fields.js";
import type { DataDoc, DataStep, Workspace } from "./workspace.js";

export interface ProcessHooks {
  server(): LocalServer | null;
  notify(text: string): void;
  /** Runs slow work with the busy indicator; errors become a dialog. */
  busy<T>(label: string, fn: () => Promise<T>): Promise<T | undefined>;
  /** The artifact a data window shows. */
  shownArtifact(doc: DataDoc): Promise<Artifact | null>;
}

const SOURCE = "data";

/** A value a new step can take as an input: the data itself, or an earlier step's output. */
interface Available {
  wire: string;
  kind: Artifact["kind"];
  format: Artifact["format"];
}

export class DataProcesses implements Omit<DataWindowHooks, "server" | "notify"> {
  private ships = new Map<string, ShipManifest>();
  private trust = new Map<string, string>();
  private shipsLoading: Promise<void> | null = null;
  /** Plan id → the data window it runs. */
  private readonly running = new Map<string, DataDoc>();

  constructor(
    private readonly ws: Workspace,
    private readonly hooks: ProcessHooks,
  ) {}

  private get server(): LocalServer {
    const s = this.hooks.server();
    if (!s) throw new Error("Processes need the local Pharos server.");
    return s;
  }

  /** Loads (or reloads, after the library changes) every ship's manifest. */
  loadShips(force = false): Promise<void> {
    if (!force && this.shipsLoading) return this.shipsLoading;
    this.shipsLoading = (async () => {
      const s = this.hooks.server();
      if (!s) return;
      const entries = await s.ships();
      const manifests = await Promise.all(entries.map((e) => s.ship(e.id, e.version).then((r) => r.manifest)));
      this.ships = new Map(manifests.map((m) => [m.id, m]));
      this.trust = new Map(entries.map((e) => [e.id, e.trust]));
      this.ws.touch();
    })();
    return this.shipsLoading;
  }

  stepSpec(run: string): StepSpec | undefined {
    const [ship, op] = run.split(".");
    const o = this.ships.get(ship)?.operations[op];
    return o && { title: `${ship} › ${op}`, summary: o.summary, params: o.parameters ?? [], makes: o.outputs?.[0]?.kind };
  }

  // ---------------------------------------------------------- what can be applied

  /** The values a step added now can use: the shown result first, then earlier results, then the data. */
  private available(doc: DataDoc): Available[] {
    const out: Available[] = [];
    const add = (step: DataStep) => {
      const [ship, op] = step.run.split(".");
      const outputs = this.ships.get(ship)?.operations[op]?.outputs ?? [];
      const preferred = step === doc.steps[doc.marker - 1] && doc.output ? doc.output : undefined;
      const ordered = preferred ? [...outputs.filter((o) => o.name === preferred), ...outputs.filter((o) => o.name !== preferred)] : outputs;
      for (const o of ordered) out.push({ wire: `${step.id}.${o.name}`, kind: o.kind, format: o.format });
    };
    for (let i = Math.min(doc.marker, doc.steps.length) - 1; i >= 0; i--) add(doc.steps[i]);
    out.push({ wire: `$${SOURCE}`, kind: doc.source.kind, format: doc.source.format });
    return out;
  }

  /** Recipes and tools that take `artifact`; the first few tools only, unless `all`. */
  async suggestions(doc: DataDoc, artifact: Artifact, all = false): Promise<Suggestion[]> {
    await this.loadShips();
    const s = this.server;
    const [books, cards] = await Promise.all([
      s
        .match(doc.workspace, [artifact.id])
        .then((r) => r.matches.filter((m) => m.tier !== "excluded").slice(0, 6))
        .catch(() => []),
      this.cards(),
    ]);
    // what the data already is, beyond its kind: a simulation case may or may not have been run
    const solved = artifact.format === "openfoam-case" ? await s.caseSummary(doc.workspace, artifact.id).then((c) => c.solved, () => false) : false;
    const ops: Suggestion[] = [];
    for (const ship of this.ships.values()) {
      for (const [name, op] of Object.entries(ship.operations)) {
        const takes = (op.inputs ?? []).some((i) => i.kind === artifact.kind && i.formats.includes(artifact.format) && (!i.needs?.includes("solved") || solved));
        if (takes) ops.push({ type: "op", id: `${ship.id}.${name}`, title: `${ship.id} › ${name}`, summary: op.summary, trust: this.trust.get(ship.id) ?? "imported" });
      }
    }
    ops.sort((a, b) => Number(b.trust === "verified") - Number(a.trust === "verified"));
    return [
      // one entry per action that fits, under its book
      ...books.flatMap((m) =>
        m.actions.map((name): Suggestion => {
          const a = cards.find((c) => c.entry.id === m.book.id)?.actions.find((x) => x.name === name);
          return { type: "book", id: m.book.id, action: name, book: m.book.title, title: a?.title ?? name, summary: a?.summary ?? m.book.summary, fit: m.tier === "direct" ? "fits this data" : "fits after conversion", trust: m.book.trust };
        }),
      ),
      ...(all ? ops : ops.slice(0, 10)),
    ];
  }

  /** The ⋯ menu of a data window: recipes, then every tool for what's on view (by ship), then window actions. */
  async menuHtml(doc: DataDoc): Promise<string> {
    const shown = (await this.hooks.shownArtifact(doc)) ?? doc.source;
    const list = await this.suggestions(doc, shown, true).catch(() => [] as Suggestion[]);
    this.lastMenu = { doc, list };
    const item = (i: number, s: Suggestion) =>
      `<button data-dp="apply:${i}" role="menuitem" title="${escapeHtml(s.summary)}">${icon(s.type === "book" ? "script" : "plug", 16)}<span>${escapeHtml(s.title)}</span></button>`;
    const byBook = new Map<string, (readonly [number, Suggestion])[]>();
    list.forEach((s, i) => {
      if (s.type === "book") byBook.set(s.book, [...(byBook.get(s.book) ?? []), [i, s] as const]);
    });
    const byShip = new Map<string, (readonly [number, Suggestion])[]>();
    list.forEach((s, i) => {
      if (s.type === "op") byShip.set(s.id.split(".")[0], [...(byShip.get(s.id.split(".")[0]) ?? []), [i, s] as const]);
    });
    const tool = (i: number, s: Suggestion) =>
      `<button data-dp="apply:${i}" role="menuitem" title="${escapeHtml(s.summary)}">${icon("plug", 16)}<span>${escapeHtml(s.id.split(".")[1].replace(/-/g, " "))}</span></button>`;
    return `
      ${[...byBook].map(([book, items]) => `<section><h4>${icon("book", 13)} ${escapeHtml(book)}</h4>${items.map(([i, s]) => item(i, s)).join("")}</section>`).join("") || `<section><h4>Books</h4><p class="pop-note">No book takes ${escapeHtml(shown.name ?? shown.kind)} yet.</p></section>`}
      ${[...byShip].map(([ship, ops]) => `<section><h4>${escapeHtml(ship)}${this.trust.get(ship) === "verified" ? " <small>verified</small>" : ""}</h4>${ops.map(([i, s]) => tool(i, s)).join("")}</section>`).join("") || `<section><h4>Tools</h4><p class="pop-note">No tool takes this yet.</p></section>`}
      <section>
        ${doc.marker > 0 ? `<button data-dp="separate" role="menuitem">${icon("duplicate", 16)}<span>Open this result in its own window</span></button>` : ""}
        <button data-dp="controls" role="menuitem">${icon("panel", 16)}<span>${doc.ui.controls ? "Hide" : "Show"} controls</span></button>
        <button data-dp="close" role="menuitem">${icon("close", 16)}<span>Close window</span></button>
      </section>`;
  }

  private lastMenu: { doc: DataDoc; list: Suggestion[] } | null = null;

  async menuClick(value: string) {
    const m = this.lastMenu;
    if (!m) return;
    const { doc } = m;
    if (value.startsWith("apply:")) return this.apply(doc, m.list[Number(value.slice(6))]);
    if (value === "separate") {
      const a = await this.hooks.shownArtifact(doc);
      if (a) this.openSeparately(doc, a);
    }
    if (value === "controls") {
      doc.ui.controls = !doc.ui.controls;
      this.ws.touch();
    }
    if (value === "close") this.ws.close(doc.id);
  }

  // ---------------------------------------------------------- applying processes

  async apply(doc: DataDoc, s: Suggestion) {
    try {
      await this.loadShips();
      if (s.type === "op") return await this.applyOperation(doc, s.id);
      return await this.applyBook(doc, s.id, s.action);
    } catch (e) {
      this.hooks.notify(e instanceof Error ? e.message : String(e));
    }
  }

  /** Picks a value for an input of `kind` (and one of `formats`, when given), or explains what's missing. */
  private pick(doc: DataDoc, kind: string, formats: readonly string[] | undefined, used: Set<string>, what: string): string {
    const avail = this.available(doc).filter((a) => !used.has(a.wire));
    const hit = avail.find((a) => a.kind === kind && (!formats || formats.includes(a.format))) ?? (formats ? undefined : avail.find((a) => a.kind === kind));
    if (!hit) throw new Error(`${what} needs ${kind} data${formats ? ` (${formats.join(", ")})` : ""}, and nothing in this window's history is that yet`);
    used.add(hit.wire);
    return hit.wire;
  }

  private uniqueId(doc: DataDoc, base: string): string {
    const clean = base.replace(/[^a-z0-9_]/g, "_").replace(/^[^a-z]+/, "") || "step";
    let id = clean;
    for (let n = 2; doc.steps.some((s) => s.id === id); n++) id = `${clean}_${n}`;
    return id;
  }

  private async applyOperation(doc: DataDoc, tool: string) {
    const [shipId, opName] = tool.split(".");
    const ship = this.ships.get(shipId);
    const op = ship?.operations[opName];
    if (!ship || !op) throw new Error(`no operation ${tool}`);
    const used = new Set<string>();
    const wires: Record<string, string> = {};
    for (const port of op.inputs ?? []) {
      try {
        wires[port.name] = this.pick(doc, port.kind, port.formats, used, `"${port.name}"`);
      } catch (e) {
        if (!port.optional) throw e;
      }
    }
    const params = await this.paramsDialog(`${ship.id} › ${opName}`, op.summary, op.parameters ?? [], {}, "");
    if (!params) return;
    const step: DataStep = { id: this.uniqueId(doc, opName.replace(/-/g, "_")), run: tool, in: wires, with: params, status: "stale" };
    doc.steps.push(step);
    doc.marker = doc.steps.length;
    doc.output = undefined;
    this.ws.touch();
    await this.run(doc);
  }

  private async applyBook(doc: DataDoc, bookId: string, actionName?: string) {
    const { manifest: book } = await this.server.book(bookId);
    const action = bookAction(book, actionName);
    if (!action) throw new Error(`${book.title} has no action "${actionName}"`);
    const values = await this.paramsDialog(action.title, action.summary ?? book.how_to_use ?? book.summary, action.parameters ?? [], {}, book.title, action.steps.map((s) => s.run));
    if (!values) return;
    this.appendBook(doc, book, action.name, values, "stale");
    doc.marker = doc.steps.length;
    doc.output = undefined;
    this.ws.touch();
    await this.run(doc);
  }

  /** Adds a book action's steps, wired to this window's data, with its parameters set into each step. */
  appendBook(doc: DataDoc, book: BookManifest, actionName: string, values: Params, status: DataStep["status"]) {
    const action = bookAction(book, actionName);
    if (!action) throw new Error(`${book.title} has no action "${actionName}"`);
    const used = new Set<string>();
    const inputWire: Record<string, string> = {};
    for (const input of action.inputs ?? []) inputWire[input.name] = this.pick(doc, input.accepts.kind, input.accepts.formats, used, `"${action.title}"`);
    const rename = new Map<string, string>();
    for (const s of action.steps) {
      const id = this.uniqueId({ ...doc, steps: [...doc.steps, ...[...rename.values()].map((v) => ({ id: v }) as DataStep)] }, s.id);
      rename.set(s.id, id);
    }
    for (const s of action.steps) {
      const wires: Record<string, string> = {};
      for (const [port, w] of Object.entries(s.in ?? {})) wires[port] = w.startsWith("$") ? inputWire[w.slice(1)] : `${rename.get(w.split(".")[0])}.${w.split(".")[1]}`;
      doc.steps.push({ id: rename.get(s.id)!, run: s.run, in: wires, with: bookStepParams(s, action, values), book: bookLabel(book, action), status });
    }
  }

  /** A form for a process's settings; null when cancelled. */
  /** `book` names the book an action belongs to; operations have none. */
  private paramsDialog(title: string, summary: string, specs: ParamSpec[], values: Params, book: string, steps?: string[]): Promise<Params | null> {
    return showDialog<Params | null>(
      `<form method="dialog"><p class="eyebrow">${escapeHtml(book || "Operation")}</p><h2>${escapeHtml(title)}</h2>
       <p class="muted">${escapeHtml(summary)}</p>
       ${steps ? `<p class="small">Adds ${steps.length} step${steps.length === 1 ? "" : "s"} to the history: ${steps.map((s) => `<code>${escapeHtml(s)}</code>`).join(" → ")}</p>` : ""}
       ${manifestParamFields(specs, values)}
       <footer><button type="button" data-cancel>Cancel</button><button class="primary">${icon("batch", 15)} Add and run</button></footer></form>`,
      (done, el) => {
        const form = el.querySelector("form")!;
        form.addEventListener("submit", (e) => {
          e.preventDefault();
          done(readManifestParams(specs, form));
        });
      },
      null,
    );
  }

  // ---------------------------------------------------------- running the history

  /** Runs the history up to the first proposed step; unchanged steps come from the cache. */
  async run(doc: DataDoc) {
    const s = this.server;
    const firstProposed = doc.steps.findIndex((x) => x.status === "proposed");
    const steps = firstProposed < 0 ? doc.steps : doc.steps.slice(0, firstProposed);
    if (!steps.length) return;
    for (const step of steps) if (step.status !== "done") Object.assign(step, { status: "queued", error: undefined, message: undefined, progress: undefined });
    this.ws.touch();
    const plan = await this.hooks.busy("Checking the steps", () =>
      s.createStepsPlan(doc.workspace, doc.name, { [SOURCE]: doc.source.id }, steps.map((x): Step => ({ id: x.id, run: x.run, in: x.in, with: x.with }))),
    );
    if (!plan) return this.settle(doc, "failed", "couldn't check the steps");
    const errors = plan.problems.filter((p) => p.severity === "error");
    if (errors.length) {
      for (const p of errors) {
        const i = Number(p.path.match(/^\/steps\/(\d+)/)?.[1]);
        const step = Number.isInteger(i) ? steps[i] : steps.find((x) => x.status === "queued");
        if (step) Object.assign(step, { status: "failed", error: p.message });
      }
      this.settle(doc, "failed", errors[0].message);
      this.hooks.notify(errors.map((p) => p.message).join("; "));
      return;
    }
    this.running.set(plan.id, doc);
    const r = await this.hooks.busy("Starting", () => s.approvePlan(plan.id));
    if (!r) return this.settle(doc, "failed", "couldn't start");
    for (const j of r.jobs) this.onJob(j);
  }

  /** Marks the steps still waiting as `status` (after a failure or cancel). */
  private settle(doc: DataDoc, status: "failed" | "cancelled", message: string) {
    for (const step of doc.steps) if (step.status === "queued" || step.status === "running") Object.assign(step, { status, error: status === "failed" ? message : undefined });
    this.ws.touch();
  }

  handle(e: ServerEvent) {
    if (e.type === "job") this.onJob(e.job);
    if (e.type === "plan") this.onPlan(e.plan);
    if (e.type === "library") {
      this.cardsLoading = null;
      void this.loadShips(true);
    }
  }

  private onJob(job: Job) {
    const doc = job.planId ? this.running.get(job.planId) : undefined;
    const step = doc?.steps.find((x) => x.id === job.stepId);
    if (!doc || !step) return;
    step.jobId = job.id;
    step.progress = job.progress;
    step.message = job.message;
    if (job.state === "queued" || job.state === "downloading") step.status = "queued";
    if (job.state === "running") step.status = "running";
    if (job.state === "done") Object.assign(step, { status: "done", outputs: job.outputs, cached: !!job.cached, error: undefined });
    if (job.state === "failed") Object.assign(step, { status: "failed", error: job.error ?? "failed" });
    if (job.state === "cancelled") step.status = "cancelled";
    this.ws.touch();
  }

  private onPlan(plan: Plan) {
    const doc = this.running.get(plan.id);
    if (!doc) return;
    if (plan.status === "failed" || plan.status === "cancelled") this.settle(doc, plan.status === "failed" ? "failed" : "cancelled", plan.error ?? plan.status);
    if (plan.status === "done" || plan.status === "failed" || plan.status === "cancelled") this.running.delete(plan.id);
  }

  approve(doc: DataDoc) {
    for (const s of doc.steps) if (s.status === "proposed") s.status = "stale";
    void this.run(doc);
  }

  rerun(doc: DataDoc) {
    void this.run(doc);
  }

  cancel(doc: DataDoc) {
    for (const [planId, d] of this.running) if (d === doc) void this.server.cancelPlan(planId).catch(() => {});
  }

  /** Steps that use step `index`'s outputs, directly or through others. */
  private dependents(doc: DataDoc, index: number): Set<number> {
    const out = new Set<number>([index]);
    for (let i = index + 1; i < doc.steps.length; i++) {
      const from = Object.values(doc.steps[i].in).map((w) => w.split(".")[0]);
      if ([...out].some((j) => from.includes(doc.steps[j].id))) out.add(i);
    }
    return out;
  }

  updateStep(doc: DataDoc, index: number, params: Params) {
    doc.steps[index].with = params;
    for (const i of this.dependents(doc, index)) if (doc.steps[i].status !== "proposed") doc.steps[i].status = "stale";
    this.ws.touch();
    void this.run(doc);
  }

  removeStep(doc: DataDoc, index: number) {
    const gone = this.dependents(doc, index);
    doc.steps = doc.steps.filter((_, i) => !gone.has(i));
    doc.marker = Math.min(index, doc.steps.length);
    doc.output = undefined;
    this.ws.touch();
  }

  select(doc: DataDoc, marker: number, output?: string) {
    doc.marker = Math.max(0, Math.min(marker, doc.steps.length));
    doc.output = output;
    this.ws.touch();
  }

  openSeparately(doc: DataDoc, artifact: Artifact) {
    this.ws.open(artifact, doc.workspace);
  }

  /**
   * An assistant's plan as proposed steps in the data's window: nothing runs
   * until Approve. Returns the window, or null when the plan's data isn't one
   * dataset this window can hold.
   */
  async fromPlan(plan: Plan, source: Artifact): Promise<DataDoc> {
    const errors = (plan.problems ?? []).filter((p) => p.severity === "error");
    if (errors.length) throw new Error(`This plan doesn't fit the data: ${errors.map((p) => p.message).join("; ")}`);
    await this.loadShips();
    const doc = this.ws.open(source, plan.workspace);
    const book = plan.book ? (await this.server.book(plan.book.id, plan.book.version)).manifest : undefined;
    const action = book && bookAction(book, plan.book!.action);
    const inputNames = Object.keys(plan.inputs);
    const rename = new Map<string, string>();
    for (const s of plan.steps) rename.set(s.id, this.uniqueId({ ...doc, steps: [...doc.steps, ...[...rename.values()].map((v) => ({ id: v }) as DataStep)] }, s.id));
    for (const s of plan.steps) {
      const wires: Record<string, string> = {};
      for (const [port, w] of Object.entries(s.in ?? {})) {
        if (w.startsWith("$")) {
          if (!inputNames.includes(w.slice(1)) || plan.inputs[w.slice(1)] !== source.id) throw new Error("this plan uses more than one dataset; open it from the library instead");
          wires[port] = `$${SOURCE}`;
        } else wires[port] = `${rename.get(w.split(".")[0])}.${w.split(".")[1]}`;
      }
      doc.steps.push({
        id: rename.get(s.id)!,
        run: s.run,
        in: wires,
        with: action ? bookStepParams(s, action, plan.parameters) : { ...(s.with ?? {}) },
        ...(book && action ? { book: bookLabel(book, action) } : {}),
        status: "proposed",
      });
    }
    doc.rationale = plan.rationale;
    doc.marker = 0;
    this.ws.touch();
    return doc;
  }

  /** Runs one of a book's actions in an open data window (from the library). */
  async useBook(doc: DataDoc, bookId: string, action?: string) {
    await this.loadShips();
    await this.applyBook(doc, bookId, action).catch((e: unknown) => this.hooks.notify(e instanceof Error ? e.message : String(e)));
  }

  private cardsLoading: Promise<BookCard[]> | null = null;

  /** The library's book cards (for action titles), loaded once and again when the library changes. */
  private cards(): Promise<BookCard[]> {
    this.cardsLoading ??= this.server.cards().catch(() => {
      this.cardsLoading = null;
      return [];
    });
    return this.cardsLoading;
  }
}

/** How a step names where it came from: the book, and the action when the book has several. */
function bookLabel(book: BookManifest, action: BookAction & { name: string }): NonNullable<DataStep["book"]> {
  return { id: book.id, action: action.name, title: Object.keys(book.actions).length > 1 ? `${book.title} › ${action.title}` : book.title };
}

/** A book step's parameter values: its own `with`, plus each action parameter that `sets` it. */
function bookStepParams(step: Step, action: BookAction, values: Params): Params {
  const out: Params = { ...(step.with ?? {}) };
  for (const p of action.parameters ?? []) {
    const v = values[p.name] ?? p.default;
    if (v === undefined) continue;
    for (const target of Array.isArray(p.sets) ? p.sets : [p.sets]) {
      const [stepId, name] = target.split(".");
      if (stepId === step.id) out[name] = v;
    }
  }
  return out;
}
