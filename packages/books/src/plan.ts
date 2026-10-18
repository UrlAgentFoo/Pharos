/**
 * Plans: a book (or an improvised pipeline) bound to the user's data and
 * parameter values, checked before anyone approves it.
 */
import type { Artifact, BookAction, BookManifest, BookParam, Params, Plan, PlanProblem, ShipManifest, Step } from "@pharos/contracts";
import { type Pipeline, type PipelineInput, type ShipLookup, checkPipeline, paramValueProblem } from "./check.js";
import { error } from "./problems.js";
import { type ImageInventory, type Machine, shipGpu } from "./resolve.js";

/** A step's parameter values: what the step fixes in `with`, plus the book parameters that `sets` it. */
export function stepParams(step: Step, params: BookParam[], values: Params): Params {
  const out: Params = { ...(step.with ?? {}) };
  for (const p of params) {
    const targets = Array.isArray(p.sets) ? p.sets : [p.sets];
    for (const t of targets) {
      const [stepId, name] = t.split(".");
      const v = values[p.name] ?? p.default;
      if (stepId === step.id && v !== undefined) out[name] = v;
    }
  }
  return out;
}

/** The ships a list of steps needs, newest version each range allows. */
export function shipNeeds(steps: Step[], ranges: Record<string, string> | undefined, ships: ShipLookup, inventory: ImageInventory): Plan["ships"] {
  const seen = new Map<string, ShipManifest>();
  for (const s of steps) {
    const id = s.run.split(".")[0];
    const ship = ships.ship(id, ranges?.[id]);
    if (ship) seen.set(id, ship);
  }
  return [...seen.values()].map((ship) => {
    const size = inventory.sizeBytes?.(ship.image);
    return { id: ship.id, version: ship.version, image: ship.image, downloaded: inventory.has(ship.image), gpu: shipGpu(ship), ...(size !== undefined ? { sizeBytes: size } : {}) };
  });
}

export interface PlanContext {
  ships: ShipLookup;
  inventory: ImageInventory;
  machine: Machine;
  /** Artifacts the plan's inputs name, by id. */
  artifacts: Record<string, Artifact>;
  /** Extra problems for an input's data, e.g. from matching its summary against `accepts`. */
  inputProblems?(input: string, artifact: Artifact): string[];
}

/** A book and the action a plan runs; absent for improvised plans. */
export interface PlanRecipe {
  book: BookManifest;
  action: BookAction;
}

/** Checks a plan as it stands: wiring, parameter values, the data it's given, its ships and the GPU. */
export function planProblems(plan: Pick<Plan, "steps" | "inputs" | "parameters">, recipe: PlanRecipe | undefined, ctx: PlanContext): PlanProblem[] {
  const problems: PlanProblem[] = [];
  const book = recipe?.book;
  const action = recipe?.action;
  const declared: PipelineInput[] = action
    ? (action.inputs ?? []).map((i) => ({ name: i.name, kind: i.accepts.kind, ...(i.accepts.formats ? { formats: i.accepts.formats } : {}) }))
    : Object.keys(plan.inputs).map((name) => ({ name, kind: ctx.artifacts[plan.inputs[name]]?.kind ?? "volume" }));

  // the data given for each input: there, of the right kind, and accepted
  for (const input of declared) {
    const id = plan.inputs[input.name];
    const artifact = id ? ctx.artifacts[id] : undefined;
    if (!id) {
      problems.push(error(`/inputs/${input.name}`, `no data chosen for "${input.name}"`));
      continue;
    }
    if (!artifact) {
      problems.push(error(`/inputs/${input.name}`, `the data for "${input.name}" isn't in this workspace`));
      continue;
    }
    if (artifact.kind !== input.kind) problems.push(error(`/inputs/${input.name}`, `"${input.name}" needs ${input.kind} data, ${artifact.name ?? "this"} is ${artifact.kind}`));
    for (const p of ctx.inputProblems?.(input.name, artifact) ?? []) problems.push(error(`/inputs/${input.name}`, p));
  }

  // the pipeline, typed with the actual formats where we know them
  const pipeline: Pipeline = {
    inputs: declared.map((i) => {
      const a = ctx.artifacts[plan.inputs[i.name]];
      return a ? { name: i.name, kind: a.kind, formats: [a.format] } : i;
    }),
    parameters: action?.parameters ?? [],
    steps: plan.steps,
    outputs: action?.outputs ?? {},
    ...(book ? { ships: book.ships } : {}),
  };
  // an improvised plan declares no outputs: whatever its last steps make is the result
  const unused = (p: PlanProblem) => p.severity === "warning" && p.message.startsWith("nothing uses the outputs");
  problems.push(...checkPipeline(pipeline, ctx.ships).filter((p) => book || !unused(p)));

  // parameter values the user set
  for (const p of action?.parameters ?? []) {
    const v = plan.parameters[p.name];
    if (v === undefined) continue;
    const bad = paramValueProblem(p, v);
    if (bad) problems.push(error(`/parameters/${p.name}`, `"${p.label ?? p.name}" ${bad}`));
  }

  // GPU
  for (const s of plan.steps) {
    const ship = ctx.ships.ship(s.run.split(".")[0], book?.ships[s.run.split(".")[0]]);
    if (ship && shipGpu(ship) === "required" && !ctx.machine.gpu) problems.push(error(`/steps`, `${s.run} needs an NVIDIA GPU, which this machine doesn't have`));
  }
  return problems;
}

/** Steps whose outputs feed `step`, by id. */
export function dependencies(step: Step): string[] {
  return [...new Set(Object.values(step.in ?? {}).filter((w) => !w.startsWith("$")).map((w) => w.split(".")[0]))];
}
