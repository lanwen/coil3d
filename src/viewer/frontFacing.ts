
import * as THREE from "three";
import type { ShapeKind, ShapeOutline } from "../core";
import { SHAPES } from "../core";

const FRONT_CAMERA_SIDE_ANGLE_DEG = 270;

function frontFlatRotationDeg(corners: number): number {
  const step = 360 / corners;
  const sideAngleBeforeRotation = FRONT_CAMERA_SIDE_ANGLE_DEG - step / 2;
  const offsetWithinStep = ((sideAngleBeforeRotation % step) + step) % step;
  return offsetWithinStep > step / 2 ? offsetWithinStep - step : offsetWithinStep;
}

export function frontFacingRotation(shapeKind: ShapeKind | undefined): THREE.Matrix4 | null {
  if (!shapeKind || shapeKind === "round") return null;
  const degrees = frontFlatRotationDeg(SHAPES[shapeKind].corners);
  return new THREE.Matrix4().makeRotationZ((degrees * Math.PI) / 180);
}

const LABEL_UP_DEG = 90;
const PILL_SIDES = 2;

export function labelUprightDeg(outline: ShapeOutline | undefined): number {
  if (!outline) return 0;
  const isFullCircle = outline.cornerRadius >= outline.apothem && outline.n !== PILL_SIDES;
  if (isFullCircle) return 0;
  const firstSideBearingDeg = 180 / outline.n;
  return LABEL_UP_DEG - firstSideBearingDeg;
}

export function frontFacingDimensionSpin(shapeKind: ShapeKind | undefined): number | undefined {
  if (!shapeKind || shapeKind === "round") return undefined;
  const degrees = frontFlatRotationDeg(SHAPES[shapeKind].corners);
  return (-degrees * Math.PI) / 180;
}
