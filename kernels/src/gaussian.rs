//! Gaussian blur, ported from ImageJ 1.x `ij/plugin/filter/GaussianBlur.java`
//! (Michael Schmid's implementation).
//!
//! The port keeps ImageJ's arithmetic order and f32/f64 precision so that
//! results match ImageJ bit for bit: Java and WebAssembly both use strict
//! IEEE-754 float math without fused multiply-add.
//!
//! Scope: full-image blur (no ROI). Out-of-image pixels are replaced by the
//! nearest edge pixel, and large sigmas use ImageJ's downscale/convolve/upscale
//! path.

const UPSCALE_K_RADIUS: i64 = 2;
const MIN_DOWNSCALED_SIGMA: f64 = 4.0;

/// Default kernel accuracy ImageJ uses for 8-bit and RGB images.
pub const ACCURACY_8BIT: f64 = 0.002;
/// Default kernel accuracy ImageJ uses for 16-bit and float images.
pub const ACCURACY_HIGH: f64 = 0.0002;

/// Blurs `pixels` (row-major, `width * height`) in place.
pub fn blur_float(pixels: &mut [f32], width: usize, height: usize, sigma_x: f64, sigma_y: f64, accuracy: f64) {
    assert_eq!(pixels.len(), width * height, "pixel buffer does not match dimensions");
    if width == 0 || height == 0 {
        return;
    }
    if sigma_x > 0.0 {
        blur_1_direction(pixels, width, height, sigma_x, accuracy, true);
    }
    if sigma_y > 0.0 {
        blur_1_direction(pixels, width, height, sigma_y, accuracy, false);
    }
}

fn blur_1_direction(pixels: &mut [f32], width: usize, height: usize, sigma: f64, accuracy: f64, x_direction: bool) {
    let (width, height) = (width as i64, height as i64);
    let length = if x_direction { width } else { height };
    let point_inc = if x_direction { 1 } else { width };
    let line_inc = if x_direction { width } else { 1 };
    let n_lines = if x_direction { height } else { width };
    let (write_from, write_to) = (0, length);

    let do_downscaling = sigma > 2.0 * MIN_DOWNSCALED_SIGMA + 0.5;
    let reduce_by = if do_downscaling {
        ((sigma / MIN_DOWNSCALED_SIGMA).floor() as i64).min(length)
    } else {
        1
    };
    let sigma_gauss = if do_downscaling {
        (sigma * sigma / ((reduce_by * reduce_by) as f64) - 1.0 / 3.0 - 1.0 / 4.0).sqrt()
    } else {
        sigma
    };
    let max_length = if do_downscaling {
        (length + reduce_by - 1) / reduce_by + 2 * (UPSCALE_K_RADIUS + 1)
    } else {
        length
    };
    let (kern, kern_sum) = make_gaussian_kernel(sigma_gauss, accuracy, max_length);
    let k_radius = kern.len() as i64 * reduce_by;
    let read_from = (write_from - k_radius).max(0);
    let read_to = (write_to + k_radius).min(length);
    let new_length = if do_downscaling {
        (read_to - read_from + reduce_by - 1) / reduce_by + 2 * (UPSCALE_K_RADIUS + 1)
    } else {
        length
    };
    let unscaled0 = read_from - (UPSCALE_K_RADIUS + 1) * reduce_by;

    let mut cache1 = vec![0f32; new_length as usize];
    let mut cache2 = if do_downscaling { vec![0f32; new_length as usize] } else { Vec::new() };
    let (down_kernel, up_kernel) = if do_downscaling {
        (make_downscale_kernel(reduce_by), make_upscale_kernel(reduce_by))
    } else {
        (Vec::new(), Vec::new())
    };

    for line in 0..n_lines {
        let pixel0 = line * line_inc;
        if do_downscaling {
            downscale_line(pixels, &mut cache1, &down_kernel, reduce_by, pixel0, unscaled0, length, point_inc, new_length);
            convolve_line(&cache1, &mut cache2, &kern, &kern_sum, 1, new_length - 1, 0, 1);
            upscale_line(&cache2, pixels, &up_kernel, reduce_by, pixel0, unscaled0, write_from, write_to, point_inc);
        } else {
            let mut p = pixel0 + read_from * point_inc;
            for i in read_from..read_to {
                cache1[i as usize] = pixels[p as usize];
                p += point_inc;
            }
            convolve_line(&cache1, pixels, &kern, &kern_sum, write_from, write_to, pixel0, point_inc);
        }
    }
}

/// One side of a normalized Gaussian kernel (`.0`), plus the running sum over
/// all kernel elements beyond each index (`.1`), used for edge handling.
pub fn make_gaussian_kernel(sigma: f64, accuracy: f64, max_radius: i64) -> (Vec<f32>, Vec<f32>) {
    let mut k_radius = (sigma * (-2.0 * accuracy.ln()).sqrt()).ceil() as i64 + 1;
    let max_radius = max_radius.max(50); // too small maxRadius would give an inaccurate sum
    if k_radius > max_radius {
        k_radius = max_radius;
    }
    let kr = k_radius as usize;
    let mut kern = vec![0f32; kr];
    let mut kern_sum = vec![0f32; kr];
    for i in 0..kr {
        let fi = i as f64;
        kern[i] = (-0.5 * fi * fi / sigma / sigma).exp() as f32;
    }
    if k_radius < max_radius && k_radius > 3 {
        // edge correction: replace the tail by a parabola reaching 0 at kRadius
        let mut sqrt_slope = f64::MAX;
        let mut r = k_radius;
        while r > k_radius / 2 {
            r -= 1;
            let a = (kern[r as usize] as f64).sqrt() / ((k_radius - r) as f64);
            if a < sqrt_slope {
                sqrt_slope = a;
            } else {
                break;
            }
        }
        for r1 in (r + 2)..k_radius {
            let d = (k_radius - r1) * (k_radius - r1);
            kern[r1 as usize] = ((d as f64) * sqrt_slope * sqrt_slope) as f32;
        }
    }
    let sum: f64 = if k_radius < max_radius {
        let mut s = kern[0] as f64;
        for &k in &kern[1..] {
            s += (2.0f32 * k) as f64;
        }
        s
    } else {
        sigma * (2.0 * std::f64::consts::PI).sqrt()
    };
    let mut rsum = 0.5 + 0.5 * (kern[0] as f64) / sum;
    for i in 0..kr {
        let v = (kern[i] as f64) / sum;
        kern[i] = v as f32;
        rsum -= v;
        kern_sum[i] = rsum as f32;
    }
    (kern, kern_sum)
}

/// Convolves `input` with the symmetric one-sided kernel and writes points
/// `write_from..write_to` to `out[point0 + i*point_inc]`.
#[allow(clippy::too_many_arguments)]
fn convolve_line(
    input: &[f32],
    out: &mut [f32],
    kern: &[f32],
    kern_sum: &[f32],
    write_from: i64,
    write_to: i64,
    point0: i64,
    point_inc: i64,
) {
    let length = input.len() as i64;
    let first = input[0];
    let last = input[(length - 1) as usize];
    let kern0 = kern[0];
    let k_radius = kern.len() as i64;
    let first_part = k_radius.min(length);
    let at = |i: i64| input[i as usize];

    // Edge case: the sum reaches beyond either end of the line.
    let edge_point = |i: i64| -> f32 {
        let mut result = at(i) * kern0;
        if i < k_radius {
            result += kern_sum[i as usize] * first;
        }
        if i + k_radius >= length {
            result += kern_sum[(length - i - 1) as usize] * last;
        }
        for k in 1..k_radius {
            let mut v = 0f32;
            if i - k >= 0 {
                v += at(i - k);
            }
            if i + k < length {
                v += at(i + k);
            }
            result += kern[k as usize] * v;
        }
        result
    };

    let mut p = point0 + write_from * point_inc;
    let mut i = write_from;
    while i < first_part {
        // ImageJ's first loop always adds the left tail and tests `i+kRadius>length`.
        let mut result = at(i) * kern0;
        result += kern_sum[i as usize] * first;
        if i + k_radius > length {
            result += kern_sum[(length - i - 1) as usize] * last;
        }
        for k in 1..k_radius {
            let mut v = 0f32;
            if i - k >= 0 {
                v += at(i - k);
            }
            if i + k < length {
                v += at(i + k);
            }
            result += kern[k as usize] * v;
        }
        out[p as usize] = result;
        i += 1;
        p += point_inc;
    }
    let i_end_inside = (length - k_radius).min(write_to);
    while i < i_end_inside {
        let mut result = at(i) * kern0;
        for k in 1..k_radius {
            result += kern[k as usize] * (at(i - k) + at(i + k));
        }
        out[p as usize] = result;
        i += 1;
        p += point_inc;
    }
    while i < write_to {
        out[p as usize] = edge_point(i);
        i += 1;
        p += point_inc;
    }
}

#[allow(clippy::too_many_arguments)]
fn downscale_line(
    pixels: &[f32],
    cache: &mut [f32],
    kernel: &[f32],
    reduce_by: i64,
    pixel0: i64,
    unscaled0: i64,
    length: i64,
    point_inc: i64,
    new_length: i64,
) {
    let mut p = pixel0 + point_inc * (unscaled0 - reduce_by * 3 / 2);
    let p_last = pixel0 + point_inc * (length - 1);
    let rb = reduce_by as usize;
    for xout in -1..=new_length {
        let (mut sum0, mut sum1, mut sum2) = (0f32, 0f32, 0f32);
        for x in 0..rb {
            let v = pixels[p.clamp(pixel0, p_last) as usize];
            sum0 += v * kernel[x + 2 * rb];
            sum1 += v * kernel[x + rb];
            sum2 += v * kernel[x];
            p += point_inc;
        }
        if xout > 0 {
            cache[(xout - 1) as usize] += sum0;
        }
        if xout >= 0 && xout < new_length {
            cache[xout as usize] += sum1;
        }
        if xout + 1 < new_length {
            cache[(xout + 1) as usize] = sum2;
        }
    }
}

fn make_downscale_kernel(unit_length: i64) -> Vec<f32> {
    let mid = (unit_length * 3 / 2) as usize;
    let mut kernel = vec![0f32; (3 * unit_length) as usize];
    for i in 0..=(unit_length / 2) as usize {
        let x = i as f64 / unit_length as f64;
        let v = ((0.75 - x * x) / unit_length as f64) as f32;
        kernel[mid - i] = v;
        kernel[mid + i] = v;
    }
    for i in (unit_length / 2 + 1) as usize..((unit_length * 3 + 1) / 2) as usize {
        let x = i as f64 / unit_length as f64;
        let v = ((0.125 + 0.5 * (x - 1.0) * (x - 2.0)) / unit_length as f64) as f32;
        kernel[mid - i] = v;
        kernel[mid + i] = v;
    }
    kernel
}

#[allow(clippy::too_many_arguments)]
fn upscale_line(
    cache: &[f32],
    pixels: &mut [f32],
    kernel: &[f32],
    reduce_by: i64,
    pixel0: i64,
    unscaled0: i64,
    write_from: i64,
    write_to: i64,
    point_inc: i64,
) {
    let mut p = pixel0 + point_inc * write_from;
    let rb = reduce_by as usize;
    for xout in write_from..write_to {
        let xin = ((xout - unscaled0 + reduce_by - 1) / reduce_by) as usize;
        let x = (reduce_by - 1 - (xout - unscaled0 + reduce_by - 1) % reduce_by) as usize;
        pixels[p as usize] = cache[xin - 2] * kernel[x]
            + cache[xin - 1] * kernel[x + rb]
            + cache[xin] * kernel[x + 2 * rb]
            + cache[xin + 1] * kernel[x + 3 * rb];
        p += point_inc;
    }
}

fn make_upscale_kernel(unit_length: i64) -> Vec<f32> {
    let ul = unit_length as usize;
    let mut kernel = vec![0f32; 4 * ul];
    let mid = 2 * ul;
    for i in 0..ul {
        let x = i as f64 / unit_length as f64;
        let v = (2.0 / 3.0 - x * x * (1.0 - 0.5 * x)) as f32;
        kernel[mid + i] = v;
        kernel[mid - i] = v;
    }
    for i in ul..2 * ul {
        let x = i as f64 / unit_length as f64;
        let v = ((2.0 - x) * (2.0 - x) * (2.0 - x) / 6.0) as f32;
        kernel[mid + i] = v;
        kernel[mid - i] = v;
    }
    kernel[0] = 0.0;
    kernel
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kernel_is_normalized() {
        for &sigma in &[0.5, 1.0, 2.0, 5.0] {
            let (k, _) = make_gaussian_kernel(sigma, ACCURACY_HIGH, 1000);
            let sum: f64 = k[0] as f64 + k[1..].iter().map(|&v| 2.0 * v as f64).sum::<f64>();
            assert!((sum - 1.0).abs() < 1e-5, "sigma {sigma}: sum {sum}");
        }
    }

    #[test]
    fn constant_image_is_unchanged() {
        for &sigma in &[1.0, 3.0, 12.0] {
            let (w, h) = (40, 30);
            let mut px = vec![7.25f32; w * h];
            blur_float(&mut px, w, h, sigma, sigma, ACCURACY_HIGH);
            for &v in &px {
                assert!((v - 7.25).abs() < 1e-4, "sigma {sigma}: got {v}");
            }
        }
    }

    #[test]
    fn preserves_total_intensity_away_from_edges() {
        let (w, h) = (101, 101);
        let mut px = vec![0f32; w * h];
        px[50 * w + 50] = 1000.0;
        blur_float(&mut px, w, h, 3.0, 3.0, ACCURACY_HIGH);
        let total: f64 = px.iter().map(|&v| v as f64).sum();
        assert!((total - 1000.0).abs() < 0.05, "total {total}");
        // peak stays at the centre and the result is symmetric
        assert_eq!(px[50 * w + 49], px[50 * w + 51]);
        assert_eq!(px[49 * w + 50], px[51 * w + 50]);
    }

    #[test]
    fn large_sigma_uses_downscaling_and_stays_smooth() {
        let (w, h) = (200, 50);
        let mut px: Vec<f32> = (0..w * h).map(|i| if i % w < 100 { 0.0 } else { 100.0 }).collect();
        blur_float(&mut px, w, h, 20.0, 0.0, ACCURACY_HIGH);
        let row = &px[25 * w..26 * w];
        for x in 1..w {
            assert!(row[x] >= row[x - 1] - 1e-3, "not monotonic at {x}");
        }
        assert!((row[100] - 50.0).abs() < 3.0, "mid value {}", row[100]);
    }
}
