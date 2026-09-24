// Fuses the bottom flange onto the grooved wall with manifold-3d (the only
// boolean this tracer bullet needs — see docs/research.md §4: "don't
// boolean the groove", but a flat flange is a fine manifold union).
//
// manifold-3d ships a single-threaded WASM build, so this works without
// COOP/COEP headers (fine for GitHub Pages / `vite preview`).

import Module, { type ManifoldToplevel } from "manifold-3d";
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
  outerRadius: number;
  boreRadius: number;
  margin: number;
  thickness: number;
  /** Circular segments used for the flange's own circles. */
  segments: number;
}

/** Fuse a bottom flange (a ring, outer radius + margin) onto the wall. */
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

    const flangeOuterRadius = flange.outerRadius + flange.margin;
    // z in [0, thickness].
    const flangeOuter = track(Manifold.cylinder(flange.thickness, flangeOuterRadius, flangeOuterRadius, flange.segments));
    // Taller than the flange and straddling both faces, so the subtraction
    // leaves no coplanar sliver.
    const flangeInner = track(
      Manifold.cylinder(flange.thickness + 2, flange.boreRadius, flange.boreRadius, flange.segments).translate(0, 0, -1),
    );
    const ring = track(flangeOuter.subtract(flangeInner));
    const ringAtBase = track(ring.translate(0, 0, -flange.thickness)); // z in [-thickness, 0]

    const fused = track(wallManifold.add(ringAtBase));
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
