import { MOUNT_PLATE_PEG_CORNER, MOUNT_PLATE_PEG_SIZE } from "../../src/core";

/** The farthest reach (mm) of a mount-plate peg hole's corners from its anchor: the peg's octagon grown by half the tolerance. */
export function pegHoleRadius(tolerance: number): number {
  const offset = tolerance / 2;
  const halfFlat = MOUNT_PLATE_PEG_SIZE / 2 + offset;
  const diagonal = MOUNT_PLATE_PEG_SIZE / 2 - MOUNT_PLATE_PEG_CORNER + offset * (Math.SQRT2 - 1);
  return Math.hypot(halfFlat, diagonal);
}
