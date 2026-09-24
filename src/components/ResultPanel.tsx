import type { Design } from "../core";

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

export function ResultPanel({ design, onDownloadStl }: { design: Design; onDownloadStl: () => void }) {
  return (
    <section className="result-panel">
      <h2>Result</h2>
      <Row testId="turns" label="Turns" value={String(design.turns)} />
      <Row testId="wound-length" label="Wound length" value={`${design.woundLength.toFixed(1)} mm`} />
      <Row testId="leftover-tail" label="Leftover tail" value={`${design.leftoverTail.toFixed(1)} mm`} />
      <Row testId="height" label="Core height" value={`${design.height.toFixed(1)} mm`} />
      {design.warnings.length > 0 && (
        <ul className="warnings" data-testid="warnings">
          {design.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
      <button type="button" data-testid="download-stl" onClick={onDownloadStl}>
        Download STL
      </button>
    </section>
  );
}
