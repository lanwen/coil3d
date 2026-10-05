import { CABLE_BEND_BUDGET, CENTRE_CONNECTOR_PASSAGE, CENTRE_GRIP_LENGTH, SIZE_HI, SIZE_LO_FLOOR } from "./constants";
import { clipRadius } from "./innerEnd";
import { grooveShape, wallThickness } from "./wall";

export function centreBendRadius(mbr: number): number {
  return mbr / CABLE_BEND_BUDGET;
}

export function minCentreEndsHeight(wireDiameter: number, tolerance: number, mbr: number): number {
  return CENTRE_GRIP_LENGTH + centreBendRadius(mbr) + clipRadius(wireDiameter, tolerance);
}

export function centreInEndLength(height: number, wireDiameter: number, tolerance: number, mbr: number): number {
  const bendRadius = centreBendRadius(mbr);
  const verticalRun = Math.max(0, height - clipRadius(wireDiameter, tolerance) - bendRadius);
  const quarterBend = (Math.PI / 2) * bendRadius;
  return verticalRun + quarterBend;
}

function boreLetsInnerEndThrough(outerSize: number, wireDiameter: number, tolerance: number, mbr: number): boolean {
  const apothem = outerSize / 2;
  const boreRadius = apothem - wallThickness(wireDiameter);
  if (2 * boreRadius < CENTRE_CONNECTOR_PASSAGE) return false;
  const bendRadius = centreBendRadius(mbr);
  const layer1Radius = apothem + wireDiameter / 2 - grooveShape(wireDiameter).depth;
  const deepestReach = Math.abs(2 * bendRadius - layer1Radius);
  if (deepestReach >= boreRadius) return false;
  const chordAtDeepestReach = 2 * Math.sqrt(boreRadius * boreRadius - deepestReach * deepestReach);
  const levelRunAndSeat = bendRadius + 2 * clipRadius(wireDiameter, tolerance);
  return chordAtDeepestReach >= levelRunAndSeat;
}

export function minCentreEndsOuterSize(wireDiameter: number, tolerance: number, mbr: number): number {
  if (!boreLetsInnerEndThrough(SIZE_HI, wireDiameter, tolerance, mbr)) return SIZE_HI;
  let tooSmall = SIZE_LO_FLOOR;
  let fits = SIZE_HI;
  for (let i = 0; i < 50; i++) {
    const middle = (tooSmall + fits) / 2;
    if (boreLetsInnerEndThrough(middle, wireDiameter, tolerance, mbr)) fits = middle;
    else tooSmall = middle;
  }
  return fits;
}
