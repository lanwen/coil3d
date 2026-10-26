import { useCallback, useEffect, useRef, useState } from "react";
import { exportDesign } from "./core";
import type { CoilSpec, Design, StepStage, StepStageId } from "./core";

export interface StepExportState {
  startedAt: number;
  plan: StepStage[];
  stage: StepStageId | null;
  restarting: boolean;
}

interface Run {
  controller: AbortController;
  specKey: string;
}

const isAbort = (err: unknown) => err instanceof DOMException && err.name === "AbortError";

export function useStepExport({
  design,
  finalReady,
  spec,
  paused,
  onBytes,
}: {
  design: Design | null;
  finalReady: boolean;
  spec: CoilSpec;
  paused: boolean;
  onBytes: (bytes: Uint8Array<ArrayBuffer>) => void;
}) {
  const [state, setState] = useState<StepExportState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restartPending, setRestartPending] = useState(false);
  const run = useRef<Run | null>(null);
  const onBytesRef = useRef(onBytes);
  onBytesRef.current = onBytes;
  const specKey = JSON.stringify(spec);

  const launch = useCallback((target: Design, key: string) => {
    const controller = new AbortController();
    const mine: Run = { controller, specKey: key };
    run.current = mine;
    setError(null);
    setState((prev) => ({ startedAt: prev?.startedAt ?? Date.now(), plan: [], stage: null, restarting: prev?.restarting ?? false }));
    exportDesign(target, "step", {
      signal: controller.signal,
      onProgress: (event) => {
        if (run.current !== mine) return;
        setState((prev) => {
          if (!prev) return prev;
          if (event.kind === "plan") return { ...prev, plan: event.stages };
          return { ...prev, stage: event.id, restarting: false };
        });
      },
    }).then(
      (bytes) => {
        if (run.current !== mine) return;
        run.current = null;
        setState(null);
        onBytesRef.current(bytes);
      },
      (err: unknown) => {
        if (run.current !== mine || isAbort(err)) return;
        run.current = null;
        setState(null);
        setError(err instanceof Error ? err.message : String(err));
      },
    );
  }, []);

  const start = useCallback(() => {
    if (!design || !finalReady || run.current) return;
    launch(design, specKey);
  }, [design, finalReady, specKey, launch]);

  const cancel = useCallback(() => {
    run.current?.controller.abort();
    run.current = null;
    setRestartPending(false);
    setState(null);
  }, []);

  useEffect(() => {
    const current = run.current;
    if (!current || current.specKey === specKey) return;
    current.controller.abort();
    run.current = null;
    setState((prev) => prev && { ...prev, plan: [], stage: null, restarting: true });
    setRestartPending(true);
  }, [specKey]);

  useEffect(() => {
    if (!restartPending || !finalReady || paused || !design) return;
    setRestartPending(false);
    launch(design, specKey);
  }, [restartPending, finalReady, paused, design, specKey, launch]);

  useEffect(() => () => run.current?.controller.abort(), []);

  return { state, error, start, cancel };
}
