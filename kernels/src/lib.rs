//! Pharos pixel kernels.
//!
//! The same crate is built for `wasm32-unknown-unknown` (loaded by both the
//! browser and the Node server) and natively for `cargo test`.
//!
//! The WebAssembly ABI is plain C: the host allocates buffers with
//! [`ik_alloc`], copies pixels into linear memory, calls a kernel, reads the
//! result back and releases it with [`ik_free`]. There is no wasm-bindgen
//! dependency, so the `.wasm` file loads with `WebAssembly.instantiate`.

pub mod gaussian;

use std::alloc::{alloc, dealloc, Layout};

const ALIGN: usize = 16;

/// Allocates `len` bytes of 16-byte-aligned memory. Returns null on failure.
#[no_mangle]
pub extern "C" fn ik_alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return std::ptr::null_mut();
    }
    match Layout::from_size_align(len, ALIGN) {
        Ok(layout) => unsafe { alloc(layout) },
        Err(_) => std::ptr::null_mut(),
    }
}

/// Frees memory returned by [`ik_alloc`] with the same `len`.
///
/// # Safety
/// `ptr` must come from `ik_alloc(len)` and not have been freed already.
#[no_mangle]
pub unsafe extern "C" fn ik_free(ptr: *mut u8, len: usize) {
    if ptr.is_null() || len == 0 {
        return;
    }
    dealloc(ptr, Layout::from_size_align_unchecked(len, ALIGN));
}

/// ABI version, bumped when an exported signature changes.
#[no_mangle]
pub extern "C" fn ik_abi_version() -> u32 {
    1
}

/// In-place Gaussian blur of a `width * height` f32 image (ImageJ algorithm).
///
/// # Safety
/// `ptr` must point to `width * height` valid, aligned f32 values.
#[no_mangle]
pub unsafe extern "C" fn ik_gaussian_blur_f32(
    ptr: *mut f32,
    width: u32,
    height: u32,
    sigma_x: f64,
    sigma_y: f64,
    accuracy: f64,
) {
    let (w, h) = (width as usize, height as usize);
    if ptr.is_null() || w == 0 || h == 0 {
        return;
    }
    let pixels = std::slice::from_raw_parts_mut(ptr, w * h);
    gaussian::blur_float(pixels, w, h, sigma_x, sigma_y, accuracy);
}
