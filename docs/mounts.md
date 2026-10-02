# Wall mounts

The coil axis points out of the wall. The bottom flange's outer face is against
the wall, and every mount feature is on that face. The mount is semi-permanent.
Multiboard is not supported.

| Mount | What it is | Status |
|---|---|---|
| Screw keyhole | A pocket recessed into the flange's outer face | Tested in geometry only |
| Through holes | Plain screw holes through the flange | Tested in geometry only |
| IKEA SKÅDIS rim clips | Separate clips that hook the board and grip the flange's rim | Not test-fitted on a physical board |
| IKEA SKÅDIS T-clips | Twist-lock clips through lugs on the flange's rim (after the CC BY 4.0 Skadis T-Clip System) | Not test-fitted on a physical board |
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
  and no pad. The screw head bears on the flange's winding-side face. The
  diameter is a setting (2.5 to 8 mm, 4.5 mm by default). Holes sit near the
  corners of a square or triangle flange and are evenly spaced on a round one.
  Each hole stays clear of the wound cable so a screwdriver can reach it.
  Every screw head (the hole plus a 2 mm bearing ring) also keeps 0.5 mm of
  plain plate between it and the thickened pads of the flange, such as the
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
- **Print orientation.** Each clip prints lying on its flat face, so the
  weight, a pull and the tongue's bending all run along the layers. It has
  no overhangs or bridges. The old plate's clip legs were printed upright
  and flexed across the layers.
- **The flange.** A flat-floored notch at each clip keys the coil's rotation.
  The flange is full thickness under each clip's jaws (a pad), and the lips
  keep 1 mm clear of the wound cable. The flange margin grows if they don't
  fit.
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

A second SKÅDIS mount type (`mount: "skadis-tclip"`, issue #213): twist-lock
clips that clamp the flange flat to the board. `src/core/skadisTclips.ts`
lays them out for both geometry backends.

**Credit.** Adapted from the
[Skadis T-Clip System](https://www.printables.com/model/256896) by Line Arc
Line, licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
(checked through the Printables API: CC BY 4.0 International, remixing and
commercial use allowed). We took the mechanism: a T that goes through the
slot upright and turns a quarter turn to lock behind the board, at least two
per part. Modified: the clip is re-implemented parametrically with our own
dimensions (none of the original's files or geometry are used). The receiver
is our own lug on the flange, not the original's round clip seat. The same
credit is in `public/THIRD_PARTY_NOTICES.txt` ("Designs").

- **The clip.** One flat "I" profile, 4 mm thick, printed lying on its face,
  so the clamp, the weight and the bars' bending run along the layers.
  - A handle, 18 x 5 mm.
  - A 2 x 4 mm stem: its diagonal (4.5 mm) turns inside even a 4.8 mm slot.
  - A T bar, 12.2 x 3 mm. It passes the tightest slot's 12.65 mm of full
    width, and overlaps the board by 3.7 mm a side once turned.
  - The gap between the handle's and the T bar's bearing faces is the lug's
    floor plus 5.2 mm. That is tight on a painted 5.23 mm board, and leaves
    about 0.4 mm of play on an unpainted 4.82 mm one.
- **The lug.** A round-ended pad on the flange's rim at each clip, full
  thickness.
  - A slot through it, centred on the clip, lets the T bar pass and the
    stem turn.
  - A 2 mm recess in its face holds the handle. Its walls stop the handle
    upright and at a quarter turn clockwise (seen from the room). Turned,
    the handle sits in the recess's across arm, whose upper edge rests on
    it: that carries the coil.
  - The lugs reach out past the wound cable, so the flange's own margin
    doesn't grow; the flange is at least 5 mm thick, for the recess's floor.
- **How many, and where.** As for the rim clips: 1 top and 2 bottom, 2 + 2
  above 0.5 kg of cable, every slot on one of the board's two 40 mm grids,
  and fallbacks when the inner-end channel is in the way. The top clip is
  lifted by half the bottom clips' slack on the 40 mm grid, so the lugs at
  both ends stay short.
- **Fitting.**
  1. Hold the coil flat on the board, each lug's slot over a board slot.
  2. Push each clip in with its handle upright: the T bar passes at the
     slot's centre.
  3. Turn the clip a quarter turn clockwise until it stops.
  4. Let go. The coil and its clips drop together about 5.3 mm, until the
     stems rest on the bottoms of the slots.

  To take the coil down, lift it back to the slots' centres and turn the
  clips back. Turned back while dropped, a clip can't come out: its T bar
  is below the slot.

`test/skadisFit.test.ts` checks the T-clips against the same fact-built
boards as the rim clips. It checks that:

- the clips are on the lattice;
- each clip passes upright through its lug and the board's slot;
- each clip turns a quarter turn without touching either, and the recess
  stops it beyond that;
- turned and dropped, it clears both, and turned back while dropped it is
  stuck;
- the stem bears on the slot's bottom and the handle carries the lug;
- the T bar catches the back of the board;
- every clip prints flat with only vertical faces.

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
