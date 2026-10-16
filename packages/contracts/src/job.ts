/**
 * Jobs (one ship operation queued or running) and runs (the record a
 * finished job leaves in `runs/<id>/`, so every artifact traces back to
 * the run that made it).
 */
import { type Static, Type } from "@sinclair/typebox";
import { ParamsSchema } from "./params.js";
import { IdSchema, VersionSchema } from "./vocabulary.js";

export const JOB_STATES = ["queued", "downloading", "running", "done", "failed", "cancelled"] as const;
export type JobState = (typeof JOB_STATES)[number];
export const FINISHED_JOB_STATES: readonly JobState[] = ["done", "failed", "cancelled"];

export const JobSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    planId: Type.Optional(Type.String()),
    stepId: Type.Optional(Type.String()),
    ship: IdSchema,
    version: VersionSchema,
    operation: Type.String(),
    state: Type.Union(JOB_STATES.map((s) => Type.Literal(s))),
    progress: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    message: Type.Optional(Type.String()),
    gpu: Type.Boolean({ description: "Runs in the single GPU slot." }),
    cached: Type.Optional(Type.Boolean({ description: "Outputs came from the cache; nothing ran." })),
    error: Type.Optional(Type.String()),
    outputs: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Output name → artifact id." })),
    runId: Type.Optional(Type.String()),
    createdAt: Type.String({ format: "date-time" }),
    startedAt: Type.Optional(Type.String({ format: "date-time" })),
    finishedAt: Type.Optional(Type.String({ format: "date-time" })),
  },
  { additionalProperties: false },
);
export type Job = Static<typeof JobSchema>;

export const RunRecordSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    jobId: Type.String(),
    book: Type.Optional(Type.Object({ id: IdSchema, version: VersionSchema }, { additionalProperties: false })),
    stepId: Type.Optional(Type.String()),
    ship: Type.Object({ id: IdSchema, version: VersionSchema, imageDigest: Type.String() }, { additionalProperties: false }),
    operation: Type.String(),
    params: ParamsSchema,
    inputs: Type.Record(Type.String(), Type.String(), { description: "Input name → artifact id." }),
    outputs: Type.Record(Type.String(), Type.String(), { description: "Output name → artifact id." }),
    cacheKey: Type.String(),
    cached: Type.Boolean(),
    exitCode: Type.Optional(Type.Integer()),
    logFile: Type.String({ description: "Path of the combined stdout/stderr log, relative to the run folder." }),
    startedAt: Type.String({ format: "date-time" }),
    finishedAt: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);
export type RunRecord = Static<typeof RunRecordSchema>;

/**
 * Everything a cache key is computed from: same image, operation,
 * parameters and input content means the stored outputs are reused, even
 * across books. Hash the canonical (sorted-key) JSON of this.
 */
export interface CacheKeyInput {
  imageDigest: string;
  operation: string;
  params: Record<string, number | string | boolean>;
  /** Input name → sha256 of its content. */
  inputHashes: Record<string, string>;
}
