# SKÅDIS mount: audit, research and redesign options (issue #207)

Status: the research behind the SKÅDIS mount redesign. Outcome: the rim
clips (option C below, with the latch on by default) replaced the clip plate
(issue #207); a T-clip variant after the CC BY Skadis T-Clip System follows
as a second mount type. The numbers marked "estimate" come from simple beam
theory, not from a printed test.

## 1. Audit of the current design

### 1.1 Layout

The code is in `src/core/mountPlate.ts` (`layoutMountPlate`, `mountPlateLayoutFor`)
and `src/core/constants.ts` (`SKADIS_*`, `MOUNT_PLATE_*`).

- The plate is the flange outline inset by 3 mm: a solid 3 mm disc, square or
  triangle, that also covers the bore.
- Clips go on a plain 40 mm grid. The columns are at side = ±20, ±60, ±100
  and so on, and the rows at up = 0, ±40, ±80, at most 4 positions per side.
  Every position whose 11 x 5.8 mm footprint fits inside the plate gets a
  clip pair.
- The clip count therefore follows the plate area, which means the flange
  size. It does not follow the coil's weight. The flange grows with the
  cable stack, the inner-end bend and the cap clip, so a core of the same
  size can get 2 clips or 12.
- Exactly 2 pegs, always. They sit on one axis through the centre, at the
  middle of the flange ring: the side axis (up = 0), or the up axis if the
  side axis would hit the inner-end channel.

Measured from `design()` (round cores unless noted; L = cable length,
d = cable diameter; the plate is the solid disc):

| Core (outer) | Cable, layers | Plate | Clips | Rows (up) | Columns (side) | Pegs |
|---|---|---|---|---|---|---|
| 60 | 2 m, 3.8 mm, 1 | 78 mm | 2 | 0 | ±20 | 2 |
| 85 | 2 m, 3.8 mm, 1 | 100 mm | 2 | 0 | ±20 | 2 |
| 100 | 2 m, 3.8 mm, 1 | 114 mm | 6 | 0, ±40 | ±20 | 2 |
| 120 | 2 m, 3.8 mm, 1 | 133 mm | 8 | 0, ±40 | ±20, ±60 (row 0 only) | 2 |
| 200 | 2 m, 3.8 mm, auto | 210 mm | 18 | 0, ±40, ±80 | up to ±100 | 2 |
| 60 | 5 m, 6 mm, 3 | 108 mm | 6 | 0, ±40 | ±20 | 2 |
| 85 | 5 m, 6 mm, 3 | 133 mm | 8 | 0, ±40 | ±20, ±60 | 2 |
| 85 | 10 m, 8 mm, 4 | 161 mm | 12 | 0, ±40 | ±20, ±60 | 2 |
| 120 | 10 m, 8 mm, 4 | 196 mm | 16 | 0, ±40, ±80 | ±20, ±60 | 2 |
| square 85, rc 10 | 2 m, 3.8 mm, auto | 116 mm | 6 | 0, ±40 | ±20 | 2 |
| triangle 120, rc 10 | 2 m, 3.8 mm, auto | 173 x 194 mm | 12 | +40 to -80 | ±20, ±60 | 2 |

Two problems are visible:

- **Small plates hang on one row through the centre.** With 2 clips at
  up = 0, the upper half of the plate has nothing holding it to the board.
- **Large plates have many clips but still only 2 pegs.** Each clip is a
  separate snap that must line up with a slot within 0.2 mm. On a 200 mm
  plate, 18 snaps have to line up and flex at the same time.

### 1.2 Print orientation

| Part | Pose | Layers relative to the load |
|---|---|---|
| Plate with clips | Back face up, clips pointing up (`rotateX: π`) | The clip legs are towers 7.8 mm tall, built across their length |
| Core | Flange down | The flange is a 3 mm plate (#122), with pads only around cuts |
| Pegs | Lying on a flat (`rotateX: π/2`) | Along the peg. This is the right choice |

### 1.3 Load path

The coil hangs with its centre of mass about 30 mm (light) to 50 mm (heavy)
out from the board face. Rough loads:

- **Light**, round 85 with 2 m of USB cable: about 0.1 kg.
- **Heavy**, 10 m of 3-core flex cable: about 1.4 kg.
- **Unwinding** adds a pull, mostly along the board and partly straight out
  from it. Assume 20 to 50 N for a stuck cable.

The load runs this way:

1. Coil → flange → glue film on the flange ring → plate. The plate is glued
   only on the ring, between the bore and its edge. That ring is about
   2,500 mm² (60 mm core), 2,950 mm² (85) and 3,700 mm² (120).
2. Plate → clips. The weight is carried where each leg's bottom corner rests
   on the bottom of its slot. The tipping moment (weight × offset) and any
   outward pull load the top clips in pull-out, and the plate's lower edge
   presses on the board.
3. Clips → board. The legs bear on the slot bottom, and the barbs sit behind
   the board.

### 1.4 Weak points (the likely failure planes)

1. **The clip leg root, where it meets the plate. Layer lines cross every
   load here.**
   - A leg is 1.4 mm thick, about 6.1 mm free to the barb, and 11 mm long.
   - To pass a 4.8 mm slot, each barb flexes 0.5 mm. That is a bending
     strain of about 2.8 % at the root (estimate: 3tδ/2L²), right at the
     interface to the plate, with no fillet. This strain runs across the
     layers. Even along the layers, PLA yields at roughly 2 to 4 %.
   - The insertion force is high (estimate, E = 3.5 GPa): about 60 N to flex
     one leg, so 100 to 200 N to push one clip home through the 45° faces.
     An 8-clip plate would need a push of about 1 kN or more. In practice
     the plate is likely to crack legs, or not go on at all.
   - **This needs a print test to confirm.**
2. **The barb.** Its retaining face is also 45°, so pull-out works like
   insertion in reverse. Retention depends on the leg spring, the same
   cross-layer root as above.
3. **The plate-to-coil joint.**
   - Each peg is a 3 mm octagon (8.5 mm² of shear area) in a clearance hole.
     It locates the plate and carries some shear.
   - The pegs carry no pull-out load at all.
   - Both pegs sit on the line through the centre, so they give no lever
     against tipping.
   - The joint is really the glue film. In shear it is strong (CA glue on
     PLA bed faces). Against peel, which is the tipping mode, it is weak.
   - Without good glue, nothing holds the top of the flange to the plate.
   - The pegs look like the joint, but they do not carry the load.
4. **The single centre row on small plates.** On 60 to 85 mm cores with
   1 layer, the lever against tipping is only the plate radius (about 40 to
   50 mm). Clips in the top row would roughly double it.

The audit's screenshots (round 60, 85 and 120; round 85 with 5 m of 6 mm
cable on 3 layers; square 85; each in the mount-side and print-layout views)
are in the issue #207 discussion.

## 2. Research: printable SKÅDIS hooks and clips

How the licences were checked:

- **GitHub:** read from the repository's licence file or the GitHub API.
- **Printables:** read from the model's licence field in the Printables
  API. The make counts, ratings and comments come from the same source.
- **Thingiverse and MakerWorld** pages could not be opened. Their licences
  are marked unverified.

Verdicts under MIT:

- CC0, public domain or MIT: yes, with credit.
- CC BY: yes, with attribution.
- NC, ND, SA, GPL, no licence, or unverified: ideas only.

The make counts, ratings and likes in the evidence column were read on
2026-10-01.

| Design | Licence | Print pose / supports | Engagement | Resists | Evidence | Under MIT |
|---|---|---|---|---|---|---|
| [Skadis T-Nuts](https://www.printables.com/model/228663) (6d6178) | **CC BY** (verified) | Pre-rotated, no supports; 3 perimeters; "a material with great layer adhesion" | Lemon-shaped printed T-nut turns 90° behind the board as an M2/M2.5 screw tightens. Small stadium alignment guides on the part | Weight **and pull-out**: the part is clamped to the board | 95 makes, 4.93 ★ (89), 3,404 likes, "over 450" compatible models. The description says integrated hooks "often easily break due to unfortunate layer orientation". [ORM's M3 variant](https://www.printables.com/model/450444) (CC BY-NC) held almost 5 kg for a month | Yes, with attribution |
| [Skadis T-Clip System](https://www.printables.com/model/256896) (Line Arc Line) | **CC BY** (verified) | Load-bearing parts "print in the optimal orientation"; 45° side walls so it can also print upright | Printed T-clip, twisted 90° behind the board; a 28 mm round receiver in a 5.4 mm back plate | Weight **and pull-out** | 132 makes, 4.99 ★ (113), 3,379 likes. Comments: "*the* way to attach 3D prints to SKADIS", "snug and strong", "a little tight". It needs ≥ 2 clips per part. Two clip sizes for 4.82 and 5.23 mm boards. The [Wazalop remix](https://www.printables.com/model/637795) (CC BY-SA) found 2 kg fine and 4 kg "on the limit of breaking", and advises ≤ 1.5 to 2 kg per hook | Yes, with attribution |
| [IKEA SKÅDIS / SKADIS Hooks](https://www.printables.com/model/300265) (Kilian) | **CC BY** (verified) | **Lying on the side**, all perimeters, 0.1 mm layers; supports for the round fillets | Two-slot L-hook that snaps into the lower slot; "require something to push on them in order to let go" | Weight **and lift** | 193 makes, 4.88 ★ (153). "Don't run the risk of popping off"; "be mindful [removing them] or else you'll probably snap them"; "One snapped not sure why" | Yes, with attribution |
| [Skadis Hook (Straight Line)](https://www.printables.com/model/105081) | **CC0** (verified) | Flat; PETG or ASA recommended | Plain straight hook | Weight | 1 make. "PLA and 50% infill... sturdy enough" | Yes, with credit |
| [Tray with T-Clip lock](https://www.printables.com/model/1021854) (Odian) | **CC BY** (verified) | Not stated | Uses the T-Clip | Weight, pull-out | 12 makes, 4.90 ★. "Hard to turn the T-clips with such a small space" | Yes, with attribution |
| [Skadisgen](https://www.printables.com/model/1546768) / [tohaimate/skadisgen](https://github.com/tohaimate/skadisgen) | **CC BY** (Printables, verified) / **Apache-2.0** (GitHub, verified) | Selectable | Generated pegs: snug, normal or loose | Weight | Made because hooks "snap off". Snug is "only recommended for models with a few pegs"; loose is "recommended for models with many pegs" | Yes, with credit |
| [loic-daigle/fusion-skadis-mount](https://github.com/loic-daigle/fusion-skadis-mount) | **MIT** (verified) | Not stated | L-hook: tab 4 x 5 x 5 mm, lip 2.5 mm thick reaching 8 mm down, tab + lip 13 mm | Weight | 1 star. The vertical hook is "not tested yet" | Yes, with credit |
| [ciawhatsthat/yasg](https://github.com/ciawhatsthat/yasg) | **MIT** (verified) | Not applicable | Generator, a source of slot facts | Not applicable | Not applicable | Yes (facts) |
| [nmattia/skapa](https://github.com/nmattia/skapa) / [Printables 1133217](https://www.printables.com/model/1133217) (our clip's origin) | GitHub: **no licence**; Printables: **CC BY-NC** (both verified) | Printed with the box, no supports | Spring clasp, printed upright | Weight; pull-out through the clasp | 5 makes. A comment on the 45° version: "can't say anything regarding the sturdiness yet". [Issue #33](https://github.com/nmattia/skapa/issues/33) asks for hooks instead of clasps | Ideas only |
| [Skadis Ultimount](https://www.printables.com/model/376207) (davidmakes) | **CC BY-SA** (verified) | Upright, zero supports; "very strong in the vertical direction" | A hook that clicks to lock; push down to remove | Weight, anti-lift | 35 makes, 5.0 ★ (32) | Ideas only |
| [Lock plugs and secure hooks](https://www.printables.com/model/52120) | **CC BY-NC-SA** (verified) | Hooks on their side; plugs upside down, perimeters only | A plug fills the slot above the hook | Anti-lift | 22 makes, 4.90 ★ | Ideas only |
| [IKEA Skadis Hook](https://www.printables.com/model/129018) (Fabber) | **CC BY-NC** (verified) | 0.2 mm, no supports | Simple L-hook; scale the width for fit | Weight | 145 makes, 4.94 ★. Fit "a tad bit loose" for one maker, "a bit tight" for another | Ideas only |
| [Hooks for Skadis](https://www.printables.com/model/632146) (ORM) | **CC BY-NC** (verified) | On their side | M3 T-nut | Weight, pull-out | 9 makes, 5.0 ★ | Ideas only |
| [Lockable plate, two hooks](https://www.printables.com/model/436445) | **CC BY-NC-SA** (verified) | Plate with the lock up; hooks "strongest when printed on their sides", glued on | 2 hooks plus a lock | Weight, lift | 0 makes | Ideas only |
| [Sturdy removable hooks](https://www.printables.com/model/174352) | **CC BY-NC-SA** (verified) | Not stated | Two slots: a springy upper hook drops in; a "stone" stiffens the spring | Weight, lift | 1 make | Ideas only |
| [Parametric hook system](https://www.printables.com/model/280270) | **CC BY-NC** (verified) | Hooks printed flat, glued to the part | L-hooks | Weight | 4 makes | Ideas only |
| [franpoli/OpenSCADutil](https://github.com/franpoli/OpenSCADutil) / [Printables 37835](https://www.printables.com/model/37835) | **GPL-3.0** (verified) | Not stated | L-peg with an optional retainer | Weight, a little lift | 15 makes, 4.88 ★ | Ideas only |
| [florianfesti/boxes](https://github.com/florianfesti/boxes) | **GPL-3.0** (verified) | Laser-cut | Hooks every 40 mm | Weight | Board 5.1 mm | Ideas only |
| [oisin/openscads](https://github.com/oisin/openscads), [legna-namor/IKEA-Skadis-Peg](https://github.com/legna-namor/IKEA-Skadis-Peg), [mayjs/skadis_tnut_openscad](https://github.com/mayjs/skadis_tnut_openscad) | **No licence** (verified) | Not stated | L-hook, peg, T-nut helper | Weight | Few stars | Ideas only |
| CSD_Salzburg hooks (Thingiverse 2853257); phrxmd customizer (Thingiverse 5204546) | Unverified (reportedly CC BY-NC) | Lying on the side | Tight-fit L-hooks | Weight | Thingiverse could not be opened | Ideas only |
| MakerWorld 644648, 2416233, 2419729, 2416268 | Unverified | 2419729: "print flat", on its side | L-hooks, 4.5 to 5 mm wide | Weight | MakerWorld could not be opened | Ideas only |

### 2.1 IKEA reference facts

- IKEA publishes no drawing and no load rating, for the board or for the
  [hook](https://www.ikea.com/us/en/p/skadis-hook-white-20320802/). The hook
  is powder-coated steel, 1" deep and 2¼" high.
- The hook has a 4.5 ★ rating from 593 reviews, and the reviews repeat one
  complaint. Quotes:
  - "the hook easily falls out of the peg board if you push/pull upwards on
    the hook at all";
  - "Now they just pop out".
- A cable that is pulled while unwinding pushes the coil exactly this way,
  so **anti-lift matters for us**.
- The board is painted fibreboard. The T-Clip listing measured 4.82 mm
  (unpainted) and 5.23 mm (painted). The T-Nut listing gives:
  - slots 5 x 15 mm, R2.5 ends, with a **1 mm fillet** on the slot edges;
  - the board stands about 20 mm off the wall.

  All of this agrees with `docs/mounts.md`. The 1 mm fillet is new: it
  gives a little extra lead-in.

### 2.2 Strength data (FDM)

- **CNC Kitchen, PLA on 0.2 mm layers**
  ([source](https://www.cnckitchen.com/blog/stop-printing-flat-the-45-secret-for-stronger-parts)):
  63 MPa printed flat, 31 MPa standing (across the layers), 40 MPa at 45°.
- **Prusament PLA datasheet:** 50.8 MPa (XY) vs 37.6 MPa (Z), and
  17 ± 3 MPa interlayer adhesion
  ([TDS](https://prusament.com/wp-content/uploads/2022/10/PLA_Prusament_TDS_2021_10_EN.pdf)).
  These numbers come from a search summary; the PDF could not be opened.

### 2.3 Patterns the well-reviewed designs share

1. **The load-bearing part prints lying on its side**, or is a separate
   part in its best pose, so the loads run along the layers. The top
   designs (T-Nut, T-Clip, Kilian) do this. The T-Nut page explains why:
   integrated hooks "often easily break due to unfortunate layer
   orientation".
2. **Something positive stops lift and pull-out:** a twist lock (T-Clip,
   T-Nut), a snap into a second slot (Kilian), or a plug (52120). Plain
   L-hooks only carry weight. IKEA's own hook is the counter-example.
3. **Two or more slots per part.** T-Clip requires it.
4. **Few, firm connections beat many snug ones.** Skadisgen advises snug
   pegs only "for models with a few pegs". This supports fewer clips.
5. Hooks are 4.5 to 5 mm wide, and the lip behind the board is about 2.5 to
   3 mm thick. Fit varies by printer and by board, so the popular designs
   offer tight and loose variants (T-Clip, 52120, skadisgen).

## 3. Redesign options

All three options:

- put clips only at the top and bottom;
- keep every clip-to-clip vector on one of the board's two 40 mm grids;
- keep every part one solid with no overhang past 45° and no bridge over
  4 mm.

### Option A: re-place and stiffen (the smallest change)

**Clips.** 4 integrated clips: 2 in the highest row that fits (±20) and 2 in
the lowest. A plate over about 160 mm adds ±60 in the top row, for 6.

**Hook.** Replace the spring pair with one solid stem, 4.4 x 6 mm, with a
tongue behind the board. You push it in and it drops down; nothing flexes.
The plate still prints back-face up, so the tongue's retaining face must
slope at 45°. A 45° face cams under a pull, so it lifts the plate rather
than locking it.

**Joint.**
- 4 pegs instead of 2, at the top, bottom and both sides, 4 mm where the
  ring allows. The top and bottom pegs then give a lever against tipping.
- Glue is still required.

**Printability.** As today: the stem root gets a 45° fillet and the plate
keeps one solid.

**Trade-offs.**
- The least code: the same parts and the same assembly.
- The hook is still loaded across its layers. There is no flex any more,
  and the root area grows from 2 x 15 to 26 mm².
- The joint still depends on glue.

### Option B: side-printed hooks set into a flat plate

**Clips.** The same top-row and bottom-row rule as A: 2 hooks at the top and
2 at the bottom.

**Hook.**
- Each hook is a separate flat profile, 4.4 mm thick, printed lying on its
  side. It has a foot, a stem and a square tongue behind the board.
- The plate has no protrusions any more, so it prints front face up. Each
  hook goes through a window in the plate, and its foot sits in an open
  pocket in the front face.
- Gluing the core on traps the feet. A pull-out load presses each foot onto
  the plate (bearing), not on a layer bond.

**Joint.** 4 pegs (up to 8 on big plates) plus glue. The hook feet add
keys against shear.

**Printability.**
- The hooks are 2.5D extrusions lying flat, so they have no overhangs at
  all.
- The plate's pockets open upward, so it needs no bridges.

**Trade-offs.**
- The hooks become strong along the layers, and the plate stays familiar.
- There are more parts (plate, 4 hooks, 4 or more pegs).
- The peel load on the glue film is unchanged.

### Option C: rim clips, no plate (recommended)

Sketches of this option (a section through the axis, the front layout, and
the old clip for comparison) are in the issue #207 discussion.

**Clips.**
- 3 clips: 1 at the top (column 0) and 2 at the bottom (columns ±20, or ±60
  on wide flanges).
- 4 clips (2 + 2) on heavy coils, by a cable-weight estimate.
- The count follows the load, not the area. The top row is any multiple of
  40 mm that is close to the top rim. The bottom pair sits 20 x odd mm
  below it, which keeps all three on the same grid.

**Hook.**
- Each clip is one flat profile, 4.4 mm thick, printed lying on its side.
  It has:
  - a tongue behind the board, 3 mm thick, reaching about 4.5 mm below the
    slot;
  - a 5 mm stem through the slot;
  - a 3 mm spine between the board and the flange's outer face;
  - a U that wraps the flange's 3 mm rim, with a 2 to 2.5 mm lip that
    overlaps the winding-side face by 5 mm.
- A small notch in the flange rim keys each clip. It fixes the coil's
  rotation and gives the bight a flat seat.
- **Anti-lift latch, on by default.** IKEA's hook reviews and the
  unwinding pull both lift the coil upward, so the top clip gets a latch: a
  spring finger in the clip's own plane. It flexes aside as the stem goes
  in, then springs into the empty top of the slot after the drop, so the
  clip can't lift. You press it to remove the coil. The same idea as
  Kilian's snap into a second slot (CC BY) and as 52120's lock plug (ideas
  only). It flexes along the layers, never across them.
- **Assembly:**
  1. Slide the clips onto the rim.
  2. Push all the stems into their slots.
  3. Let the coil drop about 6 mm until the latch clicks.
- Only the latch flexes. There is no glue and no plate.
- **Variant C-T, with hardware.** Replace the tongues with T-nut style twist
  nuts and an M2.5 screw through each clip, as in the CC BY Skadis T-Nuts
  (95 makes, 4.93 ★). It clamps the coil to the board with no play on 4 to
  5.2 mm boards. It needs screws and a screwdriver.

**Load path.**
- The weight goes from the rim into the bottom bights, then from the stems
  onto the slot bottoms.
- The tipping moment and any pull go from the winding face into the top
  lip, then from the tongue onto the back of the board.
- The lever against tipping is the whole flange height (about 2R), not the
  plate radius.
- Every clip load is in the plane of the layers. Estimate for a 30 N pull on
  the top clip: about 14 MPa in the tongue and 16 MPa in a 2.5 mm lip,
  against about 50 MPa for PLA along the layers.

**Joint.** The joint is the clip itself. The pegs, peg holes, peg pads and
`MIN_FLANGE_THICKNESS_FOR_PLATE` all go.

**Printability.**
- The clips are 2.5D extrusions lying flat, so they have no overhangs or
  bridges.
- The flange notches are 2D cuts in a flat plate.
- Each clip is one solid and a few grams.

**Trade-offs.**
- Gains:
  - Fewest parts, and glue-free.
  - Every load runs along the layers, with the biggest lever.
  - The clip count is independent of size.
  - Removable.
- Costs:
  - The most new code: a new part type and a new layout rule, the rim
    notches, and keeping the inner-end channel exit and its pad away from
    the clip angles.
  - The thin 3 mm flange rim carries the clip loads locally. It may need a
    pad at each notch.
  - The latch is the one flexing part. Its strain must be kept low (a long
    finger), and it needs a print test.
  - On a 4 mm board it rattles by about 1.5 mm, unless a spring bump is
    added. That bump would flex along the layers.
  - The coil stands 3 mm off the board only at the clips.

### Recommendation

**C.** It removes the parts the issue calls weak:

- the cross-layer clip roots;
- the many over-constrained snaps;
- the 2-peg, glue-only joint.

It does this with the pattern the best-reviewed community hooks share. The
top three on Printables (T-Nut, T-Clip, Kilian; 95 to 193 makes each, all
CC BY) all have:

- a load-bearing part printed in its strong pose;
- contact in two or more slots;
- a positive lock against lift.

The research retries did not change the choice. They added the anti-lift
latch as a default, and the T-nut variant as a hardware alternative.

**B** is the fallback if a flat plate behind the coil is wanted, for
example for openGrid later.

No third-party geometry is needed for C. The dimensions follow from the
board facts above, and the MIT `fusion-skadis-mount` agrees with them.

If C-T is chosen, the T-nut shape may be adapted from the CC BY Skadis
T-Nuts, with attribution in `THIRD_PARTY_NOTICES`, or redrawn from the
idea.

## 4. Test changes (for C)

### `test/skadisFit.test.ts`

The board is built from the facts only, as today: slots of 4.8 x 14.8 and
5 x 15 mm, and boards 4, 5 and 5.2 mm thick. The new checks:

- In the raised pose, every stem passes its slot without touching it.
- After the drop:
  - each stem rests on its slot bottom;
  - each tongue overlaps the back of the board by at least 4 mm;
  - a pull out from the board meets the tongue within the board's play;
  - a lift smaller than the drop keeps every clip engaged;
  - with the latch sprung, a lift of 1 mm hits the latch (it can't come
    off);
  - with the latch pressed, the coil lifts out.
- The clip-to-clip vectors are on the lattice (kept from today's test).
- The flange rim:
  - sits on the bottom bights;
  - meets the top lip's overlap;
  - leaves the lip clear of the wound cable envelope.

### `test/printability.test.ts` (or a new clip test)

- Each clip is `decompose().length === 1`.
- In its print pose, each clip has only vertical faces and bed faces.
- The clips fit the bed.
- The notched flange still passes the existing overhang checks.

### Other tests

- **Latch strain:** the latch's bending strain on insertion is at most 1.5 %
  (a geometry check on the clip mesh).
- **Clip count rule:** 3 by default, and 4 on heavy coils, for round,
  square and triangle at 60 to 200 mm.
- **`test/mountPegs.test.ts`, `test/mountPlate.test.ts`:** retire the
  SKÅDIS parts. Keep the openGrid plate path only if that path stays.
- **e2e:** re-baseline the mount-side, wall-room and print-layout
  screenshots, and look at the clips' line art.
- **Hash:** no new field. `mount: "skadis"` keeps its meaning, so old links
  get the new geometry.

## 5. Open questions

1. Option C (no plate), B (plate plus side-printed hooks), or A (minimal)?
2. Anti-lift: a spring latch on the top clip (my default), a separate
   printed plug for the slot above, or none (like IKEA hooks)?
3. Hardware: fully printed C, or C-T with M2.5 screws and T-nuts (no play,
   strongest hold, needs a screwdriver)?
4. Clip count: always 3, always 4, or 3 or 4 by a cable-weight estimate?
5. Board thickness: one clip for 4 to 5.2 mm with play, or a fit setting
   (4.8 wood / 5.2 painted)?
6. openGrid: keep the plate code path for the hidden placeholder (#38), or
   remove it with the SKÅDIS plate?
