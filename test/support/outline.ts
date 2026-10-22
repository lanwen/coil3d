import { offsetPerimeter, pointAt } from "../../src/core";
import type { ShapeOutline } from "../../src/core";

/** Length (mm) of one straight side of the outline; 0 for a circle. A pill's two flats count as its two sides. */
export function sideLength(o: ShapeOutline): number {
  return (offsetPerimeter(o, 0) - 2 * Math.PI * o.cornerRadius) / o.n;
}

/** Distance from the centre to the outline's farthest point, offset outward by `offset`. */
export function circumscribedRadius(o: ShapeOutline, offset: number): number {
  const centreToCorner = o.n === 2 ? (o.halfStraight ?? 0) : (o.apothem - o.cornerRadius) / Math.cos(Math.PI / o.n);
  return centreToCorner + o.cornerRadius + offset;
}

/** The middle of the outline's `seg`-th piece, counting from the first corner's arc: even pieces are corner arcs, odd ones straight sides. */
export function segmentMidpoint(o: ShapeOutline, seg: number): { x: number; y: number; nx: number; ny: number } {
  const arc = ((2 * Math.PI) / o.n) * o.cornerRadius;
  const side = sideLength(o);
  const corners = Math.floor(seg / 2);
  const along = corners * (arc + side) + (seg % 2 === 0 ? arc / 2 : arc + side / 2);
  const circleStartsMidArc = o.n !== 2 && o.cornerRadius === o.apothem;
  return pointAt(o, (along - (circleStartsMidArc ? arc / 2 : 0)) / offsetPerimeter(o, 0), 0);
}
