import type { XY } from "./types";

/** Width of the slot's neck (the narrowest part, between the seat and the rim): the gap between the outline's two neck corners. */
export function rimSlotNeckWidth(slot: { outline: XY[] }): number {
  const a = slot.outline[1];
  const b = slot.outline[slot.outline.length - 2];
  return Math.hypot(a.x - b.x, a.y - b.y);
}
