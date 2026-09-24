// The draft-to-final preview state machine (issue #7). Owns the geometry
// worker's lifetime and turns spec edits into two debounced, cancellable
// design() requests:
//
//  - a short-debounced "draft" request, so dragging a slider feels instant;
//  - a longer-debounced "final" request, fired once input has settled, at
//    the resolution used for the on-screen render from then on and for every
//    export.
//
// "Cancel stale jobs" is implemented as "drop stale results", which is all a
// synchronous WASM computation lets a caller do anyway: a generation counter
// is bumped on every spec change, and a request's result is only applied if
// its generation is still the latest when the response arrives. A newer spec
// change also clears any not-yet-fired debounce timers, so most edits during
// a drag never even reach the worker.

import { useEffect, useRef, useState } from "react";
import { GeometryWorkerClient } from "./client";
import type { CoilSpec, Design } from "../core";

// Short enough that a dragged slider feels live; long enough to coalesce the
// several spec updates a single pointer-move event can cause.
const DRAFT_DEBOUNCE_MS = 60;
// Long enough that a still-dragging user never sees the (heavier) final
// build fire on every intermediate value; short enough to feel responsive
// once they stop.
const FINAL_DEBOUNCE_MS = 400;

export interface DesignPreview {
  /** The latest design matching the current spec: draft first, then
   * replaced by final once it's ready. Null until the first draft resolves. */
  result: Design | null;
  error: string | null;
  /** True once `result` is a final-resolution design for the CURRENT spec.
   * Exports must gate on this (issue #7 AC: "Exports always use the final
   * resolution") -- it flips back to false the instant a new edit starts a
   * fresh draft, so a stale final mesh is never offered for download. */
  finalReady: boolean;
}

export function useDesignPreview(spec: CoilSpec): DesignPreview {
  // The worker client is a side-effecting external resource (like a socket),
  // not a pure derivation of props -- it must be created AND torn down by
  // the same effect, in a ref, not via useMemo. useMemo's result isn't
  // guaranteed to survive exactly once per mount (React may discard and
  // recompute it, notably under StrictMode's dev-only mount -> cleanup ->
  // mount double-invoke), so a `useEffect` cleanup keyed on a useMemo'd
  // client can terminate the one live worker the app ends up using.
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
  const [result, setResult] = useState<Design | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const myGeneration = ++generation.current;
    setError(null);

    const apply = (d: Design) => {
      if (generation.current === myGeneration) setResult(d);
    };
    const fail = (err: unknown) => {
      if (generation.current === myGeneration) setError(err instanceof Error ? err.message : String(err));
    };

    const draftTimer = window.setTimeout(() => {
      clientRef.current?.request(spec, "draft").then(apply, fail);
    }, DRAFT_DEBOUNCE_MS);
    const finalTimer = window.setTimeout(() => {
      clientRef.current?.request(spec, "final").then(apply, fail);
    }, FINAL_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(draftTimer);
      window.clearTimeout(finalTimer);
    };
  }, [spec]);

  return { result, error, finalReady: result?.resolution === "final" };
}
