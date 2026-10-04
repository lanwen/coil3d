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
  `BRepGProp.VolumeProperties` with a 1e-5 precision, like the tests.
- A near-flat shelf in the wall profile (the deep groove's circle meeting the
  ridge almost level) folded the fitted B-spline into a solid that was valid
  in memory but invalid after a STEP round trip, on an 8 mm cable. The profile
  caps that flank at 70 degrees from the axis (wall.ts).

## Open

- STEP output has been read back by OCCT only. Open it in FreeCAD and in a CAD
  program before relying on it.
- STEP size grows with height (V samples are proportional to the turn count).
  Knot removal, or a fit with a tolerance, would shrink it. This is untested.
