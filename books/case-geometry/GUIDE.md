# Look at an OpenFOAM case in 3D

## When to use

The user has an OpenFOAM case and wants to see it before (or instead of)
running it: "show me the geometry", "what does the mesh look like", "where
is the obstacle", "check the case". It meshes the case (blockMesh) and
shows its surfaces as a 3D model in the window, in a few seconds.

## When not to use

- To simulate the flow or see results (vortices, speed): use **Simulate
  flow past an obstacle**, which also makes a 3D model coloured by speed.
- Cases meshed with snappyHexMesh or imported meshes: they need their own
  meshing steps; if the case already has a mesh, it is used as it is.

## Parameters

None.

## Example

Request: "Show me what this case looks like." Data: one OpenFOAM case.

Plan: Look at an OpenFOAM case in 3D. Output: the meshed case and a 3D
model of the channel and the obstacle.
