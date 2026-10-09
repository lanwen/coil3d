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

const hasWorkerSupport = () => typeof Worker !== "undefined";

export async function exportStep(design: Design): Promise<Uint8Array<ArrayBuffer>> {
  if (hasWorkerSupport()) return runInWorker(design);
  const { buildStep } = await import("./build");
  return buildStep(design);
}
