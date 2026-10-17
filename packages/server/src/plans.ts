/**
 * Plans on the server: made from a book (or improvised by the assistant),
 * checked again after every edit, and run once approved, each step as a
 * job that starts as soon as the steps it depends on have finished.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify, parse } from "yaml";
import { type Library, type PlanRecipe, dependencies, hasErrors, planProblems, shipNeeds, stepParams } from "@pharos/books";
import { acceptProblems, matchBooks } from "@pharos/catalogue";
import { type Artifact, type BookAction, type BookManifest, type CatalogueEntry, type ChatTurn, type DataSummary, type Job, type Params, type Plan, type Step, type TestResult, type WindowRef, bookAction } from "@pharos/contracts";
import { withDefaults } from "@pharos/core";
import type { AiClient } from "./ai.js";
import type { CatalogueHolder } from "./catalogue.js";
import { type PlannerResult, planWithAssistant } from "./planner.js";
import { type Orchestration, OrchestrationError, TEST_WORKSPACE } from "./orchestration.js";
import type { WorkspaceStore } from "./workspaces.js";

const now = () => new Date().toISOString();

export interface ImprovisedPlan {
  workspace: string;
  title: string;
  rationale?: string;
  inputs: Record<string, string>;
  steps: Step[];
}

export class Plans {
  private readonly plans = new Map<string, Plan>();
  private readonly running = new Map<string, Promise<Plan>>();

  constructor(
    private readonly dataDir: string,
    private readonly workspaces: WorkspaceStore,
    private readonly library: () => Promise<Library>,
    private readonly catalogue: CatalogueHolder,
    private readonly orch: Orchestration,
  ) {}

  get(id: string): Plan {
    const plan = this.plans.get(id);
    if (!plan) throw new OrchestrationError(404, `no plan ${id}`);
    return plan;
  }

  private changed(plan: Plan) {
    this.orch.emit({ type: "plan", plan: structuredClone(plan) });
  }

  /** A plan for one of a book's actions (its first by default) on workspace data; parameters default to the action's. */
  async fromBook(workspace: string, bookId: string, inputs: Record<string, string>, parameters: Params = {}, version?: string, actionName?: string): Promise<Plan> {
    const lib = await this.library();
    const book = lib.book(bookId, version)?.manifest;
    if (!book) throw new OrchestrationError(404, `no book "${bookId}" in the library`);
    const action = bookAction(book, actionName);
    if (!action) throw new OrchestrationError(404, `"${book.title}" has no action "${actionName}" (it has: ${Object.keys(book.actions).join(", ")})`);
    const plan: Plan = {
      id: `plan-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`,
      workspace,
      source: "book",
      book: { id: book.id, version: book.version, action: action.name },
      title: Object.keys(book.actions).length > 1 ? `${book.title}: ${action.title}` : book.title,
      inputs,
      parameters: { ...Object.fromEntries((action.parameters ?? []).flatMap((p) => (p.default === undefined ? [] : [[p.name, p.default]]))), ...parameters },
      steps: structuredClone(action.steps),
      ships: [],
      problems: [],
      status: "proposed",
      createdAt: now(),
    };
    return this.store(await this.check(plan));
  }

  /** A pipeline the assistant put together from ship operations. */
  async improvised(p: ImprovisedPlan): Promise<Plan> {
    const plan: Plan = {
      id: `plan-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`,
      workspace: p.workspace,
      source: "improvised",
      title: p.title,
      ...(p.rationale ? { rationale: p.rationale } : {}),
      inputs: p.inputs,
      parameters: {},
      steps: p.steps,
      ships: [],
      problems: [],
      status: "proposed",
      createdAt: now(),
    };
    return this.store(await this.check(plan));
  }

  /**
   * Asks the assistant to choose a book for workspace data (or improvise a
   * pipeline). Only the final proposal is kept; earlier attempts the
   * assistant repaired are cancelled.
   */
  async withAssistant(workspace: string, text: string, artifacts: string[], ai: { client: AiClient; model: string }, history: ChatTurn[] = [], windows: WindowRef[] = []): Promise<PlannerResult> {
    const lib = await this.library();
    const ctx = await this.catalogue.get();
    const data = await Promise.all(artifacts.map(async (id) => ({ id, summary: await this.catalogue.summary(this.workspaces, workspace, id) })));
    const matches = matchBooks(ctx.books, data.map((d) => d.summary), { text, gpu: ctx.gpu });
    const made: Plan[] = [];
    const result = await planWithAssistant(ai.client, ai.model, { text, data, history, windows }, { ...ctx, library: lib, matches }, {
      fromBook: async (book, action, inputs, parameters, rationale) => {
        const plan = await this.fromBook(workspace, book, inputs, parameters, undefined, action);
        plan.rationale = rationale;
        made.push(this.store(plan));
        return plan;
      },
      improvised: async (title, rationale, inputs, steps) => {
        const plan = await this.improvised({ workspace, title, rationale, inputs, steps });
        made.push(plan);
        return plan;
      },
    });
    for (const p of made) if (p !== result.plan && p.status === "proposed") await this.cancel(p.id);
    return result;
  }

  /** Validates a plan without keeping it; the assistant uses this to repair its proposals. */
  async check(plan: Plan): Promise<Plan> {
    const lib = await this.library();
    const recipe = this.recipe(lib, plan);
    const book = recipe?.book;
    const artifacts: Record<string, Artifact> = {};
    const summaries: Record<string, DataSummary> = {};
    for (const id of Object.values(plan.inputs)) {
      const a = await this.workspaces.get(plan.workspace, id).catch(() => null);
      if (!a) continue;
      artifacts[id] = a;
      summaries[id] = await this.catalogue.summary(this.workspaces, plan.workspace, id).catch(() => a.meta.summary as DataSummary);
    }
    const ranges = book?.ships;
    const ships = plan.steps.flatMap((s) => lib.ship(s.run.split(".")[0], ranges?.[s.run.split(".")[0]]) ?? []);
    const inventory = await this.orch.inventory(ships);
    plan.ships = shipNeeds(plan.steps, ranges, lib, inventory);
    plan.problems = planProblems(plan, recipe, {
      ships: lib,
      inventory,
      machine: { gpu: this.orch.gpu() },
      artifacts,
      inputProblems: (name, a) => {
        const accepts = recipe?.action.inputs?.find((i) => i.name === name)?.accepts;
        return accepts && summaries[a.id] ? acceptProblems(accepts, summaries[a.id]) : [];
      },
    });
    return plan;
  }

  /** The book and action a plan was made from, when it still exists in the library. */
  private recipe(lib: Library, plan: Plan): PlanRecipe | undefined {
    const book = plan.book ? lib.book(plan.book.id, plan.book.version)?.manifest : undefined;
    const action = book && bookAction(book, plan.book!.action);
    return book && action ? { book, action } : undefined;
  }

  private store(plan: Plan): Plan {
    this.plans.set(plan.id, plan);
    this.changed(plan);
    return plan;
  }

  /** Changes inputs, parameters or steps of a proposed plan, and checks it again. */
  async update(id: string, patch: Partial<Pick<Plan, "inputs" | "parameters" | "steps">>): Promise<Plan> {
    const plan = this.get(id);
    if (plan.status !== "proposed") throw new OrchestrationError(409, `the plan is ${plan.status}; only a proposed plan can change`);
    if (patch.inputs) plan.inputs = patch.inputs;
    if (patch.parameters) plan.parameters = patch.parameters;
    if (patch.steps) plan.steps = patch.steps;
    return this.store(await this.check(plan));
  }

  /** Starts a proposed plan once it has no errors; returns as soon as its first jobs are queued. */
  async approve(id: string): Promise<{ plan: Plan; jobs: Job[] }> {
    const plan = await this.check(this.get(id));
    if (plan.status !== "proposed") throw new OrchestrationError(409, `the plan is already ${plan.status}`);
    if (hasErrors(plan.problems)) throw new OrchestrationError(422, `the plan has problems: ${plan.problems.filter((p) => p.severity === "error").map((p) => p.message).join("; ")}`);
    plan.status = "approved";
    plan.jobs = {};
    this.store(plan);
    const firstJobs = new Promise<Job[]>((ok) => {
      this.running.set(plan.id, this.execute(plan, ok));
    });
    return { plan, jobs: await firstJobs };
  }

  /** Waits for an approved plan to finish. */
  async finished(id: string): Promise<Plan> {
    return (await this.running.get(id)) ?? this.get(id);
  }

  async cancel(id: string): Promise<Plan> {
    const plan = this.get(id);
    if (plan.status === "proposed") {
      plan.status = "cancelled";
      return this.store(plan);
    }
    for (const jobId of Object.values(plan.jobs ?? {})) {
      try {
        this.orch.cancel(jobId);
      } catch {
        /* already gone */
      }
    }
    return plan;
  }

  private async execute(plan: Plan, started: (jobs: Job[]) => void): Promise<Plan> {
    const lib = await this.library();
    const recipe = this.recipe(lib, plan);
    const book = recipe?.book;
    const results = new Map<string, Record<string, string>>();
    const waiting = new Map(plan.steps.map((s) => [s.id, s]));
    const active = new Map<string, Promise<void>>();
    const queued: Job[] = [];
    let failure: Job | undefined;
    let reported = false;
    const report = () => {
      if (!reported) (reported = true), started(queued);
    };

    /** Settles once the step's job is queued (or the step failed before that). */
    const submitted: Promise<void>[] = [];
    const runStep = async (step: Step, queuedJob: () => void) => {
      const [shipId, operation] = step.run.split(".");
      const ship = lib.ship(shipId, book?.ships[shipId])!;
      const inputs: Record<string, Artifact> = {};
      for (const [port, wire] of Object.entries(step.in ?? {})) {
        const id = wire.startsWith("$") ? plan.inputs[wire.slice(1)] : results.get(wire.split(".")[0])?.[wire.split(".")[1]];
        inputs[port] = await this.workspaces.get(plan.workspace, id!);
      }
      const params = withDefaults(ship.operations[operation].parameters ?? [], stepParams(step, recipe?.action.parameters ?? [], plan.parameters));
      const job = await this.orch.submit({ workspace: plan.workspace, ship, operation, inputs, params, planId: plan.id, stepId: step.id, ...(plan.book ? { book: { id: plan.book.id, version: plan.book.version } } : {}) });
      plan.jobs![step.id] = job.id;
      queued.push(job);
      queuedJob();
      this.changed(plan);
      const done = await this.orch.finished(job.id);
      if (done.state === "done") results.set(step.id, done.outputs ?? {});
      else failure ??= done;
    };

    try {
      plan.status = "running";
      this.changed(plan);
      while (waiting.size || active.size) {
        if (!failure) {
          for (const [id, step] of waiting) {
            if (dependencies(step).every((d) => results.has(d))) {
              waiting.delete(id);
              let queuedJob!: () => void;
              submitted.push(new Promise<void>((ok) => (queuedJob = ok)));
              const run = runStep(step, queuedJob);
              void run.catch(() => {}).finally(queuedJob);
              active.set(id, run.finally(() => active.delete(id)));
            }
          }
        }
        if (!reported) {
          await Promise.all(submitted);
          report();
        }
        if (!active.size) break;
        await Promise.race(active.values());
        if (failure) await this.cancel(plan.id); // stop the steps still running
      }
      if (failure || waiting.size) {
        const f = failure as Job | undefined;
        plan.status = f?.state === "cancelled" ? "cancelled" : "failed";
        plan.error = f ? `${f.stepId ?? f.operation}: ${f.error ?? f.state}` : "some steps could never start";
      } else {
        plan.outputs = recipe ? resolveOutputs(recipe.action.outputs, results) : unconsumedOutputs(plan.steps, results);
        plan.status = "done";
      }
    } catch (e) {
      plan.status = "failed";
      plan.error = e instanceof Error ? e.message : String(e);
      await this.cancel(plan.id);
    }
    report();
    this.changed(plan);
    return plan;
  }

  // ---------------------------------------------------------- Save as book

  /**
   * Writes a plan that worked as a book in the data folder's books/: a new
   * book with one action, or a new action in a book already saved there.
   */
  async saveAsBook(id: string, meta: { id: string; title: string; summary: string; action: { name: string; title: string } }): Promise<CatalogueEntry> {
    const plan = this.get(id);
    const lib = await this.library();
    const dir = join(this.dataDir, "books", meta.id);
    const existing = lib.book(meta.id);
    if (existing && existing.dir !== dir) throw new OrchestrationError(409, `a book "${meta.id}" already exists in ${existing.dir}; only books saved in Pharos can gain actions`);
    if (existing?.manifest?.actions[meta.action.name]) throw new OrchestrationError(409, `"${existing.manifest.title}" already has an action "${meta.action.name}"`);
    const from = this.recipe(lib, plan);
    const ships: Record<string, string> = {};
    for (const s of plan.ships) ships[s.id] = `^${s.version.split(".").slice(0, 2).join(".")}`;
    const inputs: BookAction["inputs"] = [];
    for (const [name, artifactId] of Object.entries(plan.inputs)) {
      const declared = from?.action.inputs?.find((i) => i.name === name);
      if (declared) {
        inputs.push(declared);
        continue;
      }
      const a = await this.workspaces.get(plan.workspace, artifactId);
      const summary = a.meta.summary as DataSummary | undefined;
      inputs.push({ name, accepts: { kind: a.kind, ...(summary?.axes ? { axes: summary.axes } : {}) } });
    }
    const results = new Map(plan.steps.map((s) => [s.id, Object.fromEntries((lib.ship(s.run.split(".")[0], ships[s.run.split(".")[0]])?.operations[s.run.split(".")[1]]?.outputs ?? []).map((o) => [o.name, o.name]))]));
    const action: BookAction = {
      title: meta.action.title,
      ...(inputs.length ? { inputs } : {}),
      ...(from?.action.parameters?.length ? { parameters: from.action.parameters } : {}),
      steps: plan.steps,
      outputs: from?.action.outputs ?? Object.fromEntries(Object.entries(unconsumedOutputs(plan.steps, results)).map(([k]) => [k.replace(/\./g, "_"), k])),
    };
    const old = existing?.manifest;
    const book: BookManifest = old
      ? { ...old, ships: { ...old.ships, ...Object.fromEntries(Object.entries(ships).filter(([s]) => !(s in old.ships))) }, actions: { ...old.actions, [meta.action.name]: action } }
      : { id: meta.id, version: "0.1.0", title: meta.title, summary: meta.summary, tags: from?.book.tags ?? [], ships, actions: { [meta.action.name]: action } };
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "book.yaml"), stringify(book, { lineWidth: 0 }));
    if (!old) {
      await writeFile(
        join(dir, "GUIDE.md"),
        `# ${meta.title}\n\n${meta.summary}\n\n## When to use\n\n${plan.rationale ?? "Saved from a plan that worked."}\n\n## When not to use\n\n## Parameters\n\n## Example\n\nSaved from plan ${plan.id} on ${now().slice(0, 10)}.\n`,
      );
    }
    const fresh = await this.library();
    const saved = fresh.book(meta.id);
    if (!saved?.manifest?.actions[meta.action.name]) {
      const errors = saved?.problems.filter((p) => p.severity === "error").map((p) => p.message) ?? ["it didn't load"];
      throw new OrchestrationError(422, `saved to ${dir}, but the book has problems: ${errors.join("; ")}`);
    }
    this.orch.emit({ type: "library", change: "books" });
    return fresh.bookEntries().find((e) => e.id === meta.id)!;
  }

  // ---------------------------------------------------------- Test book

  /**
   * Runs each of a book's actions on its example: `example/<input>.<ext>`
   * for each input, optional `params.yaml` (shared, or keyed by action
   * name), and optional `expected-<output>.<ext>` files the results must
   * equal. Actions whose inputs the example lacks are skipped. A book whose
   * actions all pass becomes verified.
   */
  async testBook(bookId: string, version?: string): Promise<TestResult> {
    const lib = await this.library();
    const loaded = lib.book(bookId, version);
    const book = loaded?.manifest;
    if (!loaded || !book) throw new OrchestrationError(404, `no book "${bookId}" in the library`);
    const dir = join(loaded.dir, "example");
    const target = { type: "book" as const, id: book.id, version: book.version };
    const finish = async (cases: TestResult["cases"]): Promise<TestResult> => {
      const passed = cases.length > 0 && cases.every((c) => c.passed);
      const failed = cases.filter((c) => !c.passed).map((c) => `${c.name}: ${c.message ?? "failed"}`).join("; ");
      await this.orch.trust.set("book", book.id, book.version, passed ? { trust: "verified" } : { trust: "imported", error: failed || "nothing to test" });
      this.orch.emit({ type: "library", change: "books" });
      return { target, passed, cases };
    };
    const files = await readdir(dir).catch(() => null);
    if (!files) return finish([{ name: "example", passed: false, message: "no example/ folder" }]);
    await this.workspaces.create(TEST_WORKSPACE);
    const allParams = files.includes("params.yaml") ? ((parse(await readFile(join(dir, "params.yaml"), "utf8")) ?? {}) as Record<string, unknown>) : {};
    const cases: TestResult["cases"] = [];
    for (const [name, action] of Object.entries(book.actions)) {
      const fileFor = (input: string) => files.find((f) => f === input || f.startsWith(`${input}.`));
      if ((action.inputs ?? []).some((i) => !fileFor(i.name))) continue;
      const inputs: Record<string, string> = {};
      for (const input of action.inputs ?? []) inputs[input.name] = (await this.workspaces.importPath(TEST_WORKSPACE, join(dir, fileFor(input.name)!))).id;
      // params.yaml is either shared by every action, or has a section per action
      const own = allParams[name];
      const known = new Set((action.parameters ?? []).map((p) => p.name));
      const source = own && typeof own === "object" ? (own as Params) : (allParams as Params);
      const params = Object.fromEntries(Object.entries(source).filter(([k]) => known.has(k))) as Params;
      cases.push(await this.testAction(book, name, inputs, params, files, dir));
    }
    if (!cases.length) return finish([{ name: "example", passed: false, message: "example/ has no files for any action's inputs" }]);
    return finish(cases);
  }

  private async testAction(book: BookManifest, action: string, inputs: Record<string, string>, params: Params, files: string[], dir: string): Promise<TestResult["cases"][number]> {
    const plan = await this.fromBook(TEST_WORKSPACE, book.id, inputs, params, book.version, action);
    if (hasErrors(plan.problems)) return { name: action, passed: false, message: plan.problems.filter((p) => p.severity === "error").map((p) => p.message).join("; ") };
    await this.approve(plan.id);
    const done = await this.finished(plan.id);
    const jobId = Object.values(done.jobs ?? {}).at(-1);
    if (done.status !== "done") return { name: action, passed: false, message: done.error ?? done.status, ...(jobId ? { jobId } : {}) };
    const mismatched: string[] = [];
    for (const [name, artifactId] of Object.entries(done.outputs ?? {})) {
      const expected = files.find((f) => f.startsWith(`expected-${name}.`));
      if (!expected) continue;
      const a = await this.workspaces.get(TEST_WORKSPACE, artifactId);
      if (!(await stat(a.uri)).isFile() || !(await readFile(join(dir, expected))).equals(await readFile(a.uri))) mismatched.push(name);
    }
    return { name: action, passed: !mismatched.length, ...(mismatched.length ? { message: `output ${mismatched.join(", ")} differs from example/expected-*` } : {}) };
  }
}

/** Action outputs (`name: step.output`) → artifact ids. */
function resolveOutputs(outputs: Record<string, string>, results: Map<string, Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(outputs).flatMap(([name, ref]) => {
    const id = results.get(ref.split(".")[0])?.[ref.split(".")[1]];
    return id ? [[name, id]] : [];
  }));
}

/** For improvised plans: every step output that no later step uses, keyed `step.output`. */
function unconsumedOutputs(steps: Step[], results: Map<string, Record<string, string>>): Record<string, string> {
  const used = new Set(steps.flatMap((s) => Object.values(s.in ?? {})));
  const out: Record<string, string> = {};
  for (const [stepId, outs] of results) for (const [name, id] of Object.entries(outs)) if (!used.has(`${stepId}.${name}`)) out[`${stepId}.${name}`] = id;
  return out;
}
