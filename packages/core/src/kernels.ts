/**
 * Loader for the Rust kernels compiled to WebAssembly. The same module runs
 * in browsers and in Node; the host passes the bytes (or a fetch Response).
 */

interface KernelExports {
  memory: WebAssembly.Memory;
  ik_alloc(len: number): number;
  ik_free(ptr: number, len: number): void;
  ik_abi_version(): number;
  ik_gaussian_blur_f32(ptr: number, width: number, height: number, sx: number, sy: number, acc: number): void;
}

export const KERNEL_ABI_VERSION = 1;

export interface Kernels {
  /** Gaussian blur of a float plane, returning a new array (ImageJ algorithm). */
  gaussianBlurF32(pixels: Float32Array, width: number, height: number, sigmaX: number, sigmaY: number, accuracy: number): Float32Array;
}

export type KernelSource = BufferSource | Response | Promise<Response>;

export async function loadKernels(source: KernelSource): Promise<Kernels> {
  const resolved = await source;
  let instance: WebAssembly.Instance;
  if (resolved instanceof Response) {
    if (!resolved.ok) throw new Error(`failed to fetch kernels: HTTP ${resolved.status}`);
    instance = (await WebAssembly.instantiate(await resolved.arrayBuffer(), {})).instance;
  } else {
    instance = (await WebAssembly.instantiate(resolved, {})).instance;
  }
  const ex = instance.exports as unknown as KernelExports;
  const abi = ex.ik_abi_version();
  if (abi !== KERNEL_ABI_VERSION) {
    throw new Error(`kernel ABI mismatch: module is v${abi}, core expects v${KERNEL_ABI_VERSION}. Rebuild with \`npm run build:wasm\`.`);
  }
  return wrap(ex);
}

function wrap(ex: KernelExports): Kernels {
  /** Copies `data` into wasm memory, runs `fn(ptr)`, and copies the result out. */
  function withF32<T>(data: Float32Array, fn: (ptr: number) => void, read: (view: Float32Array) => T): T {
    const bytes = data.byteLength;
    const ptr = ex.ik_alloc(bytes);
    if (ptr === 0) throw new Error(`kernel allocation of ${bytes} bytes failed`);
    try {
      new Float32Array(ex.memory.buffer, ptr, data.length).set(data);
      fn(ptr);
      // memory.buffer may have been replaced if the module grew its memory
      return read(new Float32Array(ex.memory.buffer, ptr, data.length));
    } finally {
      ex.ik_free(ptr, bytes);
    }
  }

  return {
    gaussianBlurF32(pixels, width, height, sigmaX, sigmaY, accuracy) {
      if (pixels.length !== width * height) throw new RangeError("pixel count does not match width*height");
      return withF32(
        pixels,
        (ptr) => ex.ik_gaussian_blur_f32(ptr, width, height, sigmaX, sigmaY, accuracy),
        (view) => view.slice(),
      );
    },
  };
}
