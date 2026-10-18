/**
 * Reads a manifest and validates it against its schema, keeping line
 * numbers so authors see "book.yaml:14" instead of a JSON pointer.
 */
import { readFile } from "node:fs/promises";
import { LineCounter, type Document, parseDocument } from "yaml";
import type { Validation } from "@pharos/contracts";
import { type ManifestProblem, error } from "./problems.js";

export interface ParsedManifest<T> {
  value?: T;
  /** The `id` field as written, when there is one, even if the manifest is invalid. */
  id?: string;
  problems: ManifestProblem[];
  /** Line (1-based) of the value a JSON pointer names, or of its nearest parent. */
  lineOf(pointer: string): number | undefined;
}

export function parseManifest<T>(text: string, file: string, validate: (v: unknown) => Validation<T>): ParsedManifest<T> {
  const counter = new LineCounter();
  const doc = parseDocument(text, { lineCounter: counter, prettyErrors: false, uniqueKeys: true });
  const lineOf = (pointer: string) => lineFor(doc, counter, pointer);
  if (doc.errors.length) {
    return {
      problems: doc.errors.map((e) => ({ ...error("/", e.message.split("\n")[0]), file, line: counter.linePos(e.pos[0]).line })),
      lineOf,
    };
  }
  const js: unknown = doc.toJS();
  const declared = (js as { id?: unknown } | null)?.id;
  const id = typeof declared === "string" ? declared : undefined;
  const result = validate(js);
  if (!result.ok) return { id, problems: result.problems.map((p) => ({ ...error(p.path, p.message), file, line: lineOf(p.path) })), lineOf };
  return { value: result.value, id, problems: [], lineOf };
}

export async function readManifest<T>(file: string, validate: (v: unknown) => Validation<T>): Promise<ParsedManifest<T>> {
  return parseManifest(await readFile(file, "utf8"), file, validate);
}

function lineFor(doc: Document, counter: LineCounter, pointer: string): number | undefined {
  const path: (string | number)[] = pointer
    .split("/")
    .slice(1)
    .filter(Boolean)
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"))
    .map((s) => (/^\d+$/.test(s) ? Number(s) : s));
  for (let n = path.length; n >= 0; n--) {
    const node = n === 0 ? doc.contents : doc.getIn(path.slice(0, n), true);
    const range = (node as { range?: [number, number, number] } | undefined)?.range;
    if (range) return counter.linePos(range[0]).line;
  }
  return undefined;
}
