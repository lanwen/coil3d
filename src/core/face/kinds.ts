import { LABEL_DEPTH, RIM_SLOT_KEEP_OUT, RIM_SLOT_LABEL_KEEP_OUT, STRAP_SLOT_KEEP_OUT } from "../constants";
import { layoutRimSlot } from "../innerEnd";
import type { RimSlot, XY } from "../innerEnd";
import { getLabelFont, labelLoops, resolveLabel } from "../label";
import type { LabelResolution } from "../label";
import type { ShapeOutline } from "../shapes";
import { layoutStrapSlots, strapSlotsFitMargin } from "../strapSlot";
import type { StrapSlot } from "../strapSlot";
import type { FaceFeature, FaceId, FaceOpKind, FeatureKind, KeepOut } from "./types";

export interface FaceContext {
  face: FaceId;
  built: boolean;
  outline: ShapeOutline;
  boreOutline: ShapeOutline;
  margin: number;
  envelopeOffset: number;
  wireDiameter: number;
  tolerance: number;
  startU: number;
  labelText?: string;
  fixed: KeepOut[];
}

export interface FacePayload {
  label?: LabelResolution;
  rimSlot?: RimSlot;
  strapSlots?: StrapSlot[];
}

export interface Avoids {
  kinds: readonly KeepOut["kind"][];
  clearance: number;
  filter: boolean;
}

export interface KindDef {
  kind: FeatureKind;
  title: string;
  op: FaceOpKind;
  depth?: number;
  mark?: "label";
  cutRank: number;
  speaksWithoutFace?: boolean;
  avoids(face: FaceId): Avoids | undefined;
  place(ctx: FaceContext, keepOut: XY[][], clearance: number): Promise<{ features: FaceFeature[]; payload?: FacePayload }>;
}

const BASE_FIXED_KINDS: readonly KeepOut["kind"][] = ["channel", "pad", "keyhole", "throughHole", "skadisFootprint", "skadisNotch", "tclip", "plateAnchor", "plateClip", "leadIn"];
const BASE_RIM_SLOT_KINDS: readonly KeepOut["kind"][] = ["channel", "pad", "keyhole", "throughHole", "skadisFootprint"];

const LABEL: KindDef = {
  kind: "label",
  title: "Label",
  op: "engrave",
  depth: LABEL_DEPTH,
  mark: "label",
  cutRank: 30,
  speaksWithoutFace: true,
  avoids: (face) => (face === "cap" ? { kinds: [], clearance: 0, filter: false } : undefined),
  async place(ctx) {
    const resolution = await resolveLabel(ctx.labelText, ctx.outline, ctx.boreOutline, ctx.margin, ctx.built);
    const { label, warning } = resolution;
    const shared = { id: "label", kind: LABEL.kind, op: LABEL.op, depth: LABEL.depth, mark: LABEL.mark };
    if (label) {
      const loops = labelLoops(await getLabelFont(), label).map((loop) => loop.map(([x, y]) => ({ x, y })));
      return { features: [{ ...shared, status: { by: "auto" }, loops }], payload: { label: resolution } };
    }
    if (warning) return { features: [{ ...shared, status: { by: "blocked", reason: ctx.built ? "tooLong" : "needsCap" }, loops: [] }], payload: { label: resolution } };
    return { features: [], payload: { label: resolution } };
  },
};

const RIM_SLOT: KindDef = {
  kind: "rimSlot",
  title: "Rim slot",
  op: "through",
  cutRank: 10,
  avoids: (face) => {
    if (face === "base") return { kinds: BASE_RIM_SLOT_KINDS, clearance: RIM_SLOT_KEEP_OUT, filter: true };
    if (face === "cap") return { kinds: ["label"], clearance: RIM_SLOT_LABEL_KEEP_OUT, filter: false };
    return undefined;
  },
  async place(ctx, keepOut, clearance) {
    const slot = layoutRimSlot(ctx.outline, ctx.margin, ctx.wireDiameter, ctx.tolerance, ctx.startU, keepOut, clearance);
    const shared = { id: "rimSlot", kind: RIM_SLOT.kind, op: RIM_SLOT.op };
    if (!slot) return { features: [{ ...shared, status: { by: "blocked", reason: "noClearSpot" }, loops: [] }] };
    return { features: [{ ...shared, status: { by: "auto" }, loops: [slot.outline] }], payload: { rimSlot: slot } };
  },
};

const STRAP_SLOT: KindDef = {
  kind: "strapSlot",
  title: "Strap slot",
  op: "through",
  cutRank: 20,
  avoids: (face) => {
    if (face === "base") return { kinds: [...BASE_FIXED_KINDS, "rimSlot"], clearance: STRAP_SLOT_KEEP_OUT, filter: true };
    if (face === "cap") return { kinds: ["label", "rimSlot", "leadIn"], clearance: STRAP_SLOT_KEEP_OUT, filter: true };
    return undefined;
  },
  async place(ctx, keepOut) {
    const slots = layoutStrapSlots(ctx.outline, ctx.margin, ctx.envelopeOffset, keepOut, ctx.startU) ?? [];
    const shared = { kind: STRAP_SLOT.kind, op: STRAP_SLOT.op };
    if (slots.length === 0) {
      const reason = strapSlotsFitMargin(ctx.margin, ctx.envelopeOffset) ? "noClearSpot" : "noMargin";
      return { features: [0, 1].map((i) => ({ ...shared, id: `strapSlot:${i}`, status: { by: "blocked", reason }, loops: [] })), payload: { strapSlots: [] } };
    }
    return { features: slots.map((slot, i) => ({ ...shared, id: `strapSlot:${i}`, status: { by: "auto" }, loops: [slot.outline] })), payload: { strapSlots: slots } };
  },
};

export const FACE_KINDS: readonly KindDef[] = [LABEL, RIM_SLOT, STRAP_SLOT];

export function activeKinds(built: boolean, strapSlots: boolean): KindDef[] {
  return FACE_KINDS.filter((def) => (built || def.speaksWithoutFace) && (strapSlots || def.kind !== "strapSlot"));
}

function defOf(kinds: readonly KindDef[], kind: FeatureKind): KindDef {
  const def = kinds.find((k) => k.kind === kind);
  if (!def) throw new Error(`No face kind "${kind}" is registered`);
  return def;
}

export const cutRankOf = (kinds: readonly KindDef[], kind: FeatureKind): number => defOf(kinds, kind).cutRank;
export const titleOf = (kinds: readonly KindDef[], kind: FeatureKind): string => defOf(kinds, kind).title;
