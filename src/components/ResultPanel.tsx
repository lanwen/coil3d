import type { Design, MountKind, Solution } from "../core";
import { Section, mmToCm } from "./fields";
import { Hint } from "./Hint";
import { HINTS } from "./hints";

const MOUNT_LABELS: Record<MountKind, string> = {
  none: "None",
  keyhole: "Screw keyhole",
  through: "Through-holes",
  skadis: "SKÅDIS clip plate",
  opengrid: "openGrid clip plate",
};

const FREE_VARIABLE_LABELS: Record<"coreSize" | "height" | "layers", string> = {
  coreSize: "core size",
  height: "height",
  layers: "layers",
};

function Row({ testId, label, value, hint }: { testId: string; label: string; value: string; hint?: string }) {
  return (
    <div className="result-row">
      <span className="field-label-row">
        <span className="result-label">{label}</span>
        {hint && <Hint text={hint} />}
      </span>
      <span className="result-value" data-testid={testId}>
        {value}
      </span>
    </div>
  );
}

/**
 * The flange's real outer extent (issue #63), formatted for the row below:
 * `solution.flangeExtent` is set once `design()` has resolved the real
 * flange margin (see design.ts/flange.ts) -- undefined only for an
 * `alternates` entry, whose geometry `design()` never actually builds, so
 * this falls back to the solver's own (less accurate) envelope estimate
 * there rather than hiding the row.
 */
function flangeWidthValue(solution: Solution, shapeKind: Design["spec"]["shape"]["kind"]): string {
  const extent = solution.flangeExtent;
  if (!extent) return `${solution.flangeSize.toFixed(1)} mm`;
  return shapeKind === "round" ? `Ø ${extent.acrossFlats.toFixed(1)} mm` : `${extent.acrossFlats.toFixed(1)} mm`;
}

/**
 * The wound cable's own outer size (issue #65), formatted the SAME way as
 * `flangeWidthValue` above: `solution.envelopeDiameter` is already a true
 * circumscribed (across-corners) extent (`capacity.ts`'s `envelopeDiameter`
 * -- for round, across-corners === across-flats, so this still reads as a
 * plain diameter there). Before this issue the row next to it just said
 * "Envelope", which reads as an unrelated, wider number than "Flange
 * width" -- it's actually the SAME across-corners measurement `flangeExtent
 * .acrossCorners` reports below, just for the cable instead of the flange;
 * renamed so the two are directly comparable, with a hint on each row
 * spelling out which of the flange's two rows to compare against.
 */
function cableOuterSizeLabel(shapeKind: Design["spec"]["shape"]["kind"]): string {
  return shapeKind === "round" ? "Cable outer size" : "Cable outer size (across corners)";
}

function cableOuterSizeValue(solution: Solution, shapeKind: Design["spec"]["shape"]["kind"]): string {
  return shapeKind === "round" ? `Ø ${solution.envelopeDiameter.toFixed(1)} mm` : `${solution.envelopeDiameter.toFixed(1)} mm`;
}

function SolutionSummary({ solution, prefix, shapeKind }: { solution: Solution; prefix: string; shapeKind: Design["spec"]["shape"]["kind"] }) {
  return (
    <>
      <Row testId={`${prefix}outer-size`} label="Outer size" value={`${solution.outerSize.toFixed(1)} mm`} />
      {shapeKind !== "round" && <Row testId={`${prefix}corner-radius`} label="Corner radius" value={`${solution.cornerRadius.toFixed(1)} mm`} />}
      <Row testId={`${prefix}inner-bore`} label="Inner bore" value={`${solution.innerBore.toFixed(1)} mm`} />
      <Row testId={`${prefix}height`} label="Core height" value={`${solution.height.toFixed(1)} mm`} />
      {/* Issue #63: the assembled part's REAL overall height (flange bottom
          to cap top), matching the viewer's own "height" dimension line --
          "Core height" above is the wall's own WINDING height only (it
          excludes the bottom flange's thickness and any top cap), kept
          unchanged for anyone relying on that narrower number. */}
      <Row
        testId={`${prefix}overall-height`}
        label="Overall height"
        value={`${(solution.overallHeight ?? solution.height).toFixed(1)} mm`}
      />
      <Row testId={`${prefix}layers`} label="Layers" value={String(solution.layers)} />
      {/* Cable-length results, shown in centimetres for consistency with the
          cm-based length input (issue #51 AC) -- everything else in this
          summary stays in mm (it describes the printed core, not the wound
          cable). */}
      <Row testId={`${prefix}wound-length`} label="Wound length" value={`${mmToCm(solution.totalWoundLength).toFixed(1)} cm`} />
      <Row
        testId={`${prefix}capacity-vs-target`}
        label="Capacity vs. target"
        value={`${mmToCm(solution.totalWireLength).toFixed(1)} cm (${solution.lengthDeltaPct >= 0 ? "+" : ""}${solution.lengthDeltaPct.toFixed(0)}%)`}
      />
      <Row
        testId={`${prefix}capacity-range`}
        label="Capacity range"
        value={`${mmToCm(solution.capacityRange[0]).toFixed(0)} - ${mmToCm(solution.capacityRange[1]).toFixed(0)} cm`}
      />
      <Row
        testId={`${prefix}envelope`}
        label={cableOuterSizeLabel(shapeKind)}
        value={cableOuterSizeValue(solution, shapeKind)}
        hint={HINTS.envelope}
      />
      {/* Issue #63: the flange's REAL outer extent (matching the built
          flange mesh, not the solver's own envelope-based estimate) --
          round shows a single true diameter; square/triangle additionally
          show the wider "across corners" extent, since the two together
          are what actually has to clear a bed/enclosure. */}
      <Row testId={`${prefix}flange`} label="Flange width" value={flangeWidthValue(solution, shapeKind)} hint={HINTS.flange} />
      {shapeKind !== "round" && solution.flangeExtent && (
        <Row
          testId={`${prefix}flange-across-corners`}
          label="Flange width (across corners)"
          value={`${solution.flangeExtent.acrossCorners.toFixed(1)} mm`}
          hint={HINTS.flangeAcrossCorners}
        />
      )}
      <Row
        testId={`${prefix}caps`}
        label="Top cap"
        value={`${solution.topCapEnabled ? "on" : "off"} (auto would be ${solution.capsAuto ? "on" : "off"})`}
      />
      <table className="layer-table" data-testid={`${prefix}layer-table`}>
        <thead>
          <tr>
            <th>Layer</th>
            <th>Turns</th>
            <th>Perimeter</th>
            <th>Length</th>
          </tr>
        </thead>
        <tbody>
          {solution.layerResults.map((layer) => (
            <tr key={layer.layer}>
              <td>{layer.layer}</td>
              <td>{layer.turns}</td>
              <td>{layer.perimeter.toFixed(1)} mm</td>
              <td>{mmToCm(layer.length).toFixed(1)} cm</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

export function ResultPanel({
  design,
  finalReady,
  onDownloadStl,
  onDownloadThreeMf,
  onDownloadStep,
  stepBusy,
}: {
  design: Design;
  /** True once `design` is final-resolution and matches the current spec
   * (issue #7): downloads are disabled otherwise, so exports always use the
   * final resolution. */
  finalReady: boolean;
  onDownloadStl: () => void;
  onDownloadThreeMf: () => void;
  onDownloadStep: () => void;
  stepBusy: boolean;
}) {
  const { solution, warnings, parts, resolution } = design;
  const { diagnosis } = solution;
  const totalTriangles = parts.reduce((n, p) => n + p.mesh.indices.length / 3, 0);

  return (
    <>
      <Section title="Result">
        <p className={`diagnosis diagnosis-${diagnosis.status}`} data-testid="diagnosis-message">
          <strong data-testid="diagnosis-status">{diagnosis.status}</strong> ({diagnosis.freeCount} free:{" "}
          {diagnosis.freeVariables.map((v) => FREE_VARIABLE_LABELS[v]).join(", ") || "none"}) --{" "}
          {diagnosis.message}
        </p>
        <Row
          testId="mesh-detail"
          label="Mesh detail"
          value={`${resolution} (${totalTriangles.toLocaleString()} triangles) · ${parts.length} part${parts.length === 1 ? "" : "s"}`}
        />
        <Row testId="mount" label="Mount" value={MOUNT_LABELS[design.spec.mount]} />
        <SolutionSummary solution={solution} prefix="" shapeKind={design.spec.shape.kind} />
        {warnings.length > 0 && (
          <ul className="warnings" data-testid="warnings">
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        )}
        {solution.alternates.length > 0 && (
          <div className="alternate-candidate" data-testid="alternate-candidate">
            {solution.alternates.map((alt, i) => (
              <div key={i} className="alternate-candidate-item" data-testid={`alternate-candidate-${i}`}>
                <h3>
                  Alternate candidate {i + 1} (layers={alt.layers}
                  {alt.objectiveUsed ? `, ${alt.objectiveUsed}` : ""})
                </h3>
                <SolutionSummary solution={alt} prefix={`alt${i}-`} shapeKind={design.spec.shape.kind} />
              </div>
            ))}
          </div>
        )}
      </Section>
      <Section title="Export">
        {!finalReady && (
          <p className="settling" data-testid="resolution-settling">
            Rendering the full-resolution model for export…
          </p>
        )}
        <button type="button" className="btn-primary" data-testid="download-stl" onClick={onDownloadStl} disabled={!finalReady}>
          Download STL
        </button>
        <button type="button" className="btn-primary" data-testid="download-3mf" onClick={onDownloadThreeMf} disabled={!finalReady}>
          Download 3MF
        </button>
        <button type="button" className="btn-primary" data-testid="download-step" onClick={onDownloadStep} disabled={!finalReady || stepBusy}>
          {stepBusy ? "Preparing STEP…" : "Download STEP"}
        </button>
      </Section>
    </>
  );
}
