# Printed parts

Tests, redesigns and prints parts. Three actions: `test` load-tests a part
and says whether it holds; `strengthen` redesigns a shelf bracket stronger
at the same size, tests it and slices it; `print` slices a part for 3D
printing.

## When to use

The user has a solid part as a STEP file (its summary kind is `cad`) and
asks whether it is strong enough, how to make it stronger, or how to print
it.

- `test`: "will this hold 10 kg?", "is it strong enough?", "where will it
  break?", "check this part in PETG". It holds the part by its x-min side
  (a bracket's wall side), pushes evenly on its z-max side (the top of a
  bracket's arm, where a shelf rests), and reports the peak stress against
  the material's strength as a safety factor, with the part coloured blue
  (unstressed) to red (at the material's strength). The window opens with
  this run at the default load.
- `strengthen`: "make it stronger", "it needs to hold more", "redesign it so
  it passes", or a request to test and then print a better one. It draws a
  new shelf bracket the same overall size as the part, load-tests it, and
  slices it for printing on its side, in one run: the new model coloured by
  stress, its safety factor, the toolpath, and the print time, filament and
  cost.
- `print`: "how long will it take to print?", "slice it", "how much
  filament?". It lays the part on its side (y up), slices it for a generic
  0.4 mm-nozzle printer, and reports the print time, grams of filament and
  cost.

When the user asks for several of these at once ("if it won't hold, make it
stronger and tell me the print time"), choose `strengthen`: it covers the
redesign, the test and the print time.

## When not to use

- Meshes (PLY, STL) and point clouds: `test` needs a STEP solid. A mesh can
  only be sliced if it comes from a STEP part in the same window.
- Parts held or loaded anywhere but on flat sides of their bounding box,
  moving parts, impacts, heat or fatigue: this is one linear static load
  test. Say what would be needed.
- `strengthen` only draws shelf brackets (an L of a wall plate and an arm).
  For other parts, test them and say how they could be strengthened.
- Certification: this is a quick check of a design, not a certificate.

## Parameters

Loads are in newtons: kg × 9.81. A shelf rests on two brackets, so each
carries half its weight and whatever is on it: a 15 kg shelf is 74 N per
bracket; 20 kg of books on it adds 98 N per bracket. Use the total per
bracket when the user gives both.

`test`:

- **load** (N): per bracket, as above. The default, 74 N, is half of 15 kg.
- **material**: `pla` unless they say (PETG, ABS, nylon; aluminium or steel
  for metal parts).
- **target**: 2 for shelves and anything that just holds things up; 3 or
  more where a failure could hurt someone (over a bed, a child's room, a
  handle or a step).

`strengthen` (the same load, material and target, plus):

- **rib** (mm): the triangular rib down each side; it helps by far the most,
  but roughly doubles the print time. 0 leaves them off.
- **thickness** (mm): the plate and the arm. Strength grows with its square
  (6 mm is about twice as strong as 4 mm), but a ribless bracket still sags.
- **fillet** (mm): rounds the inside corner, where stress gathers; 4-8 mm.
- **infill** (%): 20 is usual; 40-60 for parts that take big loads.
- **price**: only when they give a filament price per kg.

Measured on the example bracket (120 × 25 × 120 mm, PLA, 74 N, 5 mm inside
corner unless it says), to choose from and to explain the choice:

| Design | Safety factor | Bends | Print time | Filament |
| --- | --- | --- | --- | --- |
| as drawn: 4 mm plate, no ribs, 2 mm corner | 0.64, would break | 30 mm | 1 h 42 min | 23 g |
| 6 mm plate, no ribs | 1.8, too weak | 8 mm | 2 h 2 min | 27 g |
| 7 mm plate, no ribs | 2.4, passes | 5 mm (sags) | 2 h 12 min | 29 g |
| 4 mm plate, 2 mm ribs (the defaults) | 5.9, passes | 0.2 mm | 4 h 28 min | 43 g |
| 5 mm plate, 4 mm ribs | 13.8, passes | 0.1 mm | 4 h 38 min | 49 g |

Ribs are the strong, stiff choice; a 7 mm plate without them is the quick
print that only just passes and sags. Aim for a safety factor between the
target and about 6: much more wastes filament and print time. Loads scale
the safety factor down in proportion (twice the load, half the factor).

`print`: **layer_height** 0.2 mm (0.12-0.16 for a smoother finish, slower);
**infill** 20 %; **walls** 3; **up** `y` for a bracket from this book (on
its side, no supports); `z` for parts that sit flat as drawn.

## Example

Request: "Will this bracket hold a 15 kg shelf printed in PLA? If not, make
it stronger and tell me how long it takes to print." Data: one STEP part
(cad).

Plan: Printed parts, action `strengthen`, with load 74 (half of 15 kg × 9.81,
one of two brackets), material pla, rib 2, thickness 4, fillet 5. Outputs:
the new bracket (STEP and 3D model), its stress and safety factor, the
toolpath, and the print time, filament and cost.

Request: "Will this hold 10 kg in PETG?" Plan: Printed parts, action `test`,
with load 49 (half of 10 kg × 9.81), material petg.
