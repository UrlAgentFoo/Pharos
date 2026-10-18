/**
 * Starter files for a new ship or book, for `pharos ship new` and
 * `pharos book new`. The templates validate as they are, so authors start
 * from a working manifest and change it.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ID_PATTERN } from "@pharos/contracts";

/** A yaml-language-server comment so editors check the manifest as it's typed. */
function schemaComment(dir: string, schema: "ship" | "book"): string {
  try {
    const file = fileURLToPath(import.meta.resolve(`@pharos/contracts/schemas/${schema}.schema.json`));
    const rel = relative(dir, file).split("\\").join("/");
    // inside the repo the schema is a few folders up; elsewhere an absolute path reads better
    return `# yaml-language-server: $schema=${/^(\.\.\/){4}/.test(rel) ? file : rel}\n`;
  } catch {
    return "";
  }
}

function checkId(id: string) {
  if (!new RegExp(ID_PATTERN).test(id)) throw new Error(`"${id}" isn't a valid id: use lowercase letters, digits and hyphens, e.g. my-tool`);
}

async function writeNew(dir: string, files: Record<string, string>) {
  await mkdir(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), text, { flag: "wx" }).catch((e: NodeJS.ErrnoException) => {
      throw e.code === "EEXIST" ? new Error(`${join(dir, name)} already exists`) : e;
    });
  }
}

/** Creates `<root>/ships/<id>/` with a ship.yaml, a Dockerfile and a test folder. Returns the folder. */
export async function newShip(root: string, id: string): Promise<string> {
  checkId(id);
  const dir = join(root, "ships", id);
  await writeNew(dir, {
    "ship.yaml": `${schemaComment(dir, "ship")}id: ${id}
version: 0.1.0
image: pharos/${id}:0.1.0    # pin by digest (pharos/${id}@sha256:…) once it's built
summary: One sentence on what this tool does.
requires: { memory_gb: 4, network: none }
operations:
  run:
    summary: One sentence on what this operation does; the assistant reads it.
    command: ${id}-run --in /in/image --out /out --threshold {threshold}
    inputs: [{ name: image, kind: volume, formats: [tiff] }]
    parameters:
      - { name: threshold, type: number, default: 0.5, min: 0, max: 1, description: What the threshold does. }
    outputs: [{ name: table, kind: table, format: csv, path: /out/table.csv }]
    cache: { deterministic: true }
`,
    Dockerfile: `# Builds pharos/${id}. Each operation reads /in, writes /out and exits;
# print {"progress": 0.5, "message": "..."} lines to stdout to report progress.
FROM python:3.12-slim
RUN useradd --create-home pharos
USER pharos
WORKDIR /home/pharos
`,
    "test/README.md": `Put a small input for each operation here (e.g. test/run/image.tif) and the
output you expect, so **Test ship** can check the ship works on this machine.
`,
  });
  return dir;
}

/** Creates `<root>/books/<id>/` with a book.yaml, a GUIDE.md and an example folder. Returns the folder. */
export async function newBook(root: string, id: string, ship = "my-ship"): Promise<string> {
  checkId(id);
  const dir = join(root, "books", id);
  await writeNew(dir, {
    "book.yaml": `${schemaComment(dir, "book")}id: ${id}
version: 0.1.0
title: The domain, as people name it
summary: One or two sentences on what the book does with the user's data; the assistant reads this.
how_to_use: Two or three plain sentences people see on the book's card.
tags: []
ships: { ${ship}: ^0.1 }
actions:
  measure:
    title: What this action does, as a button
    inputs:
      - name: image
        accepts: { kind: volume, axes: zyx }
    parameters:
      - { name: threshold, type: number, default: 0.5, sets: run.threshold }
    steps:
      - { id: run, run: ${ship}.run, in: { image: $image } }
    outputs: { table: run.table }
`,
    "GUIDE.md": `# ${id}

## When to use

The requests and data this book is right for.

## When not to use

Close calls where another book fits better, and why.

## Parameters

How to choose each parameter from the data summary (voxel size, shape, …).

## Example

Request: "…"

Plan: the steps and parameter values this book should produce for it.
`,
    "example/README.md": `Put a small example dataset here, plus the result you expect, so **Test book**
can run the whole book end to end.
`,
  });
  return dir;
}
