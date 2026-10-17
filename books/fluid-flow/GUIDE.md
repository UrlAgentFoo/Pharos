# Fluid flow

Runs OpenFOAM cases. Two actions: `simulate` runs the case and shows the
flow; `geometry` only meshes it and shows its shape.

## When to use

The user has an OpenFOAM case (a folder with `system/`, `constant/` and
`0/`; its summary kind is `sim-case`).

- `simulate`: they want to run it or see the flow: "simulate the flow",
  "show the vortices", "what happens at 2 m/s", "run this case". The
  example case is 2D laminar flow past a square obstacle, which sheds a
  Kármán vortex street.
- `geometry`: they want to see the case before (or instead of) running it:
  "show me the geometry", "what does the mesh look like", "where is the
  obstacle", "check the case". It meshes the case (blockMesh) and shows its
  surfaces as a 3D model in a few seconds.

## When not to use

- Microscopy images or tables: this book only runs OpenFOAM cases.
- Turbulence modelling, heat transfer or multiphase questions about a case
  built for something else: `simulate` runs the case as set up and only
  changes the inlet speed and end time; say what else would need changing.
- Cases without an `inlet` patch: the speed can't be set (the case's own
  value is used); say so.
- Cases meshed with snappyHexMesh or imported meshes need their own meshing
  steps; if the case already has a mesh, it is used as it is.

## Parameters

`simulate`:

- **speed** (m/s): from the request ("at 2 m/s" → 2). In the example case
  the obstacle is 1 m wide and the viscosity 0.01 m²/s, so the Reynolds
  number is 100 × speed: below about 0.5 m/s (Re < 50) the flow stays steady
  and shows no vortices; 1-2 m/s gives a clear vortex street; much higher
  speeds become unstable for this coarse laminar case.
- **end_time** (s): long enough for the flow to develop - about 30 / speed
  seconds before shedding is regular; the default 30 suits speed 1. Shorter runs are
  faster but may show only the start-up.
- **field**: `vorticity` to show vortices (the usual choice), `speed` if
  the user asks how fast the fluid moves.

`geometry` has none.

## Example

Request: "Simulate the flow past this obstacle at 1.5 m/s and show the
vortices." Data: one OpenFOAM case (sim-case).

Plan: Fluid flow, action `simulate`, with speed 1.5, end_time 45, field
vorticity. Outputs: the solved case, a video of the vortex street and a 3D
model coloured by speed.

Request: "Show me what this case looks like." Plan: Fluid flow, action
`geometry`. Output: the meshed case and a 3D model of the channel and the
obstacle.
