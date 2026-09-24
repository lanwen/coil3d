import type { Design, Solution } from "../core";

const FREE_VARIABLE_LABELS: Record<"coreSize" | "height" | "layers", string> = {
  coreSize: "core size",
  height: "height",
  layers: "layers",
};

function Row({ testId, label, value }: { testId: string; label: string; value: string }) {
  return (
    <div className="result-row">
      <span className="result-label">{label}</span>
      <span className="result-value" data-testid={testId}>
        {value}
      </span>
    </div>
  );
}

function SolutionSummary({ solution, prefix }: { solution: Solution; prefix: string }) {
  return (
    <>
      <Row testId={`${prefix}outer-size`} label="Outer size" value={`${solution.outerSize.toFixed(1)} mm`} />
      <Row testId={`${prefix}inner-bore`} label="Inner bore" value={`${solution.innerBore.toFixed(1)} mm`} />
      <Row testId={`${prefix}height`} label="Core height" value={`${solution.height.toFixed(1)} mm`} />
      <Row testId={`${prefix}layers`} label="Layers" value={String(solution.layers)} />
      <Row testId={`${prefix}wound-length`} label="Wound length" value={`${solution.totalWoundLength.toFixed(1)} mm`} />
      <Row
        testId={`${prefix}capacity-vs-target`}
        label="Capacity vs. target"
        value={`${solution.totalWireLength.toFixed(1)} mm (${solution.lengthDeltaPct >= 0 ? "+" : ""}${solution.lengthDeltaPct.toFixed(1)}%)`}
      />
      <Row testId={`${prefix}capacity-range`} label="Capacity range" value={`${solution.capacityRange[0].toFixed(0)} - ${solution.capacityRange[1].toFixed(0)} mm`} />
      <Row testId={`${prefix}envelope`} label="Envelope" value={`${solution.envelopeDiameter.toFixed(1)} mm`} />
      <Row testId={`${prefix}flange`} label="Flange size" value={`${solution.flangeSize.toFixed(1)} mm`} />
      <Row testId={`${prefix}caps`} label="Top cap" value={solution.capsAuto ? "on (auto, > 1 layer)" : "off"} />
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
              <td>{layer.length.toFixed(1)} mm</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

export function ResultPanel({
  design,
  onDownloadStl,
  onDownloadStep,
  stepBusy,
}: {
  design: Design;
  onDownloadStl: () => void;
  onDownloadStep: () => void;
  stepBusy: boolean;
}) {
  const { solution, warnings } = design;
  const { diagnosis } = solution;

  return (
    <section className="result-panel">
      <h2>Result</h2>
      <p className={`diagnosis diagnosis-${diagnosis.status}`} data-testid="diagnosis-message">
        <strong data-testid="diagnosis-status">{diagnosis.status}</strong> ({diagnosis.freeCount} free:{" "}
        {diagnosis.freeVariables.map((v) => FREE_VARIABLE_LABELS[v]).join(", ") || "none"}) --{" "}
        {diagnosis.message}
      </p>
      <SolutionSummary solution={solution} prefix="" />
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
              <SolutionSummary solution={alt} prefix={`alt${i}-`} />
            </div>
          ))}
        </div>
      )}
      <button type="button" data-testid="download-stl" onClick={onDownloadStl}>
        Download STL
      </button>
      <button type="button" data-testid="download-step" onClick={onDownloadStep} disabled={stepBusy}>
        {stepBusy ? "Preparing STEP…" : "Download STEP"}
      </button>
    </section>
  );
}
