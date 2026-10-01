// The draft-to-final preview state machine (issue #7, smoothed by issue
// #72). Owns the geometry worker's lifetime and turns spec edits into
// debounced, cancellable design() requests.
//
// Issue #72: the original version fired a short-debounced "draft" request on
// EVERY edit (60ms) followed by a longer-debounced "final" request (400ms).
// Since final always lands after draft, that guaranteed a visible
// draft-mesh flash on every single settle, not just slow ones -- and each of
// those two mesh swaps also kicked LineArtRenderer's own camera-fit tween
// (see LineArtRenderer.tsx's geometry-change effect), so a parameter edit
// visibly "grew" the model from the draft's own bounds up to the final's.
// The fix keeps the LAST FINAL result on screen untouched while a new edit
// is still resolving, and only falls back to showing a draft if the new
// final is taking noticeably long -- so most edits go straight from one
// final mesh to the next, with nothing in between for the camera to tween
// through (LineArtRenderer.tsx additionally ignores non-final geometry for
// framing purposes, so even that fallback draft never moves the camera).
//
// "Cancel stale jobs" is implemented as "drop stale results", which is all a
// synchronous WASM computation lets a caller do anyway: a generation counter
// is bumped on every spec change, and a request's result is only applied if
// its generation is still the latest when the response arrives. A newer spec
// change also clears any not-yet-fired timers, so most edits during a drag
// never even reach the worker.

import { useEffect, useRef, useState } from "react";
import { GeometryWorkerClient } from "./client";
import type { CoilSpec, Design } from "../core";

// How long an edit must sit still before it's even worth asking the worker
// for a new final mesh -- long enough to coalesce a whole pointer-drag's
// worth of intermediate spec values (a slider fires a new spec on every
// pointer-move frame, ~16ms apart) into one build, short enough that a
// paused drag still feels responsive. Tuned within the issue's own
// suggested 250-400ms band.
const EDIT_DEBOUNCE_MS = 300;
// Once an edit has settled and the final build is under way, this is how
// long the OLD final mesh stays on screen before falling back to a (cheap,
// low-res) draft -- a safety valve for a genuinely slow build, not the
// common case. Most builds finish well under this, so most edits never show
// a draft at all: the old final is simply replaced by the new one.
const DRAFT_FALLBACK_MS = 600;

// The very first design on a fresh page load has no "last final" to keep
// showing, so it uses the OLD (pre-#72) fast-draft-then-final timings
// instead of the edit path above -- otherwise the page would sit blank for
// EDIT_DEBOUNCE_MS + build time before its first render.
const INITIAL_DRAFT_DEBOUNCE_MS = 60;
const INITIAL_FINAL_DEBOUNCE_MS = 400;

export interface DesignPreview {
  /** The design currently shown: the last FINAL result until a new one is
   * ready (issue #72 -- no more showing every intermediate draft), falling
   * back to a draft only if the new final is taking a while (see
   * DRAFT_FALLBACK_MS). Null until the very first request resolves. */
  result: Design | null;
  error: string | null;
  /** True once `result` is a final-resolution design that matches the
   * CURRENT spec. Exports must gate on this (issue #7 AC: "Exports always
   * use the final resolution") -- it flips back to false the instant a new
   * edit starts, even though `result` itself keeps showing the previous
   * final's content for a while longer, so a stale-spec (or draft-
   * resolution) mesh is never offered for download. */
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
  // Whether ANY request has ever resolved yet -- distinguishes the very
  // first (nothing-to-keep-showing) load from every later edit (which keeps
  // showing its predecessor). A ref, not state: it must be current already
  // inside the same effect run that flips it, before the next render.
  const hasShown = useRef(false);
  const [result, setResult] = useState<Design | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [finalReady, setFinalReady] = useState(false);

  useEffect(() => {
    const myGeneration = ++generation.current;
    setError(null);
    // A new edit immediately invalidates the previous final, even though
    // `result` itself doesn't change yet (see the interface doc above).
    setFinalReady(false);

    // Guards against the final response arriving, then a still-in-flight
    // (or not-yet-fired) draft request landing afterwards and overwriting it
    // -- draft is meant as a "final is slow" fallback only, never allowed to
    // replace a final that already arrived for this same generation.
    let finalArrived = false;

    const applyFinal = (d: Design) => {
      if (generation.current !== myGeneration) return; // a newer edit already superseded this request
      hasShown.current = true;
      finalArrived = true;
      setResult(d);
      setFinalReady(true);
    };
    const applyDraft = (d: Design) => {
      if (generation.current !== myGeneration || finalArrived) return;
      hasShown.current = true;
      setResult(d); // fallback content only -- finalReady stays false
    };
    const fail = (err: unknown) => {
      if (generation.current === myGeneration) setError(err instanceof Error ? err.message : String(err));
    };

    const timers: number[] = [];
    const client = clientRef.current;

    if (!hasShown.current) {
      // First load: nothing on screen yet, so get SOMETHING up fast rather
      // than leave the page blank for EDIT_DEBOUNCE_MS + DRAFT_FALLBACK_MS.
      timers.push(window.setTimeout(() => client?.request(spec, "draft").then(applyDraft, fail), INITIAL_DRAFT_DEBOUNCE_MS));
      timers.push(window.setTimeout(() => client?.request(spec, "final").then(applyFinal, fail), INITIAL_FINAL_DEBOUNCE_MS));
    } else {
      // A real edit: wait for input to settle, then go straight for the
      // final mesh -- the previous final stays on screen the whole time.
      timers.push(
        window.setTimeout(() => {
          client?.request(spec, "final").then(applyFinal, fail);
          // Safety valve: if that final is slow, show a draft rather than
          // leave the (now stale) previous final up indefinitely. Started
          // only once the edit has already settled, so this never fires
          // mid-drag. If the final has already landed by the time it fires,
          // the draft would be built just to be thrown away, so skip it.
          timers.push(
            window.setTimeout(() => {
              if (!finalArrived) client?.request(spec, "draft").then(applyDraft, fail);
            }, DRAFT_FALLBACK_MS),
          );
        }, EDIT_DEBOUNCE_MS),
      );
    }

    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [spec]);

  return { result, error, finalReady };
}
