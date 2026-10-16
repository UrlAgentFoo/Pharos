# Pharos: notes for agents

Pharos is a local app: describe a problem, drop in data, and an assistant
picks a **book** (a recipe) that runs **ships** (container images with typed
operations) on this machine. Read `README.md` first.

## The rules

1. **The UI is the product.** Everything a user does (browse and install
   books, download ships, check Docker and GPU, run and cancel jobs, manage
   disk) happens in the app. The `pharos` command line is a thin layer over
   the same server API, for authors and automation only. If a feature has no
   UI, it isn't done.
2. **`packages/contracts` is frozen.** Every lane builds against its types
   and schemas. Never edit it in a lane; propose the change to the lead, who
   updates it for everyone.
3. **Stay in your lane.** Work on your own branch in your own git worktree
   and only edit the folders you own (below). Use mocks for what other lanes
   haven't finished.
4. **Finish with green checks.** `npm run build`, `npm run typecheck` and
   `npm test` pass, and you leave a short note: what changed, what's mocked.
5. **Nothing runs without approval.** Plans are proposed, the user approves,
   then jobs run. Ship downloads are listed before they start; never offer
   "download everything".
6. **Ships are untrusted code.** Inputs mount read-only at `/in`, outputs go
   to an empty `/out`, models to a shared `/weights` volume. No network by
   default, the host user's uid, memory and GPU limits from `requires`. Never
   mount the home folder or the Docker socket into a ship.
7. **The assistant sees metadata, never pixels** (a `DataSummary`).

## Lanes

| Lane | Owns |
| --- | --- |
| A · Core + UI | `packages/core`, `packages/ui` |
| B · Orchestrator | `packages/orchestrator`, the server's job routes |
| C · Formats + assistant | `packages/books`, `packages/catalogue` (index + MCP), `packages/assistant` |
| D · Ships + books | `ships/`, `books/`, demo data |
| Lead | `packages/contracts`, `AGENTS.md`, merges at each gate |

Gates: **1** a ship operation runs from the UI with live progress and logs;
**2** drop a file → shortlist → the assistant picks "Segment and measure" →
approve → ships download → the table appears; **3** the Cell tracking book
runs and is cached, and the catalogue shows its counts.

## Layout

```
packages/contracts   types + JSON Schemas: artifact, ship.yaml, book.yaml, plan, job, API routes, events
packages/core        headless core: image model, TIFF I/O, operations, command registry, timeline
packages/ui          browser UI (Vite + plain TypeScript)
packages/server      local server and `pharos` launcher (published as pharos-lab)
kernels/             parked Rust/WASM kernels; the built module is checked in, don't add dependants
ships/<id>/          ship.yaml, optional Dockerfile, test/ per operation
books/<id>/          book.yaml, GUIDE.md (assistant instructions), example/
```

## Commands

```sh
npm install
npm run build        # contracts → core → ui → server
npm run typecheck
npm test             # vitest, run against sources (no build needed)
npm start            # local server on 127.0.0.1; prints the launch URL with its token
npm run build -w @pharos/contracts   # also rewrites packages/contracts/schemas/*.json
```

## Conventions

- TypeScript, ES modules, strict. Relative imports end in `.js`.
- Packages import each other by name (`@pharos/core`, `@pharos/contracts`);
  vitest and Vite alias these to sources.
- Schemas are written once with TypeBox in `packages/contracts` and give both
  the TypeScript type and the JSON Schema. Pattern-keyed maps use `KeyedMap`
  so unknown keys are rejected.
- Tests live in `packages/<name>/test/*.test.ts`.
- Comments explain why, briefly; match the density of the file you're in.
- Ship ids are lowercase-hyphenated (`bio-utils`); input, output, parameter
  and step names are lowercase_snake (`movie`, `masks`).
