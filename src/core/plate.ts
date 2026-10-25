import { PLATE_GAP } from "./constants";
import { applyRigidTransform } from "./transform";
import type { CoilMesh, Part, PrintSpec, RigidTransform } from "./types";

interface BBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

function meshBBox(mesh: CoilMesh): BBox {
  const { positions } = mesh;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { minX, maxX, minY, maxY, minZ, maxZ };
}

export function printBBox(part: Part): BBox {
  return meshBBox(applyRigidTransform(part.mesh, part.printTransform));
}

export function bedRestingTransform(part: Part): RigidTransform {
  const box = printBBox(part);
  const [tx, ty, tz] = part.printTransform.translate;
  return { rotateZ: part.printTransform.rotateZ, rotateX: part.printTransform.rotateX, translate: [tx, ty, tz - box.minZ] };
}

function layoutParts(parts: Part[], bed: PrintSpec): Array<[number, number]> {
  const boxes = parts.map(printBBox);
  const widths = boxes.map((b) => b.maxX - b.minX);
  const totalWidth = widths.reduce((sum, w) => sum + w, 0) + PLATE_GAP * Math.max(0, parts.length - 1);

  let cursor = -totalWidth / 2;
  return boxes.map((b, i) => {
    const dx = cursor - b.minX + bed.bedX / 2;
    const dy = -(b.minY + b.maxY) / 2 + bed.bedY / 2;
    cursor += widths[i] + PLATE_GAP;
    return [dx, dy];
  });
}

interface PartPlacement {
  part: Part;
  transform: RigidTransform;
}

export function printPlacements(parts: Part[], bed: PrintSpec): PartPlacement[] {
  const offsets = layoutParts(parts, bed);
  return parts.map((part, i) => {
    const [ox, oy] = offsets[i];
    const resting = bedRestingTransform(part);
    return {
      part,
      transform: { rotateZ: resting.rotateZ, rotateX: resting.rotateX, translate: [resting.translate[0] + ox, resting.translate[1] + oy, resting.translate[2]] },
    };
  });
}
