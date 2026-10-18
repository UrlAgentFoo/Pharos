/**
 * Parameters, as ships and books declare them. The UI generates dialogs
 * from these, and the assistant fills them from the data summary.
 */
import { type Static, Type } from "@sinclair/typebox";
import { NameSchema } from "./vocabulary.js";

export const ParamValueSchema = Type.Union([Type.Number(), Type.String(), Type.Boolean()]);
export type ParamValue = Static<typeof ParamValueSchema>;
export const ParamsSchema = Type.Record(Type.String(), ParamValueSchema);
export type Params = Static<typeof ParamsSchema>;

export const PARAM_TYPES = ["number", "integer", "string", "boolean", "enum"] as const;

/** Fields shared by ship and book parameters. */
export const paramProperties = {
  name: NameSchema,
  type: Type.Union(PARAM_TYPES.map((t) => Type.Literal(t))),
  label: Type.Optional(Type.String({ description: "Dialog label; defaults to the name." })),
  description: Type.Optional(Type.String({ description: "One sentence for the dialog tooltip and the assistant." })),
  default: Type.Optional(ParamValueSchema),
  options: Type.Optional(Type.Array(Type.String(), { minItems: 1, description: "Allowed values (enum only)." })),
  min: Type.Optional(Type.Number()),
  max: Type.Optional(Type.Number()),
  unit: Type.Optional(Type.String({ description: "e.g. px, µm, s, m/s" })),
};

export const ParamSpecSchema = Type.Object(paramProperties, { additionalProperties: false });
export type ParamSpec = Static<typeof ParamSpecSchema>;
