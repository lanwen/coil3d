import { offsetPerimeter } from "../../src/core";
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
