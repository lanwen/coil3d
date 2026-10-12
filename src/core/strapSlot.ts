import { STRAP_SLOT_INNER_WALL, STRAP_SLOT_KEEP_OUT, STRAP_SLOT_LENGTH, STRAP_SLOT_PLATE_REACH, STRAP_SLOT_WIDTH } from "./constants";
import { cutClearsKeepOut } from "./innerEnd";
import type { XY } from "./innerEnd";
import { arcLengthFractionAt, offsetPerimeter, parameterAtOffsetArc, pointAt } from "./shapes";
import type { ShapeOutline } from "./shapes";

export interface StrapSlot {
  outline: XY[];
  centre: XY;
  axis: XY;
}

const SAMPLE_STEP_MM = 0.5;
const SWEEP_STEP_MM = 1;
const END_CAP_SEGMENTS = 8;

export function strapSlotsFitMargin(margin: number, envelopeOffset: number): boolean {
  return margin - envelopeOffset >= STRAP_SLOT_PLATE_REACH;
}

function endCap(centre: XY, normal: XY, along: XY, radius: number, from: number): XY[] {
  return Array.from({ length: END_CAP_SEGMENTS - 1 }, (_, i) => {
    const phi = (Math.PI * (i + 1)) / END_CAP_SEGMENTS;
    const across = from * Math.cos(phi) * radius;
    const out = Math.sin(phi) * radius;
    return { x: centre.x + normal.x * across + along.x * out, y: centre.y + normal.y * across + along.y * out };
  });
}

function slotAt(outline: ShapeOutline, envelopeOffset: number, arc: number): StrapSlot {
  const radius = STRAP_SLOT_WIDTH / 2;
  const innerOffset = envelopeOffset + STRAP_SLOT_INNER_WALL;
  const centreOffset = innerOffset + radius;
  const outerOffset = innerOffset + STRAP_SLOT_WIDTH;
  const straight = STRAP_SLOT_LENGTH - STRAP_SLOT_WIDTH;
  const steps = Math.ceil(straight / SAMPLE_STEP_MM);
  const ts = Array.from({ length: steps + 1 }, (_, i) => parameterAtOffsetArc(outline, centreOffset, arc - straight / 2 + (straight * i) / steps));
  const inner = ts.map((t) => pointAt(outline, t, innerOffset));
  const outer = ts.map((t) => pointAt(outline, t, outerOffset));
  const centres = ts.map((t) => pointAt(outline, t, centreOffset));
  const direction = (a: XY, b: XY): XY => {
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    return { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
  };
  const last = steps;
  const forward = direction(centres[last - 1], centres[last]);
  const backward = direction(centres[1], centres[0]);
  const loop = [
    ...inner,
    ...endCap(centres[last], { x: centres[last].nx, y: centres[last].ny }, forward, radius, -1),
    ...outer.slice().reverse(),
    ...endCap(centres[0], { x: centres[0].nx, y: centres[0].ny }, backward, radius, 1),
  ];
  const middle = pointAt(outline, parameterAtOffsetArc(outline, centreOffset, arc), centreOffset);
  return {
    outline: loop.map(({ x, y }) => ({ x, y })),
    centre: { x: middle.x, y: middle.y },
    axis: { x: middle.nx, y: middle.ny },
  };
}

export function layoutStrapSlots(outline: ShapeOutline, margin: number, envelopeOffset: number, keepOut: XY[][], startU: number): StrapSlot[] | undefined {
  if (!strapSlotsFitMargin(margin, envelopeOffset)) return undefined;
  const centreOffset = envelopeOffset + STRAP_SLOT_INNER_WALL + STRAP_SLOT_WIDTH / 2;
  const perimeter = offsetPerimeter(outline, centreOffset);
  const halfTurn = perimeter / 2;
  if (halfTurn < STRAP_SLOT_LENGTH + 2 * STRAP_SLOT_KEEP_OUT) return undefined;
  const start = arcLengthFractionAt(outline, centreOffset, startU) * perimeter;
  for (let i = 0; i * SWEEP_STEP_MM < halfTurn / 2; i++) {
    for (const arc of i === 0 ? [start] : [start + i * SWEEP_STEP_MM, start - i * SWEEP_STEP_MM]) {
      const pair = [slotAt(outline, envelopeOffset, arc), slotAt(outline, envelopeOffset, arc + halfTurn)];
      if (pair.every((slot) => cutClearsKeepOut(slot.outline, outline, margin, keepOut, STRAP_SLOT_KEEP_OUT))) return pair;
    }
  }
  return undefined;
}
