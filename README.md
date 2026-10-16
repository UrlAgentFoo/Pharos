# Pharos

Pharos - Light House of Alexandria Library.

A generalised, open-source library of scientific tools in one local app.
Describe a problem and drop in data; an assistant picks a recipe, you approve
it, and it runs on your machine in containers. Every scientific tool, one
local app, no dependency hell.

## Ships and books

- **Ships = capability.** A container image plus the typed operations it
  exposes (an `openfoam` ship offers `mesh`, `solve`, `export-vtk`). Heavy,
  technical, few, and shared between many books.
- **Books = know-how.** A recipe: the ships it needs, the steps that connect
  them, the parameters users see, and the instructions the assistant reads to
  decide when to use it. Small text files, cheap to write and share.

Users pick books; Pharos fetches only the ships those books need. Nothing runs
until you approve the plan, and every container step is cached.

**The UI is the product.** Browsing and installing books, downloading ships,
checking Docker and GPU status, running and cancelling jobs and managing disk
all happen in the app. The command line is a thin layer over the same server
API, for authors and automation.

## Layout

| Package | What it is |
| --- | --- |
| `packages/core` (`@pharos/core`) | Headless core: data model, TIFF I/O, operations, the command registry and the timeline. Runs in browsers and Node. |
| `packages/ui` (`@pharos/ui`) | The browser UI: Vite + TypeScript. |
| `packages/server` (`pharos-lab`) | The local server and `pharos` launcher: file access, batch runs and the assistant. |
| `kernels/` | Rust pixel kernels compiled to WebAssembly. Parked: the built module is checked in at `packages/core/wasm/`, and nothing new should depend on it. |

## Development

Requires Node 20.19 or later.

```sh
npm install
npm run build        # core → ui → server
npm start            # serves on 127.0.0.1 and opens the browser
npm test
npm run typecheck
```

The server only listens on `127.0.0.1` and requires the secret token in the
launch URL. Rebuilding the kernels needs Rust with the
`wasm32-unknown-unknown` target: `npm run build:wasm`.

## Licence

MIT
