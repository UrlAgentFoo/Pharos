# Pharos: Next steps

Oct 17, 2026

## Where we are

The engine works end to end: ships run locked down in Docker with progress,
caching and run records; books are type-checked, matched to data and planned
by the assistant; the catalogue answers over MCP. Every tool is now a ship,
so there is one kind of window (a data window with its history), and there
are ten examples.

What still feels wrong when using it:

- A book is a single fixed pipeline, so a domain is split across several
  books ("Look at an OpenFOAM case in 3D", "Simulate flow past an obstacle")
  instead of being one app.
- Book cards show internal detail (id, version, trust) instead of what a
  person needs to decide.
- Long work looks frozen: downloads and image builds show as "waiting" with
  an empty bar, and steps that don't report progress sit at 0%.
- Examples are slow: cold caches, full-length simulations, ship images
  built locally on first use, and amd64 images emulated on Apple silicon.
- Samples live only on the start screen, not in Add data.

## 1. Books are apps

Two concepts only: **books** and **ships**. No shelves or collections. A book
is a domain app ("Fluid flow", "Cell tracking") that can do several things
with the same ships. It can carry as much metadata as the assistant and the
engine need; the user sees four things.

**The card**

```
Fluid flow
How to use     Open an OpenFOAM case to see its geometry, simulate it at the
               speed you choose, and watch the vortices.
               See the case in 3D · Simulate the flow · Make a video
Accepted files OpenFOAM case folder
Ships          ● openfoam   ○ render        (full colour = downloaded, faded = not yet)
```

Hidden: steps and wiring, parameter mappings, EDAM terms, tags, trust,
versions, `GUIDE.md`, test examples.

**Contract change (lead)**

```yaml
id: fluid-flow
title: Fluid flow
how_to_use: Open an OpenFOAM case to see its geometry, simulate it at the speed you choose, and watch the vortices.
ships: { openfoam: ^0.1, render: ^0.1 }
inputs: [{ name: case, accepts: { kind: sim-case, formats: [openfoam-case] } }]
actions:
  geometry: { title: See the case in 3D, steps: [...], outputs: {...} }
  simulate: { title: Simulate the flow, parameters: [...], steps: [...], outputs: {...} }
```

- [x] `book.ts`: add `how_to_use` and `actions` (each with `title`, optional
      `inputs`, `parameters`, `steps`, `outputs`); a book needs at least one.
- [x] `plan.ts`: a plan names `book` + `action`.
- [x] `GET /api/library/books` returns, per book, the accepted formats and each
      ship's `downloaded` flag, so the library needs one request, not three per book.

**Then, per lane**

- [x] C: loader, type-checker, accepted formats, matcher and planner work per
      action; the assistant picks a book and an action; Save as book can add
      an action to an existing book.
- [x] A: the new card; inside a data window, the book's actions are its tools,
      and each adds steps to the same history.
- [x] D: merge `case-geometry` + `fluid-sim` into `fluid-flow`; regroup the
      microscopy books (`segment-measure`, `cell-tracking`, `score-tracking`)
      into one or two books.

## 2. Progress you can trust

One progress component used everywhere: step cards, the history strip, Add
data and the assistant.

- [x] Phases, not just a percentage: waiting → downloading or building (bytes,
      or the latest build line, from `pull` events) → starting → running (%) →
      done or cached.
- [x] An animated, indeterminate bar when progress is unknown, plus elapsed time.
- [x] Overall progress for a run: "2 of 4 · segment · 41% · 1:12".
- [x] After the event stream reconnects, fetch job states again so bars don't freeze.
- [x] "No output for 30 s · view log", so a real hang can be told apart from slow work.
- [x] A global place for jobs (the Jobs panel was removed): what's running,
      what's downloading, across closed windows.
- [x] D: ships report progress often enough to move the bar (per frame, per tile,
      per time step), not just at start and end.
- [x] Found on the way: a reloaded page re-attaches to runs still going (and picks up
      ones that finished), and autosave no longer waits forever while a run keeps
      the windows changing.

## 3. Examples that run in seconds

- [ ] Each example ships its parameters (short simulated time, small crop);
      the start screen uses them instead of book defaults.
- [ ] One cache shared across workspaces (keyed by content, so it is safe),
      not one cache per workspace.
- [ ] Warm the cache for every example (`pharos warm`), and ship precomputed
      results with the examples so the first run is instant too.
- [ ] Pull prebuilt, multi-arch ship images from a registry, pinned by digest,
      instead of building from the Dockerfile on first use.
- [ ] Add data gets a **Samples** section next to "From this computer", listing
      every example by domain.

## 4. Finish what's half-built

- [ ] Save as book in the UI (the route exists).
- [ ] Test ship, Test book and Get ready buttons (routes exist).
- [ ] Pin every ship image by digest; tags like `pharos/bio-utils:0.1.0`
      undermine the reproducibility promise.

## 5. Is the architecture right for a universal tool runner?

The goal: any open-source scientific tool, run locally, safely and
reproducibly, chained with others, without dependency hell.

### What is right, and should stay

- **Container + typed manifest per tool.** The same primitive as Boutiques,
  CWL, Galaxy and nf-core, so importing from them is a translation, not a
  rewrite.
- **Books and ships.** Know-how separate from capability, one image shared by
  many books.
- **Locked-down runs.** Read-only `/in`, empty `/out`, no network, host uid.
  Essential when running strangers' code.
- **Content-addressed cache and run records.** Provenance and instant re-runs
  come almost for free.
- **Plan, then approve.** The assistant proposes; nothing runs unasked.
- **Catalogue over MCP.** Other assistants can use the library too.

### What limits it today, most important first

1. ✅ **Closed vocabularies** (done: kinds and formats are open strings, and
   ships declare new formats with how to recognise them). `ARTIFACT_KINDS` (8 kinds) and `FORMATS` are enums
   in the frozen contracts, so every new domain (genomics, astronomy, audio,
   molecules) needs a contract change by the lead. Make kinds and formats a
   registry: EDAM terms plus entries that ships and books can declare, with the
   core enums as the built-in set.
2. **Viewers are hand-written in the UI, one per kind.** A universal tool
   can't wait for Pharos to write its viewer. Let ships provide viewers: a
   `view` operation that turns an artifact into something the UI already shows
   (image, table, video, model, HTML), and later a ship that serves its own web view.
3. **Batch only.** Every operation runs and exits. Many tools are interactive
   (ParaView, napari, Jupyter, a solver you watch and steer) or are slow to
   start (deep-learning models). "Full OpenFOAM in a window" needs the `http`
   mode the schema already declares but the orchestrator doesn't implement:
   a warm container, streamed results, and an embedded web view. This is also
   what makes small operations (crop, contrast) feel instant now that every
   tool is a ship.
4. **Docker only, one machine.** Docker Desktop is heavy and licensed for
   larger organisations; HPC users can't run Docker at all; GPUs only work on
   Linux with NVIDIA; amd64 images are emulated on Apple silicon. Put a runner
   interface in the orchestrator (Docker today; Podman, Apptainer and a remote
   or SLURM runner later) so ship manifests don't change.
5. **No fan-out in books.** Steps form a graph but can't run once per file,
   per frame or per parameter value. Batch processing is most of real
   scientific work; add a CWL-style `scatter` to steps.
6. **Copy-and-hash for every input.** Hashing and mounting whole inputs is fine
   for megabytes and painful for terabyte microscopy or simulation output.
   Hash by chunks or by metadata for large inputs, and mount by reference.
7. **Distribution and trust.** Ships are built locally and the catalogue is a
   folder. A public library needs a registry of prebuilt images, signed
   manifests and images (Sigstore), and the verifier that promotes imported
   ships to verified.
8. **Authoring cost.** Each ship today needs a wrapper script. Importers
   (Galaxy, BioContainers, nf-core, bio.tools) only scale if a ship can be a
   bare command template, with progress optional and logs parsed when the
   tool doesn't speak the progress protocol.

### Verdict

The core idea and the security model are right and worth keeping. What makes
it a product for microscopy and CFD rather than a universal runner are
decisions that were reasonable for a hackathon: closed vocabularies, viewers
inside the UI, batch only, Docker only. None needs a rewrite. Each is an
extension point placed where a hard-coded list is today. Do 1 and 2 before the
catalogue grows, because every ship and book written against the closed lists
has to be migrated later; do 3 for the app-in-a-window experience; leave 4–8
until real users ask.

## Order of work

1. Land the work in progress (one window type, examples, image-ops ship).
2. Contract change for books-as-apps (§1) and open kinds and formats (§5.1),
   in one release so lanes migrate once.
3. In parallel: progress component (§2), fast examples and Samples (§3),
   books regrouped (§1, lane D).
4. Viewers from ships (§5.2), then warm `http` ships (§5.3).
5. Save as book, test buttons, digests (§4).
