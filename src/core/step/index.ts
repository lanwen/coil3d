// Entry point for STEP export. In a browser (where `Worker` exists), the
// actual build (build.ts, which pulls in replicad's ~5 MB WASM) runs in a
// dedicated Worker so it never blocks the main thread and the WASM is only
// ever fetched once the user asks for a STEP file. In Node (vitest, no
// `Worker` global) it runs inline.

import type { Design } from "../types";

interface WorkerResult {
  ok: boolean;
  bytes?: Uint8Array<ArrayBuffer>;
  error?: string;
}

function runInWorker(design: Design): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (ev: MessageEvent<WorkerResult>) => {
      worker.terminate();
      if (ev.data.ok && ev.data.bytes) resolve(ev.data.bytes);
      else reject(new Error(ev.data.error ?? "STEP export failed in worker"));
    };
    worker.onerror = (ev: ErrorEvent) => {
      worker.terminate();
      reject(new Error(ev.message || "STEP export worker error"));
    };
    worker.postMessage(design);
  });
}

export async function exportStep(design: Design): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof Worker !== "undefined") return runInWorker(design);
  const { buildStep } = await import("./build");
  return buildStep(design);
}
