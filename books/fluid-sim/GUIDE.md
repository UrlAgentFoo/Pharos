# Simulate flow past an obstacle

## When to use

The user has an OpenFOAM case (a folder with `system/`, `constant/` and
`0/`; its summary kind is `sim-case`) and wants to run it or see the flow:
"simulate the flow", "show the vortices", "what happens at 2 m/s",
"run this case". The example case is 2D laminar flow past a square
obstacle, which sheds a Kármán vortex street.

## When not to use

- Microscopy images or tables: this book only runs OpenFOAM cases.
- Turbulence modelling, heat transfer or multiphase questions about a case
  built for something else: the book runs the case as set up and only
  changes the inlet speed and end time; say what else would need changing.
- Cases without an `inlet` patch: the speed can't be set (the case's own
  value is used); say so.

## Parameters

- **speed** (m/s): from the request ("at 2 m/s" → 2). In the example case
  the obstacle is 1 m wide and the viscosity 0.01 m²/s, so the Reynolds
  number is 100 × speed: below about 0.5 m/s (Re < 50) the flow stays steady
  and shows no vortices; 1-2 m/s gives a clear vortex street; much higher
  speeds become unstable for this coarse laminar case.
- **end_time** (s): long enough for the flow to develop - about 30 / speed
  seconds before shedding is regular; 60 suits speed 1. Shorter runs are
  faster but may show only the start-up.
- **field**: `vorticity` to show vortices (the usual choice), `speed` if
  the user asks how fast the fluid moves.

## Example

Request: "Simulate the flow past this obstacle at 1.5 m/s and show the
vortices." Data: one OpenFOAM case (sim-case).

Plan: Simulate flow past an obstacle with speed 1.5, end_time 45, field
vorticity. Outputs: the solved case and a video of the vortex street.
