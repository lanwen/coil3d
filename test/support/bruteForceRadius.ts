// Shared independent oracle for "the true distance from an outline's centre
// to its own boundary at a given standard angle" -- used by mount.test.ts's
// clearance checks (issue #71/#70/#92), so that they don't rely on the
// core's own `radiusAtAngle` to check itself.
//
// It walks `pointAt` (arc-length parameterised, already trusted elsewhere in
// this codebase -- see wire.ts's `outlineHuggingBridge` doc comment) around
// the outline to bracket the one point whose direction from the centre is
// `phi`, then bisects `pointAt`'s own parameter to converge on that point to
// (near) double precision -- never fitting a fixed-resolution polygon, whose
// approximation error would itself vary with curvature and swamp a tight
// tolerance right where it matters most (near a corner/flat-side
// transition, exactly what issue #92 is about).
import { pointAt } from "../../src/core";
import type { ShapeOutline } from "../../src/core";

/** A coarse scan of `pointAt(base, ., offset)`, reusable across many query angles for the same (shape, offset) pair. */
export function coarseOutlineScan(base: ShapeOutline, offset: number, samples = 2000): { t: number; x: number; y: number }[] {
  const pts: { t: number; x: number; y: number }[] = Array.from({ length: samples });
  for (let i = 0; i < samples; i++) {
    const t = i / samples;
    const p = pointAt(base, t, offset);
    pts[i] = { t, x: p.x, y: p.y };
  }
  return pts;
}

/**
 * The true distance from the centre to `pointAt(base, ., offset)`'s outline
 * along standard angle `phi`: brackets the sign change of the point's
 * perpendicular offset from the ray (`px*dirY - py*dirX`, zero exactly on
 * the ray) among the coarse scan -- keeping only the crossing where the
 * point is on the ray's forward side (`px*dirX + py*dirY > 0`), since a
 * convex star-shaped-around-the-centre outline crosses the FULL line twice
 * per loop (`phi` and `phi+pi`) but the ray only once -- then bisects
 * `pointAt`'s own arc-length parameter within that bracket to convergence.
 */
export function bruteForceRadiusAtAngle(scan: { t: number; x: number; y: number }[], base: ShapeOutline, offset: number, phi: number): number {
  const dirX = Math.cos(phi);
  const dirY = Math.sin(phi);
  const cross = (x: number, y: number) => x * dirY - y * dirX;
  const forward = (x: number, y: number) => x * dirX + y * dirY > 0;

  const n = scan.length;
  let loT = -1;
  let hiT = -1;
  for (let i = 0; i < n; i++) {
    const a = scan[i];
    const b = scan[(i + 1) % n];
    const ca = cross(a.x, a.y);
    const cb = cross(b.x, b.y);
    if (ca === 0 && forward(a.x, a.y)) {
      loT = a.t;
      hiT = a.t;
      break;
    }
    if (ca < 0 !== cb < 0 && (forward(a.x, a.y) || forward(b.x, b.y))) {
      loT = a.t;
      hiT = i === n - 1 ? 1 : b.t; // unwrap the last segment's wraparound (t=0) to 1
      break;
    }
  }
  if (loT < 0) throw new Error(`no ray/outline bracket found at phi=${phi}`);

  let lo = loT;
  let hi = hiT;
  let pLo = pointAt(base, lo % 1, offset);
  for (let i = 0; i < 80 && hi - lo > 0; i++) {
    const mid = (lo + hi) / 2;
    const p = pointAt(base, mid % 1, offset);
    if (cross(pLo.x, pLo.y) < 0 === cross(p.x, p.y) < 0) {
      lo = mid;
      pLo = p;
    } else {
      hi = mid;
    }
  }
  const p = pointAt(base, ((lo + hi) / 2) % 1, offset);
  return p.x * dirX + p.y * dirY;
}
