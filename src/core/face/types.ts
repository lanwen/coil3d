import type { XY } from "../innerEnd";

export type FaceId = "cap" | "base" | "mountPlate";
export type FaceOpKind = "through" | "engrave";
export type FixedKind = "channel" | "pad" | "keyhole" | "throughHole" | "skadisFootprint" | "skadisNotch" | "tclip" | "plateAnchor" | "plateClip" | "leadIn";
export type MovableKind = "label" | "rimSlot" | "strapSlot";
export type FeatureKind = MovableKind | (string & {});

export interface FacePlacement {
  u: number;
  v: number;
  rotationDeg: number;
  size?: number;
}

export type BlockedReason = "needsCap" | "tooLong" | "noMargin" | "noClearSpot";
export type PlacementStatus = { by: "auto" } | { by: "user" } | { by: "blocked"; reason: BlockedReason };

export interface FaceFeature {
  id: string;
  kind: FeatureKind;
  status: PlacementStatus;
  placement?: FacePlacement;
  loops: XY[][];
  op: FaceOpKind;
  depth?: number;
  mark?: "label";
}

export interface KeepOut {
  kind: FixedKind | MovableKind;
  id?: string;
  poly: XY[];
}

export interface FaceLayout {
  face: FaceId;
  features: FaceFeature[];
  keepOuts: KeepOut[];
}

export interface FaceOp {
  id: string;
  title: string;
  op: FaceOpKind;
  loops: XY[][];
  depth?: number;
  mark?: "label";
}
