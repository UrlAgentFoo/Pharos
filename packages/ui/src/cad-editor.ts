/**
 * The CAD editor: what an expanded window shows for a STEP part, all inside
 * the window's body (the Controls keep the window's overall actions, and the
 * history its steps). A row of tools on top; the part's size, holes and
 * faces down the left; the part in 3D, where a click picks a face; and the
 * chosen tool's settings over the view, with one button named for the edit.
 *
 * FreeCAD does the work in a container that stays up (the freecad ship):
 * `inspect` numbers the part's faces and holes and draws it with those
 * numbers, and each edit is a ship operation that lands in the window's
 * history as a new part, so undo is the history and the edited part flows
 * into whatever comes next (a load test, a print). Pressing the edit's
 * button is the approval. A normal window, and every result that isn't a
 * STEP part, are shown as before.
 */
import type { Artifact, Job, ParamSpec, Params } from "@pharos/contracts";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js";
import type { LocalServer } from "./api.js";
import type { Mounted } from "./data-views.js";
import { escapeHtml, formatSize } from "./dialogs.js";
import { icon } from "./icons.js";
import { upAxis } from "./model-view.js";
import { manifestParamFields, readManifestParams } from "./param-fields.js";
import { barHtml, clockHtml } from "./progress.js";
import { scaledCopy } from "./viewer.js";

/** The ship that edits, and the parts it takes. */
const SHIP = "freecad";
export const isEditablePart = (a: Artifact) => a.kind === "cad" && a.format === "step";

interface PartFace {
  id: number;
  type: string;
  area: number;
  center: number[];
  normal?: number[];
  size?: number[];
  diameter?: number;
  hole?: boolean;
}
interface PartHole {
  id: number;
  faces: number[];
  diameter: number;
  depth: number;
}
interface PartInfo {
  size: [number, number, number];
  min: number[];
  max: number[];
  volume: number;
  faces: PartFace[];
  holes: PartHole[];
}

export interface CadEditorHooks {
  server(): LocalServer | null;
  /** The settings a ship operation takes, from its manifest, to lay out a tool's form. */
  specs(run: string): ParamSpec[];
  /** Adds the edit to the window's history, on the part on view, and runs it. */
  edit(run: string, params: Params): void;
}

type Tool = "select" | "stretch" | "push-pull" | "hole" | "fillet" | "remove" | "transform";

const TOOLS: { id: Tool; title: string; icon: string; help: string }[] = [
  { id: "select", title: "Select", icon: "select", help: "Click a face, or pick one in the list, to see what you can do with it." },
  { id: "stretch", title: "Length", icon: "ruler", help: "Makes the part longer or shorter: it's cut across where the plane shows, and the gap is filled with its own shape. Cut where the part is the same all along." },
  { id: "push-pull", title: "Push/pull", icon: "expand", help: "Moves a flat face out to add material, or in to take it away. Pick a flat face." },
  { id: "hole", title: "Hole", icon: "tool-oval", help: "Gives a hole a new diameter, or fills it (0). Pick a hole's wall, or a hole in the list." },
  { id: "fillet", title: "Round", icon: "tool-freehand", help: "Rounds every edge around a face. Pick the face." },
  { id: "remove", title: "Remove", icon: "trash", help: "Takes features off (a fillet, a hole, a boss) and closes the part up. Pick all their faces: Shift-click adds one." },
  { id: "transform", title: "Move", icon: "rotate-right", help: "Scales, mirrors, turns and moves the whole part, about its middle." },
];

/** Settings a tool fills in from the selection, so its form leaves them out. */
const PICKED = new Set(["face", "faces"]);

const AXIS = ["x", "y", "z"] as const;
const fmt = (n: number) => Number(n.toPrecision(4)).toLocaleString();

/** A part read once per workspace: the cache makes it instant when the window opens again. */
const inspected = new Map<string, Promise<{ info: PartInfo; ply: ArrayBuffer }>>();

export class CadEditor implements Mounted {
  private view: CadView | null = null;
  private info: PartInfo | null = null;
  private tool: Tool = "select";
  private picked = new Set<number>();
  private gone = false;
  private readonly el: HTMLElement;

  constructor(
    private readonly host: HTMLElement,
    private readonly workspace: string,
    private readonly part: Artifact,
    private readonly hooks: CadEditorHooks,
  ) {
    host.classList.add("has-model");
    host.innerHTML = `<div class="cad-ed">
      <div class="cad-tools" role="toolbar" aria-label="Edit tools">${TOOLS.map((t) => `<button type="button" class="cad-tool" data-tool="${t.id}" aria-pressed="false" title="${escapeHtml(t.help)}">${icon(t.icon, 15)}<span>${t.title}</span></button>`).join("")}</div>
      <aside class="cad-tree" aria-label="The part"><p class="muted small">Reading the part…</p></aside>
      <div class="cad-view"></div>
      <section class="cad-panel" aria-label="Edit settings"></section>
    </div>`;
    this.el = host.querySelector(".cad-ed")!;
    this.el.addEventListener("click", (e) => this.onClick(e));
    this.el.addEventListener("pointerover", (e) => this.onHoverList(e));
    this.el.addEventListener("pointerleave", () => this.view?.hover(null));
    this.el.addEventListener("input", () => this.preview());
    this.el.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.picked.size) {
        e.stopPropagation();
        this.select(null, false);
      }
    });
    this.renderTools();
    void this.start();
  }

  // ---------------------------------------------------------- loading

  /** Reads the part, once FreeCAD is on this computer: getting it is a download, so it waits for a click. */
  private async start(build = false) {
    const s = this.hooks.server();
    if (!s) return this.message("The editor needs Pharos's local server.");
    const key = `${this.workspace}/${this.part.id}`;
    if (!inspected.has(key)) {
      const ship = (await s.ships().catch(() => [])).find((x) => x.id === SHIP);
      if (this.gone) return;
      if (!ship) return this.message("The editor needs the freecad ship, which isn't in the library.");
      if (!ship.installed && !build) {
        const size = ship.imageSizeBytes ? formatSize(ship.imageSizeBytes) : "about 1.7 GB";
        this.panel(
          `<p class="cad-panel-title">Edit this part with FreeCAD</p>
           <p class="muted small">The editor runs FreeCAD on this computer, in the freecad ship. It isn't here yet: getting it is ${escapeHtml(size)}, once.</p>
           <button type="button" class="primary" data-act="get">${icon("ship", 14)} Get FreeCAD ready</button>`,
        );
        this.tree(`<p class="muted small">The part's faces and holes show here once FreeCAD has read it.</p>`);
        return;
      }
      inspected.set(key, read(s, this.workspace, this.part, (job) => !this.gone && this.waiting(job)));
    }
    try {
      const { info, ply } = await inspected.get(key)!;
      if (this.gone) return;
      this.info = info;
      this.view = new CadView(this.el.querySelector<HTMLElement>(".cad-view")!, ply, info, (face, add) => this.select(face, add), (face) => this.hoverRow(face));
      this.renderTree();
      this.renderPanel();
    } catch (e) {
      inspected.delete(key); // try again next time
      if (!this.gone) this.message(`FreeCAD couldn't read this part: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** While FreeCAD is fetched, built or reading: the phase (announced once), a clock, a bar and its latest line. */
  private waiting(job: Job) {
    const phase = job.state === "downloading" ? "Getting FreeCAD ready" : job.state === "queued" ? "Waiting for a free slot" : "FreeCAD is reading the part";
    const msg = this.el.querySelector<HTMLElement>(`.cad-panel [data-phase="${phase}"] .pg-msg`);
    if (msg) {
      msg.textContent = job.message ?? "";
      return;
    }
    const since = Date.parse(job.startedAt ?? job.createdAt);
    this.panel(
      `<p class="pg" data-phase="${phase}"><span class="pg-head"><span class="pg-phase" role="status">${phase}</span>${clockHtml(since)}</span>${barHtml()}
       <span class="pg-msg">${escapeHtml(job.message ?? "")}</span></p>`,
    );
  }

  private message(text: string) {
    this.panel(`<p class="chat-warn">${escapeHtml(text)}</p>`);
  }

  private panel(html: string) {
    this.el.querySelector<HTMLElement>(".cad-panel")!.innerHTML = html;
  }

  private tree(html: string) {
    this.el.querySelector<HTMLElement>(".cad-tree")!.innerHTML = html;
  }

  // ---------------------------------------------------------- the tools, the list and the panel

  private renderTools() {
    for (const b of this.el.querySelectorAll<HTMLButtonElement>("[data-tool]")) {
      const on = b.dataset.tool === this.tool;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
    }
  }

  /** The part's size, its holes, then its faces: flat ones, then round ones. */
  private renderTree() {
    const info = this.info!;
    const [sx, sy, sz] = info.size;
    const row = (face: number, title: string, detail: string) =>
      `<li><button type="button" class="cad-row${this.picked.has(face) ? " on" : ""}" data-face="${face}" aria-pressed="${this.picked.has(face)}">${escapeHtml(title)}<small>${escapeHtml(detail)}</small></button></li>`;
    const holes = info.holes.map(
      (h) =>
        `<li><button type="button" class="cad-row${h.faces.every((f) => this.picked.has(f)) ? " on" : ""}" data-hole="${h.id}">Hole ${h.id}<small>⌀${fmt(h.diameter)} mm · ${fmt(h.depth)} mm deep</small></button></li>`,
    );
    const flat = info.faces.filter((f) => f.type === "flat");
    const round = info.faces.filter((f) => f.type !== "flat" && !f.hole);
    this.tree(`
      <p class="cad-size"><strong>${fmt(sx)} × ${fmt(sy)} × ${fmt(sz)} mm</strong><small>${fmt(info.volume / 1000)} cm³ · ${info.faces.length} faces</small></p>
      ${holes.length ? `<p class="eyebrow">Holes</p><ul class="cad-list">${holes.join("")}</ul>` : ""}
      ${flat.length ? `<p class="eyebrow">Flat faces</p><ul class="cad-list">${flat.map((f) => row(f.id, `Face ${f.id}`, `${f.size ? `${fmt(f.size[0])} × ${fmt(f.size[1])} mm · ` : ""}faces ${facing(f.normal)}`)).join("")}</ul>` : ""}
      ${round.length ? `<p class="eyebrow">Curved faces</p><ul class="cad-list">${round.map((f) => row(f.id, `Face ${f.id}`, `${f.type}${f.diameter ? ` ⌀${fmt(f.diameter)} mm` : ""}`)).join("")}</ul>` : ""}`);
  }

  /** The tool's settings, filled in from the part and what's picked, and its one button. */
  private renderPanel() {
    const info = this.info;
    if (!info) return;
    const tool = TOOLS.find((t) => t.id === this.tool)!;
    const faces = [...this.picked];
    const face = faces.length === 1 ? info.faces.find((f) => f.id === faces[0]) : undefined;
    const hole = face && info.holes.find((h) => h.faces.includes(face.id));
    const head = `<p class="cad-panel-title">${escapeHtml(tool.title === "Move" ? "Move, turn or scale" : tool.title)}</p>`;
    let need = "";
    let values: Params = {};
    let button = "";
    switch (this.tool) {
      case "select": {
        if (!faces.length) return this.panel(`${head}<p class="muted small">${escapeHtml(tool.help)}</p>`);
        const what = hole ? `Hole ${hole.id}: ⌀${fmt(hole.diameter)} mm, ${fmt(hole.depth)} mm deep` : face ? describe(face) : `${faces.length} faces: ${faces.join(", ")}`;
        const offer = (t: Tool, label: string) => `<button type="button" class="chip" data-tool="${t}">${label}</button>`;
        const offers = [
          face?.type === "flat" && offer("push-pull", "Push or pull it"),
          hole && offer("hole", "Change its size"),
          face && offer("fillet", "Round its edges"),
          offer("remove", faces.length > 1 ? "Take them off" : "Take it off"),
        ].filter(Boolean);
        return this.panel(`${head}<p class="cad-picked">${escapeHtml(what)}</p><div class="cad-offers">${offers.join("")}</div>
          <p class="muted small">Esc lets go of it.</p>`);
      }
      case "stretch": {
        const axis = AXIS[info.size.indexOf(Math.max(...info.size))];
        values = { axis, length: info.size[AXIS.indexOf(axis)] };
        button = "Change the length";
        break;
      }
      case "push-pull":
        if (face?.type !== "flat") need = "Pick a flat face: click it, or choose one under Flat faces.";
        values = { face: face?.id ?? 0 };
        button = "Move the face";
        break;
      case "hole":
        if (!hole) need = "Pick a hole: click its wall, or choose one under Holes.";
        values = { face: face?.id ?? 0, diameter: hole?.diameter ?? 0 };
        button = "Change the hole";
        break;
      case "fillet":
        if (!face) need = "Pick one face: its edges get rounded.";
        values = { face: face?.id ?? 0 };
        button = "Round the edges";
        break;
      case "remove":
        if (!faces.length) need = "Pick every face of the feature to take off: Shift-click adds one.";
        values = { faces: faces.join(", ") };
        button = faces.length > 1 ? `Take off ${faces.length} faces` : "Take it off";
        break;
      case "transform":
        button = "Move the part";
        break;
    }
    const specs = this.formSpecs();
    this.panel(`${head}<p class="muted small">${escapeHtml(tool.help)}</p>
      ${faces.length && this.tool !== "stretch" && this.tool !== "transform" ? `<p class="cad-picked">${escapeHtml(this.tool === "hole" && hole ? `Hole ${hole.id}, ⌀${fmt(hole.diameter)} mm` : faces.length === 1 && face ? describe(face) : `Faces ${faces.join(", ")}`)}</p>` : ""}
      ${need ? `<p class="cad-need">${escapeHtml(need)}</p>` : ""}
      <form class="cad-form"${need ? " inert" : ""}>${manifestParamFields(specs, values)}
        <button type="submit" class="primary run-btn" data-act="apply"${need ? " disabled" : ""}><span>${escapeHtml(button)}</span>${icon("arrow-right", 14)}</button>
      </form>`);
    this.el.querySelector("form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      this.apply();
    });
    this.preview();
  }

  /** The tool's settings that a person sets: the face it works on comes from the selection. */
  private formSpecs(): ParamSpec[] {
    return this.tool === "select" ? [] : this.hooks.specs(`${SHIP}.${this.tool}`).filter((p) => !PICKED.has(p.name));
  }

  /** Shows what the form will do: for Length, where the part is cut. */
  private preview() {
    if (!this.view || !this.info) return;
    const form = this.el.querySelector<HTMLFormElement>(".cad-form");
    if (this.tool !== "stretch" || !form) return this.view.plane(null);
    const v = readManifestParams(this.formSpecs(), form);
    const k = AXIS.indexOf((v.axis as (typeof AXIS)[number]) ?? "x");
    const at = Number(v.at ?? 0.5);
    this.view.plane({ axis: k, at: this.info.min[k] + this.info.size[k] * Math.min(1, Math.max(0, at)) });
  }

  private apply() {
    const form = this.el.querySelector<HTMLFormElement>(".cad-form");
    if (!form?.reportValidity() || !this.info) return;
    const params: Params = readManifestParams(this.formSpecs(), form);
    const faces = [...this.picked];
    if (this.tool === "remove") params.faces = faces.join(", ");
    else if (this.tool !== "stretch" && this.tool !== "transform") params.face = faces[0];
    this.hooks.edit(`${SHIP}.${this.tool}`, params);
  }

  // ---------------------------------------------------------- picking

  private select(face: number | null, add: boolean) {
    if (face === null) this.picked.clear();
    else if (add || this.tool === "remove") {
      if (!this.picked.delete(face)) this.picked.add(face);
    } else {
      // a click on a hole's wall picks the whole hole
      const hole = this.info?.holes.find((h) => h.faces.includes(face));
      this.picked = new Set(hole && this.tool !== "fillet" ? hole.faces : [face]);
    }
    this.view?.highlight(this.picked);
    this.renderTree();
    this.renderPanel();
  }

  private hoverRow(face: number | null) {
    for (const b of this.el.querySelectorAll<HTMLElement>(".cad-row")) b.classList.toggle("hover", face !== null && b.dataset.face === String(face));
  }

  private onHoverList(e: PointerEvent) {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".cad-row");
    if (!row || !this.view) return;
    const hole = row.dataset.hole && this.info?.holes.find((h) => String(h.id) === row.dataset.hole);
    this.view.hover(hole ? hole.faces[0] : Number(row.dataset.face));
  }

  private onClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    const tool = t.closest<HTMLElement>("[data-tool]")?.dataset.tool as Tool | undefined;
    if (tool) {
      this.tool = tool;
      this.renderTools();
      return this.renderPanel();
    }
    if (t.closest("[data-act='get']")) return void this.start(true);
    const row = t.closest<HTMLElement>(".cad-row");
    if (row?.dataset.hole) {
      const hole = this.info?.holes.find((h) => String(h.id) === row.dataset.hole);
      if (hole) this.select(hole.faces[0], false);
    } else if (row?.dataset.face) this.select(Number(row.dataset.face), e.shiftKey);
  }

  snapshot(max: number): HTMLCanvasElement | null {
    return this.view?.snapshot(max) ?? null;
  }

  destroy() {
    this.gone = true;
    this.view?.destroy();
    this.host.classList.remove("has-model");
  }
}

/** "+z", "−x", or "at an angle": which way a flat face looks. */
function facing(n: number[] | undefined): string {
  if (!n) return "";
  const k = n.findIndex((c) => Math.abs(c) > 0.999);
  return k < 0 ? "at an angle" : `${n[k] > 0 ? "+" : "−"}${AXIS[k]}`;
}

function describe(f: PartFace): string {
  if (f.type === "flat") return `Face ${f.id}: flat${f.size ? `, ${fmt(f.size[0])} × ${fmt(f.size[1])} mm` : ""}, facing ${facing(f.normal)}`;
  return `Face ${f.id}: ${f.type}${f.diameter ? `, ⌀${fmt(f.diameter)} mm` : ""}`;
}

/** Runs freecad's inspect on the part as a job of its own (cached like any operation): its numbers and its numbered model. */
async function read(s: LocalServer, workspace: string, part: Artifact, onJob: (job: Job) => void): Promise<{ info: PartInfo; ply: ArrayBuffer }> {
  let job: Job = await s.runJob({ workspace, tool: `${SHIP}.inspect`, inputs: { part: part.id } });
  while (job.state !== "done" && job.state !== "failed" && job.state !== "cancelled") {
    onJob(job);
    await new Promise((ok) => setTimeout(ok, 400));
    job = await s.job(job.id);
  }
  if (job.state !== "done" || !job.outputs?.faces || !job.outputs.model) throw new Error(job.error ?? job.state);
  const [faces, ply] = await Promise.all([s.content(workspace, job.outputs.faces), s.content(workspace, job.outputs.model)]);
  return { info: JSON.parse(new TextDecoder().decode(faces)) as PartInfo, ply };
}

// ---------------------------------------------------------- the 3D view

/** A colour token from the stylesheet, so the view follows the theme's meanings (the accent is what's picked). */
const token = (name: string, fallback: string) => new THREE.Color(getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback);

/**
 * The part in 3D, each face of it numbered (the PLY's `face_id`): a click
 * that doesn't drag picks a face, hovering lights one, and the picked faces
 * show in the accent colour. Drawn only on change, like ModelView.
 */
class CadView {
  private readonly renderer = new THREE.WebGLRenderer({ antialias: true });
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
  private readonly controls: OrbitControls;
  private readonly resize: ResizeObserver;
  private readonly mesh: THREE.Mesh;
  private readonly ids: ArrayLike<number>;
  private readonly colors: THREE.BufferAttribute;
  private readonly cut: THREE.Mesh;
  private readonly size: number[];
  private readonly base = new THREE.Color(0xbfc4cc);
  private readonly accent = token("--accent", "#2f6fd6");
  private picked = new Set<number>();
  private hovered: number | null = null;
  private down: { x: number; y: number } | null = null;
  private frame = 0;
  private drawing = false;

  constructor(
    private readonly host: HTMLElement,
    ply: ArrayBuffer,
    info: PartInfo,
    private readonly onPick: (face: number | null, add: boolean) => void,
    private readonly onHover: (face: number | null) => void,
  ) {
    this.renderer.setPixelRatio(devicePixelRatio);
    this.renderer.setClearColor(0x1e1d1b);
    host.append(this.renderer.domElement);
    const loader = new PLYLoader();
    loader.setCustomPropertyNameMapping({ faceId: ["face_id"] });
    const geometry = loader.parse(ply);
    this.ids = (geometry.getAttribute("faceId") as THREE.BufferAttribute).array;
    this.colors = new THREE.BufferAttribute(new Float32Array(this.ids.length * 3), 3);
    geometry.setAttribute("color", this.colors);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    this.mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.05, side: THREE.DoubleSide }));
    this.scene.add(this.mesh);
    this.paint();

    // where Length will cut: a see-through plane across the part, a little larger than its cross-section
    this.size = info.size;
    this.cut = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: this.accent, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }));
    this.cut.visible = false;
    this.cut.position.set(...(info.min.map((m, i) => m + info.size[i] / 2) as [number, number, number]));
    this.scene.add(this.cut);

    // lit and framed as ModelView frames a part that says which way is up
    const up = upAxis(ply) ?? new THREE.Vector3(0, 0, 1);
    const turn = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
    const sky = new THREE.HemisphereLight(0xffffff, 0x44403c, 1.6);
    sky.position.set(0, 1, 0).applyQuaternion(turn);
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(1, 2, 3).applyQuaternion(turn);
    this.scene.add(sky, sun);
    this.camera.up.copy(up);
    const { center, radius } = geometry.boundingSphere!;
    this.camera.near = radius / 100;
    this.camera.far = radius * 100;
    this.camera.position.copy(center).add(new THREE.Vector3(0.7, 0.9, 1.3).applyQuaternion(turn).normalize().multiplyScalar(radius * 2.6));
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.copy(center);
    this.controls.enableDamping = true;
    this.controls.update();

    const canvas = this.renderer.domElement;
    canvas.addEventListener("pointerdown", this.onDown);
    canvas.addEventListener("pointerup", this.onUp);
    canvas.addEventListener("pointermove", this.onMove);
    canvas.addEventListener("pointerleave", this.onLeave);
    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(host);
    this.fit();
    this.controls.addEventListener("change", this.redraw);
  }

  /** The face under a point on the canvas, or null. */
  private faceAt(e: PointerEvent): number | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera);
    const hit = ray.intersectObject(this.mesh)[0];
    return hit?.face ? this.ids[hit.face.a] : null;
  }

  private onDown = (e: PointerEvent) => {
    this.down = { x: e.clientX, y: e.clientY };
  };

  /** A click that didn't turn the view picks the face under it (Shift adds it); on empty space it lets go. */
  private onUp = (e: PointerEvent) => {
    const d = this.down;
    this.down = null;
    if (!d || e.button !== 0 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
    this.onPick(this.faceAt(e), e.shiftKey);
  };

  private onMove = (e: PointerEvent) => {
    if (e.buttons) return;
    const face = this.faceAt(e);
    if (face === this.hovered) return;
    this.hover(face);
    this.onHover(face);
  };

  private onLeave = () => {
    this.hover(null);
    this.onHover(null);
  };

  hover(face: number | null) {
    this.hovered = face;
    this.renderer.domElement.style.cursor = face === null ? "" : "pointer";
    this.paint();
  }

  highlight(faces: Set<number>) {
    this.picked = new Set(faces);
    this.paint();
  }

  /** Shows where Length cuts (axis 0-2, at a coordinate in mm), or hides it. */
  plane(cut: { axis: number; at: number } | null) {
    this.cut.visible = !!cut;
    if (cut) {
      // the plane faces z; turned to face x its sides lie along z and y, turned to face y along x and z
      const [w, h] = [[2, 1], [0, 2], [0, 1]][cut.axis].map((k) => Math.max(this.size[k] * 1.2, Math.max(...this.size) * 0.1));
      this.cut.rotation.set(cut.axis === 1 ? Math.PI / 2 : 0, cut.axis === 0 ? Math.PI / 2 : 0, 0);
      this.cut.scale.set(w, h, 1);
      this.cut.position.setComponent(cut.axis, cut.at);
    }
    this.redraw();
  }

  /** Every vertex coloured by its face: picked in the accent, the hovered face lighter. */
  private paint() {
    const c = new THREE.Color();
    const hover = this.base.clone().lerp(this.accent, 0.35);
    const a = this.colors.array as Float32Array;
    for (let i = 0; i < this.ids.length; i++) {
      const id = this.ids[i];
      c.copy(this.picked.has(id) ? this.accent : id === this.hovered ? hover : this.base);
      a[i * 3] = c.r;
      a[i * 3 + 1] = c.g;
      a[i * 3 + 2] = c.b;
    }
    this.colors.needsUpdate = true;
    this.redraw();
  }

  private redraw = () => {
    if (this.drawing) return;
    this.drawing = true;
    this.frame = requestAnimationFrame(this.step);
  };

  private step = () => {
    this.drawing = false;
    const moving = this.controls.update();
    this.renderer.render(this.scene, this.camera);
    if (moving) this.redraw();
  };

  private fit() {
    const { clientWidth: w, clientHeight: h } = this.host;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.redraw();
  }

  snapshot(max: number): HTMLCanvasElement | null {
    const canvas = this.renderer.domElement;
    if (!canvas.width || !canvas.height) return null;
    this.renderer.render(this.scene, this.camera);
    return scaledCopy(canvas, canvas.width, canvas.height, max);
  }

  destroy() {
    cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    const canvas = this.renderer.domElement;
    canvas.removeEventListener("pointerdown", this.onDown);
    canvas.removeEventListener("pointerup", this.onUp);
    canvas.removeEventListener("pointermove", this.onMove);
    canvas.removeEventListener("pointerleave", this.onLeave);
    this.controls.removeEventListener("change", this.redraw);
    this.controls.dispose();
    this.mesh.geometry.dispose();
    this.renderer.dispose();
    canvas.remove();
  }
}
