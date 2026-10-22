# Wall mounts

The coil axis points out of the wall. The bottom flange's outer face is against
the wall, and every mount feature is on that face. The mount is semi-permanent.
Multiboard is not supported.

| Mount | What it is | Status |
|---|---|---|
| Screw keyhole | A pocket recessed into the flange's outer face | Tested in geometry only |
| Through holes | Plain screw holes through the flange | Tested in geometry only |
| IKEA SKÅDIS rim clips | Separate clips that hook the board and grip the flange's rim | Not test-fitted on a physical board |
| IKEA SKÅDIS T-clips | Twist-lock clips through slots in the core's floor, turned by fins (after the CC BY 4.0 Skadis T-Clip System) | Not test-fitted on a physical board |
| openGrid | A separate plate glued to the flange, with a placeholder connector | Not usable: hidden in the UI and rejected in links |

coil3d is not affiliated with IKEA. SKÅDIS is an IKEA product name.

## Screw mounts

- **Keyhole.** A narrow, shallow slot at the wall-facing surface holds the
  screw shank. Behind it, a deeper and wider chamber lets the screw head
  travel. The head therefore stays captured, not just wedged. The slot can be
  rotated by 0 or 45 degrees away from vertical; the mount axis stays level
  at every setting. Sized for a common wood screw (head about 8 mm, shank
  about 4 mm). A tolerance-checked 2 mm of flange is kept around the cut.
  - The pocket is 3 mm deep: a 1 mm slot level at the wall-facing surface, and
    a 2 mm undercut behind it (a pan or truss head is about 2 mm high, so the
    head is captured there and not wedged at the mouth of a shallow chamber).
    The slot is 6 mm wide, midway between the 4 mm shank and the 8 mm head.
    A single depth cannot work: an 8 mm head cannot pass a 4 mm channel to
    reach the shank's rest point, 4 mm from the entry hole. The slot is nearest
    the face that prints on the bed, so the void only widens as the print
    rises. It needs no support and is a plain bridging pocket.
  - 2 mm of roof stays above the pocket for the head to press against, so a
    keyhole flange is at least 5 mm thick.
  - The cut's widest reach is the head radius at either end (the undercut is
    head wide, directly behind the narrow slot). So the flange's radial width
    is the slot travel plus two head radii plus two edge margins, at whatever
    angle the slot sits. Placement uses the shape's exact radius at that angle,
    not its corner radius, which for a non-round shape could be so pessimistic
    that the mount never fits.
  - A flange over 90 mm across gets two slots, 25 degrees either side of the
    axis, for a more stable hang. The axis may tilt up to 60 degrees from
    vertical to land on a cheaper direction, such as a flat side's midpoint
    instead of a sharp corner.
  - The rotation is 0 or 45 degrees, never 90. At 90 the channel would run
    horizontal once hung level, with no gravity along it (cos 90 = 0), so
    nothing would stop the screw sliding. Even 60 degrees (cos = 0.5) is the
    outer limit of tilt, so 90 would just clamp to 60.
  - "Up" is local +Y in the flange's frame (`WALL_UP`, `src/core/mount.ts`). The
    viewer's wall preset rotates the geometry so that same axis lands on the
    camera's up vector, so the core and the viewer agree on which way is up.
    The slots sit above the centre, with the narrow shank end higher than the
    head end: the screw goes in at the wide hole, the part is lowered, and
    gravity seats the shank at the far end against the roof.
  - Both channels run parallel to "up", not radially. The part is rigid, so for
    two slots to hang level they must already point the same way; a radial fan
    cannot be vertical at both once installed.
  - A slot or a pair is placed on a genuine mirror axis of the outline, so the
    centre of mass hangs straight below it. A regular n-gon has 2n such axes
    (n through a corner, n through a side's midpoint), 180/n degrees apart.
    Round and square have one at vertical; a triangle's are 60 degrees apart,
    so it tilts onto the nearest. The search window (60 degrees from vertical)
    is fixed and is never re-centred on the rotation request: the request only
    picks among the same safe axes. Without a request the cheapest axis wins
    (the smallest exact radius at the slot's own fanned position, a side's
    midpoint having no corner bulge), ties going to the one nearest vertical.
    With 45 the axis closest to 45 wins, but never the automatic axis when
    another is reachable: a triangle has only two axes (30 degrees either side),
    and the one nearest 45 is also its cheapest, so without that rule the
    rotation did nothing for triangles. With a single reachable axis it stays on
    that one. The two-slot fan is costed too, because fanning away from a
    corner can be cheaper than fanning away from a side.
  - The slots stay clear of the wall's own outline, not of the bore. The
    flange's inner annulus, bore to outline, sits directly under the solid wall
    tube, so a cut there would undermine the wall's support. Only the outer
    annulus, outline to rim, is safe.
  - The required margin is found by bisection, not a closed form, because the
    shape's radius at an angle is not additive in the margin away from an exact
    corner or side centre. The target gets a hairline (1e-6 mm) so that the
    layout's own later fit check cannot read a few ULPs short.
  - The layout reports the axis it used (`axisDeg`), so the viewer can show the
    real hung orientation: a triangle hangs level with that axis vertical, not
    local +Y.
  - The mesh overlaps the slot and the undercut by 0.05 mm: with the two levels
    meeting exactly on one plane, a fine flange-thickness sweep hit a stray
    sliver at one thickness. Only manifold needs it; the exact kernel in STEP
    uses an exact abutment.
- **Through holes.** Plain round holes, constant radius, with no counterbore
  and no pad. The diameter is a setting (2.5 to 8 mm, 4.5 mm by default).
  Holes sit near the corners of a square or triangle flange and are evenly
  spaced on a round one. Since #239 each hole sits as close to the core as it
  fits, under the winding if that is where it falls (screw the core to the
  wall before winding). On the winding face it has a 90-degree countersink,
  twice the hole's width or the 2 mm bearing ring at most, keeping 1 mm of
  plain bore below it. A countersunk screw's head then lies flush under the
  cable. The cone faces up in the core's print orientation, so it needs no
  support. Every screw head (the hole plus its 2 mm bearing ring) keeps
  0.5 mm of plain plate between it and the thickened pads of the flange,
  such as the collar under the wall and the inner-end channel pad. A corner
  hole turns up to 20 degrees round its corner to clear the channel pad
  before it is skipped. A round flange rotates the ring of holes to clear the
  inner-end channel pad. A round flange rotates the ring of holes to clear the
  pads. A square or triangle flange skips a corner hole that is blocked and
  warns, but only on a locked core size: with a free size the flange margin
  grows until every hole fits. This mount is permanent.
  A round flange tries four holes, then three. A hole that does not clear the
  channel or a pad moves outward in 0.25 mm steps. The screw head bears on the
  flat top of the plate, so a hole sits 1 mm further from the rim than the
  2 mm edge margin, past the rim's chamfer.
  The holes are at fixed angles (a corner's centre for a square or triangle,
  evenly spaced for round), never searched. At a corner the shape's radius is
  additive in the margin, so the required flange margin is a closed form. The
  hole sits clear of the wall by the bearing ring, and of the collar pad by
  0.5 mm plus a hair. Off a corner's bisector the wall and the rim are nearer
  than along the radius, so the hole's true offset is checked as well. A round
  ring that collides is rotated, in whole degrees, to the middle of the widest
  range of rotations that clears, so the holes either side of the channel pad
  keep about the same room.

## SKÅDIS

IKEA publishes no spec. The numbers below are community measurements that
agree across independent sources.

| Fact | Value | Sources |
|---|---|---|
| Slot | One vertical stadium slot per position. Nominal 5 x 15 mm, measured as tight as 4.8 x 14.8 mm | [Pegboardly, SKÅDIS Sizes & Dimensions](https://pegboardly.com/skadis/skadis-sizes-and-dimensions); [Thingiverse 4939659](https://www.thingiverse.com/thing:4939659); [jbazant/esp8266-binary-clock `case/skadis.scad`](https://github.com/jbazant/esp8266-binary-clock/blob/master/case/skadis.scad) |
| Lattice | Two 40 x 40 mm grids offset by (20, 20) mm: columns every 20 mm, slots every 40 mm in a column, neighbouring columns shifted 20 mm. Two slots 40 mm apart in a row are on the same grid | the same `.scad` (`SPACING_X=20`, `SPACING_Y=40`); Pegboardly |
| Board thickness | About 5 mm: 4.82 mm unpainted and 5.23 mm painted, measured by the T-Clip listing. 5.1 mm in [florianfesti/boxes](https://github.com/florianfesti/boxes/blob/master/boxes/walledges.py) and the `.scad`. Some boards are 4 mm | [Printables: Skadis Thickness Testers](https://www.printables.com/model/271676-skadis-thickness-testers); [Printables: Skadis T-Clip System](https://www.printables.com/model/256896) |
| Slot edges | Rounded over by about 1 mm on both faces | [Printables: Skadis T-Nuts](https://www.printables.com/model/228663) |

The constants are in `src/core/constants.ts` (`SKADIS_*`). Background research, with the
designs we looked at and their licences: [research/skadis-mount.md](research/skadis-mount.md).

### Rim clips

There is no plate. Separate clips hook into the board and grip the bottom
flange's rim, each in a small notch. `src/core/skadisClips.ts` lays them out
for both geometry backends.

- **How many.** 1 top clip and 2 bottom clips, whatever the core size. A
  cable estimated over 0.5 kg gets a second top clip (2 + 2). The estimate is
  the cable's cross-section at 1.8 g/cm³ times its length: about 5.5 m of
  8 mm cable, or 25 m of 3.8 mm cable. 0.5 kg is about a third of the 1.5 to
  2 kg per hook that printed SKÅDIS hooks are reported to hold (a load test
  on a T-Clip remix, Printables 637795).
- **Where.** The coil hangs with a flat at the bottom where the shape has
  one: a square on a side, a triangle on a side with its apex up. The top
  clip sits in column 0, the bottom clips in columns ±20 mm. Every clip is on
  one of the board's two 40 mm grids, and each clip's spine takes up the
  difference between its slot and the rim. If the inner-end channel is in
  the way, other columns are tried, then a triangle hung apex down (two top
  clips on its top side, one at the apex).
- **The profile.** Each clip is one flat profile, 4.4 mm thick, with:
  - a stem through the slot (5 mm) and a tongue behind the board (3 mm
    thick, reaching about 4.6 mm past the slot's end once seated);
  - an outer jaw between the flange and the board (the 3 mm standoff), a
    bight round the rim, and a lip on the winding side that reaches 5 mm in
    from the notch floor.
- **Dimensions.** The clip is 4.4 mm wide: the tightest 4.8 mm slot less 0.2 mm
  a side. The stem (5 mm) and tongue (6 mm, so 11 mm together) pass the
  tightest slot's 11.9 mm of full width. The tongue's retaining face sits
  0.3 mm behind the thickest, 5.2 mm board. The notch in the rim is at least
  1 mm deep, with a flat floor for the bight, and the rim crosses each notch's
  side walls at least 15 degrees steeply, so no sliver of rim is left beside a
  notch. The lip keeps 1 mm from the wound cable's outer surface.
- **The latch's dimensions.** The arm is 1.6 mm thick and flexes into a 2.9 mm
  slit, beside a 3 mm mast. From the tooth's centre to where the slit's rounded
  end meets the arm it is 21 mm: long enough to keep the bending strain under
  1.5 % (3 t d / 2 a²). The tooth is 2.5 mm deep and 4 mm long. Its top is
  modelled 1 mm below the top of the slot's full-width part (tightest slot), but
  the tooth's slanted face meets the board's rounded slot edge first: measured
  against that board, a seated clip lifts 0.43 mm in the tightest slot and
  0.88 mm in a nominal one before the slot stops it (issue #364). 0.8 mm
  separates the stem's top from the arm's free end.
- **Fillets.** Every corner of the profile is rounded as far as its edges
  allow, up to 2 mm. A fillet takes at most half of each edge it touches (all
  of it where the other end is a sharp corner), then whatever a neighbour
  leaves unused, so two fillets never overlap. A flat under 0.1 mm between two
  fillets is taken up by one of them. The arcs are 8 facets per quarter turn, the same on every core and in the
  mesh and the STEP file. Four corners stay sharp: the latch tooth's catching
  face at both its ends, and the tongue's retaining face at both its ends. Two
  more are capped: the stem's root at the board face (0.8 mm, so it nests in
  the board's 1 mm round-over) and the latch's end gap (0.8 mm, so the fillet
  doesn't reach over the arm's free end). The bight's two inside corners take
  0.95 mm, which leaves a 1.5 mm flat for the rim to rest on. The rim's notch
  is rounded to match, concentric with them, so the gap to the clip stays one
  tolerance all round; on the bed side the round is a 45° chamfer of the same
  reach, so the flange still prints without supports. A board-face edge
  between two fillets is kept at least 1 mm long: where a bottom clip's stem
  would sit closer than that to the bight's back or the jaw's tip, the bight
  or the jaw grows by the difference.
- **Frame and seat.** Like the keyhole layout, "up" and "side" follow the
  chosen axis. Every clip is one closed profile in the (up, z) plane, extruded
  4.4 mm along side. "Seated" means each stem rests on the bottom of a nominal
  5 x 15 mm slot, on its lower corners at the rounded end.
- **The lips and the pads.** The lips lie on the plate, below the winding face.
  There the pad under the wall has flared at 45 degrees to the collar's
  2.5 mm plus the plate's depth below the face, and at the lip's underside (a
  tolerance above the plate) that is a tolerance less. The lip keeps 0.5 mm
  from that flare, and 0.05 mm from the channel pad's footprint (its widest,
  half a millimetre inside the plate). With a plain flange there is no pad
  and no flare.
- **Clean-up.** A point closer than the weld's limit to the one before it is
  dropped from a profile (a jaw's end and the stem's top fell 0.01 mm apart,
  and both backends built an edge that short, #219), and so is a vertex on a
  straight line.
- **Fallbacks.** The default columns come first. When the inner-end channel is
  in the way, the layout tries other columns, a top pair over one bottom clip,
  or one clip above the other. Three or more clips if any arrangement allows
  it; two in one column only as the last resort. The required flange margin is
  found by bisection over the real layout, with a hairline added so the later,
  independent recomputation never falls a few ULPs short.
  The last bottom choices are one clip at column -40 or +40. A pill needs
  them: its inner-end channel runs back along the long flat for about 45 mm and
  blocks the columns -20, 0 and 20 under it, and on a locked size the margin
  does not grow, so without them a long pill lost its clips. They
  are tried only when no other column choice fits on either axis, so every layout
  that fitted before is unchanged. The margin search
  still uses the first choice only. A pill whose long flat is under about
  90 mm has no free column once the channel takes the middle, so on a locked size
  it warns and leaves the clips out; a free size grows the margin until they fit.
- **Print orientation.** Each clip prints lying on its flat face, so the
  weight, a pull and the tongue's bending all run along the layers. It has
  no overhangs or bridges. The old plate's clip legs were printed upright
  and flexed across the layers.
- **The flange.** A flat-floored notch at each clip keys the coil's rotation.
  The jaws grip the flange's plain 3 mm plate, the same base as the
  through-hole mount: nothing thickens the rim under a clip (issue #222), so
  the clip is the same part for every cable and core. The notch stays: it is
  what stops the coil turning on its clips. The lips keep 1 mm clear of the
  wound cable and beside the thick pads under the wall and the inner-end
  channel (they lie on the plate, below the winding face), so the flange
  margin grows if they don't fit (by 0.3 to 1.8 mm, on square and triangle
  cores with a cable of 5 mm or more). A small triangle with a thick cable may
  have no room for the clips left: it warns and leaves them out. The load
  check for the plain plate is in
  [research/skadis-mount.md](research/skadis-mount.md#rim-load-check-issue-222).
- **The latch (on by default).** The top clip has a spring arm on the board
  face, cut free from a rigid mast by a slit. Its tooth reaches 2.5 mm into
  the slot, past the 1 mm edge fillet. While the clip is pushed in, the arm
  flexes back (in the clip's own plane, so along the layers, at most 1.5 %
  bending strain). It springs into the top of the slot when the clip drops.
  Seated, the coil can lift at most about 1 mm. The tooth's upper face leans
  25° from the board normal, so a firm lift cams it out again (an estimate:
  about 10 to 20 N, depending on friction). Turn the latch off for a plain
  hook.

Hanging the coil:

1. Push each bottom clip into its slot and let it drop.
2. Lower the coil's rim into the bottom clips.
3. Push the top clip into its slot just above the rim and let it drop until
   it clicks.

To take the coil down, lift the top clip firmly.

`test/skadisFit.test.ts` checks the real clip meshes against a board built
only from the facts above. It uses three boards: tight 4.8 x 14.8 mm slots in
a 5.2 mm board, and nominal 5 x 15 mm slots in 5 mm and 4 mm boards. It
checks that:

- every clip sits on the lattice and clears the board when seated;
- each stem bears on its slot's bottom;
- a pull is caught by the tongues;
- a 1.6 mm lift hits the latch tooth;
- raised by the drop, the stem and tongue pass straight through the tightest
  slot;
- the rim rests on the bottom clips and is held by the top lip;
- no clip touches the wound cable;
- every clip prints flat with only vertical faces.

**This has not been test-fitted on a physical board.** The latch's release
force and the board play (about 1.5 mm on a 4 mm board) need a real print.

### T-clips

A second SKÅDIS mount type (`mount: "skadis-tclip"`, issues #213, #221):
twist-lock clips that clamp the core's floor flat to the board, from inside
the bore. `src/core/skadisTclips.ts` lays them out for both geometry
backends.

**Credit.** Adapted from the
[Skadis T-Clip System](https://www.printables.com/model/256896) by Line Arc
Line, licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
(checked through the Printables API: CC BY 4.0 International, remixing and
commercial use allowed). We took the mechanism: a T that goes through the
slot upright and turns a quarter turn to lock behind the board, at least two
per part. We also adapted its smooth-turning features: the hook ramps, the
chamfered edges, the shaped stem and a seat lead-in. Modified: the clip is
re-implemented parametrically with our own dimensions (none of the
original's files or geometry are used). The receiver is our own floor in the
bore, not the original's round clip seat, and the handle is a fin. The
same credit is in `public/THIRD_PARTY_NOTICES.txt` ("Designs").

- **The clip.** One flat "I" profile, 4 mm thick, printed lying on its face,
  so the clamp, the weight and the bars' bending run along the layers.
  - A fin handle, 18 mm wide (see "Reaching the fins"): long enough to grip,
    and to bear on the floor either side of its slot. It is 12 mm tall above
    the floor, and at least 5 mm above its recess; it is lower only where the
    core has less room (below the cap's collar or the ring's funnel, with a
    1 mm gap). A clip only needs a short fin to turn it, so a taller one
    would waste filament and print time.
  - A 2 x 4 mm stem with 0.5 mm chamfered corners: its diagonal (about
    4.1 mm) turns inside even a 4.8 mm slot.
  - A T bar, 12.2 x 3 mm. It passes the tightest slot's 12.65 mm of full
    width, and overlaps the board by 3.7 mm a side once turned. Its bearing
    face ramps down 0.7 mm over its last 1.2 mm at both ends (the original's
    hook ramps), so the bar rides onto the back of the board as it turns.
  - Every edge is chamfered 0.6 mm, the faces' edges too (45°, so the
    bed-side ones print).
  - A notch across the fin's top, on the clip's axis and through its full
    4 mm thickness: 1.2 mm wide and 3 mm deep, so a flat screwdriver's blade
    turns a fin that is out of reach. It runs across, not along the edge,
    because the clip prints on its face: the notch is then part of the flat
    outline, with no overhang, and a turning blade loads its walls along the
    layers. A groove along the top edge would overhang its whole depth and
    load its thin walls across the layers. The notch's mouth has a 0.4 mm
    lead-in chamfer. A fin with less room keeps at least 2 mm of full-width
    fin above the floor's top, so its notch is shallower, and it has none
    under 1 mm.
  - The gap between the fin's and the T bar's bearing faces is the floor
    under the recess plus 5.2 mm. That is tight on a painted 5.23 mm board,
    and leaves about 0.4 mm of play on an unpainted 4.82 mm one. There is
    one clamp length.
- **Construction.** A clip is a base fin, two prongs, a stem and a T bar (a
  fin with no notch is one piece), each a convex prism with its faces' edges
  chamfered. The prongs are the fin's two halves above the notch's floor; they
  run two chamfers (1.2 mm) down into the base, so that on each face the
  prong's chamfer ends exactly where the base's begins: the joint leaves no
  groove, and no coplanar overlap that would leave slivers. The mesh backend builds each as the hull of its
  four levels and the STEP backend as a loft through them: the same solid. The
  stem runs 0.5 mm into the fin and the bar so the pieces overlap. The slot
  and recess cutters are separate convex pieces (a hull of both would bulge
  over the lead-in's inner corner): the slot, the straight prism, then the 45
  degree mouth. The recess is a bow tie: the upright and across bars plus the
  two quarter sectors their far corners sweep when the fin turns clockwise.
  The mesh backend unites the four pieces of the prism in 2D and extrudes the
  result once: four hulls that share the recess floor's plane meet at corners
  that agree only to rounding, and the 3D union of such coplanar floors could
  leave a zero-thickness sheet on it (pill fuzz case 4020). The mouth's cone
  continues 0.25 mm below its start (`SKADIS_TCLIP_LEAD_IN_ROOT`), inside the
  prism, so it crosses the prism's wall instead of starting exactly on it,
  which left a zero-volume wedge there. The shape is the same.
- **The floor.** The bore's bottom is filled from the flange's wall face up
  to its winding face (at least 5 mm thick), one solid with the core and
  printed on the bed.
  - A slot through it at each clip lets the T bar pass and the stem turn.
  - A 2 mm recess in its top holds the fin's foot. Its walls stop the fin
    upright and at a quarter turn clockwise (seen from the room). Turned,
    the fin sits in the recess's across arm, whose upper edge rests on it:
    that carries the coil.
  - The slot is the board's nominal 5 x 15 mm slot plus 0.1 mm all round, so
    the T bar passes and the stem turns. A clip's axis keeps the recess's
    sweep plus 1.5 mm from the bore's wall.
  - The slot is as wide as the recess's upright arm, so the two make one
    straight channel with no ledge. The recess's mouth, where the T bar goes
    in, has a 0.5 mm x 45° lead-in. Below it the walls stay vertical: they
    are the stops and carry the weight.
  - Nothing sticks out past the flange, and the inner-end channel and the
    cable path are outside the wall, clear of the floor.
- **How many, and where.** Every slot is on one of the board's two 40 mm
  grids, with its axis at least the fin's turning radius plus 1.5 mm from
  the bore's wall, and (with a cap) 8 mm inside the cap's hole.
  - 3 whenever they fit: 1 top clip above the bore's centre and 2 bottom
    clips 40 or 80 mm apart. There is no 4th clip for heavy cables.
  - Otherwise 2 (one above the other, side by side, or diagonal): the coil
    hangs straight from the pair, with a note.
  - Otherwise 1, straight above the centre so the coil hangs plumb below it.
    Its weight keeps the clip dropped in its slot, and a clip can't turn
    back without being lifted, so nothing turns. A note says so.
  - If no slot fits, the clips are left out with a warning that suggests the
    rim clips. That only happens on a locked core size: a free size grows
    until one clip fits.

  For 2 m of 3.8 mm cable: round 40-50 mm gets 1 clip, 60 mm gets 2, and
  70 mm and up gets 3; square 60 mm gets 2; triangle 50 mm gets 1.
- **Seating.** Seated, the clip's axis sits below the slot's centre by the
  turned stem's lowest points resting on the slot's rounded bottom.
- **Search.** For 3 clips the top clip goes at column 0 as high as it can, the
  pair below it at columns ±20 or ±40 (on the same 40 mm grid) as low as they
  can; the arrangement with the widest spread wins, ties go to the one centred
  on the bore. Pairs: one above the other, side by side, diagonal. A single
  clip sits as high as it goes, so the coil hangs below it like a pendulum.
- **Reaching the fins.** You reach through the core (and the cap's hole) and
  pinch the fin's top, or turn a fin that is out of reach with long-nose
  pliers, or a flat screwdriver in the fin's notch.
  - A 15 mm column straight above each fin's top stays clear of the core and
    the cap, so a fingertip or a tool goes straight down onto the fin.
  - Fins turn in their own 9.5 mm circles, and slots are at least 28 mm
    apart, so they never touch each other or the wall.
- **Fitting.**
  1. Hold the coil flat on the board, each slot in the core's floor over a
     board slot.
  2. Reach through the core and push each clip in with its fin upright: the
     T bar passes at the slot's centre.
  3. Pinch the fin (or turn it with long-nose pliers, or a flat screwdriver in
     its notch, if it is out of reach) and turn the clip a quarter turn clockwise until it stops.
  4. Let go. The coil and its clips drop together about 5.4 mm, until the
     stems rest on the bottoms of the slots.

  To take the coil down, lift it back to the slots' centres and turn the
  clips back. Turned back while dropped, a clip can't come out: its T bar
  is below the slot.

`test/skadisFit.test.ts` checks the T-clips against the same fact-built
boards as the rim clips. It checks that:

- the clips are on the lattice, inside the bore, 3, 2 or 1 by size;
- each clip passes upright through the floor and the board's slot;
- each clip turns a quarter turn without touching either, and the recess
  stops it beyond that;
- turned and dropped, it clears both, and turned back while dropped it is
  stuck;
- the stem bears on the slot's bottom and the fin carries the floor;
- the T bar catches the back of the board;
- the fins clear each other, the wall and the cap's collar, and their tops
  can be reached through the cap's hole;
- every clip prints flat with no face steeper than 45° overhang.

**This has not been test-fitted on a physical board.**

## openGrid

openGrid support is a placeholder. The core can build a plate for it, but it is
not reachable from the UI or from a link. The plate (`src/core/mountPlate.ts`)
is a flat panel inset 3 mm from the flange outline, printed back-face up, and
glued to the flange's outer face on two printed alignment pegs (`peg-1`,
`peg-2`: 3 mm chamfered octagons, printed lying on a flat, in matching blind
holes 2.4 mm deep in each part). SKÅDIS used the same plate until issue #207.

The plate prints back-face up and the core prints flange-down, so neither
mating face can carry a protrusion without supports. Both get matching blind
round holes instead, 2.4 mm deep (so the flange is at least that plus 1.5 mm
of roof thick there), aligned on two separately printed pegs, then glued.

- A peg is a low-poly prism: a 3 mm square with its corners cut 0.5 mm at 45
  degrees, an octagon whose 8 corners lie on one 1.80 mm circle, with a 0.4 mm
  45-degree lead-in on both ends. It is 4.5 mm long: both holes' depth less a
  little, so the faces close.
- It prints lying on one of its wide flats. The layers then run along the peg,
  so the joint's shear load never splits a layer line, and every other face is
  at 45 degrees or steeper, with no supports. The round hole grips the
  octagon's corners, so the peg goes in at any rotation.
- The plate keeps at most 4 clip positions each side of the centre per axis, so
  an oversized flange does not grow an absurd count, and it warns when fewer
  than 2 clip columns fit.

- The clip mount plate is a separate part: a flat panel of the layout's
  outline with no bore, in the assembly frame at z = -(flange thickness +
  `MOUNT_PLATE_THICKNESS`) to -flange thickness, its front face flush against
  the flange's outer face. Nothing protrudes from the front face (the plate
  prints on it); a blind peg hole goes into the plate from it and a matching
  one into the flange from its outer face. Each placeholder connector is built
  in a canonical local frame (up = +X, side = +Y, reach = -Z) and rotated
  by the layout's single axis angle, and its base is embedded by
  `MOUNT_PLATE_EMBED` because a coincident base face unions unreliably.
  Each peg hole's mouth pokes `MOUNT_PLATE_EMBED` out past its face.

- **Pegs and holes.** The peg is an octagon (a square with its corners cut).
  The hole is the same polygon offset outward by half the tolerance along every
  edge, so the clearance is the tolerance on every flat and corner cut. A round
  hole's clearance ballooned at the flats while it pinched the peg at its
  corners (#143). The flats face ±X and ±Y so the peg lies on a wide flat in its
  print pose. The hole's circular bound (its farthest corner) is what the pads
  use, so the pad covers the whole octagon and not just its flats.
- **Layout.** The board repeats its pattern, so only the vector between two
  clips must be a lattice vector: the plate is centred on its own origin and
  slid along the board until the holes line up. Candidate positions are
  checked in the rotated up/side frame against the true outline, never against
  an axis-aligned box. A row away from the centre needs the outline's actual
  crossing at that height, which the single-ray radius of the keyhole layout
  does not give. Each peg hole sits at the middle of its own side's annulus
  (a triangle is much shorter from the centre to a flat than to the opposite
  corner), on the side axis, or on the up axis if the channel is in the way.
  The flange margin grows by bisection over the real clip count, because a
  clip's footprint also extends along "up", where that single-ray radius is
  not exact.

- Grid pitch: 28 x 28 mm (`OPENGRID_PITCH`). This is stated in the
  [openGrid docs](https://github.com/openGrid-3D/openGrid-docs) (`board.mdx`):
  "The board system uses a 28x28mm grid pattern."
- Board thickness: 6.8 mm for the full board and 4 mm for the Lite board. The
  plate does not use these yet.
- The connector (the snap that clicks into a board hole) is not published as
  plain dimensions. Only STL, STEP and parametric OpenSCAD source exist
  ([mitufy/opengrid-projects](https://github.com/mitufy/opengrid-projects)).
  The system is CC-BY and the generator models are CC-BY-SA, so copying a
  generated shape would need a licence review.
- The placeholder is a plain 14 mm square push-fit peg, 5 mm long
  (`OPENGRID_PLACEHOLDER_PEG_SIZE`, `OPENGRID_PLACEHOLDER_PEG_REACH`). It is
  not the real snap.

To finish openGrid: reimplement the snap from measurements of a real board or
from the published source, then un-hide it.
