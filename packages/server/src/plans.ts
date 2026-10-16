/**
 * Plans on the server: made from a book (or improvised by the assistant),
 * checked again after every edit, and run once approved, each step as a
 * job that starts as soon as the steps it depends on have finished.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify, parse } from "yaml";
import { type Library, dependencies, hasErrors, planProblems, shipNeeds, stepParams } from "@pharos/books";
import { acceptProblems, matchBooks } from "@pharos/catalogue";
import type { Artifact, BookManifest, CatalogueEntry, DataSummary, Job, Params, Plan, Step, TestResult } from "@pharos/contracts";
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

  /** A plan for a book on workspace data; parameters default to the book's. */
  async fromBook(workspace: string, bookId: string, inputs: Record<string, string>, parameters: Params = {}, version?: string): Promise<Plan> {
    const lib = await this.library();
    const book = lib.book(bookId, version)?.manifest;
    if (!book) throw new OrchestrationError(404, `no book "${bookId}" in the library`);
    const plan: Plan = {
      id: `plan-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`,
      workspace,
      source: "book",
      book: { id: book.id, version: book.version },
      title: book.title,
      inputs,
      parameters: { ...Object.fromEntries((book.parameters ?? []).flatMap((p) => (p.default === undefined ? [] : [[p.name, p.default]]))), ...parameters },
      steps: structuredClone(book.steps),
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
  async withAssistant(workspace: string, text: string, artifacts: string[], ai: { client: AiClient; model: string }): Promise<PlannerResult> {
    const lib = await this.library();
    const ctx = await this.catalogue.get();
    const data = await Promise.all(artifacts.map(async (id) => ({ id, summary: await this.catalogue.summary(this.workspaces, workspace, id) })));
    const matches = matchBooks(ctx.books, data.map((d) => d.summary), { text, gpu: ctx.gpu });
    const made: Plan[] = [];
    const result = await planWithAssistant(ai.client, ai.model, { text, data }, { ...ctx, library: lib, matches }, {
      fromBook: async (book, inputs, parameters, rationale) => {
        const plan = await this.fromBook(workspace, book, inputs, parameters);
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
    const book = plan.book ? lib.book(plan.book.id, plan.book.version)?.manifest : undefined;
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
    plan.problems = planProblems(plan, book, {
      ships: lib,
      inventory,
      machine: { gpu: this.orch.gpu() },
      artifacts,
      inputProblems: (name, a) => {
        const accepts = book?.inputs?.find((i) => i.name === name)?.accepts;
        return accepts && summaries[a.id] ? acceptProblems(accepts, summaries[a.id]) : [];
      },
    });
    return plan;
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
    const book = plan.book ? lib.book(plan.book.id, plan.book.version)?.manifest : undefined;
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
      const params = withDefaults(ship.operations[operation].parameters ?? [], stepParams(step, book?.parameters ?? [], plan.parameters));
      const job = await this.orch.submit({ workspace: plan.workspace, ship, operation, inputs, params, planId: plan.id, stepId: step.id, ...(plan.book ? { book: plan.book } : {}) });
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
        plan.outputs = book ? resolveOutputs(book.outputs, results) : unconsumedOutputs(plan.steps, results);
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

  /** Writes a plan that worked as a new book in the data folder's books/. */
  async saveAsBook(id: string, meta: { id: string; title: string; summary: string }): Promise<CatalogueEntry> {
    const plan = this.get(id);
    const lib = await this.library();
    if (lib.book(meta.id)) throw new OrchestrationError(409, `a book "${meta.id}" already exists`);
    const from = plan.book ? lib.book(plan.book.id, plan.book.version)?.manifest : undefined;
    const ships: Record<string, string> = {};
    for (const s of plan.ships) ships[s.id] = `^${s.version.split(".").slice(0, 2).join(".")}`;
    const inputs: BookManifest["inputs"] = [];
    for (const [name, artifactId] of Object.entries(plan.inputs)) {
      const declared = from?.inputs?.find((i) => i.name === name);
      if (declared) {
        inputs.push(declared);
        continue;
      }
      const a = await this.workspaces.get(plan.workspace, artifactId);
      const summary = a.meta.summary as DataSummary | undefined;
      inputs.push({ name, accepts: { kind: a.kind, ...(summary?.axes ? { axes: summary.axes } : {}) } });
    }
    const results = new Map(plan.steps.map((s) => [s.id, Object.fromEntries((lib.ship(s.run.split(".")[0], ships[s.run.split(".")[0]])?.operations[s.run.split(".")[1]]?.outputs ?? []).map((o) => [o.name, o.name]))]));
    const book: BookManifest = {
      id: meta.id,
      version: "0.1.0",
      title: meta.title,
      summary: meta.summary,
      tags: from?.tags ?? [],
      ships,
      inputs,
      ...(from?.parameters?.length ? { parameters: from.parameters } : {}),
      steps: plan.steps,
      outputs: from?.outputs ?? Object.fromEntries(Object.entries(unconsumedOutputs(plan.steps, results)).map(([k]) => [k.replace(/\./g, "_"), k])),
    };
    const dir = join(this.dataDir, "books", meta.id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "book.yaml"), stringify(book, { lineWidth: 0 }));
    await writeFile(
      join(dir, "GUIDE.md"),
      `# ${meta.title}\n\n${meta.summary}\n\n## When to use\n\n${plan.rationale ?? "Saved from a plan that worked."}\n\n## When not to use\n\n## Parameters\n\n## Example\n\nSaved from plan ${plan.id} on ${now().slice(0, 10)}.\n`,
    );
    const fresh = await this.library();
    const saved = fresh.book(meta.id);
    if (!saved?.manifest) {
      const errors = saved?.problems.filter((p) => p.severity === "error").map((p) => p.message) ?? ["it didn't load"];
      throw new OrchestrationError(422, `saved to ${dir}, but the book has problems: ${errors.join("; ")}`);
    }
    this.orch.emit({ type: "library", change: "books" });
    return fresh.bookEntries().find((e) => e.id === meta.id)!;
  }

  // ---------------------------------------------------------- Test book

  /**
   * Runs a book on its example: `example/<input>.<ext>` for each input,
   * optional `params.yaml`, and optional `expected-<output>.<ext>` files the
   * results must equal. A book that passes becomes verified.
   */
  async testBook(bookId: string, version?: string): Promise<TestResult> {
    const lib = await this.library();
    const loaded = lib.book(bookId, version);
    const book = loaded?.manifest;
    if (!loaded || !book) throw new OrchestrationError(404, `no book "${bookId}" in the library`);
    const dir = join(loaded.dir, "example");
    const target = { type: "book" as const, id: book.id, version: book.version };
    const finish = async (passed: boolean, message?: string, jobId?: string): Promise<TestResult> => {
      await this.orch.trust.set("book", book.id, book.version, passed ? { trust: "verified" } : { trust: "imported", error: message });
      this.orch.emit({ type: "library", change: "books" });
      return { target, passed, cases: [{ name: "example", passed, ...(message ? { message } : {}), ...(jobId ? { jobId } : {}) }] };
    };
    const files = await readdir(dir).catch(() => null);
    if (!files) return finish(false, "no example/ folder");
    await this.workspaces.create(TEST_WORKSPACE);
    const inputs: Record<string, string> = {};
    for (const input of book.inputs ?? []) {
      const file = files.find((f) => f === input.name || f.startsWith(`${input.name}.`));
      if (!file) return finish(false, `example/ has no file for input "${input.name}"`);
      inputs[input.name] = (await this.workspaces.importPath(TEST_WORKSPACE, join(dir, file))).id;
    }
    const params = files.includes("params.yaml") ? ((parse(await readFile(join(dir, "params.yaml"), "utf8")) ?? {}) as Params) : {};
    const plan = await this.fromBook(TEST_WORKSPACE, book.id, inputs, params, book.version);
    if (hasErrors(plan.problems)) return finish(false, plan.problems.filter((p) => p.severity === "error").map((p) => p.message).join("; "));
    await this.approve(plan.id);
    const done = await this.finished(plan.id);
    if (done.status !== "done") return finish(false, done.error ?? done.status);
    const mismatched: string[] = [];
    for (const [name, artifactId] of Object.entries(done.outputs ?? {})) {
      const expected = files.find((f) => f.startsWith(`expected-${name}.`));
      if (!expected) continue;
      const a = await this.workspaces.get(TEST_WORKSPACE, artifactId);
      if (!(await stat(a.uri)).isFile() || !(await readFile(join(dir, expected))).equals(await readFile(a.uri))) mismatched.push(name);
    }
    return finish(!mismatched.length, mismatched.length ? `output ${mismatched.join(", ")} differs from example/expected-*` : undefined);
  }
}

/** Book outputs (`name: step.output`) → artifact ids. */
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
