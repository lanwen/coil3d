import { useCallback, useEffect, useState } from "react";
import { exportDesign, parseHash, toHash } from "./core";
import type { CoilSpec, ViewMode } from "./core";
import { useDesignPreview } from "./geometry/useDesignPreview";
import { ControlsForm } from "./components/ControlsForm";
import { CustomizePanel } from "./components/CustomizePanel";
import { ResultPanel } from "./components/ResultPanel";
import { CoilViewer } from "./viewer/CoilViewer";
import { ViewerBoundary, ViewerUnavailable } from "./viewer/ViewerBoundary";
import { ProjectionToggle } from "./viewer/ViewControls";
import type { Projection } from "./viewer/lineArt/LineArtRenderer";
import type { FaceId } from "./viewer/lineArt/presets";
import { EyeToggle } from "./components/fields";
import { CoilMark } from "./components/CoilMark";
import { HeaderActions } from "./components/HeaderActions";
import { HINTS } from "./components/hints";
import { Guide } from "./guide/Guide";
import "./App.css";

const FACES: FaceId[] = ["cap", "base"];

interface CustomizeSession {
  draft: CoilSpec;
  face: FaceId;
}

function readInitialState() {
  return parseHash(window.location.hash);
}

function BuildLabel() {
  const { commit, short, builtAt, branch } = __BUILD__;
  const text = branch && branch !== "main" ? `${short} (${branch})` : short;
  const title = `Built ${builtAt.slice(0, 16).replace("T", " ")} UTC`;
  if (commit === "dev") {
    return (
      <span className="build-label" data-testid="build-label" title={title} aria-label="Build dev">
        {text}
      </span>
    );
  }
  return (
    <a
      className="build-label"
      data-testid="build-label"
      href={`https://github.com/lanwen/coil3d/commit/${commit}`}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      aria-label={`Build ${short}`}
    >
      {text}
    </a>
  );
}

export default function App() {
  const [{ spec, notice: initialNotice, showWire: initialShowWire, view: initialView }] = useState(readInitialState);
  const [notice, setNotice] = useState(initialNotice);
  const [formKey, setFormKey] = useState(0);
  const [currentSpec, setCurrentSpec] = useState<CoilSpec>(spec);
  const [showWire, setShowWire] = useState(initialShowWire);
  const [exploded, setExploded] = useState(false);
  const [showDimensions, setShowDimensions] = useState(true);
  const [projection, setProjection] = useState<Projection>("ortho");
  const [viewResetKey, setViewResetKey] = useState(0);
  const [isPrintLayout, setIsPrintLayout] = useState(false);
  const [view, setView] = useState<ViewMode>(initialView);
  const [customize, setCustomize] = useState<CustomizeSession | null>(null);
  const customizing = customize !== null;

  useEffect(() => {
    window.history.replaceState(null, "", toHash(currentSpec, showWire, view));
  }, [currentSpec, showWire, view]);

  const { result, error, finalReady } = useDesignPreview(customize?.draft ?? currentSpec);

  const builtFaces = result ? FACES.filter((face) => result.faces[face]) : [];
  const startCustomize = () => {
    if (builtFaces.length > 0) setCustomize({ draft: currentSpec, face: builtFaces[0] });
  };
  const cancelCustomize = () => setCustomize(null);
  const saveCustomize = () => {
    if (!customize) return;
    setCurrentSpec(customize.draft);
    setCustomize(null);
  };
  const setDraft = useCallback((draft: CoilSpec) => setCustomize((session) => session && { ...session, draft }), []);
  const setFace = (face: FaceId) => setCustomize((session) => session && { ...session, face });

  useEffect(() => {
    if (!customizing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      if (document.querySelector('[data-testid="hint-bubble"][data-open]')) return;
      setCustomize(null);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [customizing]);

  const canReset = toHash(currentSpec, showWire, view) !== toHash(parseHash("").spec, showWire, view);
  const handleReset = () => {
    setCustomize(null);
    setCurrentSpec(parseHash("").spec);
    setNotice(undefined);
    setFormKey((key) => key + 1);
  };

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
    if (!result || !finalReady) return;
    const bytes = await exportDesign(result, "stl");
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
        <h1>
          <button type="button" className="logo-btn" data-testid="reset-view" aria-label="Reset view" onClick={() => {
              setCustomize(null);
              setViewResetKey((key) => key + 1);
            }}
          >
            <CoilMark />
            coil3d
          </button>
        </h1>
        <HeaderActions canReset={canReset} onReset={handleReset} />
        <p>Design a 3D-printable cable coil from your cable's length and diameter.</p>
      </header>
      {notice && (
        <p className="notice" data-testid="hash-notice">
          {notice}
        </p>
      )}
      <div className="layout">
        <div className="sidebar">
          {customize ? (
            <CustomizePanel spec={customize.draft} design={result} finalReady={finalReady} face={customize.face} onChange={setDraft} onSave={saveCustomize} onCancel={cancelCustomize} />
          ) : (
            <ControlsForm key={formKey} spec={currentSpec} solution={result?.solution} canCustomize={builtFaces.length > 0} onCustomize={startCustomize} onChange={setCurrentSpec} />
          )}
          {error && (
            <p className="error" data-testid="design-error">
              {error}
            </p>
          )}
          {result && !customizing && (
            <ResultPanel
              design={result}
              spec={currentSpec}
              onChange={setCurrentSpec}
              finalReady={finalReady}
              onDownloadStl={handleDownloadStl}
              onDownloadThreeMf={handleDownloadThreeMf}
              onDownloadStep={handleDownloadStep}
              stepBusy={stepBusy}
            />
          )}
          {stepError && !customizing && (
            <p className="error" data-testid="step-error">
              {stepError}
            </p>
          )}
          {result && !customizing && (
            <button type="button" className="btn-primary guide-nav-btn" data-testid="open-guide" onClick={() => setView("guide")}>
              Assembly guide
            </button>
          )}
        </div>
        <div className="viewer">
          {result && (
            <>
              <ViewerBoundary fallback={<ViewerUnavailable />}>
                <CoilViewer
                  parts={result.parts}
                  resolution={result.resolution}
                  wirePaths={result.wirePaths}
                  innerEndLeadIn={result.innerEndLeadIn}
                  layerTransitions={result.layerTransitions}
                  outerEndLeadOut={result.outerEndLeadOut}
                  outerEndReach={result.faceChannels?.outer !== undefined}
                  cablePath={result.cablePath}
                  wireDiameter={result.spec.wire.diameter}
                  showWire={showWire && !customizing}
                  exploded={exploded && !customizing}
                  mountAxisDeg={result.mountAxisDeg}
                  envelopeWidth={result.solution.flangeExtent?.acrossFlats ?? result.solution.flangeSize}
                  overallHeight={result.solution.overallHeight}
                  showDimensions={showDimensions}
                  shapeKind={result.spec.shape.kind}
                  bed={result.spec.print}
                  onPrintLayoutActiveChange={setIsPrintLayout}
                  mountKind={result.spec.mount}
                  pegboard={result.pegboard}
                  projection={customizing ? "ortho" : projection}
                  viewResetKey={viewResetKey}
                  faceOutline={result.flangeSpec.outline}
                  lockedFace={customize?.face}
                  lockableFaces={builtFaces}
                  onLockedFaceChange={setFace}
                />
              </ViewerBoundary>
              {!customizing && (
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
              )}
            </>
          )}
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
            <BuildLabel />
          </div>
        </div>
      </div>
    </div>
  );
}
