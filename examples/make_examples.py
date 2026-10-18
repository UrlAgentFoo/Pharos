"""
Builds the synthetic example data in this folder: microscopy images in data/
and OpenFOAM cases in cases/. Deterministic; run it in the bio-utils ship's
image, which has numpy, tifffile and zarr:

    docker run --rm --user "$(id -u):$(id -g)" -v "$PWD/examples:/ex" -v "$PWD/books:/books:ro" \
      --entrypoint python pharos/bio-utils:0.1.0 /ex/make_examples.py /ex

(The first three examples, nuclei-timelapse, nuclei-stack and cylinder-flow,
come from the bio-utils test data and the Simulate flow book.)
"""

import os
import shutil
import sys

import numpy as np
import tifffile

sys.path.insert(0, "/opt/pharos")


# ---------------------------------------------------------------- microscopy


def blobs(shape, centres, radii, brightness, seed):
    """Fluorescent nuclei: soft ellipsoids (or discs, for 2D shapes) plus camera noise."""
    rng = np.random.default_rng(seed)
    grid = np.indices(shape, dtype=np.float32)
    image = np.zeros(shape, np.float32)
    for c, r, b in zip(centres, radii, brightness):
        d = sum(((g - ci) / ri) ** 2 for g, ci, ri in zip(grid, c, r))
        image += b * np.exp(-d * 1.2)
    image += 100 + rng.normal(0, 25, shape)
    return np.clip(image, 0, 65535).astype(np.uint16)


def spaced(rng, n, low, high, gap, tries=20000):
    """Up to n random points between low and high, at least gap apart (in the last two axes)."""
    out = []
    for _ in range(tries):
        if len(out) == n:
            break
        p = rng.uniform(low, high)
        if all(np.hypot(*(p[-2:] - q[-2:])) > gap for q in out):
            out.append(p)
    return out


def crowded_2d(path):
    """A single 2D field of crowded nuclei of mixed sizes under uneven illumination."""
    rng = np.random.default_rng(21)
    size = 256
    centres = spaced(rng, 48, [12, 12], [size - 12, size - 12], 17)
    radii = [(r, r * rng.uniform(0.8, 1.2)) for r in rng.uniform(6, 10, len(centres))]
    image = blobs((size, size), centres, radii, rng.uniform(900, 1800, len(centres)), 22).astype(np.float32)
    # brighter on the left, as from an off-centre lamp
    image *= np.linspace(1.25, 0.8, size)[None, :]
    image = np.clip(image, 0, 65535).astype(np.uint16)
    tifffile.imwrite(path, image, imagej=True, resolution=(1 / 0.65, 1 / 0.65), metadata={"unit": "um", "axes": "YX"})


def organoid(path):
    """A 3D organoid: nuclei packed on the shell of a hollow sphere."""
    rng = np.random.default_rng(31)
    shape = (32, 128, 128)  # z at 1 µm, y and x at 0.5 µm
    centre = np.array([16, 64, 64.0])
    radius = np.array([11, 44, 44.0])  # the shell, in voxels per axis
    centres = []
    for _ in range(20000):
        if len(centres) == 60:
            break
        v = rng.normal(size=3)
        p = centre + radius * v / np.linalg.norm(v)
        # compare in µm so the spacing is the same in every direction
        if all(np.linalg.norm((p - q) * [1, 0.5, 0.5]) > 6.5 for q in centres):
            centres.append(p)
    image = blobs(shape, centres, [(2.6, 5.5, 5.5)] * len(centres), rng.uniform(1000, 1600, len(centres)), 32)
    tifffile.imwrite(path, image, imagej=True, resolution=(2.0, 2.0), metadata={"spacing": 1.0, "unit": "um", "axes": "ZYX"})


def crawling_2d(path):
    """A 2D time-lapse: nuclei wandering along smooth loops, never touching."""
    rng = np.random.default_rng(41)
    size, frames = 160, 30
    homes = spaced(rng, 16, [18, 18], [size - 18, size - 18], 30)
    amp = rng.uniform(3, 7, (len(homes), 2))
    phase = rng.uniform(0, 2 * np.pi, (len(homes), 2))
    speed = rng.uniform(0.12, 0.25, len(homes))
    movie = []
    for t in range(frames):
        centres = [h + a * np.sin(s * t + p) for h, a, p, s in zip(homes, amp, phase, speed)]
        movie.append(blobs((size, size), centres, [(6, 6)] * len(centres), [1500] * len(centres), 100 + t))
    tifffile.imwrite(path, np.stack(movie), imagej=True, resolution=(1 / 0.65, 1 / 0.65), metadata={"unit": "um", "axes": "TYX", "finterval": 60})


def zarr_stack(path, scratch):
    """A 3D stack of nuclei saved as OME-Zarr (via bio-utils' own writer)."""
    from pharos_bio import read_image, write_ome_zarr

    rng = np.random.default_rng(51)
    shape = (16, 96, 96)
    centres = spaced(rng, 18, [3, 9, 9], [13, 87, 87], 14)
    image = blobs(shape, centres, [(2.5, 6, 6)] * len(centres), rng.uniform(1100, 1700, len(centres)), 52)
    tif = os.path.join(scratch, "zarr-stack.tif")
    tifffile.imwrite(tif, image, imagej=True, resolution=(2.0, 2.0), metadata={"spacing": 2.0, "unit": "um", "axes": "ZYX"})
    shutil.rmtree(path, ignore_errors=True)
    write_ome_zarr(path, read_image(tif), "nuclei")
    os.remove(tif)


# ---------------------------------------------------------------- OpenFOAM cases

HEADER = "/*--------------------------------*- C++ -*----------------------------------*\\\n  {title}\n\\*---------------------------------------------------------------------------*/\n"


def block_mesh(title, xs, ys, nx, ny, gx, gy, solid, walls):
    """
    A 2D blockMeshDict on a grid of blocks: xs and ys are the block edges,
    nx and ny the cells across each column and row, gx and gy their gradings,
    and `solid` the (column, row) blocks left out as obstacles. Inflow is on
    the left (patch inlet), outflow on the right (outlet); `walls` makes the
    top and bottom no-slip walls instead of symmetry planes.
    """
    ci, cj = len(xs) - 1, len(ys) - 1
    fluid = [(i, j) for j in range(cj) for i in range(ci) if (i, j) not in solid]
    used = sorted({(i + a, j + b) for i, j in fluid for a in (0, 1) for b in (0, 1)}, key=lambda p: (p[1], p[0]))
    index = {}
    for k in (0, 1):
        for p in used:
            index[(*p, k)] = len(index)
    v = lambda i, j, k: index[(i, j, k)]
    faces = {"inlet": [], "outlet": [], "bottom": [], "top": [], "obstacle": [], "frontAndBack": [], "-": []}  # "-": faces shared with another fluid block
    blocks = []
    for i, j in fluid:
        blocks.append(f"    hex ({v(i,j,0)} {v(i+1,j,0)} {v(i+1,j+1,0)} {v(i,j+1,0)} {v(i,j,1)} {v(i+1,j,1)} {v(i+1,j+1,1)} {v(i,j+1,1)}) ({nx[i]} {ny[j]} 1) simpleGrading ({gx[i]} {gy[j]} 1)")
        left = f"({v(i,j,0)} {v(i,j+1,0)} {v(i,j+1,1)} {v(i,j,1)})"
        right = f"({v(i+1,j,0)} {v(i+1,j,1)} {v(i+1,j+1,1)} {v(i+1,j+1,0)})"
        low = f"({v(i,j,0)} {v(i,j,1)} {v(i+1,j,1)} {v(i+1,j,0)})"
        high = f"({v(i,j+1,0)} {v(i+1,j+1,0)} {v(i+1,j+1,1)} {v(i,j+1,1)})"
        faces["inlet" if i == 0 else "obstacle" if (i - 1, j) in solid else "-"].append(left)
        faces["outlet" if i == ci - 1 else "obstacle" if (i + 1, j) in solid else "-"].append(right)
        faces["bottom" if j == 0 else "obstacle" if (i, j - 1) in solid else "-"].append(low)
        faces["top" if j == cj - 1 else "obstacle" if (i, j + 1) in solid else "-"].append(high)
        faces["frontAndBack"] += [f"({v(i,j,0)} {v(i+1,j,0)} {v(i+1,j+1,0)} {v(i,j+1,0)})", f"({v(i,j,1)} {v(i,j+1,1)} {v(i+1,j+1,1)} {v(i+1,j,1)})"]
    side = "wall" if walls else "symmetryPlane"
    types = {"inlet": "patch", "outlet": "patch", "bottom": side, "top": side, "obstacle": "wall", "frontAndBack": "empty"}
    points = [f"({xs[i]} {ys[j]} {0.1 * k})" for (i, j, k) in index]
    patches = [f"    {name} {{ type {types[name]}; faces ({' '.join(faces[name])}); }}" for name in types if faces[name]]
    return (
        HEADER.format(title=title)
        + "FoamFile { version 2.0; format ascii; class dictionary; object blockMeshDict; }\n\nscale 1;\n\n"
        + "vertices\n(\n    " + "\n    ".join(points) + "\n);\n\n"
        + "blocks\n(\n" + "\n".join(blocks) + "\n);\n\n"
        + "boundary\n(\n" + "\n".join(patches) + "\n);\n",
        [n for n in types if faces[n]],
    )


def fields(title, patches, walls):
    side_u = "noSlip" if walls else "symmetryPlane"
    side_p = "zeroGradient" if walls else "symmetryPlane"
    u = {"inlet": "fixedValue; value uniform (1 0 0)", "outlet": "zeroGradient", "top": side_u, "bottom": side_u, "obstacle": "noSlip", "frontAndBack": "empty"}
    p = {"inlet": "zeroGradient", "outlet": "fixedValue; value uniform 0", "top": side_p, "bottom": side_p, "obstacle": "zeroGradient", "frontAndBack": "empty"}

    def field(cls, name, dims, internal, bc):
        body = "\n".join(f"    {n:<13}{{ type {bc[n]}; }}" for n in patches)
        return HEADER.format(title=title) + f"FoamFile {{ version 2.0; format ascii; class {cls}; object {name}; }}\n\ndimensions      {dims};\ninternalField   uniform {internal};\n\nboundaryField\n{{\n{body}\n}}\n"

    return field("volVectorField", "U", "[0 1 -1 0 0 0 0]", "(1 0 0)", u), field("volScalarField", "p", "[0 2 -2 0 0 0 0]", "0", p)


def foam_case(path, base, title, mesh, walls, end_time):
    shutil.rmtree(path, ignore_errors=True)
    for d in ("0", "constant", "system"):
        os.makedirs(os.path.join(path, d))
    for f in ("constant/transportProperties", "constant/turbulenceProperties", "system/fvSchemes", "system/fvSolution", "system/controlDict"):
        text = open(os.path.join(base, f)).read()
        lines = text.split("\n")
        # keep the solver settings, retitle the header
        lines[1] = f"  {title}"
        text = "\n".join(lines)
        if f.endswith("controlDict"):
            text = text.replace("endTime         60;", f"endTime         {end_time};")
        open(os.path.join(path, f), "w").write(text)
    dict_text, patches = block_mesh(title, **mesh, walls=walls)
    open(os.path.join(path, "system/blockMeshDict"), "w").write(dict_text)
    u, p = fields(title, patches, walls)
    open(os.path.join(path, "0/U"), "w").write(u)
    open(os.path.join(path, "0/p"), "w").write(p)


CASES = {
    # a channel that suddenly widens: the flow separates at the step and reattaches downstream
    "backward-step": dict(
        title="Flow over a backward-facing step: a small 2D case for Pharos (Re = U h / nu = 100 at 1 m/s).",
        walls=True,
        end_time=40,
        mesh=dict(xs=[-4, 0, 20], ys=[0, 1, 3], nx=[24, 160], ny=[14, 24], gx=[1, 3], gy=[1, 1], solid={(0, 0)}),
    ),
    # two square blocks in a row: the first one's vortices hit the second
    "tandem-blocks": dict(
        title="Flow past two blocks in a row: a small 2D case for Pharos (Re = 100 at 1 m/s).",
        walls=False,
        end_time=60,
        mesh=dict(
            xs=[-3, 0, 1, 4, 5, 16], ys=[-3, 0, 1, 4.3], nx=[30, 16, 36, 16, 100], ny=[28, 16, 30], gx=[0.5, 1, 1, 1, 3], gy=[0.4, 1, 2.5], solid={(1, 1), (3, 1)}
        ),
    ),
    # a wall with one opening: a jet squeezes through and starts to flap
    "slot-jet": dict(
        title="A jet through a slot in a wall: a small 2D case for Pharos (Re = 100 at 1 m/s upstream).",
        walls=True,
        end_time=40,
        mesh=dict(xs=[-3, 0, 0.5, 14], ys=[-4, -0.4, 0.6, 4.3], nx=[20, 8, 130], ny=[30, 16, 30], gx=[0.5, 1, 4], gy=[0.4, 1, 2.5], solid={(1, 0), (1, 2)}),
    ),
}


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))
    data = os.path.join(root, "data")
    os.makedirs(data, exist_ok=True)
    crowded_2d(os.path.join(data, "crowded-nuclei.tif"))
    organoid(os.path.join(data, "organoid.tif"))
    crawling_2d(os.path.join(data, "crawling-cells.tif"))
    zarr_stack(os.path.join(data, "nuclei.zarr"), data)
    base = os.environ.get("PHAROS_BASE_CASE", "/books/fluid-flow/example/case")
    for name, spec in CASES.items():
        foam_case(os.path.join(root, "cases", name), base, **spec)
    print("done")


if __name__ == "__main__":
    main()
