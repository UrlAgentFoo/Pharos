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
import { type Artifact, type BookAction, type BookCard, type BookManifest, type BookMatch, type ControlWhen, type DataSummary, type Job, type ParamSpec, type Params, type Plan, type ServerEvent, type ShipManifest, type Step, bookAction } from "@pharos/contracts";
import type { LocalServer } from "./api.js";
import type { DataWindowHooks, NextAction, RunControls, StepSpec, SuggestedSubject, Suggestion } from "./data-window.js";
import { escapeHtml, formatSize, showDialog } from "./dialogs.js";
import { icon } from "./icons.js";
import { manifestParamFields, readManifestParams } from "./param-fields.js";
import { type Phase, heardFrom } from "./progress.js";
import { LARGE_BYTES, downsizers } from "./large-data.js";
import { type DataDoc, type DataStep, type Workspace, blockAt, newBlock, timeBlocks } from "./workspace.js";

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

export class DataProcesses implements Omit<DataWindowHooks, "server" | "notify" | "suggestMenu" | "controlsTab" | "renderSuggested" | "chain"> {
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

  /** What an operation makes: each output's name, kind and format (empty for one this window doesn't know). */
  stepOutputs(run: string): { name: string; kind: string; format: string }[] {
    const [ship, op] = run.split(".");
    return (this.ships.get(ship)?.operations[op]?.outputs ?? []).map((o) => ({ name: o.name, kind: o.kind, format: o.format }));
  }

  /** What a book action does (its summary), for the chain view; undefined when the book or action is gone. */
  async actionSummary(bookId: string, action: string): Promise<string | undefined> {
    const book = await this.manifest(bookId).catch(() => null);
    return (book && bookAction(book, action)?.summary) || undefined;
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

  // ---------------------------------------------------------- large data: make it smaller first

  /** When `artifact` is large enough to slow everything after it, and something can make it smaller: why, and how. */
  async largeData(artifact: Artifact): Promise<{ note: string; ops: Suggestion[] } | null> {
    const limit = LARGE_BYTES[artifact.kind];
    const size = artifact.sizeBytes ?? 0;
    if (!limit || size < limit) return null;
    await this.loadShips();
    const ops = downsizers(this.ships.values(), artifact).map((s) => ({ ...s, trust: this.trust.get(s.id.split(".")[0]) ?? "imported" }));
    if (!ops.length) return null;
    const what = { video: "video", photos: "photo set", mesh: "model", splat: "splat" }[artifact.kind] ?? "data";
    return { note: `This ${what} is ${formatSize(size)}. Making it smaller first makes every run after it faster.`, ops };
  }

  /** The Controls' "make it smaller first", for a window's data: its note, and the first way to do it. */
  async smallerFirst(doc: DataDoc, artifact: Artifact): Promise<{ note: string; title: string; apply(): void } | null> {
    const large = await this.largeData(artifact).catch(() => null);
    if (!large) return null;
    const op = large.ops[0];
    return { note: large.note, title: op.id.split(".")[1].replace(/[-_]+/g, " "), apply: () => void this.apply(doc, op) };
  }

  /** The Suggested menu in a window's history bar: what takes the data on view, books first. The ⋯ menu has every tool. */
  async suggestHtml(doc: DataDoc): Promise<string> {
    const shown = (await this.hooks.shownArtifact(doc)) ?? doc.source;
    const large = await this.largeData(shown).catch(() => null);
    const smaller = large?.ops ?? [];
    const rest = (await this.suggestions(doc, shown).catch(() => [] as Suggestion[])).filter((s) => !smaller.some((x) => x.id === s.id));
    const list = [...smaller, ...rest];
    this.lastMenu = { doc, list };
    const head = `<h4>${doc.marker > 0 ? "Next, with this result" : "Suggested for this data"}</h4>`;
    if (!list.length) return `<section>${head}<p class="pop-note">Nothing in the library takes ${escapeHtml(shown.name ?? shown.kind)} yet.</p></section>`;
    const row = (s: Suggestion, i: number) => {
      const title = s.type === "book" ? s.title : s.id.split(".")[1].replace(/[-_]+/g, " ");
      return `<button data-dp="apply:${i}" role="menuitem" title="${escapeHtml(s.summary)}">${icon(s.type === "book" ? "script" : "plug", 16)}<span>${escapeHtml(title)}</span><small>${escapeHtml(s.type === "book" ? s.book : s.id.split(".")[0])}</small></button>`;
    };
    // large data: making it smaller comes first, with why
    const first = smaller.length ? `<section><h4>Make it smaller first</h4><p class="pop-note">${escapeHtml(large!.note)}</p>${smaller.map((s, i) => row(s, i)).join("")}</section>` : "";
    return `${first}${rest.length ? `<section>${head}${rest.map((s, i) => row(s, i + smaller.length)).join("")}</section>` : ""}`;
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
        <button data-dp="fork" role="menuitem">${icon("branch", 16)}<span>Fork from this point</span></button>
        ${doc.marker > 0 ? `<button data-dp="separate" role="menuitem">${icon("duplicate", 16)}<span>Open this result in its own window</span></button>` : ""}
        ${this.savable(doc).length ? `<button data-dp="save-book" role="menuitem">${icon("book", 16)}<span>Save these steps as a book…</span></button>` : ""}
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
    if (value === "fork") this.fork(doc);
    if (value === "controls") {
      doc.ui.controls = !doc.ui.controls;
      this.ws.touch();
    }
    if (value === "close") this.ws.close(doc.id);
    if (value === "save-book") await this.saveAsBook(doc);
  }

  // ---------------------------------------------------------- Save as book

  /** The steps worth saving: those that ran, from the start of the history up to the first that didn't. */
  private savable(doc: DataDoc): DataStep[] {
    const first = doc.steps.findIndex((s) => s.status !== "done");
    return first < 0 ? doc.steps : doc.steps.slice(0, first);
  }

  /**
   * Saves the window's steps that worked as a book (or as another action of
   * a book saved earlier), so they can be used on other data from Books.
   */
  async saveAsBook(doc: DataDoc) {
    const steps = this.savable(doc);
    if (!steps.length) return this.hooks.notify("Run some steps first: a book is made from steps that worked.");
    const cards = await this.cards();
    const first = steps.find((x) => x.book)?.book?.title;
    const choice = await showDialog<{ book: string; title: string; summary: string; action: string } | null>(
      `<form method="dialog"><p class="eyebrow">Save as book</p><h2>${steps.length} step${steps.length === 1 ? "" : "s"} from ${escapeHtml(doc.name)}</h2>
       <p class="muted small">${steps.map((s) => `<code>${escapeHtml(s.run)}</code>`).join(" → ")}</p>
       <label class="field">Book<select name="book"><option value="">A new book</option>${cards.map((c) => `<option value="${escapeHtml(c.entry.id)}">${escapeHtml(c.entry.title)}</option>`).join("")}</select></label>
       <label class="field new-only">Title, as people name the domain<input name="title" required placeholder="e.g. Fluid flow" value="${escapeHtml(first ?? "")}"/></label>
       <label class="field new-only">One sentence on what it does<input name="summary" placeholder="What the book does with someone's data"/></label>
       <label class="field">What these steps do, as a button<input name="action" required placeholder="e.g. Simulate the flow"/></label>
       <p class="muted small">Steps run on data like <strong>${escapeHtml(doc.source.name ?? doc.source.kind)}</strong> (${escapeHtml(doc.source.kind)}). Only books saved in Pharos can gain more actions.</p>
       <footer><button type="button" data-cancel>Cancel</button><button class="primary">${icon("book", 15)} Save</button></footer></form>`,
      (done, el) => {
        const form = el.querySelector("form")!;
        const book = form.elements.namedItem("book") as HTMLSelectElement;
        const sync = () => {
          for (const f of el.querySelectorAll<HTMLElement>(".new-only")) f.hidden = !!book.value;
          (form.elements.namedItem("title") as HTMLInputElement).required = !book.value;
        };
        book.addEventListener("change", sync);
        sync();
        form.addEventListener("submit", (e) => {
          e.preventDefault();
          const v = (n: string) => (form.elements.namedItem(n) as HTMLInputElement).value.trim();
          done({ book: book.value, title: v("title"), summary: v("summary"), action: v("action") });
        });
      },
      null,
    );
    if (!choice) return;
    const card = cards.find((c) => c.entry.id === choice.book);
    const title = card?.entry.title ?? choice.title;
    const s = this.server;
    const saved = await this.hooks.busy("Saving the book", async () => {
      const plan = await s.createStepsPlan(doc.workspace, title, { [SOURCE]: doc.source.id }, steps.map((x): Step => ({ id: x.id, run: x.run, in: x.in, with: x.with })));
      try {
        return await s.saveAsBook(plan.id, {
          id: card?.entry.id ?? slug(title, "-"),
          title,
          summary: card?.entry.summary ?? (choice.summary || `${choice.action}.`),
          action: { name: slug(choice.action, "_"), title: choice.action },
        });
      } finally {
        await s.cancelPlan(plan.id).catch(() => {});
      }
    });
    if (saved) this.hooks.notify(`Saved: ${saved.title} › ${choice.action}. It's in Books, for other data like this.`);
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
    const step: DataStep = { id: this.uniqueId(doc, opName.replace(/-/g, "_")), run: tool, in: wires, with: params, status: "stale", block: newBlock() };
    doc.steps.push(step);
    // the window stays on what it shows, with the run's progress over it, and moves to the run once it's done
    this.follow(doc);
    await this.run(doc);
  }

  private async applyBook(doc: DataDoc, bookId: string, actionName?: string) {
    const { manifest: book } = await this.server.book(bookId);
    const action = bookAction(book, actionName);
    if (!action) throw new Error(`${book.title} has no action "${actionName}"`);
    const values = await this.paramsDialog(action.title, action.summary ?? book.how_to_use ?? book.summary, action.parameters ?? [], {}, book.title, action.steps.map((s) => s.run));
    if (!values) return;
    this.appendBook(doc, book, action.name, values, "stale");
    // the window stays on what it shows, with the run's progress over it, and moves to the run once it's done
    this.follow(doc);
    await this.run(doc);
  }

  /** Adds a book action's steps, wired to this window's data, with its parameters set into each step. */
  appendBook(doc: DataDoc, book: BookManifest, actionName: string, values: Params, status: DataStep["status"], reason?: string) {
    const action = bookAction(book, actionName);
    if (!action) throw new Error(`${book.title} has no action "${actionName}"`);
    const used = new Set<string>();
    const inputWire: Record<string, string> = {};
    for (const input of action.inputs ?? []) inputWire[input.name] = this.pick(doc, input.accepts.kind, input.accepts.formats, used, `"${action.title}"`);
    const rename = new Map<string, string>();
    const block = newBlock();
    for (const s of action.steps) {
      const id = this.uniqueId({ ...doc, steps: [...doc.steps, ...[...rename.values()].map((v) => ({ id: v }) as DataStep)] }, s.id);
      rename.set(s.id, id);
    }
    for (const s of action.steps) {
      const wires: Record<string, string> = {};
      for (const [port, w] of Object.entries(s.in ?? {})) wires[port] = w.startsWith("$") ? inputWire[w.slice(1)] : `${rename.get(w.split(".")[0])}.${w.split(".")[1]}`;
      doc.steps.push({ id: rename.get(s.id)!, run: s.run, in: wires, with: bookStepParams(s, action, values), book: bookLabel(book, action), block, status, ...(reason ? { reason } : {}) });
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
    for (const step of doc.steps) if (step.status === "queued" || step.status === "running") Object.assign(step, { status, error: status === "failed" ? message : undefined, live: undefined });
    this.arrive(doc);
    this.ws.touch();
  }

  /** Windows waiting for a new run (by its id) to finish before moving to it. */
  private following = new WeakMap<DataDoc, string>();

  /** The run just added to `doc`: the window moves to it once it's done, so the timeline only gains finished runs. */
  private follow(doc: DataDoc) {
    const block = doc.steps[doc.steps.length - 1]?.block;
    if (block) this.following.set(doc, block);
  }

  /** Moves a window to the run it follows once that run has stopped: its last result, or the step that didn't finish. */
  private arrive(doc: DataDoc) {
    const id = this.following.get(doc);
    if (!id) return;
    const steps = doc.steps.flatMap((s, i) => (s.block === id ? [[s, i] as const] : []));
    if (steps.some(([s]) => s.status === "queued" || s.status === "running")) return;
    this.following.delete(doc);
    if (!steps.length) return;
    doc.marker = (steps.find(([s]) => s.status !== "done") ?? steps[steps.length - 1])[1] + 1;
    doc.output = undefined;
  }

  handle(e: ServerEvent) {
    if (e.type === "job") this.onJob(e.job);
    if (e.type === "pull") this.onPull(e);
    if (e.type === "job-log") heardFrom(e.jobId);
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
    const changed = step.progress !== job.progress || step.message !== job.message;
    step.jobId = job.id;
    step.progress = job.progress;
    step.message = job.message;
    if (job.state === "queued" || job.state === "downloading") step.status = "queued";
    if (job.state === "running") step.status = "running";
    if (job.state === "done") Object.assign(step, { status: "done", outputs: job.outputs, cached: !!job.cached, error: undefined });
    if (job.state === "failed") Object.assign(step, { status: "failed", error: job.error ?? "failed" });
    if (job.state === "cancelled") step.status = "cancelled";
    if (step.status === "queued" || step.status === "running") {
      const prev = step.live;
      const ship = step.run.split(".")[0];
      const phase: Phase =
        job.state === "downloading" ? (prev?.phase === "building" ? "building" : "downloading") : job.state === "queued" ? "waiting" : job.progress === undefined && !job.message ? "starting" : "running";
      const since = Date.parse(job.state === "running" && job.startedAt ? job.startedAt : job.createdAt);
      step.live = {
        phase,
        ship,
        job: job.id,
        since: prev?.phase === phase && prev.since ? prev.since : since,
        ...(job.progress !== undefined ? { fraction: job.progress } : {}),
        ...(job.message ? { message: job.message } : {}),
        ...(prev?.bytes && (phase === "downloading" || phase === "building") ? { bytes: prev.bytes } : {}),
        lastOutput: changed ? Date.now() : (prev?.lastOutput ?? since),
      };
    } else step.live = undefined;
    this.arrive(doc);
    this.ws.touch();
  }

  /** A ship is downloading or building: every waiting step that needs it shows how far along it is. */
  private onPull(e: Extract<ServerEvent, { type: "pull" }>) {
    let touched = false;
    for (const doc of this.running.values()) {
      for (const step of doc.steps) {
        if (step.status !== "queued" || step.run.split(".")[0] !== e.ship) continue;
        const building = !e.totalBytes && !!e.message;
        step.live = {
          ...(step.live ?? { since: Date.now() }),
          phase: e.done ? "starting" : building ? "building" : "downloading",
          ship: e.ship,
          ...(e.message ? { message: e.message } : {}),
          ...(!building ? { bytes: { received: e.receivedBytes, ...(e.totalBytes ? { total: e.totalBytes } : {}) } } : {}),
          lastOutput: Date.now(),
        };
        if (e.error) Object.assign(step, { status: "failed", error: `couldn't get the ${e.ship} ship: ${e.error}`, live: undefined });
        touched = true;
      }
    }
    if (touched) this.ws.touch();
  }

  /**
   * After the event stream reconnects: what happened to the jobs and plans
   * we were following while it was down.
   */
  async resync() {
    if (!this.running.size) return;
    const s = this.server;
    const jobs = await s.jobs().catch(() => [] as Job[]);
    for (const j of jobs) if (j.planId && this.running.has(j.planId)) this.onJob(j);
    for (const id of [...this.running.keys()]) {
      const plan = await s.plan(id).catch(() => null);
      if (plan) this.onPlan(plan);
    }
  }

  async viewsFor(artifact: Artifact): Promise<{ tool: string; title: string; summary: string }[]> {
    await this.loadShips();
    const out: { tool: string; title: string; summary: string }[] = [];
    for (const ship of this.ships.values()) {
      for (const [name, op] of Object.entries(ship.operations)) {
        if (!op.view) continue;
        if ((op.inputs ?? []).some((i) => !i.optional && i.kind === artifact.kind && i.formats.includes(artifact.format))) out.push({ tool: `${ship.id}.${name}`, title: ship.id, summary: op.summary });
      }
    }
    return out;
  }

  /** Runs a view as a job of its own, outside the window's history; the cache makes it instant next time. */
  async runView(doc: DataDoc, artifact: Artifact, tool: string): Promise<Artifact> {
    const [shipId, opName] = tool.split(".");
    const op = this.ships.get(shipId)?.operations[opName];
    const port = op?.inputs?.find((i) => !i.optional);
    if (!op || !port) throw new Error(`no view ${tool}`);
    const s = this.server;
    let job = await s.runJob({ workspace: doc.workspace, tool, inputs: { [port.name]: artifact.id } });
    while (job.state !== "done" && job.state !== "failed" && job.state !== "cancelled") {
      await new Promise((ok) => setTimeout(ok, 500));
      job = await s.job(job.id);
    }
    const id = job.state === "done" ? Object.values(job.outputs ?? {})[0] : undefined;
    if (!id) throw new Error(`${tool} couldn't show it: ${job.error ?? job.state}`);
    return s.artifact(doc.workspace, id);
  }

  /** A job's log so far, in a dialog. */
  async showLog(jobId: string) {
    const job = await this.server.job(jobId).catch(() => null);
    await showDialog(
      `<p class="eyebrow">Log</p><h2>${escapeHtml(job ? `${job.ship} › ${job.operation}` : jobId)}</h2>
       <pre class="code log-text">${escapeHtml(job?.log || "Nothing printed yet.")}</pre>
       <footer><button class="primary" data-cancel>Close</button></footer>`,
      (_done, el) => {
        const pre = el.querySelector("pre")!;
        pre.scrollTop = pre.scrollHeight;
      },
      undefined,
    );
  }

  /**
   * A restored window whose steps were running when it was saved: steps
   * whose job is still going are followed again, finished ones take their
   * results, and the rest stay changed so the next run starts them.
   */
  async reattach(doc: DataDoc) {
    const s = this.hooks.server();
    if (!s) return;
    for (const step of doc.steps) {
      if (step.status !== "stale" || !step.jobId) continue;
      const job = await s.job(step.jobId).catch(() => null);
      if (!job || job.state === "failed" || job.state === "cancelled") {
        step.jobId = undefined;
        continue;
      }
      if (job.planId) this.running.set(job.planId, doc);
      this.onJob(job);
    }
    this.ws.touch();
  }

  /** Everything queued or running, in every window, for the toolbar's activity list. */
  active(): { doc: DataDoc; step: DataStep; index: number }[] {
    return this.ws.docs.flatMap((doc) =>
      doc.steps.flatMap((step, index) => (step.status === "queued" || step.status === "running" ? [{ doc, step, index }] : [])),
    );
  }

  private onPlan(plan: Plan) {
    const doc = this.running.get(plan.id);
    if (!doc) return;
    if (plan.status === "failed" || plan.status === "cancelled") this.settle(doc, plan.status === "failed" ? "failed" : "cancelled", plan.error ?? plan.status);
    if (plan.status === "done" || plan.status === "failed" || plan.status === "cancelled") this.running.delete(plan.id);
  }

  approve(doc: DataDoc) {
    const proposed = doc.steps.find((s) => s.status === "proposed");
    if (proposed?.block) this.following.set(doc, proposed.block);
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

  // ---------------------------------------------------------- a book's Controls design

  private manifests = new Map<string, Promise<BookManifest>>();
  private summaries = new Map<string, Promise<DataSummary | undefined>>();

  private manifest(id: string): Promise<BookManifest> {
    let m = this.manifests.get(id);
    if (!m) {
      m = this.server.book(id).then((r) => r.manifest);
      m.catch(() => this.manifests.delete(id)); // try again next time
      this.manifests.set(id, m);
    }
    return m;
  }

  /** What the window's data is (axes, time points, channels), read once. */
  private summary(doc: DataDoc): Promise<DataSummary | undefined> {
    const known = doc.source.meta.summary as DataSummary | undefined;
    if (known) return Promise.resolve(known);
    const key = `${doc.workspace}/${doc.source.id}`;
    let s = this.summaries.get(key);
    if (!s) {
      s = this.server.match(doc.workspace, [doc.source.id]).then((r) => r.summaries[0], () => undefined);
      this.summaries.set(key, s);
    }
    return s;
  }

  /** The book step behind each step of the run starting at `first`, when the run is still the action's steps in order. */
  private async bookRun(doc: DataDoc, first: number) {
    const block = timeBlocks(doc).find((b) => b.first === first);
    const head = doc.steps[first];
    if (!block || !head?.book) return null;
    const action = bookAction(await this.manifest(head.book.id), head.book.action);
    const steps = doc.steps.slice(block.first, block.last + 1);
    if (!action || action.steps.length !== steps.length || action.steps.some((s, j) => s.run !== steps[j].run)) return null;
    return { action, at: (target: string) => first + action.steps.findIndex((s) => s.id === target.split(".")[0]) };
  }

  /**
   * The Controls for a run of a book action: its design's sections that fit
   * the window's data, with the run's values. Null for a run of one operation,
   * or a run whose steps no longer match the action.
   */
  async runControls(doc: DataDoc, first: number): Promise<RunControls | null> {
    const run = await this.bookRun(doc, first).catch(() => null);
    if (!run) return null;
    const { action } = run;
    const summary = await this.summary(doc);
    const specs = new Map((action.parameters ?? []).map(({ sets: _sets, ...spec }) => [spec.name, spec as ParamSpec]));
    const design = action.controls ?? [{ title: "Settings", params: [...specs.keys()] }];
    const placed = new Set(design.flatMap((sec) => sec.params ?? []));
    const sections: RunControls["sections"] = design
      .filter((sec) => fits(sec.when, doc.source, summary))
      .map((sec) => ({ title: sec.title, note: sec.note, params: (sec.params ?? []).flatMap((p) => specs.get(p) ?? []) }));
    const rest = [...specs.values()].filter((p) => !placed.has(p.name));
    if (rest.length) sections.push({ title: "More settings", params: rest, folded: true });
    const values: Params = {};
    for (const p of action.parameters ?? []) {
      const target = Array.isArray(p.sets) ? p.sets[0] : p.sets;
      const v = doc.steps[run.at(target)]?.with[target.split(".")[1]];
      if (v !== undefined) values[p.name] = v;
      else if (p.default !== undefined) values[p.name] = p.default;
    }
    return { sections, values };
  }

  private fitsLoading = new Map<string, Promise<BookMatch[]>>();

  /** The books that can run on the window's data, best first, read once. */
  private fitting(doc: DataDoc): Promise<BookMatch[]> {
    const key = `${doc.workspace}/${doc.source.id}`;
    let m = this.fitsLoading.get(key);
    if (!m) {
      m = this.server.match(doc.workspace, [doc.source.id]).then(
        (r) => r.matches.filter((x) => x.tier !== "excluded"),
        () => [],
      );
      this.fitsLoading.set(key, m);
    }
    return m;
  }

  /** An action laid out by its Controls design for the window's data, with its defaults: ready to run. */
  private async offer(doc: DataDoc, book: BookManifest, name: string): Promise<NextAction | null> {
    const action = bookAction(book, name);
    if (!action) return null;
    // only what the window has something for: the data itself, or a result of the right kind
    const used = new Set<string>();
    try {
      for (const input of action.inputs ?? []) this.pick(doc, input.accepts.kind, input.accepts.formats, used, action.title);
    } catch {
      return null;
    }
    const summary = await this.summary(doc);
    const specs = new Map((action.parameters ?? []).map(({ sets: _sets, ...spec }) => [spec.name, spec as ParamSpec]));
    const design = action.controls ?? [{ title: "Settings", params: [...specs.keys()] }];
    const placed = new Set(design.flatMap((sec) => sec.params ?? []));
    const sections: RunControls["sections"] = design
      .filter((sec) => fits(sec.when, doc.source, summary))
      .map((sec) => ({ title: sec.title, note: sec.note, params: (sec.params ?? []).flatMap((p) => specs.get(p) ?? []) }));
    const rest = [...specs.values()].filter((p) => !placed.has(p.name));
    if (rest.length) sections.push({ title: "More settings", params: rest, folded: true });
    const values = Object.fromEntries((action.parameters ?? []).flatMap((p) => (p.default === undefined ? [] : [[p.name, p.default]])));
    return { book: { id: book.id, title: book.title }, action: action.name, title: action.title, summary: action.summary, sections, values };
  }

  /**
   * What the Controls offer to run next: on the data itself, every book
   * action that fits it, the one the data came to try first (with its
   * settings); after a finished run of a book action, the actions that one
   * names as `next`.
   */
  async nextActions(doc: DataDoc): Promise<NextAction[]> {
    await this.loadShips();
    if (doc.marker === 0) {
      const out: NextAction[] = [];
      for (const m of await this.fitting(doc)) {
        const book = await this.manifest(m.book.id).catch(() => null);
        for (const name of book ? m.actions : []) {
          const a = await this.offer(doc, book!, name);
          if (a) out.push(a);
        }
      }
      const p = doc.prefer;
      // without an action named, the book's first that fits
      const i = p ? out.findIndex((a) => a.book.id === p.book && (!p.action || a.action === p.action)) : -1;
      if (i < 0) return out;
      const [preferred] = out.splice(i, 1);
      return [{ ...preferred, values: { ...preferred.values, ...p!.values }, preferred: true }, ...out];
    }
    const step = doc.steps[doc.marker - 1];
    const block = timeBlocks(doc)[blockAt(timeBlocks(doc), doc.marker)];
    if (!step?.book || !block || doc.steps.slice(block.first, block.last + 1).some((s) => s.status !== "done")) return [];
    const book = await this.manifest(step.book.id).catch(() => null);
    const names = book ? (bookAction(book, step.book.action)?.next ?? []) : [];
    return (await Promise.all(names.map((n) => this.offer(doc, book!, n)))).filter((a): a is NextAction => !!a);
  }

  /** Runs a book action from the Controls, with the values set there: the click is the approval. */
  async runNext(doc: DataDoc, bookId: string, actionName: string, values: Params, reason?: string) {
    try {
      this.appendBook(doc, await this.manifest(bookId), actionName, values, "stale", reason);
    } catch (e) {
      return this.hooks.notify(e instanceof Error ? e.message : String(e));
    }
    // the window stays on what it shows, with the run's progress over it, and moves to the run once it's done
    this.follow(doc);
    await this.run(doc);
  }

  /**
   * As data opens in a window: the opening action of the best book that has
   * one and fits. It runs straight away when it's quick and its ships are on
   * this computer (opening the data approves it); otherwise it waits, proposed.
   */
  async openWith(doc: DataDoc) {
    if (doc.steps.length || !this.hooks.server()) return;
    for (const m of await this.fitting(doc)) {
      const book = await this.manifest(m.book.id).catch(() => null);
      const name = book?.opens_with;
      if (!book || !name || !m.actions.includes(name) || doc.steps.length) continue;
      const card = (await this.cards()).find((c) => c.entry.id === book.id);
      const ready = !!book.actions[name]?.quick && !!card && card.ships.every((s) => s.downloaded);
      try {
        this.appendBook(doc, book, name, {}, ready ? "stale" : "proposed");
      } catch {
        continue; // nothing in the window it can take after all
      }
      if (ready) {
        this.follow(doc);
        await this.run(doc);
      } else {
        doc.marker = doc.steps.length;
        doc.output = undefined;
        this.ws.touch();
      }
      return;
    }
  }

  /**
   * Apply and run: the book run starting at `first`, again with new settings,
   * as a new run after the last. The run it came from stays in the history as
   * it was, and the new one reads the same inputs. Settings the form didn't
   * show keep the run's values.
   */
  async updateRun(doc: DataDoc, first: number, values: Params) {
    const run = await this.bookRun(doc, first).catch(() => null);
    const block = timeBlocks(doc).find((b) => b.first === first);
    if (!run || !block) return;
    const current = (await this.runControls(doc, first))?.values ?? {};
    const next = { ...current, ...values };
    if ((run.action.parameters ?? []).every((p) => next[p.name] === current[p.name])) return this.hooks.notify("Nothing changed: these are the settings it ran with.");
    this.appendCopy(doc, block, (_s, i) => bookStepParams(run.action.steps[i], run.action, next));
  }

  /** Apply and run for a step of one operation: it again with new settings, as a new run after the last. */
  updateStep(doc: DataDoc, index: number, params: Params) {
    if (JSON.stringify(params) === JSON.stringify(doc.steps[index].with)) return this.hooks.notify("Nothing changed: these are the settings it ran with.");
    this.appendCopy(doc, { first: index, last: index }, () => params);
  }

  /** Copies steps `first`..`last` to the end of the history as one new run, reading what they read, with `params`; then runs it. */
  private appendCopy(doc: DataDoc, span: { first: number; last: number }, params: (step: DataStep, i: number) => Params) {
    const old = doc.steps.slice(span.first, span.last + 1);
    const rename = new Map<string, string>();
    for (const s of old) rename.set(s.id, this.uniqueId({ ...doc, steps: [...doc.steps, ...[...rename.values()].map((v) => ({ id: v }) as DataStep)] }, s.id));
    const block = newBlock();
    old.forEach((s, i) => {
      // wires inside the run follow the copies; wires to the data or earlier runs stay as they were
      const wires = Object.fromEntries(Object.entries(s.in).map(([port, w]) => [port, rename.has(w.split(".")[0]) ? `${rename.get(w.split(".")[0])}.${w.split(".")[1]}` : w]));
      doc.steps.push({ id: rename.get(s.id)!, run: s.run, in: wires, with: params(s, i), ...(s.book ? { book: s.book } : {}), ...(s.reason ? { reason: s.reason } : {}), block, status: "stale" });
    });
    doc.marker = doc.steps.length;
    doc.output = undefined;
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

  /** A new window with this one's history up to the step on view, to try something else from there. */
  fork(doc: DataDoc): DataDoc {
    const steps = doc.steps.slice(0, doc.marker).map((s): DataStep => {
      const { live: _live, progress: _progress, ...copy } = structuredClone(s);
      // a step still at work carries on in its own window; here it runs again on the next run
      return copy.status === "running" || copy.status === "queued" ? { ...copy, status: "stale", jobId: undefined } : copy;
    });
    const names = new Set(this.ws.docs.map((d) => d.name));
    let name = `${doc.name} (fork)`;
    for (let n = 2; names.has(name); n++) name = `${doc.name} (fork ${n})`;
    return this.ws.restore({ name, workspace: doc.workspace, source: doc.source, steps, marker: steps.length, output: doc.output, prefer: doc.prefer, ui: { ...doc.ui, results: false } });
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
    const block = newBlock();
    // a chain: each link its own run, labelled with its book action, carrying its why
    const linkOf = new Map((plan.links ?? []).flatMap((l) => l.steps.map((id) => [id, l] as const)));
    const runOf = new Map((plan.links ?? []).map((l) => [l.id, newBlock()]));
    const labels = new Map<string, NonNullable<DataStep["book"]>>();
    for (const l of plan.links ?? []) {
      if (!l.book) continue;
      const m = (await this.server.book(l.book.id, l.book.version).catch(() => null))?.manifest;
      const a = m && bookAction(m, l.book.action);
      if (m && a) labels.set(l.id, bookLabel(m, a));
    }
    for (const s of plan.steps) rename.set(s.id, this.uniqueId({ ...doc, steps: [...doc.steps, ...[...rename.values()].map((v) => ({ id: v }) as DataStep)] }, s.id));
    for (const s of plan.steps) {
      const link = linkOf.get(s.id);
      const label = book && action ? bookLabel(book, action) : link && labels.get(link.id);
      const reason = link?.why ?? plan.rationale;
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
        ...(label ? { book: label } : {}),
        ...(reason ? { reason } : {}),
        block: (link && runOf.get(link.id)) ?? block,
        status: "proposed",
      });
    }
    doc.rationale = plan.rationale;
    doc.marker = 0;
    this.ws.touch();
    return doc;
  }

  // ---------------------------------------------------------- the Controls' Suggested tab

  /**
   * The assistant's answer to a request, as a suggestion: a book action waits
   * in the window's Controls (Suggested tab) with its values, off the history
   * until it's run. A plan of single operations still lands as proposed steps.
   */
  async suggest(plan: Plan, source: Artifact, request: string): Promise<DataDoc> {
    if (!plan.book) return this.fromPlan(plan, source);
    const errors = (plan.problems ?? []).filter((p) => p.severity === "error");
    if (errors.length) throw new Error(`This plan doesn't fit the data: ${errors.map((p) => p.message).join("; ")}`);
    const book = await this.manifest(plan.book.id);
    const action = bookAction(book, plan.book.action);
    if (!action) throw new Error(`${book.title} has no action "${plan.book.action}"`);
    const doc = this.ws.open(source, plan.workspace);
    doc.suggestion = { book: { id: book.id, title: book.title }, action: action.name, title: action.title, values: { ...plan.parameters }, rationale: plan.rationale, request };
    doc.ui.controlsTab = "suggested";
    this.ws.activate(doc.id);
    this.ws.touch();
    return doc;
  }

  /**
   * What the Suggested tab lays out: what the assistant suggested in the chat,
   * else the book run on view (its settings, to re-run), else the first action
   * that fits what's on view.
   */
  async suggestedSubject(doc: DataDoc): Promise<SuggestedSubject | null> {
    await this.loadShips();
    const specsOf = (a: BookAction) => (a.parameters ?? []).map(({ sets: _sets, ...spec }) => spec as ParamSpec);
    if (doc.suggestion) {
      const book = await this.manifest(doc.suggestion.book.id).catch(() => null);
      const a = book && bookAction(book, doc.suggestion.action);
      if (a) {
        const specs = specsOf(a);
        const defaults = Object.fromEntries(specs.flatMap((p) => (p.default === undefined ? [] : [[p.name, p.default]])));
        return { kind: "suggestion", book: doc.suggestion.book, action: a.name, title: a.title, specs, values: { ...defaults, ...doc.suggestion.values }, chosen: doc.suggestion.values, rationale: doc.suggestion.rationale, request: doc.suggestion.request };
      }
    }
    const step = doc.marker > 0 ? doc.steps[doc.marker - 1] : null;
    const block = timeBlocks(doc)[blockAt(timeBlocks(doc), doc.marker)];
    if (step?.book && block) {
      const run = await this.runControls(doc, block.first);
      const book = run && (await this.manifest(step.book.id).catch(() => null));
      const a = book && bookAction(book, step.book.action);
      if (run && a) return { kind: "run", book: { id: book!.id, title: book!.title }, action: a.name, title: a.title, specs: run.sections.flatMap((sec) => sec.params), values: run.values, first: block.first };
    }
    const next = (await this.nextActions(doc))[0];
    // the settings the data came with win over the layout's, as a suggestion's do
    const chosen = next?.preferred ? doc.prefer?.values : undefined;
    return next ? { kind: "next", book: next.book, action: next.action, title: next.title, specs: next.sections.flatMap((sec) => sec.params), values: next.values, ...(chosen ? { chosen } : {}) } : null;
  }

  /** Runs the Suggested tab's action with its values: a re-run of the run on view, or a new run. */
  runSuggested(doc: DataDoc, subject: SuggestedSubject, values: Params) {
    if (subject.kind === "run" && subject.first !== undefined) return void this.updateRun(doc, subject.first, values);
    const reason = subject.kind === "suggestion" ? subject.rationale : undefined;
    if (subject.kind === "suggestion") doc.suggestion = undefined;
    void this.runNext(doc, subject.book.id, subject.action, values, reason);
  }

  /** Lets the assistant's suggestion go, without running it. */
  dismissSuggestion(doc: DataDoc) {
    doc.suggestion = undefined;
    this.ws.touch();
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

/** Whether the window's data fits a controls section's `when`. */
function fits(when: ControlWhen | undefined, a: Artifact, s: DataSummary | undefined): boolean {
  if (!when) return true;
  if (when.kind && !when.kind.includes(a.kind)) return false;
  if (when.formats && !when.formats.includes(a.format)) return false;
  const size = (axis: string) => (s?.axes && s.shape ? (s.shape[s.axes.indexOf(axis)] ?? 1) : 1);
  const has = { time: Math.max(s?.timepoints ?? 1, size("t")) > 1, z: size("z") > 1, channels: Math.max(s?.channels ?? 1, size("c")) > 1 };
  return (when.has ?? []).every((x) => has[x]) && (when.lacks ?? []).every((x) => !has[x]);
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

/** A name for an id: lowercase words joined by `sep` ("Fluid flow" → fluid-flow or fluid_flow). */
function slug(text: string, sep: "-" | "_"): string {
  const words = text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
  const out = words.join(sep) || "saved";
  return sep === "_" && /^[0-9]/.test(out) ? `a_${out}` : out;
}
