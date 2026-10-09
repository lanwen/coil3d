import { printPlacements } from "./plate";
import { writeZip } from "./zip";
import type { CoilMesh, Design, RigidTransform } from "./types";

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/3D/3dmodel.model"/>
</Relationships>`;

function fmt(n: number): string {
  return Number(n.toFixed(6)).toString();
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function meshXml(mesh: CoilMesh): string {
  const { positions, indices } = mesh;
  const verts: string[] = [];
  for (let i = 0; i < positions.length; i += 3) {
    verts.push(`<vertex x="${fmt(positions[i])}" y="${fmt(positions[i + 1])}" z="${fmt(positions[i + 2])}"/>`);
  }
  const tris: string[] = [];
  for (let i = 0; i < indices.length; i += 3) {
    tris.push(`<triangle v1="${indices[i]}" v2="${indices[i + 1]}" v3="${indices[i + 2]}"/>`);
  }
  return `<mesh><vertices>${verts.join("")}</vertices><triangles>${tris.join("")}</triangles></mesh>`;
}

function transformAttr(t: RigidTransform): string {
  const cosX = Math.cos(t.rotateX);
  const sinX = Math.sin(t.rotateX);
  const cosZ = Math.cos(t.rotateZ ?? 0);
  const sinZ = Math.sin(t.rotateZ ?? 0);
  const [dx, dy, dz] = t.translate;
  return [cosZ, sinZ * cosX, sinZ * sinX, -sinZ, cosZ * cosX, cosZ * sinX, 0, -sinX, cosX, dx, dy, dz].map(fmt).join(" ");
}

export function write3mf(design: Design): Uint8Array<ArrayBuffer> {
  const { parts } = design;
  const placements = printPlacements(parts, design.spec.print);

  const objects = parts.map((part, i) => `<object id="${i + 1}" type="model" name="${escapeXml(part.name)}">${meshXml(part.mesh)}</object>`).join("");

  const items = placements
    .map(({ transform }, i) => `<item objectid="${i + 1}" transform="${transformAttr(transform)}"/>`)
    .join("");

  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <metadata name="Application">coil3d</metadata>
  <resources>${objects}</resources>
  <build>${items}</build>
</model>`;

  return writeZip([
    { name: "[Content_Types].xml", data: new TextEncoder().encode(CONTENT_TYPES) },
    { name: "_rels/.rels", data: new TextEncoder().encode(ROOT_RELS) },
    { name: "3D/3dmodel.model", data: new TextEncoder().encode(model) },
  ]) as Uint8Array<ArrayBuffer>;
}
