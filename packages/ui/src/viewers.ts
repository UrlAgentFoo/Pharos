/**
 * Viewers: each artifact kind (and format) maps to a way of showing it.
 * Images open in the image viewer; tables in a table view; kinds without a
 * viewer yet (meshes, splats, videos, simulation cases) show where the data
 * is so it can be opened in another app. Register a viewer to add one.
 */
import type { Artifact } from "@pharos/contracts";
import { parseCsv } from "./csv.js";
import { escapeHtml, formatSize, showDialog } from "./dialogs.js";

export interface ViewerHost {
  /** The artifact's bytes (files only). */
  content(artifact: Artifact): Promise<ArrayBuffer>;
  /** Opens TIFF bytes as an image window. */
  openImage(bytes: ArrayBuffer, name: string): Promise<void>;
}

export interface Viewer {
  id: string;
  /** Verb for the open button, e.g. "Open", "View table". */
  label: string;
  accepts(artifact: Artifact): boolean;
  open(artifact: Artifact, host: ViewerHost): Promise<void>;
}

const viewers: Viewer[] = [];

export function registerViewer(v: Viewer) {
  viewers.push(v);
}

/** The first registered viewer that accepts the artifact; the info card is the fallback. */
export function viewerFor(artifact: Artifact): Viewer {
  return viewers.find((v) => v.accepts(artifact)) ?? infoViewer;
}

// ------------------------------------------------------------ images

registerViewer({
  id: "image",
  label: "Open",
  accepts: (a) => (a.kind === "volume" || a.kind === "labels") && (a.format === "tiff" || a.format === "ome-tiff"),
  async open(a, host) {
    await host.openImage(await host.content(a), a.name ?? a.id.slice(0, 12));
  },
});

// ------------------------------------------------------------ tables

const TABLE_ROWS = 500;

registerViewer({
  id: "table",
  label: "View table",
  accepts: (a) => a.kind === "table" && a.format === "csv",
  async open(a, host) {
    const text = new TextDecoder().decode(await host.content(a));
    const [header = [], ...rows] = parseCsv(text, TABLE_ROWS + 1);
    const more = rows.length === TABLE_ROWS;
    await showDialog(
      `<p class="eyebrow">Table</p><h2>${escapeHtml(a.name ?? a.id)}</h2>
       <div class="artifact-table"><table><thead><tr>${header.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>
       <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
       <p class="muted small">${more ? `First ${TABLE_ROWS} rows` : `${rows.length} rows`} · ${header.length} columns · ${formatSize(a.sizeBytes ?? 0)}</p>
       <footer><button class="primary" data-cancel>Close</button></footer>`,
      () => {},
      undefined,
    );
  },
});

// ------------------------------------------------------------ videos

registerViewer({
  id: "video",
  label: "Play",
  accepts: (a) => a.kind === "video" && a.format === "mp4",
  async open(a, host) {
    const url = URL.createObjectURL(new Blob([await host.content(a)], { type: "video/mp4" }));
    try {
      await showDialog(
        `<p class="eyebrow">Video</p><h2>${escapeHtml(a.name ?? a.id)}</h2>
         <video class="artifact-video" src="${url}" controls autoplay loop muted playsinline></video>
         <p class="muted small">${formatSize(a.sizeBytes ?? 0)}</p>
         <footer><button class="primary" data-cancel>Close</button></footer>`,
        () => {},
        undefined,
      );
    } finally {
      URL.revokeObjectURL(url);
    }
  },
});

// ------------------------------------------------------------ everything else

const KIND_LABEL: Record<Artifact["kind"], string> = {
  volume: "Image volume",
  labels: "Label image",
  tracks: "Tracks",
  table: "Table",
  mesh: "Mesh",
  splat: "Gaussian splat",
  "sim-case": "Simulation case",
  video: "Video",
};

export const kindLabel = (a: Artifact) => KIND_LABEL[a.kind];

const infoViewer: Viewer = {
  id: "info",
  label: "Details",
  accepts: () => true,
  async open(a) {
    await showDialog(
      `<p class="eyebrow">${escapeHtml(kindLabel(a))} · ${escapeHtml(a.format)}</p><h2>${escapeHtml(a.name ?? a.id)}</h2>
       <p class="muted">Pharos can't show this kind of data inside the app yet. It's stored here, so you can open it in another app:</p>
       <pre class="code">${escapeHtml(a.uri)}</pre>
       <p class="muted small">${formatSize(a.sizeBytes ?? 0)} · ${escapeHtml(a.contentHash ?? "")}</p>
       <footer><button data-copy>Copy path</button><button class="primary" data-cancel>Close</button></footer>`,
      (_done, el) => {
        el.querySelector("[data-copy]")!.addEventListener("click", async (e) => {
          await navigator.clipboard.writeText(a.uri);
          (e.target as HTMLButtonElement).textContent = "Copied";
        });
      },
      undefined,
    );
  },
};
