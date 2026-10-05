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
  DEFAULT_BASE,
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
import { idealChannelDepth, requiredRimSlotMargin } from "./innerEnd";
import { collarFootprintOffset } from "./flangePads";
import { requiredFlangeMargin, requiredThroughMountMargin } from "./mount";
import { woundReachOffset } from "./wire";
import { requiredMountPlateMargin } from "./mountPlate";
import { requiredSkadisMargin } from "./skadisClips";
import { circumscribedRadius, inscribedRadius } from "./shapes";
import type { ShapeOutline } from "./shapes";
import type { CoilSpec, FlangeExtent, MountKind } from "./types";
import { wallThickness } from "./wall";

export function baseEnabled(spec: Pick<CoilSpec, "base" | "mount">): boolean {
  return spec.mount !== "none" || (spec.base ?? DEFAULT_BASE) === "on";
}

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
  /** The margin the rim cable slot alone needs (issue #241): its seat clear of the base's collar pad. */
  rimSlotMargin: number;
  /** The drawn cable's outer surface, as an offset outside the core's outline: the wound envelope, or further out where a lifted single-layer turn or the outer end's climb to the cap reaches (wire.ts's `woundReachOffset`). */
  envelopeOffset: number;
  /** The plain channel-driven thickness, before any mount/plate bump -- design.ts compares against this the same way. */
  channelOnlyThickness: number;
}

export function resolveFlangeSizing(
  outline: ShapeOutline,
  boreOutline: ShapeOutline,
  flangeSizeEnvelope: number,
  wireDiameter: number,
  mount: MountKind,
  leadIn: { tolerance: number; bendRadius: number; heavyCable?: boolean; woundLayers?: number; topCap?: boolean },
  keyholeRotation = 0,
  throughHoleDiameter = DEFAULT_THROUGH_HOLE_DIAMETER,
  baseOn = true,
): FlangeSizing {
  const wantsKeyhole = mount === "keyhole";
  const wantsThrough = mount === "through";
  const mountKindForPlate = mount === "opengrid" ? mount : undefined;

  const envelopeOffset = woundReachOffset(flangeSizeEnvelope / 2 - FLANGE_MARGIN - circumscribedRadius(outline, 0), wireDiameter, leadIn.woundLayers ?? 1, leadIn.topCap ?? false);
  const baseMargin = Math.max(FLANGE_MARGIN, envelopeOffset + FLANGE_MARGIN);
  const channelOnlyThickness = Math.max(FLANGE_THICKNESS, idealChannelDepth(wireDiameter) + INNER_CHANNEL_MIN_SHELF);
  const mountMargin = mount === "skadis"
    ? Math.max(baseMargin, requiredSkadisMargin(outline, boreOutline, envelopeOffset, leadIn.heavyCable ?? false, channelOnlyThickness, Math.min(FLANGE_PLATE_THICKNESS, channelOnlyThickness), leadIn.tolerance))
    : wantsKeyhole
    ? Math.max(baseMargin, requiredFlangeMargin(outline, boreOutline, keyholeRotation))
    : wantsThrough
      ? Math.max(baseMargin, requiredThroughMountMargin(outline, boreOutline, throughHoleDiameter, collarFootprintOffset({ thickness: channelOnlyThickness, plateThickness: Math.min(FLANGE_PLATE_THICKNESS, channelOnlyThickness) })))
      : mountKindForPlate
        ? Math.max(baseMargin, requiredMountPlateMargin(outline, boreOutline))
        : baseMargin;

  const thickness = wantsKeyhole
    ? Math.max(channelOnlyThickness, MIN_FLANGE_THICKNESS_FOR_SCREW_MOUNT)
    : mountKindForPlate
      ? Math.max(channelOnlyThickness, MIN_FLANGE_THICKNESS_FOR_PLATE)
      : mount === "skadis-tclip"
        ? Math.max(channelOnlyThickness, MIN_FLANGE_THICKNESS_FOR_TCLIP)
        : channelOnlyThickness;

  const rimSlotMargin = requiredRimSlotMargin(wireDiameter, leadIn.tolerance);
  if (!baseOn) {
    const margin = leadIn.topCap ? Math.max(baseMargin, rimSlotMargin) : 0;
    return { margin, thickness: 0, plateThickness: 0, baseMargin, mountMargin: baseMargin, rimSlotMargin, envelopeOffset, channelOnlyThickness };
  }
  const margin = Math.max(mountMargin, rimSlotMargin);

  return { margin, thickness, plateThickness: Math.min(FLANGE_PLATE_THICKNESS, thickness), baseMargin, mountMargin, rimSlotMargin, envelopeOffset, channelOnlyThickness };
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
