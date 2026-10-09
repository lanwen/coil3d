import { bedRestingTransform } from "./plate";
import { applyRigidTransform } from "./transform";
import { writeBinaryStl } from "./stl";
import { write3mf } from "./threeMf";
import { writeZip } from "./zip";
import type { Design, ExportFormat, Part } from "./types";

function bedRestingStl(part: Part): Uint8Array<ArrayBuffer> {
  return writeBinaryStl(applyRigidTransform(part.mesh, bedRestingTransform(part)), part.name);
}

function exportStl(design: Design): Uint8Array<ArrayBuffer> {
  if (design.parts.length === 1) return bedRestingStl(design.parts[0]);
  return writeZip(design.parts.map((part) => ({ name: `${part.name}.stl`, data: bedRestingStl(part) }))) as Uint8Array<ArrayBuffer>;
}

export async function exportDesign(design: Design, format: ExportFormat): Promise<Uint8Array<ArrayBuffer>> {
  if (format === "stl") return exportStl(design);
  if (format === "3mf") {
    return write3mf(design);
  }
  if (format === "step") {
    const { exportStep } = await import("./step");
    return exportStep(design);
  }
  throw new Error(`Unsupported export format: ${format satisfies never}`);
}
