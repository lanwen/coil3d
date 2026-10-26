import { buildStep } from "./build";
import type { StepWorkerMessage } from "./progress";
import type { Design } from "../types";

interface WorkerScope {
  onmessage: ((ev: MessageEvent<Design>) => void) | null;
  postMessage: (data: StepWorkerMessage) => void;
}
const scope = self as unknown as WorkerScope;

scope.onmessage = (ev) => {
  buildStep(ev.data, (event) => scope.postMessage(event)).then(
    (bytes) => scope.postMessage({ kind: "done", bytes }),
    (err: unknown) => scope.postMessage({ kind: "error", message: err instanceof Error ? err.message : String(err) }),
  );
};
