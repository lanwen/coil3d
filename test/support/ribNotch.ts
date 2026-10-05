import type { Design } from "../../src/core";

/** The angles (degrees from the axis) the cap's notch for the inner end's rib covers, widened by `marginDeg`. */
export function ribNotchDegs(d: Design, marginDeg = 2): { centre: number; half: number } {
  const points = d.centreInnerEnd.capNotch;
  const centre = Math.atan2(d.centreInnerEnd.seat.y, d.centreInnerEnd.seat.x);
  const offsets = points.map((p) => {
    let delta = Math.atan2(p.y, p.x) - centre;
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;
    return delta;
  });
  const half = Math.max(...offsets.map(Math.abs));
  return { centre: (centre * 180) / Math.PI, half: (half * 180) / Math.PI + marginDeg };
}

/** Whether a ray at `deg` from the axis passes through the cap's notch for the rib. */
export function inRibNotch(d: Design, deg: number, marginDeg = 2): boolean {
  const { centre, half } = ribNotchDegs(d, marginDeg);
  const delta = ((((deg - centre) % 360) + 540) % 360) - 180;
  return Math.abs(delta) <= half;
}
