import type { Design } from "../types";
import type { StepOptions, StepWorkerMessage } from "./progress";

const abortError = () => new DOMException("STEP export aborted", "AbortError");

function runInWorker(design: Design, { onProgress, signal }: StepOptions): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    const finish = () => {
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
    };
    const onAbort = () => {
      finish();
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort);
    worker.onmessage = (ev: MessageEvent<StepWorkerMessage>) => {
      if (signal?.aborted) return;
      const message = ev.data;
      if (message.kind === "plan" || message.kind === "stage") {
        onProgress?.(message);
        return;
      }
      finish();
      if (message.kind === "done") resolve(message.bytes);
      else reject(new Error(message.message));
    };
    worker.onerror = (ev: ErrorEvent) => {
      finish();
      reject(new Error(ev.message || "STEP export worker error"));
    };
    worker.postMessage(design);
  });
}

const hasWorkerSupport = () => typeof Worker !== "undefined";

export async function exportStep(design: Design, options: StepOptions = {}): Promise<Uint8Array<ArrayBuffer>> {
  if (hasWorkerSupport()) return runInWorker(design, options);
  options.signal?.throwIfAborted();
  const { buildStep } = await import("./build");
  const bytes = await buildStep(design, options.onProgress);
  options.signal?.throwIfAborted();
  return bytes;
}
