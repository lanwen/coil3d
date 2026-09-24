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
//
// `resolution` (issue #7) only ever changes the mesh's column/row density
// (see constants.ts); the solved numbers, warnings and wall/flange specs are
// identical between draft and final for the same spec.
//
// `wirePaths` (issue #4) is the schematic wound-cable centerline per layer,
// built from the exact same wallSpec/layerResults used above so it can never
// drift from the printed groove or the solved turns/offsets (see wire.ts).
// It doesn't depend on `resolution` beyond the wallSpec fields it reads.

import {
  FLANGE_MARGIN,
  FLANGE_THICKNESS,
  GROOVE_DEPTH_FACTOR,
  MARGIN,
  MIN_BORE_CORNER_RADIUS,
  MIN_BORE_RADIUS,
  FINAL_ROWS_PER_PITCH,
  FINAL_COLUMNS,
  DRAFT_ROWS_PER_PITCH,
  DRAFT_COLUMNS,
  TAPER_TURNS,
  CLEARANCE,
  WALL_THICKNESS,
} from "./constants";
import { fuseFlange } from "./manifold";
import { circumscribedRadius, makeOutline } from "./shapes";
import type { ShapeOutline } from "./shapes";
import { solve } from "./solve";
import type { CoilSpec, Design, Resolution } from "./types";
import { buildWall } from "./wall";
import { buildWirePaths } from "./wire";

export async function design(spec: CoilSpec, resolution: Resolution = "final"): Promise<Design> {
  const { solution, warnings } = solve(spec);
  const columns = resolution === "draft" ? DRAFT_COLUMNS : FINAL_COLUMNS;
  const rowsPerPitch = resolution === "draft" ? DRAFT_ROWS_PER_PITCH : FINAL_ROWS_PER_PITCH;

  const outline = makeOutline(spec.shape.kind, solution.outerSize, solution.cornerRadius);

  // The bore is a TRUE inward offset of the wall's own outline by the wall
  // thickness (issue #6 AC: "the triangle wall is computed from the true
  // inward offset", not `outer - 2*wall`): both apothem and corner radius
  // shrink by the same amount (Steiner), floored so the outline never
  // inverts (spikes/s1-grooved-wall/geom.ts's `boreMinCornerR`).
  let boreApothem = outline.apothem - WALL_THICKNESS;
  if (boreApothem < MIN_BORE_RADIUS) {
    warnings.push(`Core size ${solution.outerSize.toFixed(1)} mm is too small for a ${WALL_THICKNESS} mm wall; the bore has been reduced.`);
    boreApothem = MIN_BORE_RADIUS;
  }
  // Round's defining invariant is apothem === cornerRadius (see shapes.ts);
  // apothem and corner radius are floored independently above/below (they
  // guard different things -- MIN_BORE_RADIUS keeps a printable bore at
  // all, MIN_BORE_CORNER_RADIUS keeps a non-round bore's corner from
  // folding), so at the small end they can hit different floors and break
  // that invariant. Preserve it explicitly for round, or a tiny locked core
  // would get a very-slightly-square bore instead of a circle.
  const isRound = outline.cornerRadius === outline.apothem;
  const boreCornerRadius = isRound ? boreApothem : Math.min(Math.max(outline.cornerRadius - WALL_THICKNESS, MIN_BORE_CORNER_RADIUS), boreApothem);
  const boreOutline: ShapeOutline = { n: outline.n, apothem: boreApothem, cornerRadius: boreCornerRadius };

  const wireDiameter = spec.wire.diameter;
  const grooveDepth = GROOVE_DEPTH_FACTOR * wireDiameter;
  const layer1Turns = solution.layerResults[0]?.turns ?? 0;

  const wallSpec = {
    outline,
    boreOutline,
    height: solution.height,
    wireDiameter,
    clearance: CLEARANCE,
    grooveDepth,
    marginBottom: MARGIN,
    marginTop: MARGIN,
    taperTurns: TAPER_TURNS,
    turns: layer1Turns,
    columns,
    rowsPerPitch,
  };
  const flangeSpec = {
    outline,
    boreOutline,
    // The flange must clear the outermost wound layer, not just the core's
    // own wall (docs/research.md §1 "Flange size = final outer envelope +
    // margin"): solution.flangeSize already accounts for every layer, so the
    // effective margin beyond the core's own outline grows with layer count.
    // circumscribedRadius(outline, margin) === circumscribedRadius(outline, 0) + margin
    // (the offset term is additive, see shapes.ts), so this margin is exactly
    // what's needed for the flange's own circumscribed radius to reach
    // solution.flangeSize / 2.
    margin: Math.max(FLANGE_MARGIN, solution.flangeSize / 2 - circumscribedRadius(outline, 0)),
    thickness: FLANGE_THICKNESS,
    columns,
  };

  const wall = buildWall(wallSpec);
  const mesh = await fuseFlange(wall, flangeSpec);
  const wirePaths = buildWirePaths(solution.layerResults, wallSpec, spec.windingQuality);

  return { spec, solution, warnings, mesh, resolution, wirePaths, wallSpec, flangeSpec };
}
