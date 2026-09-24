// Worker entry point: runs the coil core's design() (src/core/design.ts) off
// the main thread (issue #7, docs/research.md "Workers": "all geometry runs
// off the main thread"). Unlike the STEP export worker (core/step/worker.ts
// + core/step/index.ts), which is created lazily, once, only when the user
// asks for a STEP file, this worker is created once by GeometryWorkerClient
// and kept alive for the app's lifetime: every edit needs a fresh draft
// and/or final design, not just exports.
//
// Imports design() directly from its own module, not the core/index.ts
// barrel, so this worker's bundle never pulls in the barrel's (lazy, dynamic)
// STEP/replicad path -- it only ever needs solve.ts, wall.ts and manifold.ts.

import { design } from "../core/design";
import type { CoilSpec, Design, Resolution } from "../core/types";

export interface GeometryRequest {
  id: number;
  spec: CoilSpec;
  resolution: Resolution;
}

export type GeometryResponse = { id: number; ok: true; design: Design } | { id: number; ok: false; error: string };

// Cast away the DOM `self` typing (this file runs in a worker, not a
// window) rather than pull in the `webworker` lib project-wide (matches
// core/step/worker.ts's own cast).
interface WorkerScope {
  onmessage: ((ev: MessageEvent<GeometryRequest>) => void) | null;
  postMessage: (data: GeometryResponse, transfer?: Transferable[]) => void;
}
const scope = self as unknown as WorkerScope;

scope.onmessage = (ev) => {
  const { id, spec, resolution } = ev.data;
  design(spec, resolution).then(
    (d) =>
      scope.postMessage({ id, ok: true, design: d }, [
        // Issue #9: every part's mesh (not just the core's -- `d.mesh` is the
        // same buffer as `d.parts[0].mesh`, so transferring it twice would
        // throw) is a typed array; transfer them all for zero-copy.
        ...d.parts.flatMap((p) => [p.mesh.positions.buffer, p.mesh.indices.buffer]),
        // The schematic wound-cable path per layer (issue #4) is typed
        // arrays too; transfer them for the same zero-copy reason as the mesh.
        ...d.wirePaths.map((p) => p.points.buffer),
      ]),
    (err: unknown) => scope.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) }),
  );
};
