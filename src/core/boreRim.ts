import { outlineOffsetAt } from "./shapes";
import type { ShapeOutline } from "./shapes";
import { RIM_NEEDLE_ANGLE_DEG, RIM_NEEDLE_DEVIATION, RIM_NEEDLE_VOLUME } from "./weld";
import type { Corner, NeedleRule } from "./weld";

const BORE_RIM_BAND = 1;

export function boreRimNeedles(boreOutline: ShapeOutline, levels: number[]): NeedleRule {
  const nearBore = ([x, y]: Corner) => Math.abs(outlineOffsetAt(boreOutline, x, y).offset) <= BORE_RIM_BAND;
  const atLevel = ([, , z]: Corner) => levels.some((level) => Math.abs(z - level) <= BORE_RIM_BAND);
  return {
    minAngleDeg: RIM_NEEDLE_ANGLE_DEG,
    maxDeviation: RIM_NEEDLE_DEVIATION,
    maxVolume: RIM_NEEDLE_VOLUME,
    at: (a, b, c) => [a, b, c].every(nearBore) && [a, b, c].some(atLevel),
  };
}
