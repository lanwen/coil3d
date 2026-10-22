import type { XY } from "./types";

/** Volume of a closed, consistently-oriented triangle mesh, by the divergence theorem, computed here independently of the core. */
export function meshVolume(mesh: { positions: Float32Array; indices: Uint32Array }): number {
  const { positions: v, indices: t } = mesh;
  let volume = 0;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i] * 3;
    const b = t[i + 1] * 3;
    const c = t[i + 2] * 3;
    volume +=
      (v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) -
        v[a + 1] * (v[b] * v[c + 2] - v[b + 2] * v[c]) +
        v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c])) /
      6;
  }
  return Math.abs(volume);
}

/** Distance from a point to a closed polygon's boundary, 0 when the point is inside it. */
export function distanceToClosedPolygon(px: number, py: number, points: XY[]): number {
  let best = Infinity;
  let inside = false;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    if (a.y > py !== b.y > py && px < a.x + ((py - a.y) * (b.x - a.x)) / (b.y - a.y)) inside = !inside;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 1e-12 ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len2)) : 0;
    const d = Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
    if (d < best) best = d;
  }
  return inside ? 0 : best;
}
