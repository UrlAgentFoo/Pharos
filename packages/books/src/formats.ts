/**
 * Which file formats a book accepts, derived rather than written by hand:
 * the formats its first steps read directly, plus any format a converter
 * ship can turn into one of those. Authors only write the constraints that
 * matter (`axes`, `channels`, …).
 *
 * A converter is any ship operation named `convert` with one input and one
 * output of the same kind, such as `bio-utils.convert`.
 */
import type { ArtifactKind, BookManifest, Format, ShipManifest } from "@pharos/contracts";
import type { ShipLookup } from "./check.js";

export interface Converter {
  /** `<ship>.convert` */
  id: string;
  kind: ArtifactKind;
  from: Format[];
  to: Format;
}

export interface AcceptedFormats {
  input: string;
  kind: ArtifactKind;
  /** Read directly by every step the input feeds. */
  direct: Format[];
  /** Readable after one conversion step. */
  converted: { format: Format; via: string }[];
}

export function converters(ships: Iterable<ShipManifest>): Converter[] {
  const out: Converter[] = [];
  for (const ship of ships) {
    const op = ship.operations.convert;
    if (!op || op.inputs?.length !== 1 || op.outputs.length !== 1) continue;
    const [i, o] = [op.inputs[0], op.outputs[0]];
    if (i.kind === o.kind) out.push({ id: `${ship.id}.convert`, kind: i.kind, from: i.formats, to: o.format });
  }
  return out;
}

export function acceptedFormats(book: BookManifest, ships: ShipLookup, available: Converter[]): AcceptedFormats[] {
  return (book.inputs ?? []).map((input) => {
    // formats every port this input feeds can read
    let direct: Format[] | undefined;
    for (const step of book.steps) {
      const ship = ships.ship(step.run.split(".")[0], book.ships[step.run.split(".")[0]]);
      const op = ship?.operations[step.run.split(".")[1]];
      for (const [port, wire] of Object.entries(step.in ?? {})) {
        if (wire !== `$${input.name}`) continue;
        const formats = op?.inputs?.find((x) => x.name === port)?.formats ?? [];
        direct = direct ? direct.filter((f) => formats.includes(f)) : [...formats];
      }
    }
    if (input.accepts.formats) direct = direct ? direct.filter((f) => input.accepts.formats!.includes(f)) : input.accepts.formats;
    direct ??= [];
    const converted: AcceptedFormats["converted"] = [];
    for (const c of available) {
      if (c.kind !== input.accepts.kind || !direct.includes(c.to)) continue;
      for (const f of c.from) if (!direct.includes(f) && !converted.some((x) => x.format === f)) converted.push({ format: f, via: c.id });
    }
    return { input: input.name, kind: input.accepts.kind, direct, converted };
  });
}
