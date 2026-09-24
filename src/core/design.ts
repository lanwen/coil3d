// The coil core orchestrator: solves the spec (solve.ts) then builds the
// round, grooved wall and fuses the bottom flange (docs/research.md §4).
// The geometry itself is unchanged from the tracer bullet (#2): it still
// renders only the layer-1 groove on a single wall; layers beyond the first
// only affect the solved numbers and the flange size (the flange must clear
// every wound layer, not just the core's own wall). The top cap for
// multi-layer coils is ticket #9.
//
// `wallSpec`/`flangeSpec` are stashed on the returned Design so the STEP
// exporter (issue #11, src/core/step/build.ts) can fit its B-spline from
// the exact same parametric grid the mesh backend used -- the two backends
// must never drift apart (docs/research.md "STEP").

import { FLANGE_MARGIN, FLANGE_THICKNESS, GROOVE_DEPTH_FACTOR, MARGIN, MIN_BORE_RADIUS, ROWS_PER_PITCH, TAPER_TURNS, COLUMNS, CLEARANCE, WALL_THICKNESS } from "./constants";
import { fuseFlange } from "./manifold";
import { solve } from "./solve";
import type { CoilSpec, Design } from "./types";
import { buildRoundWall } from "./wall";

export async function design(spec: CoilSpec): Promise<Design> {
  const { solution, warnings } = solve(spec);

  const outerRadius = solution.outerSize / 2;
  let boreRadius = solution.innerBore / 2;
  if (boreRadius < MIN_BORE_RADIUS) {
    warnings.push(`Core size ${solution.outerSize.toFixed(1)} mm is too small for a ${WALL_THICKNESS} mm wall; the bore has been reduced.`);
    boreRadius = MIN_BORE_RADIUS;
  }

  const wireDiameter = spec.wire.diameter;
  const grooveDepth = GROOVE_DEPTH_FACTOR * wireDiameter;
  const layer1Turns = solution.layerResults[0]?.turns ?? 0;

  const wallSpec = {
    outerRadius,
    boreRadius,
    height: solution.height,
    wireDiameter,
    clearance: CLEARANCE,
    grooveDepth,
    marginBottom: MARGIN,
    marginTop: MARGIN,
    taperTurns: TAPER_TURNS,
    turns: layer1Turns,
    columns: COLUMNS,
    rowsPerPitch: ROWS_PER_PITCH,
  };
  const flangeSpec = {
    outerRadius,
    boreRadius,
    // The flange must clear the outermost wound layer, not just the core's
    // own wall (docs/research.md §1 "Flange size = final outer envelope +
    // margin"): solution.flangeSize already accounts for every layer, so the
    // effective margin beyond the core's own radius grows with layer count.
    margin: Math.max(FLANGE_MARGIN, solution.flangeSize / 2 - outerRadius),
    thickness: FLANGE_THICKNESS,
    segments: COLUMNS,
  };

  const wall = buildRoundWall(wallSpec);
  const mesh = await fuseFlange(wall, flangeSpec);

  return { spec, solution, warnings, mesh, wallSpec, flangeSpec };
}
