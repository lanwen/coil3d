// Hand-written 3MF (Core spec) writer -- issue #10, proven by
// spikes/s4-3mf (read spikes/s4-3mf/RESULT.md). Reuses this project's own
// zip.ts (STORE method, no compression) instead of adding `fflate` as a
// dependency: the spike used fflate, but this repo already hand-rolls its
// own zip writer for the multi-part STL bundle (see zip.ts's header
// comment), so a second zip implementation would be pure duplication for a
// format this small.
//
// One <object> + one <build><item> pair per part -- NOT nested via
// <components>, which is for building one object out of sub-parts, not
// independent build-plate items (spikes/s4-3mf/RESULT.md §1). Units are
// always millimeter. No <basematerials>/color: per docs/research.md §10b
// and the S4 spike, Bambu/Orca/Prusa ignore the spec's basematerials/pid
// color and read only a per-triangle `paint_color` vendor attribute, so v1
// ships single-color named objects only (issue #10 AC) -- name and
// placement are all a plain core-spec 3MF needs for slicers to show
// separate, correctly-placed objects.
//
// Each object's mesh is written in the part's OWN (unrotated, untranslated)
// frame -- the exact same `part.mesh` the viewer and STL/STEP exporters
// use -- and the print orientation + plate position are folded into the
// <item>'s transform matrix instead (see `transformAttr`). This keeps every
// export backend reading the identical vertex data, so they can never
// drift apart from one another.

import { layoutParts } from "./plate";
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

/** Trim float noise and avoid scientific notation -- both trip up some XML parsers (spikes/s4-3mf/src/write3mf.ts). */
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

/**
 * A `RigidTransform` (rotate about X, then translate -- types.ts) as a 3MF
 * `<item transform="...">` matrix: 12 numbers, row-major over a 4x3 matrix
 * (3x3 linear part + a translation row), applied as `P' = P * M` (the OPC/
 * 3MF row-vector convention -- spikes/s4-3mf/RESULT.md §1). Working out
 * `P'.y = y*cos - z*sin` and `P'.z = y*sin + z*cos` (transform.ts's own
 * rotation) in that convention gives the middle two rows below; `rotateX
 * === 0` reduces this to the spike's plain identity+translate matrix.
 */
function transformAttr(t: RigidTransform): string {
  const cos = Math.cos(t.rotateX);
  const sin = Math.sin(t.rotateX);
  const [dx, dy, dz] = t.translate;
  return [1, 0, 0, 0, cos, sin, 0, -sin, cos, dx, dy, dz].map(fmt).join(" ");
}

export function write3mf(design: Design): Uint8Array<ArrayBuffer> {
  const { parts } = design;
  const offsets = layoutParts(parts, design.spec.print);

  const objects = parts.map((part, i) => `<object id="${i + 1}" type="model" name="${escapeXml(part.name)}">${meshXml(part.mesh)}</object>`).join("");

  const items = parts
    .map((part, i) => {
      const [ox, oy] = offsets[i];
      const t: RigidTransform = {
        rotateX: part.printTransform.rotateX,
        translate: [part.printTransform.translate[0] + ox, part.printTransform.translate[1] + oy, part.printTransform.translate[2]],
      };
      return `<item objectid="${i + 1}" transform="${transformAttr(t)}"/>`;
    })
    .join("");

  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <metadata name="Application">scroll3d</metadata>
  <resources>${objects}</resources>
  <build>${items}</build>
</model>`;

  return writeZip([
    { name: "[Content_Types].xml", data: new TextEncoder().encode(CONTENT_TYPES) },
    { name: "_rels/.rels", data: new TextEncoder().encode(ROOT_RELS) },
    { name: "3D/3dmodel.model", data: new TextEncoder().encode(model) },
  ]) as Uint8Array<ArrayBuffer>;
}
