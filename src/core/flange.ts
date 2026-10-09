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
import { idealChannelDepth, requiredInnerEndMargin, requiredRimSlotMargin, resolveChannelDepth } from "./innerEnd";
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

export function resolveBoreOutline(outline: ShapeOutline, wireDiameter: number): { boreOutline: ShapeOutline; reduced: boolean } {
  const wall = wallThickness(wireDiameter);
  let boreApothem = outline.apothem - wall;
  const reduced = boreApothem < MIN_BORE_RADIUS;
  if (reduced) boreApothem = MIN_BORE_RADIUS;
  const isRound = outline.cornerRadius === outline.apothem;
  const boreCornerRadius = isRound ? boreApothem : Math.min(Math.max(outline.cornerRadius - wall, MIN_BORE_CORNER_RADIUS), boreApothem);
  return { boreOutline: { n: outline.n, apothem: boreApothem, cornerRadius: boreCornerRadius }, reduced };
}

export interface FlangeSizing {
  margin: number;
  thickness: number;
  plateThickness: number;
  baseMargin: number;
  mountMargin: number;
  innerEndMargin: number;
  rimSlotMargin: number;
  envelopeOffset: number;
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
  const wantsPlate = mount === "opengrid";

  const envelopeOffset = woundReachOffset(flangeSizeEnvelope / 2 - FLANGE_MARGIN - circumscribedRadius(outline, 0), wireDiameter, leadIn.woundLayers ?? 1, leadIn.topCap ?? false);
  const baseMargin = Math.max(FLANGE_MARGIN, envelopeOffset + FLANGE_MARGIN);
  const channelOnlyThickness = Math.max(FLANGE_THICKNESS, idealChannelDepth(wireDiameter) + INNER_CHANNEL_MIN_SHELF);
  const mountMargin = mount === "skadis"
    ? Math.max(baseMargin, requiredSkadisMargin(outline, boreOutline, envelopeOffset, leadIn.heavyCable ?? false, channelOnlyThickness, Math.min(FLANGE_PLATE_THICKNESS, channelOnlyThickness), leadIn.tolerance))
    : wantsKeyhole
    ? Math.max(baseMargin, requiredFlangeMargin(outline, boreOutline, keyholeRotation))
    : wantsThrough
      ? Math.max(baseMargin, requiredThroughMountMargin(outline, boreOutline, throughHoleDiameter, collarFootprintOffset({ thickness: channelOnlyThickness, plateThickness: Math.min(FLANGE_PLATE_THICKNESS, channelOnlyThickness) })))
      : wantsPlate
        ? Math.max(baseMargin, requiredMountPlateMargin(outline, boreOutline))
        : baseMargin;

  const thickness = wantsKeyhole
    ? Math.max(channelOnlyThickness, MIN_FLANGE_THICKNESS_FOR_SCREW_MOUNT)
    : wantsPlate
      ? Math.max(channelOnlyThickness, MIN_FLANGE_THICKNESS_FOR_PLATE)
      : mount === "skadis-tclip"
        ? Math.max(channelOnlyThickness, MIN_FLANGE_THICKNESS_FOR_TCLIP)
        : channelOnlyThickness;

  const innerEndMargin = requiredInnerEndMargin(outline, wireDiameter, leadIn.tolerance, leadIn.bendRadius, resolveChannelDepth(wireDiameter, thickness));
  const rimSlotMargin = requiredRimSlotMargin(wireDiameter, leadIn.tolerance);
  if (!baseOn) {
    const margin = leadIn.topCap ? Math.max(baseMargin, rimSlotMargin) : 0;
    return { margin, thickness: 0, plateThickness: 0, baseMargin, mountMargin: baseMargin, innerEndMargin: 0, rimSlotMargin, envelopeOffset, channelOnlyThickness };
  }
  const margin = Math.max(mountMargin, innerEndMargin, rimSlotMargin);

  return { margin, thickness, plateThickness: Math.min(FLANGE_PLATE_THICKNESS, thickness), baseMargin, mountMargin, innerEndMargin, rimSlotMargin, envelopeOffset, channelOnlyThickness };
}

export function stackedKeyholeThickness(wireDiameter: number, thickness: number): number {
  return Math.max(thickness, idealChannelDepth(wireDiameter) + INNER_CHANNEL_MIN_SHELF + SCREW_MOUNT_RECESS_DEPTH);
}

export function flangeExtentOf(outline: ShapeOutline, margin: number): FlangeExtent {
  return { acrossFlats: 2 * inscribedRadius(outline, margin), acrossCorners: 2 * circumscribedRadius(outline, margin) };
}

export function overallHeightOf(flangeThickness: number, windingHeight: number, topCapEnabled: boolean): number {
  return flangeThickness + windingHeight + (topCapEnabled ? CAP_THICKNESS : 0);
}
