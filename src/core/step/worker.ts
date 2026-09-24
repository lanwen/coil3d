// Worker entry point: runs the replicad-based STEP build (build.ts) off
// the main thread, so the WASM download/parse and the build itself never
// block the UI (see step/index.ts). Bundled as its own chunk by Vite, only
// fetched once a worker is actually constructed.

import { buildStep } from "./build";
import type { Design } from "../types";

// Cast away the DOM `self` typing (this file runs in a worker, not a
// window) rather than pull in the `webworker` lib project-wide.
interface WorkerScope {
  onmessage: ((ev: MessageEvent<Design>) => void) | null;
  postMessage: (data: unknown) => void;
}
const scope = self as unknown as WorkerScope;

scope.onmessage = (ev) => {
  buildStep(ev.data).then(
    (bytes) => scope.postMessage({ ok: true, bytes }),
    (err: unknown) => scope.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) }),
  );
};
