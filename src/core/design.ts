// The tracer-bullet solver (docs/research.md §1, §3, restricted to a round
// core and a single layer). Given the wire and the core size, solves the
// height needed to hold as much of the wire as fits in whole turns, then
// builds the grooved wall and fuses the bottom flange.

import { buildRoundWall } from "./wall";
import { fuseFlange } from "./manifold";
import type { CoilSpec, Design } from "./types";

// Fixed print parameters. Not user-configurable in this slice; later
// tickets promote some of these to the solver/spec (docs/research.md §2).
const WALL_THICKNESS = 3; // mm
const CLEARANCE = 0.3; // mm, added to wire diameter for the winding pitch
const GROOVE_DEPTH_FACTOR = 0.3; // groove depth = 0.3 * wire diameter
const MARGIN = 3; // mm, top & bottom (also the groove's taper run-out zone)
const TAPER_TURNS = 0.5; // the groove fades out over this many turns at each end
const FLANGE_MARGIN = 4; // mm beyond the core's outer radius
const FLANGE_THICKNESS = 3; // mm
const MIN_BORE_RADIUS = 1; // mm, guards against a wall thicker than the core
const COLUMNS = 96; // mesh columns around the circumference
const ROWS_PER_PITCH = 8; // mesh rows per helical pitch

export async function design(spec: CoilSpec): Promise<Design> {
  const warnings: string[] = [];
  const d = spec.wireDiameter;
  const outerRadius = spec.coreSize / 2;
  const grooveDepth = GROOVE_DEPTH_FACTOR * d;
  const wireOffset = d / 2 - grooveDepth; // layer-1 wire centerline offset from the outer surface
  const centerlineRadius = outerRadius + wireOffset;
  const perimeter = 2 * Math.PI * centerlineRadius;
  const pitch = d + CLEARANCE;

  let turns = Math.floor(spec.wireLength / perimeter);
  if (turns < 1) {
    warnings.push(
      `The cable (${spec.wireLength} mm) is shorter than one turn around this core (${perimeter.toFixed(1)} mm circumference); showing a single turn.`,
    );
    turns = 1;
  }

  let boreRadius = outerRadius - WALL_THICKNESS;
  if (boreRadius < MIN_BORE_RADIUS) {
    warnings.push(`Core size ${spec.coreSize} mm is too small for a ${WALL_THICKNESS} mm wall; the bore has been reduced.`);
    boreRadius = MIN_BORE_RADIUS;
  }

  const woundLength = turns * perimeter;
  const leftoverTail = Math.max(0, spec.wireLength - woundLength);
  const height = 2 * MARGIN + turns * pitch;

  const wall = buildRoundWall({
    outerRadius,
    boreRadius,
    height,
    wireDiameter: d,
    clearance: CLEARANCE,
    grooveDepth,
    marginBottom: MARGIN,
    marginTop: MARGIN,
    taperTurns: TAPER_TURNS,
    turns,
    columns: COLUMNS,
    rowsPerPitch: ROWS_PER_PITCH,
  });

  const mesh = await fuseFlange(wall, {
    outerRadius,
    boreRadius,
    margin: FLANGE_MARGIN,
    thickness: FLANGE_THICKNESS,
    segments: COLUMNS,
  });

  return {
    spec,
    turns,
    woundLength,
    leftoverTail,
    height,
    pitch,
    perimeter,
    outerRadius,
    boreRadius,
    warnings,
    mesh,
  };
}
