import { design } from "../core/design";
import type { CoilSpec, Design, Resolution } from "../core/types";

export interface GeometryRequest {
  id: number;
  spec: CoilSpec;
  resolution: Resolution;
}

export type GeometryResponse = { id: number; ok: true; design: Design } | { id: number; ok: false; error: string };

interface WorkerScope {
  onmessage: ((ev: MessageEvent<GeometryRequest>) => void) | null;
  postMessage: (data: GeometryResponse, transfer?: Transferable[]) => void;
}
const scope = self as unknown as WorkerScope;

function transferableBuffers(d: Design): Transferable[] {
  return [
    ...d.parts.flatMap((p) => [p.mesh.positions.buffer, p.mesh.indices.buffer]),
    ...d.wirePaths.map((p) => p.points.buffer),
    d.innerEndLeadIn.buffer,
    ...d.layerTransitions.map((t) => t.buffer),
    d.outerEndLeadOut.buffer,
    d.cablePath.buffer,
  ];
}

scope.onmessage = (ev) => {
  const { id, spec, resolution } = ev.data;
  design(spec, resolution).then(
    (d) => scope.postMessage({ id, ok: true, design: d }, transferableBuffers(d)),
    (err: unknown) => scope.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) }),
  );
};
