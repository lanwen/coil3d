// Print-layout view (issue #78): "every part in its print orientation ...
// laid out on a drawn bed outline". Every part's placement comes from the
// core's own `printPlacements` (plate.ts's `bedRestingTransform` +
// `layoutParts`) -- the SAME function the 3MF writer (threeMf.ts) calls --
// so this view and the exported plate can never disagree about where a part
// actually sits (issue #78 AC). Pure geometry building, no React: CoilViewer.tsx
// creases each returned mesh with its own `buildCreasedGeometry` (shared with
// the assembled view) and disposes everything this module hands back.

import * as THREE from "three";
import { printPlacements, type CoilMesh, type Part, type PrintSpec, type RigidTransform } from "../core";
import { DIMENSION_LABEL_LAYER } from "./lineArt/LineArtRenderer";

/**
 * `RigidTransform` applied directly to vertex positions (rotate about X,
 * then translate) -- the same trivial math `core/transform.ts`'s
 * `applyRigidTransform` does. Reimplemented here, not imported, because that
 * module is a core INTERNAL the UI may not reach into (architecture rule:
 * "the UI and renderer use only [the core's public] interface" -- see
 * `src/guide/printOrientation.ts`'s own copy, which this mirrors); only
 * `plate.ts`'s actual placement math (`printPlacements`, non-trivial enough
 * that reimplementing it risks drifting from the 3MF export) is worth a
 * shared, exported function.
 */
function applyPrintTransform(mesh: CoilMesh, t: RigidTransform): CoilMesh {
  const { positions } = mesh;
  const cos = Math.cos(t.rotateX);
  const sin = Math.sin(t.rotateX);
  const [dx, dy, dz] = t.translate;
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    out[i] = x + dx;
    out[i + 1] = y * cos - z * sin + dy;
    out[i + 2] = y * sin + z * cos + dz;
  }
  return { positions: out, indices: mesh.indices };
}

export interface PrintLayoutPart {
  part: Part;
  /** Print-placed mesh (world = bed mm), ready for `buildCreasedGeometry`. */
  mesh: CoilMesh;
  /** Where to float this part's name label: centered over its own footprint, just above its own top face. */
  labelPosition: THREE.Vector3;
  /** This part's own footprint diagonal (mm) -- how `buildPartLabel` sizes its text, see that function's own doc comment. */
  footprintSize: number;
  /** The exact `printPlacements` transform this part was placed with -- mirrored as accessible text by CoilViewer (like DimensionAxes' own hidden list) so e2e coverage can confirm it against the 3MF export's own item transform, without re-deriving it from pixels (issue #78 AC: "view and 3MF agree"). */
  transform: RigidTransform;
}

// The label floats above each part by this fraction of the larger of its
// own footprint diagonal OR its own height -- scale-invariant per part (a
// fixed mm gap would look cramped on a small part and buried in a large
// one, and parts on the same bed can differ a lot in size, e.g. a core vs.
// its mount plate). Measured against height too, not just footprint: in
// this view's own iso-like elevation (presets.ts's ISO_DIR, shared with the
// "Wall mount" preset), a TALL part's own rim still reads well up the
// screen, so a lift sized only off the (much smaller) footprint would float
// the label barely past the rim instead of clearly above it.
const LABEL_LIFT_FRACTION = 0.4;

/** Every part in its exact print-bed placement (issue #78), plus the whole
 * layout's own bounds (bed footprint union part heights) for framing. */
export function buildPrintLayout(parts: Part[], bed: PrintSpec): { parts: PrintLayoutPart[]; bounds: THREE.Box3 } {
  const bounds = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(bed.bedX, bed.bedY, 0));

  const placed = printPlacements(parts, bed).map(({ part, transform }) => {
    const mesh = applyPrintTransform(part.mesh, transform);
    const { positions } = mesh;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
      minX = Math.min(minX, positions[i]);
      maxX = Math.max(maxX, positions[i]);
      minY = Math.min(minY, positions[i + 1]);
      maxY = Math.max(maxY, positions[i + 1]);
      maxZ = Math.max(maxZ, positions[i + 2]);
    }
    bounds.expandByPoint(new THREE.Vector3(minX, minY, 0));
    bounds.expandByPoint(new THREE.Vector3(maxX, maxY, maxZ));
    const footprintSize = Math.max(maxX - minX, maxY - minY);
    const lift = LABEL_LIFT_FRACTION * Math.max(footprintSize, maxZ);
    const labelPosition = new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, maxZ + lift);
    return { part, mesh, labelPosition, footprintSize, transform };
  });

  return { parts: placed, bounds };
}

// A thin drawn slab, never printed/exported -- just the "drawn bed outline"
// the AC asks for, sized to the configured bed and level with every part's
// own resting Z (0, see `printPlacements`/`bedRestingTransform`).
const BED_THICKNESS = 1; // mm

/** A flat rectangle the size of the configured print bed, top face at z=0. */
export function buildBedGeometry(bed: PrintSpec): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(bed.bedX, bed.bedY, BED_THICKNESS);
  geometry.translate(bed.bedX / 2, bed.bedY / 2, -BED_THICKNESS / 2);
  return geometry;
}

const LABEL_FONT_PX = 32;
const LABEL_PAD_PX = 10;
const LABEL_SUPERSAMPLE = 2;
// The label's own text height, as a fraction of ITS PART's footprint
// diagonal -- fixed relative to that PART's scale, not the bed or the
// screen (unlike DimensionAxes' labels, this view is a static snapshot,
// never re-fit per frame): since LineArtRenderer's own camera fit always
// scales the WHOLE layout to fill the same fraction of the canvas
// regardless of its real mm size, and a part's own on-screen size then
// follows its share of that layout, sizing each label off its OWN part
// (not the bed, which can dwarf a small part) keeps every label legible
// and proportionate -- a big core and its much smaller mount plate each
// get a label sized to themselves, not to the bed both happen to share.
const LABEL_HEIGHT_FRACTION = 0.28;

/** A camera-facing text sprite naming a part (issue #78 AC: "the part names
 * ... are visible"), on the same overlay layer `DimensionAxes` uses for its
 * own labels (drawn straight onto the canvas, after FXAA, so the edge
 * detector never outlines it). `footprintSize` is that part's own footprint
 * diagonal (`PrintLayoutPart.footprintSize`), driving the label's size (see
 * `LABEL_HEIGHT_FRACTION` above). Caller positions it (`labelPosition`
 * above, an unrelated ONE-time placement -- this view never re-fits) and
 * disposes its texture/material. */
export function buildPartLabel(text: string, footprintSize: number): THREE.Sprite {
  const mmPerPx = (LABEL_HEIGHT_FRACTION * footprintSize) / LABEL_FONT_PX;
  const scale = LABEL_SUPERSAMPLE * (typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);
  const font = `bold ${LABEL_FONT_PX}px sans-serif`;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  ctx.font = font;
  const widthPx = Math.ceil(ctx.measureText(text).width) + 2 * LABEL_PAD_PX;
  const heightPx = LABEL_FONT_PX + 2 * LABEL_PAD_PX;
  canvas.width = Math.ceil(widthPx * scale);
  canvas.height = Math.ceil(heightPx * scale);
  ctx.scale(scale, scale);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, widthPx, heightPx);
  ctx.font = font;
  ctx.fillStyle = "#000";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, widthPx / 2, heightPx / 2 + 1);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;

  const material = new THREE.SpriteMaterial({ map: texture, depthTest: false, depthWrite: false, transparent: true });
  const sprite = new THREE.Sprite(material);
  sprite.layers.set(DIMENSION_LABEL_LAYER);
  sprite.frustumCulled = false;
  sprite.renderOrder = 1;
  sprite.scale.set(widthPx * mmPerPx, heightPx * mmPerPx, 1);
  return sprite;
}
