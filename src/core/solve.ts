// Main solver orchestrator: "lock what you know, solve the rest"
// (docs/research.md §1 solver model, §3 capacity math and constraints).
// Adapted from spikes/s5-solver/src/solver/solve.ts (see RESULT.md):
// connector-pocket sizing is dropped (out of scope, docs/research.md
// "Out of Scope"); the flexible-cord bend multiplier is fixed to 4x (the
// spike used 6x, which contradicts docs/research.md §1's decision); the
// bound-hit check only looks at the actual free variable, not all three;
// and the freeCount===2/3 alternate candidates are picked from an
// already-computed candidate pool instead of a second `solve()` call,
// which in the spike recursed into itself forever (freeCount stays 2 for
// the recursive call, which then computes its own alternate, forever).
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
import {
  MARGIN,
  CLEARANCE,
  FLANGE_MARGIN,
  GROOVE_DEPTH_FACTOR,
  HEIGHT_HI,
  LAYERS_HI,
  MAX_WIRE_LENGTH,
  MIN_TURNS_PER_LAYER,
  SHAPE_ROUNDING_EPS,
  SIZE_HI,
  SIZE_LO_FLOOR,
  WALL_THICKNESS,
} from "./constants";
import { makeOutline, offsetArea, shapePlugin } from "./shapes";
import type { ShapeOutline } from "./shapes";
import { bendMultiplierOf } from "./types";
import type { CoilSpec, Diagnosis, Objective, ShapeSpec, Solution } from "./types";

/**
 * Bend-limit floor on the corner radius (issue #6): the innermost wound
 * layer's corner must clear the wire's minimum bend radius, exactly like
 * round's `minOuterSizeForBend` below but expressed as a corner-radius floor
 * instead of a size floor -- it's what a non-round shape's corner radius
 * gets clamped UP to (docs/research.md §2 "cornerRadiusRange", spikes/s1
 * RESULT.md "bend radius vs size"). Independent of the resolved size.
 */
function bendCornerRadiusFloor(wire: CoilSpec["wire"]): number {
  const mbr = bendMultiplierOf(wire) * wire.diameter;
  const o1 = wire.diameter / 2 - GROOVE_DEPTH_FACTOR * wire.diameter;
  return Math.max(0, mbr - o1);
}

/** The shape outline actually used for a candidate outer size: round is
 * always fully round; sq/tri clamp the requested corner radius into
 * [bend-limit floor, outerSize/2] (see `bendCornerRadiusFloor` above). */
function resolveOutline(shape: ShapeSpec, outerSize: number, rcMin: number): ShapeOutline {
  if (shape.kind === "round") return makeOutline("round", outerSize, outerSize / 2);
  const rcMax = outerSize / 2;
  // A hairline short of fully round (SHAPE_ROUNDING_EPS): keeps a
  // non-degenerate (nonzero-length) straight side even when the bend limit
  // forces the shape as round as this size allows, so the geometry backends
  // (the polygon-fillet solid in step/build.ts) never see an exactly
  // zero-length side. Imperceptible at print resolution.
  const rc = Math.min(Math.max(shape.cornerRadius, rcMin), Math.max(0, rcMax - SHAPE_ROUNDING_EPS));
  return makeOutline(shape.kind, outerSize, rc);
}

/** Relative tolerance on "capacity >= target", to absorb floating-point noise only. */
const CAPACITY_EPS = 1e-6;
/** Overshoot (%) above which an at-the-bound "meets capacity" result is still reported as infeasible, not ok. */
const OVERSHOOT_INFEASIBLE_PCT = 3;
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

function toOuterSize(lock: Extract<CoilSpec["coreSize"], { locked: true }>): number {
  return lock.dimension === "outer" ? lock.value : lock.value + 2 * WALL_THICKNESS;
}

function capacityOf(spec: CoilSpec, quality: number, g: Resolved) {
  const wire = spec.wire;
  const grooveDepth = GROOVE_DEPTH_FACTOR * wire.diameter;
  const usableHeight = Math.max(0, g.height - 2 * MARGIN);
  const outline = resolveOutline(spec.shape, g.outerSize, bendCornerRadiusFloor(wire));
  return computeCapacity({
    outline,
    height: usableHeight,
    layers: g.layers,
    wireDiameter: wire.diameter,
    grooveDepth,
    clearance: CLEARANCE,
    quality,
  });
}

function lengthFor(spec: CoilSpec, g: Resolved): number {
  return capacityOf(spec, spec.windingQuality, g).totalWoundLength;
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

function envelopeVolumeFor(spec: CoilSpec, g: Resolved): number {
  const cap = capacityOf(spec, spec.windingQuality, g);
  const outline = resolveOutline(spec.shape, g.outerSize, bendCornerRadiusFloor(spec.wire));
  // True swept envelope volume (docs/research.md §10a, shapes.ts's
  // `offsetArea`): the outline's own enclosed area at the outermost wound
  // wire's outer edge, not a bounding-circle overestimate across the
  // envelope diameter -- matters for sq/tri, where the true footprint is
  // smaller than its circumscribed bounding circle.
  const outerOffset = cap.outermostOffset + spec.wire.diameter / 2;
  const trueVolume = offsetArea(outline, outerOffset) * g.height;
  return trueVolume * turnsPerLayerPenalty(cap);
}

function aspectScoreFor(spec: CoilSpec, g: Resolved): number {
  const cap = capacityOf(spec, spec.windingQuality, g);
  const outline = resolveOutline(spec.shape, g.outerSize, bendCornerRadiusFloor(spec.wire));
  const env = envelopeDiameter(outline, cap.outermostOffset, spec.wire.diameter);
  return Math.abs(g.height - env);
}

function scoreOf(objective: Objective): (spec: CoilSpec, g: Resolved) => number {
  return objective === "minVolume" ? envelopeVolumeFor : aspectScoreFor;
}

/** Build the full Solution + extra warnings from a resolved geometry (no further solving). */
function finishSolution(
  spec: CoilSpec,
  resolved: Resolved,
  diagnosis: Diagnosis,
  objectiveUsed: Objective | undefined,
  minOuterSizeForBend: number,
): { solution: Solution; warnings: string[] } {
  const warnings: string[] = [];
  const target = spec.wire.length;

  const cap = capacityOf(spec, spec.windingQuality, resolved);
  const capLo = capacityOf(spec, 0, resolved);
  const capHi = capacityOf(spec, 1, resolved);
  const totalWireLength = cap.totalWoundLength;
  const lengthLo = capLo.totalWoundLength;
  const lengthHi = capHi.totalWoundLength;

  const rcMin = bendCornerRadiusFloor(spec.wire);
  const rcMax = resolved.outerSize / 2;
  const outline = resolveOutline(spec.shape, resolved.outerSize, rcMin);
  const cornerRadius = outline.cornerRadius;

  const innerBore = resolved.outerSize - 2 * WALL_THICKNESS;
  const env = envelopeDiameter(outline, cap.outermostOffset, spec.wire.diameter);
  const flangeSize = env + 2 * FLANGE_MARGIN;
  const capsAuto = resolved.layers > 1;
  const deltaPct = ((totalWireLength - target) / target) * 100;

  if (innerBore <= 0) {
    warnings.push(`Wall thickness (${WALL_THICKNESS} mm) leaves no bore at outer size ${resolved.outerSize.toFixed(1)} mm -- increase outer size.`);
  }
  if (env > 500) {
    warnings.push(`Envelope footprint is ${env.toFixed(0)} mm -- check this fits your print bed.`);
  }
  if (Math.abs(deltaPct) > 10) {
    warnings.push(`Resulting capacity is ${deltaPct > 0 ? "+" : ""}${deltaPct.toFixed(1)}% vs. the target cable length.`);
  }
  // Capacity range too wide (issue #23): "ok" only means the CHOSEN winding
  // quality covers the target -- a design can still leave a loose/stacked
  // winding well short. Warn explicitly whenever the low end of the range
  // (the worst-case winding quality, whichever end that is -- see
  // capacityRange's own min/max ordering above) falls under the target, so
  // this isn't silently hidden behind an "ok" status.
  const capacityLo = Math.min(lengthLo, lengthHi);
  if (capacityLo < target * (1 - CAPACITY_EPS)) {
    const pctOfTarget = (capacityLo / target) * 100;
    warnings.push(
      `At the loosest winding quality, capacity is only ${capacityLo.toFixed(0)} mm (${pctOfTarget.toFixed(0)}% of the ${target.toFixed(0)} mm target) -- a loose winding may not fit; wind snugly to reach the full target length.`,
    );
  }
  if (spec.shape.kind !== "round") {
    const label = shapePlugin(spec.shape.kind).label.toLowerCase();
    const requested = spec.shape.cornerRadius;
    if (rcMin >= rcMax) {
      warnings.push(
        `The bend limit needs at least a ${rcMin.toFixed(1)} mm corner radius, but the core is only ${resolved.outerSize.toFixed(1)} mm across -- the ${label} core is effectively round.`,
      );
    } else if (requested < rcMin - 1e-9) {
      warnings.push(`Corner radius clamped up to ${rcMin.toFixed(1)} mm (requested ${requested.toFixed(1)} mm) to respect the bend limit.`);
    } else if (requested > rcMax + 1e-9) {
      warnings.push(`Corner radius clamped down to ${rcMax.toFixed(1)} mm (half the core size).`);
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
    minOuterSizeForBend,
    alternates: [],
  };
  return { solution, warnings };
}

interface SizeHeightSearchResult {
  /** The lowest-score candidate whose capacity covers the target, if any. */
  feasible?: { g: Resolved; length: number; score: number };
  /** The candidate that comes closest to the target (by length), even if it falls short -- used only to report a shortfall when nothing is feasible. */
  closest: { g: Resolved; length: number };
}

/** Grid-search height, bisect size at each sample, for a FIXED layer count. Shared by freeCount 2's third branch and freeCount 3's per-layer-count search. */
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
    const size = bisect((s) => lengthFor(spec, { outerSize: s, height, layers }), sizeLo, sizeHi, target);
    const g: Resolved = { outerSize: size, height, layers };
    const length = lengthFor(spec, g);
    if (!closest || length > closest.length) closest = { g, length };
    if (coversTarget(length, target)) {
      const s = score(spec, g);
      if (!feasible || s < feasible.score) feasible = { g, length, score: s };
    }
  }
  return { feasible, closest: closest! };
}

export function solve(rawSpec: CoilSpec): { solution: Solution; warnings: string[] } {
  const warnings: string[] = [];

  // Cords above 15 m are rejected: cap the target and warn rather than crash
  // (docs/research.md §1 "max 15 m").
  const spec: CoilSpec =
    rawSpec.wire.length > MAX_WIRE_LENGTH ? { ...rawSpec, wire: { ...rawSpec.wire, length: MAX_WIRE_LENGTH } } : rawSpec;
  if (rawSpec.wire.length > MAX_WIRE_LENGTH) {
    warnings.push(
      `Cable length ${rawSpec.wire.length} mm exceeds the supported maximum of ${MAX_WIRE_LENGTH} mm (15 m) and was rejected; capped at ${MAX_WIRE_LENGTH} mm.`,
    );
  }

  // Bend limit (docs/research.md §3): MBR = multiplier * d, applied to the
  // innermost layer. For a round core the corner radius IS the whole
  // radius, so the bend limit becomes a hard floor on the outer size
  // (spikes/s5-solver/RESULT.md "this only bites round cores").
  const bendMultiplier = bendMultiplierOf(spec.wire);
  const mbr = bendMultiplier * spec.wire.diameter;
  const grooveDepth = GROOVE_DEPTH_FACTOR * spec.wire.diameter;
  const o1 = spec.wire.diameter / 2 - grooveDepth;
  const rcMin = Math.max(0, mbr - o1);
  const minOuterSizeForBend = 2 * rcMin;
  const sizeLo = Math.max(SIZE_LO_FLOOR, minOuterSizeForBend);
  const sizeHi = SIZE_HI;
  const pitch = spec.wire.diameter + CLEARANCE;
  const heightLo = 2 * MARGIN + pitch;
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

  const lockedOuterSize = spec.coreSize.locked ? toOuterSize(spec.coreSize) : undefined;
  const lockedHeight = spec.height.locked ? spec.height.value : undefined;
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
    if (Math.abs(deltaPct) < 3) {
      diagnosis = { freeCount, freeVariables: freeVars, status: "ok", message: "Fully constrained; computed capacity matches the target within 3%." };
    } else {
      diagnosis = {
        freeCount,
        freeVariables: freeVars,
        status: "over-constrained",
        message:
          computed > target
            ? `Fully constrained geometry overshoots capacity by ${deltaPct.toFixed(1)}% -- the cable will be loose. Release the outer size, height, or layers lock to let the solver fix this.`
            : `Fully constrained geometry falls short of capacity by ${Math.abs(deltaPct).toFixed(1)}% -- the cable will not fit. Release the outer size, height, or layers lock to let the solver fix this.`,
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
    const meetsCapacity = coversTarget(computed, target);
    // Only the actually-free variable can have hit a search bound.
    const atLowBound = sizeFree ? resolved.outerSize <= sizeLo + 1e-6 : heightFree ? resolved.height <= heightLo + 1e-6 : resolved.layers <= layersLo;

    if (!meetsCapacity) {
      // bisect/solveIntegerUpTo only ever returns an undershoot when even the
      // high bound can't reach the target (see their early-return paths).
      diagnosis = {
        freeCount,
        freeVariables: freeVars,
        status: "infeasible",
        message: `The target cable length is unreachable within practical bounds even with this dimension maxed out (falls short by ${Math.abs(deltaPct).toFixed(1)}%). Lock a shorter target or free another dimension.`,
      };
    } else if (atLowBound && deltaPct > OVERSHOOT_INFEASIBLE_PCT) {
      diagnosis = {
        freeCount,
        freeVariables: freeVars,
        status: "infeasible",
        message: sizeFree
          ? `The minimum feasible outer size (${sizeLo.toFixed(1)} mm, set by the bend limit) already overshoots the target length by ${deltaPct.toFixed(1)}%. The core cannot be made smaller.`
          : `The minimum feasible value already overshoots the target length by ${deltaPct.toFixed(1)}%. The core cannot be made smaller.`,
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
      // coreSize + height free, layers locked: coarse grid over height, bisect size per sample.
      const SAMPLES = 48;
      for (let i = 0; i <= SAMPLES; i++) {
        const height = heightLo + ((heightHi - heightLo) * i) / SAMPLES;
        const size = bisect((s) => lengthFor(spec, { outerSize: s, height, layers: lockedLayers! }), sizeLo, sizeHi, target);
        const g = { outerSize: size, height, layers: lockedLayers! };
        candidates.push({ g, length: lengthFor(spec, g) });
      }
    }

    // Only candidates that actually cover the target are eligible: capacity
    // must be >= target (tail >= 0), never just "close" to it either way.
    const feasible = candidates.filter((c) => coversTarget(c.length, target));

    if (feasible.length === 0) {
      const closest = candidates.reduce((a, b) => (b.length > a.length ? b : a));
      const shortfallPct = ((target - closest.length) / target) * 100;
      resolved = closest.g;
      diagnosis = {
        freeCount,
        freeVariables: freeVars,
        status: "infeasible",
        message: `Two free dimensions: no sampled combination reaches the target length within practical bounds (the best falls short by ${shortfallPct.toFixed(1)}%). Free the third dimension or shorten the target.`,
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

      // The alternate candidate is picked from the same feasible pool under
      // the other objective -- no recursive solve() call (see the file header).
      const otherObjective: Objective = objective === "minVolume" ? "aspectRatio" : "minVolume";
      const altBest = pickBest(otherObjective);
      if (altBest !== primary) {
        const altDiagnosis: Diagnosis = {
          ...diagnosis,
          message: `Two free dimensions: the "${otherObjective}" objective's pick among the same target-covering candidates.`,
        };
        alternates = [finishSolution(spec, altBest.g, altDiagnosis, otherObjective, minOuterSizeForBend).solution];
      }
    }
  } else {
    // freeCount === 3: fully under-constrained. Search a small set of
    // representative layer counts (1..6) and return 2-3 candidates side by
    // side: the overall objective-best pick as the primary, plus fixed
    // layers=1 / layers=2 picks as alternates (when distinct and feasible),
    // per the ticket's "e.g. 1 layer / 2 layers / min-volume" example.
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
        message: `All three dimensions are free, but even the best sampled combination (up to ${PRACTICAL_LAYERS_HI} layers) falls short of the target length by ${shortfallPct.toFixed(1)}%. Increase the practical bounds or shorten the target.`,
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

      // Alternates: prefer named layers=1 / layers=2 candidates (distinct
      // from the primary), falling back to the next-best-scoring layer
      // counts if those specific ones aren't feasible or coincide with it.
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
        return finishSolution(spec, p.g, altDiagnosis, objective, minOuterSizeForBend).solution;
      });
    }
  }

  const finished = finishSolution(spec, resolved, diagnosis, objectiveUsed, minOuterSizeForBend);
  finished.solution.alternates = alternates;
  return { solution: finished.solution, warnings: [...warnings, ...finished.warnings] };
}
