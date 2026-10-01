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
| Core | A tube. It is hollow and open. The user locks either the inner diameter (bore) or the outer diameter (winding surface). A fixed 3 mm wall links the two. |
| Shapes | Round, rounded square, rounded triangle. Round is a diameter, square is across flats, triangle is the inscribed-circle diameter. |
| Cable | Round cross-section only. Bend limit: USB/audio 4x the diameter, flexible cord 4x, stiff or solid 10x, or a custom multiplier. |
| Parts | A core with the bottom flange printed as one piece. A separate top cap, on by default when there is more than one layer. A separate mount plate with two alignment pegs for SKÅDIS and openGrid. At most five parts. |
| Cap joint | Press fit, bayonet or snap. All are permanent and glue-friendly. One global print tolerance scales every fit. The bayonet (three lugs in the core's bore, L-slots in the cap's collar, a 60° twist to a stop) needs a round core; elsewhere the cap gets the press-fit collar, with a warning. The snap cap has three fingers with diamond-point barbs (45° faces both sides) that click under a ridge ring inside the core's bore; nothing is cut into the core's wall. Its 1.2 mm fingers leave a 2.2 mm + tolerance step inside the seated cap, bevelled at the fingers' tips. A core too small for the clips gets the press-fit collar, with a warning. |
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
  start, so the cable never bends tighter than its bend radius. It is round,
  one cable diameter plus tolerance across, and it follows the cable's own
  drop so that layers do not wind over a bump. It ends in a snap-in clip near
  the rim. The clip opening is narrower than the cable, so the cable presses
  in and leaves the rim sideways, along its own direction.
- Outer end: the same clip, hanging under the top cap on a 45-degree
  chamfered root. It is repeated every 90 degrees (round, square) or every 120
  degrees (triangle), so an end that was unwound a little still has a clip. A
  clip that would stand in the drawn cable's way is left out. The cap's middle
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
(`0.3 d`):

```
o_1 = d/2 - g
o_k = o_1 + (k - 1) h            h = d sqrt(3)/2 (orthocyclic, ideal) ... d (stacked, worst case)
```

A "winding quality" `q` from 0 to 1 blends `h` between the two. Hand winding
is rarely perfectly orthocyclic. The default is 0.7. Real coil makers report
25-30 % less than the ideal capacity.

**Turns per layer.** The pitch is `p = d + 0.3 mm`. Layer 1 has
`floor(H / p)` turns, where `H` is the usable height (core height minus the
3 mm margins). Higher layers have `floor((H - q p / 2) / p)`. This is a
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
  is a hard floor on the size: `2 (k d - d/2 + g)`. A 9 mm cord at 4x needs a
  core of at least about 68 mm. A square or triangle can have a smaller
  corner radius, but a core that is too small turns into a circle. So the
  solver also keeps every flat side at least two cable diameters and 15 % of
  the perimeter long. It raises a locked size that is below this floor and
  warns, for a round core too (where the floor is the bend limit alone).
- The whole drawn cable (lead-in, layer transitions, outer end) stays within
  the bend radius. Tests check this for every "ok" design, piece by piece
  (`test/cableBend.test.ts`).
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
  stitched with a z-sorted zipper. The groove fades out over half a turn at
  each end by sliding the profile out of the wall, so it gets shallower and
  narrower together.
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
  radius `d/2 + clearance/2` whose upper flank is a 45-degree tangent line.
- Depth is `0.3 d`. A deeper teardrop is wider than the pitch, and
  neighbouring grooves then merge into knife-edge ridges.
- The groove covers layer 1 only. Pitch is `d + 0.3 mm`.
- The helix phase follows the arc length of the groove floor, not of the
  un-grooved surface, so the pitch does not bunch up at corners.

### Backends must agree

The mesh and STEP backends build from the same shared layouts (the wall
profile, the joint geometry, the label outlines, the mount and clip layouts).
Each STEP solid is checked against the part's mesh volume (see Export).

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
- The legacy flat form `#v=1&L=...&d=...` still parses. On load the app
  rewrites it as `#s=...`, so old links migrate.
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
- Test a real print: the SKÅDIS clip on a board, the joints, the 3MF in a
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
