/**
 * Schema validation for manifests and plans. These check shape only; the
 * books package checks wiring (step references, kinds matching) on top.
 */
import type { Static, TSchema } from "@sinclair/typebox";
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { BookManifestSchema } from "./book.js";
import { PlanSchema } from "./plan.js";
import { ShipManifestSchema } from "./ship.js";

export interface SchemaProblem {
  /** JSON pointer to the offending value, e.g. /operations/segment/outputs/0/path. */
  path: string;
  message: string;
}

export type Validation<T> = { ok: true; value: T } | { ok: false; problems: SchemaProblem[] };

// `date-time` is only checked by the type; Ajv's format plugin isn't needed.
const ajv = new Ajv({ allErrors: true, strict: true, verbose: true, formats: { "date-time": true } });

function problems(errors: ErrorObject[] | null | undefined): SchemaProblem[] {
  return (errors ?? []).map((e) => {
    let message = e.message ?? "is invalid";
    if (e.keyword === "additionalProperties") {
      const key = (e.params as { additionalProperty: string }).additionalProperty;
      const keyed = !!(e.parentSchema as { patternProperties?: object } | undefined)?.patternProperties;
      message = keyed ? `"${key}" is not a valid name here` : `unknown field "${key}"`;
    }
    if (e.keyword === "enum" || e.keyword === "const") message = `must be one of: ${[(e.params as { allowedValues?: unknown[] }).allowedValues ?? (e.params as { allowedValue: unknown }).allowedValue].flat().join(", ")}`;
    return { path: e.instancePath || "/", message };
  });
}

function validator<S extends TSchema>(schema: S): (value: unknown) => Validation<Static<S>> {
  let compiled: ValidateFunction | undefined;
  return (value) => {
    compiled ??= ajv.compile(schema);
    return compiled(value) ? { ok: true, value: value as Static<S> } : { ok: false, problems: problems(compiled.errors) };
  };
}

export const validateShip = validator(ShipManifestSchema);
export const validateBook = validator(BookManifestSchema);
export const validatePlan = validator(PlanSchema);

/** The schemas published as JSON files, for editors and tools outside TypeScript. */
export const PUBLISHED_SCHEMAS = {
  "ship.schema.json": ShipManifestSchema,
  "book.schema.json": BookManifestSchema,
  "plan.schema.json": PlanSchema,
} as const;
