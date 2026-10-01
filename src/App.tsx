import { useEffect, useState } from "react";
import { exportDesign, parseHash, toHash } from "./core";
import type { CoilSpec, ViewMode } from "./core";
import { useDesignPreview } from "./geometry/useDesignPreview";
import { ControlsForm } from "./components/ControlsForm";
import { ResultPanel } from "./components/ResultPanel";
import { CoilViewer } from "./viewer/CoilViewer";
import { ProjectionToggle } from "./viewer/ViewControls";
import type { Projection } from "./viewer/lineArt/LineArtRenderer";
import { EyeToggle } from "./components/fields";
import { HINTS } from "./components/hints";
import { Guide } from "./guide/Guide";
import "./App.css";

function readInitialState() {
  return parseHash(window.location.hash);
}

export default function App() {
  const [{ spec, notice, showWire: initialShowWire, view: initialView }] = useState(readInitialState);
  const [currentSpec, setCurrentSpec] = useState<CoilSpec>(spec);
  // Wire visibility (issue #4) is a view-only setting, not a CoilSpec field
  // (design() always computes wirePaths regardless), so it's tracked
  // alongside the spec here rather than inside it.
  const [showWire, setShowWire] = useState(initialShowWire);
  // Exploded view (issue #9) is a view-only toggle, not part of the shared
  // hash (only cap/joint/tol are, per the ticket) -- it resets on reload,
  // same as the wire toggle's initial value would if it weren't persisted.
  const [exploded, setExploded] = useState(false);
  // Dimension axes (issue #69): view-only too, on by default.
  const [showDimensions, setShowDimensions] = useState(true);
  // Isometric/perspective camera (issue #15): view-only, resets on reload.
  // Lifted here from CoilViewer by issue #145 so its switch sits with the
  // three toggles above (one strip under the canvas on a phone).
  const [projection, setProjection] = useState<Projection>("ortho");
  // Print layout (issue #78 PR review): while that view is active, the
  // wire/dimensions toggles below have no effect (the view force-hides both
  // itself -- there's nothing to show), so they're hidden rather than left
  // sitting there, checked, doing nothing. `showWire`/`showDimensions`
  // themselves are untouched, so leaving the view "restores" them for free.
  const [isPrintLayout, setIsPrintLayout] = useState(false);
  // Design/guide view switch (issue #17): a plain UI-routing concern, not
  // part of `CoilSpec` -- it changes nothing about the solved design, only
  // which component App renders. It round-trips through the SAME `#s=`
  // document as the spec and the wire toggle (issue #56: `core/hash.ts`'s
  // own `ParsedHash.view`/`toHash`'s own `view` parameter), so a shared
  // guide link still opens straight into the guide.
  const [view, setView] = useState<ViewMode>(initialView);

  // The hash reflects the spec, the wire toggle and the view (all inside
  // the one document now, see hash.ts), but none of toggling the wire,
  // exploding the view or switching views ever needs a re-solve, so this is
  // independent of useDesignPreview below.
  useEffect(() => {
    window.history.replaceState(null, "", toHash(currentSpec, showWire, view));
  }, [currentSpec, showWire, view]);

  // Issue #7: design() runs off the main thread in a worker, debounced, with
  // a fast draft while editing and the final (FDM-tuned) mesh once input
  // settles. See src/geometry/useDesignPreview.ts.
  const { result, error, finalReady } = useDesignPreview(currentSpec);

  const [stepError, setStepError] = useState<string | null>(null);
  const [stepBusy, setStepBusy] = useState(false);

  const downloadBytes = (bytes: Uint8Array<ArrayBuffer>, filename: string, type: string) => {
    const blob = new Blob([bytes], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handleDownloadStl = async () => {
    // finalReady already gates the button, but never trust disabled-ness
    // alone: exports must always use the final resolution (issue #7).
    if (!result || !finalReady) return;
    const bytes = await exportDesign(result, "stl");
    // One part -> a plain STL; two or more (issue #9: a top cap) -> a zip of
    // one STL per part, each already in its own print-bed orientation (see
    // core/export.ts).
    const multiPart = result.parts.length > 1;
    downloadBytes(bytes, multiPart ? "coil-parts.zip" : "coil.stl", multiPart ? "application/zip" : "model/stl");
  };

  const handleDownloadThreeMf = async () => {
    if (!result || !finalReady) return;
    const bytes = await exportDesign(result, "3mf");
    downloadBytes(bytes, "coil.3mf", "model/3mf");
  };

  const handleDownloadStep = async () => {
    if (!result || !finalReady) return;
    setStepError(null);
    setStepBusy(true);
    try {
      const bytes = await exportDesign(result, "step");
      downloadBytes(bytes, "coil.step", "model/step");
    } catch (err) {
      setStepError(err instanceof Error ? err.message : String(err));
    } finally {
      setStepBusy(false);
    }
  };

  // The guide (issue #17) is generated straight from the current solved
  // Design -- same hash, same spec -- so a shared `&view=guide` link opens
  // it directly. Before the first design resolves (a brand-new page load),
  // show a plain placeholder rather than nothing: `result` starts null even
  // for the very first draft (useDesignPreview.ts), and the guide has no
  // meaningful content without at least one solved design to draw.
  if (view === "guide") {
    return result ? (
      <Guide design={result} onBack={() => setView("design")} />
    ) : (
      <p className="settling" data-testid="guide-loading">
        Solving the design…
      </p>
    );
  }

  return (
    <div className="app">
      <header>
        <h1>coil3d</h1>
        <p>Design a 3D-printable cable coil from your cable's length and diameter.</p>
      </header>
      {notice && (
        <p className="notice" data-testid="hash-notice">
          {notice}
        </p>
      )}
      <div className="layout">
        <div className="sidebar">
          <ControlsForm spec={currentSpec} solution={result?.solution} design={result} finalReady={finalReady} onChange={setCurrentSpec} />
          {error && (
            <p className="error" data-testid="design-error">
              {error}
            </p>
          )}
          {result && (
            <ResultPanel
              design={result}
              finalReady={finalReady}
              onDownloadStl={handleDownloadStl}
              onDownloadThreeMf={handleDownloadThreeMf}
              onDownloadStep={handleDownloadStep}
              stepBusy={stepBusy}
            />
          )}
          {stepError && (
            <p className="error" data-testid="step-error">
              {stepError}
            </p>
          )}
          {result && (
            <button type="button" className="btn-primary guide-nav-btn" data-testid="open-guide" onClick={() => setView("guide")}>
              Assembly guide
            </button>
          )}
        </div>
        <div className="viewer">
          {result && (
            <>
              <CoilViewer
                parts={result.parts}
                resolution={result.resolution}
                wirePaths={result.wirePaths}
                innerEndLeadIn={result.innerEndLeadIn}
                layerTransitions={result.layerTransitions}
                outerEndLeadOut={result.outerEndLeadOut}
                cablePath={result.cablePath}
                wireDiameter={result.spec.wire.diameter}
                showWire={showWire}
                exploded={exploded}
                mountAxisDeg={result.mountAxisDeg}
                envelopeWidth={result.solution.flangeExtent?.acrossFlats ?? result.solution.flangeSize}
                overallHeight={result.solution.overallHeight}
                showDimensions={showDimensions}
                shapeKind={result.spec.shape.kind}
                bed={result.spec.print}
                onPrintLayoutActiveChange={setIsPrintLayout}
                mountKind={result.spec.mount}
                pegboard={result.pegboard}
                projection={projection}
              />
              {/* The viewport toggles (issue #145): overlaid on the canvas's
                  corners on desktop (the wrapper is `display: contents`
                  there), one strip under the canvas on a phone -- see
                  App.css's `.viewport-toggles`. After the canvas in the DOM
                  so the phone's tab order follows what's on screen. */}
              <div className="viewport-toggles" data-testid="viewport-toggles">
                {!isPrintLayout && (
                  <div className="wire-toggle">
                    <EyeToggle testId="wire" label="Show wound cable" checked={showWire} hint={HINTS.wire} onChange={setShowWire} />
                  </div>
                )}
                {!isPrintLayout && (
                  <div className="dimensions-toggle">
                    <EyeToggle testId="dimensions" label="Dimensions" checked={showDimensions} hint={HINTS.dimensions} onChange={setShowDimensions} />
                  </div>
                )}
                {!isPrintLayout && result.parts.length > 1 && (
                  <div className="explode-toggle">
                    <EyeToggle testId="exploded" label="Exploded view" checked={exploded} hint={HINTS.exploded} onChange={setExploded} />
                  </div>
                )}
                <ProjectionToggle projection={projection} onProjectionChange={setProjection} />
              </div>
            </>
          )}
          {/* Bottom-right credits: the author link and the third-party
              notices (public/THIRD_PARTY_NOTICES.txt, served from the app's
              base path so it also works under a sub-path deploy). */}
          <div className="credits">
            <a className="author-link" data-testid="author-link" href="https://github.com/lanwen" target="_blank" rel="noopener noreferrer">
              <svg className="author-link-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
                <path
                  fill="currentColor"
                  d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"
                />
              </svg>
              lanwen
            </a>
            <a className="licenses-link" data-testid="licenses-link" href={`${import.meta.env.BASE_URL}THIRD_PARTY_NOTICES.txt`} target="_blank" rel="noopener noreferrer">
              Licenses
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
