// Main solver orchestrator: "lock what you know, solve the rest"
// (docs/research.md §1 solver model, §3 capacity math and constraints).
// Adapted from spikes/s5-solver/src/solver/solve.ts (see RESULT.md):
// connector-pocket sizing is dropped (out of scope, docs/research.md
// "Out of Scope"); the flexible-cord bend multiplier is fixed to 4x (the
// spike used 6x, which contradicts docs/research.md §1's decision); the
// bound-hit check only looks at the actual free variable, not all three;
// and the freeCount===2 "alternate" candidate is picked from the already-
// computed candidate pool instead of a second `solve()` call, which in the
// spike recursed into itself forever (freeCount stays 2 for the recursive
// call, which then computes its own alternate, forever).

import { computeCapacity, envelopeDiameter } from "./capacity";
import { MARGIN, CLEARANCE, FLANGE_MARGIN, GROOVE_DEPTH_FACTOR, HEIGHT_HI, LAYERS_HI, MAX_WIRE_LENGTH, SIZE_HI, SIZE_LO_FLOOR, WALL_THICKNESS } from "./constants";
import { bendMultiplierOf } from "./types";
import type { CoilSpec, Diagnosis, Objective, Solution } from "./types";

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
  return (a + b) / 2;
}

function solveIntegerUpTo(f: (n: number) => number, lo: number, hi: number, target: number): number {
  let best = lo;
  for (let n = lo; n <= hi; n++) {
    best = n;
    if (f(n) >= target) return n;
  }
  return best;
}

interface Resolved {
  outerSize: number;
  height: number; // full core height, including top/bottom margins
  layers: number;
}

function toOuterSize(lock: Extract<CoilSpec["coreSize"], { locked: true }>): number {
  return lock.dimension === "outer" ? lock.value : lock.value + 2 * WALL_THICKNESS;
}

function capacityOf(wire: CoilSpec["wire"], quality: number, g: Resolved) {
  const grooveDepth = GROOVE_DEPTH_FACTOR * wire.diameter;
  const usableHeight = Math.max(0, g.height - 2 * MARGIN);
  return computeCapacity({
    outerSize: g.outerSize,
    height: usableHeight,
    layers: g.layers,
    wireDiameter: wire.diameter,
    grooveDepth,
    clearance: CLEARANCE,
    quality,
  });
}

function lengthFor(spec: CoilSpec, g: Resolved): number {
  return capacityOf(spec.wire, spec.windingQuality, g).totalWoundLength;
}

function envelopeVolumeFor(spec: CoilSpec, g: Resolved): number {
  const cap = capacityOf(spec.wire, spec.windingQuality, g);
  const env = envelopeDiameter(g.outerSize, cap.outermostOffset, spec.wire.diameter);
  // Treat the footprint as its bounding circle for a relative volume score.
  return (Math.PI / 4) * env * env * g.height;
}

function aspectScoreFor(spec: CoilSpec, g: Resolved): number {
  const cap = capacityOf(spec.wire, spec.windingQuality, g);
  const env = envelopeDiameter(g.outerSize, cap.outermostOffset, spec.wire.diameter);
  return Math.abs(g.height - env);
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

  const cap = capacityOf(spec.wire, spec.windingQuality, resolved);
  const capLo = capacityOf(spec.wire, 0, resolved);
  const capHi = capacityOf(spec.wire, 1, resolved);
  const totalWireLength = cap.totalWoundLength;
  const lengthLo = capLo.totalWoundLength;
  const lengthHi = capHi.totalWoundLength;

  const innerBore = resolved.outerSize - 2 * WALL_THICKNESS;
  const env = envelopeDiameter(resolved.outerSize, cap.outermostOffset, spec.wire.diameter);
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

  const solution: Solution = {
    diagnosis,
    objectiveUsed,
    outerSize: resolved.outerSize,
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
  };
  return { solution, warnings };
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
  let alternate: Solution | undefined;

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
    // Only the actually-free variable can have hit a search bound.
    const atLowBound = sizeFree ? resolved.outerSize <= sizeLo + 1e-6 : heightFree ? resolved.height <= heightLo + 1e-6 : resolved.layers <= layersLo;
    const atHighBound = sizeFree ? resolved.outerSize >= sizeHi - 1e-6 : heightFree ? resolved.height >= heightHi - 1e-6 : resolved.layers >= layersHi;
    if (Math.abs(deltaPct) > 3 && atHighBound) {
      diagnosis = {
        freeCount,
        freeVariables: freeVars,
        status: "infeasible",
        message: "The target cable length is unreachable within practical bounds even with this dimension maxed out. Lock a shorter target or free another dimension.",
      };
    } else if (Math.abs(deltaPct) > 3 && atLowBound) {
      diagnosis = {
        freeCount,
        freeVariables: freeVars,
        status: "infeasible",
        message: sizeFree
          ? `The minimum feasible outer size (${sizeLo.toFixed(1)} mm, set by the bend limit) already overshoots the target length. The core cannot be made smaller.`
          : "The minimum feasible value already overshoots the target length. The core cannot be made smaller.",
      };
    } else {
      diagnosis = { freeCount, freeVariables: freeVars, status: "ok", message: "Solved directly for the single free dimension." };
    }
  } else if (freeCount === 2) {
    const objective = spec.objective;
    objectiveUsed = objective;
    const scoreFor = (o: Objective) => (o === "minVolume" ? envelopeVolumeFor : aspectScoreFor);

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

    const feasible = candidates.filter((c) => Math.abs((c.length - target) / target) < 0.05);
    const pool = feasible.length > 0 ? feasible : candidates;

    const pickBest = (o: Objective) => {
      const score = scoreFor(o);
      let best = pool[0];
      let bestScore = score(spec, best.g);
      for (const c of pool.slice(1)) {
        const s = score(spec, c.g);
        if (s < bestScore) {
          best = c;
          bestScore = s;
        }
      }
      return best;
    };

    resolved = pickBest(objective).g;

    diagnosis = {
      freeCount,
      freeVariables: freeVars,
      status: feasible.length > 0 ? "ok" : "infeasible",
      message:
        feasible.length > 0
          ? `Two free dimensions: picked the "${objective}" candidate among solutions that hit the target length. See the alternate candidate for comparison.`
          : `Two free dimensions: no sampled combination reached the target length within 5%; showing the closest by "${objective}".`,
    };

    // The alternate candidate is picked from the same pool under the other
    // objective -- no recursive solve() call (see the file header).
    const otherObjective: Objective = objective === "minVolume" ? "aspectRatio" : "minVolume";
    const altResolved = pickBest(otherObjective).g;
    const altDiagnosis: Diagnosis = { ...diagnosis, message: diagnosis.message.replace(objective, otherObjective) };
    alternate = finishSolution(spec, altResolved, altDiagnosis, otherObjective, minOuterSizeForBend).solution;
  } else {
    // freeCount === 3: fully under-constrained. Default heuristic: try
    // layers 1..6, solving (size, height) with the chosen objective at each,
    // and take the first whose envelope stays within a practical bed size.
    const objective = spec.objective;
    objectiveUsed = objective;
    const score = objective === "minVolume" ? envelopeVolumeFor : aspectScoreFor;
    let chosen: Resolved | undefined;
    let triedLayers = 1;
    for (let n = 1; n <= 6; n++) {
      triedLayers = n;
      const SAMPLES = 32;
      let best: { g: Resolved; score: number; length: number } | undefined;
      for (let i = 0; i <= SAMPLES; i++) {
        const height = heightLo + ((heightHi - heightLo) * i) / SAMPLES;
        const size = bisect((s) => lengthFor(spec, { outerSize: s, height, layers: n }), sizeLo, sizeHi, target);
        const g = { outerSize: size, height, layers: n };
        const length = lengthFor(spec, g);
        if (Math.abs((length - target) / target) > 0.05) continue;
        const s = score(spec, g);
        if (!best || s < best.score) best = { g, score: s, length };
      }
      if (best) {
        const cap = capacityOf(spec.wire, spec.windingQuality, best.g);
        const env = envelopeDiameter(best.g.outerSize, cap.outermostOffset, spec.wire.diameter);
        if (env <= 400 || n === 6) {
          chosen = best.g;
          break;
        }
      }
    }
    resolved = chosen ?? { outerSize: sizeLo, height: heightHi, layers: 6 };
    diagnosis = {
      freeCount,
      freeVariables: freeVars,
      status: "under-constrained",
      message: `All three dimensions are free: solver defaulted to layers=${triedLayers} and the "${objective}" objective for outer size/height. Lock at least one dimension for a deterministic result.`,
    };
  }

  const finished = finishSolution(spec, resolved, diagnosis, objectiveUsed, minOuterSizeForBend);
  finished.solution.alternate = alternate;
  return { solution: finished.solution, warnings: [...warnings, ...finished.warnings] };
}
