/**
 * Plans: a pipeline proposed from a book or improvised by the assistant.
 * Nothing runs until the user approves one.
 */
import { type Static, Type } from "@sinclair/typebox";
import { StepSchema } from "./book.js";
import { ParamsSchema } from "./params.js";
import { IdSchema, VersionSchema } from "./vocabulary.js";

export const PLAN_STATUSES = ["proposed", "approved", "running", "done", "failed", "cancelled"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

/** A ship a plan needs, and whether it is already on this machine. */
export const ShipNeedSchema = Type.Object(
  {
    id: IdSchema,
    version: VersionSchema,
    image: Type.String(),
    downloaded: Type.Boolean(),
    sizeBytes: Type.Optional(Type.Integer({ minimum: 0, description: "Download size; unknown until the registry is asked." })),
    gpu: Type.Union([Type.Literal("required"), Type.Literal("optional"), Type.Literal("none")]),
  },
  { additionalProperties: false },
);
export type ShipNeed = Static<typeof ShipNeedSchema>;

export const PlanProblemSchema = Type.Object(
  {
    path: Type.String({ description: "Where the problem is, e.g. steps/2/in/labels." }),
    message: Type.String(),
    severity: Type.Union([Type.Literal("error"), Type.Literal("warning")]),
  },
  { additionalProperties: false },
);
export type PlanProblem = Static<typeof PlanProblemSchema>;

export const PlanSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    source: Type.Union([Type.Literal("book"), Type.Literal("improvised")]),
    book: Type.Optional(Type.Object({ id: IdSchema, version: VersionSchema }, { additionalProperties: false })),
    title: Type.String(),
    rationale: Type.Optional(Type.String({ description: "The assistant's short explanation of its choice." })),
    inputs: Type.Record(Type.String(), Type.String(), { description: "Book input name → artifact id." }),
    parameters: ParamsSchema,
    steps: Type.Array(StepSchema, { minItems: 1 }),
    ships: Type.Array(ShipNeedSchema),
    problems: Type.Array(PlanProblemSchema, { description: "Validation results; a plan with errors cannot be approved." }),
    status: Type.Union(PLAN_STATUSES.map((s) => Type.Literal(s))),
    createdAt: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false, $id: "plan.schema.json", title: "Pharos plan" },
);
export type Plan = Static<typeof PlanSchema>;
