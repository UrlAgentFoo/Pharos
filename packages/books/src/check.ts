/**
 * Type-checks pipelines: books, and plans the assistant improvises.
 *
 * Every wire must exist and come from an earlier step; each step's input
 * gets the kind it needs, in a format it reads; parameters exist, have
 * valid values and are set once; outputs point at real step outputs.
 * Problems carry JSON pointers into the book, e.g. /steps/2/in/labels.
 */
import { type ArtifactKind, type BookAction, type BookManifest, type BookParam, DISPLAYABLE_FORMATS, type Format, type ParamSpec, type ParamValue, type ShipManifest, type Step } from "@pharos/contracts";
import { type ManifestProblem, error, warning } from "./problems.js";

/** Finds ship manifests: the best version matching a range, or any version. */
export interface ShipLookup {
  ship(id: string, range?: string): ShipManifest | undefined;
}

export interface PipelineInput {
  name: string;
  kind: ArtifactKind;
  /** Formats the input may arrive in; absent means any format of its kind. */
  formats?: Format[];
}

export interface Pipeline {
  inputs: PipelineInput[];
  parameters: BookParam[];
  steps: Step[];
  outputs: Record<string, string>;
  /** Ship id → version range; when given, every step's ship must be listed. */
  ships?: Record<string, string>;
}

/** One of a book's actions as a pipeline: its inputs, parameters, steps and outputs, with the book's ships. */
export function actionPipeline(book: Pick<BookManifest, "ships">, action: BookAction): Pipeline {
  return {
    inputs: (action.inputs ?? []).map((i) => ({ name: i.name, kind: i.accepts.kind, ...(i.accepts.formats ? { formats: i.accepts.formats } : {}) })),
    parameters: action.parameters ?? [],
    steps: action.steps,
    outputs: action.outputs,
    ships: book.ships,
  };
}

/** Checks a ship's own consistency: unique names, and command placeholders that match its parameters. */
export function checkShip(ship: ShipManifest): ManifestProblem[] {
  const problems: ManifestProblem[] = [];
  for (const [name, op] of Object.entries(ship.operations)) {
    const base = `/operations/${name}`;
    const params = new Set((op.parameters ?? []).map((p) => p.name));
    dupes((op.inputs ?? []).map((i) => i.name), `${base}/inputs`, "input", problems);
    dupes(op.outputs.map((o) => o.name), `${base}/outputs`, "output", problems);
    dupes([...params], `${base}/parameters`, "parameter", problems);
    const used = new Set([...op.command.matchAll(/\{([a-z][a-z0-9_]*)\}/g)].map((m) => m[1]));
    for (const u of used) if (!params.has(u)) problems.push(error(`${base}/command`, `uses {${u}}, which isn't one of its parameters`));
    if (op.view) {
      if ((op.inputs ?? []).filter((i) => !i.optional).length !== 1) problems.push(error(`${base}/view`, "a view takes exactly one input: the data it shows"));
      if (op.outputs.length !== 1 || !DISPLAYABLE_FORMATS.includes(op.outputs[0].format)) {
        problems.push(error(`${base}/view`, `a view makes one output a window can show (${DISPLAYABLE_FORMATS.join(", ")})`));
      }
    }
    for (const p of op.parameters ?? []) {
      if (!used.has(p.name)) problems.push(warning(`${base}/parameters`, `parameter "${p.name}" never appears in the command`));
      const bad = p.default === undefined ? null : paramValueProblem(p, p.default);
      if (bad) problems.push(error(`${base}/parameters`, `default of "${p.name}" ${bad}`));
      if (p.type === "enum" && !p.options?.length) problems.push(error(`${base}/parameters`, `enum parameter "${p.name}" needs options`));
    }
  }
  return problems;
}

/** Why a value doesn't fit a parameter, or null when it does. */
export function paramValueProblem(spec: Pick<ParamSpec, "type" | "options" | "min" | "max">, v: ParamValue): string | null {
  switch (spec.type) {
    case "number":
      if (typeof v !== "number" || !Number.isFinite(v)) return "must be a number";
      break;
    case "integer":
      if (!Number.isInteger(v)) return "must be a whole number";
      break;
    case "boolean":
      return typeof v === "boolean" ? null : "must be true or false";
    case "enum":
      return typeof v === "string" && (spec.options ?? []).includes(v) ? null : `must be one of ${(spec.options ?? []).join(", ")}`;
    case "string":
      return typeof v === "string" ? null : "must be text";
  }
  const n = v as number;
  if ((spec.min !== undefined && n < spec.min) || (spec.max !== undefined && n > spec.max)) return `must be between ${spec.min ?? "-∞"} and ${spec.max ?? "∞"}`;
  return null;
}

interface WireValue {
  kind: ArtifactKind;
  formats?: Format[];
  from: string;
}

/** Checks every action of a book; problems point into it, e.g. /actions/simulate/steps/1/in/case. */
export function checkBook(book: BookManifest, ships: ShipLookup): ManifestProblem[] {
  const problems: ManifestProblem[] = [];
  for (const [name, action] of Object.entries(book.actions)) {
    for (const p of checkPipeline(actionPipeline(book, action), ships)) problems.push({ ...p, path: `/actions/${name}${p.path}` });
    // the Controls design places the action's own parameters, each once
    const params = new Set((action.parameters ?? []).map((x) => x.name));
    const placed = new Set<string>();
    (action.controls ?? []).forEach((sec, i) =>
      (sec.params ?? []).forEach((param, j) => {
        const path = `/actions/${name}/controls/${i}/params/${j}`;
        if (!params.has(param)) problems.push(error(path, `"${name}" has no parameter "${param}"`));
        else if (placed.has(param)) problems.push(warning(path, `"${param}" is already in an earlier section`));
        placed.add(param);
      }),
    );
    (action.next ?? []).forEach((other, i) => {
      if (!book.actions[other]) problems.push(error(`/actions/${name}/next/${i}`, `the book has no action "${other}"`));
      else if (other === name) problems.push(warning(`/actions/${name}/next/${i}`, `"${name}" offers itself next; its own Controls already re-run it`));
    });
  }
  // the opening action runs without a click only when quick, so say when it won't
  if (book.opens_with !== undefined) {
    const opener = book.actions[book.opens_with];
    if (!opener) problems.push(error("/opens_with", `the book has no action "${book.opens_with}"`));
    else if (!opener.quick) problems.push(warning("/opens_with", `"${book.opens_with}" isn't marked quick, so opening data only proposes it`));
  }
  // a ship listed but used by no action still gets downloaded for the book
  const used = new Set(Object.values(book.actions).flatMap((a) => a.steps.map((s) => s.run.split(".")[0])));
  for (const id of Object.keys(book.ships)) if (!used.has(id)) problems.push(warning(`/ships/${id}`, `no action uses ship "${id}"`));
  return problems;
}

export function checkPipeline(p: Pipeline, ships: ShipLookup): ManifestProblem[] {
  const problems: ManifestProblem[] = [];
  const inputs = new Map(p.inputs.map((i) => [i.name, i]));
  dupes(p.inputs.map((i) => i.name), "/inputs", "input", problems);
  dupes(p.parameters.map((x) => x.name), "/parameters", "parameter", problems);

  /** Step id → its operation and outputs, once the step has been checked. */
  const done = new Map<string, { ship: ShipManifest; op: string; outputs: Map<string, WireValue> }>();
  const allIds = new Set(p.steps.map((s) => s.id));
  /** Steps that failed their own check; wires from them aren't reported again. */
  const failed = new Set<string>();
  const consumed = new Set<string>();

  p.steps.forEach((step, i) => {
    const base = `/steps/${i}`;
    if (done.has(step.id) || p.steps.findIndex((s) => s.id === step.id) !== i) {
      problems.push(error(`${base}/id`, `step id "${step.id}" is used twice`));
      return;
    }
    const [shipId, opName] = step.run.split(".");
    if (p.ships && !(shipId in p.ships)) problems.push(error(`${base}/run`, `ship "${shipId}" isn't listed under ships`));
    const ship = ships.ship(shipId, p.ships?.[shipId]);
    if (!ship) {
      const range = p.ships?.[shipId];
      problems.push(error(`${base}/run`, `needs ship "${shipId}"${range ? ` ${range}` : ""}, which isn't in the library`));
      failed.add(step.id);
      return;
    }
    const op = ship.operations[opName];
    if (!op) {
      problems.push(error(`${base}/run`, `ship "${shipId}" ${ship.version} has no operation "${opName}" (it has: ${Object.keys(ship.operations).join(", ")})`));
      failed.add(step.id);
      return;
    }

    // inputs: every wire resolves, to the right kind, in a readable format
    const ports = new Map((op.inputs ?? []).map((x) => [x.name, x]));
    for (const [port, wire] of Object.entries(step.in ?? {})) {
      const path = `${base}/in/${port}`;
      const spec = ports.get(port);
      if (!spec) {
        problems.push(error(path, `${step.run} has no input "${port}" (it has: ${[...ports.keys()].join(", ") || "none"})`));
        continue;
      }
      const value = resolveWire(wire, inputs, done, allIds, failed, path, problems);
      if (!value) continue;
      if (!wire.startsWith("$")) consumed.add(wire);
      if (value.kind !== spec.kind) {
        problems.push(error(path, `"${port}" needs ${spec.kind}, but ${value.from} is ${value.kind}`));
      } else if (value.formats && !value.formats.some((f) => spec.formats.includes(f))) {
        problems.push(error(path, `"${port}" reads ${spec.formats.join(", ")}, but ${value.from} is ${value.formats.join(", ")}`));
      }
    }
    for (const [name, spec] of ports) {
      if (!spec.optional && !(name in (step.in ?? {}))) problems.push(error(`${base}/in`, `required input "${name}" of ${step.run} isn't connected`));
    }

    // parameters given in the step itself
    const specs = new Map((op.parameters ?? []).map((x) => [x.name, x]));
    for (const [name, v] of Object.entries(step.with ?? {})) {
      const spec = specs.get(name);
      const path = `${base}/with/${name}`;
      if (!spec) problems.push(error(path, `${step.run} has no parameter "${name}"`));
      else {
        const bad = paramValueProblem(spec, v);
        if (bad) problems.push(error(path, `"${name}" ${bad}`));
      }
    }

    done.set(step.id, {
      ship,
      op: opName,
      outputs: new Map(op.outputs.map((o) => [o.name, { kind: o.kind, formats: [o.format], from: `${step.id}.${o.name}` }])),
    });
  });

  // book parameters fill step parameters
  const setBy = new Map<string, string>();
  p.parameters.forEach((param, i) => {
    const targets = Array.isArray(param.sets) ? param.sets : [param.sets];
    for (const target of targets) {
      const path = `/parameters/${i}/sets`;
      const [stepId, name] = target.split(".");
      const step = p.steps.find((s) => s.id === stepId);
      const resolved = done.get(stepId);
      if (!step) {
        problems.push(error(path, `no step "${stepId}"`));
        continue;
      }
      if (!resolved) continue; // the step itself already failed to check
      const spec = resolved.ship.operations[resolved.op].parameters?.find((x) => x.name === name);
      if (!spec) {
        problems.push(error(path, `${step.run} has no parameter "${name}"`));
        continue;
      }
      if (step.with && name in step.with) problems.push(error(path, `"${target}" is also fixed in the step's "with"`));
      if (setBy.has(target)) problems.push(error(path, `"${target}" is already set by parameter "${setBy.get(target)}"`));
      setBy.set(target, param.name);
      const compatible = spec.type === param.type || (spec.type === "number" && param.type === "integer");
      if (!compatible) problems.push(error(path, `"${param.name}" is ${param.type}, but ${target} is ${spec.type}`));
      if (param.type === "enum" && spec.type === "enum") {
        const extra = (param.options ?? []).filter((o) => !(spec.options ?? []).includes(o));
        if (extra.length) problems.push(error(path, `${target} doesn't accept ${extra.join(", ")}`));
      }
      const bad = param.default === undefined ? null : paramValueProblem(spec, param.default);
      if (bad) problems.push(error(`/parameters/${i}/default`, `default for ${target} ${bad}`));
    }
  });

  // step parameters that nothing gives a value
  p.steps.forEach((step, i) => {
    const resolved = done.get(step.id);
    if (!resolved) return;
    for (const spec of resolved.ship.operations[resolved.op].parameters ?? []) {
      const given = spec.default !== undefined || (step.with && spec.name in step.with) || setBy.has(`${step.id}.${spec.name}`);
      if (!given) problems.push(error(`/steps/${i}`, `parameter "${spec.name}" of ${step.run} has no default and nothing sets it`));
    }
  });

  // outputs
  for (const [name, ref] of Object.entries(p.outputs)) {
    const value = resolveWire(ref, inputs, done, allIds, failed, `/outputs/${name}`, problems);
    if (value) consumed.add(ref);
  }
  p.steps.forEach((step, i) => {
    const resolved = done.get(step.id);
    if (resolved && ![...resolved.outputs.keys()].some((o) => consumed.has(`${step.id}.${o}`))) {
      problems.push(warning(`/steps/${i}`, `nothing uses the outputs of step "${step.id}"`));
    }
  });
  return problems;
}

function resolveWire(
  wire: string,
  inputs: Map<string, PipelineInput>,
  done: Map<string, { outputs: Map<string, WireValue> }>,
  allIds: Set<string>,
  failed: Set<string>,
  path: string,
  problems: ManifestProblem[],
): WireValue | undefined {
  if (wire.startsWith("$")) {
    const input = inputs.get(wire.slice(1));
    if (!input) problems.push(error(path, `no input "${wire.slice(1)}" (inputs: ${[...inputs.keys()].join(", ") || "none"})`));
    return input && { kind: input.kind, formats: input.formats, from: wire };
  }
  const [stepId, out] = wire.split(".");
  if (failed.has(stepId)) return undefined;
  const step = done.get(stepId);
  if (!step) {
    problems.push(error(path, allIds.has(stepId) ? `step "${stepId}" runs later; a step can only use earlier steps' outputs` : `no step "${stepId}"`));
    return undefined;
  }
  const value = step.outputs.get(out);
  if (!value) problems.push(error(path, `step "${stepId}" has no output "${out}" (it has: ${[...step.outputs.keys()].join(", ")})`));
  return value;
}

function dupes(names: string[], path: string, what: string, problems: ManifestProblem[]) {
  const seen = new Set<string>();
  for (const n of names) {
    if (seen.has(n)) problems.push(error(path, `${what} "${n}" is declared twice`));
    seen.add(n);
  }
}
