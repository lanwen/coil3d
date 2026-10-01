// Convex-outline math shared by every core shape (docs/design.md, Shapes and
// Capacity math). Issue #6 widens this from round-only to a small registry of
// "rounded regular n-gon" shapes: round, rounded square and rounded
// triangle. The outline evaluation and arc-length parameterisation come from
// an early prototype. `circumscribedRadius` below is the TRUE offset outline's farthest point (a corner-arc midpoint),
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
// Size semantics (docs/design.md, Decisions; issue #6 AC): round=diameter,
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

/** Sum of all straight-segment lengths at offset 0 (docs/design.md, Shapes). */
export function straightLength(o: ShapeOutline): number {
  return o.n * sideLength(o);
}

/** Steiner offset perimeter: P(o) = S + 2*pi*(cornerRadius + offset). Holds
 * for any convex rounded outline, regardless of corner count. */
export function offsetPerimeter(o: ShapeOutline, offset: number): number {
  return straightLength(o) + 2 * Math.PI * (o.cornerRadius + offset);
}

/** Inscribed-circle radius at the given offset (docs/design.md, Shapes): unaffected by cornerRadius, since rounding a corner never moves the middle of a flat side. */
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
 * true footprint is than its circumscribed bounding circle (docs/design.md,
 * Shapes) -- see solve.ts's `envelopeVolumeFor`. Round reduces to `pi*rc^2` for
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
 * shape's center. This replaces a worst-case "sharp corner"
 * bounding-circle estimate (which overstates square flanges) with the outline's own
 * exact extent -- round reduces to `apothem + offset` for free (Rc = 0).
 */
export function circumscribedRadius(o: ShapeOutline, offset: number): number {
  const half = Math.PI / o.n;
  const Rc = (o.apothem - o.cornerRadius) / Math.cos(half);
  return Rc + o.cornerRadius + offset;
}

/**
 * EXACT distance from the outline's centre to its own boundary at a given
 * STANDARD angle (radians, measured counter-clockwise from +X -- the same
 * convention `evalOutline` places corner i at, `2*pi*i/n`). Unlike
 * `circumscribedRadius`/`inscribedRadius` (the worst/best case across ANY
 * angle -- deliberately angle-agnostic, for callers that don't know or care
 * which way a shape is rotated), this is the true value at ONE specific
 * angle: exactly `apothem` at a flat side's own midpoint, growing smoothly
 * to `circumscribedRadius` at a corner's own midpoint (a ray-circle
 * intersection against that corner's own arc), and `apothem / cos(delta)`
 * on the straight side in between (a ray-line intersection against a line
 * whose own perpendicular distance from the centre is exactly `apothem`).
 * Used by mount.ts to size the screw-keyhole mount tightly around whichever
 * exact angle(s) it actually places a slot at, instead of assuming the
 * worst case (a sharp corner) everywhere regardless of where the slot
 * really sits (issue #13 PR review).
 *
 * Issue #92: an earlier version drew the arc-vs-flat-side cutoff at
 * `asin(cornerRadius/Rc)` -- the half-angle (from the centre) of the cone
 * inside which a ray merely INTERSECTS the corner arc's own full circle.
 * That is not the same angle as the arc's actual tangent point with the
 * flat side (where the arc's own sweep, `psi` in `evalOutline`, ends), and
 * the two only coincide as `cornerRadius -> 0`: the asin cutoff grows
 * unboundedly wider than the true tangent-point angle as `cornerRadius`
 * grows relative to `Rc` (it even saturates at a fixed 90 degrees once
 * `cornerRadius >= Rc`, via the `Math.min(1, ...)` clamp, regardless of `n`),
 * so once an offset made `cornerRadius` large enough it swallowed angles that
 * are genuinely on the flat side into the corner-arc branch, returning that
 * arc's own (smaller, wrong) ray/circle intersection instead of the flat
 * side's true, larger boundary distance -- reproduced exactly by wire.ts's
 * `outlineHuggingBridge` doc comment (a rounded square, apothem=31.45,
 * cornerRadius=14.44, offset=4.2, misclassifying the flat side's own
 * 45-degree midpoint: ~24.6mm returned vs. ~35.7mm true).
 *
 * The fix: the tangent point is exactly `evalOutline`'s own arc endpoint,
 * `psi = th +- half` (this corner's centre direction `th`, swept by the full
 * corner half-angle `half = pi/n`) at radius `o.cornerRadius` from that arc's
 * own centre (Rc, 0) in the corner-local frame -- i.e. the fixed point `(Rc +
 * cornerRadius*cos(half), cornerRadius*sin(half))`. Its OWN angle as seen
 * from the shape's centre, `atan2(cornerRadius*sin(half), Rc +
 * cornerRadius*cos(half))`, is the true cutoff: it's always < `half` (so it
 * never swallows the whole side even as `cornerRadius -> Infinity` -- a
 * ratio of `sin`/`(Rc/cornerRadius + cos)` that itself tends to `tan(half)`
 * in that limit, i.e. the cutoff angle tends to `half` itself, matching the
 * fully-rounded limit where the flat side's own length -- offset-invariant,
 * see `sideLength` -- shrinks to an ever-thinner sliver of the angular range
 * but never truly zero for a finite `cornerRadius`), and it needs no
 * `Math.min` clamp the old cutoff did.
 */
export function radiusAtAngle(o: ShapeOutline, phi: number): number {
  if (o.cornerRadius === o.apothem) return o.apothem; // round: no bulge anywhere
  const half = Math.PI / o.n;
  const Rc = (o.apothem - o.cornerRadius) / Math.cos(half);
  const cornerHalfAngle = Math.atan2(o.cornerRadius * Math.sin(half), Rc + o.cornerRadius * Math.cos(half));
  const step = (2 * Math.PI) / o.n;
  const nearestI = Math.round(phi / step);
  const delta = phi - nearestI * step;
  if (Math.abs(delta) <= cornerHalfAngle) {
    // On corner `nearestI`'s own rounded arc (centre at distance Rc, radius cornerRadius): a ray-circle intersection, the far root (the ray starts inside the arc's own circle whenever this corner's arc actually reaches the centre-ward side, and Rc<=circumscribedRadius always keeps this real by construction).
    return Rc * Math.cos(delta) + Math.sqrt(Math.max(0, o.cornerRadius * o.cornerRadius - (Rc * Math.sin(delta)) ** 2));
  }
  // On the flat side adjacent to corner `nearestI`, on whichever side `phi` leans: a ray-line intersection against a line at perpendicular distance `apothem` from the centre, foot at the side's own midpoint angle.
  const sideIndex = delta > 0 ? nearestI : nearestI - 1;
  const thetaMid = (sideIndex + 0.5) * step;
  return o.apothem / Math.cos(phi - thetaMid);
}

/** A Minkowski offset outward by `amount` (negative = inward). Both
 * `apothem` and `cornerRadius` shift by the same amount (Steiner); the
 * caller is responsible for flooring an inward offset that would invert the
 * outline (see design.ts's bore construction). */
export function offsetOutline(o: ShapeOutline, amount: number): ShapeOutline {
  return { n: o.n, apothem: o.apothem + amount, cornerRadius: o.cornerRadius + amount };
}

/**
 * Minimum corner-arc segments for a given "segments per 90 degrees of
 * sweep" density, scaled to `o`'s own actual corner sweep angle (issue #85):
 * a square's 90-degree corners take the density as-is, but a triangle's
 * 120-degree corners need proportionally more segments to read equally
 * smooth. Round has no corner arc of its own (see this file's header, and
 * `outlineColumnParams` below), so this is never actually consulted for it.
 */
export function minCornerSegments(o: ShapeOutline, segmentsPer90Deg: number): number {
  const sweepDeg = 360 / o.n;
  return Math.max(1, Math.ceil((segmentsPer90Deg * sweepDeg) / 90));
}

/**
 * Adaptive column sampling (issue #85, "rounded corners look faceted"): a
 * plain arc-length-uniform `t = i / columns` (the scheme every mesh builder
 * used before this) spreads a fixed column budget across the WHOLE
 * perimeter in proportion to arc length -- fine for round, whose entire
 * boundary is one uniform curve, but for a rounded square/triangle the
 * corner arcs are a much SMALLER share of the perimeter than the straight
 * sides flanking them (a 60mm rounded square with an 8mm corner radius puts
 * barely 5 of 96 columns on EACH 90-degree corner), so the corners end up
 * visibly faceted while the straight sides -- which need no curvature at
 * all -- get most of the budget. This redistributes `requestedColumns`
 * instead: each of the outline's `n` (identical, by construction -- a
 * regular n-gon) corner arcs gets at least `minSegments` columns (see
 * `minCornerSegments`), and each of its `n` identical straight sides gets
 * whatever's left, split evenly (still at least 1, so a near-fully-rounded
 * outline's hairline SHAPE_ROUNDING_EPS side never divides by zero). The
 * actual column count returned may exceed `requestedColumns` when the floor
 * forces it to (reported by the caller, not silently absorbed -- mind the
 * triangle budget).
 *
 * Round (or a corner radius clamped to exactly `apothem`, `sideLength`
 * returns exactly 0 -- see that function) reduces to the OLD plain
 * arc-length-uniform sampling, unchanged: an already-uniform curve has no
 * corner/side distinction to redistribute, and this keeps every existing
 * round golden number (test/golden-round.test.ts) byte-identical.
 *
 * Returns arc-length fractions `t` in [0,1), exactly what `pointAt`/
 * `evalOutline` already consume -- callers just replace `i / columns` with
 * this array's entries; nothing about the analytic outline/wall-profile
 * math changes, only WHERE it gets sampled.
 */
export function outlineColumnParams(o: ShapeOutline, requestedColumns: number, minSegments: number): number[] {
  const side = sideLength(o);
  if (side <= 1e-9) {
    const ts: number[] = new Array(requestedColumns);
    for (let i = 0; i < requestedColumns; i++) ts[i] = i / requestedColumns;
    return ts;
  }

  const n = o.n;
  const half = Math.PI / n;
  const arc = 2 * half * o.cornerRadius; // one corner's own arc length
  const perimeter = n * (arc + side);

  // A perfectly sharp corner (cornerRadius 0, no arc to approximate) needs
  // exactly its own vertex, not `minSegments` coincident points.
  const proportionalCorner = Math.round((requestedColumns * arc) / perimeter);
  const cornerSegs = arc <= 1e-9 ? 1 : Math.max(minSegments, proportionalCorner, 1);

  const leftover = requestedColumns - n * cornerSegs;
  const sideSegs = Math.max(1, Math.round(leftover / n));

  const unitLength = arc + side;
  const ts: number[] = [];
  for (let i = 0; i < n; i++) {
    const unitStart = i * unitLength;
    for (let k = 0; k < cornerSegs; k++) ts.push((unitStart + (arc * k) / cornerSegs) / perimeter);
    for (let k = 0; k < sideSegs; k++) ts.push((unitStart + arc + (side * k) / sideSegs) / perimeter);
  }
  return ts;
}

/** A position on the outline, independent of offset: an arc (even `seg`,
 * corner index seg/2) or a side (odd `seg`, side index (seg-1)/2), plus a
 * local fraction `u` in [0,1]. */
export interface OutlineParam {
  seg: number;
  u: number;
}

/** Point + outward unit normal on the outline at (param, offset). Ported
 * verbatim from an early prototype. */
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
 * offset) to an `OutlineParam`. Ported from an early prototype. */
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

/**
 * True arc-length fraction, measured at a DIFFERENT reference `offset`, of
 * the same geometric point `pointAt(o, t, ...)` places at arc-length
 * fraction `t` on the winding surface itself (offset 0) -- issue #103,
 * "groove rings pinch together near a corner/side transition".
 *
 * `t` is defined once and for all as an arc-length fraction of the outline
 * AT OFFSET 0 (`paramAt(o, 0, t)`, `pointAt`'s own doc comment) -- exactly
 * right for PLACING a point (columns should be spread evenly across the
 * winding surface's own perimeter), but wrong wherever `t` gets reused
 * directly as a HELIX PHASE (`wall.ts`'s `z = zStart + pitch*t`): a corner's
 * own arc length changes under a nonzero offset (Steiner: `arc(offset) =
 * 2*(pi/n)*(cornerRadius+offset)`, see `offsetPerimeter`), while a straight
 * side's doesn't (`sideLength` is offset-invariant). So the SAME `dt` sweeps
 * LESS real distance at the groove floor's own (negative, inward) offset
 * than it does at offset 0 -- but only on the corner arcs, never the flat
 * sides -- and a helix phased by raw `t` still advances z by the same
 * `pitch*dt` regardless of which one it's crossing, so it runs locally
 * steeper (in real arc length) exactly where it crosses a corner, bunching
 * consecutive rings together there. (Measured: ~6.5% local pitch distortion
 * at a rounded triangle/square's own default corner radius and groove
 * depth, well past the ticket's 2% floor; round is untouched -- an offset
 * rescales every one of its "corners" identically, so it's a constant
 * global rescale of `t`, invisible since it's the same all the way round.)
 *
 * The fix: re-derive the SAME (seg, u) breakdown `paramAt(o, 0, t)` already
 * computes (an angle-only quantity -- see its own doc comment, unaffected by
 * offset), then re-accumulate arc length up to that (seg, u) using `offset`'s
 * OWN corner-arc length instead of offset 0's. Reduces to `t` unchanged for
 * round and for any fully-rounded outline (`side <= 0`, same fast path
 * `paramAt`/`outlineColumnParams` already use) -- offset cancels out of the
 * fraction identically for every corner, see file header.
 *
 * `wall.ts`'s `createWallProfile` uses this (offset = -grooveDepth, the
 * groove floor's own outline) to re-phase the helix by the arc length of the
 * surface the wire actually sits in, not the un-grooved winding surface's.
 */
export function arcLengthFractionAt(o: ShapeOutline, offset: number, t: number): number {
  const side = sideLength(o);
  if (side <= 1e-9) return (((t % 1) + 1) % 1); // fully rounded (incl. round itself): offset cancels, see header
  const arc = ((2 * Math.PI) / o.n) * (o.cornerRadius + offset);
  const perimeter = o.n * (arc + side);
  const p = paramAt(o, 0, t);
  const i = p.seg >> 1;
  const s = i * (arc + side) + ((p.seg & 1) === 0 ? p.u * arc : arc + p.u * side);
  return s / perimeter;
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

/**
 * How far the point (x, y) sits outside `o`'s own offset-0 outline (negative
 * inside), plus the outward normal at the nearest outline point -- the
 * inverse of `pointAt`'s offset term. Every outline here is the set of
 * points within `cornerRadius + offset` of the corner-centre polygon (radius
 * `Rc`, corner `i` at angle `2*pi*i/n`, see `evalOutline`), so this is just
 * the distance to that convex polygon minus `cornerRadius`. Round's polygon
 * collapses to the origin. Used by innerEnd.ts/wire.ts to place the rim
 * keyholes on a cable's own tangent line (issue #115).
 */
export function outlineOffsetAt(o: ShapeOutline, x: number, y: number): { offset: number; nx: number; ny: number } {
  const n = o.n;
  const Rc = (o.apothem - o.cornerRadius) / Math.cos(Math.PI / n);
  let bestD = Infinity;
  let qx = 0;
  let qy = 0;
  let inside = true;
  for (let i = 0; i < n; i++) {
    const a0 = (2 * Math.PI * i) / n;
    const a1 = (2 * Math.PI * (i + 1)) / n;
    const ax = Rc * Math.cos(a0);
    const ay = Rc * Math.sin(a0);
    const ex = Rc * Math.cos(a1) - ax;
    const ey = Rc * Math.sin(a1) - ay;
    const len2 = ex * ex + ey * ey;
    if (ex * (y - ay) - ey * (x - ax) < 0) inside = false;
    const f = len2 > 1e-18 ? Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / len2)) : 0;
    const px = ax + f * ex;
    const py = ay + f * ey;
    const dist = Math.hypot(x - px, y - py);
    if (dist < bestD) {
      bestD = dist;
      qx = px;
      qy = py;
    }
  }
  if (Rc < 1e-9) inside = false;
  const dx = x - qx;
  const dy = y - qy;
  const len = Math.hypot(dx, dy);
  if (inside || len < 1e-12) {
    // Inside the corner-centre polygon (deep inside the core): not a case
    // the keyholes ever hit; report the plain radial direction.
    const r = Math.hypot(x, y) || 1;
    return { offset: -bestD - o.cornerRadius, nx: x / r, ny: y / r };
  }
  return { offset: len - o.cornerRadius, nx: dx / len, ny: dy / len };
}
