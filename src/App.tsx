import { useEffect, useState } from "react";
import { exportDesign, parseHash, toHash } from "./core";
import type { CoilSpec } from "./core";
import { useDesignPreview } from "./geometry/useDesignPreview";
import { ControlsForm } from "./components/ControlsForm";
import { ResultPanel } from "./components/ResultPanel";
import { CoilViewer } from "./viewer/CoilViewer";
import "./App.css";

function readInitialState() {
  return parseHash(window.location.hash);
}

export default function App() {
  const [{ spec, notice, showWire: initialShowWire }] = useState(readInitialState);
  const [currentSpec, setCurrentSpec] = useState<CoilSpec>(spec);
  // Wire visibility (issue #4) is a view-only setting, not a CoilSpec field
  // (design() always computes wirePaths regardless), so it's tracked
  // alongside the spec here rather than inside it.
  const [showWire, setShowWire] = useState(initialShowWire);

  // The hash reflects both the spec and the wire toggle, but toggling the
  // wire never needs a re-solve, so it's independent of useDesignPreview below.
  useEffect(() => {
    window.history.replaceState(null, "", toHash(currentSpec, showWire));
  }, [currentSpec, showWire]);

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
    downloadBytes(bytes, "coil.stl", "model/stl");
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

  return (
    <div className="app">
      <header>
        <h1>scroll3d</h1>
        <p>Design a 3D-printable cable coil from your cable's length and diameter.</p>
      </header>
      {notice && (
        <p className="notice" data-testid="hash-notice">
          {notice}
        </p>
      )}
      <div className="layout">
        <div className="sidebar">
          <ControlsForm spec={currentSpec} solution={result?.solution} onChange={setCurrentSpec} />
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
              onDownloadStep={handleDownloadStep}
              stepBusy={stepBusy}
            />
          )}
          {stepError && (
            <p className="error" data-testid="step-error">
              {stepError}
            </p>
          )}
        </div>
        <div className="viewer">
          {result && (
            <>
              <label className="wire-toggle">
                <input
                  type="checkbox"
                  data-testid="toggle-wire"
                  checked={showWire}
                  onChange={(e) => setShowWire(e.target.checked)}
                />
                <span>Show wound cable</span>
              </label>
              <CoilViewer
                mesh={result.mesh}
                resolution={result.resolution}
                wirePaths={result.wirePaths}
                wireDiameter={result.spec.wire.diameter}
                showWire={showWire}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
