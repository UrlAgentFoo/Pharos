/**
 * `book.yaml`: an app for one domain ("Fluid flow", "Cell tracking"). It
 * names the ships it needs and the actions it offers; each action is a
 * pipeline of ship operations with the data it accepts and the parameters
 * people see. Its `GUIDE.md` (not described here) tells the assistant when
 * to use it.
 *
 * People see a book's title, `how_to_use`, its actions' titles, the file
 * types it accepts and its ships; everything else is for Pharos and the
 * assistant.
 *
 * Step wiring, within an action: `in` values are `$<action input>` or
 * `<step id>.<output name>`; outputs are `<step id>.<output name>`. A
 * parameter's `sets` names the `<step id>.<parameter>` it fills.
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

/** One thing a book does: a pipeline with its own inputs, parameters and outputs. */
export const BookActionSchema = Type.Object(
  {
    title: Type.String({ minLength: 1, description: "What it does, as a button or menu item: \"Simulate the flow\"." }),
    summary: Type.Optional(Type.String({ description: "One sentence more, for the assistant and tooltips." })),
    inputs: Type.Optional(Type.Array(BookInputSchema, { description: "Empty for actions that start from parameters alone." })),
    parameters: Type.Optional(Type.Array(BookParamSchema)),
    steps: Type.Array(StepSchema, { minItems: 1 }),
    outputs: KeyedMap(Type.String({ pattern: NAME_PATTERN }), Type.String({ pattern: STEP_PARAM_PATTERN }), { minProperties: 1 }),
  },
  { additionalProperties: false },
);
export type BookAction = Static<typeof BookActionSchema>;

export const BookManifestSchema = Type.Object(
  {
    id: IdSchema,
    version: VersionSchema,
    title: Type.String({ minLength: 1, description: "The domain, as people name it: \"Fluid flow\"." }),
    summary: Type.String({ minLength: 1, description: "One or two sentences, searched and read by the assistant." }),
    how_to_use: Type.Optional(Type.String({ minLength: 1, description: "Two or three plain sentences shown on the book's card; the summary when absent." })),
    tags: Type.Optional(Type.Array(Type.String())),
    authors: Type.Optional(Type.Array(Type.String())),
    citation: Type.Optional(Type.String()),
    ships: KeyedMap(IdSchema, VersionRangeSchema, { minProperties: 1, description: "Ship id → tested version range." }),
    actions: KeyedMap(Type.String({ pattern: NAME_PATTERN }), BookActionSchema, {
      minProperties: 1,
      description: "Action name (lowercase_snake) → what it does; the first is the book's main action.",
    }),
  },
  { additionalProperties: false, $id: "book.schema.json", title: "Pharos book" },
);
export type BookManifest = Static<typeof BookManifestSchema>;

/** A book's action by name (the first when no name is given), with its name. */
export function bookAction(book: Pick<BookManifest, "actions">, name?: string): (BookAction & { name: string }) | undefined {
  const key = name ?? Object.keys(book.actions)[0];
  const action = key !== undefined ? book.actions[key] : undefined;
  return action && { ...action, name: key! };
}
