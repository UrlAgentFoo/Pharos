/**
 * `ship.yaml`: a container image plus the typed operations it exposes.
 *
 * In CLI mode (the default) each operation is a command that reads its
 * inputs from `/in`, writes its outputs to `/out` and exits, printing
 * progress as JSON lines (see `ProgressLine`). Warm ships run the same
 * commands inside a container that stays up between operations. Field names follow Boutiques
 * where they overlap.
 */
import { type Static, Type } from "@sinclair/typebox";
import { ParamSpecSchema } from "./params.js";
import { ArtifactKindSchema, FORMAT_PATTERN, FormatInfoSchema, FormatSchema, IdSchema, KeyedMap, NameSchema, OPERATION_PATTERN, VersionSchema } from "./vocabulary.js";

export const ShipInputSchema = Type.Object(
  {
    name: NameSchema,
    kind: ArtifactKindSchema,
    formats: Type.Array(FormatSchema, { minItems: 1, description: "Formats the operation reads directly." }),
    optional: Type.Optional(Type.Boolean()),
    needs: Type.Optional(
      Type.Array(Type.Literal("solved"), {
        minItems: 1,
        description: "What the data must already be, beyond its kind: solved = a simulation case that has been run (has results).",
      }),
    ),
    description: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type ShipInput = Static<typeof ShipInputSchema>;

export const ShipOutputSchema = Type.Object(
  {
    name: NameSchema,
    kind: ArtifactKindSchema,
    format: FormatSchema,
    path: Type.String({ pattern: "^/out/", description: "Where the operation writes this output, under /out." }),
    description: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type ShipOutput = Static<typeof ShipOutputSchema>;

export const OperationSchema = Type.Object(
  {
    summary: Type.String({ minLength: 1, description: "One sentence: what the operation does. Searched and shown to the assistant." }),
    command: Type.String({
      minLength: 1,
      description: "Command template. `{param}` is replaced by a parameter's value; inputs are mounted at /in/<name>.",
    }),
    inputs: Type.Optional(Type.Array(ShipInputSchema, { description: "Empty for operations that start from parameters alone." })),
    parameters: Type.Optional(Type.Array(ParamSpecSchema)),
    outputs: Type.Array(ShipOutputSchema, { minItems: 1 }),
    cache: Type.Optional(
      Type.Object(
        { deterministic: Type.Boolean({ description: "Same inputs and parameters always give the same outputs, so results can be cached." }) },
        { additionalProperties: false },
      ),
    ),
    edam: Type.Optional(Type.String({ pattern: "^operation_\\d+$", description: "EDAM operation term." })),
    view: Type.Optional(
      Type.Boolean({
        description:
          "Shows data rather than changing it: one input, and one output Pharos can display (an image, table, video, 3D model or web page). Windows offer it for data Pharos can't show itself; it doesn't enter the history.",
      }),
    ),
  },
  { additionalProperties: false },
);
export type Operation = Static<typeof OperationSchema>;

export const RequirementsSchema = Type.Object(
  {
    gpu: Type.Optional(
      Type.Object(
        {
          vendor: Type.Literal("nvidia"),
          optional: Type.Boolean({ description: "true: runs on CPU too, only slower." }),
        },
        { additionalProperties: false },
      ),
    ),
    memory_gb: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    disk_gb: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    network: Type.Optional(
      Type.Union([Type.Literal("none"), Type.Literal("download")], { description: "none (default): no network while running." }),
    ),
  },
  { additionalProperties: false },
);
export type Requirements = Static<typeof RequirementsSchema>;

export const ShipManifestSchema = Type.Object(
  {
    id: IdSchema,
    version: VersionSchema,
    image: Type.String({ minLength: 1, description: "Container image, pinned by digest (name@sha256:…) for verified ships." }),
    mode: Type.Optional(
      Type.Union([Type.Literal("cli"), Type.Literal("warm")], {
        description:
          "cli (default): a fresh container per operation. warm: one container per workspace stays up between operations, so they start at once; inputs still appear at /in, outputs go to /out.",
      }),
    ),
    warm: Type.Optional(
      Type.Object(
        {
          start: Type.Optional(
            Type.String({ description: "Runs when the warm container starts and keeps running, e.g. a server that loads a model once; operations can talk to it inside the container." }),
          ),
          idle_minutes: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "Stop the container after this long without operations (default 10)." })),
        },
        { additionalProperties: false },
      ),
    ),
    summary: Type.Optional(Type.String()),
    citation: Type.Optional(Type.String()),
    license: Type.Optional(Type.String({ description: "SPDX licence id of the tool, e.g. GPL-3.0-only." })),
    homepage: Type.Optional(Type.String()),
    tags: Type.Optional(Type.Array(Type.String())),
    requires: Type.Optional(RequirementsSchema),
    formats: Type.Optional(
      KeyedMap(Type.String({ pattern: FORMAT_PATTERN }), FormatInfoSchema, {
        description: "File formats this ship brings that Pharos doesn't know yet: how to recognise them and what kind of data they hold.",
      }),
    ),
    operations: KeyedMap(Type.String({ pattern: OPERATION_PATTERN }), OperationSchema, { minProperties: 1 }),
  },
  { additionalProperties: false, $id: "ship.schema.json", title: "Pharos ship" },
);
export type ShipManifest = Static<typeof ShipManifestSchema>;

/** One line an operation may print to stdout to report progress. */
export const ProgressLineSchema = Type.Object({
  progress: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  message: Type.Optional(Type.String()),
});
export type ProgressLine = Static<typeof ProgressLineSchema>;
