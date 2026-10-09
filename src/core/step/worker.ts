import { buildStep } from "./build";
import type { Design } from "../types";

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
