# Wall mounts

The coil axis points out of the wall. The bottom flange's outer face is against
the wall, and every mount feature is on that face. The mount is semi-permanent.
Multiboard is not supported.

| Mount | What it is | Status |
|---|---|---|
| Screw keyhole | A pocket recessed into the flange's outer face | Tested in geometry only |
| Through holes | Plain screw holes through the flange | Tested in geometry only |
| IKEA SKÅDIS rim clips | Separate clips that hook the board and grip the flange's rim | Not test-fitted on a physical board |
| IKEA SKÅDIS T-clips | Twist-lock clips through slots in the core's floor, turned by tall fins (after the CC BY 4.0 Skadis T-Clip System) | Not test-fitted on a physical board |
| openGrid | A separate plate glued to the flange, with a placeholder connector | Not usable: hidden in the UI and rejected in links |

coil3d is not affiliated with IKEA. SKÅDIS is an IKEA product name.

## Screw mounts

- **Keyhole.** A narrow, shallow slot at the wall-facing surface holds the
  screw shank. Behind it, a deeper and wider chamber lets the screw head
  travel. The head therefore stays captured, not just wedged. The slot can be
  rotated by 0 or 45 degrees away from vertical; the mount axis stays level
  at every setting. Sized for a common wood screw (head about 8 mm, shank
  about 4 mm). A tolerance-checked 2 mm of flange is kept around the cut.
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
  warns, so a triangle with a 6-8 mm cable can end up with 2 holes. This mount
  is permanent.

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
- **Chamfers.** The clip's outer corners (the jaw and lip tips, the spine's
  top and the stem's back) are cut at 45°, 0.5 mm, so they are not sharp to
  handle. The hook faces, the latch, the jaw faces and the stem are as before.
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
bore, not the original's round clip seat, and the handle is a tall fin. The
same credit is in `public/THIRD_PARTY_NOTICES.txt` ("Designs").

- **The clip.** One flat "I" profile, 4 mm thick, printed lying on its face,
  so the clamp, the weight and the bars' bending run along the layers.
  - A fin handle, 18 mm wide (see "Reaching the fins").
  - A 2 x 4 mm stem with 0.5 mm chamfered corners: its diagonal (about
    4.1 mm) turns inside even a 4.8 mm slot.
  - A T bar, 12.2 x 3 mm. It passes the tightest slot's 12.65 mm of full
    width, and overlaps the board by 3.7 mm a side once turned. Its bearing
    face ramps down 0.7 mm over its last 1.2 mm at both ends (the original's
    hook ramps), so the bar rides onto the back of the board as it turns.
  - Every edge is chamfered 0.6 mm, the faces' edges too (45°, so the
    bed-side ones print).
  - The gap between the fin's and the T bar's bearing faces is the floor
    under the recess plus 5.2 mm. That is tight on a painted 5.23 mm board,
    and leaves about 0.4 mm of play on an unpainted 4.82 mm one. There is
    one clamp length.
- **The floor.** The bore's bottom is filled from the flange's wall face up
  to its winding face (at least 5 mm thick), one solid with the core and
  printed on the bed.
  - A slot through it at each clip lets the T bar pass and the stem turn.
  - A 2 mm recess in its top holds the fin's foot. Its walls stop the fin
    upright and at a quarter turn clockwise (seen from the room). Turned,
    the fin sits in the recess's across arm, whose upper edge rests on it:
    that carries the coil.
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
    rim clips.

  For 2 m of 3.8 mm cable: round 40-50 mm gets 1 clip, 60 mm gets 2, and
  70 mm and up gets 3; square 60 mm gets 2; triangle 50 mm gets 1.
- **Reaching the fins.** You reach through the core (and the cap's hole) and
  pinch the fin's top.
  - A fin rises to 1 mm below the wall's top (with a cap, below the cap's
    collar), up to 60 mm above its recess.
  - In a bore under 50 mm across, where no hand fits, it always rises to the
    top.
  - A fin top more than 65 mm below the core's top gets a note.
  - Fins turn in their own 9.5 mm circles, and slots are at least 28 mm
    apart, so they never touch each other or the wall.
- **Fitting.**
  1. Hold the coil flat on the board, each slot in the core's floor over a
     board slot.
  2. Reach through the core and push each clip in with its fin upright: the
     T bar passes at the slot's centre.
  3. Pinch the fin and turn the clip a quarter turn clockwise until it stops.
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
