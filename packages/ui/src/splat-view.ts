/**
 * A 3D Gaussian splat in a data window: the PLY that splat trainers write
 * (position, colour, opacity, scale and rotation per Gaussian), drawn as
 * soft ellipses sorted back to front. Drag to orbit, scroll to zoom,
 * right-drag to pan.
 *
 * Each Gaussian's data sits in float textures; one instanced quad per
 * Gaussian reads it by index, projects its 3D covariance to the screen and
 * fades it out from the centre. Only the index order changes as the view
 * turns (a counting sort on depth), so turning stays cheap.
 */
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { scaledCopy } from "./viewer.js";

/** Texture width: Gaussian i is at (i % WIDTH, i / WIDTH). */
const WIDTH = 2048;
/** The zero-order spherical-harmonics constant: colour = 0.5 + SH_C0 × f_dc. */
const SH_C0 = 0.28209479177387814;

export interface Splats {
  count: number;
  centers: Float32Array;
  /** Covariance per Gaussian: xx, xy, xz, yy, yz, zz. */
  covariances: Float32Array;
  /** RGBA, 0-255. */
  colors: Uint8Array;
}

const TYPES: Record<string, [number, (v: DataView, o: number) => number]> = {
  float: [4, (v, o) => v.getFloat32(o, true)],
  float32: [4, (v, o) => v.getFloat32(o, true)],
  double: [8, (v, o) => v.getFloat64(o, true)],
  float64: [8, (v, o) => v.getFloat64(o, true)],
  uchar: [1, (v, o) => v.getUint8(o)],
  uint8: [1, (v, o) => v.getUint8(o)],
  int: [4, (v, o) => v.getInt32(o, true)],
  int32: [4, (v, o) => v.getInt32(o, true)],
  uint: [4, (v, o) => v.getUint32(o, true)],
  uint32: [4, (v, o) => v.getUint32(o, true)],
  short: [2, (v, o) => v.getInt16(o, true)],
  ushort: [2, (v, o) => v.getUint16(o, true)],
};

/** The header of a PLY file, as text, when it has one. */
function plyHeader(buffer: ArrayBuffer): string | null {
  const head = new TextDecoder().decode(new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 64 * 1024)));
  const end = head.indexOf("end_header");
  return head.startsWith("ply") && end > 0 ? head.slice(0, end) : null;
}

/** Whether a PLY holds Gaussian splats rather than a mesh or point cloud. */
export function isSplatPly(buffer: ArrayBuffer): boolean {
  const h = plyHeader(buffer);
  return !!h && /property \w+ f_dc_0/.test(h) && /property \w+ rot_0/.test(h);
}

/** Reads a binary little-endian splat PLY; Gaussians nearly fully transparent are left out. */
export function parseSplatPly(buffer: ArrayBuffer): Splats {
  const header = plyHeader(buffer);
  if (!header) throw new Error("not a PLY file");
  if (!/format binary_little_endian/.test(header)) throw new Error("only binary little-endian splat PLYs can be shown");
  const lines = header.split("\n").map((l) => l.trim());
  const props: { name: string; offset: number; read: (v: DataView, o: number) => number }[] = [];
  let count = 0;
  let stride = 0;
  let inVertex = false;
  for (const line of lines) {
    const parts = line.split(/\s+/);
    if (parts[0] === "element") {
      inVertex = parts[1] === "vertex";
      if (inVertex) count = Number(parts[2]);
    } else if (parts[0] === "property" && inVertex) {
      const type = TYPES[parts[1]];
      if (!type) throw new Error(`unsupported PLY property type ${parts[1]}`);
      props.push({ name: parts[2], offset: stride, read: type[1] });
      stride += type[0];
    }
  }
  const start = new TextEncoder().encode(header).length + "end_header\n".length;
  const view = new DataView(buffer, start);
  const prop = (name: string) => {
    const p = props.find((x) => x.name === name);
    if (!p) throw new Error(`the splat has no "${name}"`);
    return p;
  };
  const [px, py, pz, r0, r1, r2, op, s0, s1, s2, q0, q1, q2, q3] = ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"].map(prop);

  const centers = new Float32Array(count * 3);
  const covariances = new Float32Array(count * 6);
  const colors = new Uint8Array(count * 4);
  let n = 0;
  for (let i = 0; i < count; i++) {
    const o = i * stride;
    const alpha = 1 / (1 + Math.exp(-op.read(view, o + op.offset)));
    if (alpha < 1 / 255) continue;
    centers.set([px.read(view, o + px.offset), py.read(view, o + py.offset), pz.read(view, o + pz.offset)], n * 3);
    const c = (p: typeof r0) => Math.max(0, Math.min(255, Math.round((0.5 + SH_C0 * p.read(view, o + p.offset)) * 255)));
    colors.set([c(r0), c(r1), c(r2), Math.round(alpha * 255)], n * 4);
    // covariance = R S Sᵀ Rᵀ, from the rotation quaternion (w, x, y, z) and log scales
    let w = q0.read(view, o + q0.offset);
    let x = q1.read(view, o + q1.offset);
    let y = q2.read(view, o + q2.offset);
    let z = q3.read(view, o + q3.offset);
    const len = Math.hypot(w, x, y, z) || 1;
    w /= len;
    x /= len;
    y /= len;
    z /= len;
    const R = [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y), 2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x), 2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)];
    const sx = Math.exp(s0.read(view, o + s0.offset)) ** 2;
    const sy = Math.exp(s1.read(view, o + s1.offset)) ** 2;
    const sz = Math.exp(s2.read(view, o + s2.offset)) ** 2;
    const cov = (a: number, b: number) => R[a * 3] * R[b * 3] * sx + R[a * 3 + 1] * R[b * 3 + 1] * sy + R[a * 3 + 2] * R[b * 3 + 2] * sz;
    covariances.set([cov(0, 0), cov(0, 1), cov(0, 2), cov(1, 1), cov(1, 2), cov(2, 2)], n * 6);
    n++;
  }
  return { count: n, centers: centers.subarray(0, n * 3), covariances: covariances.subarray(0, n * 6), colors: colors.subarray(0, n * 4) };
}

const VERTEX = /* glsl */ `
uniform highp sampler2D uCenter;
uniform highp sampler2D uCovA;
uniform highp sampler2D uCovB;
uniform highp sampler2D uColor;
uniform vec2 uViewport;
uniform vec2 uFocal;
in float splatIndex;
out vec4 vColor;
out vec2 vPos;

void main() {
  int k = int(splatIndex);
  ivec2 t = ivec2(k % ${WIDTH}, k / ${WIDTH});
  vec3 center = texelFetch(uCenter, t, 0).xyz;
  vec4 a = texelFetch(uCovA, t, 0);
  vec2 b = texelFetch(uCovB, t, 0).xy;
  vColor = texelFetch(uColor, t, 0);
  vec4 cam = modelViewMatrix * vec4(center, 1.0);
  vec4 clip = projectionMatrix * cam;
  float bound = 1.2 * clip.w;
  if (cam.z > -0.001 || abs(clip.x) > bound || abs(clip.y) > bound) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }
  // the 3D covariance seen from the camera, then projected to pixels (Jacobian of the perspective)
  mat3 sigma = mat3(a.x, a.y, a.z, a.y, a.w, b.x, a.z, b.x, b.y);
  mat3 w = mat3(modelViewMatrix);
  mat3 s = w * sigma * transpose(w);
  float z = cam.z;
  vec3 j1 = vec3(uFocal.x / -z, 0.0, uFocal.x * cam.x / (z * z));
  vec3 j2 = vec3(0.0, uFocal.y / -z, uFocal.y * cam.y / (z * z));
  float A = dot(j1, s * j1) + 0.3;
  float B = dot(j1, s * j2);
  float C = dot(j2, s * j2) + 0.3;
  // the ellipse's axes from the 2D covariance's eigenvalues
  float mid = 0.5 * (A + C);
  float r = length(vec2(0.5 * (A - C), B));
  float l1 = mid + r;
  float l2 = max(mid - r, 0.1);
  vec2 v1 = abs(B) > 1e-8 ? normalize(vec2(B, l1 - A)) : (A >= C ? vec2(1.0, 0.0) : vec2(0.0, 1.0));
  vec2 major = min(sqrt(2.0 * l1), 1024.0) * v1;
  // the minor axis a quarter turn anticlockwise from the major, so the quad keeps its winding
  vec2 minor = min(sqrt(2.0 * l2), 1024.0) * vec2(-v1.y, v1.x);
  vPos = position.xy;
  gl_Position = vec4(clip.xy / clip.w + (position.x * major + position.y * minor) * 2.0 / uViewport, clip.z / clip.w, 1.0);
}`;

const FRAGMENT = /* glsl */ `
in vec4 vColor;
in vec2 vPos;
out highp vec4 fragColor;

void main() {
  float a = -dot(vPos, vPos);
  if (a < -4.0) discard;
  float b = exp(a) * vColor.a;
  if (b < 1.0 / 255.0) discard;
  fragColor = vec4(vColor.rgb * b, b);
}`;

function dataTexture(data: Float32Array | Uint8Array, rows: number): THREE.DataTexture {
  const float = data instanceof Float32Array;
  const tex = new THREE.DataTexture(data, WIDTH, rows, THREE.RGBAFormat, float ? THREE.FloatType : THREE.UnsignedByteType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

export class SplatView {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(50, 1, 0.01, 1000);
  private readonly controls: OrbitControls;
  private readonly resize: ResizeObserver;
  private readonly material: THREE.ShaderMaterial;
  private readonly order: THREE.InstancedBufferAttribute;
  private readonly textures: THREE.DataTexture[];
  private readonly splats: Splats;
  private readonly depths: Float32Array;
  private readonly counts = new Uint32Array(65536);
  private readonly keys: Uint16Array;
  private lastView = new THREE.Matrix4();
  private frame = 0;
  private drawing = false;
  readonly count: number;

  constructor(
    private readonly host: HTMLElement,
    ply: ArrayBuffer,
  ) {
    this.splats = parseSplatPly(ply);
    const { count, centers, covariances, colors } = this.splats;
    if (!count) throw new Error("the splat has no visible Gaussians");
    this.count = count;
    this.depths = new Float32Array(count);
    this.keys = new Uint16Array(count);

    this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setClearColor(0x1e1d1b);
    host.append(this.renderer.domElement);

    // the Gaussians' data as textures, one texel per Gaussian per texture
    const rows = Math.ceil(count / WIDTH);
    const center = new Float32Array(rows * WIDTH * 4);
    const covA = new Float32Array(rows * WIDTH * 4);
    const covB = new Float32Array(rows * WIDTH * 4);
    const color = new Uint8Array(rows * WIDTH * 4);
    for (let i = 0; i < count; i++) {
      center.set(centers.subarray(i * 3, i * 3 + 3), i * 4);
      covA.set(covariances.subarray(i * 6, i * 6 + 4), i * 4);
      covB.set(covariances.subarray(i * 6 + 4, i * 6 + 6), i * 4);
    }
    color.set(colors);
    this.textures = [dataTexture(center, rows), dataTexture(covA, rows), dataTexture(covB, rows), dataTexture(color, rows)];

    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-2, -2, 0, 2, -2, 0, 2, 2, 0, -2, 2, 0]), 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    this.order = new THREE.InstancedBufferAttribute(new Float32Array(count), 1);
    this.order.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("splatIndex", this.order);
    geometry.instanceCount = count;
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        uCenter: { value: this.textures[0] },
        uCovA: { value: this.textures[1] },
        uCovB: { value: this.textures[2] },
        uColor: { value: this.textures[3] },
        uViewport: { value: new THREE.Vector2(1, 1) },
        uFocal: { value: new THREE.Vector2(1, 1) },
      },
      transparent: true,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
      // colours come premultiplied, drawn back to front
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.frustumCulled = false;
    this.scene.add(mesh);

    // frame the scene's dense middle (floaters at the edges would push the camera far away);
    // splats from COLMAP keep its world, where y points down and the first camera looks along +z
    const { center: mid, radius } = robustBounds(centers, count);
    this.camera.up.set(0, -1, 0);
    this.camera.near = radius / 200;
    this.camera.far = radius * 200;
    this.camera.position.copy(mid).add(new THREE.Vector3(0, -0.35, -1).normalize().multiplyScalar(radius * 2.2));
    this.camera.updateProjectionMatrix();
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.copy(mid);
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
    this.sortIfMoved();
    this.renderer.render(this.scene, this.camera);
    if (moving) this.redraw();
  };

  /** Sorts the Gaussians back to front when the camera has moved. */
  private sortIfMoved() {
    this.camera.updateMatrixWorld();
    const m = this.camera.matrixWorld;
    if (m.equals(this.lastView)) return;
    this.lastView.copy(m);
    const e = m.elements;
    // the camera looks along its -z axis
    const fx = -e[8];
    const fy = -e[9];
    const fz = -e[10];
    const { centers } = this.splats;
    const n = this.count;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < n; i++) {
      const d = centers[i * 3] * fx + centers[i * 3 + 1] * fy + centers[i * 3 + 2] * fz;
      this.depths[i] = d;
      if (d < min) min = d;
      if (d > max) max = d;
    }
    // counting sort on 16-bit depth, farthest first
    const scale = max > min ? 65535 / (max - min) : 0;
    const counts = this.counts;
    counts.fill(0);
    for (let i = 0; i < n; i++) {
      const k = ((max - this.depths[i]) * scale) | 0;
      this.keys[i] = k;
      counts[k]++;
    }
    for (let k = 1; k < 65536; k++) counts[k] += counts[k - 1];
    const out = this.order.array as Float32Array;
    for (let i = n - 1; i >= 0; i--) out[--counts[this.keys[i]]] = i;
    this.order.needsUpdate = true;
  }

  /** The scene as it's framed now (for the minimised-window shelf). */
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
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.material.uniforms.uViewport.value.copy(size);
    const p = this.camera.projectionMatrix.elements;
    this.material.uniforms.uFocal.value.set((p[0] * size.x) / 2, (p[5] * size.y) / 2);
    this.redraw();
  }

  destroy() {
    cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    this.controls.removeEventListener("change", this.redraw);
    this.controls.dispose();
    for (const t of this.textures) t.dispose();
    this.material.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

/** The middle of the densest part of a point set, and a radius holding most of it. */
function robustBounds(centers: Float32Array, n: number): { center: THREE.Vector3; radius: number } {
  const step = Math.max(1, Math.floor(n / 20000));
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  for (let i = 0; i < n; i += step) {
    xs.push(centers[i * 3]);
    ys.push(centers[i * 3 + 1]);
    zs.push(centers[i * 3 + 2]);
  }
  const median = (v: number[]) => v.sort((a, b) => a - b)[Math.floor(v.length / 2)];
  const center = new THREE.Vector3(median(xs), median(ys), median(zs));
  const dist = xs.map((_, i) => Math.hypot(xs[i] - center.x, ys[i] - center.y, zs[i] - center.z)).sort((a, b) => a - b);
  return { center, radius: dist[Math.floor(dist.length * 0.8)] || 1 };
}
