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
  FLANGE_THICKNESS,
  INNER_CHANNEL_MIN_SHELF,
  MIN_BORE_CORNER_RADIUS,
  MIN_BORE_RADIUS,
  MIN_FLANGE_THICKNESS_FOR_PLATE,
  MIN_FLANGE_THICKNESS_FOR_SCREW_MOUNT,
  MIN_FLANGE_THICKNESS_FOR_THROUGH_MOUNT,
  SCREW_MOUNT_RECESS_DEPTH,
  THROUGH_MOUNT_COUNTERBORE_DEPTH,
  WALL_THICKNESS,
} from "./constants";
import { idealChannelDepth, requiredCapClipMargin, requiredInnerEndMargin, resolveChannelDepth } from "./innerEnd";
import { requiredFlangeMargin, requiredThroughMountMargin } from "./mount";
import { requiredMountPlateMargin } from "./mountPlate";
import { circumscribedRadius, inscribedRadius } from "./shapes";
import type { ShapeOutline } from "./shapes";
import type { FlangeExtent, MountKind } from "./types";

/**
 * The bore outline for a given wall outline: a TRUE inward offset by the
 * wall thickness, floored so it never inverts (design.ts's own bore
 * construction, factored out verbatim so solve.ts's search can share it
 * without hand-deriving `boreOutline` per candidate -- see
 * spikes/s1-grooved-wall/geom.ts's `boreMinCornerR`). `reduced` is true
 * when the apothem floor actually bit; design.ts turns that into a "too
 * small for a wall" warning, the search doesn't need the warning text.
 */
export function resolveBoreOutline(outline: ShapeOutline): { boreOutline: ShapeOutline; reduced: boolean } {
  let boreApothem = outline.apothem - WALL_THICKNESS;
  const reduced = boreApothem < MIN_BORE_RADIUS;
  if (reduced) boreApothem = MIN_BORE_RADIUS;
  // Round's defining invariant is apothem === cornerRadius (see shapes.ts);
  // preserve it explicitly, or a tiny core would get a very-slightly-square
  // bore instead of a circle once the two floors below bite differently.
  const isRound = outline.cornerRadius === outline.apothem;
  const boreCornerRadius = isRound ? boreApothem : Math.min(Math.max(outline.cornerRadius - WALL_THICKNESS, MIN_BORE_CORNER_RADIUS), boreApothem);
  return { boreOutline: { n: outline.n, apothem: boreApothem, cornerRadius: boreCornerRadius }, reduced };
}

export interface FlangeSizing {
  margin: number;
  thickness: number;
  /** The plain envelope-clearance margin, before any mount bump -- design.ts compares against this to decide whether to warn "margin increased ...". */
  baseMargin: number;
  /** The margin the requested mount alone needs (>= baseMargin). */
  mountMargin: number;
  /** The margin the inner-end lead-in alone needs (issue #115). */
  innerEndMargin: number;
  /** The margin the top cap's cable clip alone needs (issue #117): 0 with the cap off. */
  capClipMargin: number;
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
  /** Issue #115: the inner-end lead-in needs room to reach the groove within the cable's bend radius (innerEnd.ts's `requiredInnerEndMargin`); issue #117: with the top cap on, its cable clip needs room between the wound cable and the rim (`requiredCapClipMargin`). */
  leadIn: { tolerance: number; bendRadius: number; topCap?: boolean },
  /** Issue #71: ignored unless `mount === "keyhole"`. */
  keyholeRotation = 0,
  /** Issue #70: ignored unless `mount === "through"`. */
  throughHoleDiameter = DEFAULT_THROUGH_HOLE_DIAMETER,
): FlangeSizing {
  const wantsKeyhole = mount === "keyhole";
  const wantsThrough = mount === "through";
  const mountKindForPlate = mount === "skadis" || mount === "opengrid" ? mount : undefined;

  // circumscribedRadius(outline, margin) === circumscribedRadius(outline, 0) + margin
  // (the offset term is additive, see shapes.ts), so this margin is exactly
  // what's needed for the flange's own circumscribed radius to reach
  // flangeSizeEnvelope / 2.
  const baseMargin = Math.max(FLANGE_MARGIN, flangeSizeEnvelope / 2 - circumscribedRadius(outline, 0));
  // Issue #70 AC ("outside the winding envelope, so a screwdriver can reach
  // them"): `flangeSizeEnvelope` is already the wound envelope's own
  // diameter (plus a flat FLANGE_MARGIN pad, docs/research.md "Flange size =
  // final outer envelope + margin") -- reusing it directly as the through
  // mount's own envelope-clearance radius is a few mm more conservative than
  // the bare minimum (that pad), never less, so it's a safe stand-in with no
  // extra plumbing.
  const mountMargin = wantsKeyhole
    ? Math.max(baseMargin, requiredFlangeMargin(outline, boreOutline, keyholeRotation))
    : wantsThrough
      ? Math.max(baseMargin, requiredThroughMountMargin(outline, boreOutline, throughHoleDiameter, flangeSizeEnvelope / 2))
      : mountKindForPlate
        // Issue #120: SKÅDIS/openGrid used to just take `baseMargin` here,
        // so a plate whose fixed-pitch grid needs more room than the plain
        // wound-envelope clearance gives could be silently skipped (only a
        // warning to notice) -- this grows the margin exactly like the
        // other two mount kinds already do, so the plate is never dropped
        // just because the (often solver-picked) core came out small.
        ? Math.max(baseMargin, requiredMountPlateMargin(outline, boreOutline, mountKindForPlate))
        : baseMargin;

  const minPlateThickness = mountKindForPlate ? MIN_FLANGE_THICKNESS_FOR_PLATE : 0;
  const idealDepth = idealChannelDepth(wireDiameter);
  const channelOnlyThickness = Math.max(FLANGE_THICKNESS, idealDepth + INNER_CHANNEL_MIN_SHELF);
  const thickness = wantsKeyhole
    ? Math.max(channelOnlyThickness, MIN_FLANGE_THICKNESS_FOR_SCREW_MOUNT, idealDepth + INNER_CHANNEL_MIN_SHELF + SCREW_MOUNT_RECESS_DEPTH)
    : wantsThrough
      ? Math.max(channelOnlyThickness, MIN_FLANGE_THICKNESS_FOR_THROUGH_MOUNT, idealDepth + INNER_CHANNEL_MIN_SHELF + THROUGH_MOUNT_COUNTERBORE_DEPTH)
      : mountKindForPlate
        ? Math.max(channelOnlyThickness, minPlateThickness)
        : channelOnlyThickness;

  // Issue #115: wide enough for the inner-end lead-in's straight chord to
  // hold the clip past the end of its drop into the channel.
  const innerEndMargin = requiredInnerEndMargin(outline, wireDiameter, leadIn.tolerance, leadIn.bendRadius, resolveChannelDepth(wireDiameter, thickness, mount));
  // Issue #117: the cap's clip hangs between the outermost layer (the
  // envelope, FLANGE_MARGIN inside `flangeSizeEnvelope`) and the rim.
  const envelopeOffset = flangeSizeEnvelope / 2 - FLANGE_MARGIN - circumscribedRadius(outline, 0);
  const capClipMargin = leadIn.topCap ? requiredCapClipMargin(envelopeOffset, wireDiameter, leadIn.tolerance) : 0;
  const margin = Math.max(mountMargin, innerEndMargin, capClipMargin);

  return { margin, thickness, baseMargin, mountMargin, innerEndMargin, capClipMargin, channelOnlyThickness };
}

/** The flange's real outer extent (types.ts's `FlangeExtent`) at a resolved outline and the real margin `resolveFlangeSizing` returned -- exact, since the flange mesh itself is built from this same offset outline (wall.ts's `buildOutlineRing`). */
export function flangeExtentOf(outline: ShapeOutline, margin: number): FlangeExtent {
  return { acrossFlats: 2 * inscribedRadius(outline, margin), acrossCorners: 2 * circumscribedRadius(outline, margin) };
}

/** The core's real overall assembled height (types.ts's `Solution.overallHeight`): flange bottom to cap top (or the wall's own top rim, uncapped) -- mirrors the assembled frame's z=[-thickness,0] (flange), z=[0,height] (wall), z=[height,height+CAP_THICKNESS] (cap) convention (manifold.ts, design.ts). */
export function overallHeightOf(flangeThickness: number, windingHeight: number, topCapEnabled: boolean): number {
  return flangeThickness + windingHeight + (topCapEnabled ? CAP_THICKNESS : 0);
}
