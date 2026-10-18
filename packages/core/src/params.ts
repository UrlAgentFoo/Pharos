/**
 * Parameter checking for ship operations: fills defaults and checks types,
 * ranges and enum options, so a container never sees a malformed value.
 */
import type { ParamSpec, Params } from "@pharos/contracts";

export function withDefaults(specs: ParamSpec[], params: Params): Params {
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
