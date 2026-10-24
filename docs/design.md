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
| Shapes | Round, rounded square, rounded triangle, pill. Round is a diameter, square is across flats, triangle is the inscribed-circle diameter, pill is the overall length. |
| Cable | Round cross-section only. Bend limit: USB/audio 2.6x the diameter, flexible cord 2.6x, stiff or solid 6.5x, or a custom multiplier (2.6x by default). |
| Parts | A core with the bottom flange printed as one piece. A separate top cap, on by default when there is more than one layer. Separate rim clips or T-clips for SKÅDIS (3 or 4), or a separate mount plate with two alignment pegs for the hidden openGrid placeholder. |
| Cap joint | Press fit, bayonet or snap. All are permanent and glue-friendly. One global print tolerance scales every fit. The bayonet (three lugs in the core's bore, L-slots in the cap's collar, a 60° twist to a stop) needs a round core; elsewhere the cap gets the press-fit collar, with a warning. The snap cap has one 12 mm finger per side of the bore (slots at the corners: four on round and square cores, three on triangles), each with a barb along its whole width that clicks under a ridge ring inside the core's bore: a 30° lead-in, so it goes on with about half the pull-off force, and a 45° retaining face (the print overhang limit). Seated, the barbs sit 0.2 mm into the ridge, so the fingers stay a little bent, pull the cap onto the rim and centre it: no radial or tilt play. Under the finger tips a seat ring narrows the bore to the cap's hole, so there is no step inside the seated cap. Nothing is cut into the core's wall. A core too small for the clips gets the press-fit collar, with a warning; see [Snap joint](#snap-joint). |
| Label | Text engraved into the top cap's room-facing face. It is hidden, with a warning, when it does not fit. |
| Printer | A bed-size setting. It only produces warnings. The app never rearranges parts to fit. |
| Units | Metric only. English only. In `src/core/constants.ts`, lengths are in mm unless the name says otherwise: `_DEG` is degrees, `_KG` and `_G_PER_MM3` are mass units, and `_TURNS`, `_FACTOR` and `_SEGMENTS` are counts or ratios. |
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
  With no top cap, the outer end goes into the top face's channel (see the
  bare core below).
- Clip details. The lips are 1.5 times the wire diameter long (at least
  5 mm): short, so the cable is easy to press in and the lips sit only near
  the rim. They may start where the cable is still 0.25 mm above its final
  channel depth (the very end of its drop), which puts the clip a few mm
  further from the rim and saves flange margin. They start and end square,
  because the cable presses in from above and needs no lead-in chamfer, and a
  square end reads cleanly in the line art. A 0.05 mm ramp only keeps two
  cross-sections from sharing one station. The flange keeps 1.5 mm of
  material on each side of the clip's bore: the rim chamfer plus half a
  millimetre of flat face. Without it the chamfer trimmed the outer lip's
  lead-in once the inner end set a slim margin, and left a sliver that the
  line art drew as a dark blob.
- The lips are rigid stubs on a thick wall and PLA does not flex, so the cable's
  jacket takes all of the interference. The opening is the cable's diameter
  less 8 %, but never under 0.75 of the bore, which keeps the lip underside
  within the 45 degree overhang limit. The lips' mouth is a 45 degree funnel:
  from the 0.3 mm land above the edge where the opening meets the bore, the
  wall flares out until it meets the plain channel's wall and runs up from
  there. Outside the clip the flare is a hairline on that wall, so no two
  vertices of a ring coincide. The clip sits where both lips are still inside
  the rim, with 1.5 mm of flange beyond them, and after the drop.
- Channel details. The inner-end channel is one cable diameter deep, so the
  first turn lies flush with the flange face. The wall's own groove needs only
  0.4 d, because later turns nest in the groove's own profile; here they pass
  straight over a flat annulus, so no bump can be tolerated. The plate keeps
  1.5 mm under the recess and 0.4 mm between the channel's side and the wall,
  so the cable lies in a full-width trench. The cutter is clipped 0.2 mm
  outside the wall's outline: less than the 0.4 mm skin, so the clip never
  flattens the round channel's wall-side flank, but never exactly on the
  wall's surface either.
- Lead-in route (`src/core/innerEnd.ts`). The cable leaves the groove start
  backwards along the helix's own tangent, as a straight chord across the flange
  margin: a cable at its bend radius can follow a straight line. Two gentle
  blends ride on that chord, one after the other, because the first turn starts
  on the face and cannot drop while it is still beside the wall. First it shifts
  sideways until the channel sits a skin clear of the wall, while the helix's
  slope eases off with the cable's bottom on the face. Then it drops into the
  channel, top flush with the face. Each blend is the lowest-peak-curvature C1
  ramp (two parabolas), sized so the curvature stays within the bend budget.
  The channel's depth is the cable diameter, capped to what the flange's
  thickness leaves under a small shelf. The keyhole pocket on the other face
  sits on its own pad, so it takes nothing from this depth.
- On a square or triangle the straight chord runs along the flat side that ends
  at the groove start and meets the rim only past the next corner, right where
  a through-hole mount puts that corner's screw hole. So the chord bends
  gently outward (up to 80 % of the bend budget) until the clip's rim end
  reaches its limit by the flat side's middle, or at the end of the drop plus
  the clip if that is further. Past the clip the cable keeps bending outward
  with what is left of the budget, because a chord that meets the rim at a
  grazing angle leaves a long knife-edge sliver of rim beside the channel. Past
  the rim it goes straight on.
- The flange margin must be at least the narrowest width that holds the clip
  past the end of the drop (`requiredInnerEndMargin`), which is cheap and
  independent of the margin, so the solver can ask for it on every candidate.
  `layoutInnerEnd` assumes it and has no fallback for a narrower margin: the
  margin the sizing step picks is never narrower, a sweep of free and locked
  cores never produced one, and the squeezed-drop warning that used to cover it
  was removed (issue #373).
- The channel is swept along the drawn cable, not cut as a flat-bottomed box.
  Every cross-section is a round bore of one cable diameter plus tolerance
  around the cable's centre, open straight up to the face (a "U"). Its depth
  follows the cable's drop: zero where the cable's bottom reaches the face, full
  depth once it lies in the channel, with no step and no square corners. The
  cut starts where the bore's bottom is still 0.3 mm above the face, but not
  beside the wall, where the cable shifts clear of it and the bore only touches
  the face. It ends when the whole bore is past the rim. The old vertical rim
  keyhole needed a 90 degree turn; the clip lies along the cable's own
  direction and the cable leaves through the rim along the same chord.
- Every ring of a sweep puts its vertices at the same angles round the circle,
  whatever its slots' widths: from where the narrowest up slot meets the circle
  to where the narrowest down slot does, with a break at each slot's widest
  foot too. A vertex inside a slot sits on the slot's wall, level with its
  angle. So where a lip starts, each vertex only moves straight across and the
  strips between the two rings tile the lip's end face. With the angles spread
  over each ring's own arc, the vertices slid round the circle there and the
  strips folded back over themselves.
- Outer end details. Under the cap the cable runs 0.1 mm below the plate's
  underside: its top would otherwise sit exactly on that face, which the line
  art draws as a dashed seam. A clipped end leaves a free tail past the rim
  of three wire diameters (at least 10 mm). With the cap off and no face
  channel, the straight tail along the last turn is six diameters (at least
  20 mm). The rim slot's neck is 1 mm long, then the 45-degree lead-in. The
  base slot keeps 1 mm of flange from the inner-end channel, the mount's cuts
  and the pads; the cap slot keeps 1 mm of plate from the label. The seat is
  a 32-sided circle.
- The rim slot is a keyhole cut straight through the plate. The seat is a print
  tolerance wider than the cable, so it holds it without clamping it, and a
  connector behind it stops it pulling through. The neck is narrower than the
  cable by the same 8 % as the clip, because the plate beside it is rigid and
  the jacket takes the squeeze. The walls are vertical, so it needs no support
  either way up. The slot runs straight in along the rim's normal: the coil is
  inboard of the seat, so its pull on the cable draws it away from the neck.
  The seat sits as far out as the rim allows, with the neck ending at the foot
  of the rim chamfer, so the neck keeps the plate's full thickness.
- The slot is placed as near the cable's lead-out as it fits: half a
  millimetre at a time either way round the rim, the first position whose cut
  keeps its clearance from every keep-out polygon and has none of them inside it.
  If none fits there is no slot.
- Strap slots (#240, #314, `strapSlots`, off by default, `src/core/strapSlot.ts`).
  Each plate gets two closed slots beside the wound cable, half a turn apart.
  A hook-and-loop tie goes through a slot, over the rim edge and round the
  cable lead that leaves the plate, so it holds the cable at that plate only,
  without wrapping the coil. A tie 12.7 mm wide fits the 14 mm slot
  (`STRAP_SLOT_LENGTH`) and the 1.5 mm hook side passes the 2.5 mm width
  (`STRAP_SLOT_WIDTH`). The slot is a stadium that follows the rim: a vertical
  prism through the plate, so it prints without support either way up, and
  each part stays one solid because the walls close the loop (genus +1 per
  slot). The walls are 1.5 mm on the cable side (`STRAP_SLOT_INNER_WALL`, so the
  cable never catches in the slot) and 2 mm on the rim side
  (`STRAP_SLOT_OUTER_WALL`, the wall that takes the tie's pull). The plate
  therefore needs 6 mm past the cable (`STRAP_SLOT_PLATE_REACH`), which an
  unmounted plate does not have: it reaches only 1.5 to 3 mm past a multi-layer
  winding. The flange margin grows until it does, the way it grows for a
  mount, even with the core size locked: that lock keeps the core's size only.
  A square or triangle with two layers gets 4.5 mm more on every side, a round
  one 2 to 4.5 mm. If the margin cannot grow there are no slots and a note says
  so. The search starts at the cable's outer end, where the lead leaves through
  the rim slot, and goes one millimetre at a time either way round the rim.
  The first pair that keeps
  1 mm clear of that plate's keep-outs is used. The base's are its rim slot, the
  inner-end channel, the through-holes and their pads, the mounts and T-clips,
  and the cable's free ends at the base. The cap's are its rim slot, the label
  and the cable's free ends at the cap. Each plate is laid out on its own, so
  the base's pair and the cap's can sit at different angles: one tie goes
  through one plate and over its rim, so they need not line up. The mount plate
  keeps the base's pair, because it is glued to the base and a tie passes both.
  When no opposite pair is clear (three through-holes 120 degrees apart can
  block every one), the pair that is farthest apart is used, as long as it is at
  least a third of the way round (`STRAP_SLOT_MIN_SEPARATION_FRACTION`, 120
  degrees on a round plate). Below that a plate gets no slots, and a note under
  the switch (`Design.strapSlotsNote`, also in the messages) names the plate.
  The mount plate gets the same slots
  where it reaches into them: its edge is 3 mm inside the base's, so its cut is
  a notch open at the plate's edge, and the base's wall still closes the slot.
  The plate keeps at least 2 mm of its own outside a slot
  (`STRAP_SLOT_PLATE_MIN_SKIN`, the same as the rim wall). A thinner skin is a
  hairline that the plate polygon's chord sag breaks into slivers, and it would
  not print. In that case the plate's slot is opened through its edge instead:
  a U-notch with the same rounded inner end, running 1 mm past the plate's edge
  (`STRAP_SLOT_PLATE_OVERSHOOT`), so the tie still passes the plate and no thin
  wall is left.
  The slot walls' strength under a tie is not measured; a print has to show
  that the 2 mm rim wall holds.
- The cable's cap end runs level under the cap, then curves outward with 80 %
  of the bend budget and leaves past the rim, with a straight free tail beyond
  it. The curve never keeps turning until the tail points back round the axis,
  which a small bend radius would allow.
- Sweeps. A channel or clip is swept with a cross-section every 2.5 mm and 16
  samples on each arc. The floor may sag at most 0.08 mm between two
  sections, so on a tight bend the step shrinks to
  `sqrt(8 * sag * bend radius)`. The lead-in, the transitions and the outer
  end are sampled every 0.5 mm.
- A swept solid is one closed cross-section polygon per station, all with the
  same vertex count and order, each in the vertical plane across the cable.
  Consecutive rings join with straight edges and each end is capped by a fan
  from an interior point. The mesh and STEP backends both build from these same
  rings (the mesh meshes them, STEP lofts them). The mesh is valid as long as
  consecutive rings do not cross, which holds for any path that bends far more
  gently than the bore is wide: the cable's bend radius is several diameters.
- The flange and cap margins grow when the inner end's lead-in or the base
  slot needs more room (the slot's seat stays 0.4 mm clear of the wall, and
  may cut through the collar pad beside it).
- The flange and cap cover the drawn cable as it really runs, not just the
  wound envelope (`woundReachOffset`): an outer end that climbs the whole
  height outside a last layer ending at the bottom (an even layer count: one
  cable diameter past the envelope, with the cap on or off), or, with an odd
  layer count and the cap on, its run on at the last layer's own offset under
  the cap, at least 0.3 mm clear of the wall (a single layer sits half in the
  groove, which has faded out at the top). Only the free ends leave the plate.
- **Channel blocker.** The inner-end channel's bore is as wide as the cable
  needs and can exceed the wall's thickness for a heavy cord, and near the
  groove start the cable is still in the groove. The cutter is therefore
  clipped against the wall's outline offset by `INNER_CHANNEL_WALL_GUARD`
  (not offset 0, which would risk a coincident seam). Without the clip a wide
  bore reaches through the wall into the core's bore and wires the outside to
  it a second way: an 8 mm cable on a 60 mm round core gave the bore a genus
  of 2. The STEP backend uses the same offset on its blocker, where a
  coincident seam is an invalid solid, not just a sliver.
- The drawn cable (`src/core/wire.ts`) is traverse-wound: the core keeps
  turning the same way while the climb reverses every layer, odd layers
  climbing and even layers descending, so each layer picks up where the one
  below finished. It reuses the solver's and the wall's numbers (each layer's
  offset, turns and perimeter, the groove's pitch and start), so layer 1 sits
  centred in the printed groove, and a square or triangle core's cable follows
  the real offset outline, not a circle.
- The whole cable is one path from the inner end to the outer end, with a
  curvature of at most 1 / bend radius. Each layer starts at the angle where
  the previous transition ended, because a fixed start made the transition
  turn back on itself. A transition is a blend in the outline's own (position
  along the outline, offset, z) space, lengthened until its curvature passes.
  The inner end is the lead-in's straight chord. With the cap on, the outer end
  is a blend, searched the same way, to just under the cap and then out past the
  rim; with the cap off it is a straight tail along the last turn's tangent.
- Sampling is at least a minimum number of points per turn and at most a
  maximum arc length apart. A layer is capped at 300 000 samples, so an input
  far outside the solver's bounds cannot exhaust memory: the density scales
  back instead, never below 8 per turn.

### Bare core and its face channels (#254)

The default design is the bare core: no base and no top cap. The base plate is
an option (`base`: on or off, written to the link only when on). A wall mount
needs it, so a mount keeps the base on whatever `base` says; the spec keeps the
user's value. With the base off the core is the only part: a grooved tube that
stands on its own bottom face, with no flange, no inner-end channel and no base
rim slot. The top cap stays optional, and `auto` means off, with or without a
base, so a core has no cap until the user switches it on. An explicit cap is
still built, sized to the wound cable. A link that sets `base` or `cap` keeps
its choice.

Both cable ends leave the winding onto an end face (`faceChannel.ts`). Layer 1
starts on the bottom turn and climbs, so the inner end uses the bottom face. An
odd last layer finishes on the top turn; an even one on the bottom turn.

- **Rings.** The core gets a thin ring at the bottom, and one at the top when
  the outer end uses the top face. The ring's opening is the hole; its outline
  is the bore's, offset inward by the ring width `W`, so a square or a triangle
  has a thin ring all round (corners sharp below `FACE_HOLE_CORNER_MIN`). The
  hole always passes a 22.4 mm plug (plus the print clearance).
  The hole's inscribed radius `a = sqrt(R (R - 2 rho))` is where an arc at the
  bend radius `rho`, tangent to a winding of radius `R`, reaches the hole
  square-on. It is kept between the passage (the plug and the bend) and the
  bore less the channel and 1.2 mm of web each side, and `W` is the bore's
  inscribed radius less `a`.
- **Bottom ring.** Flat on the bed, `zStart + r_u + 1.2 mm` thick: the cable's
  centre level, the channel's round roof (radius `r_u = d/2 + c`) and 1.2 mm
  above it. The channel is open to the bed, so the roof bridges the channel's
  width `d + 2c`: 4.6 mm for USB-C, 7.4 mm for a 7 mm HDMI cable. Cables wider
  than 8 mm bridge more than that; the test accepts roofs up to 8.5 mm.
- **Top ring.** Its top is the core's top face. The channel is open to the top.
  The channel's floor is the cable's level less `r_u`, with 1.2 mm of web
  under it. Under the ring a 45 degree funnel (the distance to the hole)
  reaches down to the bore wall, so it prints without supports. Each bore
  column meets the nearest point of the hole's outline (a corner of a square
  or a triangle takes the whole corner's arc), because a ruled surface to any
  other point leans flatter than 45 degrees between columns.
- **Channel.** From the end turn, level at the turn's own height (the
  helix's slope eases to level over 6 mm), one circular arc tangent to the
  winding, of radius `max(rho_min, dive)`, where `rho_min` is the bend radius
  over the curvature budget and `dive` is how far the hole is from the
  winding. A corner of a square or a triangle is followed first, so the arc
  leaves along a flat side. The arc crosses the hole's edge; the cable then
  runs straight on, bends 90 degrees up (inner end) or down (outer end) at
  `rho_min` in the vertical plane, and stands in the hole. The cut is a
  revolved section (an arc, no sweep), so STEP gets exact tori.
- **With the base on (#292).** Only the bottom differs. The top of the core
  (the top ring, the hole, the top-face channel and the outer end's drawn path)
  is planned by the same code with the same dimensions, so the plan reserves the
  bottom ring's thickness and the inner end's seat in both cases. With the base
  on there is no bottom ring and no bottom channel: the inner end keeps the
  flange's channel and clip.
- **Any layer count, no cap (#286).** The outer end uses the top face whenever
  the cap is off. Layers 1 to L-1 fill the band around the whole core, so the
  outer end cannot reach the core at its own height: it would cross their
  turns. Instead it rises in a ramp over the stack, then runs level into the
  channel. Nothing is printed under the crossing: the cable rests on the lower
  turns, so the base-on top stays the bare core's. The ramp is the same blend as
  the cap's lead-out, searched in length until its bend passes. With an odd
  count the last layer ends on the top turn: the ramp starts at its own offset
  and moves out by the gap the nested layers leave (about 0.1 d), so it passes
  the turn beside it at a cable's width. With an even count the last layer
  ends on the bottom turn, so the ramp first climbs the whole height outside
  the last layer, one cable diameter past it (as the cap's lead-out does), and
  the search also picks how fast it moves out, so it clears the turns above
  the end by a cable's width. The channel's level is one cable diameter above
  the highest turn of the stack (all layers, for an even count) and clear of
  the groove's top flank by 1.2 mm of web (the groove fades out over its last
  0.15 turn), so the channel never cuts the grooved wall. The solver takes
  `crossingReserve` (about 1.4 d) off the winding span, so for the same turns
  the core is that much taller. It is a nominal estimate: the real path's
  length is not fed back. The ramp ends where the in-plane arc can reach the
  hole: for a square or a triangle the arc may start inside a corner, so the
  arc follows only the rest of that corner. Where no ramp fits, the outer end
  keeps its straight tail and a note says so.
- **Arc joints.** A channel is a few arcs. Each cutter overlaps the next arc
  by `FACE_ARC_JOINT_OVERLAP` (0.3 mm along the arc), and the first arc's
  start extends back by the same amount. The forward overlap is needed: with
  none, about 70 of 3000 fuzz designs fold at the arc joints on square and
  triangle cores, where the two arcs' walls are tangent and differ by under
  a micrometre. The backward extension is not needed. The 0.3 mm is not
  derived from a clearance, it was chosen against the fuzz. At 3000 cases,
  0.2, 0.25, 0.35 and 0.4 each leave 1 to 5 hazards, and 0.1 and 0.3 leave
  only case 2639 (a thin cable on a triangle core, which has no face channel
  and fails on main either way). The failures follow the facet phase: short
  edges the weld refused to collapse where the groove lip, the channel wall
  and the outer wall meet, and fold edges near the dome crest. One swept cut
  per end with a shared ring at each joint needs no overlap, but it fails
  cases 595 and 2797 where the overlap is clean, so it is not used.
- **Clearances.** Channel arcs reach the hole at least 0.4 square-on (a
  grazing crossing leaves a sliver of ring beside the channel); the standing
  cable keeps 0.5 mm clear of the hole's edge; the two cables stand at least
  one diameter and a millimetre apart.
- **Floors.** The solver raises the core so the arc reaches the hole within
  the bend radius (`minFaceChannelOuterSize`, by bisection on `planFaceChannels`
  at an unlimited height), and the height so the rings, the funnel and the
  bend fit. The cable length counts the arcs, the straight run, the quarter
  bend and (for the inner end) the climb to the top face. With the base on the
  same size floor applies, and the height floor leaves out only the inner end's
  climb; the length counts the outer end's channel alone.
- **Rim leads (#321).** A channel used to start with a step against the groove
  it leaves, and the cutter's flat start face stood in the wall as a short line
  in the line art. The wall now opens a lead section around each junction: the
  channel's own section (a circle of the channel's radius about the cable's
  centre, with a vertical wall on the face side, tangent to the circle), grown by
  `FACE_LEAD_MARGIN` (0.05 mm) so that it holds the cutter's start face inside the
  wall's cavity. On the groove side it holds for `FACE_ARC_JOINT_OVERLAP` plus
  `FACE_LEAD_HOLD`, then shrinks into the groove over `FACE_LIP_OPEN` (twice the 6
  mm ease length) with a smoothstep. On the channel side it shrinks by
  `FACE_LEAD_INNER` over `FACE_LEAD_SHRINK` (2 mm), and the groove fades there
  over `FACE_GROOVE_LEAD` (4 mm). A circle meeting the cutter's dome meets it at
  an angle that grows as the circle shrinks, so the surfaces that emerge from each
  other have the same section shape. At the bottom the roof side of the section
  follows the circle only up to a tangent line at an angle that goes from 90 to
  45 degrees from vertical between `FACE_LEAD_TILT` (0.6 mm) before the cutter's
  start face and the face, and stays at 45 degrees (the groove's own rule) after
  it, so the roof stays printable. The lead section applies only to the leads of
  one-layer cores at the top (with more layers the top channel starts off the wall
  after the ramp). The wall's columns are 0.5 mm apart within 4 mm
  (`FACE_LEAD_COLUMN_STEP`, `FACE_LEAD_COLUMN_REACH`) of both ends of the groove
  on every design, so the base-on and bare cores share them, and the section's
  change over a coarse column does not cross the cutter at a sharp angle (the
  mesh and the STEP export build the wall on the same columns, `wallColumnParams`).
  Every transverse edge within 1.5 mm of the cutter's start face (and 3 mm into the
  channel) is at most 20 degrees, 10 below the viewer's draw threshold. The
  STEP cutter is 0.03 mm wider than the mesh's (`FACE_STEP_CUT_CLEARANCE`): a
  B-spline wall and a cylinder at the same depth leave 3 % of the volume on the
  core. The cutter's face is hidden by the wall in all designs; the line art keeps a short
  fragment at the tip of the opened wall (about 12 mm along the top groove).
- **Edge rounds (#321).** The floor of the top channel and the roof of the
  bottom channel used to meet the hole's vertical edge at 90 degrees, a knife a
  pulled cable bears on. Each channel's cutter gets one more piece
  (`faceDipSweep`): the channel's own section, with its dome moved down (top)
  or up (bottom) along a quarter round of radius equal to the web (1.2 mm),
  tangent to the floor or roof and vertical `FACE_DIP_PAST` (0.25 mm) beyond the
  hole's edge. Its first section is the channel's own, so the round starts
  without a ledge; the sections after it are `FACE_DIP_OUTSET` (0.05 mm) wider,
  so the sweep encloses the arc it continues instead of surfacing through its
  dome at a near-tangent angle. A first section of any other size leaves a ledge
  that draws as a dot in the line art, and cutting the arc short where the round
  begins leaves hairline slivers in some designs. The round meets the edge at
  about 140 degrees, and its last sheet stands in the hole instead of on its
  wall: sheets that coincide with the hole's wall fold the mesh in about 0.1 % of
  the fuzz designs. Where the arc meets the edge square-on, the three lines (the
  centre and the two walls) cross it together. Where it does not (a pill's), the
  round is placed on the centre line, where the cable bears, when the latest
  wall line crosses within `FACE_DIP_SKEW` (0.5 mm) of it; the earlier wall keeps
  a partial round. A more oblique crossing places the round on the latest line,
  so the centre line keeps part of its knife (a 7 mm cable on a round core
  crosses at about 0.4 square-on and keeps all of it; main has the same knife).
  A round on the distance to the edge (twisted sections) fixes that, but its flat
  crown patches fail the print check on wider channels. The top round faces up,
  so it has no overhang. At the bottom the round rises from the roof's crown like
  the roof's own bridge, so the printability check accepts a patch up to the web
  higher than the roof. A larger radius does not fit: the cable's own bend radius
  (about 6 mm) would need a web of that size, or a shallow exit with a thin tip.
  STEP fuses a coarser copy of the sweep (3 steps, 8 dome segments, 0.05 mm
  narrower) into each end's tool: cut from the ring solids alone it leaves the
  core invalid with the SKADIS clips' notches, and fused at the mesh's size the
  boolean takes several times longer than without the round.
- **Bore fillet (#321).** With the bottom ring, the ring's top face is a ledge
  `W` wide that met the bore wall at 90 degrees. A concave quarter round of
  radius `min(d, W / 2, room under the top funnel's foot less 0.2 mm)` rounds
  that corner: it faces up, so it needs no support, and half the ledge stays flat
  for the hole's seat clearance. STEP cuts the same polyline round as a ruled
  loft (`filletCollars`).
- **Mesh.** The ring surfaces are part of the wall's own mesh (`buildWall`:
  the bore's profile per column), so no boolean builds a ring. One boolean cuts
  the channels from the finished wall.

With the 2.6 x d bend radius (#255) the default 3.8 mm USB cable needs a
36 mm core (the hole's 22.8 mm, the channel's 4.2 mm and 1.2 mm of web each
side: 18 mm to the winding surface); the 30 mm default is raised.

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
  The rim is described once, as rows of (offset from the core's outline, z), and
  both backends turn the rows into surfaces. Where the flange is thinner than
  its pads, a 45 degree frustum under the plate's top face keeps the chamfer
  there: the mesh intersects the flange with it, STEP subtracts it from a slab
  above the face. The slab starts below the chamfer's foot and the pads'
  lowest level, so its bottom face lies on neither.
- The flange is a thin plate (`FLANGE_PLATE_THICKNESS`, 3 mm) with its
  winding-side face flat. It is thicker only on pads under the wall, the
  inner-end channel and each mount cut (`flangePads.ts`).
  - A pad keeps 2.5 mm beyond the cut it carries, at the face. That is more
    than any edge margin (keyhole, through-holes, clip wall), so a pad at a
    tight margin runs out over the rim instead of grazing it.
  - The collar under the wall reaches 1 mm past the wall's outline. It is a
    keep-out for the relief cut and not a visible surface, so it has only 96
    columns, which keeps the STEP boolean cheap.
  - The channel pad has a cross-section every 5 mm. It blends into the collar
    on both sides with a concave curve in plan, 5 mm in radius at the
    chamfer's foot (on the plate) and as much more at the face as the chamfer
    is wide, sampled every 2 mm. The blend's edge runs 0.15 mm inside the
    collar's: never on it (no coincident faces), and close enough that the
    two meet at a hair of an angle, not a crease.
  - A pad reaches 1.25 mm into the plate below its top face (the chamfer's
    1 mm plus 0.25) and 0.5 mm above the winding face. The underside is
    strictly below the foot of the rim chamfer: with it exactly on that line,
    a pad running out over the rim left a zero-length edge (fuzz case 1097).
  - The keyhole pocket and the channel recess each need plate beside them
    (2 mm of roof, 1.5 mm of shelf). They sit on separate pads, so those only
    stack if the two footprints overlap.
  - The outer (wall-facing) face stays flat: it is the face the part prints
    on, the face every wall mount sits against, the face the SKÅDIS clips'
    outer jaws rest on and the face the openGrid plate is glued to. So the
    plate is the lowest 3 mm and the pads grow upward from its top to the
    winding face at z = 0, where they print with no overhang and the channel
    stays flush with the face. Every pad has a 45 degree chamfer down to the
    plate. The wound cable only reaches the face on the collar and on the
    channel pad, so the thinner plate changes nothing for the winding.
  - Pads exist for the collar under the wall, the channel (with its clip, out
    to the rim), the keyhole slot and each openGrid pin hole. The through-hole
    mount and the SKÅDIS rim clips get none: a plain hole needs no relief, and
    the clips' jaws grip the plain plate (their notches are cut through it).
  - The backends subtract a "relief" (the slab above the plate top, minus the
    pads) from the full-thickness flange ring before fusing the wall. Each
    pad is a swept solid, so both backends build it from the same rings.
  - On a big core the collar gets more columns, so the facets' chords stay
    well inside the depth the channel pad's fillet dips into it. Where the
    two came within a hair of each other, the booleans left a sliver folded
    back over itself (#219).
  - The channel pad follows the cable's lead-in as a coarse polyline with
    mitred cross-sections. It blends into the collar on both sides, and every
    level of the chamfer is the same curve offset by the chamfer, so nothing
    overhangs. On the wall side a fillet fills the V where the pad's edge
    leaves the collar: in plan a circle of the blend radius that dips 0.15 mm
    into both edges (it crosses them at a hair of an angle, which no boolean
    dislikes), and lower down the same circle shrinks as much as the edges
    grow, so the fillet's face is a 45 degree cone. On the other side the pad
    runs on along the wall as a tail, its outer edge easing down in a cubic
    (matching value and slope at the pad, flat at the end) to just inside the
    collar's edge. The tail's length keeps its concave end near the blend
    radius (a cubic dropping D over T bends at about T^2 / 6D), and it ends
    twice the dip inside the collar, so it crosses the collar's edge once,
    never grazing along it where the collar's sampled polygon would cut it
    into slivers.
  - The through-hole layout keeps each hole clear of every pad's footprint
    (collar, channel pad with fillet and tail), so each screw head sits on the
    plain plate. The design and both backends call one function, so they cut
    the same holes.
- The label's ink must be at least 5 mm high, or it is hidden with a warning.
  Text with short ink for its font size (lowercase without ascenders, a lone
  "-") cannot reach that under the largest font size, so it is fitted at that
  size instead. The largest font size gives 1.8 mm stems: the bundled Archivo
  Black has a stem of 0.221 em (the ink width of its "I", 221 of 1000 units,
  from opentype.js `font.getPath("I", 0, 0, 1).getBoundingBox()`), so about
  8.1 mm, with capitals about 5.6 mm tall. The engraving keeps 2 mm from the
  bore hole and from the rim, is 0.6 mm deep (well under the cap's 3 mm, so
  the pocket never breaks through to the collar side), flattens each glyph
  curve into 6 segments, and takes at most 40 characters: generous for one
  line, and short enough to keep the hash short.
- The cap's through-hole runs straight through the plate and collar, so in the
  cap's print orientation (face down) its walls rise from the bed with
  nothing spanning them. The plate is solid under the collar, never a blind
  pocket whose floor would print as a bridge.
- Needle-thin triangles that the booleans leave (in flat faces, and where
  curved surfaces cross on the collar and the plate rim) draw as dotted
  lines. They are cleaned up after the build (`improveFlatFaces`,
  `weldShortEdges`). Welding drops triangles, so the label's pocket
  triangles are carried over through the weld's origin map, and edge flips
  stay inside one flat face so the label's triangles stay the label's.
- The weld (`src/core/weld.ts`). Where two faceted curved surfaces meet in a
  boolean (the bayonet's L-slot cutters against the collar, the chamfer of the
  plate rim, the core's grooved wall), the intersection curve passes a few
  thousandths of a millimetre from vertices that are already there. A facet
  with such a short edge on its border has a needle whose third corner is
  millimetres away, and no edge flip can fix it, because the short edge is on
  the border. The line-art renderer draws needles as isolated pixels. So every
  edge shorter than `WELD_EPSILON` (0.02 mm: far below what a printer
  resolves, above the 0.0055 mm gaps the booleans leave) is collapsed onto one
  of its ends, as long as the mesh stays a closed manifold and no triangle
  folds over. Each collapse moves a vertex by less than the epsilon and drops
  two triangles; what the collapses leave behind is for `flatFaces.ts` to flip.
  - A collapse must pass the link condition: the ends' only shared neighbours
    are the two vertices across the edge. Otherwise it would pinch the surface
    or make a non-manifold edge. A closed piece smaller than the epsilon, a
    tetrahedron of no volume that the booleans leave, may flatten into a
    double-sided triangle, which manifold-3d drops when it reads the mesh.
  - A triangle may turn by at most about 78 degrees (cosine 0.2) when its
    corner moves. A triangle thinner than the epsilon is itself a needle: its
    facing means nothing and it may turn freely. A triangle lower than 1 µm has
    no facing to trust, because float32 rounding can turn it, so it cannot fold.
    A triangle that moves with the corner, turned or not, must not end up lying
    back over its neighbour (within 8 degrees of opposite), a fold of no
    thickness: a needle a few thousandths of a millimetre high that turned face
    down in a flat face did, and so did one that kept its facing but met a new
    neighbour across the collapsed edge (#320).
  - When neither end is safe, the merged vertex goes halfway between them: a
    sliver beside the edge can turn over when the vertex lands on either end,
    and not when it lands in between. Then both ends' triangles are checked,
    and a refused collapse puts the vertex back.
  - A tip, a triangle's third corner that sits within twice the epsilon of
    the plane of its two neighbours, is dropped first. Failing that, a vertex
    slides along a neighbouring edge, provided it stays within half the epsilon
    of every triangle it leaves.
  - The pass repeats until no short edge is left or a round collapses none,
    because an edge refused once may be safe after its neighbours collapse. It
    reports how many it could not collapse (`stuck`: 0 on every design the
    tests sample).
- The label is cut as one `CrossSection` with the NonZero fill rule, which
  turns a letter's outer and inner contour ("O") into a ring without any
  separate hole bookkeeping. It is extruded from 1 mm above the cap's top
  face down by `LABEL_DEPTH`. The cutter carries its own original ID so the
  pocket's faces can be found in the result.
- The rim's chamfer triangles are recorded on the mesh so the viewer can leave
  them out of the drawing.
- The label is placed along a bearing: 90 degrees for a round cap, and the
  outward normal of flat side 0 for a square or triangle. Along it the cap's
  bore and rim distances are exactly the apothems, not conservative bounds, and
  the text sits centred on a flat side instead of running toward a corner. The
  largest font size that fits is found by bisection, because both the ink's
  height and width grow with the size while the room left for the width
  shrinks. The glyph loops are mirrored in Y: the cap's room-facing side is
  seen from above, and a font's own orientation reads upside down there (both
  axes flipped) or backwards (X only). Mirroring flips every loop's winding,
  so a loop with a negative signed area is a solid and a positive one a hole.
  That lets the STEP backend union the solids and cut the holes in one pass,
  without testing which loop nests in which. A glyph contour often ends with a
  line back to its own start point. That zero-length closing edge is dropped
  once in the shared outline, since manifold-3d tolerates it but OpenCascade
  throws with no readable message.
- The font is Archivo Black (SIL Open Font License 1.1, `src/assets/fonts/`):
  one very bold weight, so a shallow engraved stroke stays legible. It is
  embedded as base64 by `src/assets/fonts/generate-base64.mjs`, which writes
  `src/core/label-font-data.ts`, so the same bytes load in the main thread, the
  geometry worker and Node with no fetch and no bundler asset URL.
- The default bed is 256 mm each way (`DEFAULT_BED_SIZE`: a Bambu X1C or P1S,
  a Prusa MK4). Most FDM printers this project targets are at or below it. The
  setting runs from 50 to 1000 mm, and the 3MF plate keeps 5 mm between parts.
- Print orientation hints appear in the guide and in the 3MF placement.

### Tolerances

Rough FDM values: press fit about -0.1 mm, sliding fit 0.15-0.2 mm, loose fit
0.35-0.5 mm. The app exposes one global tolerance, 0.2 mm by default (0.05 to
0.8 mm).

### Joint collars

All three joints share one circular engagement collar on the coil axis,
whatever the core's cross-section. A circle is simple, always manifold and
needs only one global tolerance. On a non-round bore the collar touches the
bore's flat sides, not its corners. That is a normal printable fit, not a
defect.

- The cap is a top flange: the same outer footprint as the bottom flange,
  3 mm thick, above the wall's top the way the flange is below z=0.
- The collar's outer diameter keeps 0.3 mm (`JOINT_FIT_GAP`) from the bore's
  inscribed circle, before the tolerance. That keeps it clear of a non-round
  bore's corners too. It reaches 7 mm into the bore. The bore runs through
  the base flange, so the room a joint has is the wall's height plus the
  flange's thickness (#376): a core only as tall as its cable still takes the
  twist lock (9 mm), and a press collar stops `COLLAR_FLOOR_GAP` (1 mm) short
  of the flange's underside, so the coil stands flat. The snap clips need
  their 12 mm finger plus 2 mm; where that is more than the bore has, the cap
  falls back to the press collar with the usual note, and a free height is
  raised to fit the clips as before.
- The collar is a tube 2 mm thick, and the hole through its middle runs
  straight through the cap. No floor, ledge or roof over it would print as a
  bridge. The snap collar flares at its root over 2 mm; press and bayonet
  collars are straight.
- A bore with an inscribed radius under 4 mm is too small to cut real bayonet
  or snap features into a 3 mm wall without breaking through, so it gets the
  press collar.

The collar's outline follows the bore's true shape, not a circle at the flat
sides: it is the bore outline moved inward until its apothem equals the collar
radius, so the gap to the wall is the same on the flats and at the corners (a
circle sized at the flats leaves a large, uneven gap at a non-round bore's
corners). Its corner radius is floored a hairline above 0 so an inward offset
never inverts it. Every collar runs straight up into the plate by
`WELD_OVERLAP`. The cap's centre hole is the collar outline moved inward by the
collar wall and runs through the collar and the plate, so the collar is a tube
and nothing prints as a bridge over a hollow; a collar whose hole would be
under 1 mm across stays a plug.

## Shapes

The capacity math needs convex outlines. Every shape is a regular n-gon with
rounded corners, described by three numbers: the corner count `n`, the
apothem (centre to flat side) and the corner radius. Round is the case where
the corner radius equals the apothem, so the straight sides have zero length.
The round, square and triangle size conventions are chosen so that the apothem
is always `size / 2`. That keeps the solver's bounds the same for those shapes.
The pill is the one exception, below.

`ShapePlugin` in `src/core/shapes.ts` is a small registry entry: `kind`,
`label`, `sizeSemantics` (`diameter`, `acrossFlats` or
`inscribedDiameter`), `corners` and `maxCornerRadius(size)`. The geometry
helpers (`offsetPerimeter`, `pointAt`, `circumscribedRadius` and so on) work
on any `ShapeOutline`, so a new shape only adds an entry. A position on the
outline is a pair (segment, fraction), which does not depend on the offset.
So `point(position, offset) = base + offset * normal` is exact for any offset.

Three floors keep the outlines valid. The bore keeps at least 1 mm of radius,
so a wall thicker than the core cannot invert it. A bore corner keeps at least
0.5 mm of radius, because offsetting a corner inward by the wall thickness can
take it to zero or below and fold the outline. A fully degenerate corner (a
zero-length straight side) is handed back 0.01 mm of radius, so the corner
fillet builder in STEP never sees an exactly round rounded polygon. That is
invisible at print resolution. A new square or triangle starts with an 8 mm
corner radius, before the bend limit clamps it.

For the same size, a triangle's corners reach further out than a square's,
so its flange is larger. The footprint is the true offset outline, not a
bounding circle across a sharp corner.

- **The pill is the 2-gon.** A stadium is the same construction with `n = 2`:
  two corner centres on the x axis, each swept 180 degrees, joined by two
  straight sides. The apothem is the end radius `r` (so the width is `2 r`).
  A 2-gon's corner-centre distance cannot come from the apothem
  (`cos(pi / 2)` is 0), so the outline carries one optional field,
  `halfStraight`: half the length of each straight side, `L / 2 - r` for a
  pill of overall length `L`. The size is that overall length, ends included.
  The radius runs from the cable's bend limit up to `L / 2`, where `halfStraight`
  is 0 and `makeOutline` hands back the round outline, so a pill at its largest
  radius is the round core. Every outline function that loops over `n` works for
  `n = 2` unchanged, and the outlines of the other shapes never reach a pill
  branch. The long axis is the core's x axis, which the wall mounts keep
  horizontal. Four rules differ from the other shapes. A locked size has no
  straight floor: the radius clamps to `L / 2` with a note. A free size keeps the
  pill at least twice as long as it is wide (`L >= 4 r`), so the solver cannot
  pick a size at which the pill is round. With face channels, the cable's ends
  pass the centre hole along the long axis, and the room for that depends on the
  width, not the length, so the radius floor is the round core's channel floor
  (half its smallest size), and a radius under it is raised with a note.
  Picking Pill on a locked size lengthens that size to `4 r` (`coreSizeForPill`;
  `r` is the default radius raised to those floors, and an inner size is
  converted through the wall), so the new pill is not round. A longer lock and a
  free size stay as they are.
  Everything that tests "is this outline round" asks `isFullCircle`, because a
  pill has `cornerRadius === apothem` too. Code that copies an outline into a
  new one (the bore, the collar, the face-channel hole) spreads it, or it loses
  `halfStraight` and turns the pill into a circle. `outlineOffsetAt` treats a
  point on the pill's axis past an end as outside: the generic inside test is
  true for it, because the corner-centre "polygon" has no area.
- **Round is exact.** A bore whose outline is round stays a circle: the two
  floors above can bite differently on a tiny core, and without this rule the
  bore would turn very slightly square. Round's `t = 0` also sits at angle 0
  (`pointAt` has a closed form for it). The general path starts `t = 0` at the
  start of corner 0's arc, which would turn round's groove and seam by 45
  degrees against the committed round designs.
- **Exact radius at an angle.** `radiusAtAngle` gives the true
  centre-to-boundary distance at one angle, for placing a keyhole slot tightly.
  The cut-off between a corner arc and a flat side is the angle, seen from the
  centre, of the arc's tangent point with the side. An earlier cut-off (the
  half-angle of the cone in which a ray meets the arc's full circle) grew past
  that angle as the corner radius grew, and returned the arc's smaller distance
  for points that lie on the flat side: 24.6 mm instead of 35.7 mm for a
  rounded square with apothem 31.45, corner radius 14.44, offset 4.2, at its
  45-degree flat midpoint.
- **Columns follow the corners.** A column split by arc length alone gave a 60
  mm rounded square with an 8 mm corner radius about 5 of 96 columns per
  corner, which looked faceted. `outlineColumnParams` gives every corner at
  least `minCornerSegments` columns (scaled to the corner's sweep, so a
  triangle's 120-degree corners get more than a square's 90-degree ones) and
  splits the rest over the straight sides. The count can exceed the requested
  one. A sharp corner gets exactly one column. Round, and any outline with no
  straight side, keeps the plain even split.
- **Helix phase.** A corner arc's length changes with the offset, a straight
  side's does not. So a helix phased by the arc-length fraction at offset 0
  runs about 6.5 % steeper where it crosses a corner of the groove floor, and
  consecutive rings bunch up there. `arcLengthFractionAt` re-derives the
  fraction at the floor's own offset, and the wall profile phases the helix
  with it.

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

**A one-turn-tall core is a flat spiral.** A layer nests in the valleys of the
layer below, and one turn leaves no valley. When `floor(H / p)` is below 2 the
model uses `q = 0` everywhere (`effectiveQuality`): every layer has as many
turns as layer 1, the radial step is `d`, and there is no phase shift. The
solver, the drawn cable and the outer-end crossing all read that same
quality, so locking many layers on a core one turn tall adds length instead of
empty flange. The envelope counts only layers that hold a turn.

**A flat spiral lies on the base and the cap closes on it** (#376). With the
base and the cap both on and `floor(H / p)` below 2, the helical climb is
pointless: a layer needs a full groove pitch of height per turn, which left
5.7 mm of play above a 3.8 mm cable. The cable is drawn planar instead, at
`(d + 0.4) / 2` above the base; the wall is a plain face at the groove floor
(no groove, so layer 1 keeps the same offset), and the lowest height is
`d + FLAT_GAP_CLEARANCE`: 4.2 mm for a 3.8 mm cable, 2.4 mm for 2 mm, 8.4 mm
for 8 mm. The layers are the turns of one spiral: the outline offset grows by
`d` over each turn, so every turn lies exactly `d` outside the one before it at
every angle, and there is no hop between layers (a layer that stepped out by
`d` over part of a turn passed through its own first turn). A turn's length is
that of its mid-offset curve, `spiralTurnLength` in `shapes.ts`; it matches the
drawn cable within 0.01 %. Capacity is constant from the gap up to the height
of two helical turns, where the helical model takes over unchanged. A free
height settles at the gap (the solver picks the lowest height that covers the
cable); a locked height above it is honoured, the cable still lies on the base,
and a note names the snug height. The clearance is a fixed 0.4 mm, not the
tolerance: it forgives a top layer the slicer prints a layer short and a jacket
thicker than its nominal diameter, and the cap never presses on the cable. The
tolerance would have made it print-calibration dependent in a place where the
cable, not the printer, sets the fit. The last turn ends `d` outside where it
began, and the outer end keeps spiralling out for up to
`FLAT_LEAD_OUT_TURNS_MAX` of a turn so it stays `d` clear of the turn inside
it. A flat core's flange margin carries that reach. The inner lead-in settles
at the same height, with no slope.

The cable never passes through itself. `test/support/cableClearance.ts` checks
that any two samples of the layers and the outer end more than 3 cable
diameters apart along the path are at least 0.98 d apart (centre to centre). The
inner lead-in is not covered: it crosses the stack at the layers' height for its
first few millimetres, which is a known gap.

**Length.** `L_wound = sum_k n_k sqrt(P(o_k)^2 + p^2)`. The helix correction
is small, but free.

**Solver.** Each output grows monotonically with each free variable, so one
free variable is solved by bisection (or an integer search for layers). The
search keeps the upper bracket, because a midpoint can round down across an
integer turn count and undershoot. With two free variables the solver needs an
objective: `minVolume` (smallest envelope, the default) or `aspectRatio`
(height close to the envelope diameter), and it also returns an alternative
candidate. `minVolume` penalizes a candidate with fewer than 5 turns per layer heavily,
but not absolutely: nobody winds one or two turns per layer, six layers deep,
just to shrink a bounding-cylinder estimate, yet such a candidate is still
picked when nothing better-shaped covers the target. The search covers a core
size of 5 to 500 mm, a height up to 400 mm and up to 40 layers.
`minVolume` scores what is printed: the flange's real footprint, at its real
margin, times the real overall height, flange bottom to cap top. `aspectRatio`
compares that height with the flange's real width across flats.
With three free variables it tries a few layer counts, returns
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
- The corner radius of a square or triangle has a ceiling too, so the slider
  does not spend most of its range on shapes that already read as a circle.
  It is the largest radius at which every flat is still at least two cable
  diameters and 15 % of the perimeter long. Both limits are affine in the
  radius, so each one solves in closed form and the tighter binds. The size
  floor above is the same boundary solved for the size at the bend limit's
  radius. A size already raised to that floor keeps this ceiling at or above
  the bend limit. A radius outside the two is clamped with a note.
- A free core size also keeps room for the chosen mount and joint. The
  snap clips and the twist lock need a bore wide and tall enough for their
  fingers or lugs, and the SKÅDIS T-clips need room in the bore for at least
  one clip, so the solver raises a free size (and, for the joints, a free
  height) to the smallest value at which the real layout fits, and says so in
  a note. The through-holes, the SKÅDIS rim clips and the openGrid plate's
  pegs depend on the flange margin more than on the size (the channel for the
  inner cable end can block them at any size), so a free-size design grows
  the margin instead, to the smallest value at which the layout fits. A locked
  size keeps that behaviour for the through-holes only: the lock fixes the core,
  not the margin. The closed-form margin leaves a corner hole a band about a
  micrometre wide, so the margin grows by the bisected minimum (0.02 mm at most
  on a square or triangle, 0.23 mm on a pill, about 2 mm where a small round
  flange's ring of large holes cannot clear the channel) and a corner hole
  turns clear of the channel pad. For the SKÅDIS rim clips and the
  openGrid plate a locked size keeps the old behaviour: the feature is skipped
  and a warning says so.
  A twist lock on a square or triangle core falls back to the press-fit collar
  at every size.
- The whole drawn cable (lead-in, layer transitions, outer end) stays within
  the bend radius. Tests check this for every "ok" design, piece by piece
  (`test/cableBend.test.ts`). The lead-in is laid out analytically against
  0.97 of the curvature limit. The transitions and the cap lead-out are
  searched, lengthened until they pass, against 1.03 of it: a wound layer on a
  core sized exactly at the bend limit already bends at the limit, and any
  blend leaving it adds a little.
- Layer 1 ends with the cable's top 0.3 x its radius below the wall's top
  face (the usable height above leaves that room), so the drawn cable never
  grazes the top face. Its last half turn stays in the fading groove.
- The flange is at least the outermost layer plus a margin.
- The label only renders when its bounding box fits the cap annulus.
- Each part is checked against the bed size.

On the flat sides of a non-round core a stiff cable bows outward instead of
lying flat. The app does not model this.

`resolveFlangeSizing` and `resolveBoreOutline` (`flange.ts`) are closed-form,
with no meshing, so `design()` and the solver's search share them and the
solver can call them for every candidate. They are what keeps the solver's
flange margin, thickness and overall height equal to what gets built, including
the cap. The bore is the wall outline moved inward by the wall thickness;
`reduced` tells `design()` to warn that the core is too small for a wall.

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
  The fade and rim triangles recorded on the mesh (`CoilMesh.fadeTriangles`,
  `rimTriangles`) are found by position in the finished mesh, since the booleans
  and the clean-up passes do not track faces.
- **Bore columns.** The wall's top and bottom faces and the flange ring are
  strips between the outer outline and the bore, one column of each per
  parameter. The bore's point is the one across from the outer's: the same
  corner arc or side, at the same fraction of it. The same fraction of the
  bore's own perimeter is wrong on a rounded square or triangle. A thin
  cable's wall is as thick as the corner radius, so the bore's arc is much
  shorter than the outer one, the points drift millimetres apart, and the
  strips twist over each other at the corners into sheets of no thickness.
  The flange ring uses the same pairing (`buildOutlineRing`): a round
  outline's corner parameter starts 45 degrees round from its `t`, which paired
  each outer column with an inner one 45 degrees away, and on a narrow annulus
  the twisted strips folded back over each other.
- **Resolution.** `draft` is coarse and is shown on the first load, and later
  only if a build is slow. `final` is used for the settled view and for every
  export. Both use the same code path, so they cannot drift apart. The
  preview debounces input and drops stale results. `draft` is 24 columns and
  3 rows per pitch, about 16k triangles (25 to 33 ms in Node). `final` is 96
  columns and 16 rows per pitch, about 170k triangles (about 240 ms).
- **Corner columns.** A split by arc length alone gave a rounded square's or
  triangle's corner arcs far fewer columns than their straight sides, which
  looked kinked up close. Each corner gets at least 16 columns per 90 degrees
  of sweep in `final` and 8 in `draft` (scaled up for a triangle's 120-degree
  corners). `draft` is half, still far smoother than a plain split, and
  cheaper. Round has no corner arc.
- **Schematic cable samples.** The drawn cable's centreline has the same
  split: at least 96 samples per turn and at most 1 mm between samples in
  `final`, 16 and 4 mm in `draft`. The density follows the arc length, with a
  floor, so a small, tightly wound coil still gets a smooth curve. The path is
  schematic and never exported.
- **Memory.** Every manifold object must be freed with `.delete()`, or the
  WASM heap runs out after a few builds.
- **Boolean order.** Booleans against the big wall cost much more than
  booleans between small parts. Combine the small parts first and touch the
  wall once or twice. Force evaluation inside a timer, because manifold
  booleans are lazy.
- **Flush features.** A small feature fused or cut exactly flush with a
  face can fail silently (it passes `status()` and `genus()` but leaves a
  disconnected piece). Embed such features past their face by a fixed margin
  (`WELD_OVERLAP`, `MOUNT_PLATE_EMBED`). A flat base exactly on the target's
  face is a razor-thin seam. It silently leaves a cut un-cut, or a glued-on
  solid as a separate piece with inverted orientation, and `status()` and
  `genus()` both read as if nothing were wrong: only a `decompose()` count
  finds it. A curved face needs the same: two independently tessellated
  surfaces at the same nominal radius need a real volume of overlap, 1 mm
  (`WELD_OVERLAP`), or the union leaves degenerate slivers. A cut shape that is open to an edge
  must be an outer-contour detour, not a hole.
- **Blind pockets.** A blind cut (the keyhole recess) pokes `WELD_OVERLAP` out
  of its mouth, so its mouth never shares a face with the flange's outer
  face. An exactly coincident seam there once left the cutter behind as a
  disconnected, inverted copy instead of cutting. The same fragility hit the
  union of the keyhole's two depth levels at one flange thickness in a fine
  thickness sweep, so `SCREW_MOUNT_LEVEL_OVERLAP` grows the slot level a
  hairline past the seam. The recess's total depth does not change.
- **Through-cuts** poke `WELD_OVERLAP` past both faces. A through-hole's
  countersink cone is carried 0.5 mm down into the bore so its edge never
  lies on the bore's surface.
- **Cap collar and snap collar.** The straight prism of the snap collar runs
  halfway up into its flare, so the two share no face: flush at the foot, the
  union left zero-width slits along a straight side that came off the cap as
  separate pieces at some column counts. Hulls use only the outline's corner
  points: many points in one side's plane folded sheets of no thickness into
  that face. The cap's collar is a straight tube run `WELD_OVERLAP` up into
  the plate, so it never flares out to the bore and the seated cap does not
  run into the core's rim.
- **Collar columns.** A round collar's wall gets 2.5 degree facets
  (`collarSegments.round`, 144): the line art draws a facet seam seen
  almost edge-on beside the wall's outline as a depth step, 7.5 degree facets
  left dotted vertical lines, and facets under about 3 degrees put every seam
  in the outline. Other shapes keep 48: their corner arcs get their own
  columns, and more only adds triangles on the flats.
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
- With one layer and a top channel, the end fade does not stop at the end turn:
  the groove stays at full depth up to it and fades over the 2 mm after, under
  the channel's cut (see the rim leads of the face channels). Otherwise it
  fades over the last 0.15 turn.
- The helix phase follows the arc length of the groove floor, not of the
  un-grooved surface, so the pitch does not bunch up at corners.

### Backends must agree

The mesh and STEP backends build from the same shared layouts (the wall
profile, the joint geometry, the label outlines, the mount and clip layouts).
Each STEP builder in `src/core/step/build.ts` mirrors its mesh twin in
`manifold.ts` primitive for primitive, with the same constants. Each STEP solid
is checked against the part's mesh volume (see Export).

Every bayonet and snap feature comes from one layout in `joints.ts`
(`jointGeometry`, `bayonetLayout`, `snapLayout`) that both backends read. A
joint the core cannot take (a bayonet on a non-round core, or a core too small)
falls back to the press collar through `resolveCapJoint`, which `design()` and
the STEP export both call, so both build the same joint and the warning is the
same.

`Design` carries the `wallSpec` and `flangeSpec` the mesh was built from, so the
STEP exporter fits its B-spline on the exact parametric grid of the mesh.
`resolution` only changes the mesh's column and row density: the solved
numbers, notices and the two specs are the same for `draft` and `final`.

### Face features (#382, #383)

The cap's top, the base's bottom and the mount plate's back are faces. Three
kinds of feature sit on a face: the label, the rim cable slot and the strap
slots. One layout per face (`FaceLayout`, `src/core/face/`) holds them, and
`Design.faces` exposes it. A feature is plain data (`FaceFeature`): an id, a
kind, a status (`auto`, `user` or `blocked` with a reason), its outline loops in
mm in the face plane, and its operation. `placement` is reserved for the part
that lets a user pin a feature; nothing fills it yet. The layout crosses the
worker boundary, so it holds no functions or classes.

**The layout pass.** `layoutFace` (`face/layout.ts`) places the kinds one by
one, in priority order: label, rim slot, strap slots. `design()` first builds
the face's fixed keep-outs: the channel ribbon, the pads, the keyholes and
through holes, the SKÅDIS footprints and notches, the T-clip cutters, the mount
plate's anchors and clips, and the cable lead-ins. Each placed feature then adds
its own loops to the keep-outs of the kinds after it. A kind's `place` calls the
same search it always used (`resolveLabel`, `layoutRimSlot`, `layoutStrapSlots`).
The mount plate's face (`layoutPlateFace`) maps the base's strap slots onto the
plate.

**The kind registry.** `face/kinds.ts` has one `KindDef` per kind:

- `avoids(face)` names the keep-out kinds the feature stays clear of on that
  face, the clearance, and whether degenerate polygons (under 3 points) are
  dropped first. It returns nothing when the kind does not go on that face.
  The cap's rim slot avoids only the label, unfiltered; the base's rim slot
  avoids the channel, pads, keyholes, through holes and SKÅDIS footprints; the
  strap slots avoid everything else on their face, which is why a notch, a
  T-clip or a lead-in blocks a strap slot but not the rim slot.
- `cutRank` sets the order of the booleans inside a face: rim slot 10, strap
  slots 20, label 30. Both backends use it, so a cap is cut the same way
  everywhere. Cuts stay one subtract each and are never merged: the mesh
  output depends on their order, and the label's triangles stay tagged only
  because the label is its own cut.
- `title` names the cut in an error.

**Generic operations.** `faceOps(layout)` turns the placed features into a
sorted list of `FaceOp`s. Each backend applies the list to a slab (`zLo` and
`thickness` of the face's part, passed as the part already states them):
`applyFaceOps` in `manifold.ts` and `applyFaceOpsStep` in `step/build.ts`. A
`through` op cuts the whole slab, with the weld overlap on both sides. An
`engrave` op cuts `depth` into the slab's top face. An op with `mark` has its
triangles tagged in the mesh (`labelTriangles`). The STEP backend fuses a
multi-loop cutter by classifying the loops into solids and holes
(`classifyLabelLoops`), as the label always did.

**Adding a kind.** Write one `KindDef` (its `avoids`, its `place`, its
operation and `cutRank`), add its outline function, and list it in `FACE_KINDS`.
The layout, the face operations and both backends need no other change. A kind
that adds material (an emboss) needs a third operation first; nothing uses one
yet. A new kind of thing to avoid goes into `FixedKind` and into the face's
fixed keep-outs in `design()`.

`Design.rimSlots`, `strapSlots`, `labelFit` and `strapSlotsNote` stay as views
of the layouts' results for the UI and the tests; the STEP backend reads
`Design.faces`.

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
  A wider gap under the tips shows as a slit that the line art draws as a
  dashed line, and tips that print a layer long just rest on the seat.
- **Barb and ridge.** A barb protrudes 1.1 mm past the finger. The ridge
  stands 1.1 mm into the bore and is 1.4 mm tall. The barb's tip keeps 0.1 mm
  plus the tolerance from the bore wall. So the barb overlaps the ridge by
  1.0 mm less the tolerance, and the finger clears it by 0.1 mm plus the
  tolerance, the same gap as the barb's tip from the bore. The preload is at
  most half the engagement.
- **Finger wall.** 1.2 mm, three 0.4 mm extrusion widths. It is thinner than
  the press collar's 2 mm, so the cap's inner step is smaller and the fingers
  bend more easily. The relief slots between fingers are 2 mm wide.
- **Lead-in angle.** The barb's lead-in face is `SNAP_LEAD_IN_ANGLE_DEG` from
  the axis (30 degrees); its back face toward the plate is 45 degrees. Both
  faces start `BARB_EMBED` (0.2 mm) inside the finger so they weld in instead
  of meeting its surface at a tangent.
- **Root flare.** The fingers' root flare reaches out as far as the barbs, so
  it clears the bore by the same gap. It lies inside the core's relief.
- **Rings.** The core-side ridge and seat follow the bore's shape, so they stay
  parallel to the collar at every angle. Each is a lip welded into the wall,
  with its relief cut from the lip on its own, never from the wall. The
  relief's chamfers run out past the bore by `WELD_OVERLAP`, and the lip is
  welded `WELD_OVERLAP / 2` into the wall (less, where the wall behind the
  cable groove's floor is thin: never more than halfway through it). So a ring
  meets the bore at 45 degrees instead of nearly tangent to it, which boolean
  CSG handles poorly. A chamfer's rise is the widest horizontal step, at the
  corners when an outline's corner radius is floored, so none is steeper than
  45 degrees. The ridge sits `preload` lower than the barb's engagement point,
  at most half the engagement.
- **Rings take the wall's columns.** A lip with its own, finer facets poked out
  through a coarse (draft) wall's chords behind the groove.
- **No flush faces.** The prism of the collar's base runs halfway up into its
  flare, so the two share no face: where they met flush at the flare's foot,
  the union left zero-width slits along the straight sides that came off the
  cap as separate pieces at some column counts.

### Bayonet joint

Round cores only. `bayonetLayout` in `src/core/joints.ts` has the profiles.
Three lugs stand in the core's bore just under the rim, and the cap's collar
has an L-slot for each. The cap drops on turned counter-clockwise, then turns
clockwise (seen from above) by 60 degrees to a hard stop.

- A lug reaches 1 mm into the collar (the hold). It is 5 mm wide at the
  collar and at most 30 degrees of arc, so the lugs, the slots and the walls
  between them fit round a small collar.
- A lug's flat top sits 1.5 mm under the rim, so the collar keeps that much
  (less the gap) of solid ring above its grooves. Its vertical tip face is
  0.8 mm; under it the lug runs back to the bore wall at 45 degrees.
- The sliding clearance for the twist is 0.4 mm, plus the tolerance.
- The collar keeps at least 1.2 mm of wall behind the L-slots (its centre hole
  shrinks to keep it) and at least 1.5 mm between one groove's end stop and the
  next entry slot. With less land the cap gets the press fit.

The lugs stand in the core's bore and the L-slots are cut into the cap's
collar, not the other way round: the core's wall carries the cable groove,
which runs up to about 2 mm under the rim, so cutting into the wall there would
leave too little of it. The collar is solid plastic all round, and its centre
hole is sized so `BAYONET_MIN_WALL` always stays behind the groove. Both parts
print without overhangs: a lug has a 45-degree underside back to the wall (the
core prints upright), and the cap's groove is the lug grown by the sliding gap,
so in the cap's print orientation its ceiling is 45 degrees too. The slot is
straight up from the collar's tip to the groove's top, as wide as the lug plus
the gap on each side. Each groove runs from its slot to just past its lug,
where its end face is the stop.

## Export

| Format | How |
|---|---|
| STL | Binary STL. One file for a single part, a zip of STL files for several. Each part is in its print orientation, resting on the bed. |
| 3MF | A hand-written core-spec writer on a small zip writer. One `<object>` and one `<build><item transform>` per part, laid out on the plate. Names and units are set. No colours: Bambu, Orca and PrusaSlicer ignore `basematerials` and read only a vendor `paint_color` attribute. It is not tested in a slicer in this repo. |
| STEP | One file, one solid per part. The OpenCascade WASM is loaded lazily in a worker when the user asks for STEP. |

`bedRestingTransform` corrects a part's `printTransform` so its lowest point
lands exactly on z = 0. The transform only orients a part. It happens to rest
the cap on the bed (its flip cancels the height), but not the core: the core's
flange lies below the wall's z = 0, and its transform is the identity. The STL
and the 3MF both place parts through it, and the 3MF and the viewer's print
layout both use `printPlacements`, so a part sits in the same place in the
export and on screen.

- The zip writer stores without compression and stamps a fixed date
  (2026-01-01), so a design always exports the same bytes. It is hand-written
  because the multi-part STL bundle and the 3MF are all it serves, and a
  dependency would cost more than it saves.
- In the 3MF every object's mesh is in the part's own frame, the same
  `part.mesh` the viewer, the STL and STEP read. The print orientation and
  plate position are the `<item>`'s transform, a row-major 4 x 3 matrix
  (`P' = P * M`) for a turn about Z, then about X, then the translation.
  Parts are separate build items, not `<components>`, which build one object
  out of sub-parts.

### STEP

STEP uses replicad (OpenCascade WASM). The grooved wall is a periodic cubic
B-spline surface, fitted in JavaScript (`src/core/step/bspfit.ts`) to the same
parametric grid the mesh uses. The poles go straight into
`Geom_BSplineSurface`. Planar caps are added, the faces are sewn into a solid,
and the bore is cut. Booleans for the rest are ordinary and run on planar or
analytic geometry. A bare core skips the bore cut: its tube is sewn from the
wall's faces and the faces of an analytic bore with its end rings, so the face
channels are the only boolean that touches the wall.

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
  (corner radius, or a pill's end radius; the default is 8 mm, and 20 mm for a pill), `lock` with `size`, `h` and `ly`, `cap`, `joint`, `tol`,
  `base` (the base plate, only written when on), `strap` (the strap slots, only written when on), `bx`/`by`/`bz` (bed), `label`, and the mount keys (`mount`, `pj`, `kr`,
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
- The JSON is encoded as UTF-8 bytes before the base64url step, because
  `btoa` only takes Latin-1 and a label can hold any character. The `=`
  padding is stripped, since it would collide with the `key=value` split of
  `URLSearchParams`. Only the `s` parameter is read; any other one next to it
  is ignored.
- `ui` holds view-only state (the wire toggle, the design or guide screen). It
  does not change what `design()` computes, but a shared link reproduces the
  screen the sender saw. The top-level keys otherwise mirror `CoilSpec`.
- A link that locks the core size, the height and the layers at once (the UI
  cannot produce it, because something has to stay free to fit the cable) keeps
  every other field: the layers lock is dropped, with a notice.
- The keyhole rotation is 0 or 45 degrees only. A key that only applies to one
  mount (`kr`, `thd`, `latch`) or one shape (`rc`) or cable type (`mbr`) is
  rejected when its mount, shape or type is not selected.

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
smallest angle (`src/core/flatFaces.ts`). A flip across a corner a hair off the
plane (up to 0.01 mm) may not turn either new triangle more than a degree away
from the plane: on the cap's 45 degree rim chamfer a flip beside the cable slot
made a sliver 0.1 mm wide that leaned 46.6 degrees, past what a printer holds
without support (#279).

The edge cut comes first because a flip can only choose among the vertices a
face already has, and a fan's spokes are one long edge each, with no vertex to
flip to. Measured on the round cap in the print layout (27 views at 2x pixel
density), stray dots were 107 with no pass, 24 with flips alone, 21 at a 25 mm
edge cut, 8 at 15 mm, 2 at 10 mm, 5 at 6 mm, 10 at 3 mm and 1 at 2 mm. Below
10 mm the count is noise, but the triangles are not (the cap has 9.3k at
10 mm, 30k at 2 mm). A flip needs two triangles in one plane within 0.01 mm:
the seams where a curved collar wall is cut by another curved surface sit
0.005 mm off, and neighbouring facets of the collar wall (0.3 mm wide, 0.77
degrees apart) sit 0.004 mm off. The planes are any, not only horizontal: such
a seam leaves a strip of micro-triangles whose normals point 45 degrees away
from the wall's, and the shader draws a dot where one lands on a pixel. A flip
never moves a vertex, so the surface changes by at most that tolerance. Rules
for a flip:

- Only pairs with a triangle under 2 degrees are worth it. The collar's wall is
  a skin of columns 0.06 mm wide (3 degrees at best), and thousands of flips
  for nothing would follow otherwise.
- The quad must be strictly convex and both old triangles must have area. A
  flip across a corner a hair reflex leaves an inverted triangle that can cut
  the part into pieces (the bayonet cap, #201), and across three points on a
  line it reorders a zero-width slit that manifold-3d can then cut off (#208).
- Triangles at coincident vertices, and the ends of an edge where the surface
  folds back onto itself, stay as they are, for the same reason.
- The new edge is at least the weld's limit long and does not exist already.
- The pass uses typed arrays: it runs on every design, and the garbage of a
  plain-array version showed in the memory test.

Before that, `src/core/weld.ts` collapses every edge under 0.02 mm. A collapse
that fails the link condition because a vertex across the edge has only three
triangles drops that tip first, when it lies within 0.04 mm of the plane its
neighbours span. A channel's side wall crossing the wall's rim beside a rim
vertex leaves a tip 0.03 mm off a steep wall triangle (#292).

When neither end of a short edge can move onto the other (the slope of a
channel lip meets its wall 0.02 mm above the wall's foot, and moving either end
turns a sliver over the bottom face), the weld slides one end along a longer
edge to a neighbour instead, when the end lies within 0.01 mm of the planes of
the triangles it leaves. A closed piece of two triangles has no volume,
and is dropped whole when one of its edges is short, however far the third corner
is (#303, and #320, where the booleans on a pill's mirror plane left one with a
corner 2.8 mm away).

The SKÅDIS clips are built by hand from rings, not by the booleans, so the weld
limit has to be met by the profile itself. A clip's fillets are faceted at
11.25 degrees, and its cap edges are chamfered 0.4 mm by moving the profile in
with mitred corners. Inside that chamfer an arc of radius r has facets of
about 0.196 (r - 0.4) mm, so a 0.5 mm arc would leave facets of 0.0196 mm,
under the weld limit. The smallest convex fillet is therefore 0.55 mm
(`SKADIS_CLIP_FILLET_MIN_CONVEX`), and the shortest board-face edge between two
fillets 1.1 mm. A flat under 0.1 mm between two fillets is taken up by one of
them. The chamfer faces are marked as the rim's chamfers are (`rimTriangles`),
and the clip's walls as the land, so the viewer inks the one crease where the
chamfer meets the wall, at the old cap edge, and none where it meets the cap.

The camera is refitted to the projected bounds when the geometry changes.
The wound cable is drawn as one merged tube per layer, with smooth normals so
the tube's facets do not draw lines. When the wire's on-screen diameter falls
below 4.8 px, the layers (of more than 12 turns) are drawn as a plain envelope
shell plus a few real turns, because the lines of adjacent turns would merge
into a black band. The on-screen diameter is the canvas height times the wire
diameter, divided by the cable's height plus its outer diameter. When the
final mesh replaces the draft, it fades in over a quarter of a second.

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
- The edge and thicken passes run at `max(2, devicePixelRatio)` device pixels
  per CSS pixel: 2x supersampling on a 1x to 2x screen, native above that. A
  1.5x screen used to run them at 3x, which cost more and showed no cleaner
  line. The output pass averages them down, so thin lines are smooth and not
  stair-stepped.
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
- The switch is the tube's screen diameter, not the turn count or the turn
  pitch. The crease shader inks any two neighbouring pixels whose normals
  differ by more than 30°. A tube 4 px across turns round by more than 30° per
  pixel everywhere, so it is solid black. At about 5 px a white strip is left
  between its two outlines. Measured at a 920 x 613 px canvas, a 4 mm cable
  keeps white rings at 80 turns (5.9 px), a 2 mm cable at 80 turns (5.2 px) but
  only grey ones at 91 (4.5 px), and a 1 mm cable is already black at 72 turns
  (4.0 px). No single turn count fits all three. The 4.8 px threshold sits just
  above where white starts to vanish. The estimate is rough: it ignores the
  camera angle and the cable's gap between turns.

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
- The strap slots switch sits under the top cap switch and shows while the base
  or the top cap is on. It is off by default. A note under it appears when a
  plate gets no slots.
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
