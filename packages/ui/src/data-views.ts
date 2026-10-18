/**
 * Viewers for data, by kind and format: the one place that knows how to load
 * an artifact for display and draw it into an element. A data window uses it
 * for the result on view and for every tile in its results grid.
 *
 * Adding a kind of data to Pharos means adding a loader and a mount here;
 * nothing else in the window changes.
 */
import type { Artifact, CaseSummary } from "@pharos/contracts";
import { type Image, readTiff } from "@pharos/core";
import type { LocalServer, PreviewSampling } from "./api.js";
import { parseCsv } from "./csv.js";
import { escapeHtml, formatSize } from "./dialogs.js";
import { ModelView } from "./model-view.js";
import { SplatView, isSplatPly } from "./splat-view.js";
import { TAIL, type TrackScene, TracksIn3D, drawTracksOnSlice, drawWheel, isDeep, nearText, trackScene } from "./track-views.js";
import { parseTracks } from "./tracks.js";
import { type ViewState, Viewer, newViewState, resetRanges, scaledCopy, setRanges } from "./viewer.js";

/** What a viewer needs for one artifact, fetched once and kept while its window is open. */
export type Loaded =
  /**
   * `note`: what a preview of a larger image left out ("A preview: every 2nd pixel, 1 in 3 frames");
   * `sampling`, exactly how (for drawing what was measured on the full image over it).
   */
  | { type: "image"; image: Image; view: ViewState; note?: string; sampling?: PreviewSampling }
  /**
   * Cell tracks over the movie they came from, on the slice on view or in 3D (`mode`), following its
   * sliders. `shared`: the movie is the window's own data's, already held (so it isn't counted twice).
   */
  | { type: "tracks"; image: Image; view: ViewState; note?: string; scene: TrackScene; total: number; mode: "slice" | "3d"; shared: boolean }
  | { type: "table"; rows: string[][]; total: number }
  /** A media link the video streams from: nothing of it is held in the page. */
  | { type: "video"; url: string }
  | { type: "model"; ply: ArrayBuffer }
  | { type: "splat"; ply: ArrayBuffer }
  | { type: "case"; summary: CaseSummary }
  | { type: "text"; text: string }
  | { type: "page"; url: string; bytes: number }
  /** Data the window can't draw itself; `reason` when it tried (a Zarr it can't read), and ship views may still show it. */
  | { type: "info"; reason?: string }
  | { type: "error"; message: string };

/** A viewer drawn into an element; destroy it before reusing the element. */
export interface Mounted {
  destroy(): void;
  /** What it shows right now as a small picture, for viewers that draw pixels (videos, models). */
  snapshot?(max: number): HTMLCanvasElement | null;
}

/**
 * Tracks with the movie they were made from, to draw them over it: `movie`'s preview, or the one the window
 * already holds (`held`, its own data on view earlier).
 */
export async function loadTracksView(s: LocalServer, workspace: string, tracks: Artifact, movie: Artifact, held?: Extract<Loaded, { type: "image" }>): Promise<Loaded> {
  try {
    const [text, shown] = await Promise.all([
      s.content(workspace, tracks.id).then((b) => new TextDecoder().decode(b)),
      held ?? s.artifactImage(workspace, movie.id).then(async (tiff) => ({ image: await readTiff(tiff.data, movie.name), note: tiff.note, sampling: tiff.sampling })),
    ]);
    const { image, note, sampling } = shown;
    const view = newViewState(image);
    view.pos.z = Math.floor(image.shape.slices / 2);
    resetRanges(view, image); // the contrast of the slice it opens on, not the first (often empty) one
    const all = parseCsv(text);
    const scene = trackScene(image, sampling ?? { x: 1, y: 1, z: 1, t: 1, c: 1 }, parseTracks(all));
    return { type: "tracks", image, view, ...(note ? { note } : {}), scene, total: all.length - 1, mode: "slice", shared: !!held };
  } catch (e) {
    return { type: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

export async function loadView(s: LocalServer, workspace: string, a: Artifact): Promise<Loaded> {
  try {
    if (a.kind === "volume" || a.kind === "labels") {
      let tiff: { data: ArrayBuffer; note?: string; sampling?: PreviewSampling };
      try {
        tiff = await s.artifactImage(workspace, a.id);
      } catch (e) {
        // what the preview can't read (a Blosc-compressed or Zarr 3 store, a plain array): a ship's view can still show it
        if ((e as { status?: number }).status === 415) return { type: "info", reason: e instanceof Error ? e.message : String(e) };
        throw e;
      }
      const image = await readTiff(tiff.data, a.name);
      const view = newViewState(image);
      view.labels = a.kind === "labels";
      // open stacks in the middle, where the objects usually are, not on the (often empty) first slice,
      // with that slice's contrast
      view.pos.z = Math.floor(image.shape.slices / 2);
      if (!view.labels) resetRanges(view, image);
      return { type: "image", image, view, ...(tiff.note ? { note: tiff.note } : {}), ...(tiff.sampling ? { sampling: tiff.sampling } : {}) };
    }
    if (a.format === "csv") {
      const text = new TextDecoder().decode(await s.content(workspace, a.id));
      return { type: "table", rows: parseCsv(text, 501), total: text.split("\n").filter((l) => l.trim()).length - 1 };
    }
    if (a.kind === "splat" && (a.format === "splat-ply" || a.format === "ply")) return { type: "splat", ply: await s.content(workspace, a.id) };
    if (a.kind === "mesh" && a.format === "ply") {
      // a splat saved as plain .ply (as most trainers name it) is recognised by what's in it
      const ply = await s.content(workspace, a.id);
      return isSplatPly(ply) ? { type: "splat", ply } : { type: "model", ply };
    }
    // MP4s, and phone videos as QuickTime .mov (H.264 or HEVC); the browser decodes what it can
    if (a.kind === "video" && (a.format === "mp4" || a.format === "mov")) return { type: "video", url: await s.artifactLink(workspace, a.id) };
    if (a.format === "openfoam-case") return { type: "case", summary: await s.caseSummary(workspace, a.id) };
    if (a.format === "html") {
      const page = await s.content(workspace, a.id);
      return { type: "page", url: URL.createObjectURL(new Blob([page], { type: "text/html" })), bytes: page.byteLength };
    }
    if (a.format === "json") return { type: "text", text: new TextDecoder().decode(await s.content(workspace, a.id)) };
    return { type: "info" };
  } catch (e) {
    return { type: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

/** Frees what a loaded entry holds outside the page (a page's blob). */
export function releaseView(entry: Loaded) {
  if (entry.type === "page") URL.revokeObjectURL(entry.url);
}

/**
 * Draws `entry` into `host` (a `.dv-stage`). `compact` is for grid tiles:
 * no hints or footers, and videos without controls until hovered.
 */
export function mountView(host: HTMLElement, entry: Loaded, a: Artifact, compact = false): Mounted & { viewer?: Viewer } {
  host.classList.remove("has-image", "has-model");
  const none = { destroy() {} };
  switch (entry.type) {
    case "image":
      return mountImage(host, entry, a, compact);
    case "tracks":
      return mountTracks(host, entry, a, compact);
    case "table":
      mountTable(host, entry.rows, entry.total, a, compact);
      return none;
    case "video": {
      host.innerHTML = `<video class="dv-video" src="${entry.url}" ${compact ? "" : "controls"} autoplay loop muted playsinline></video>`;
      const video = host.querySelector("video")!;
      // a codec this browser can't decode (some HEVC or 10-bit HDR phone videos): say so, and how to get one it can
      video.addEventListener("error", () => {
        host.innerHTML = card(
          "Can't play this video here",
          `This browser can't decode ${escapeHtml(a.name ?? "it")} (${escapeHtml(a.format)}), but it's in the workspace and books can still use it. To watch it in Pharos, resize it with the media-ops ship (Suggest, then Resize video): the copy is an MP4 every browser plays.`,
        );
      }, { once: true });
      // the frame on screen now; the video is a blob of our own, so the canvas stays readable
      return { destroy() {}, snapshot: (max) => (video.readyState >= 2 && video.videoWidth ? scaledCopy(video, video.videoWidth, video.videoHeight, max) : null) };
    }
    case "model": {
      host.classList.add("has-model");
      host.innerHTML = `<div class="dv-model"></div>${compact ? "" : `<p class="dv-hint">Drag to turn · scroll to zoom · right-drag to move</p>`}`;
      try {
        return new ModelView(host.querySelector<HTMLElement>(".dv-model")!, entry.ply);
      } catch (e) {
        host.innerHTML = card("Can't show this model", escapeHtml(e instanceof Error ? e.message : String(e)));
        return none;
      }
    }
    case "splat": {
      host.classList.add("has-model");
      host.innerHTML = `<div class="dv-model"></div>${compact ? "" : `<p class="dv-hint">Drag to turn · scroll to zoom · right-drag to move</p>`}`;
      try {
        return new SplatView(host.querySelector<HTMLElement>(".dv-model")!, entry.ply);
      } catch (e) {
        host.innerHTML = card("Can't show this splat", escapeHtml(e instanceof Error ? e.message : String(e)));
        return none;
      }
    }
    case "case":
      host.innerHTML = caseCard(entry.summary, a, compact);
      return none;
    case "text":
      host.innerHTML = `<pre class="code dv-text">${escapeHtml(entry.text)}</pre>`;
      return none;
    case "page":
      // ships are untrusted: their pages get no scripts, no forms and no access to Pharos
      host.innerHTML = `<iframe class="dv-page" sandbox="" referrerpolicy="no-referrer" src="${entry.url}" title="${escapeHtml(a.name ?? "page")}"></iframe>`;
      return none;
    case "error":
      host.innerHTML = card("Can't show this", escapeHtml(entry.message));
      return none;
    default:
      host.innerHTML = `<div class="dv-card"><p class="eyebrow">${escapeHtml(a.kind)} · ${escapeHtml(a.format)}</p><h3>${escapeHtml(a.name ?? a.id)}</h3>
        ${entry.type === "info" && entry.reason ? `<p class="small">${escapeHtml(entry.reason.charAt(0).toUpperCase() + entry.reason.slice(1))}.</p>` : ""}
        <p class="muted">Pharos can't show this kind of data inside a window yet. It's stored at:</p><pre class="code">${escapeHtml(a.uri)}</pre></div>`;
      return none;
  }
}

/**
 * An image in its zoomable canvas, with its slice, frame and channel sliders and the contrast buttons;
 * `changed` hears when they move the view.
 */
function mountImage(host: HTMLElement, entry: { image: Image; view: ViewState; note?: string }, a: Artifact, compact: boolean, changed = () => {}): Mounted & { viewer: Viewer } {
  const { slices, frames, channels } = entry.image.shape;
  // a tile has its own view, opened on the middle slice where objects usually are
  const view = compact ? { ...entry.view, pos: { ...entry.view.pos, z: Math.floor(slices / 2) }, placed: false } : entry.view;
  host.classList.add("has-image");
  host.innerHTML = `<div class="dv-canvas"><canvas tabindex="0"></canvas><div class="win-readout"></div>${entry.note && !compact ? `<p class="dv-preview-note" title="The window shows less than the whole image; ships run on all of it">${escapeHtml(entry.note)}</p>` : ""}</div>
    <div class="dv-sliders">${[["z", slices, "Slice"], ["t", frames, "Frame"], ["c", channels, "Channel"]]
      .filter(([, n]) => (n as number) > 1)
      .map(([axis, n, label]) => `<label>${label}<input type="range" min="0" max="${(n as number) - 1}" value="${view.pos[axis as "z" | "t" | "c"]}" data-axis="${axis}"/><output>${view.pos[axis as "z" | "t" | "c"] + 1}/${n}</output></label>`)
      .join("")}${compact || entry.view.labels ? "" : `<span class="dv-contrast" title="Changes only the display, not the data">Contrast <button class="chip" data-range="auto">Auto</button><button class="chip" data-range="full">Full range</button></span>`}</div>`;
  const readout = host.querySelector<HTMLElement>(".win-readout")!;
  const viewer: Viewer = new Viewer(host.querySelector("canvas")!, (info) => (readout.textContent = info || `${a.kind === "labels" ? "labels" : a.format} · ${viewer.zoomPercent}%`));
  viewer.show(entry.image, view);
  host.querySelectorAll<HTMLInputElement>("input[data-axis]").forEach((input) =>
    input.addEventListener("input", () => {
      const axis = input.dataset.axis as "z" | "t" | "c";
      view.pos[axis] = Number(input.value);
      input.nextElementSibling!.textContent = `${Number(input.value) + 1}/${Number(input.max) + 1}`;
      viewer.render();
      changed();
    }),
  );
  host.querySelectorAll<HTMLButtonElement>("[data-range]").forEach((b) =>
    b.addEventListener("click", () => {
      setRanges(view, entry.image, b.dataset.range as "auto" | "full");
      viewer.render();
      changed();
    }),
  );
  return { viewer, destroy() {} };
}

function mountTable(host: HTMLElement, rows: string[][], total: number, a: Artifact, compact: boolean) {
  host.innerHTML = `<div class="dv-table artifact-table"><table><thead><tr>${(rows[0] ?? []).map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>
    <tbody>${rows.slice(1).map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
    ${compact ? "" : `<p class="dv-foot">${total} rows${total > 500 ? " · first 500 shown" : ""} · ${formatSize(a.sizeBytes ?? 0)}</p>`}`;
}

/**
 * Tracks over their movie: on the slice on view (the image viewer's overlay) or, for a 3D movie, in 3D, with
 * the legend on the picture and the choice between the two beside the sliders. Tiles show the slice only.
 */
function mountTracks(host: HTMLElement, entry: Extract<Loaded, { type: "tracks" }>, a: Artifact, compact: boolean): Mounted {
  const { scene } = entry;
  let space: TracksIn3D | null = null;
  const { viewer } = mountImage(host, entry, a, compact, () => space?.update());
  viewer.overlay = (ctx, view, zoom) => drawTracksOnSlice(ctx, scene, view, zoom);
  viewer.render();
  const flat = host.querySelector<HTMLCanvasElement>("canvas")!;
  const snap = (max: number) => space?.snapshot(max) ?? scaledCopy(flat, flat.width, flat.height, max);
  if (compact) return { destroy() {}, snapshot: snap };

  const stage = host.querySelector<HTMLElement>(".dv-canvas")!;
  const deep = isDeep(scene);
  stage.insertAdjacentHTML(
    "beforeend",
    `<div class="trk-legend"><canvas class="trk-wheel" width="56" height="56" aria-hidden="true"></canvas>
      <p>Each tail: a cell's last ${TAIL} frames<br>Colour: its direction · grey: still<span class="trk-near"></span></p></div>`,
  );
  drawWheel(stage.querySelector<HTMLCanvasElement>(".trk-wheel")!);
  const n = scene.tracks.byId.size;
  host.querySelector(".dv-sliders")!.insertAdjacentHTML(
    "beforeend",
    `<span class="dv-tracks" role="group" aria-label="Tracks"><span>${n} track${n === 1 ? "" : "s"}</span>${
      deep ? `<button class="chip" data-mode="slice">On the slice</button><button class="chip" data-mode="3d">In 3D</button>` : ""
    }</span>`,
  );
  const readout = host.querySelector<HTMLElement>(".win-readout")!;
  const show = () => {
    const in3d = entry.mode === "3d";
    for (const b of host.querySelectorAll<HTMLButtonElement>("[data-mode]")) {
      b.classList.toggle("on", b.dataset.mode === entry.mode);
      b.setAttribute("aria-pressed", String(b.dataset.mode === entry.mode));
    }
    const near = nearText(scene, entry.mode);
    stage.querySelector(".trk-near")!.innerHTML = near ? `<br>${escapeHtml(near)}` : "";
    flat.hidden = in3d;
    if (in3d && !space) {
      const box = Object.assign(document.createElement("div"), { className: "trk-3d" });
      stage.prepend(box);
      space = new TracksIn3D(box, scene, entry.view);
      readout.textContent = "Drag to turn · scroll to zoom · right-drag to move";
    } else if (!in3d && space) {
      space.destroy();
      stage.querySelector(".trk-3d")?.remove();
      space = null;
      readout.textContent = "";
      viewer.render();
    }
  };
  host.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) =>
    b.addEventListener("click", () => {
      entry.mode = b.dataset.mode as "slice" | "3d";
      show();
    }),
  );
  show();
  return { destroy: () => space?.destroy(), snapshot: snap };
}

const card = (title: string, html: string) => `<div class="dv-card"><p class="eyebrow">${escapeHtml(title)}</p><p>${html}</p></div>`;

function caseCard(c: CaseSummary, a: Artifact, compact: boolean): string {
  const times = c.times.filter((t) => t > 0);
  return `<div class="dv-card">
    <p class="eyebrow">OpenFOAM case${c.solved ? " · solved" : ""}</p>
    <h3>${escapeHtml(a.name ?? "case")}</h3>
    <dl>
      ${c.application ? `<dt>Solver</dt><dd>${escapeHtml(c.application)}</dd>` : ""}
      ${c.cells ? `<dt>Mesh</dt><dd>${c.cells.toLocaleString()} cells</dd>` : `<dt>Mesh</dt><dd>made when it runs (blockMesh)</dd>`}
      ${c.inletSpeed !== undefined ? `<dt>Inlet speed</dt><dd>${c.inletSpeed} m/s</dd>` : ""}
      ${c.viscosity !== undefined ? `<dt>Viscosity</dt><dd>${c.viscosity} m²/s</dd>` : ""}
      ${c.endTime !== undefined ? `<dt>End time</dt><dd>${c.endTime} s</dd>` : ""}
      <dt>Saved times</dt><dd>${times.length ? `${times.length} (${times[0]}-${times[times.length - 1]} s)` : "none yet"}</dd>
      ${compact ? "" : `<dt>Fields</dt><dd>${escapeHtml(c.fields.join(", ") || "none")}</dd>
      <dt>Boundaries</dt><dd>${c.patches.map((p) => `${escapeHtml(p.name)} <small>${escapeHtml(p.type)}</small>`).join(", ")}</dd>`}
    </dl>
    ${compact ? "" : `<p class="muted small">${c.solved ? "Add a process (⋯) to visualise it, e.g. a vorticity video." : "Add a process (⋯) to run it, e.g. the flow simulation recipe."}</p>`}
  </div>`;
}
