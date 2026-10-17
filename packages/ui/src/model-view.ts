/**
 * A 3D model in a data window: a PLY mesh with per-vertex colours (an
 * OpenFOAM case's surfaces, segmented objects), lit softly and framed to
 * fit. Drag to orbit, scroll to zoom, right-drag to pan.
 */
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js";
import { scaledCopy } from "./viewer.js";

export class ModelView {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
  private readonly controls: OrbitControls;
  private readonly resize: ResizeObserver;
  private frame = 0;

  constructor(
    private readonly host: HTMLElement,
    ply: ArrayBuffer,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(devicePixelRatio);
    this.renderer.setClearColor(0x1e1d1b);
    host.append(this.renderer.domElement);

    const geometry = new PLYLoader().parse(ply);
    geometry.computeVertexNormals();
    const coloured = !!geometry.getAttribute("color");
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({ vertexColors: coloured, color: coloured ? 0xffffff : 0xbfc4cc, roughness: 0.75, metalness: 0.05, side: THREE.DoubleSide }),
    );
    this.scene.add(mesh);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x44403c, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(1, 2, 3);
    this.scene.add(sun);

    // frame the model: look at its centre from a three-quarter view
    geometry.computeBoundingSphere();
    const { center, radius } = geometry.boundingSphere!;
    this.camera.near = radius / 100;
    this.camera.far = radius * 100;
    this.camera.position.copy(center).add(new THREE.Vector3(0.6, 0.5, 1.4).normalize().multiplyScalar(radius * 2.6));
    this.camera.updateProjectionMatrix();
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.copy(center);
    this.controls.enableDamping = true;
    this.controls.update();

    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(host);
    this.fit();
    const tick = () => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this.frame = requestAnimationFrame(tick);
    };
    tick();
  }

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
  }

  destroy() {
    cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
