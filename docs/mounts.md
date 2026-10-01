# Wall mounts

The coil axis points out of the wall. The bottom flange's outer face is against
the wall, and every mount feature is on that face. The mount is semi-permanent.
Multiboard is not supported.

| Mount | What it is | Status |
|---|---|---|
| Screw keyhole | A pocket recessed into the flange's outer face | Tested in geometry only |
| Through holes | Plain screw holes through the flange | Tested in geometry only |
| IKEA SKÅDIS | A separate clip plate, glued to the flange | Not test-fitted on a physical board |
| openGrid | Same plate, with a placeholder connector | Not usable: hidden in the UI and rejected in links |

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
| Board thickness | About 5 mm. 5.1 mm in [florianfesti/boxes](https://github.com/florianfesti/boxes/blob/master/boxes/walledges.py) and the `.scad`. Some boards are 4 mm, some up to 5.2 mm | [Printables: Skadis Thickness Testers](https://www.printables.com/model/271676-skadis-thickness-testers) and hook listings |

The constants are in `src/core/constants.ts` (`SKADIS_*`).

### The clip plate

The plate is a flat panel, inset from the flange outline by a fixed margin, so
it always fits inside the flange for every shape. It is a separate part so the
core prints flat with no clips. The clips sit on one plain 40 x 40 mm grid, in
columns at 20 and 60 mm from the centre, so the layout stays mirrored and a
100 mm core still fits two or more columns. The grid is placed on the same
axis the keyhole mount uses, so a non-round core hangs level. At least two
clip columns must fit, or the app warns.

Each position has one mirrored, spring-loaded pair of legs.

- The legs are 4.4 mm across at rest (0.2 mm of clearance per side in the
  tightest 4.8 mm slot), 1.4 mm thick, with a 1.6 mm gap to flex into.
- The barb's retaining face starts 5.4 mm out, so it sits behind boards up to
  5.2 mm thick. It is 5.8 mm across, 0.5 mm wider than the slot per side.
- Every face is vertical or a 45-degree slope, and the plate prints back-face
  up, so it needs no supports. The clip is 11 mm long along the vertical axis,
  short enough to clear the rounded ends of a 14.8 mm slot.
- Only the root is embedded into the plate.

The clip technique comes from [nmattia/skapa](https://github.com/nmattia/skapa),
which has no licence. Only the idea and the measurements were used. The shape
and dimensions are our own, and the code is not copied.

How it engages (checked in `test/skadisFit.test.ts` on the real plate mesh,
against a board built only from the facts above, for round, square and
triangle cores, 4.8 x 14.8 and 5 x 15 mm slots, and 4, 5 and 5.2 mm boards):
push the plate flat against the board. Each leg pair squeezes through its slot
and the barbs spring out behind the board. Let go, and the plate drops about
0.5 to 0.7 mm until each leg's bottom corner rests on the bottom of the slot,
which carries the weight. Seated, nothing else touches the board. If it is
pulled off, the barbs catch the back of the board within 0.7 mm of play on the
thickest board.

**This has not been test-fitted on a physical board.** The geometry tests do
not show that a printed spring clip grips, or that the thickness assumption
holds on every board.

### Plate and flange joint

Neither mating face can carry a protrusion without supports (the plate prints
back-face up and the core prints flange-down). So both faces have matching
blind round holes, aligned with two small printed pegs (`peg-1`, `peg-2`),
and then glued.

- Each peg is a 3 mm square with its corners cut 0.5 mm at 45 degrees (an
  octagon whose corners all lie on a 1.8 mm circle), 4.5 mm long, with a 0.4 mm
  lead-in at both ends.
- It prints lying on a 2 mm flat. The layers then run along the peg, so the
  shear across the joint never splits a layer line.
- The holes stay round, 2.4 mm deep in each part. They are sized to the corner
  circle plus the print tolerance, so the peg goes in at any rotation.
- A hole pair needs 3.6 mm of flange ring plus 1 mm on each side, and stays
  3.3 mm clear of the inner-end channel.
- Old links with `pj=snap` still parse. They get the same glued plate and a
  warning, because snap tabs on the plate front cannot print without supports.

## openGrid

openGrid support is a placeholder. The core can build a plate for it, but it is
not reachable from the UI or from a link.

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
