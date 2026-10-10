import { STRAP_NOTCH_KEEP_OUT, STRAP_NOTCH_MOUTH_EXTRA, STRAP_NOTCH_WIDTH } from "./constants";
import { cutClearsKeepOut } from "./innerEnd";
import type { XY } from "./innerEnd";
import { offsetPerimeter, outlineOffsetAt, parameterAtOffsetArc, pointAt, sideLength } from "./shapes";
import type { ShapeOutline } from "./shapes";

export interface StrapNotch {
  outline: XY[];
  centre: XY;
  axis: XY;
}

const SAMPLE_STEP_MM = 0.5;
const SWEEP_STEP_MM = 1;
const FLOOR_TOLERANCE_MM = 1e-3;
const FLOOR_SAGITTA_MM = 0.05;
const NEGLIGIBLE_SIDE_MM = 1e-6;

function notchAt(outline: ShapeOutline, margin: number, envelopeOffset: number, arc: number): StrapNotch | undefined {
  const half = STRAP_NOTCH_WIDTH / 2;
  const steps = Math.ceil(STRAP_NOTCH_WIDTH / SAMPLE_STEP_MM);
  const ts = Array.from({ length: steps + 1 }, (_, i) => parameterAtOffsetArc(outline, envelopeOffset, arc - half + (STRAP_NOTCH_WIDTH * i) / steps));
  const floor = ts.map((t) => pointAt(outline, t, envelopeOffset));
  const mouth = ts.map((t) => pointAt(outline, t, margin + STRAP_NOTCH_MOUTH_EXTRA));
  const onFloor = floor.every((p) => Math.abs(outlineOffsetAt(outline, p.x, p.y).offset - envelopeOffset) < FLOOR_TOLERANCE_MM);
  const deepEnough = floor.slice(1).every((q, i) => outlineOffsetAt(outline, (q.x + floor[i].x) / 2, (q.y + floor[i].y) / 2).offset >= envelopeOffset - FLOOR_SAGITTA_MM);
  if (!onFloor || !deepEnough) return undefined;
  const middle = pointAt(outline, parameterAtOffsetArc(outline, envelopeOffset, arc), envelopeOffset);
  return {
    outline: [...mouth, ...floor.slice().reverse()].map(({ x, y }) => ({ x, y })),
    centre: { x: middle.x, y: middle.y },
    axis: { x: middle.nx, y: middle.ny },
  };
}

function candidateArcs(outline: ShapeOutline, envelopeOffset: number): number[] {
  const side = sideLength(outline);
  const perimeter = offsetPerimeter(outline, envelopeOffset);
  const unit = perimeter / outline.n;
  const arc = unit - side;
  const sideMiddles = side > NEGLIGIBLE_SIDE_MM ? Array.from({ length: outline.n }, (_, k) => k * unit + arc + side / 2) : [];
  const sweep = Array.from({ length: Math.floor(perimeter / 2 / SWEEP_STEP_MM) }, (_, i) => i * SWEEP_STEP_MM);
  return [...sideMiddles, ...sweep];
}

export function layoutStrapNotches(outline: ShapeOutline, margin: number, envelopeOffset: number, keepOut: XY[][]): StrapNotch[] | undefined {
  const halfTurn = offsetPerimeter(outline, envelopeOffset) / 2;
  if (halfTurn < STRAP_NOTCH_WIDTH + 2 * STRAP_NOTCH_KEEP_OUT) return undefined;
  for (const arc of candidateArcs(outline, envelopeOffset)) {
    const pair = [notchAt(outline, margin, envelopeOffset, arc), notchAt(outline, margin, envelopeOffset, arc + halfTurn)];
    if (!pair[0] || !pair[1]) continue;
    const clear = pair.every((notch) => cutClearsKeepOut(notch!.outline, outline, margin, keepOut, STRAP_NOTCH_KEEP_OUT));
    if (clear) return pair as StrapNotch[];
  }
  return undefined;
}
