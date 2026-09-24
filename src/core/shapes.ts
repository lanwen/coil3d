// Convex-outline math shared by every core shape (docs/research.md §2
// ShapePlugin interface, §3 Steiner perimeter). Issue #6 widens this from
// round-only to a small registry of "rounded regular n-gon" shapes: round,
// rounded square and rounded triangle. Ported from spikes/s1-grooved-wall/geom.ts
// (outline evaluation + arc-length parameterisation) and
// spikes/s5-solver/src/solver/shapes.ts (per-shape size semantics), with the
// footprint bug flagged in docs/research.md §10a fixed: `circumscribedRadius`
// below is the TRUE offset outline's farthest point (a corner-arc midpoint),
// not a worst-case bounding circle across a sharp corner.
//
// A "ShapeOutline" is a regular n-gon with its corners rounded to a shared
// radius, described by only 3 numbers: `n` (corner count), `apothem`
// (center-to-flat-side distance at offset 0) and `cornerRadius` (at offset
// 0). Round is the degenerate case n=4, cornerRadius=apothem: 4 quarter-turn
// arcs with zero-length sides between them, which together already trace a
// full circle -- so every function below (perimeter, point/normal, offset)
// handles round for free, with no special casing.
//
// Size semantics (docs/research.md §1, issue #6 AC): round=diameter,
// square=across flats, triangle=inscribed-circle diameter. All three are
// chosen so that `apothem === size / 2` uniformly, which is what lets the
// solver's search bounds (SIZE_LO_FLOOR..SIZE_HI, the bend-limit floor) stay
// shape-agnostic (solve.ts).

export type ShapeKind = "round" | "sq" | "tri";
export type SizeSemantics = "diameter" | "acrossFlats" | "inscribedDiameter";

export interface ShapeOutline {
  /** Corner count (round: 4, by convention -- see file header). */
  n: number;
  /** Center-to-flat-side distance at offset 0, mm. */
  apothem: number;
  /** Corner radius at offset 0, mm. Round: always equals `apothem`. */
  cornerRadius: number;
}

export interface ShapePlugin {
  kind: ShapeKind;
  label: string;
  sizeSemantics: SizeSemantics;
  /** Corners of a shape's outline (round has none of its own; see file header). */
  corners: number;
  /** Corner radius beyond which the shape is fully rounded (straight sides vanish) -- always `size / 2`, see file header. */
  maxCornerRadius(size: number): number;
}

const round: ShapePlugin = {
  kind: "round",
  label: "Round",
  sizeSemantics: "diameter",
  corners: 4,
  maxCornerRadius: (size) => size / 2,
};

const sq: ShapePlugin = {
  kind: "sq",
  label: "Rounded square",
  sizeSemantics: "acrossFlats",
  corners: 4,
  maxCornerRadius: (size) => size / 2,
};

const tri: ShapePlugin = {
  kind: "tri",
  label: "Rounded triangle",
  sizeSemantics: "inscribedDiameter",
  corners: 3,
  maxCornerRadius: (size) => size / 2, // apothem === inscribed radius === size/2, see file header
};

export const SHAPES: Record<ShapeKind, ShapePlugin> = { round, sq, tri };

export function shapePlugin(kind: ShapeKind): ShapePlugin {
  return SHAPES[kind];
}

/** Build the offset-0 outline for a shape, size and corner radius. Only
 * convex outlines are representable: `cornerRadius` is clamped into
 * [0, maxCornerRadius(size)] (round ignores it and is always fully round). */
export function makeOutline(kind: ShapeKind, size: number, cornerRadius: number): ShapeOutline {
  const apothem = size / 2;
  if (kind === "round") return { n: round.corners, apothem, cornerRadius: apothem };
  const plugin = SHAPES[kind];
  const rc = Math.min(Math.max(cornerRadius, 0), plugin.maxCornerRadius(size));
  return { n: plugin.corners, apothem, cornerRadius: rc };
}

/** Length of one straight side at offset 0 (0 for a fully-rounded outline). */
export function sideLength(o: ShapeOutline): number {
  return 2 * (o.apothem - o.cornerRadius) * Math.tan(Math.PI / o.n);
}

/** Sum of all straight-segment lengths at offset 0 (docs/research.md §2 "straightLength"). */
export function straightLength(o: ShapeOutline): number {
  return o.n * sideLength(o);
}

/** Steiner offset perimeter: P(o) = S + 2*pi*(cornerRadius + offset). Holds
 * for any convex rounded outline, regardless of corner count. */
export function offsetPerimeter(o: ShapeOutline, offset: number): number {
  return straightLength(o) + 2 * Math.PI * (o.cornerRadius + offset);
}

/** Inscribed-circle radius at the given offset (docs/research.md §2 "inscribedRadius"): unaffected by cornerRadius, since rounding a corner never moves the middle of a flat side. */
export function inscribedRadius(o: ShapeOutline, offset: number): number {
  return o.apothem + offset;
}

/**
 * TRUE enclosed area of the offset outline (issue #23): the outline is the
 * Minkowski sum of a sharp-corner "core" polygon (apothem `o.apothem -
 * o.cornerRadius`, invariant under offset -- rounding/offsetting only grows
 * the corner disk, see `offsetPerimeter`) with a disk of radius `o.cornerRadius
 * + offset`, so its area is the standard polygon-plus-disk decomposition:
 * `Area(core polygon) + Perimeter(core polygon)*rc + pi*rc^2`. This replaces
 * a bounding-circle volume estimate (`pi/4 * envelopeDiameter^2`), which
 * overstates a round core's swept volume for nothing (round has no corners
 * to bulge past) but understates how much SMALLER a square/triangle core's
 * true footprint is than its circumscribed bounding circle (docs/research.md
 * §10a) -- see solve.ts's `envelopeVolumeFor`. Round reduces to `pi*rc^2` for
 * free (innerApothem = 0, same as `pi/4*diameter^2`).
 */
export function offsetArea(o: ShapeOutline, offset: number): number {
  const half = Math.PI / o.n;
  const innerApothem = o.apothem - o.cornerRadius;
  const rc = o.cornerRadius + offset;
  return o.n * innerApothem * innerApothem * Math.tan(half) + 2 * o.n * innerApothem * Math.tan(half) * rc + Math.PI * rc * rc;
}

/**
 * TRUE circumscribed radius of the offset outline: the farthest point from
 * center is always the midpoint of a corner arc, at distance `Rc + cornerRadius
 * + offset`, where `Rc` is the corner arc's own center distance from the
 * shape's center. This replaces the spike's worst-case "sharp corner"
 * bounding-circle estimate (docs/research.md §10a: "the envelope uses a
 * bounding circle, which overstates square flanges") with the outline's own
 * exact extent -- round reduces to `apothem + offset` for free (Rc = 0).
 */
export function circumscribedRadius(o: ShapeOutline, offset: number): number {
  const half = Math.PI / o.n;
  const Rc = (o.apothem - o.cornerRadius) / Math.cos(half);
  return Rc + o.cornerRadius + offset;
}

/** A Minkowski offset outward by `amount` (negative = inward). Both
 * `apothem` and `cornerRadius` shift by the same amount (Steiner); the
 * caller is responsible for flooring an inward offset that would invert the
 * outline (see design.ts's bore construction). */
export function offsetOutline(o: ShapeOutline, amount: number): ShapeOutline {
  return { n: o.n, apothem: o.apothem + amount, cornerRadius: o.cornerRadius + amount };
}

/** A position on the outline, independent of offset: an arc (even `seg`,
 * corner index seg/2) or a side (odd `seg`, side index (seg-1)/2), plus a
 * local fraction `u` in [0,1]. */
export interface OutlineParam {
  seg: number;
  u: number;
}

/** Point + outward unit normal on the outline at (param, offset). Ported
 * verbatim from spikes/s1-grooved-wall/geom.ts's `evalOutline`. */
export function evalOutline(o: ShapeOutline, p: OutlineParam, offset: number): { x: number; y: number; nx: number; ny: number } {
  const n = o.n;
  const half = Math.PI / n;
  const Rc = (o.apothem - o.cornerRadius) / Math.cos(half);
  const i = p.seg >> 1;
  const th = (2 * Math.PI * i) / n;
  const cx = Rc * Math.cos(th);
  const cy = Rc * Math.sin(th);
  const r = o.cornerRadius + offset;
  if ((p.seg & 1) === 0) {
    const psi = th - half + p.u * 2 * half;
    const nx = Math.cos(psi);
    const ny = Math.sin(psi);
    return { x: cx + r * nx, y: cy + r * ny, nx, ny };
  }
  const th2 = (2 * Math.PI * (i + 1)) / n;
  const dx = Rc * Math.cos(th2) - cx;
  const dy = Rc * Math.sin(th2) - cy;
  const psi = th + half;
  const nx = Math.cos(psi);
  const ny = Math.sin(psi);
  return { x: cx + p.u * dx + r * nx, y: cy + p.u * dy + r * ny, nx, ny };
}

/** Map an arc-length fraction t in [0,1) (measured at the given reference
 * offset) to an `OutlineParam`. Ported from spikes/s1-grooved-wall/geom.ts's
 * `paramAt`. */
export function paramAt(o: ShapeOutline, offset: number, t: number): OutlineParam {
  const arc = ((2 * Math.PI) / o.n) * (o.cornerRadius + offset);
  const side = sideLength(o);
  const P = o.n * (arc + side);
  let s = (((t % 1) + 1) % 1) * P;
  for (let i = 0; i < o.n; i++) {
    if (s <= arc || (side <= 1e-9 && i === o.n - 1)) return { seg: 2 * i, u: Math.min(1, arc > 0 ? s / arc : 0) };
    s -= arc;
    if (s <= side) return { seg: 2 * i + 1, u: side > 0 ? s / side : 0 };
    s -= side;
  }
  return { seg: 2 * o.n - 1, u: 1 };
}

/** The point + normal at arc-length fraction t (reference offset 0) and the
 * given (possibly different) offset -- the one function wall.ts's helix and
 * step/build.ts's B-spline fit both sample.
 *
 * `evalOutline`/`paramAt`'s corner-arc-length bookkeeping starts `t=0` at the
 * BEGINNING of corner 0's arc (`psi = th - half` there, not `psi = th`), so a
 * fully-rounded outline's `t=0` sits at angle `-pi/n`, not angle 0 -- a
 * constant rotation with no effect on any shape's perimeter, area, volume,
 * manifoldness or wall-to-bore/flange alignment (a uniform rotation of the
 * whole cross-section), but a REAL regression for round: it silently rotated
 * the previously-committed round coil's groove/seam by `-pi/4` relative to
 * the tracer bullet's exact circle formula (`theta = 2*pi*t`), which this PR
 * is not meant to change. `cornerRadius === apothem` is true only for an
 * EXACT circle (any `n`: zero-length sides, corners covering the full
 * 2*pi), so it's a closed-form special case, not a hack -- and it leaves
 * sq/tri (which never hit this equality; the "became round" clamp keeps a
 * hairline side via SHAPE_ROUNDING_EPS) on the untouched general path. */
export function pointAt(o: ShapeOutline, t: number, offset: number): { x: number; y: number; nx: number; ny: number } {
  if (o.cornerRadius === o.apothem) {
    const theta = 2 * Math.PI * t;
    const nx = Math.cos(theta);
    const ny = Math.sin(theta);
    const r = o.apothem + offset;
    return { x: nx * r, y: ny * r, nx, ny };
  }
  return evalOutline(o, paramAt(o, 0, t), offset);
}

/** The (rc=0) sharp-corner polygon's vertex `i` (0..n-1), independent of
 * `cornerRadius`: every corner arc's midpoint sits on this same vertex once
 * rc -> 0 (see step/build.ts, which fillets this sharp polygon by
 * `cornerRadius` to get the true rounded outline as a CAD solid). */
export function polygonVertex(o: ShapeOutline, i: number): [number, number] {
  const half = Math.PI / o.n;
  const Rv = o.apothem / Math.cos(half);
  const theta = (2 * Math.PI * i) / o.n;
  return [Rv * Math.cos(theta), Rv * Math.sin(theta)];
}
