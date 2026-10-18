/**
 * A 3D model in a data window: a PLY mesh with per-vertex colours (an
 * OpenFOAM case's surfaces, segmented objects), lit softly and framed to
 * fit, or a PLY point cloud (a scene's sparse points from COLMAP) drawn as
 * coloured dots. Drag to orbit, scroll to zoom, right-drag to pan. A PLY
 * can say which way is up (`comment up z`, for CAD parts and print
 * toolpaths); otherwise meshes have y up, and point clouds COLMAP's y down.
 */
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js";
import { scaledCopy } from "./viewer.js";

/** The way up a PLY's header gives (`comment up z`, `comment up -y`), or null when it gives none. */
export function upAxis(ply: ArrayBuffer): THREE.Vector3 | null {
  const text = new TextDecoder().decode(new Uint8Array(ply, 0, Math.min(ply.byteLength, 4096)));
  const end = text.indexOf("end_header");
  const m = /^comment up ([+-]?)([xyz])\s*$/m.exec(end < 0 ? text : text.slice(0, end));
  if (!m) return null;
  const axis = new THREE.Vector3();
  axis[m[2] as "x" | "y" | "z"] = m[1] === "-" ? -1 : 1;
  return axis;
}

export class ModelView {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
  private readonly controls: OrbitControls;
  private readonly resize: ResizeObserver;
  private frame = 0;
  private drawing = false;

  constructor(
    private readonly host: HTMLElement,
    ply: ArrayBuffer,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(devicePixelRatio);
    this.renderer.setClearColor(0x1e1d1b);
    host.append(this.renderer.domElement);

    const geometry = new PLYLoader().parse(ply);
    const coloured = !!geometry.getAttribute("color");
    // a PLY with no faces is a point cloud
    const points = !geometry.index;
    const up = upAxis(ply);
    geometry.computeBoundingSphere();
    if (points) {
      const size = geometry.boundingSphere!.radius / 150;
      this.scene.add(new THREE.Points(geometry, new THREE.PointsMaterial({ size, vertexColors: coloured, color: coloured ? 0xffffff : 0xbfc4cc })));
      // point clouds that don't say come from COLMAP, whose world y points down
      if (!up) this.camera.up.set(0, -1, 0);
    } else {
      geometry.computeVertexNormals();
      const mesh = new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({ vertexColors: coloured, color: coloured ? 0xffffff : 0xbfc4cc, roughness: 0.75, metalness: 0.05, side: THREE.DoubleSide }),
      );
      this.scene.add(mesh);
    }
    // lit and framed for a model with y up, turned to the model's own up when it gives one
    const turn = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), up ?? new THREE.Vector3(0, 1, 0));
    const sky = new THREE.HemisphereLight(0xffffff, 0x44403c, 1.6);
    sky.position.set(0, 1, 0).applyQuaternion(turn);
    this.scene.add(sky);
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(1, 2, 3).applyQuaternion(turn);
    this.scene.add(sun);

    if (up) this.camera.up.copy(up);
    // frame the model: look at its centre from a three-quarter view, turned to its own up (for COLMAP's points, from behind its first camera)
    const { center, radius } = geometry.boundingSphere!;
    this.camera.near = radius / 100;
    this.camera.far = radius * 100;
    const colmap = points && !up;
    // a part that says which way is up is seen from a little higher, so its top shows
    const from = colmap ? new THREE.Vector3(0, -0.35, -1) : (up ? new THREE.Vector3(0.7, 0.9, 1.3) : new THREE.Vector3(0.6, 0.5, 1.4)).applyQuaternion(turn);
    this.camera.position.copy(center).add(from.normalize().multiplyScalar(colmap ? radius * 1.6 : radius * 2.6));
    this.camera.updateProjectionMatrix();
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.copy(center);
    this.controls.enableDamping = true;
    this.controls.update();

    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(host);
    this.fit();
    this.controls.addEventListener("change", this.redraw);
    this.redraw();
  }

  /**
   * Draws on the next frame, then keeps drawing only while the camera still
   * moves (a drag, a scroll, or the easing after one): an idle view costs
   * nothing, however many windows show one.
   */
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

  /** The model as it's framed now (for the minimised-window shelf); drawn fresh, as WebGL keeps no frame between renders. */
  snapshot(max: number): HTMLCanvasElement | null {
    const canvas = this.renderer.domElement;
    if (!canvas.width || !canvas.height) return null;
    this.renderer.render(this.scene, this.camera);
    return scaledCopy(canvas, canvas.width, canvas.height, max);
  }

  private fit() {
    const { clientWidth: w, clientHeight: h } = this.host;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.redraw();
  }

  destroy() {
    cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    this.controls.removeEventListener("change", this.redraw);
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
