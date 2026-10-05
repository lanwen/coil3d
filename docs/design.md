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
| Cable | Round cross-section only. Bend limit: USB/audio 2.6x the diameter, flexible cord 2.6x, stiff or solid 6.5x, or a custom multiplier (2.6x by default). |
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
- Outer end (#241): a rim slot in the top cap, and the same slot in the base
  flange right below it. Each is a keyhole cut straight through the plate:
  a round seat one cable diameter plus tolerance across, a 1 mm neck out to
  the rim that is 8% narrower than the cable (the same squeeze as the inner
  end's clip, which a cable jacket takes; the plate beside it is rigid), and
  a 45-degree lead-in through the rim chamfer. The cable is pressed in from
  the edge and passes through the plate. The seat doesn't clamp it, and a
  connector behind it stops it pulling through. The walls are vertical, so
  both parts still print without supports. The cap's slot sits where the
  cable's lead-out arrives under the cap. Each slot moves along the rim if
  something is in the way: on the base the inner-end channel and its pad,
  the mount's holes, slots and pads, the SKÅDIS notches; on the cap the
  label. The drawn cable runs level under the cap and curves out past the
  rim, under the cap's slot, within its bend radius. The top turn sits flush
  under the cap, so a cable pressed up into the slot right above its end
  bends tighter than its bend radius there; rising through the plate within
  it would take 10 to 20 mm along the cable. (#237's clips under the cap
  needed 6 to 8 mm of margin beside the wound cable, so they were removed.)
  With no top cap, the cable leaves the last turn as a straight tangential
  tail.
- The flange and cap margins grow when the inner end's lead-in or the base
  slot needs more room (the slot's seat stays 0.4 mm clear of the wall, and
  may cut through the collar pad beside it).
- The flange and cap cover the drawn cable as it really runs, not just the
  wound envelope (`woundReachOffset`): with the cap on, an outer end that
  climbs the whole height outside a last layer ending at the bottom (an even
  layer count: one cable diameter past the envelope), or, with an odd layer
  count, its run on at the last layer's own offset under the cap, at least
  0.3 mm clear of the wall (a single layer sits half in the groove, which has
  faded out at the top). Only the free ends leave the plate.

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
- The flange (and the cap) reaches 1.5 mm past the wound cable's outer
  surface (#239, `FLANGE_MARGIN`; it was 4 mm). With the 1 mm rim chamfer
  that keeps half a millimetre of flat face beyond the outermost turn, so the
  cable rests on the face, not on the chamfer. The inner end's lead-in, the
  base rim slot and the mounts can need more: the keyhole slots, the SKÅDIS
  clips' lips (they keep clear of the wound cable) and the through-holes
  (wall, collar pad, hole and rim).
- The flange and the top cap have a 1 mm x 45 degree chamfer on their outer
  edge, on both faces (#229, #237, `EDGE_CHAMFER`, `src/core/edgeChamfer.ts`).
  The rim slots' necks end at the foot of the chamfer. A 3 mm
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
  with the groove at `0.4 d`. A 9 mm cord at 2.6x needs a core of at least about
  45 mm. A square or triangle can have a smaller
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
  creases and the depth steps within a fade (they cross the crease angle
  along it and die out half way as stubs), so a groove's lines end where its
  full depth ends. The crest above a fading groove counts as part of the fade
  too: there the surface sits at offset 0 whatever the groove's depth. That
  band's top is the land's middle under the next turn, which follows the
  helix, so the level run-in's band stops below the full turn's crest.
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

### Line pass details

- The depth-step test uses the second difference of linear depth. Its
  threshold is 4 line-pass pixels, converted to world units from the camera
  every frame, so it follows zoom in both projections.
- The camera sits two radii from the model centre, with near at 0.5 r and far
  at 3.5 r. The bounding sphere then lies strictly between the clip planes and
  only empty pixels read depth 1, which the silhouette test needs.
- The normal target is half-float, because 8-bit normals are too coarse for
  the 30 degree crease test. Normals are split at 30 degrees. The groove arc
  turns about 17 degrees per mesh row, below that. The ridges and rims turn 45
  to 110 degrees, so they always draw.
- The edge and thicken passes run at twice the CSS pixel ratio on a 1x screen
  (native on 2x or better). The output pass averages them down, so thin lines
  are smooth and not stair-stepped.
- The pen weight is the on-screen diagonal of the model divided by 500,
  clamped to 1.0 to 1.6 CSS px. The label outline pen is 0.8 px. The thicken
  pass searches at most 4 px.
- The edge shader gives each face kind its own alpha in the normal target:
  0.5 for label pockets, 0.9 for the rim chamfer, 0.8 for the rim land, 0.97
  for the groove fade, 1 for everything else. Where a groove fades out, its
  edges turn gradually shallower, so a crease would draw as broken dashes and
  depth steps would end as stubs. Neither is drawn inside the fade, and each
  groove line ends where the full depth ends.
- Dimension lines, slot outlines and labels are drawn on separate camera
  layers after the model passes. The normal pass sees only layer 0, so the
  edge detector never outlines them. Lines go in before FXAA, so they are
  smoothed. Labels go straight onto the canvas after FXAA, so the text is not
  blurred.

### Camera and framing

- The perspective fit solves the field of view so the same half-height fills
  the frame at the fit distance, which keeps the pen weight valid for both
  projections. It also pads for the vertex nearest the camera, which
  foreshortening makes bigger than the flat box shows.
- The projection toggle refits the incoming camera with the same `fill`
  instead of copying the outgoing scale. A copy drifts on ortho, perspective
  and back. Two fits with one `fill` keep the toggle exactly reversible.
- Wheel and pinch zoom is limited to 0.3x to 4x of the fitted framing.
- The orbit target and the zoom limits are set again every frame, because the
  orbit controls swap in a fresh instance when the default camera changes, and
  that can lag a frame.
- While the camera is not animating, the stored view direction follows a
  manual orbit drag. Without that, any refit (a parameter edit, a resize, the
  exploded or print-layout view) would snap the camera back. The sync is
  skipped during the tweens, because the orbit target has not reached the new
  centre yet.
- A preset change slerps the view in 500 ms. A parameter edit eases only the
  fit in 400 ms. Reduced motion skips both.
- A geometry change whose fit moved by less than 1% is applied at once.
  Otherwise the draft-to-final swap (a slightly different bounding sphere)
  starts a tiny tween, and screenshots taken after load are flaky.
- After the first final mesh is framed, a later draft mesh never moves the
  camera. Otherwise a slow build's fallback draft would tween to its own
  bounds and again when the final arrived.
- Every one-shot camera change asks for four extra animation frames. A single
  isolated render is not reliably picked up by headless Chromium's compositor
  under software GL, and element screenshots can return a stale frame.
- The cameras are marked `manual`, so the canvas resize handler leaves them
  alone. It would otherwise reset an ortho frustum to pixel units, for example
  when a late webfont reflows the canvas.
- The viewer turns the geometry itself for the wall views, never a wrapping
  group. The renderer frames the camera from the geometry's own vertices and
  would frame the unrotated shape. The cable is turned the same way, so it
  never separates from the coil.
- The e2e tests read `window.__framingTweenCount`, `__orbitAzimuthDeg` and
  `__orbitByDeg` instead of simulating pointer paths. `OrbitControls` wraps
  the azimuth, so the renderer adds up the unwrapped total to measure long
  drags.
- The debug close-up (`?debugFocusInnerEnd=1`, `?debugFocusOuterEnd=1`) is a
  screenshot tool. It rotates the model so the cable end faces the Iso camera,
  and fits with a loose fill of 0.4. It adds two far points 600 mm along the
  view direction, past the largest solver size, so the near and far planes
  still cover the whole model.

### Exploded view and views of the mount

- An exploded part lifts by its own height plus a gap, so it clears the core
  at any design scale. The top cap's gap is its collar engagement, plus the
  weld flare, plus 1.5 times the cap thickness, plus 15 mm. The guide lifts by
  height plus 20 mm.
- The mount plate, the pegs and the SKÅDIS clips sit on the other side of the
  core and lift along the negative coil axis. The pegs lift by half the
  plate's lift, so they float in line with their holes. While exploded, the
  camera fits tighter (0.85 instead of 0.75).
- A guide figure is one static render. It frames only the pose it shows, so an
  assembled figure is not padded for a lift that never happens.
- The wall rotations live in one module, so the viewer and the guide cannot
  drift apart. They depend only on the fixed camera, never on a design.
- The wall preset lays the coil on its side: axis horizontal, flange against
  the wall, top cap facing the room. The mount's up (local +Y) maps to world
  Z, because the camera is oblique with up = world +Z. An extra spin of about
  24.2 degrees about world X cancels the tilt the oblique camera gives the
  projected up direction. Without it the top-centre slot lands a quarter turn
  off the ellipse apex.
- The mount-face preset is built straight from the camera's basis, so the
  flange shows as an undistorted circle. A shape with no mirror axis at local
  +Y (a triangle) still hangs level: the geometry is pre-rotated about Z by
  the mount's axis angle.
- Choosing SKÅDIS as the mount jumps to the mount-side view once, because the
  clips sit behind the flange where neither the Iso nor the wall camera looks.
- The print-layout view places every part with `printPlacements`, the same
  function the 3MF writer uses, so the view and the exported plate cannot
  disagree. It hides the cable and the dimension axes, because the core
  prints without a cable. Its part labels sit on one shared row just past the
  bounds of the whole layout. The parts share about the same Y band, so a
  label pushed out from its own part could land on a deeper neighbour. The row
  is on the side the camera looks from, so it is never hidden.
- A square or triangle core has a corner, not a flat side, toward the fixed
  Front camera. The viewer rotates the presented geometry about the coil axis
  so a flat side faces the camera. The Iso view uses the same rotation, so it
  reads as 45 degrees off that flat. The dimension box is spun by the opposite
  angle, so the two cancel and the box stays flush with the silhouette. The
  box's own area search can prefer a corner-through-the-axis pose on a heavily
  rounded triangle, so the spin is passed in. A round core is not rotated.
- The slot outlines lie in the back plane of the board for the mount-side
  view and in its front plane for the room-side wall view. They are hidden
  wherever the model is nearer the camera, because the clip barbs hook behind
  the board.

### Wound cable

- The tube has 24 sides, because the cable is thick next to the core and fewer
  sides show as a faceted outline. Crease normals cannot fix that, because the
  edge shader reads the real silhouette.
- The envelope shell sits half a wire radius outside the centreline. The hint
  tubes reach the centreline plus the hint radius, so they stay visibly proud
  of the shell. On layer 1 the centreline is only 0.1 d above the groove
  ridges, so a shell on the centreline would fight them for depth.
- Each hint is a real slice of two turns, not a flat ring. A single-turn hint
  looks like a flat ring when the pitch is large next to the diameter, and the
  cable reads like bamboo.
- Hints sit about every 6 turns, at least 3 and at most 40, as separate
  islands with smooth shell between them. Too few read as a smooth pole with a
  few rings. The first and last hints are pinned to the ends of the cable.
- A hint is thicker than the real wire: 12% of the layer radius, never less
  than the wire radius. A thin wire on a coil that fills the canvas would
  protrude less than the depth-step threshold and never draw.
- The cable's end paths are drawn as one-turn paths, so they always get the
  full tube, whatever the layers themselves use.

### Dimension axes

- The axes live in the model's own frame, at the bottom corner furthest left
  in the default Iso view, chosen once per design and pose, never per frame.
  They are hidden while exploded, in the print layout, in the mount-side view
  and in the debug close-up. The framing keeps room for them even when they
  are off, so the toggle never zooms the model.
- The gap to the box is 8% of the footprint (not of the height, which would
  push a tall coil's axes far aside), and at least 4 mm. The camera fit
  reserves 6% of the largest extent around the axes for ticks and labels, and
  12% of the footprint above the height axis, so the viewer's toggles do not
  cover it in Front view.
- The box is the smallest-area footprint rectangle, so a square flange
  measures across its flats and a triangle by its flat base and its height.
  The mount plate, pegs and clips do not count toward the box height.
- A stroke fragment behind the model is discarded, not drawn grey, checked
  against the model's depth. A bias of 1e-5 stops a line lying on the surface
  from flickering.
- A sprite has no depth test, so a hidden label is found on the CPU by
  raycasting its anchor. The ray is shortened by 1e-4 so a point flush on the
  surface does not hide itself.
- An axis seen almost end-on (under about 14 degrees to the view ray) or
  shorter than 6 px is hidden, not drawn misleadingly short. A short axis
  draws its arrowheads outside, pointing in.
- Width and depth share the origin corner, so their labels can overlap on a
  slim coil. A round core has the same number for both and draws one label.
  Otherwise the depth label slides along its axis until it clears, within
  three axis lengths.
### Canvases

- The frame loop of a guide canvas is switched from inside the canvas, never
  with the `frameloop` prop. A new prop value reconfigures the canvas and
  resizes it, and a resize clears the picture. The canvas ignores scroll when
  it measures itself, for the same reason.
- If WebGL fails (no support, a blocklisted GPU, a lost context), an error
  boundary swaps only the canvas for a short note. The geometry is solved in a
  worker, so the rest of the app keeps working.

## UI notes

### Geometry worker and live preview

- One persistent worker (`src/geometry/worker.ts`) lives for the whole page, because
  every edit needs a new design. The STEP worker is different: it starts lazily,
  once, when the user asks for a STEP file.
- The worker imports `design()` from its own module, not the `core` barrel, so its
  bundle does not pull in the lazy STEP (replicad) path.
- Requests carry an id and the client matches responses by id, so a caller can drop
  a stale result instead of trusting whichever response comes last. Results are
  moved, not copied, as typed-array buffers. `design.mesh` is the same buffer as
  `design.parts[0].mesh`, so only the parts are listed (moving a buffer twice throws).
- A synchronous WASM build cannot be cancelled, so "cancel a stale job" means "drop
  its result": a generation counter is bumped on every spec change and a result is
  only applied if its generation is still the latest.
- The first design after a page load has nothing to keep on screen, so it asks for a
  draft after 60 ms and the final after 400 ms. Later edits wait 300 ms (a slider
  fires a new spec on every pointer-move frame, so this merges a whole drag into one
  build) and go straight for the final mesh. The previous final stays on screen the
  whole time. A draft is only shown if the final is still not ready after another
  600 ms. Showing a draft on every edit made the model flash and "grow" as the camera
  refitted to the draft's bounds, and then to the final's.
- The worker client is created and terminated by one effect, held in a ref, not made
  with `useMemo`: React may discard and recompute a memo (StrictMode mounts twice in
  development), and the cleanup of that effect would then end the one live worker.

### Assembly guide

- The guide is built from the current `Design`, so a shared link opens the same
  guide. Every figure uses the viewer's own line-art pipeline (`GuideFigure`).
  A step is left out when it does not apply (no cap, no "fit the cap" step) and the
  numbers after it close up. Each step has one short line of text: the pictogram and
  the arrow carry the meaning.
- Arrows and call-outs are SVG drawn over a figure, placed from 3D points projected
  with the same camera fit the figure uses (`src/guide/projection.ts`). The fit is a
  pure function of parts, preset, fill and aspect, so the overlay and the render
  cannot disagree. The aspect is fixed at 4:3 (the same value as the CSS box), so
  the fit can run at render time, before any canvas exists. Figures are wider than
  tall because the printed page is portrait, and this leaves room for the next step.
  Figures fill 85% of their frame, tighter than the viewer's 75%.
- The guide uses only the public core interface. Small helpers such as applying the
  print transform or reading mesh bounds are written again in `src/guide` instead of
  importing core internals. Positions of features the guide cannot read exactly
  (the wall screw, the groove start) are schematic: the mesh vertex furthest along
  an axis, near a given height.
- Pictograms are plain, generic symbols, not renders: several steps have no model
  geometry to show, and the guide must not read core internals to find an exact
  position. All pictograms share a 64x64 box and a 3.5 px stroke.
- The keyhole step shows the real hung pose, with the same rotation matrices as the
  viewer's wall presets (`src/viewer/wallRotations.ts`). The rotation is baked into
  the vertex positions, not put on a wrapping group, because the camera fit reads
  vertex positions. In that pose the coil axis is +X and sliding down to seat means
  lower Z. The wall is a quad drawn beside the coil, not behind it: an SVG layer
  cannot be hidden by the WebGL picture under it. The screw mark in the inset is
  approximate for the same reason as above.
- A zoom inset is a second, larger copy of the same figure inside a round mask. The
  host figure has a fixed CSS width, so "N times bigger" is a known ratio, and a
  point at a given fraction of the host lands at the same fraction of the bigger box.
- Parts under the flange (mount plate, pegs, SKÅDIS clips) are not lifted with the
  cap in the exploded view: the guide lifts non-core parts up, which would push these
  through the core, so the plate step lowers them instead.
- The guide root carries `data-resolution` (the design's resolution), so a test can
  wait for the final mesh before a screenshot, as the design view waits for
  `download-stl`.

### Result panel

- The verdict headline only changes when the cable does not fit. A design that holds
  the cable is "ok" however much room the locks force on it.
- The cable's outer size is measured across corners, like the flange's "across
  corners" row, so those two rows can be compared directly. The flange's own width
  comes from `flangeExtent`, the real built extent; the solver's estimate is only a
  fallback.
- Cable lengths are in centimetres, like the length input. Sizes of printed parts
  stay in millimetres.
- Option cards: with three free dimensions, picking a card locks its height and
  layers, so the cards go away and a "Back to all options" link replaces them. That
  link is plain React state and does not survive a reload; a reload shows the picked
  design, which is what the link stores. A picked card shows as checked at once,
  before its design is solved. Cards keep a fixed order so the picked one never
  jumps. "All numbers" is always collapsed on load and never goes in the hash.

### Controls

- The (i) hint opens on hover, focus and tap. Those are three separate reasons to be
  open, not one toggle: a tap is delivered as a mouseenter followed by a click, so a
  single toggle would flip straight back to closed. Esc closes it and returns focus
  to the button. The bubble is always in the DOM, only collapsed visually, so
  `aria-describedby` points at real text. The button is a sibling of the label and
  never inside it, so a tap cannot also toggle the control. A bubble that would run
  off the right edge of the window opens leftwards instead (measured before paint).
- The shape picker has one real radio input per shape, so arrow keys and screen
  readers work as in a `<select>`. It is built from the shape registry, so a new
  shape plugin gets a button without a change here; an unknown kind gets a generic
  polygon icon.
- The label input cuts text only when the user inserts characters and the final
  design for exactly that text and geometry says fewer fit. Text that stops fitting
  because the coil changed, or that came from the URL, is never cut: the design's
  warning covers it.
- Core size and height round to 1 mm, or 0.5 mm below 20 mm (the solver's smallest
  cores are 5 mm, where 1 mm is too coarse). The paired number input rounds too, so
  a typed long decimal never reaches the spec. A locked value is never below the
  field's minimum (the shape's bend limit), also for an old link that stored a smaller one.
- Cable length is entered in centimetres. The spec keeps millimetres, like every
  other dimension: the core, the hash and the solver never see the unit change.
- Every on/off control is one `Switch`: a real checkbox with `role="switch"`, so keyboard and
  test tools work, drawn as a black and white pill. The state mark ("0" or "I") sits
  in the free part of the track, not on the knob. The knob is centred with
  `top: 50%`, because a fixed 1 px inset left it off centre. The hit area is larger
  than the pill (at least 44 px on phones). The slide is a CSS transition that is
  skipped under `prefers-reduced-motion`. A padlock sits before the value of a locked
  dimension. A free dimension hides its slider, except the corner radius when there is
  no useful range, which keeps a greyed slider.
- At most two of core size, height and layers can be locked, so the third lock is
  disabled (never one that is already locked) and a note says why: something must
  stay free to fit the cable length.
- The viewport toggles sit over the canvas on desktop and in one strip under it on
  a phone. In print layout the wire and dimension toggles are hidden, because the
  view hides both anyway; their values are kept, so leaving the view restores them.
- View-only state (wire, dimensions, exploded, projection) is not part of the
  design. Only the wire toggle and the view (design or guide) go in the hash.
  Exploded and projection reset on reload. The page shows a placeholder until the
  first design resolves, so a guide link has something to draw.
- Exports always use the final mesh: the buttons are disabled until it is ready and
  the handlers check again. More than one part downloads as a zip of one STL per part,
  each in its print orientation.

### Core, shape and mount controls

- Sliders never show a number the solver would change. The corner radius field's
  minimum is the cable's bend-limit floor (`Solution.cornerRadiusRange`), so the UI
  does not keep its own copy of that math, rounded up to its 0.5 mm step. Its maximum
  is the largest radius that still reads as a square or triangle rather than a
  circle, rounded down. If the two land in the same step, the maximum is raised to
  the minimum, so the range is never upside down and a value never sits below the
  bend limit. When no range is left, the slider stays visible but greyed (the hint
  says to grow the core).
- The core size minimum follows the solver's minimum for this shape and cable, rounded
  like every other core size. A locked size below it can only come from an old link; the
  field shows the raised value and a note explains it.
- Locked dimension, joint, tolerance and label controls appear only when they apply:
  the dimension picker only while the core size is locked, and the joint, tolerance
  and label only while a top cap exists. Hiding a control never resets its value.
- The top cap switch is "auto" while `spec.topCap` is `"auto"` and then shows the
  automatic choice (on from two layers). Touching it stores an explicit on or off; the
  "reset" link goes back to auto. The "auto" tag sits before the switch so the row reads
  as "mode, then state".
- The wall mount switch off is `mount: "none"`. Turning it on again restores the last
  chosen kind. openGrid is not offered in the list (and the hash rejects it), because
  its connector is a placeholder that would print a plate that does not fit.
- The label switch means "the user turned it on", not "there is text". An empty label
  with the switch on stays visible. Turning it off clears the label, which the hash
  leaves out. The twist lock needs a round core: on other shapes its option is greyed,
  and a spec that already has it keeps it and gets a warning from `design()`.
- "Advanced settings" is always collapsed on load, and its state is not in the hash.

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
