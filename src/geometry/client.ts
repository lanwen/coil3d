import type { GeometryRequest, GeometryResponse } from "./worker";
import type { CoilSpec, Design, Resolution } from "../core";

export class GeometryWorkerClient {
  private worker: Worker;
  private nextId = 0;
  private pending = new Map<number, { resolve: (d: Design) => void; reject: (err: Error) => void }>();

  constructor() {
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (ev: MessageEvent<GeometryResponse>) => {
      const res = ev.data;
      const entry = this.pending.get(res.id);
      if (!entry) return;
      this.pending.delete(res.id);
      if (res.ok) entry.resolve(res.design);
      else entry.reject(new Error(res.error));
    };
    this.worker.onerror = (ev: ErrorEvent) => {
      for (const entry of this.pending.values()) entry.reject(new Error(ev.message || "geometry worker error"));
      this.pending.clear();
    };
  }

  request(spec: CoilSpec, resolution: Resolution): Promise<Design> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const req: GeometryRequest = { id, spec, resolution };
      this.worker.postMessage(req);
    });
  }

  terminate() {
    this.worker.terminate();
    this.pending.clear();
  }
}
