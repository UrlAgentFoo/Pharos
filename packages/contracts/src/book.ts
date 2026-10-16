/**
 * `book.yaml`: a recipe. The ships it needs, the steps that connect them,
 * the parameters users see, and what data it accepts. Its `GUIDE.md` (not
 * described here) tells the assistant when to use it.
 *
 * Step wiring: `in` values are `$<book input>` or `<step id>.<output name>`;
 * book outputs are `<step id>.<output name>`. A book parameter's `sets`
 * names the `<step id>.<parameter>` it fills.
 */
import { type Static, Type } from "@sinclair/typebox";
import { ParamValueSchema, paramProperties } from "./params.js";
import {
  ArtifactKindSchema,
  FormatSchema,
  IdSchema,
  KeyedMap,
  NAME_PATTERN,
  NameSchema,
  OPERATION_REF_PATTERN,
  VersionRangeSchema,
  VersionSchema,
} from "./vocabulary.js";

/** `$input` or `step.output`. */
export const WIRE_PATTERN = "^(\\$[a-z][a-z0-9_]*|[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*)$";
/** `step.parameter`. */
export const STEP_PARAM_PATTERN = "^[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*$";

export const AcceptsSchema = Type.Object(
  {
    kind: ArtifactKindSchema,
    formats: Type.Optional(
      Type.Array(FormatSchema, { minItems: 1, description: "Formats read directly; converter ships widen this automatically." }),
    ),
    axes: Type.Optional(Type.String({ pattern: "^[tczyx]+$", description: "Axes the data must have, e.g. tzyx for 3D + time." })),
    channels: Type.Optional(
      Type.Union([Type.Integer({ minimum: 1 }), Type.String({ pattern: "^\\d+(-\\d+)?$" })], { description: "A count, or a range like 1-4." }),
    ),
    dtype: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
    max_size_gb: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    edam: Type.Optional(Type.String({ pattern: "^data_\\d+$", description: "EDAM data term." })),
  },
  { additionalProperties: false },
);
export type Accepts = Static<typeof AcceptsSchema>;

export const BookInputSchema = Type.Object(
  {
    name: NameSchema,
    description: Type.Optional(Type.String()),
    accepts: AcceptsSchema,
  },
  { additionalProperties: false },
);
export type BookInput = Static<typeof BookInputSchema>;

export const BookParamSchema = Type.Object(
  {
    ...paramProperties,
    sets: Type.Union([
      Type.String({ pattern: STEP_PARAM_PATTERN }),
      Type.Array(Type.String({ pattern: STEP_PARAM_PATTERN }), { minItems: 1 }),
    ]),
  },
  { additionalProperties: false },
);
export type BookParam = Static<typeof BookParamSchema>;

export const StepSchema = Type.Object(
  {
    id: NameSchema,
    run: Type.String({ pattern: OPERATION_REF_PATTERN, description: "<ship>.<operation>" }),
    in: Type.Optional(KeyedMap(Type.String({ pattern: NAME_PATTERN }), Type.String({ pattern: WIRE_PATTERN }))),
    with: Type.Optional(KeyedMap(Type.String({ pattern: NAME_PATTERN }), ParamValueSchema)),
  },
  { additionalProperties: false },
);
export type Step = Static<typeof StepSchema>;

export const BookManifestSchema = Type.Object(
  {
    id: IdSchema,
    version: VersionSchema,
    title: Type.String({ minLength: 1 }),
    summary: Type.String({ minLength: 1 }),
    tags: Type.Optional(Type.Array(Type.String())),
    authors: Type.Optional(Type.Array(Type.String())),
    citation: Type.Optional(Type.String()),
    ships: KeyedMap(IdSchema, VersionRangeSchema, { minProperties: 1, description: "Ship id → tested version range." }),
    inputs: Type.Optional(Type.Array(BookInputSchema, { description: "Empty for books that start from parameters alone." })),
    parameters: Type.Optional(Type.Array(BookParamSchema)),
    steps: Type.Array(StepSchema, { minItems: 1 }),
    outputs: KeyedMap(Type.String({ pattern: NAME_PATTERN }), Type.String({ pattern: STEP_PARAM_PATTERN }), { minProperties: 1 }),
  },
  { additionalProperties: false, $id: "book.schema.json", title: "Pharos book" },
);
export type BookManifest = Static<typeof BookManifestSchema>;
