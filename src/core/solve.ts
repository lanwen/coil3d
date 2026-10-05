// Main solver orchestrator: "lock what you know, solve the rest"
// (docs/design.md, Decisions and Capacity math).
// Adapted from an early prototype: connector-pocket sizing is dropped (out
// of scope, see docs/design.md, Roadmap); the flexible-cord bend multiplier
// is fixed to 2.6x (the prototype used 6x); the
// bound-hit check only looks at the actual free variable, not all three;
// and the freeCount===2/3 alternate candidates are picked from an
// already-computed candidate pool instead of a second `solve()` call,
// which in the prototype recursed into itself forever (freeCount stays 2 for
// the recursive call, which then computes its own alternate, forever).
//
// Status rule (issue #199): a design that holds the cable is "ok" (or
// "under-constrained" with all three free), whatever the number of free
// dimensions -- even when the locks or the bend limit force more room than
// the cable needs; that overshoot is a note naming its cause
// (`overshootNote`). "infeasible" (and, fully locked, "over-constrained")
// means the capacity falls short of the target.
//
// Capacity invariant: whenever a dimension is free (freeCount 1-3) and the
// solver reports "ok" or "under-constrained" (not "infeasible"), the
// resolved geometry's capacity covers the target cable length (tail >= 0),
// with the smallest overshoot achievable for that candidate. `bisect`
// below is the mechanism this leans on: it returns the upper bracket `b`,
// which the loop invariant keeps at f(b) >= target throughout, not the
// naive midpoint (which can round down across an integer-turns step and
// silently undershoot -- this bit a height/layers search in practice,
// since turns-per-layer is a step function of height, unlike a
// continuous "size" search).

import { computeCapacity, envelopeDiameter } from "./capacity";
import type { CapacityResult } from "./capacity";
import { centreInnerEndLength, minCentreEndsHeight, minCentreEndsOuterSize } from "./centreEnds";
import { baseEnabled, flangeExtentOf, overallHeightOf, resolveBoreOutline, resolveFlangeSizing } from "./flange";
import { isHeavyCable } from "./skadisClips";
import {
  CENTRE_CONNECTOR_PASSAGE,
  CENTRE_GRIP_LENGTH,
  FLANGE_MARGIN,
  HEIGHT_HI,
  LAYERS_HI,
  MAX_WIRE_LENGTH,
  MIN_TURNS_PER_LAYER,
  SHAPE_ROUNDING_EPS,
  SIZE_HI,
  SIZE_LO_FLOOR,
} from "./constants";
import { makeOutline, offsetArea, shapePlugin } from "./shapes";
import type { ShapeOutline } from "./shapes";
import { bendMultiplierOf, noticeCollector } from "./types";
import { grooveShape, wallThickness, windingSpan } from "./wall";
import type { CoilSpec, Diagnosis, Notice, Objective, ShapeSpec, Solution } from "./types";

/**
 * Bend-limit floor on the corner radius (issue #6): the innermost wound
 * layer's corner must clear the wire's minimum bend radius, exactly like
 * round's `minOuterSizeForBend` below but expressed as a corner-radius floor
 * instead of a size floor -- it's what a non-round shape's corner radius
 * gets clamped UP to (docs/design.md, Capacity math: constraints). Independent of the resolved size.
 */
function bendCornerRadiusFloor(wire: CoilSpec["wire"]): number {
  const mbr = bendMultiplierOf(wire) * wire.diameter;
  const o1 = wire.diameter / 2 - grooveShape(wire.diameter).depth;
  return Math.max(0, mbr - o1);
}

/** The shape outline actually used for a candidate outer size: round is
 * always fully round; sq/tri clamp the requested corner radius into
 * [bend-limit floor, useful max] (see `bendCornerRadiusFloor` and
 * `usefulMaxCornerRadius` below -- issue #134 tightened the old ceiling,
 * literally `outerSize/2` [an exact circle], down to the largest corner
 * radius that still reads as a square/triangle). */
function resolveOutline(shape: ShapeSpec, outerSize: number, rcMin: number, wire: CoilSpec["wire"]): ShapeOutline {
  if (shape.kind === "round") return makeOutline("round", outerSize, outerSize / 2);
  const rcMax = usefulMaxCornerRadius(shape.kind, outerSize, wire);
  const rc = Math.min(Math.max(shape.cornerRadius, rcMin), Math.max(0, rcMax));
  return makeOutline(shape.kind, outerSize, rc);
}

/** Fraction of the outline's own perimeter a straight side must keep to stay meaningfully distinct from round (issue #54). */
const MIN_FLAT_PERIMETER_FRACTION = 0.15;
/** Minimum straight-side length in wire diameters (issue #54): "each flat >= max(2*d, 15% of perimeter)". */
const MIN_FLAT_WIRE_DIAMETERS = 2;

/**
 * Minimum outer size for sq/tri to keep a MEANINGFULLY long straight flat at
 * the bend-limited corner radius (issue #54): with a small core (or a stiff
 * cable whose bend limit alone forces a big corner radius), the corner
 * radius can get clamped up close to the apothem well before it technically
 * hits the "effectively round" floor (`finishSolution`'s own `rcMin >=
 * rcMaxHard`, the TRUE geometric ceiling -- see `usefulMaxCornerRadius`
 * below for the tighter, cosmetic ceiling issue #134 adds on the corner
 * radius's own axis) -- the shape choice becomes invisible even though the
 * solver hasn't (yet) reported it as literally round.
 *
 * At a FIXED corner radius (`rcMin`, the bend limit -- independent of size),
 * a straight side's length grows 1:1 with the apothem (`sideLength =
 * (outerSize/2 - rcMin) * 2 * tan(pi/n)`, shapes.ts), and so does the
 * outline's own perimeter (`straightLength + 2*pi*rcMin`) -- both linear in
 * `outerSize`, so the crossover against each threshold ("2 wire diameters",
 * "15% of perimeter") is a closed-form solve, not a search. The true minimum
 * is whichever crossover is larger: below it, the OTHER threshold is already
 * satisfied (both are monotonic in `outerSize` for n=3,4), so this is exact,
 * not just a safe overestimate.
 */
function minOuterSizeForShapeFlats(kind: Extract<ShapeSpec["kind"], "sq" | "tri">, wire: CoilSpec["wire"]): number {
  const n = shapePlugin(kind).corners;
  const k = Math.tan(Math.PI / n);
  const rcMin = bendCornerRadiusFloor(wire);
  // sideLength(outerSize) >= MIN_FLAT_WIRE_DIAMETERS * d
  //   => (outerSize/2 - rcMin) * 2 * k >= MIN_FLAT_WIRE_DIAMETERS * d
  const sizeForDiameterFloor = 2 * rcMin + (MIN_FLAT_WIRE_DIAMETERS * wire.diameter) / k;
  // sideLength(outerSize) >= MIN_FLAT_PERIMETER_FRACTION * (n*sideLength + 2*pi*rcMin)
  //   => sideLength * (1 - MIN_FLAT_PERIMETER_FRACTION*n) >= MIN_FLAT_PERIMETER_FRACTION * 2*pi*rcMin
  const perimeterMargin = 1 - MIN_FLAT_PERIMETER_FRACTION * n; // > 0 for n=3,4
  const sideLengthForPerimeterFloor = (MIN_FLAT_PERIMETER_FRACTION * 2 * Math.PI * rcMin) / perimeterMargin;
  const sizeForPerimeterFloor = 2 * rcMin + sideLengthForPerimeterFloor / k;
  return Math.max(sizeForDiameterFloor, sizeForPerimeterFloor);
}

/** `minOuterSizeForShapeFlats` for round too (a no-op: round has no flats to keep, so its own bend-limit floor is the whole story) -- one call site for both, so callers never need their own round/non-round branch. */
function minOuterSizeForShape(shape: ShapeSpec, wire: CoilSpec["wire"], minOuterSizeForBend: number): number {
  return shape.kind === "round" ? minOuterSizeForBend : minOuterSizeForShapeFlats(shape.kind, wire);
}

/**
 * Useful maximum corner radius for sq/tri at an already-resolved outer size
 * (issue #134): "with the square or triangle shape, corner radius after
 * some point doesn't change anything and makes it look like a circle" --
 * because the OLD ceiling `resolveOutline` clamped into was literally
 * `outerSize/2 - SHAPE_ROUNDING_EPS`, a hair short of an EXACT circle. Long
 * before a slider reaches that point, the straight sides have already
 * shrunk to an imperceptible sliver, so most of the slider's own range did
 * nothing anyone would notice -- exactly issue #54's "the shape choice
 * becomes invisible" problem, just approached from the corner-radius axis
 * instead of the size axis.
 *
 * This reuses issue #54's own "still distinguishable from round" criterion
 * verbatim (`MIN_FLAT_WIRE_DIAMETERS`/`MIN_FLAT_PERIMETER_FRACTION` above:
 * "each flat >= max(2 wire diameters, 15% of the outline's own perimeter)"),
 * just solved for the OTHER unknown: `minOuterSizeForShapeFlats` fixes the
 * corner radius at the bend floor and searches for the smallest legal outer
 * size; this fixes the outer size (already resolved) and searches for the
 * largest legal corner radius. Both trace the SAME joint (size,
 * cornerRadius) feasibility boundary -- `sideLength` (shapes.ts) grows
 * linearly with size and shrinks linearly with corner radius, and so does
 * the perimeter threshold it's compared against -- so a shape sitting on
 * either boundary reads identically "still a square/triangle". One
 * consequence of sharing the boundary: a resolved size (already raised to
 * >= `minOuterSizeForShapeFlats` at the bend floor, by the solver's own
 * invariant elsewhere) always keeps this useful max at or above that same
 * bend floor -- the two criteria never disagree about which corner radius
 * is legal.
 *
 * Closed form, not a search: `sideLength(cr) = 2*(apothem-cr)*tan(pi/n)`
 * and `perimeter(cr) = n*sideLength(cr) + 2*pi*cr` are both affine in `cr`,
 * so each inequality solves directly to an upper bound on `cr`; the
 * tighter (smaller) one binds, since either threshold can dominate
 * depending on `n` and `outerSize` (matching `minOuterSizeForShapeFlats`'s
 * own `Math.max` of its two crossovers -- there the larger size wins,
 * here the smaller corner radius does, because corner radius and size
 * move in OPPOSITE directions along the same boundary).
 *
 * Doesn't take `layers` as a parameter, unlike the ticket's own phrasing
 * ("a pure core function of shape, core size, cable, bend limit and
 * layers") -- layers only ever affects this indirectly, through the outer
 * size the solver already resolved around them; once `outerSize` is known,
 * this criterion needs nothing else about how it got there.
 */
function usefulMaxCornerRadius(kind: Extract<ShapeSpec["kind"], "sq" | "tri">, outerSize: number, wire: CoilSpec["wire"]): number {
  const n = shapePlugin(kind).corners;
  const k = Math.tan(Math.PI / n);
  const apothem = outerSize / 2;

  // sideLength(cr) >= MIN_FLAT_WIRE_DIAMETERS * d
  //   2*(apothem-cr)*k >= MIN_FLAT_WIRE_DIAMETERS*d
  //   cr <= apothem - (MIN_FLAT_WIRE_DIAMETERS*d) / (2*k)
  const diameterFloorCr = apothem - (MIN_FLAT_WIRE_DIAMETERS * wire.diameter) / (2 * k);

  // sideLength(cr) >= MIN_FLAT_PERIMETER_FRACTION * (n*sideLength(cr) + 2*pi*cr)
  //   Let A = 2*k*(1 - f*n) (f = MIN_FLAT_PERIMETER_FRACTION; positive for n=3,4):
  //   A*(apothem-cr) >= 2*pi*f*cr  =>  cr <= A*apothem / (A + 2*pi*f)
  const f = MIN_FLAT_PERIMETER_FRACTION;
  const A = 2 * k * (1 - f * n);
  const perimeterFloorCr = (A * apothem) / (A + 2 * Math.PI * f);

  // Never above the hard geometric ceiling (a hairline short of an exact
  // circle, same margin `resolveOutline` always kept -- see
  // SHAPE_ROUNDING_EPS): both closed-form bounds above are already strictly
  // below `apothem` for any physically sane wire diameter, but this keeps
  // that invariant explicit rather than relying on it always holding.
  const hardCeiling = Math.max(0, apothem - SHAPE_ROUNDING_EPS);
  return Math.min(diameterFloorCr, perimeterFloorCr, hardCeiling);
}

/** Relative tolerance on "capacity >= target", to absorb floating-point noise only. */
const CAPACITY_EPS = 1e-6;
/** Overshoot (%) above which the solver says what keeps the coil from getting smaller (the result panel's "more than you need" uses the same 10%). */
const OVERSHOOT_NOTE_PCT = 10;
/** Practical layer-count bound for the (size, height) grid search (freeCount 2's third branch, and freeCount 3). */
const PRACTICAL_LAYERS_HI = 6;

function bisect(f: (x: number) => number, lo: number, hi: number, target: number, iters = 60): number {
  let a = lo;
  let b = hi;
  if (f(a) >= target) return a;
  if (f(b) <= target) return b;
  for (let i = 0; i < iters; i++) {
    const m = (a + b) / 2;
    if (f(m) < target) a = m;
    else b = m;
  }
  // Return the upper bracket, not the midpoint: the loop invariant guarantees
  // f(b) >= target, so this is the smallest-overshoot point that still
  // covers the target. The midpoint has no such guarantee (see file header).
  return b;
}

function solveIntegerUpTo(f: (n: number) => number, lo: number, hi: number, target: number): number {
  let best = lo;
  for (let n = lo; n <= hi; n++) {
    best = n;
    if (f(n) >= target) return n;
  }
  return best;
}

function coversTarget(length: number, target: number): boolean {
  return length >= target * (1 - CAPACITY_EPS);
}

interface Resolved {
  outerSize: number;
  height: number; // full core height, including top/bottom margins
  layers: number;
}

function toOuterSize(lock: Extract<CoilSpec["coreSize"], { locked: true }>, wireDiameter: number): number {
  return lock.dimension === "outer" ? lock.value : lock.value + 2 * wallThickness(wireDiameter);
}

function capacityOf(spec: CoilSpec, quality: number, g: Resolved) {
  const wire = spec.wire;
  const groove = grooveShape(wire.diameter);
  const usableHeight = Math.max(0, windingSpan(g.height, wire.diameter));
  const outline = resolveOutline(spec.shape, g.outerSize, bendCornerRadiusFloor(wire), wire);
  return computeCapacity({
    outline,
    height: usableHeight,
    layers: g.layers,
    wireDiameter: wire.diameter,
    grooveDepth: groove.depth,
    pitch: groove.pitch,
    quality,
  });
}

function endsLengthFor(spec: CoilSpec, g: Resolved): number {
  const d = spec.wire.diameter;
  const outline = resolveOutline(spec.shape, g.outerSize, bendCornerRadiusFloor(spec.wire), spec.wire);
  const { boreOutline } = resolveBoreOutline(outline, d);
  return centreInnerEndLength(outline, boreOutline, d, spec.tolerance, bendMultiplierOf(spec.wire) * d, g.height);
}

function lengthFor(spec: CoilSpec, g: Resolved): number {
  return capacityOf(spec, spec.windingQuality, g).totalWoundLength + endsLengthFor(spec, g);
}

function resolveTopCap(spec: CoilSpec, layers: number): boolean {
  return spec.topCap === "on" ? true : spec.topCap === "off" ? false : layers > 1 && baseEnabled(spec);
}

function centreFloors(spec: CoilSpec): { size: number; height: number } {
  const d = spec.wire.diameter;
  const mbr = bendMultiplierOf(spec.wire) * d;
  const rcMin = bendCornerRadiusFloor(spec.wire);
  const size = minCentreEndsOuterSize((outerSize) => resolveOutline(spec.shape, outerSize, rcMin, spec.wire), (outline) => resolveBoreOutline(outline, d).boreOutline, d, spec.tolerance, mbr);
  return { size, height: minCentreEndsHeight(d, spec.tolerance, mbr) };
}

/**
 * Multiplier that grows quickly once any layer's turn count falls below
 * `MIN_TURNS_PER_LAYER` (issue #23): a squat many-layer stack with only 1-2
 * turns per layer can score as "small volume" purely because height shrinks
 * faster than the envelope grows as layers are added, even though nobody
 * would wind a coil that way. Quadratic in the shortfall so the penalty
 * dominates the volume score well before the shortfall reaches this floor,
 * without hard-excluding the candidate (it can still win if nothing better
 * covers the target length).
 */
function turnsPerLayerPenalty(cap: CapacityResult): number {
  const minTurns = cap.layerResults.reduce((m, l) => Math.min(m, l.turns), Infinity);
  const shortfall = Math.max(0, MIN_TURNS_PER_LAYER - minTurns);
  return 1 + shortfall * shortfall;
}

function realExtentsFor(spec: CoilSpec, g: Resolved, outline: ShapeOutline, cap: CapacityResult): { margin: number; overallHeight: number } {
  const { boreOutline } = resolveBoreOutline(outline, spec.wire.diameter);
  const env = envelopeDiameter(outline, cap.outermostOffset, spec.wire.diameter);
  const flangeSizeEnvelope = env + 2 * FLANGE_MARGIN;
  const topCapEnabled = resolveTopCap(spec, g.layers);
  const baseOn = baseEnabled(spec);
  const { margin, thickness } = resolveFlangeSizing(
    outline,
    boreOutline,
    flangeSizeEnvelope,
    spec.wire.diameter,
    baseOn ? spec.mount : "none",
    { tolerance: spec.tolerance, bendRadius: bendMultiplierOf(spec.wire) * spec.wire.diameter, heavyCable: isHeavyCable(spec.wire.diameter, spec.wire.length), woundLayers: cap.layerResults.filter((r) => r.turns > 0).length, topCap: topCapEnabled },
    spec.keyholeRotation,
    spec.throughHoleDiameter,
    baseOn,
  );
  return { margin, overallHeight: overallHeightOf(thickness, g.height, topCapEnabled) };
}

function envelopeVolumeFor(spec: CoilSpec, g: Resolved): number {
  const cap = capacityOf(spec, spec.windingQuality, g);
  const outline = resolveOutline(spec.shape, g.outerSize, bendCornerRadiusFloor(spec.wire), spec.wire);
  // Real printed-volume proxy (issue #63): the flange's own true footprint
  // area (shapes.ts's `offsetArea`, at the REAL flange margin -- not the
  // wound envelope's own offset) times the REAL overall assembled height
  // (flange bottom to cap top), so the objective optimizes the dimensions
  // that actually end up printed, not an internal estimate that silently
  // omitted the flange margin/thickness and any cap.
  const { margin, overallHeight } = realExtentsFor(spec, g, outline, cap);
  const trueVolume = offsetArea(outline, margin) * overallHeight;
  return trueVolume * turnsPerLayerPenalty(cap);
}

function aspectScoreFor(spec: CoilSpec, g: Resolved): number {
  const cap = capacityOf(spec, spec.windingQuality, g);
  const outline = resolveOutline(spec.shape, g.outerSize, bendCornerRadiusFloor(spec.wire), spec.wire);
  const { margin, overallHeight } = realExtentsFor(spec, g, outline, cap);
  // The real flange's own "across flats" extent (shapes.ts sizeSemantics:
  // round=diameter, square=across flats, triangle=inscribed diameter) --
  // the real, built counterpart of the wound envelope diameter this used to
  // compare against.
  const flangeWidth = flangeExtentOf(outline, margin).acrossFlats;
  return Math.abs(overallHeight - flangeWidth);
}

function scoreOf(objective: Objective): (spec: CoilSpec, g: Resolved) => number {
  return objective === "minVolume" ? envelopeVolumeFor : aspectScoreFor;
}

function finishSolution(
  spec: CoilSpec,
  resolved: Resolved,
  diagnosis: Diagnosis,
  objectiveUsed: Objective | undefined,
  minOuterSizeForBend: number,
  minOuterSizeForShapeVal: number,
): { solution: Solution; notices: Notice[] } {
  const { notices, problem, note } = noticeCollector();
  const target = spec.wire.length;

  const cap = capacityOf(spec, spec.windingQuality, resolved);
  const capLo = capacityOf(spec, 0, resolved);
  const capHi = capacityOf(spec, 1, resolved);
  const ends = endsLengthFor(spec, resolved);
  const totalWireLength = cap.totalWoundLength + ends;
  const lengthLo = capLo.totalWoundLength + ends;
  const lengthHi = capHi.totalWoundLength + ends;

  const rcMin = bendCornerRadiusFloor(spec.wire);
  const rcMaxHard = resolved.outerSize / 2;
  const rcMax = spec.shape.kind === "round" ? rcMaxHard : usefulMaxCornerRadius(spec.shape.kind, resolved.outerSize, spec.wire);
  const outline = resolveOutline(spec.shape, resolved.outerSize, rcMin, spec.wire);
  const cornerRadius = outline.cornerRadius;

  const wall = wallThickness(spec.wire.diameter);
  const innerBore = resolved.outerSize - 2 * wall;
  const env = envelopeDiameter(outline, cap.outermostOffset, spec.wire.diameter);
  const flangeSize = env + 2 * FLANGE_MARGIN;
  const capsAuto = resolved.layers > 1 && baseEnabled(spec);
  const topCapEnabled = resolveTopCap(spec, resolved.layers);
  const deltaPct = ((totalWireLength - target) / target) * 100;

  if (innerBore <= 0) {
    problem(`Wall thickness (${Number(wall.toFixed(1))} mm) leaves no bore at outer size ${resolved.outerSize.toFixed(1)} mm -- increase outer size.`);
  }
  if (env > 500) {
    note(`Envelope footprint is ${env.toFixed(0)} mm -- check this fits your print bed.`);
  }
  if (deltaPct < -10) {
    note(`Resulting capacity is ${deltaPct.toFixed(0)}% vs. the target cable length.`);
  }
  const capacityLo = Math.min(lengthLo, lengthHi);
  if (capacityLo < target * (1 - CAPACITY_EPS)) {
    const pctOfTarget = (capacityLo / target) * 100;
    note(
      `At the loosest winding quality, capacity is only ${capacityLo.toFixed(0)} mm (${pctOfTarget.toFixed(0)}% of the ${target.toFixed(0)} mm target) -- a loose winding may not fit; wind snugly to reach the full target length.`,
    );
  }
  if (spec.shape.kind !== "round") {
    const label = shapePlugin(spec.shape.kind).label.toLowerCase();
    const requested = spec.shape.cornerRadius;
    if (rcMin >= rcMaxHard) {
      problem(
        `The bend limit needs at least a ${rcMin.toFixed(1)} mm corner radius, but the core is only ${resolved.outerSize.toFixed(1)} mm across -- the ${label} core is effectively round.`,
      );
    } else if (requested < rcMin - 1e-9) {
      note(`Corner radius clamped up to ${rcMin.toFixed(1)} mm (requested ${requested.toFixed(1)} mm) to respect the bend limit.`);
    } else if (requested > rcMax + 1e-9) {
      note(`Corner radius clamped down to ${rcMax.toFixed(1)} mm (the largest that still reads as a ${label}, not a circle).`);
    }
  }

  const solution: Solution = {
    diagnosis,
    objectiveUsed,
    outerSize: resolved.outerSize,
    cornerRadius,
    cornerRadiusRange: [Math.min(rcMin, rcMax), rcMax],
    innerBore,
    height: resolved.height,
    layers: resolved.layers,
    layerResults: cap.layerResults,
    totalWoundLength: cap.totalWoundLength,
    totalWireLength,
    targetWireLength: target,
    lengthDeltaPct: deltaPct,
    capacityRange: [Math.min(lengthLo, lengthHi), Math.max(lengthLo, lengthHi)],
    envelopeDiameter: env,
    flangeSize,
    capsAuto,
    topCapEnabled,
    minOuterSizeForBend,
    minOuterSizeForShape: minOuterSizeForShapeVal,
    alternates: [],
  };
  return { solution, notices };
}

interface SizeHeightSearchResult {
  /** The lowest-score candidate whose capacity covers the target, if any. */
  feasible?: { g: Resolved; length: number; score: number };
  /** The candidate that comes closest to the target (by length), even if it falls short -- used only to report a shortfall when nothing is feasible. */
  closest: { g: Resolved; length: number };
}

/**
 * The tight candidate for one height sample (issue #195): the smallest size
 * that covers the target at this height and layer count, and -- when even
 * the size floor already overshoots -- the smallest height that still covers
 * it at that floor. Without the second step a tall sample at the size floor
 * kept every surplus turn (the default cable with all three dimensions free
 * and the "aspectRatio" objective picked +111%), so the overshoot is now at
 * most one turn per layer there, and ~0 wherever the size is free to shrink.
 */
function sizeThenHeight(spec: CoilSpec, height: number, layers: number, sizeLo: number, sizeHi: number, heightLo: number, target: number): Resolved {
  const outerSize = bisect((s) => lengthFor(spec, { outerSize: s, height, layers }), sizeLo, sizeHi, target);
  if (outerSize > sizeLo) return { outerSize, height, layers };
  return { outerSize, height: bisect((h) => lengthFor(spec, { outerSize, height: h, layers }), heightLo, height, target), layers };
}

/**
 * With a free layer count, a candidate only counts when one layer fewer at
 * the same size and height falls short (issue #195): otherwise its last
 * layer is pure overshoot -- e.g. a second layer at the bend-limited size
 * floor, which an "aspectRatio" pick liked for its wider flange.
 */
function needsEveryLayer(spec: CoilSpec, g: Resolved, target: number): boolean {
  return g.layers <= 1 || !coversTarget(lengthFor(spec, { ...g, layers: g.layers - 1 }), target);
}

/** Grid-search height, with the tight size (and, at the size floor, height) per sample, for one layer count of freeCount 3's per-layer-count search. */
function searchSizeAndHeight(
  spec: CoilSpec,
  layers: number,
  sizeLo: number,
  sizeHi: number,
  heightLo: number,
  heightHi: number,
  target: number,
  objective: Objective,
  samples: number,
): SizeHeightSearchResult {
  const score = scoreOf(objective);
  let feasible: { g: Resolved; length: number; score: number } | undefined;
  let closest: { g: Resolved; length: number } | undefined;
  for (let i = 0; i <= samples; i++) {
    const height = heightLo + ((heightHi - heightLo) * i) / samples;
    const g = sizeThenHeight(spec, height, layers, sizeLo, sizeHi, heightLo, target);
    const length = lengthFor(spec, g);
    if (!closest || length > closest.length) closest = { g, length };
    if (coversTarget(length, target) && needsEveryLayer(spec, g, target)) {
      const s = score(spec, g);
      if (!feasible || s < feasible.score) feasible = { g, length, score: s };
    }
  }
  return { feasible, closest: closest! };
}

/** A length in mm without trailing zeros ("80", "70.6"). */
const mm = (v: number) => `${Number(v.toFixed(1))} mm`;

function overshootNote(
  spec: CoilSpec,
  g: Resolved,
  locked: { size: boolean; height: boolean; layers: boolean },
  sizeLo: number,
  heightLo: number,
  deltaPct: number,
): string {
  const target = spec.wire.length;
  const current = lengthFor(spec, g);
  const holdsWithLess = (h: Resolved) => {
    const length = lengthFor(spec, h);
    return coversTarget(length, target) && length < current * (1 - CAPACITY_EPS);
  };
  const causes: string[] = [];
  if (locked.size && holdsWithLess({ ...g, outerSize: bisect((s) => lengthFor(spec, { ...g, outerSize: s }), sizeLo, g.outerSize, target) })) {
    causes.push(`core size (${mm(g.outerSize)})`);
  }
  if (locked.height && holdsWithLess({ ...g, height: bisect((h) => lengthFor(spec, { ...g, height: h }), heightLo, g.height, target) })) {
    causes.push(`height (${mm(g.height)})`);
  }
  if (locked.layers && holdsWithLess({ ...g, layers: solveIntegerUpTo((n) => lengthFor(spec, { ...g, layers: n }), 1, g.layers, target) })) {
    causes.push(`${g.layers} layers`);
  }
  const room = `Room for ${deltaPct.toFixed(0)}% more cable than you need`;
  if (causes.length > 0) {
    const list = causes.length === 1 ? causes[0] : `${causes.slice(0, -1).join(", ")} and ${causes.at(-1)}`;
    return `${room}, because of the locked ${list}. Unlock ${causes.length === 1 ? "it" : "them"} to let the coil get smaller.`;
  }
  if (g.outerSize <= sizeLo + 1e-6) {
    const floor =
      sizeLo <= SIZE_LO_FLOOR
        ? `the core can't be smaller than ${mm(sizeLo)}`
        : centreFloors(spec).size >= sizeLo - 1e-6
          ? `the bore has to let this cable's inner end through at its ${mm(bendMultiplierOf(spec.wire) * spec.wire.diameter)} bend radius, which needs a core of at least ${mm(sizeLo)}`
        : spec.shape.kind === "round"
          ? `this cable's ${mm(bendMultiplierOf(spec.wire) * spec.wire.diameter)} bend radius needs a core of at least ${mm(sizeLo)}`
          : `this cable's bend limit needs a ${shapePlugin(spec.shape.kind).label.toLowerCase()} core of at least ${mm(sizeLo)}`;
    return `${room}: ${floor}, and the fewest turns around it already hold that much. This is the smallest coil for this cable.`;
  }
  return `${room}: the coil can't lose a whole turn or layer and still hold the cable.`;
}

export function solve(rawSpec: CoilSpec): { solution: Solution; notices: Notice[] } {
  const { notices, problem, note } = noticeCollector();

  const spec: CoilSpec =
    rawSpec.wire.length > MAX_WIRE_LENGTH ? { ...rawSpec, wire: { ...rawSpec.wire, length: MAX_WIRE_LENGTH } } : rawSpec;
  if (rawSpec.wire.length > MAX_WIRE_LENGTH) {
    problem(
      `Your cable is ${(rawSpec.wire.length / 10).toFixed(0)} cm long, over the 15 m maximum, so the coil is sized for 15 m.`,
    );
  }

  const bendMultiplier = bendMultiplierOf(spec.wire);
  const mbr = bendMultiplier * spec.wire.diameter;
  const groove = grooveShape(spec.wire.diameter);
  const o1 = spec.wire.diameter / 2 - groove.depth;
  const rcMin = Math.max(0, mbr - o1);
  const minOuterSizeForBend = 2 * rcMin;
  const shapeFloor = minOuterSizeForShape(spec.shape, spec.wire, minOuterSizeForBend);
  const centre = centreFloors(spec);
  const centreBinds = centre.size > shapeFloor + 1e-9;
  const minOuterSizeForShapeVal = Math.max(shapeFloor, centre.size);
  const sizeLo = Math.max(SIZE_LO_FLOOR, minOuterSizeForShapeVal);
  const sizeHi = SIZE_HI;
  const heightLo = Math.max(groove.pitch - windingSpan(0, spec.wire.diameter), centre.height);
  const heightHi = HEIGHT_HI;
  const layersLo = 1;
  const layersHi = LAYERS_HI;

  const sizeFree = !spec.coreSize.locked;
  const heightFree = !spec.height.locked;
  const layersFree = !spec.layers.locked;
  const freeVars: Array<"coreSize" | "height" | "layers"> = [
    ...(sizeFree ? (["coreSize"] as const) : []),
    ...(heightFree ? (["height"] as const) : []),
    ...(layersFree ? (["layers"] as const) : []),
  ];
  const freeCount = freeVars.length as 0 | 1 | 2 | 3;

  let lockedOuterSize = spec.coreSize.locked ? toOuterSize(spec.coreSize, spec.wire.diameter) : undefined;
  if (lockedOuterSize !== undefined && lockedOuterSize < minOuterSizeForShapeVal - 1e-9) {
    const why = centreBinds
      ? `the bore has to let the cable's inner end through at its ${mbr.toFixed(1)} mm bend radius, and pass a ${CENTRE_CONNECTOR_PASSAGE} mm connector past the grip`
      : spec.shape.kind === "round"
        ? `this cable's ${mbr.toFixed(1)} mm bend radius needs at least that much`
        : `this cable's bend limit needs at least that much to keep the ${shapePlugin(spec.shape.kind).label.toLowerCase()} core's straight sides meaningful, or the shape would be indistinguishable from round`;
    note(`Core size raised from ${lockedOuterSize.toFixed(1)} mm to ${minOuterSizeForShapeVal.toFixed(1)} mm: ${why}.`);
    lockedOuterSize = minOuterSizeForShapeVal;
  }
  let lockedHeight = spec.height.locked ? spec.height.value : undefined;
  if (lockedHeight !== undefined && lockedHeight < centre.height - 1e-9) {
    note(`Height raised from ${lockedHeight.toFixed(1)} mm to ${centre.height.toFixed(1)} mm: the core holds the cable's inner end in a ${CENTRE_GRIP_LENGTH} mm grip, then bends it to level at its ${mbr.toFixed(1)} mm bend radius.`);
    lockedHeight = centre.height;
  }
  const lockedLayers = spec.layers.locked ? spec.layers.value : undefined;

  const target = spec.wire.length;
  let resolved: Resolved;
  let diagnosis: Diagnosis;
  let objectiveUsed: Objective | undefined;
  let alternates: Solution[] = [];

  if (freeCount === 0) {
    resolved = { outerSize: lockedOuterSize!, height: lockedHeight!, layers: lockedLayers! };
    const computed = lengthFor(spec, resolved);
    const deltaPct = ((computed - target) / target) * 100;
    if (coversTarget(computed, target)) {
      diagnosis = { freeCount, freeVariables: freeVars, status: "ok", message: "Fully constrained; the locked geometry holds the target length." };
    } else {
      diagnosis = {
        freeCount,
        freeVariables: freeVars,
        status: "over-constrained",
        message: `Fully constrained geometry falls short of capacity by ${Math.abs(deltaPct).toFixed(0)}% -- the cable will not fit. Release the outer size, height, or layers lock to let the solver fix this.`,
      };
    }
  } else if (freeCount === 1) {
    if (sizeFree) {
      const size = bisect((s) => lengthFor(spec, { outerSize: s, height: lockedHeight!, layers: lockedLayers! }), sizeLo, sizeHi, target);
      resolved = { outerSize: size, height: lockedHeight!, layers: lockedLayers! };
    } else if (heightFree) {
      const height = bisect((h) => lengthFor(spec, { outerSize: lockedOuterSize!, height: h, layers: lockedLayers! }), heightLo, heightHi, target);
      resolved = { outerSize: lockedOuterSize!, height, layers: lockedLayers! };
    } else {
      const layers = solveIntegerUpTo((n) => lengthFor(spec, { outerSize: lockedOuterSize!, height: lockedHeight!, layers: n }), layersLo, layersHi, target);
      resolved = { outerSize: lockedOuterSize!, height: lockedHeight!, layers };
    }
    const computed = lengthFor(spec, resolved);
    const deltaPct = ((computed - target) / target) * 100;

    if (!coversTarget(computed, target)) {
      diagnosis = {
        freeCount,
        freeVariables: freeVars,
        status: "infeasible",
        message: `The target cable length is unreachable within practical bounds even with this dimension maxed out (falls short by ${Math.abs(deltaPct).toFixed(0)}%). Lock a shorter target or free another dimension.`,
      };
    } else {
      diagnosis = {
        freeCount,
        freeVariables: freeVars,
        status: "ok",
        message: "Solved directly for the single free dimension; capacity covers the target with the smallest overshoot.",
      };
    }
  } else if (freeCount === 2) {
    const objective = spec.objective;
    objectiveUsed = objective;

    type Candidate = { g: Resolved; length: number };
    const candidates: Candidate[] = [];

    if (layersFree && sizeFree && !heightFree) {
      for (let n = layersLo; n <= layersHi; n++) {
        const size = bisect((s) => lengthFor(spec, { outerSize: s, height: lockedHeight!, layers: n }), sizeLo, sizeHi, target);
        const g = { outerSize: size, height: lockedHeight!, layers: n };
        candidates.push({ g, length: lengthFor(spec, g) });
      }
    } else if (layersFree && heightFree && !sizeFree) {
      for (let n = layersLo; n <= layersHi; n++) {
        const height = bisect((h) => lengthFor(spec, { outerSize: lockedOuterSize!, height: h, layers: n }), heightLo, heightHi, target);
        const g = { outerSize: lockedOuterSize!, height, layers: n };
        candidates.push({ g, length: lengthFor(spec, g) });
      }
    } else {
      const SAMPLES = 48;
      for (let i = 0; i <= SAMPLES; i++) {
        const height = heightLo + ((heightHi - heightLo) * i) / SAMPLES;
        const g = sizeThenHeight(spec, height, lockedLayers!, sizeLo, sizeHi, heightLo, target);
        candidates.push({ g, length: lengthFor(spec, g) });
      }
    }

    const feasible = candidates.filter((c) => coversTarget(c.length, target) && (!layersFree || needsEveryLayer(spec, c.g, target)));

    if (feasible.length === 0) {
      const closest = candidates.reduce((a, b) => (b.length > a.length ? b : a));
      const shortfallPct = ((target - closest.length) / target) * 100;
      resolved = closest.g;
      diagnosis = {
        freeCount,
        freeVariables: freeVars,
        status: "infeasible",
        message: `Two free dimensions: no sampled combination reaches the target length within practical bounds (the best falls short by ${shortfallPct.toFixed(0)}%). Free the third dimension or shorten the target.`,
      };
    } else {
      const pickBest = (o: Objective) => {
        const score = scoreOf(o);
        let best = feasible[0];
        let bestScore = score(spec, best.g);
        for (const c of feasible.slice(1)) {
          const s = score(spec, c.g);
          if (s < bestScore) {
            best = c;
            bestScore = s;
          }
        }
        return best;
      };

      const primary = pickBest(objective);
      resolved = primary.g;
      diagnosis = {
        freeCount,
        freeVariables: freeVars,
        status: "ok",
        message: `Two free dimensions: picked the "${objective}" candidate among solutions that cover the target length with the smallest overshoot. See the alternate candidate for comparison.`,
      };

      const otherObjective: Objective = objective === "minVolume" ? "aspectRatio" : "minVolume";
      const altBest = pickBest(otherObjective);
      const sameGeometry = altBest.g.outerSize === primary.g.outerSize && altBest.g.height === primary.g.height && altBest.g.layers === primary.g.layers;
      if (!sameGeometry) {
        const altDiagnosis: Diagnosis = {
          ...diagnosis,
          message: `Two free dimensions: the "${otherObjective}" objective's pick among the same target-covering candidates.`,
        };
        alternates = [finishSolution(spec, altBest.g, altDiagnosis, otherObjective, minOuterSizeForBend, minOuterSizeForShapeVal).solution];
      }
    }
  } else {
    const objective = spec.objective;
    objectiveUsed = objective;
    const SAMPLES = 32;

    const perLayer: Array<{ n: number; result: SizeHeightSearchResult }> = [];
    for (let n = 1; n <= PRACTICAL_LAYERS_HI; n++) {
      perLayer.push({ n, result: searchSizeAndHeight(spec, n, sizeLo, sizeHi, heightLo, heightHi, target, objective, SAMPLES) });
    }

    const feasiblePerLayer = perLayer
      .filter((p) => p.result.feasible)
      .map((p) => ({ n: p.n, g: p.result.feasible!.g, length: p.result.feasible!.length, score: p.result.feasible!.score }));

    if (feasiblePerLayer.length === 0) {
      const closestOverall = perLayer.reduce((a, b) => (b.result.closest.length > a.result.closest.length ? b : a));
      const shortfallPct = ((target - closestOverall.result.closest.length) / target) * 100;
      resolved = closestOverall.result.closest.g;
      diagnosis = {
        freeCount,
        freeVariables: freeVars,
        status: "infeasible",
        message: `All three dimensions are free, but even the best sampled combination (up to ${PRACTICAL_LAYERS_HI} layers) falls short of the target length by ${shortfallPct.toFixed(0)}%. Increase the practical bounds or shorten the target.`,
      };
    } else {
      feasiblePerLayer.sort((a, b) => a.score - b.score);
      const primary = feasiblePerLayer[0];
      resolved = primary.g;
      diagnosis = {
        freeCount,
        freeVariables: freeVars,
        status: "under-constrained",
        message: `All three dimensions are free: picked layers=${primary.n} by the "${objective}" objective among combinations that cover the target length. Lock at least one dimension for a deterministic result.`,
      };

      const chosenNs = new Set([primary.n]);
      const altPicks: typeof feasiblePerLayer = [];
      for (const wantN of [1, 2]) {
        const found = feasiblePerLayer.find((p) => p.n === wantN && !chosenNs.has(p.n));
        if (found) {
          altPicks.push(found);
          chosenNs.add(found.n);
        }
      }
      for (const p of feasiblePerLayer) {
        if (altPicks.length >= 2) break;
        if (chosenNs.has(p.n)) continue;
        altPicks.push(p);
        chosenNs.add(p.n);
      }
      alternates = altPicks.map((p) => {
        const altDiagnosis: Diagnosis = {
          freeCount,
          freeVariables: freeVars,
          status: "under-constrained",
          message: `All three dimensions are free: layers=${p.n} fixed, best outer size/height for the "${objective}" objective among combinations that cover the target length.`,
        };
        return finishSolution(spec, p.g, altDiagnosis, objective, minOuterSizeForBend, minOuterSizeForShapeVal).solution;
      });
    }
  }

  const finished = finishSolution(spec, resolved, diagnosis, objectiveUsed, minOuterSizeForBend, minOuterSizeForShapeVal);
  finished.solution.alternates = alternates;
  if (finished.solution.lengthDeltaPct > OVERSHOOT_NOTE_PCT) {
    note(overshootNote(spec, resolved, { size: !sizeFree, height: !heightFree, layers: !layersFree }, sizeLo, heightLo, finished.solution.lengthDeltaPct));
  }
  return { solution: finished.solution, notices: [...notices, ...finished.notices] };
}
