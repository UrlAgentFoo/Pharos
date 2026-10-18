/**
 * Artifacts: every piece of data Pharos handles, file-backed on disk. The
 * browser only ever holds views of them.
 */
import { type Static, Type } from "@sinclair/typebox";
import { ArtifactKindSchema, FormatSchema } from "./vocabulary.js";

export const ArtifactSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    kind: ArtifactKindSchema,
    format: FormatSchema,
    uri: Type.String({ minLength: 1, description: "A file or folder on disk (file:// URL or absolute path)." }),
    name: Type.Optional(Type.String()),
    meta: Type.Record(Type.String(), Type.Unknown(), { description: "Format-specific metadata, e.g. a DataSummary." }),
    producedBy: Type.Optional(Type.String({ description: "Id of the run that made it; absent for imported data." })),
    contentHash: Type.Optional(Type.String({ description: "sha256 of the content, used for caching and de-duplication." })),
    sizeBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    createdAt: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);
export type Artifact = Static<typeof ArtifactSchema>;

/**
 * What the data inspector reads from an input's metadata. The assistant
 * sees this, never the pixels.
 */
export const DataSummarySchema = Type.Object(
  {
    kind: ArtifactKindSchema,
    format: FormatSchema,
    name: Type.String(),
    sizeBytes: Type.Integer({ minimum: 0 }),
    axes: Type.Optional(Type.String({ pattern: "^[tczyx]+$" })),
    shape: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { description: "Length per axis, in `axes` order." })),
    dtype: Type.Optional(Type.String()),
    channels: Type.Optional(Type.Integer({ minimum: 1 })),
    timepoints: Type.Optional(Type.Integer({ minimum: 1 })),
    voxelSize: Type.Optional(
      Type.Object({ x: Type.Number(), y: Type.Number(), z: Type.Optional(Type.Number()), unit: Type.String() }, { additionalProperties: false }),
    ),
    frameInterval: Type.Optional(Type.Object({ value: Type.Number(), unit: Type.String() }, { additionalProperties: false })),
    columns: Type.Optional(Type.Array(Type.String(), { description: "Tables only." })),
    rows: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);
export type DataSummary = Static<typeof DataSummarySchema>;
