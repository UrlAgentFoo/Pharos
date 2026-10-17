/**
 * The shared vocabulary: artifact kinds, file formats, trust levels and the
 * identifiers ships, books and operations use. Hand-written books and
 * imported tools are matched with these same words.
 */
import { type ObjectOptions, type TSchema, type TString, Type } from "@sinclair/typebox";

/** What an artifact is, independent of how it is stored. */
export const ARTIFACT_KINDS = ["volume", "labels", "tracks", "table", "mesh", "splat", "sim-case", "video"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
export const ArtifactKindSchema = Type.Union(ARTIFACT_KINDS.map((k) => Type.Literal(k)));

/** How an artifact is stored on disk. Artifacts are always file-backed. */
export const FORMATS = [
  "ome-zarr",
  "ome-tiff",
  "tiff",
  "czi",
  "nd2",
  "lif",
  "csv",
  "parquet",
  "json",
  "ply",
  "vtk",
  "mp4",
  "openfoam-case",
  "geff",
] as const;
export type Format = (typeof FORMATS)[number];
export const FormatSchema = Type.Union(FORMATS.map((f) => Type.Literal(f)));

/**
 * EDAM terms (https://edamontology.org) for the kinds and formats above, so
 * imported tools, which bio.tools describes in EDAM, match the same
 * vocabulary. Only terms that have been checked against EDAM are listed;
 * add the rest as they are confirmed.
 */
export const EDAM_KINDS: Partial<Record<ArtifactKind, string>> = {
  volume: "data_2968", // Image
};
export const EDAM_FORMATS: Partial<Record<Format, string>> = {
  tiff: "format_3591",
  "ome-tiff": "format_3727",
  csv: "format_3752",
};

/**
 * How far a ship or book can be trusted. Only verified ships run in the
 * demo books; imported ones are searchable but clearly marked.
 */
export const TRUST_LEVELS = ["verified", "verifying", "imported"] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];
export const TrustLevelSchema = Type.Union(TRUST_LEVELS.map((t) => Type.Literal(t)));

/** Ship and book ids: lowercase words joined by hyphens, e.g. `bio-utils`. */
export const ID_PATTERN = "^[a-z0-9][a-z0-9-]*$";
/** Operation names inside a ship, e.g. `segment`, `export-vtk`. */
export const OPERATION_PATTERN = "^[a-z][a-z0-9-]*$";
/** A ship operation as books refer to it: `<ship>.<operation>`. */
export const OPERATION_REF_PATTERN = "^[a-z0-9][a-z0-9-]*\\.[a-z][a-z0-9-]*$";
/** Input, output, parameter and step names. */
export const NAME_PATTERN = "^[a-z][a-z0-9_]*$";
/** A semantic version, e.g. `0.1.0` or `1.2.0-beta.1`. */
export const VERSION_PATTERN = "^\\d+\\.\\d+\\.\\d+(-[0-9A-Za-z.-]+)?$";

export const IdSchema = Type.String({ pattern: ID_PATTERN });
export const NameSchema = Type.String({ pattern: NAME_PATTERN });
export const VersionSchema = Type.String({ pattern: VERSION_PATTERN });
/** An npm-style version range, e.g. `^0.1`, `~1.2.0` or `0.6.1`. */
export const VersionRangeSchema = Type.String({ minLength: 1 });

/**
 * A map whose keys must match `key` (e.g. operation names). TypeBox records
 * accept any other key unless additionalProperties is closed, so always
 * build pattern-keyed maps with this.
 */
export const KeyedMap = <V extends TSchema>(key: TString, value: V, options: ObjectOptions = {}) =>
  Type.Record(key, value, { ...options, additionalProperties: false });
