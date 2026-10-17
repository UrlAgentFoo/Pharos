# Pharos

Pharos - Light House of Alexandria Library.

A generalised, open-source library of scientific tools in one local app.
Describe a problem and drop in data; an assistant picks a book, you approve
it, and it runs on your machine in containers. Every scientific tool, one
local app, no dependency hell.

## Ships and books

- **Ships = capability.** A container image plus the typed operations it
  exposes (an `openfoam` ship offers `mesh`, `solve`, `export-vtk`). Heavy,
  technical, few, and shared between many books.
- **Books = know-how.** An app for one domain ("Fluid flow", "Cell
  imaging"): the ships it needs and the actions it offers ("Simulate the
  flow", "See the case in 3D"), each a pipeline of ship operations with the
  data it accepts and the parameters people see, plus the instructions the
  assistant reads to decide when to use it. Small text files, cheap to write
  and share.

Kinds of data and file formats are open: a ship can bring a new format (say
`.h5ad` for single-cell data) by declaring how to recognise it, and Pharos
picks it up without any change to the app.

Users pick books; Pharos fetches only the ships those books need. Nothing runs
until you approve the plan, and every container step is cached.

**Every tool is a ship.** Even everyday image processing (blur, threshold,
binary operations, particles, measurements) is the `image-ops` ship: each
data window offers, in its ⋯ menu, the book actions and ship operations that fit
the data it shows, and each one lands in that window's history.

**The UI is the product.** Browsing and installing books, downloading ships,
checking Docker and GPU status, running and cancelling jobs and managing disk
all happen in the app. The command line is a thin layer over the same server
API, for authors and automation.

## Layout

| Package | What it is |
| --- | --- |
| `packages/contracts` (`@pharos/contracts`) | Shared types and JSON Schemas: artifacts, `ship.yaml`, `book.yaml`, plans, jobs, the server API and its events. |
| `packages/books` (`@pharos/books`) | Loads and checks ships and books, type-checks pipelines, resolves books and builds plans. |
| `packages/orchestrator` (`@pharos/orchestrator`) | Runs ship operations in Docker: downloads, jobs, progress, caching and run records. |
| `packages/core` (`@pharos/core`) | Headless core: the image model, TIFF I/O and display (for viewing data in windows), and parameter checking for ship operations. Runs in browsers and Node. |
| `packages/catalogue` (`@pharos/catalogue`) | Data inspector, full-text catalogue of ships and books, book matching, and the MCP server. |
| `packages/ui` (`@pharos/ui`) | The browser UI: Vite + TypeScript. |
| `packages/server` (`pharos-lab`) | The local server and `pharos` launcher: workspaces, library, plans, jobs, the assistant and authoring commands. |
| `ships/`, `books/` | The ships (`image-ops` for everyday image processing, `bio-utils`, `cellpose`, `ultrack`, `space-time-field`, `geff`, `yolo`, `render`, `openfoam`, `colmap`, `mapanything`, `opensplat`, `media-ops`, `mesh-ops`, `cad`, `fea`, `slicer`, and `hello` for tests) and books (Cell imaging, Fluid flow, Object detection, 3D capture, Printed parts) in this repo. Ship images build from each ship's Dockerfile the first time they're needed. |

## Development

Requires Node 22.13 or later.

```sh
npm install
npm run build        # contracts → books → orchestrator → core → catalogue → ui → server
npm start            # serves on 127.0.0.1 with this repo's ships and books, and opens the browser
npm run dev          # the same, with changes showing live as you edit
npm test
npm run typecheck
```

Running ships needs Docker (Docker Desktop on macOS and Windows); GPU steps
need Linux with an NVIDIA GPU and the NVIDIA Container Toolkit. Data lives in
`~/Pharos` (set `PHAROS_HOME` or `--data` to change it).

The assistant needs an Anthropic API key: save one in its Settings, or set
`ANTHROPIC_API_KEY` in the environment or in a `.env` file in the folder you
start Pharos from (this repo ignores `.env`). A key saved in Settings wins,
then the environment, then `.env`.

To use the catalogue from Claude Code, Claude Desktop or another MCP client,
add a stdio server that runs `pharos mcp --library <this repo>`.

The server only listens on `127.0.0.1` and requires the secret token in the
launch URL.

## Licence

MIT
