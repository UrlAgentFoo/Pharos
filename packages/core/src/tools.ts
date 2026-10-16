/**
 * Tools: one interface for everything Pharos can run, `run(inputs, params,
 * ctx) → outputs`. A built-in tool (a command from the registry) runs
 * in-process on images; a ship tool runs its operation in the ship's
 * container through `ctx.runShip`, which the orchestrator provides.
 *
 * Values passed between tools are either in-memory images or file-backed
 * artifacts; the context converts between them, so a built-in can follow
 * a ship operation and the other way round.
 */
import type { Artifact, ArtifactKind, Format, Operation, ParamSpec as ManifestParam, ShipManifest } from "@pharos/contracts";
import { type Command, type CommandContext, COMMANDS, type Params, parseParams } from "./commands.js";
import type { Image } from "./image.js";

export type ToolValue = Image | Artifact;
export type ToolValues = Record<string, ToolValue>;

export interface ToolPort {
  name: string;
  kind: ArtifactKind;
  /** Formats read directly (inputs) or written (outputs); absent for in-memory images. */
  formats?: Format[];
  optional?: boolean;
}

export type ToolSource = { type: "builtin"; command: string } | { type: "ship"; ship: string; version: string; operation: string };

export interface ToolSpec {
  /** `builtin.<command>` or `<ship>.<operation>`, the id books use. */
  id: string;
  title: string;
  summary: string;
  source: ToolSource;
  inputs: ToolPort[];
  outputs: ToolPort[];
  params: ManifestParam[];
  /** Same inputs and parameters always give the same outputs. */
  deterministic: boolean;
}

export interface ToolContext extends CommandContext {
  /** Reads an artifact into memory; needed when a built-in follows a ship. */
  load?(artifact: Artifact): Promise<Image>;
  /** Writes an image to a file-backed artifact; needed when a ship follows a built-in. */
  store?(image: Image, hint: { kind: ArtifactKind; name: string }): Promise<Artifact>;
  /** Runs a ship operation in its container and returns its output artifacts. */
  runShip?(source: Extract<ToolSource, { type: "ship" }>, inputs: Record<string, Artifact>, params: Params): Promise<Record<string, Artifact>>;
  signal?: AbortSignal;
}

export interface Tool extends ToolSpec {
  run(inputs: ToolValues, params: Params, ctx: ToolContext): Promise<ToolValues>;
}

export const isArtifact = (v: ToolValue): v is Artifact => "uri" in v && "kind" in v;

function missing(tool: string, port: string): never {
  throw new RangeError(`${tool}: missing input "${port}"`);
}

// ------------------------------------------------------------ built-in commands

/** A registry command's parameters, in the manifest shape ships and books use. */
export function commandParamSpecs(cmd: Command): ManifestParam[] {
  return Object.entries(cmd.params).map(([name, p]): ManifestParam => {
    const common = { name, label: p.label, ...(p.description ? { description: p.description } : {}) };
    if (p.type === "number") {
      return { ...common, type: "number", default: p.default, ...(p.min !== undefined ? { min: p.min } : {}), ...(p.max !== undefined ? { max: p.max } : {}), ...(p.unit ? { unit: p.unit } : {}) };
    }
    if (p.type === "choice") return { ...common, type: "enum", default: p.default, options: p.options.map((o) => o.value) };
    return { ...common, type: "boolean", default: p.default };
  });
}

/** Wraps a command as a tool with one `image` input and one `image` output. */
export function builtinTool(cmd: Command): Tool {
  const id = `builtin.${cmd.id}`;
  return {
    id,
    title: cmd.title.replace(/…$/, ""),
    summary: cmd.description,
    source: { type: "builtin", command: cmd.id },
    inputs: [{ name: "image", kind: "volume" }],
    outputs: [{ name: "image", kind: "volume" }],
    params: commandParamSpecs(cmd),
    deterministic: true,
    async run(inputs, params, ctx) {
      const value = inputs.image ?? missing(id, "image");
      let image: Image;
      if (isArtifact(value)) {
        if (!ctx.load) throw new Error(`${id}: cannot read artifact ${value.id} without a loader`);
        image = await ctx.load(value);
      } else image = value;
      return { image: cmd.run(image, parseParams(cmd, params), ctx) };
    },
  };
}

// ------------------------------------------------------------ ship operations

/** One tool per operation a ship declares. */
export function shipTools(ship: ShipManifest): Tool[] {
  return Object.entries(ship.operations).map(([name, op]) => shipTool(ship, name, op));
}

function shipTool(ship: ShipManifest, name: string, op: Operation): Tool {
  const id = `${ship.id}.${name}`;
  const source = { type: "ship", ship: ship.id, version: ship.version, operation: name } as const;
  return {
    id,
    title: `${ship.id} › ${name}`,
    summary: op.summary,
    source,
    inputs: (op.inputs ?? []).map((i) => ({ name: i.name, kind: i.kind, formats: i.formats, ...(i.optional ? { optional: true } : {}) })),
    outputs: op.outputs.map((o) => ({ name: o.name, kind: o.kind, formats: [o.format] })),
    params: op.parameters ?? [],
    deterministic: op.cache?.deterministic ?? false,
    async run(inputs, params, ctx) {
      if (!ctx.runShip) throw new Error(`${id}: ship operations need the local server (Docker)`);
      const artifacts: Record<string, Artifact> = {};
      for (const port of op.inputs ?? []) {
        const value = inputs[port.name];
        if (!value) {
          if (port.optional) continue;
          missing(id, port.name);
        }
        if (isArtifact(value)) artifacts[port.name] = value;
        else if (ctx.store) artifacts[port.name] = await ctx.store(value, { kind: port.kind, name: value.name ?? port.name });
        else throw new Error(`${id}: cannot hand an in-memory image to a ship without a store`);
      }
      return ctx.runShip(source, artifacts, withDefaults(op.parameters ?? [], params));
    },
  };
}

/** Fills defaults and checks types and enum options, so containers never see a malformed value. */
export function withDefaults(specs: ManifestParam[], params: Params): Params {
  const out: Params = {};
  const known = new Set(specs.map((s) => s.name));
  for (const key of Object.keys(params)) if (!known.has(key)) throw new RangeError(`unknown parameter "${key}"`);
  for (const s of specs) {
    const v = params[s.name] ?? s.default;
    if (v === undefined) throw new RangeError(`parameter "${s.name}" is required`);
    const ok =
      s.type === "number" ? typeof v === "number" && Number.isFinite(v)
      : s.type === "integer" ? Number.isInteger(v)
      : s.type === "boolean" ? typeof v === "boolean"
      : s.type === "enum" ? typeof v === "string" && (s.options ?? []).includes(v)
      : typeof v === "string";
    if (!ok) throw new RangeError(`parameter "${s.name}" must be ${s.type === "enum" ? `one of ${(s.options ?? []).join(", ")}` : `a ${s.type}`}`);
    if (typeof v === "number" && ((s.min !== undefined && v < s.min) || (s.max !== undefined && v > s.max))) {
      throw new RangeError(`parameter "${s.name}" must be between ${s.min ?? "-∞"} and ${s.max ?? "∞"}`);
    }
    out[s.name] = v;
  }
  return out;
}

// ------------------------------------------------------------ registry

/** Every tool Pharos knows: the built-ins, plus the operations of each installed ship. */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  constructor(tools: Tool[] = COMMANDS.map(builtinTool)) {
    for (const t of tools) this.add(t);
  }

  add(tool: Tool) {
    if (this.tools.has(tool.id)) throw new Error(`duplicate tool ${tool.id}`);
    this.tools.set(tool.id, tool);
  }

  /** Adds a ship's operations, replacing any earlier version of the same ship. */
  addShip(ship: ShipManifest) {
    for (const [id, t] of this.tools) if (t.source.type === "ship" && t.source.ship === ship.id) this.tools.delete(id);
    for (const t of shipTools(ship)) this.add(t);
  }

  get(id: string): Tool | undefined {
    return this.tools.get(id);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  /** Tools that can take an input of this kind (and format, when it is a file). */
  accepting(kind: ArtifactKind, format?: Format): Tool[] {
    return this.list().filter((t) => t.inputs.some((i) => i.kind === kind && (!format || !i.formats || i.formats.includes(format))));
  }
}
