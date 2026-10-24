import { plateStrapSlots } from "../strapSlot";
import type { StrapSlot } from "../strapSlot";
import type { ShapeOutline } from "../shapes";
import { cutRankOf, titleOf } from "./kinds";
import type { FaceContext, FacePayload, KindDef } from "./kinds";
import type { FaceFeature, FaceLayout, FaceOp, KeepOut } from "./types";

function keepOutsOf(feature: FaceFeature): KeepOut[] {
  return feature.loops.map((poly) => ({ kind: feature.kind as KeepOut["kind"], id: feature.id, poly }));
}

export async function layoutFace(ctx: FaceContext, kinds: readonly KindDef[]): Promise<{ layout: FaceLayout; payload: FacePayload }> {
  const layout: FaceLayout = { face: ctx.face, features: [], keepOuts: [...ctx.fixed] };
  const payload: FacePayload = {};
  for (const def of kinds) {
    const avoids = def.avoids(ctx.face);
    if (!avoids) continue;
    const considered = layout.keepOuts.filter((k) => avoids.kinds.includes(k.kind)).map((k) => k.poly);
    const placed = await def.place(ctx, avoids.filter ? considered.filter((poly) => poly.length >= 3) : considered, avoids.clearance);
    layout.features.push(...placed.features);
    layout.keepOuts.push(...placed.features.flatMap(keepOutsOf));
    Object.assign(payload, placed.payload);
  }
  return { layout, payload };
}

export function layoutPlateFace(base: FaceLayout | undefined, slots: StrapSlot[], outline: ShapeOutline, envelopeOffset: number, plateEdgeOffset: number | undefined): { layout: FaceLayout; slots: StrapSlot[] } {
  if (plateEdgeOffset === undefined) return { layout: { face: "mountPlate", features: [], keepOuts: [] }, slots: [] };
  const plateSlots = plateStrapSlots(outline, envelopeOffset, slots, plateEdgeOffset);
  const features = (base?.features ?? []).filter((f) => f.kind === "strapSlot").map((f, i) => ({ ...f, loops: plateSlots[i] ? [plateSlots[i].outline] : [] }));
  return { layout: { face: "mountPlate", features, keepOuts: [] }, slots: plateSlots };
}

export function faceOps(layout: FaceLayout, kinds: readonly KindDef[]): FaceOp[] {
  return layout.features
    .filter((f) => f.status.by !== "blocked")
    .map((f, order) => ({ f, order, rank: cutRankOf(kinds, f.kind) }))
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .map(({ f }) => ({ id: f.id, title: titleOf(kinds, f.kind), op: f.op, loops: f.loops, depth: f.depth, mark: f.mark }));
}
