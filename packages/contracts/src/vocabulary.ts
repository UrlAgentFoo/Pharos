/**
 * The shared vocabulary: artifact kinds, file formats, trust levels and the
 * identifiers ships, books and operations use. Hand-written books and
 * imported tools are matched with these same words.
 */
import { type ObjectOptions, type Static, type TSchema, type TString, Type } from "@sinclair/typebox";

/**
 * What an artifact is, independent of how it is stored. Kinds are open: any
 * lowercase-hyphenated name is valid, so a ship for a new domain (genomics,
 * astronomy, audio) can bring its own. These are the ones Pharos itself
 * knows how to show.
 */
export const ARTIFACT_KINDS = ["volume", "labels", "tracks", "table", "mesh", "splat", "sim-case", "video", "report"] as const;
export const KIND_PATTERN = "^[a-z][a-z0-9-]*$";
// `string & {}` keeps editor completion for the built-in names while allowing any other
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number] | (string & {});
export const ArtifactKindSchema = Type.String({ pattern: KIND_PATTERN, description: `What the data is, e.g. ${ARTIFACT_KINDS.join(", ")}.` });

/**
 * How an artifact is stored on disk. Artifacts are always file-backed.
 * Formats are open too: ships declare the ones they add (`formats` in
 * ship.yaml), with the file extensions or folder contents that identify them.
 */
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
  "html",
] as const;
export const FORMAT_PATTERN = "^[a-z0-9][a-z0-9-]*$";
export type Format = (typeof FORMATS)[number] | (string & {});
export const FormatSchema = Type.String({ pattern: FORMAT_PATTERN, description: `How the data is stored, e.g. ${FORMATS.join(", ")}.` });

/** How to recognise a format on disk, and what kind of data it holds. */
export const FormatInfoSchema = Type.Object(
  {
    kind: ArtifactKindSchema,
    title: Type.Optional(Type.String({ description: "As people know it, e.g. \"OME-Zarr\"." })),
    extensions: Type.Optional(
      Type.Array(Type.String({ pattern: "^(\\.[a-z0-9]+)+$" }), { minItems: 1, description: "Lowercase, with the dot; longest wins, e.g. .ome.tif before .tif." }),
    ),
    folder: Type.Optional(Type.Boolean({ description: "The data is a folder (a .zarr store, an OpenFOAM case)." })),
    contains: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: "For folders: entries that identify the format whatever the folder is called." }),
    ),
    edam: Type.Optional(Type.String({ pattern: "^format_\\d+$", description: "EDAM format term." })),
  },
  { additionalProperties: false },
);
export type FormatInfo = Static<typeof FormatInfoSchema>;

/** The formats Pharos recognises without any ship. */
export const BUILT_IN_FORMATS: Record<(typeof FORMATS)[number], FormatInfo> = {
  "ome-zarr": { kind: "volume", title: "OME-Zarr", extensions: [".zarr", ".ome.zarr"], folder: true },
  "ome-tiff": { kind: "volume", title: "OME-TIFF", extensions: [".ome.tif", ".ome.tiff"], edam: "format_3727" },
  tiff: { kind: "volume", title: "TIFF", extensions: [".tif", ".tiff"], edam: "format_3591" },
  czi: { kind: "volume", title: "Zeiss CZI", extensions: [".czi"] },
  nd2: { kind: "volume", title: "Nikon ND2", extensions: [".nd2"] },
  lif: { kind: "volume", title: "Leica LIF", extensions: [".lif"] },
  csv: { kind: "table", title: "CSV", extensions: [".csv"], edam: "format_3752" },
  parquet: { kind: "table", title: "Parquet", extensions: [".parquet"] },
  json: { kind: "table", title: "JSON" },
  ply: { kind: "mesh", title: "PLY", extensions: [".ply"] },
  vtk: { kind: "mesh", title: "VTK", extensions: [".vtk", ".vtu", ".vtp"] },
  mp4: { kind: "video", title: "MP4 video", extensions: [".mp4"] },
  "openfoam-case": { kind: "sim-case", title: "OpenFOAM case", folder: true, contains: ["system", "constant"] },
  geff: { kind: "tracks", title: "GEFF tracks", extensions: [".geff"], folder: true },
  // a page a ship's view makes; shown sandboxed, with no access to Pharos or the network
  html: { kind: "report", title: "Web page", extensions: [".html", ".htm"] },
};

/** Formats a window can draw itself; a ship's view operation must produce one of these. */
export const DISPLAYABLE_FORMATS: readonly string[] = ["tiff", "ome-tiff", "ome-zarr", "csv", "ply", "mp4", "html", "json"];

/**
 * Recognises a file or folder from its name (and, for folders, what it
 * contains), using the built-in formats plus any that ships declare.
 * Longer extensions win, so `.ome.tif` is OME-TIFF rather than TIFF.
 */
export function sniffFormat(
  name: string,
  isDir: boolean,
  entries: string[] = [],
  formats: Record<string, FormatInfo> = BUILT_IN_FORMATS,
): { kind: ArtifactKind; format: Format } | null {
  const n = name.toLowerCase();
  let best: { kind: string; format: string; len: number } | null = null;
  for (const [format, info] of Object.entries(formats)) {
    if (!!info.folder !== isDir) continue;
    for (const ext of info.extensions ?? []) {
      if (n.endsWith(ext) && ext.length > (best?.len ?? 0)) best = { kind: info.kind, format, len: ext.length };
    }
  }
  if (best) return { kind: best.kind, format: best.format };
  if (!isDir) return null;
  for (const [format, info] of Object.entries(formats)) {
    if (info.folder && info.contains?.every((e) => entries.includes(e))) return { kind: info.kind, format };
  }
  return null;
}

/**
 * EDAM terms (https://edamontology.org) for the kinds and formats above, so
 * imported tools, which bio.tools describes in EDAM, match the same
 * vocabulary. Only terms that have been checked against EDAM are listed;
 * add the rest as they are confirmed.
 */
export const EDAM_KINDS: Partial<Record<ArtifactKind, string>> = {
  volume: "data_2968", // Image
};
export const EDAM_FORMATS: Partial<Record<Format, string>> = Object.fromEntries(
  Object.entries(BUILT_IN_FORMATS).flatMap(([f, info]) => (info.edam ? [[f, info.edam]] : [])),
);

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
