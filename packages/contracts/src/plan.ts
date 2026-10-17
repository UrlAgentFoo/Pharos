/**
 * Plans: a pipeline proposed from a book, or chained by the assistant from
 * book actions and ship operations.
 * Nothing runs until the user approves one.
 */
import { type Static, Type } from "@sinclair/typebox";
import { StepSchema } from "./book.js";
import { ParamsSchema } from "./params.js";
import { IdSchema, NAME_PATTERN, VersionSchema } from "./vocabulary.js";

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

/**
 * One link of a chain the assistant proposed: a book action or a ship
 * operation, the steps it became, and why it's there. Each link runs as its
 * own run in the window, carrying its why.
 */
export const PlanLinkSchema = Type.Object(
  {
    id: Type.String({ pattern: NAME_PATTERN }),
    title: Type.String(),
    book: Type.Optional(Type.Object({ id: IdSchema, version: VersionSchema, action: Type.String({ pattern: NAME_PATTERN }) }, { additionalProperties: false })),
    run: Type.Optional(Type.String({ description: "<ship>.<operation>, for a link that runs one operation." })),
    why: Type.Optional(Type.String({ description: "The assistant's reason for this link, for the user." })),
    steps: Type.Array(Type.String({ pattern: NAME_PATTERN }), { minItems: 1, description: "The ids of the plan's steps this link became, in order." }),
  },
  { additionalProperties: false },
);
export type PlanLink = Static<typeof PlanLinkSchema>;

export const PlanSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    workspace: Type.String({ description: "Where the inputs come from and the outputs go." }),
    source: Type.Union([Type.Literal("book"), Type.Literal("improvised")]),
    book: Type.Optional(
      Type.Object({ id: IdSchema, version: VersionSchema, action: Type.String({ pattern: NAME_PATTERN, description: "Which of the book's actions." }) }, { additionalProperties: false }),
    ),
    title: Type.String(),
    rationale: Type.Optional(Type.String({ description: "The assistant's short explanation of its choice." })),
    inputs: Type.Record(Type.String(), Type.String(), { description: "Action input name → artifact id." }),
    parameters: ParamsSchema,
    steps: Type.Array(StepSchema, { minItems: 1 }),
    /** For a chain: its links, which together hold every step. */
    links: Type.Optional(Type.Array(PlanLinkSchema)),
    ships: Type.Array(ShipNeedSchema),
    problems: Type.Array(PlanProblemSchema, { description: "Validation results; a plan with errors cannot be approved." }),
    status: Type.Union(PLAN_STATUSES.map((s) => Type.Literal(s))),
    /** Step id → job id, once approved. */
    jobs: Type.Optional(Type.Record(Type.String(), Type.String())),
    /** Action output name → artifact id, once done. */
    outputs: Type.Optional(Type.Record(Type.String(), Type.String())),
    error: Type.Optional(Type.String()),
    createdAt: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false, $id: "plan.schema.json", title: "Pharos plan" },
);
export type Plan = Static<typeof PlanSchema>;
