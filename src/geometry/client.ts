// Client-side bridge to the geometry worker (issue #7). One
// GeometryWorkerClient owns one persistent Worker for the app's lifetime and
// multiplexes concurrent `design()` requests over it by request id, so a
// draft and a final request can both be in flight without racing each
// other's response. Correlating by id (rather than "last message wins") is
// what lets a caller drop a stale result instead of trusting whichever
// response arrives last.

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
      if (!entry) return; // response to a request this client no longer tracks
      this.pending.delete(res.id);
      if (res.ok) entry.resolve(res.design);
      else entry.reject(new Error(res.error));
    };
    this.worker.onerror = (ev: ErrorEvent) => {
      for (const entry of this.pending.values()) entry.reject(new Error(ev.message || "geometry worker error"));
      this.pending.clear();
    };
  }

  /** Request a design() at the given resolution. Every call gets its own
   * response, however many are in flight at once. */
  request(spec: CoilSpec, resolution: Resolution): Promise<Design> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const req: GeometryRequest = { id, spec, resolution };
      this.worker.postMessage(req);
    });
  }

  /** Stop the worker and drop every in-flight request (its promise never
   * settles) -- called when the client itself is torn down, not per-request. */
  terminate() {
    this.worker.terminate();
    this.pending.clear();
  }
}
