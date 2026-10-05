
import * as THREE from "three";
import type { ShapeKind } from "../core";
import { SHAPES } from "../core";

const FRONT_CAMERA_SIDE_ANGLE_DEG = 270;

export function frontFlatRotationDeg(corners: number): number {
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

export function frontFacingDimensionSpin(shapeKind: ShapeKind | undefined): number | undefined {
  if (!shapeKind || shapeKind === "round") return undefined;
  const degrees = frontFlatRotationDeg(SHAPES[shapeKind].corners);
  return (-degrees * Math.PI) / 180;
}
