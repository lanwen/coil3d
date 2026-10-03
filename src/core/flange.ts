// Shared, mesh-free flange sizing (issue #63, PR #59 review): design.ts
// needs these exact numbers to actually BUILD the flange; solve.ts's
// min-volume/aspect-ratio objectives need the SAME numbers to score search
// candidates by what actually ends up printed, not an internal proxy that
// silently omits the flange margin/thickness and any top cap (the bug this
// issue reports: the result panel's flange/height numbers didn't match the
// built parts). One shared module, so the two callers can never drift on
// what "the flange's real size" means -- the same convention design.ts's
// header already uses for `layoutKeyholeMount`/`layoutInnerEnd` (one pure
// function, called once per consumer).
//
// Every function here is a plain, closed-form analytic formula (at most one
// bounded bisection, in mount.ts's `requiredFlangeMargin`) -- never
// meshing -- so solve.ts's inner search loops (thousands of candidate
// evaluations across a solve()) can call these on every candidate for
// negligible cost.

import {
  CAP_THICKNESS,
  DEFAULT_THROUGH_HOLE_DIAMETER,
  FLANGE_MARGIN,
  FLANGE_PLATE_THICKNESS,
  FLANGE_THICKNESS,
  INNER_CHANNEL_MIN_SHELF,
  MIN_BORE_CORNER_RADIUS,
  MIN_BORE_RADIUS,
  MIN_FLANGE_THICKNESS_FOR_PLATE,
  MIN_FLANGE_THICKNESS_FOR_SCREW_MOUNT,
  MIN_FLANGE_THICKNESS_FOR_TCLIP,
  SCREW_MOUNT_RECESS_DEPTH,
} from "./constants";
import { idealChannelDepth, requiredInnerEndMargin, requiredRimSlotMargin, resolveChannelDepth } from "./innerEnd";
import { collarFootprintOffset } from "./flangePads";
import { requiredFlangeMargin, requiredThroughMountMargin } from "./mount";
import { requiredMountPlateMargin } from "./mountPlate";
import { requiredSkadisMargin } from "./skadisClips";
import { circumscribedRadius, inscribedRadius } from "./shapes";
import type { ShapeOutline } from "./shapes";
import type { FlangeExtent, MountKind } from "./types";
import { wallThickness } from "./wall";

/**
 * The bore outline for a given wall outline: a TRUE inward offset by the
 * wall thickness, floored so it never inverts (design.ts's own bore
 * construction, factored out verbatim so solve.ts's search can share it
 * without hand-deriving `boreOutline` per candidate; see
 * MIN_BORE_CORNER_RADIUS). `reduced` is true
 * when the apothem floor actually bit; design.ts turns that into a "too
 * small for a wall" warning, the search doesn't need the warning text.
 */
export function resolveBoreOutline(outline: ShapeOutline, wireDiameter: number): { boreOutline: ShapeOutline; reduced: boolean } {
  const wall = wallThickness(wireDiameter);
  let boreApothem = outline.apothem - wall;
  const reduced = boreApothem < MIN_BORE_RADIUS;
  if (reduced) boreApothem = MIN_BORE_RADIUS;
  // Round's defining invariant is apothem === cornerRadius (see shapes.ts);
  // preserve it explicitly, or a tiny core would get a very-slightly-square
  // bore instead of a circle once the two floors below bite differently.
  const isRound = outline.cornerRadius === outline.apothem;
  const boreCornerRadius = isRound ? boreApothem : Math.min(Math.max(outline.cornerRadius - wall, MIN_BORE_CORNER_RADIUS), boreApothem);
  return { boreOutline: { n: outline.n, apothem: boreApothem, cornerRadius: boreCornerRadius }, reduced };
}

export interface FlangeSizing {
  margin: number;
  /** The full thickness, on the pads (issue #122) -- the flange's overall thickness. */
  thickness: number;
  /** Issue #122: the plate's own thickness away from the pads (flangePads.ts). */
  plateThickness: number;
  /** The plain envelope-clearance margin, before any mount bump -- design.ts compares against this to decide whether to warn "margin increased ...". */
  baseMargin: number;
  /** The margin the requested mount alone needs (>= baseMargin). */
  mountMargin: number;
  /** The margin the inner-end lead-in alone needs (issue #115). */
  innerEndMargin: number;
  /** The margin the rim cable slot alone needs (issue #241): its seat clear of the base's collar pad. */
  rimSlotMargin: number;
  /** The wound cable's outer surface, as an offset outside the core's outline (the cable's lead-out under the cap runs just outside it). */
  envelopeOffset: number;
  /** The plain channel-driven thickness, before any mount/plate bump -- design.ts compares against this the same way. */
  channelOnlyThickness: number;
}

/**
 * The flange's real margin and thickness (design.ts's own derivation,
 * factored out verbatim -- see that file's history for why each floor
 * exists): wide enough to clear `flangeSizeEnvelope`'s own naive
 * wound-envelope estimate AND whatever the requested mount needs; thick
 * enough for the inner-end channel's full depth AND whatever the requested
 * mount/plate joint needs.
 */
export function resolveFlangeSizing(
  outline: ShapeOutline,
  boreOutline: ShapeOutline,
  flangeSizeEnvelope: number,
  wireDiameter: number,
  mount: MountKind,
  /** Issue #115: the inner-end lead-in needs room to reach the groove within the cable's bend radius (innerEnd.ts's `requiredInnerEndMargin`). */
  leadIn: { tolerance: number; bendRadius: number; heavyCable?: boolean },
  /** Issue #71: ignored unless `mount === "keyhole"`. */
  keyholeRotation = 0,
  /** Issue #70: ignored unless `mount === "through"`. */
  throughHoleDiameter = DEFAULT_THROUGH_HOLE_DIAMETER,
): FlangeSizing {
  const wantsKeyhole = mount === "keyhole";
  const wantsThrough = mount === "through";
  const mountKindForPlate = mount === "opengrid" ? mount : undefined;

  // circumscribedRadius(outline, margin) === circumscribedRadius(outline, 0) + margin
  // (the offset term is additive, see shapes.ts), so this margin is exactly
  // what's needed for the flange's own circumscribed radius to reach
  // flangeSizeEnvelope / 2.
  const baseMargin = Math.max(FLANGE_MARGIN, flangeSizeEnvelope / 2 - circumscribedRadius(outline, 0));
  // Issue #70 AC ("outside the winding envelope, so a screwdriver can reach
  // them"): `flangeSizeEnvelope` is already the wound envelope's own
  // diameter (plus a flat FLANGE_MARGIN pad, docs/design.md, Parts and
  // printing: flange size = final outer envelope + margin) -- reusing it directly as the through
  // mount's own envelope-clearance radius is a few mm more conservative than
  // the bare minimum (that pad), never less, so it's a safe stand-in with no
  // extra plumbing.
  // Issue #117: the wound cable's outer surface (FLANGE_MARGIN inside
  // `flangeSizeEnvelope`), as an offset outside the core's outline.
  const envelopeOffset = flangeSizeEnvelope / 2 - FLANGE_MARGIN - circumscribedRadius(outline, 0);
  const channelOnlyThickness = Math.max(FLANGE_THICKNESS, idealChannelDepth(wireDiameter) + INNER_CHANNEL_MIN_SHELF);
  const mountMargin = mount === "skadis"
    ? // Issue #207: the rim clips' lips must clear the wound cable (issue #222: and the collar's flare, which the lips on the plate sit beside).
      Math.max(baseMargin, requiredSkadisMargin(outline, boreOutline, envelopeOffset, leadIn.heavyCable ?? false, channelOnlyThickness, Math.min(FLANGE_PLATE_THICKNESS, channelOnlyThickness), leadIn.tolerance))
    : wantsKeyhole
    ? Math.max(baseMargin, requiredFlangeMargin(outline, boreOutline, keyholeRotation))
    : wantsThrough
      ? Math.max(baseMargin, requiredThroughMountMargin(outline, boreOutline, throughHoleDiameter, flangeSizeEnvelope / 2, collarFootprintOffset({ thickness: channelOnlyThickness, plateThickness: Math.min(FLANGE_PLATE_THICKNESS, channelOnlyThickness) })))
      : mountKindForPlate
        // Issue #120: openGrid used to just take `baseMargin` here,
        // so a plate whose fixed-pitch grid needs more room than the plain
        // wound-envelope clearance gives could be silently skipped (only a
        // warning to notice) -- this grows the margin exactly like the
        // other two mount kinds already do, so the plate is never dropped
        // just because the (often solver-picked) core came out small.
        ? Math.max(baseMargin, requiredMountPlateMargin(outline, boreOutline))
        : baseMargin;

  // Issue #122: the channel and the mount's cut sit on separate pads (the
  // keyhole on the wall face, the channel on the winding face; the pin-hole
  // layout keeps clear of the channel, and design.ts checks the keyhole), so
  // the thickness is the deeper of the two, not their sum. Away from the
  // pads the plate is FLANGE_PLATE_THICKNESS. Issue #129: the through-hole
  // mount no longer needs its own thickness floor -- it's a plain,
  // constant-radius hole with no counterbore, so it fits in the ordinary
  // channel-driven thickness (or the plain plate, wherever the channel
  // doesn't reach) exactly like `mount === "none"`.
  const thickness = wantsKeyhole
    ? Math.max(channelOnlyThickness, MIN_FLANGE_THICKNESS_FOR_SCREW_MOUNT)
    : mountKindForPlate
      ? Math.max(channelOnlyThickness, MIN_FLANGE_THICKNESS_FOR_PLATE)
      : mount === "skadis-tclip"
        ? // Issues #213, #221: the bore floor under the T-clip fin's recess.
          Math.max(channelOnlyThickness, MIN_FLANGE_THICKNESS_FOR_TCLIP)
        : channelOnlyThickness;

  // Issue #115: wide enough for the inner-end lead-in's straight chord to
  // hold the clip past the end of its drop into the channel.
  const innerEndMargin = requiredInnerEndMargin(outline, wireDiameter, leadIn.tolerance, leadIn.bendRadius, resolveChannelDepth(wireDiameter, thickness));
  // Issue #241: the rim slot's seat stays clear of the collar pad under the wall.
  const rimSlotMargin = requiredRimSlotMargin(wireDiameter, leadIn.tolerance);
  const margin = Math.max(mountMargin, innerEndMargin, rimSlotMargin);

  return { margin, thickness, plateThickness: Math.min(FLANGE_PLATE_THICKNESS, thickness), baseMargin, mountMargin, innerEndMargin, rimSlotMargin, envelopeOffset, channelOnlyThickness };
}

/** Issue #122: the thickness when a keyhole slot's footprint overlaps the channel's, so the pocket (wall face) and the channel (winding face) stack in one spot -- the pre-#122 sizing. design.ts falls back to it; the layouts normally keep the two apart. */
export function stackedKeyholeThickness(wireDiameter: number, thickness: number): number {
  return Math.max(thickness, idealChannelDepth(wireDiameter) + INNER_CHANNEL_MIN_SHELF + SCREW_MOUNT_RECESS_DEPTH);
}

/** The flange's real outer extent (types.ts's `FlangeExtent`) at a resolved outline and the real margin `resolveFlangeSizing` returned -- exact, since the flange mesh itself is built from this same offset outline (wall.ts's `buildOutlineRing`). */
export function flangeExtentOf(outline: ShapeOutline, margin: number): FlangeExtent {
  return { acrossFlats: 2 * inscribedRadius(outline, margin), acrossCorners: 2 * circumscribedRadius(outline, margin) };
}

/** The core's real overall assembled height (types.ts's `Solution.overallHeight`): flange bottom to cap top (or the wall's own top rim, uncapped) -- mirrors the assembled frame's z=[-thickness,0] (flange), z=[0,height] (wall), z=[height,height+CAP_THICKNESS] (cap) convention (manifold.ts, design.ts). */
export function overallHeightOf(flangeThickness: number, windingHeight: number, topCapEnabled: boolean): number {
  return flangeThickness + windingHeight + (topCapEnabled ? CAP_THICKNESS : 0);
}
