/**
 * Chains: what the assistant proposes when no single book action does what
 * was asked. Each link is a book action or one ship operation, wired to the
 * plan's inputs ("$<input>") or to an earlier link's output ("<link>.<output>",
 * a book action's outputs by their names in the book). A chain expands into
 * plain steps, which the pipeline check then type-checks like any plan; the
 * links stay with the plan so each runs as its own run, with its why.
 */
import { type BookManifest, type Params, type PlanLink, type ShipManifest, type Step, bookAction } from "@pharos/contracts";
import { stepParams } from "./plan.js";

/** A link as the assistant proposes it. */
export interface ChainLinkSpec {
  id: string;
  /** A book action: the book's id and the action's name. */
  book?: string;
  action?: string;
  /** Or one operation: "<ship>.<operation>". */
  run?: string;
  in?: Record<string, string>;
  /** The book action's parameters, or the operation's. */
  parameters?: Params;
  why?: string;
}

export interface ChainLookup {
  book(id: string): { manifest?: BookManifest } | undefined;
  ship(id: string): ShipManifest | undefined;
}

/** Why a chain can't be expanded, in words the assistant can act on. */
export class ChainError extends Error {}

const ID = /^[a-z][a-z0-9_]*$/;

/**
 * The steps a chain becomes: a book link's steps renamed "<link>_<step>" and
 * wired through, an operation link as one step named after the link.
 */
export function expandChain(links: ChainLinkSpec[], lookup: ChainLookup): { steps: Step[]; links: PlanLink[] } {
  if (!links.length) throw new ChainError("the chain has no links");
  const steps: Step[] = [];
  const out: PlanLink[] = [];
  // each earlier link's outputs, by the names later links use, as the step wires that make them
  const made = new Map<string, Map<string, string>>();
  const resolve = (link: string, port: string, wire: string): string => {
    if (wire.startsWith("$")) return wire;
    const [from, output] = wire.split(".");
    const outputs = made.get(from);
    if (!outputs) throw new ChainError(`link "${link}" takes "${port}" from "${wire}", but no earlier link is called "${from}" (links run in order: ${[...made.keys()].join(", ") || "none before it"})`);
    const target = outputs.get(output);
    if (!target) throw new ChainError(`link "${link}" takes "${port}" from "${wire}", but "${from}" makes ${[...outputs.keys()].map((o) => `"${o}"`).join(", ")}`);
    return target;
  };
  for (const link of links) {
    if (!ID.test(link.id)) throw new ChainError(`"${link.id}" isn't a link id: use lowercase_snake`);
    if (made.has(link.id)) throw new ChainError(`two links are called "${link.id}"`);
    const wires = link.in ?? {};
    if (link.book) {
      const book = lookup.book(link.book)?.manifest;
      if (!book) throw new ChainError(`link "${link.id}": no book "${link.book}" in the library`);
      const action = bookAction(book, link.action);
      if (!action) throw new ChainError(`link "${link.id}": "${book.title}" has no action "${link.action}" (it has: ${Object.keys(book.actions).join(", ")})`);
      const values = { ...Object.fromEntries((action.parameters ?? []).flatMap((p) => (p.default === undefined ? [] : [[p.name, p.default]]))), ...(link.parameters ?? {}) };
      const unknown = Object.keys(wires).filter((port) => !(action.inputs ?? []).some((i) => i.name === port));
      if (unknown.length) throw new ChainError(`link "${link.id}" (${book.title} › ${action.title}) has no input ${unknown.map((u) => `"${u}"`).join(", ")}; its inputs: ${(action.inputs ?? []).map((i) => i.name).join(", ") || "none"}`);
      const inputs: Record<string, string> = {};
      for (const input of action.inputs ?? []) {
        const wire = wires[input.name];
        if (!wire) throw new ChainError(`link "${link.id}" (${book.title} › ${action.title}) needs its input "${input.name}": wire it to "$<input>" or "<earlier link>.<output>"`);
        inputs[input.name] = resolve(link.id, input.name, wire);
      }
      const rename = (id: string) => `${link.id}_${id}`;
      const ids: string[] = [];
      for (const s of action.steps) {
        const stepWires: Record<string, string> = {};
        for (const [port, w] of Object.entries(s.in ?? {})) {
          stepWires[port] = w.startsWith("$") ? inputs[w.slice(1)] : `${rename(w.split(".")[0])}.${w.split(".")[1]}`;
        }
        const params = stepParams(s, action.parameters ?? [], values);
        steps.push({ id: rename(s.id), run: s.run, in: stepWires, ...(Object.keys(params).length ? { with: params } : {}) });
        ids.push(rename(s.id));
      }
      made.set(link.id, new Map(Object.entries(action.outputs).map(([name, ref]) => [name, `${rename(ref.split(".")[0])}.${ref.split(".")[1]}`])));
      out.push({ id: link.id, title: `${book.title} › ${action.title}`, book: { id: book.id, version: book.version, action: action.name }, ...(link.why ? { why: link.why } : {}), steps: ids });
    } else if (link.run) {
      const [shipId, opName] = link.run.split(".");
      const op = lookup.ship(shipId)?.operations[opName ?? ""];
      if (!op) throw new ChainError(`link "${link.id}": no operation "${link.run}" in the library`);
      const stepWires = Object.fromEntries(Object.entries(wires).map(([port, w]) => [port, resolve(link.id, port, w)]));
      steps.push({ id: link.id, run: link.run, in: stepWires, ...(link.parameters && Object.keys(link.parameters).length ? { with: link.parameters } : {}) });
      made.set(link.id, new Map(op.outputs.map((o) => [o.name, `${link.id}.${o.name}`])));
      const words = opName.replace(/[-_]+/g, " ");
      out.push({ id: link.id, title: words.charAt(0).toUpperCase() + words.slice(1), run: link.run, ...(link.why ? { why: link.why } : {}), steps: [link.id] });
    } else throw new ChainError(`link "${link.id}" runs nothing: give it a book and action, or a run ("<ship>.<operation>")`);
  }
  return { steps, links: out };
}
