// Fuses the bottom flange onto the grooved wall with manifold-3d (the only
// boolean this tracer bullet needs — see docs/research.md §4: "don't
// boolean the groove", but a flat flange is a fine manifold union).
//
// The flange itself is a direct parametric mesh too (wall.ts's
// `buildOutlineRing`), shaped like the core's own outline extended outward
// by `margin` -- not a bounding circle (issue #6 AC "the flange for
// non-round shapes should follow the offset outline"). Round keeps
// producing a plain circular flange for free, since round's outline IS a
// circle (see shapes.ts).
//
// manifold-3d ships a single-threaded WASM build, so this works without
// COOP/COEP headers (fine for GitHub Pages / `vite preview`).

import Module, { type ManifoldToplevel } from "manifold-3d";
import { buildOutlineRing } from "./wall";
import type { ShapeOutline } from "./shapes";
import type { CoilMesh } from "./types";

let wasmPromise: Promise<ManifoldToplevel> | undefined;

function getWasm(): Promise<ManifoldToplevel> {
  if (!wasmPromise) {
    wasmPromise = Module().then((wasm) => {
      wasm.setup();
      return wasm;
    });
  }
  return wasmPromise;
}

export interface FlangeSpec {
  /** The wall's own outline at offset 0; the flange's outer edge is this outline offset outward by `margin`. */
  outline: ShapeOutline;
  /** The wall's own bore outline (the flange shares the same bore). */
  boreOutline: ShapeOutline;
  /** How far beyond `outline` the flange extends, mm (docs/research.md §1). */
  margin: number;
  thickness: number;
  /** Columns around the circumference (mirrors WallSpec.columns). */
  columns: number;
}

/** Fuse a bottom flange (shaped like `flange.outline`, offset out by `flange.margin`) onto the wall. */
export async function fuseFlange(wall: CoilMesh, flange: FlangeSpec): Promise<CoilMesh> {
  const wasm = await getWasm();
  const { Manifold, Mesh } = wasm;
  const trash: { delete(): void }[] = [];
  const track = <T extends { delete(): void }>(m: T): T => {
    trash.push(m);
    return m;
  };

  try {
    const wallManifold = track(new Manifold(new Mesh({ numProp: 3, vertProperties: wall.positions, triVerts: wall.indices })));
    if (wallManifold.status() !== "NoError") {
      throw new Error(`Wall mesh is not a valid manifold: ${wallManifold.status()}`);
    }

    const ringMesh = buildOutlineRing(flange.outline, flange.margin, flange.boreOutline, -flange.thickness, 0, flange.columns);
    const ringManifold = track(new Manifold(new Mesh({ numProp: 3, vertProperties: ringMesh.positions, triVerts: ringMesh.indices })));
    if (ringManifold.status() !== "NoError") {
      throw new Error(`Flange mesh is not a valid manifold: ${ringManifold.status()}`);
    }

    const fused = track(wallManifold.add(ringManifold));
    const status = fused.status();
    if (status !== "NoError") {
      throw new Error(`Fused mesh is not a valid manifold: ${status}`);
    }

    const outMesh = fused.getMesh();
    return {
      positions: new Float32Array(outMesh.vertProperties),
      indices: new Uint32Array(outMesh.triVerts),
    };
  } finally {
    for (const m of trash) m.delete();
  }
}
