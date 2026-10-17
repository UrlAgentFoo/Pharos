/**
 * The catalogue: every known ship and book manifest with a trust level,
 * searchable as text. The Pharos assistant, the build agents and outside
 * assistants all query it through the same MCP tools.
 */
import { type Static, Type } from "@sinclair/typebox";
import { IdSchema, TrustLevelSchema, VersionSchema } from "./vocabulary.js";

export const CATALOGUE_SOURCES = ["hand-written", "bio.tools", "biocontainers", "galaxy", "nf-core", "bioimage.io", "saved-plan"] as const;

export const CatalogueEntrySchema = Type.Object(
  {
    type: Type.Union([Type.Literal("ship"), Type.Literal("book")]),
    id: IdSchema,
    version: VersionSchema,
    title: Type.String(),
    summary: Type.String(),
    tags: Type.Array(Type.String()),
    trust: TrustLevelSchema,
    source: Type.Union(CATALOGUE_SOURCES.map((s) => Type.Literal(s))),
    installed: Type.Boolean(),
    gpu: Type.Union([Type.Literal("required"), Type.Literal("optional"), Type.Literal("none")]),
    imageSizeBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    /** Why verification failed, when it did. */
    verifyError: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type CatalogueEntry = Static<typeof CatalogueEntrySchema>;

/** How well a book fits the user's data, from its `accepts` block. */
export const MATCH_TIERS = ["direct", "convert", "excluded"] as const;
export type MatchTier = (typeof MATCH_TIERS)[number];

export const BookMatchSchema = Type.Object(
  {
    book: CatalogueEntrySchema,
    tier: Type.Union(MATCH_TIERS.map((t) => Type.Literal(t))),
    /** The book's actions that can run on the data, best first; empty when excluded. */
    actions: Type.Array(Type.String()),
    /** e.g. "needs tzyx, file has zyx", "converted by bio-utils.convert". */
    reasons: Type.Array(Type.String()),
    score: Type.Number({ description: "Higher ranks first; excluded books score 0." }),
  },
  { additionalProperties: false },
);
export type BookMatch = Static<typeof BookMatchSchema>;

export interface CatalogueStats {
  ships: Record<"verified" | "verifying" | "imported", number>;
  books: Record<"verified" | "verifying" | "imported", number>;
  /** Count per domain tag, e.g. microscopy, cfd, genomics. */
  byDomain: Record<string, number>;
}

/** Tools the catalogue's MCP server exposes. */
export const MCP_TOOLS = {
  search_books: "Full-text search over books, with optional tag, trust and GPU filters.",
  search_ships: "Full-text search over ships and their operations, with optional filters.",
  match_file: "Given a DataSummary, rank the books that can run on it (direct, after conversion, or excluded with reasons).",
  get_manifest: "Return one ship.yaml or book.yaml (and a book's GUIDE.md) by id and optional version.",
  catalogue_stats: "Counts of ships and books by trust level and domain.",
  find_gaps: "Formats and operations no verified ship covers yet.",
} as const;
export type McpToolName = keyof typeof MCP_TOOLS;
