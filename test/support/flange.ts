import type { Design } from "../../src/core";
import type { XY } from "./types";

/** Z of the thin plate's top face where the flange has raised pads over it, or undefined for a full-thickness flange. */
export function plateTopZ(d: Design): number | undefined {
  const { thickness, plateThickness } = d.flangeSpec;
  const plate = Math.min(plateThickness ?? thickness, thickness);
  // A relief under a micrometre is no relief: the plate is the full flange.
  return thickness - plate > 1e-6 ? -thickness + plate : undefined;
}

/** Distance (mm, in plan) from a point to the top cap's engraved label pocket, read off the faces its mesh marks as label faces: 0 inside the pocket, Infinity when there is no label. */
export function distanceToLabel(d: Design, p: XY): number {
  const cap = d.parts.find((part) => part.role === "topCap");
  const marked = cap?.mesh.labelTriangles;
  if (!cap || !marked) return Infinity;
  const { positions, indices } = cap.mesh;
  let best = Infinity;
  for (const t of marked) {
    const corner = (k: number): XY => ({ x: positions[indices[t * 3 + k] * 3], y: positions[indices[t * 3 + k] * 3 + 1] });
    const triangle = [corner(0), corner(1), corner(2)];
    if (insideTriangle(p, triangle)) return 0;
    for (let k = 0; k < 3; k++) best = Math.min(best, distanceToSegment(p, triangle[k], triangle[(k + 1) % 3]));
  }
  return best;
}

function insideTriangle(p: XY, [a, b, c]: XY[]): boolean {
  const side = (u: XY, v: XY) => (v.x - u.x) * (p.y - u.y) - (v.y - u.y) * (p.x - u.x);
  const signs = [side(a, b), side(b, c), side(c, a)];
  return signs.every((v) => v >= 0) || signs.every((v) => v <= 0);
}

function distanceToSegment(p: XY, a: XY, b: XY): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 1e-12 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
