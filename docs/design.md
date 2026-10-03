# coil3d design notes

coil3d is a static, client-side web app. You enter the length and diameter of
a cable. It designs a 3D-printable coil (a tube with a helical groove, a
bottom flange and usually a top cap), draws it in an IKEA-instruction style,
and exports STL, 3MF or STEP. The whole configuration lives in the URL hash.

This file records why the app works the way it does. The mount geometry is in
[mounts.md](mounts.md). Known pitfalls of the STEP export are in
[step-notes.md](step-notes.md).

## Decisions

| Topic | Decision |
|---|---|
| Use cases | USB and headphone cables (2-5 mm, 0.5-3 m) and EU extension cords with a heavy plug (8-10 mm cable, up to 15 m). The ranges cover both. |
| Solver | The cable length and diameter are always inputs. The user locks what they know; the solver fills in the rest. At most two of core size, height and layers can be locked. |
| Winding | Helical. The groove guides layer 1 only. Higher layers nest in the valleys of the layer below (orthocyclic winding). |
| Core | A tube. It is hollow and open. The user locks either the inner diameter (bore) or the outer diameter (winding surface). A 3 mm wall links the two (thicker for a cable over 3 mm, so 1.5 mm of wall stays under the groove). |
| Shapes | Round, rounded square, rounded triangle. Round is a diameter, square is across flats, triangle is the inscribed-circle diameter. |
| Cable | Round cross-section only. Bend limit: USB/audio 4x the diameter, flexible cord 4x, stiff or solid 10x, or a custom multiplier. |
| Parts | A core with the bottom flange printed as one piece. A separate top cap, on by default when there is more than one layer. Separate rim clips or T-clips for SKÅDIS (3 or 4), or a separate mount plate with two alignment pegs for the hidden openGrid placeholder. |
| Cap joint | Press fit, bayonet or snap. All are permanent and glue-friendly. One global print tolerance scales every fit. The bayonet (three lugs in the core's bore, L-slots in the cap's collar, a 60° twist to a stop) needs a round core; elsewhere the cap gets the press-fit collar, with a warning. The snap cap has one 12 mm finger per side of the bore (slots at the corners: four on round and square cores, three on triangles), each with a barb along its whole width that clicks under a ridge ring inside the core's bore: a 30° lead-in, so it goes on with about half the pull-off force, and a 45° retaining face (the print overhang limit). Seated, the barbs sit 0.2 mm into the ridge, so the fingers stay a little bent, pull the cap onto the rim and centre it: no radial or tilt play. Under the finger tips a seat ring narrows the bore to the cap's hole, so there is no step inside the seated cap. Nothing is cut into the core's wall. A core too small for the clips gets the press-fit collar, with a warning; see [Snap joint](#snap-joint). |
| Label | Text engraved into the top cap's room-facing face. It is hidden, with a warning, when it does not fit. |
| Printer | A bed-size setting. It only produces warnings. The app never rearranges parts to fit. |
| Units | Metric only. English only. |
| Persistence | No local storage. All state is in the URL hash. |

### Orientation

The coil axis points out of the wall. The bottom flange's outer face is
against the wall, and the mount features are on that face. The top cap faces
the room, so the label is on it. The coil is storage, not a rotating spool:
take it off the wall to unwind it. Unwinding over the end of a fixed spool
adds one twist per turn, and the guide tells the user to rotate the coil.

### Cable ends

Neither end of the cable has a connector pocket. Both connectors hang outside.

- Inner end: a channel recessed into the bottom flange's inner face. It is
  swept along the straight line the cable takes when it leaves the groove
  start, so the cable never bends tighter than its bend radius. The first turn
  starts on the flange face, so the cable first shifts sideways along the face
  until the channel is clear of the wall, and only then drops into it. It is round,
  one cable diameter plus tolerance across, and it follows the cable's own
  drop so that layers do not wind over a bump. It ends in a snap-in clip near
  the rim. The clip opening is 8% of the cable's diameter narrower than the
  cable, so the cable presses in from the top and leaves the rim sideways,
  along its own direction. The lips are stubs on a thick wall and PLA does
  not flex, so the cable's own jacket takes the interference (0.24 mm at
  3 mm). The mouth is a 45-degree funnel above a 0.3 mm land, which centres
  the cable. The opening never goes below 0.75 of the bore, which keeps the
  lip underside within 45 degrees (41 degrees at the floor).
- Outer end: a clip hanging under the top cap, just outside the wound cable
  (#237). It is a low rib, flush with the cable's underside, with its ends
  ramped into the plate at 45 degrees. The cable snaps up through a 45-degree
  lead-in and a throat only a little narrower than the cable (0.88 of the
  bore), so the cable's jacket takes the squeeze. The walls round the bore are
  half a cable diameter thick (1.2 to 2 mm), so the lips stay stiff: in
  PLA a millimetre-sized lip can't flex much without cracking across the
  layer lines, which is how the earlier clip broke. It is repeated every 90
  degrees (round, square) or every 120 degrees (triangle), so an end that was
  unwound a little still has a clip. A clip that would stand in the drawn
  cable's way is left out. The cap's middle
  is a straight through-hole, so nothing prints as a bridge. With no top cap,
  the cable leaves the last turn as a straight tangential tail.
- The flange and cap margins grow when a clip needs more room.

### Parts and printing

- Every part is one connected solid and prints flat on the bed without
  supports: overhangs of at most 45 degrees and no large bridges. This is why
  the clip mount is a separate plate (clips cannot point into the print bed),
  why the label is engraved (a raised label would sit below the bed plane in
  the cap's print orientation), why the label's letters are at most about
  5.6 mm tall (each letter's floor prints as a bridge as wide as its stroke,
  so strokes stay under 1.8 mm), and why the plate and the flange are joined
  with blind holes and printed pegs.
- One accepted exception (#175): the keyhole mount's undercut roof is a flat
  bridge as wide as the screw head (8 mm). Most printers bridge it, and a
  45 degree roof would need a 3.5 mm thicker pad. The tests cap it at 8.5 mm.
- The flange is the final outer envelope of the wound cable plus a margin.
- The flange and the top cap have a 1 mm x 45 degree chamfer on their outer
  edge, on both faces (#229, #237, `EDGE_CHAMFER`, `src/core/edgeChamfer.ts`).
  The cap's cable clips stay inside the foot of its underside chamfer. A 3 mm
  plate keeps a 1 mm vertical land. The through-hole mount keeps its holes
  1 mm further from the rim, so the screw head sits on the flat top. The
  exports keep the chamfer; the drawings leave it out (see Rendering).
- Print orientation hints appear in the guide and in the 3MF placement.

### Tolerances

Rough FDM values: press fit about -0.1 mm, sliding fit 0.15-0.2 mm, loose fit
0.35-0.5 mm. The app exposes one global tolerance, 0.2 mm by default (0.05 to
0.8 mm).

## Shapes

The capacity math needs convex outlines. Every shape is a regular n-gon with
rounded corners, described by three numbers: the corner count `n`, the
apothem (centre to flat side) and the corner radius. Round is the case where
the corner radius equals the apothem, so the straight sides have zero length.
All three size conventions are chosen so that the apothem is always
`size / 2`. That keeps the solver's bounds the same for every shape.

`ShapePlugin` in `src/core/shapes.ts` is a small registry entry: `kind`,
`label`, `sizeSemantics` (`diameter`, `acrossFlats` or
`inscribedDiameter`), `corners` and `maxCornerRadius(size)`. The geometry
helpers (`offsetPerimeter`, `pointAt`, `circumscribedRadius` and so on) work
on any `ShapeOutline`, so a new shape only adds an entry. A position on the
outline is a pair (segment, fraction), which does not depend on the offset.
So `point(position, offset) = base + offset * normal` is exact for any offset.

For the same size, a triangle's corners reach further out than a square's,
so its flange is larger. The footprint is the true offset outline, not a
bounding circle across a sharp corner.

## Capacity math

The solver (`src/core/solve.ts`, `src/core/capacity.ts`) is the core of the
app.

**Offset perimeter.** When you offset a convex rounded shape outward by `o`,
the straight sides keep their length and the corner arcs grow. The arcs
always add up to one full circle (the Steiner formula):

```
P(o) = S + 2 pi (r_c + o)        S = sum of straight sides, r_c = corner radius
```

**Layer centrelines.** For a cable of diameter `d` and a groove depth `g`
(`0.4 d`, so `o_1 = 0.1 d`: layer 1's centre sits just above the ridges):

```
o_1 = d/2 - g
o_k = o_1 + (k - 1) h            h = d sqrt(3)/2 (orthocyclic, ideal) ... d (stacked, worst case)
```

A "winding quality" `q` from 0 to 1 blends `h` between the two. Hand winding
is rarely perfectly orthocyclic. The default is 0.7. Real coil makers report
25-30 % less than the ideal capacity.

**Turns per layer.** The pitch `p` is the groove's width at the surface plus
a 0.3 mm land on the ridge (about `1.15 d + 0.3 mm`: 3.78 mm for a 3 mm cable,
see Geometry: Groove). Layer 1 has `floor(H / p)` turns, where `H` is how far
its centreline can climb: from the groove start, with the cable's bottom on
the flange face, until the cable's top is 0.3 x its radius below the core's
top face. Higher layers have `floor((H - q p / 2) / p)`. This is a
continuous approximation that keeps the solver monotonic. Check it against a
real wound coil before relying on it at the last turn.

**Length.** `L_wound = sum_k n_k sqrt(P(o_k)^2 + p^2)`. The helix correction
is small, but free.

**Solver.** Each output grows monotonically with each free variable, so one
free variable is solved by bisection (or an integer search for layers). The
search keeps the upper bracket, because a midpoint can round down across an
integer turn count and undershoot. With two free variables the solver needs an
objective: `minVolume` (smallest envelope, the default) or `aspectRatio`
(height close to the envelope diameter), and it also returns an alternative
candidate. With three free variables it tries a few layer counts, returns
two or three candidates and warns that defaults were applied. The solver never
reports "ok" when the capacity is below the target length. A design that holds
the cable is "ok" ("under-constrained" with all three free), whatever the
number of free variables, even when the locks or the bend limit force more
room than the cable needs. Above 10 % that room gets a note naming the cause:
the locks that could shrink and still hold the cable, or else the smallest
core the bend limit allows. "infeasible" (or, fully locked,
"over-constrained") always means the cable doesn't fit.

Every candidate is tight: no free variable can shrink and still hold the
cable. Where the size is free it is the smallest that covers the target. At
the size floor a free height drops to the smallest that still covers it, and a
free layer count never keeps a layer the cable doesn't need. So a candidate
overshoots by less than one step of a free variable: about 0 for a free size
above its floor, less than one turn per layer for a free height, less than the
outer layer for a free layer count. An objective only chooses among these
candidates; it can't buy proportions with extra capacity.

**Constraints.**

- The innermost layer's corner radius must be at least the minimum bend
  radius `MBR = multiplier x d`. Outer layers only get rounder.
- For a round core the corner radius is the whole radius, so the bend limit
  is a hard floor on the size: `2 (k d - d/2 + g)`, which is `2 (k - 0.1) d`
  with the groove at `0.4 d`. A 9 mm cord at 4x needs a core of at least about
  70 mm. A square or triangle can have a smaller
  corner radius, but a core that is too small turns into a circle. So the
  solver also keeps every flat side at least two cable diameters and 15 % of
  the perimeter long. It raises a locked size that is below this floor and
  warns, for a round core too (where the floor is the bend limit alone).
- The whole drawn cable (lead-in, layer transitions, outer end) stays within
  the bend radius. Tests check this for every "ok" design, piece by piece
  (`test/cableBend.test.ts`).
- Layer 1 ends with the cable's top 0.3 x its radius below the wall's top
  face (the usable height above leaves that room), so the drawn cable never
  grazes the top face. Its last half turn stays in the fading groove.
- The flange is at least the outermost layer plus a margin.
- The label only renders when its bounding box fits the cap annulus.
- Each part is checked against the bed size.

On the flat sides of a non-round core a stiff cable bows outward instead of
lying flat. The app does not model this.

## Geometry

### Mesh backend

All geometry runs in a Web Worker. The app does not boolean the groove. The
core's outer surface is a parametric surface: the wall displaced inward by the
groove profile, as a function of arc length and height. The mesh is generated
from it directly. This is fast and exact, and it cannot self-intersect.
(Cutting a helical sweep with a boolean is a known OCCT failure mode, see
[step-notes.md](step-notes.md).) manifold-3d is only used for the simple
features: flange, joints, clips, mounts and label.

- **Sheared rows.** Mesh rows follow the helix, so every column samples the
  groove profile at the same phases. The profile is exact, there is no
  aliasing, and the seam closes without special code. Adjacent columns are
  stitched with a z-sorted zipper. The rows are spaced evenly along the
  profile's own length, not in z, so the steep edges of the groove get as many
  rows as its floor. One more row sits on the floor, on each flank's tangent
  point and in the middle of each ridge's land. The land's two edges get no row, so the
  mesh's crest is one sharp edge (as a nozzle prints it) and the viewer draws
  one line per ridge, not two creases a fraction of a millimetre apart that
  break up. The groove fades
  out over 0.15 turn at its top end by sliding the profile out of the wall,
  so it gets shallower and narrower together. At the bottom it runs on 0.1
  turn before layer 1's start, level with it, fading the same way, so the
  first turn already sits in the full groove. The viewer leaves out the
  creases within a fade (they cross the crease angle along it and would draw
  as broken lines), so a groove's lines end where its full depth ends. The
  crest above a fading groove counts as part of the fade too: there the
  surface sits at offset 0 whatever the groove's depth.
- **Resolution.** `draft` is coarse and is shown on the first load, and later
  only if a build is slow. `final` is used for the settled view and for every
  export. Both use the same code path, so they cannot drift apart. The
  preview debounces input and drops stale results.
- **Memory.** Every manifold object must be freed with `.delete()`, or the
  WASM heap runs out after a few builds.
- **Boolean order.** Booleans against the big wall cost much more than
  booleans between small parts. Combine the small parts first and touch the
  wall once or twice. Force evaluation inside a timer, because manifold
  booleans are lazy.
- **Flush features.** A small feature fused or cut exactly flush with a
  face can fail silently (it passes `status()` and `genus()` but leaves a
  disconnected piece). Embed such features past their face by a fixed margin
  (`WELD_OVERLAP`, `MOUNT_PLATE_EMBED`). A cut shape that is open to an edge
  must be an outer-contour detour, not a hole.
- **No COOP/COEP headers.** The host may not set them, so there is no
  `SharedArrayBuffer` and no threaded WASM. All WASM builds are
  single-threaded.

### Groove

- The profile follows the cable. A plain semicircle makes a ceiling overhang
  when the core prints upright, so the groove is a teardrop: a circle of
  radius `d/2 + 0.15 mm` whose upper flank is a 45-degree tangent line.
- Depth is `0.4 d`: the cable's centre sits `0.1 d` above the ridges between
  the turns (at `0.3 d` it sat `0.2 d` proud and slid out while winding). The
  45-degree flank caps how close the ridges can come: the deeper the groove,
  the wider it is at the surface. So the pitch is not `d + clearance` but the
  groove's own width at the surface plus a 0.3 mm flat land on top of each
  ridge, and ridges never come to a knife edge. At `0.4 d` that costs about
  12 % of the turns per layer against the old `d + 0.3 mm`; centre level with
  the ridges (`0.5 d`) would need a pitch of about `1.3 d` and cost 20 %.
- Where the circle's lower flank would meet the ridge steeper than 70 degrees
  from the axis (nearly flat), it runs on as a straight chamfer instead. A
  near-flat shelf is a knife-edge corner, and the STEP export's B-spline wall
  can't fit it (it folded into an invalid solid on thick cables).
- The first turn starts on the flange face: at layer 1's start the groove's
  lower edge is 0.2 mm above the face, so the cable's bottom sits about
  0.3 mm above it. Nothing is left below the first turn to slide down into.
- The groove covers layer 1 only.
- The helix phase follows the arc length of the groove floor, not of the
  un-grooved surface, so the pitch does not bunch up at corners.

### Backends must agree

The mesh and STEP backends build from the same shared layouts (the wall
profile, the joint geometry, the label outlines, the mount and clip layouts).
Each STEP solid is checked against the part's mesh volume (see Export).

### Snap joint

`snapLayout` in `src/core/joints.ts` lays out both parts. The numbers below
are for PLA and the default 0.2 mm tolerance; each finger is treated as a
cantilever strip, so compare them with each other, not with a force gauge.

- **Strain.** A finger's bending strain at full deflection goes with
  thickness x deflection / length². The old 7 mm fingers reached about 3%
  for 0.5 mm of engagement, at PLA's yield (and the fingers bend across their
  layer lines), so they likely took a set and lost grip. The 12 mm fingers
  reach about 1.8% for 0.8 mm (2.1% at the tightest tolerance).
- **Engagement.** Barbs and slots follow the outline. A barb on a stiff
  corner can't flex, so the slots sit at the corners and every finger is one
  side. The old round barb on a square core engaged only near each flat's
  middle, about a quarter of the perimeter.
- **Faces.** Both parts print with the axis vertical, so the retaining faces
  (the barb's back face, the ridge's underside) are overhangs and stay at
  45°. The lead-in faces up as printed, so it is 30° from the axis: on a
  square core the cap goes on with about the old force and comes off with
  about 1.8 times it.
- **No play.** Seated, the back face sits `SNAP_PRELOAD` (0.2 mm) into the
  ridge's underside. The fingers stay bent by that much (about 0.5% strain),
  which pulls the plate onto the rim and centres the cap. A print error under
  0.2 mm leaves no gap. The root flare still clears the bore by 0.1 mm +
  tolerance, as a hard stop. The drawn, assembled parts overlap there by
  design (`test/snapJoint.test.ts` measures it).
- **Seat.** A ring under the finger tips narrows the bore to the cap's hole:
  a flat top 0.3 mm under the tips (it prints facing up), then a 45° chamfer
  back out to the bore. It is inside the wall, so the winding capacity does
  not change. It costs a little plastic and narrows the bore just under the
  joint to the cap's hole, which is the narrowest point anyway once the cap
  is on. A core too short for it keeps the snap without the seat.

## Export

| Format | How |
|---|---|
| STL | Binary STL. One file for a single part, a zip of STL files for several. Each part is in its print orientation, resting on the bed. |
| 3MF | A hand-written core-spec writer on a small zip writer. One `<object>` and one `<build><item transform>` per part, laid out on the plate. Names and units are set. No colours: Bambu, Orca and PrusaSlicer ignore `basematerials` and read only a vendor `paint_color` attribute. It is not tested in a slicer in this repo. |
| STEP | One file, one solid per part. The OpenCascade WASM is loaded lazily in a worker when the user asks for STEP. |

### STEP

STEP uses replicad (OpenCascade WASM). The grooved wall is a periodic cubic
B-spline surface, fitted in JavaScript (`src/core/step/bspfit.ts`) to the same
parametric grid the mesh uses. The poles go straight into
`Geom_BSplineSurface`. Planar caps are added, the faces are sewn into a solid,
and the bore is cut. Booleans for the rest are ordinary and run on planar or
analytic geometry.

Why this way:

- OCCT's own surface interpolation broke at high resolution and crashed the
  WASM. The fit is plain linear algebra and is robust.
- Sweeping a profile along a long helix and cutting it fails silently.
- Both backends sample one grid, so they cannot drift apart.
- A build takes about 0.2-0.4 s, and the result matches the analytic volume to
  a few thousandths of a percent.
- replicad exposes the raw OCCT classes that the fit needs. The other
  candidate, occt-wasm, exposes only a facade and has no text support, with
  no real size advantage.

Every export checks that each solid is valid, that there is exactly one solid
per part, and that the volume matches the mesh within 1.5 %. A boolean that
removes nothing counts as a failure. See [step-notes.md](step-notes.md).

Bundle sizes (production build): the main script is 1.5 MB (430 kB gzip), the
manifold WASM is 0.5 MB, and the OpenCascade WASM is 23.0 MB raw, 7.2 MB gzip
and 5.0 MB brotli. Only the last one is lazy. The host should serve it
compressed. The OpenCascade build is LGPL-2.1, so it stays a separate,
replaceable file; [occt-source.md](occt-source.md) says where its source is.

STEP output has not been opened in FreeCAD or Fusion. It has been read back
with OCCT only.

## URL hash

The hash is `#s=<base64url(JSON)>` (`src/core/hash.ts`).

- The JSON document has a numeric version `v` (currently 2) and short keys for
  the spec: `L` (cable length, mm), `d` (diameter), `wt` (cable type), `mbr`
  (custom bend multiplier), `q` (winding quality), `obj`, `shape` and `rc`
  (corner radius), `lock` with `size`, `h` and `ly`, `cap`, `joint`, `tol`,
  `bx`/`by`/`bz` (bed), `label`, and the mount keys (`mount`, `pj`, `kr`,
  `thd`). View-only state is nested under `ui` (`wire`, `view`). Lengths are
  always millimetres; the centimetre display in the controls is a UI-only
  conversion.
- Values equal to their default are left out. A new field is added to the zod
  schema, is left out at its default, and gets a round-trip test.
- The schema is strict. An unknown key, an out-of-range value, an unsupported
  version or garbage input falls back to the defaults and shows a notice.
- Compression is not used. It would make the codec async, or need a new
  dependency, and links are already short.
- `openGrid` is never accepted from a link, because its connector is a
  placeholder (see [mounts.md](mounts.md)).
- coil3d is in beta, so links are not guaranteed to survive spec changes and
  there is no migration code. A link that is not a readable `#s=` document
  (including the old flat query-string form) falls back to the defaults.
- The hash never reaches the server.

## Rendering

The viewer draws IKEA-instruction line art: white surfaces, black lines, an
orthographic camera, and a transparent background (`src/viewer/lineArt`).
It does not use lighting.

1. One full-scene pass renders normals and depth into a target with a depth
   texture.
2. A fullscreen shader finds lines on that: silhouettes (a model pixel next to
   an empty one), occlusion steps (the second difference of depth, so grazing
   surfaces do not produce black crescents), and creases (the normal turns by
   more than 30 degrees). The viewer splits vertex normals at hard edges, so
   smooth curves never reach the threshold.
3. A dilate ("thicken") pass makes pixels black near a line pixel. The
   thickness is recomputed each time the model is framed, from the diagonal of
   its projected bounding box, so the line weight follows the on-screen size
   of the model and stays a thin pen line. The pass only samples the circle
   the pens can reach, not the whole square of the largest pen.
4. FXAA runs last.

The engraved label is drawn differently, because its letters are only a few
millimetres tall: the usual lines on its pocket walls and floors would fill
the letters in. The top cap mesh marks the label's pocket faces
(`CoilMesh.labelTriangles`), the normal pass writes that mark into its alpha,
and the edge shader draws only the outline of the marked area, with a finer
pen than the other lines.

The rim chamfer (#229) is too small for an IKEA drawing, so the same alpha
channel carries a second mark (`CoilMesh.rimTriangles`: the chamfer bands and
the land between them), and the edge shader leaves out the crease between a
chamfer and the plate's flat face. The rim then draws as a plate with a square
edge: the line where the chamfer meets the land, and the silhouette.

The edge shader reads a needle-thin triangle (a thousandth of a millimetre
wide) as isolated pixels, which show as a dotted line on a flat face. The
booleans leave such triangles in the flat faces of the top cap and of the
core's flange, so those meshes have every edge cut to 10 mm and the edges
inside each horizontal flat face flipped to the triangulation with the best
smallest angle (`src/core/flatFaces.ts`).

The camera is refitted to the projected bounds when the geometry changes.
The wound cable is drawn as one merged tube per layer, with smooth normals so
the tube's facets do not draw lines. A layer with many turns (over 60) is
drawn as a plain envelope shell plus a few real turns, because the occlusion
lines between hundreds of adjacent turns would merge into a black band. When
the final mesh replaces the draft, it fades in over a quarter of a second.

Every canvas renders on demand. The assembly guide has about a dozen figures,
and each one runs this whole pipeline, so a guide figure only renders while it
is within 200 px of the viewport (`GuideFigure`; its `data-rendered` attribute
turns `true` after the first draw). The canvas keeps its last picture while it
is away. The print button draws every figure first
(`renderAllGuideFigures`), because a browser prints the canvases as they are.

The look and the pass structure follow
[nmattia/skapa](https://github.com/nmattia/skapa), a SKÅDIS box generator.
skapa has no licence, so no code was copied: the technique was reimplemented
from reading how it works. The draft-to-final swap and the view presets were
inspired by [andymai/gridfinity-layout-tool](https://github.com/andymai/gridfinity-layout-tool)
(AGPL-3.0). No code from it was used either.

## Roadmap

- A clip on the cable that stops the coil from unwinding.
- A connector pocket, if one is ever needed. Connector sizes (USB-A/C,
  Lightning, 3.5 mm, Schuko) would be modelled then.
- The real openGrid snap connector (see [mounts.md](mounts.md)).
- A fit-test coupon (a groove sample and a joint sample) so users can
  calibrate the tolerance before a long print.
- Test a real print: the SKÅDIS rim clips and their latch on a board, the joints, the 3MF in a
  slicer, and the STEP file in a CAD program.

## Sources

- Winding: [orthocyclic winding](https://www.e-magnetica.pl/doku.php/orthocyclic_winding),
  [rounded rectangle perimeter](https://mathworld.wolfram.com/RoundedRectangle.html),
  [reel capacity](https://www.quabbin.com/tech-briefs/method-calculate-capacity-reel-or-spool)
- Bend radius: [Anixter](https://www.anixter.com/en_us/resources/literature/wire-wisdom/minimum-bend-radius.html)
- FDM fits: [Formlabs snap-fits](https://formlabs.com/global/blog/designing-3d-printed-snap-fit-enclosures/)
- OCCT helix failures: [OCCT #1543](https://github.com/Open-Cascade-SAS/OCCT/issues/1543),
  [#1558](https://github.com/Open-Cascade-SAS/OCCT/issues/1558),
  [FreeCAD #18658](https://github.com/FreeCAD/FreeCAD/issues/18658)
- Kernels: [replicad](https://github.com/sgenoud/replicad),
  [manifold](https://github.com/elalish/manifold)
