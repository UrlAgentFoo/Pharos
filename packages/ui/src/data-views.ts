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
import type { LocalServer } from "./api.js";
import { parseCsv } from "./csv.js";
import { escapeHtml, formatSize } from "./dialogs.js";
import { ModelView } from "./model-view.js";
import { type ViewState, Viewer, newViewState, setRanges } from "./viewer.js";

/** What a viewer needs for one artifact, fetched once and kept while its window is open. */
export type Loaded =
  | { type: "image"; image: Image; view: ViewState }
  | { type: "table"; rows: string[][]; total: number }
  | { type: "video"; url: string }
  | { type: "model"; ply: ArrayBuffer }
  | { type: "case"; summary: CaseSummary }
  | { type: "text"; text: string }
  | { type: "info" }
  | { type: "error"; message: string };

/** A viewer drawn into an element; destroy it before reusing the element. */
export interface Mounted {
  destroy(): void;
}

export async function loadView(s: LocalServer, workspace: string, a: Artifact): Promise<Loaded> {
  try {
    if (a.kind === "volume" || a.kind === "labels") {
      const image = await readTiff(await s.artifactImage(workspace, a.id), a.name);
      const view = newViewState(image);
      view.labels = a.kind === "labels";
      // open stacks in the middle, where the objects usually are, not on the (often empty) first slice
      view.pos.z = Math.floor(image.shape.slices / 2);
      return { type: "image", image, view };
    }
    if (a.format === "csv") {
      const text = new TextDecoder().decode(await s.content(workspace, a.id));
      return { type: "table", rows: parseCsv(text, 501), total: text.split("\n").filter((l) => l.trim()).length - 1 };
    }
    if (a.kind === "mesh" && a.format === "ply") return { type: "model", ply: await s.content(workspace, a.id) };
    if (a.format === "mp4") return { type: "video", url: URL.createObjectURL(new Blob([await s.content(workspace, a.id)], { type: "video/mp4" })) };
    if (a.format === "openfoam-case") return { type: "case", summary: await s.caseSummary(workspace, a.id) };
    if (a.format === "json") return { type: "text", text: new TextDecoder().decode(await s.content(workspace, a.id)) };
    return { type: "info" };
  } catch (e) {
    return { type: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

/** Frees what a loaded entry holds outside the page (video blobs). */
export function releaseView(entry: Loaded) {
  if (entry.type === "video") URL.revokeObjectURL(entry.url);
}

/**
 * Draws `entry` into `host` (a `.dv-stage`). `compact` is for grid tiles:
 * no hints or footers, and videos without controls until hovered.
 */
export function mountView(host: HTMLElement, entry: Loaded, a: Artifact, compact = false): Mounted & { viewer?: Viewer } {
  host.classList.remove("has-image", "has-model");
  const none = { destroy() {} };
  switch (entry.type) {
    case "image": {
      const { slices, frames, channels } = entry.image.shape;
      // a tile has its own view, opened on the middle slice where objects usually are
      const view = compact ? { ...entry.view, pos: { ...entry.view.pos, z: Math.floor(slices / 2) }, placed: false } : entry.view;
      host.classList.add("has-image");
      host.innerHTML = `<div class="dv-canvas"><canvas tabindex="0"></canvas><div class="win-readout"></div></div>
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
        }),
      );
      host.querySelectorAll<HTMLButtonElement>("[data-range]").forEach((b) =>
        b.addEventListener("click", () => {
          setRanges(view, entry.image, b.dataset.range as "auto" | "full");
          viewer.render();
        }),
      );
      return { viewer, destroy() {} };
    }
    case "table":
      host.innerHTML = `<div class="dv-table artifact-table"><table><thead><tr>${(entry.rows[0] ?? []).map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>
        <tbody>${entry.rows.slice(1).map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
        ${compact ? "" : `<p class="dv-foot">${entry.total} rows${entry.total > 500 ? " · first 500 shown" : ""} · ${formatSize(a.sizeBytes ?? 0)}</p>`}`;
      return none;
    case "video":
      host.innerHTML = `<video class="dv-video" src="${entry.url}" ${compact ? "" : "controls"} autoplay loop muted playsinline></video>`;
      return none;
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
    case "case":
      host.innerHTML = caseCard(entry.summary, a, compact);
      return none;
    case "text":
      host.innerHTML = `<pre class="code dv-text">${escapeHtml(entry.text)}</pre>`;
      return none;
    case "error":
      host.innerHTML = card("Can't show this", escapeHtml(entry.message));
      return none;
    default:
      host.innerHTML = `<div class="dv-card"><p class="eyebrow">${escapeHtml(a.kind)} · ${escapeHtml(a.format)}</p><h3>${escapeHtml(a.name ?? a.id)}</h3>
        <p class="muted">Pharos can't show this kind of data inside a window yet. It's stored at:</p><pre class="code">${escapeHtml(a.uri)}</pre></div>`;
      return none;
  }
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
