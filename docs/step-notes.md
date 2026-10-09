# STEP export notes

How the STEP backend works is in [design.md](design.md#export). This file lists
the OpenCascade (OCCT) failure modes we met, so nobody tries them again.
The backend is `src/core/step/`: `bspfit.ts` is the B-spline fit, `build.ts`
builds and validates the solids.

## What works

1. Fit a periodic cubic B-spline surface in JavaScript to the same `R(s, z)`
   grid the mesh uses. U (around the outline) is periodic, V (up the wall) is
   clamped with analytic end tangents. Pass the poles and knots straight to
   `Geom_BSplineSurface`.
2. The boundary rows of the grid are exactly planar. Each cap is a planar face
   made from the boundary curve. Sew the faces, make a solid, fix it, and cut
   a straight bore. The bore never touches the B-spline surface, so that
   boolean is easy.
3. Cuts and fuses for slots, holes, clips and the label work on this solid.
4. Accuracy depends on samples per pitch in V. About 20 samples per pitch keeps
   the surface within 0.1 mm of the analytic wall.
5. The groove lip must be smooth (G1). A sharp crease between land and groove
   makes the fit oscillate. Keep a small lip radius, or put knots at the
   crease.

## OCCT detail

- OCCT wants the periodic pole index shifted by `NU - 1` compared with the
  textbook layout. Shift the poles only. Rotating the knots as well pairs each
  pole with the wrong span and puts the volume off by about 5 %.

## What fails

- **`GeomAPI_PointsToBSplineSurface.Interpolate(points, periodic)`.** It is
  fine on small grids. On large grids the top boundary stops being planar, the
  cap face fails, and `GeomAPI_ProjectPointOnSurf` crashes the WASM module with
  `RuntimeError: table index is out of bounds`. Fit in JavaScript instead.
- **A facade that only approximates a non-periodic surface** (the occt-wasm
  `bsplineSurface`). At a moderate grid the bore cut was silently dropped and
  the volume was 5 times too large. At a fine grid it threw
  `makeFace: construction failed`.
- **A loft through exact periodic sections.** It is valid in memory. After a
  STEP write and read back, both readers reported it invalid with the wrong
  volume. Always round-trip a candidate approach through STEP before
  trusting it.
- **A pipe-shell sweep and cut along one long helix.** `BRepAlgoAPI_Cut`
  returned an empty shape with no error and no warning. `Common` returned the
  whole tube. Frenet or binormal mode, `ShapeFix_Solid` and a fuzzy value did
  not help. The classifier fails on one face that wraps many turns. Splitting
  the spine into quarter-turn arcs or one tool per turn works, but is 5 to 15
  times slower than the B-spline wall.
- **The same sweep at a groove depth of half the cable diameter.** The helix
  centre lies on the wall surface. The cut reported only a warning and
  returned a wrong solid that still passed validation, with 120 % too much
  volume (the groove was mostly not cut). The shipped groove is 0.4 d deep,
  baked into the B-spline wall rather than cut; the lesson holds for any
  feature.
- **A pipe-shell sweep on a rounded square with a single B-spline spine.**
  `pipe shell failed`.
- **A fillet on the grooved wall's outer edge.** It ran for minutes and then
  threw `[object WebAssembly.Exception]`. Do not fillet B-spline edges. Bake
  chamfers or lead-ins into the surface function instead.
- **A faceted STEP written through OCCT.** About 2.5 KB of STEP and 3 ms per
  triangle. A print-quality mesh gives a file of tens of MB and takes
  minutes. If a faceted fallback is ever needed, write it directly in
  JavaScript.

## Validation

`BRepCheck_Analyzer` says "valid" for a solid that is silently wrong. Only a
volume check catches it. Every export therefore checks, per part: the shape is
valid, there is exactly one solid, and the STEP volume matches the part's mesh
volume within 1.5 % (`VOLUME_TOLERANCE`). A cut that removes no volume counts
as a failure.

Other things we learned in the shipped code:

- `checkedCut` and `checkedFuse` retry with a small fuzzy value, from far
  below print resolution upward. Swept cutters with hundreds of small planar
  faces sometimes cut nothing at all without one.
- Cutting a bore from an already-fused plate and block removed the bore's
  whole volume, even where the bore ran outside the part. Cut the bore from
  each piece separately, then fuse.
- Free WASM objects explicitly (`.delete()`), or they pile up in the OCCT heap.
- Small features fused exactly flush with a face fail in the mesh backend too.
  Embed them past the face.
- replicad's `measureVolume` integrates at a fixed order. On the deep groove's
  B-spline wall it misread the volume by 2-3 %. The export's own check uses
  `BRepGProp.VolumeProperties` with a 1e-3 precision (it is within 1e-5 of the
  1e-5 run and takes a third of the time); the tests use 1e-5.
- A near-flat shelf in the wall profile (the deep groove's circle meeting the
  ridge almost level) folded the fitted B-spline into a solid that was valid
  in memory but invalid after a STEP round trip, on an 8 mm cable. The profile
  caps that flank at 70 degrees from the axis (wall.ts).

## A bare core's face channels

A boolean against the fitted wall costs about 35 ms for every tool face, even
for a box in the middle of the bore: the wall is one face that wraps the whole
outline, so its bounding box overlaps every tool, and OCCT must show that each
pair does not meet. Cutting the bore, the rings and the channel from the wall
therefore took 2 to 4.5 times as long as before (a 60 mm round core 2.1 s
against 0.5 s; a square or a triangle 6 s against 1.5 s with one layer). Now
only the channels are a boolean against the wall:

- The bore and the two rings are one analytic cut (bore minus rings; no wall in
  it). The tube is not cut from a wall solid. It is sewn from the wall's faces,
  the faces of that analytic void, and the two end caps, which are planar faces
  with the void's openings cut out of them.
- The wall is split in z at the channels' reach (the channel's level plus its
  radius and 0.5 mm). Each band is fitted on its own, and the bands share their
  boundary curves. The two end bands are also split in u into sectors of about
  16 columns. Each sector is its own face on its own small surface, so its
  bounding box meets only the channel tools near it. The middle band stays one face.
- One cut removes both channels. Each end's arcs are fused into one tool first,
  then the two ends go in as a list of tools. Overlapping arcs in the list left
  slivers of the core as extra solids.

Pitfalls met:

- A sector is a clamped cubic patch with the same poles as the fitted surface
  (knot insertion at both ends; the difference to the fitted surface is 1e-14).
  The same patch left unclamped was valid in memory, yet it read back from STEP
  with 21 % too much volume. Round-trip any change to these surfaces.
- Cut with a fuzzy value (`SEWN_FUZZY`, above the tolerance sewing leaves on the
  seams). Without one, the top channel of a 100 mm square core cut nothing, with
  no error, and the volume check passed at 0.5 %.
- A sewn solid can come out inside-out; a point in the wall tells which way it faces.
- Rings and tools overshoot the faces they cut through. A tool face on the
  wall's own cap plane made each cut 1 s slower.
- Sectors of 6 columns or of 48 columns were slower than 16 (more faces to sew and check, or bigger faces to intersect).

Cost, with one layer and no cap: a 36 mm round core takes 0.9 s, a 60 mm rounded
square 1.3 s and a 90 mm triangle 1.25 s. Without channels they took 0.9, 1.2 and
1.0 s, and with the channels cut from the wall 2.4, 5.6 and 6.6 s.

## Build details

- `build.ts` is reached only through a dynamic `import()` (`index.ts` and
  `worker.ts`), so replicad's WASM stays out of the main chunk. Node has no
  `Worker` and builds inline. `worker.ts` types its own scope instead of adding
  the `webworker` lib to the whole project.
- The fit's U samples are the mesh's own corner-favouring columns
  (`outlineColumnParams`), so the fit is a non-uniform periodic cubic. Its
  collocation coefficients are Cox-de-Boor values per row, not the constant
  1/6, 4/6, 1/6. Raising a uniform column count to the same corner density
  also works, but a shape needing 4 times the columns took 3.3 times as long to
  build, because booleans against the surface scale badly with it.
- The periodic U system is cyclic tridiagonal. It is solved by Sherman-Morrison
  (two plain tridiagonal solves). The two corner entries are row 0's wrap
  entry (column n-1) and row n-1's wrap entry (column 0). Swapping them goes
  unnoticed while the coefficients are constant and shows once they are not.
- The volume tolerance is 1.5 %, not 1 %. A 60 mm rounded square (15 mm
  corners, one layer) has a fitted tube about 0.9 % under the mesh wall, and
  its fuse with the flange loses a little more, because the fitted wall reaches
  a hair below z=0.
- `checkedCut` compares the first cut with the next fuzzy value's. The
  inner-end channel on one wide flange removed 7 mm^3 of 2958 at the smallest
  fuzzy value and all of it at the next. Two results within 1 % settle it;
  otherwise the cut that removes most wins.
- A swept solid is built from its own planar faces, the triangles the mesh
  uses (a quad stays one face where it is flat). A ruled loft through the same
  rings gave the same shape and was several times slower.
- The inner-end cutter is clipped against the wall's outline grown by
  `INNER_CHANNEL_WALL_GUARD`. Clipping against the exact outline risks a
  razor-thin coincident seam.
- The countersink cone reaches 0.5 mm into the bore and 1 mm above the face, so
  its cut leaves no coincident faces.
- Glyph and mount outlines are built with `makePolygon` in one call. A long
  `draw().lineTo()` chain let replicad's `FinalizationRegistry` collect a curve
  still in use (`This object has been deleted`).
- A label is the fused solid loops minus the hole loops (an "O" is a ring),
  since replicad has no face primitive with several contours.

## Open

- STEP output has been read back by OCCT only. Open it in FreeCAD and in a CAD
  program before relying on it.
- STEP size grows with height (V samples are proportional to the turn count).
  Knot removal, or a fit with a tolerance, would shrink it. This is untested.
