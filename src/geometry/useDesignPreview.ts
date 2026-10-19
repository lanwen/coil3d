import { useEffect, useRef, useState } from "react";
import { GeometryWorkerClient } from "./client";
import type { CoilSpec, Design } from "../core";

const EDIT_DEBOUNCE_MS = 300;
const DRAFT_FALLBACK_MS = 600;

const INITIAL_DRAFT_DEBOUNCE_MS = 60;

export interface DesignPreview {
  result: Design | null;
  error: string | null;
  finalReady: boolean;
}

export function useDesignPreview(spec: CoilSpec): DesignPreview {
  const clientRef = useRef<GeometryWorkerClient | null>(null);
  useEffect(() => {
    const client = new GeometryWorkerClient();
    clientRef.current = client;
    return () => {
      client.terminate();
      clientRef.current = null;
    };
  }, []);

  const generation = useRef(0);
  const hasShown = useRef(false);
  const [result, setResult] = useState<Design | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [finalReady, setFinalReady] = useState(false);

  useEffect(() => {
    const myGeneration = ++generation.current;
    setError(null);
    setFinalReady(false);

    let finalArrived = false;

    const isSuperseded = () => generation.current !== myGeneration;
    const applyFinal = (d: Design) => {
      if (isSuperseded()) return;
      hasShown.current = true;
      finalArrived = true;
      setResult(d);
      setFinalReady(true);
    };
    const applyDraft = (d: Design) => {
      if (isSuperseded() || finalArrived) return;
      hasShown.current = true;
      setResult(d);
    };
    const fail = (err: unknown) => {
      if (!isSuperseded()) setError(err instanceof Error ? err.message : String(err));
    };

    const timers: number[] = [];
    const client = clientRef.current;
    const requestFinal = () => client?.request(spec, "final").then(applyFinal, fail);
    const requestDraft = () => client?.request(spec, "draft").then(applyDraft, fail);

    if (!hasShown.current) {
      timers.push(
        window.setTimeout(() => {
          requestDraft()?.then(() => {
            if (!isSuperseded()) requestFinal();
          });
        }, INITIAL_DRAFT_DEBOUNCE_MS),
      );
    } else {
      timers.push(
        window.setTimeout(() => {
          requestFinal();
          timers.push(
            window.setTimeout(() => {
              if (!finalArrived) requestDraft();
            }, DRAFT_FALLBACK_MS),
          );
        }, EDIT_DEBOUNCE_MS),
      );
    }

    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [spec]);

  return { result, error, finalReady };
}
