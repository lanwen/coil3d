import type { Design } from "../../src/core";

export interface XY {
  x: number;
  y: number;
}

export type RimSlot = NonNullable<Design["rimSlots"]["base"]>;
export type StrapSlot = Design["strapSlots"]["base"][number];
export type FaceEnd = NonNullable<NonNullable<Design["faceChannels"]>["inner"]>;
export type WallSpec = Design["wallSpec"];
