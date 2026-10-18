/**
 * Cell tracks over the movie they came from, two ways (data-views.ts mounts them). On the slice: the cells
 * near the slice on view, each a dot where it is now and a tail back through its last frames, fading into the
 * past, so the tail's length is how far it went and its bright end where it's going. In 3D: the same tails in
 * the movie's space, in µm, with the slice on view as a plane through them; drag to turn. Both colour a cell
 * by its move (tracks.ts's motionColour), as the legend's wheel shows: its direction round the wheel, grey
 * when it stays put.
 */
import type { Image } from "@pharos/core";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import type { PreviewSampling } from "./api.js";
import { type TrackPoint, type Tracks, type Voxel, fastSpeed, motionColour, trail, trailColour } from "./tracks.js";
import { type ViewState, scaledCopy, thumbnailElement } from "./viewer.js";

/** Frames a tail reaches back. */
export const TAIL = 10;
/** How far from the slice on view a cell still shows on it, in µm: about half a nucleus. */
const NEAR_UM = 3;
/** The stage's background (as `.dv-stage.has-image` and the model view), which 3D tails fade into. */
const STAGE = 0x1e1d1b;
/** On the slice, in screen pixels: a tail's width, and how far a cell's glow reaches (its bright middle is about half that). */
const LINE = 4.5;
const GLOW = 11;
/** The 3D tails' width, in screen pixels: thinner than on the slice, as every cell in the stack shows at once. */
const LINE_3D = 1.75;
/** How much of its colour a tail keeps at its oldest end. */
const OLDEST = 0.25;
/** Steps of a tail, from the cell back, at its full colour before it fades. */
const SOLID = 3;

/**
 * How strong a tail's step is, `back` steps back from the cell (0 is the step that ends at it) of `steps`:
 * full for the newest few, then fading to OLDEST at the oldest.
 */
export function tailStrength(back: number, steps: number): number {
  if (back < SOLID || steps <= SOLID) return 1;
  return 1 - ((1 - OLDEST) * (back - SOLID + 1)) / (steps - SOLID);
}

/** Tracks with the movie (its preview) they're drawn over. */
export interface TrackScene {
  image: Image;
  sampling: PreviewSampling;
  tracks: Tracks;
  /** The full movie's pixel and slice, in its unit (µm, or pixels when it gives none). */
  voxel: Voxel;
  /** A fast cell's speed per frame, at which colours are at their strongest. */
  fast: number;
}

export function trackScene(image: Image, sampling: PreviewSampling, tracks: Tracks): TrackScene {
  const c = image.calibration;
  const voxel = { x: c.pixelWidth / sampling.x, y: c.pixelHeight / sampling.y, z: c.pixelDepth / sampling.z };
  return { image, sampling, tracks, voxel, fast: fastSpeed(tracks, voxel) };
}

/** Whether the cells' depth counts: tracks in 3D over a stack of slices (so a 3D view means something). */
export const isDeep = (s: TrackScene) => s.tracks.hasZ && s.image.shape.slices > 1;

/** How far from the slice on view a cell still shows on it, in the full movie's slices. */
function nearSlices(s: TrackScene): number {
  return s.image.calibration.unit === "pixel" ? 2 : Math.max(1, NEAR_UM / s.voxel.z);
}

/** What the legend says of the cells shown, as the view shows them. */
export function nearText(s: TrackScene, mode: "slice" | "3d"): string {
  if (mode === "3d") return "The slice on view is the plane";
  if (!isDeep(s)) return "";
  return s.image.calibration.unit === "pixel" ? "Cells within 2 slices of this one" : `Cells within ${NEAR_UM} ${s.image.calibration.unit} of this slice`;
}

const rgb = (c: [number, number, number]) => c.map((v) => Math.round(v * 255)).join(",");
/** A colour halfway to white: a glowing cell's middle. */
const whiter = (c: [number, number, number]): [number, number, number] => [0, 1, 2].map((i) => (c[i] + 1) / 2) as [number, number, number];

/**
 * Draws the tracks at the frame and slice on view (Viewer.overlay): the context is in the preview's pixels,
 * and `zoom` screen pixels make one, for line widths that stay the same on screen. Points are in the full
 * movie's pixels, frames and slices; the scene's sampling puts them on the preview.
 */
export function drawTracksOnSlice(ctx: CanvasRenderingContext2D, s: TrackScene, view: ViewState, zoom: number) {
  const { tracks, sampling: sm } = s;
  const t = view.pos.t * sm.t;
  const zNow = view.pos.z * sm.z;
  const near = isDeep(s) ? nearSlices(s) : Infinity;
  // a point is a pixel's middle
  const at = (p: TrackPoint) => [p.x / sm.x + 0.5, p.y / sm.y + 0.5] as const;
  const heads: { p: TrackPoint; c: [number, number, number]; alpha: number }[] = [];
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const p of tracks.byT.get(t) ?? []) {
    const dz = Math.abs(p.z - zNow);
    if (dz > near) continue;
    // fainter the further from the slice, so the cells on it stand out
    const alpha = near === Infinity ? 1 : 1 - 0.55 * (dz / near);
    const path = trail(tracks, p.id, t, TAIL);
    const c = trailColour(path, s.voxel, s.fast);
    const colour = rgb(c);
    const steps = path.length - 1;
    const step = (k: number, style: string, width: number) => {
      ctx.strokeStyle = style;
      ctx.lineWidth = width / zoom;
      ctx.beginPath();
      ctx.moveTo(...at(path[k - 1]));
      ctx.lineTo(...at(path[k]));
      ctx.stroke();
    };
    // a dark edge under the whole tail first, so it reads on bright nuclei too, then the colour over it
    for (let k = 1; k <= steps; k++) step(k, `rgba(0,0,0,${0.4 * alpha * tailStrength(steps - k, steps)})`, LINE + 2);
    for (let k = 1; k <= steps; k++) step(k, `rgba(${colour},${alpha * tailStrength(steps - k, steps)})`, LINE);
    heads.push({ p, c, alpha });
  }
  // the cells over every tail: a glow, bright in the middle and soft at its edge
  for (const { p, c, alpha } of heads) {
    const [x, y] = at(p);
    const r = GLOW / zoom;
    const glow = ctx.createRadialGradient(x, y, 0, x, y, r);
    glow.addColorStop(0, `rgba(${rgb(whiter(c))},${alpha})`);
    glow.addColorStop(0.45, `rgba(${rgb(c)},${alpha})`);
    glow.addColorStop(1, `rgba(${rgb(c)},0)`);
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, 2 * Math.PI);
    ctx.fill();
  }
}

/** The legend's wheel: a move's colour by its direction (round the wheel, as on the image) and speed (out from the grey middle). */
export function drawWheel(canvas: HTMLCanvasElement) {
  const n = canvas.width;
  const r = n / 2;
  const ctx = canvas.getContext("2d")!;
  const data = ctx.createImageData(n, n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const dx = i + 0.5 - r;
      const dy = j + 0.5 - r;
      const d = Math.hypot(dx, dy);
      if (d > r) continue;
      const c = motionColour(dx, dy, d, r);
      const k = (j * n + i) * 4;
      [data.data[k], data.data[k + 1], data.data[k + 2]] = c.map((v) => Math.round(v * 255));
      data.data[k + 3] = Math.round(255 * Math.min(1, r - d)); // a soft rim
    }
  }
  ctx.putImageData(data, 0, 0);
}

/** A 3D cell's glow, as on the slice: white (the cell's colour tints it), bright in the middle and soft at its edge. */
function glowTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d")!;
  const glow = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  glow.addColorStop(0, "rgba(255,255,255,1)");
  glow.addColorStop(0.45, "rgba(255,255,255,0.95)");
  glow.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

/**
 * The tracks in 3D, in the movie's own units (so a stack with deep slices keeps its shape): its box, the slice
 * on view as a plane, every cell at the frame on view as a dot, and each one's tail. The stack's depth is up,
 * its first slice on top. Like the model view, it draws only while something changes.
 */
export class TracksIn3D {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(40, 1, 0.1, 1000);
  private readonly controls: OrbitControls;
  private readonly resize: ResizeObserver;
  private readonly lines = new LineMaterial({ vertexColors: true, linewidth: LINE_3D });
  private readonly dots: THREE.PointsMaterial;
  private readonly plane: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private tails: LineSegments2 | null = null;
  private cells: THREE.Points | null = null;
  /** The full movie's size in its units, and where its middle is in its pixels and slices. */
  private readonly size: THREE.Vector3;
  private readonly middle: THREE.Vector3;
  private frame = 0;
  private drawing = false;
  private shown = "";

  constructor(
    private readonly host: HTMLElement,
    private readonly s: TrackScene,
    private readonly view: ViewState,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(devicePixelRatio);
    this.renderer.setClearColor(STAGE);
    host.append(this.renderer.domElement);

    const { width, height, slices } = s.image.shape;
    const full = new THREE.Vector3(width * s.sampling.x, height * s.sampling.y, slices * s.sampling.z);
    this.middle = full.clone().multiplyScalar(0.5);
    this.size = new THREE.Vector3(full.x * s.voxel.x, full.y * s.voxel.y, full.z * s.voxel.z);
    const box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(this.size.x, this.size.y, this.size.z)), new THREE.LineBasicMaterial({ color: 0x6b665e }));
    this.scene.add(box);
    this.plane = new THREE.Mesh(
      new THREE.PlaneGeometry(this.size.x, this.size.y),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }),
    );
    this.scene.add(this.plane);
    const reach = this.size.length();
    // soft-edged, so drawn after the solid things and without hiding what's behind their edges
    this.dots = new THREE.PointsMaterial({ size: reach / 36, sizeAttenuation: true, vertexColors: true, map: glowTexture(), transparent: true, depthWrite: false });

    // a three-quarter view from above the stack's front, its first slice on top
    this.camera.up.set(0, 0, 1);
    this.camera.near = reach / 100;
    this.camera.far = reach * 20;
    this.camera.position.set(0.55, -1.1, 0.75).normalize().multiplyScalar(reach * 1.25);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.update();

    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(host);
    this.fit();
    this.controls.addEventListener("change", this.redraw);
    this.update();
  }

  /**
   * A point in the full movie's pixels and slices (a pixel's middle), in the scene: centred, in its units,
   * y and depth flipped so the image reads as on the slice.
   */
  private place(x: number, y: number, z: number): [number, number, number] {
    const { voxel: v } = this.s;
    return [(x + 0.5 - this.middle.x) * v.x, (this.middle.y - y - 0.5) * v.y, (this.middle.z - z - 0.5) * v.z];
  }

  /** Brings it to the frame, slice, channel and contrast on view. */
  update() {
    const { tracks, sampling: sm } = this.s;
    const { pos } = this.view;
    const t = pos.t * sm.t;
    const key = `${t}`;
    if (key !== this.shown) {
      this.shown = key;
      this.tails?.geometry.dispose();
      if (this.tails) this.scene.remove(this.tails);
      this.cells?.geometry.dispose();
      if (this.cells) this.scene.remove(this.cells);
      const segs: number[] = [];
      const colours: number[] = [];
      const dots: number[] = [];
      const dotColours: number[] = [];
      const stage = new THREE.Color(STAGE);
      for (const p of tracks.byT.get(t) ?? []) {
        const path = trail(tracks, p.id, t, TAIL);
        // the same colour as on the slice (given in sRGB, as the canvas takes it)
        const c = new THREE.Color().setRGB(...trailColour(path, this.s.voxel, this.s.fast), THREE.SRGBColorSpace);
        // fading into the past: the colour mixed into the stage's, as lines here take no alpha of their own
        const steps = path.length - 1;
        // a point's colour: its step's strength (the point that ends the newest step is the cell's own)
        const at = (k: number) => stage.clone().lerp(c, tailStrength(Math.max(0, steps - k - 1), steps));
        for (let k = 1; k < path.length; k++) {
          segs.push(...this.place(path[k - 1].x, path[k - 1].y, path[k - 1].z), ...this.place(path[k].x, path[k].y, path[k].z));
          const [a, b] = [at(k - 1), at(k)];
          colours.push(a.r, a.g, a.b, b.r, b.g, b.b);
        }
        dots.push(...this.place(p.x, p.y, p.z));
        dotColours.push(c.r, c.g, c.b);
      }
      if (segs.length) {
        this.tails = new LineSegments2(new LineSegmentsGeometry().setPositions(segs).setColors(colours), this.lines);
        this.scene.add(this.tails);
      } else this.tails = null;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(dots, 3));
      g.setAttribute("color", new THREE.Float32BufferAttribute(dotColours, 3));
      this.cells = new THREE.Points(g, this.dots);
      this.scene.add(this.cells);
    }
    // the slice on view, as the slice view shows it, where it is in the stack
    this.plane.material.map?.dispose();
    const tex = new THREE.CanvasTexture(thumbnailElement(this.s.image, this.view, 1024));
    tex.colorSpace = THREE.SRGBColorSpace;
    this.plane.material.map = tex;
    this.plane.material.needsUpdate = true;
    this.plane.position.z = this.place(0, 0, pos.z * sm.z)[2];
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

  /** What it shows now, small (for the minimised-window shelf). */
  snapshot(max: number): HTMLCanvasElement | null {
    const canvas = this.renderer.domElement;
    if (!canvas.width || !canvas.height) return null;
    this.renderer.render(this.scene, this.camera);
    return scaledCopy(canvas, canvas.width, canvas.height, max);
  }

  private fit() {
    const { clientWidth: w, clientHeight: h } = this.host;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.lines.resolution.set(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.redraw();
  }

  destroy() {
    cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    this.controls.removeEventListener("change", this.redraw);
    this.controls.dispose();
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments || o instanceof THREE.Points || o instanceof LineSegments2) o.geometry.dispose();
    });
    this.plane.material.map?.dispose();
    this.plane.material.dispose();
    this.dots.map?.dispose();
    this.dots.dispose();
    this.lines.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
