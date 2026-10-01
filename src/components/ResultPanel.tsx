import { useId, useState } from "react";
import { CAP_THICKNESS, toHash } from "../core";
import type { CoilSpec, Design, MountKind, ShapeKind, Solution } from "../core";
import { Section, mmToCm } from "./fields";
import { Hint } from "./Hint";
import { HINTS } from "./hints";

const MOUNT_LABELS: Record<MountKind, string> = {
  none: "None",
  keyhole: "Screw keyhole",
  through: "Through-holes",
  skadis: "SKÅDIS rim clips",
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
 * flange margin (see design.ts/flange.ts), on the design and (issue #192)
 * on its alternates; the solver's own (less accurate) envelope estimate is
 * only a fallback.
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

/** Cable lengths in the summary: whole centimetres, matching the cm cable-length control (issue #51). */
const cmWhole = (mm: number) => `${Math.round(mmToCm(mm))} cm`;
/** Part sizes in the summary: cm to one decimal, matching the viewer's dimension labels. */
const cm1 = (mm: number) => mmToCm(mm).toFixed(1);

/** The flange's real width: `flangeExtent` is set on the design and (issue #192) on every alternate. */
const widthOf = (s: Solution) => s.flangeExtent?.acrossFlats ?? s.flangeSize;
const tallOf = (s: Solution) => s.overallHeight ?? s.height;

/** "Ø 6.8 cm, 4.0 cm tall" -- the assembled coil's outer size, in the same words everywhere it's shown. */
function sizeText(s: Solution, shape: ShapeKind): string {
  return `${shape === "round" ? "Ø " : ""}${cm1(widthOf(s))} cm${shape === "round" ? "" : " wide"}, ${cm1(tallOf(s))} cm tall`;
}

const layersText = (n: number) => `${n} layer${n === 1 ? "" : "s"}`;

/** Within this ratio two sizes read as "about the same" on an option card. */
const SAME_SIZE = 0.08;

/** What an option changes compared with the design on screen, in a few plain words. */
function differenceText(option: Solution, current: Solution): string {
  const words: string[] = [];
  const tall = tallOf(option) / tallOf(current);
  const wide = widthOf(option) / widthOf(current);
  if (tall > 1 + SAME_SIZE) words.push("taller");
  else if (tall < 1 - SAME_SIZE) words.push("shorter");
  if (wide > 1 + SAME_SIZE) words.push("wider");
  else if (wide < 1 - SAME_SIZE) words.push("narrower");
  let text = words.length ? words.join(" and ") : "about the same size";
  if (option.topCapEnabled !== current.topCapEnabled) text += option.topCapEnabled ? ", adds a top cap" : ", no top cap";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Two free dimensions: the options are the two objectives' picks. Three free: one per layer count. */
function optionTitle(s: Solution, freeCount: number): string {
  if (freeCount >= 3) return layersText(s.layers);
  return s.objectiveUsed === "aspectRatio" ? "Even proportions" : "Smallest";
}

/**
 * The spec change that renders an option, using only existing spec (and
 * hash) fields. Two free dimensions: the other objective -- its pick comes
 * from the same candidate pool, so the two options just swap. Three free:
 * lock that candidate's layers AND height, which leaves only the core size
 * free; the solver then finds exactly the size it gave the candidate.
 */
function specFor(option: Solution, spec: CoilSpec, freeCount: number): CoilSpec {
  if (freeCount >= 3) return { ...spec, layers: { locked: true, value: option.layers }, height: { locked: true, value: option.height } };
  return { ...spec, objective: option.objectiveUsed ?? spec.objective };
}

/** Side-view line art of one option (flange, core wall, wound cable, cap), drawn to a scale every card shares. */
function OptionArt({ s, scale }: { s: Solution; scale: number }) {
  const size = 56;
  const bottom = size - 2;
  const capT = s.topCapEnabled ? CAP_THICKNESS * scale : 0;
  const flangeT = Math.max(1.5, (tallOf(s) - s.height) * scale - capT);
  const flangeW = widthOf(s) * scale;
  const coreW = s.outerSize * scale;
  const cableW = s.envelopeDiameter * scale;
  const flangeTop = bottom - flangeT;
  const wallTop = flangeTop - s.height * scale;
  const inset = Math.min(1.5, (s.height * scale) / 6);
  const left = (w: number) => (size - w) / 2;
  return (
    <svg className="option-art" viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden="true" focusable="false">
      <rect className="option-art-cable" x={left(cableW)} y={wallTop + inset} width={cableW} height={Math.max(0, flangeTop - wallTop - 2 * inset)} rx={1.5} />
      <line className="option-art-wall" x1={left(coreW)} x2={left(coreW)} y1={wallTop} y2={flangeTop} />
      <line className="option-art-wall" x1={left(coreW) + coreW} x2={left(coreW) + coreW} y1={wallTop} y2={flangeTop} />
      <rect className="option-art-part" x={left(flangeW)} y={flangeTop} width={flangeW} height={flangeT} />
      {s.topCapEnabled && <rect className="option-art-part" x={left(flangeW)} y={wallTop - capT} width={flangeW} height={capT} />}
    </svg>
  );
}

function Verdict({ design, problemCount }: { design: Design; problemCount: number }) {
  const { solution } = design;
  const target = solution.targetWireLength;
  const holds = solution.totalWireLength;
  // Issue #199: a design that holds the cable is "ok" however much room the
  // locks force on it, so only a shortfall changes the headline.
  const short = solution.diagnosis.status === "infeasible" || holds < target * (1 - 1e-6);
  const tone = short ? "bad" : problemCount > 0 ? "warn" : "good";
  let detail: string;
  if (short) detail = `This coil holds only ${cmWhole(holds)}. Unlock a size or shorten the cable.`;
  else if (solution.capacityRange[0] < target * (1 - 1e-6)) detail = `Wind it snugly: a loose winding holds only ${cmWhole(solution.capacityRange[0])}.`;
  else if (solution.lengthDeltaPct > 10) detail = `Room for ${cmWhole(holds)}, ${Math.round(solution.lengthDeltaPct)}% more than you need.`;
  else detail = `Room for ${cmWhole(holds)}.`;
  if (!short) detail += problemCount > 0 ? ` Check ${problemCount === 1 ? "one thing" : `${problemCount} things`} below before printing.` : " Ready to print.";
  return (
    <div className={`verdict verdict-${tone}`} data-testid="verdict" data-tone={tone}>
      <span className="verdict-icon" aria-hidden="true">
        {tone === "good" ? "✓" : "!"}
      </span>
      <div>
        <p className="verdict-title" data-testid="verdict-title">
          {short ? `Your ${cmWhole(target)} cable won't fit` : `Holds your ${cmWhole(target)} cable`}
        </p>
        <p className="verdict-detail">{detail}</p>
      </div>
    </div>
  );
}

/** One card per option, a radio group: picking a card renders it (issue #192). */
function Options({ design, spec, onChange }: { design: Design; spec: CoilSpec; onChange: (next: CoilSpec) => void }) {
  const { solution } = design;
  const shape = design.spec.shape.kind;
  const freeCount = solution.diagnosis.freeCount;
  const groupName = useId();
  const introId = useId();
  // Three free: picking locks height and layers, so the cards go away and a
  // link leads back to them. Session-only (plain React state): a reload
  // shows the picked design, which is what the link stores.
  const [back, setBack] = useState<{ spec: CoilSpec; to: string; title: string } | null>(null);
  const hash = toHash(spec, true, "design");
  const canGoBack = back !== null && back.to === hash;

  if (solution.alternates.length === 0) {
    if (!canGoBack) return null;
    return (
      <Section title="Options">
        <p className="options-intro">Showing the {back.title} option. Its height and layers are locked.</p>
        <button
          type="button"
          className="option-back"
          data-testid="option-back"
          onClick={() => {
            onChange(back.spec);
            setBack(null);
          }}
        >
          ← Back to all options
        </button>
      </Section>
    );
  }

  // A fixed order, so the picked card never jumps: by layers (three free), Smallest first (two free).
  const rank = (o: Solution) => (freeCount >= 3 ? o.layers : o.objectiveUsed === "aspectRatio" ? 1 : 0);
  const options = [solution, ...solution.alternates].sort((a, b) => rank(a) - rank(b));
  const scale = 52 / Math.max(...options.map((o) => Math.max(widthOf(o), tallOf(o))));
  // The picked card shows as checked straight away, before its design has
  // been solved: once the spec runs ahead of the design on screen, the
  // checked card is the one whose spec it now is.
  const specChanged = hash !== toHash(design.spec, true, "design");
  const isChecked = (option: Solution) => (specChanged ? toHash(specFor(option, design.spec, freeCount), true, "design") === hash : option === solution);
  const pick = (option: Solution) => {
    if (isChecked(option)) return;
    const next = specFor(option, spec, freeCount);
    if (freeCount >= 3) setBack({ spec, to: toHash(next, true, "design"), title: optionTitle(option, freeCount) });
    onChange(next);
  };

  return (
    <Section title="Options">
      <div className="field-label-row options-intro-row">
        <p className="options-intro" id={introId}>
          {freeCount >= 3 ? "This cable can be wound in different ways. Pick one to see it." : "Two shapes hold the same cable. Pick one to see it."}
        </p>
        <Hint text={HINTS.options} />
      </div>
      <div className="options" role="radiogroup" aria-labelledby={introId} data-testid="options">
        {options.map((option, i) => {
          const active = option === solution;
          const checked = isChecked(option);
          const title = optionTitle(option, freeCount);
          return (
            <label key={title} className={`option${checked ? " option-active" : ""}`} data-testid={`option-${i}`} data-active={active}>
              <input
                type="radio"
                name={groupName}
                className="option-input"
                data-testid={`option-input-${i}`}
                aria-label={title}
                aria-describedby={`${groupName}-${i}`}
                checked={checked}
                onChange={() => pick(option)}
              />
              <OptionArt s={option} scale={scale} />
              <span className="option-text" id={`${groupName}-${i}`}>
                <span className="option-title">
                  <span data-testid={`option-title-${i}`}>{title}</span>
                  {active && <span className="option-tag">showing</span>}
                  {!active && freeCount >= 3 && option === solution && <span className="option-tag">suggested</span>}
                </span>
                {!active && <span className="option-diff">{differenceText(option, solution)}</span>}
                <span className="option-detail">
                  {freeCount < 3 && `${layersText(option.layers)} · `}
                  <span data-testid={`option-size-${i}`}>{sizeText(option, shape)}</span>
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </Section>
  );
}

export function ResultPanel({
  design,
  spec,
  onChange,
  finalReady,
  onDownloadStl,
  onDownloadThreeMf,
  onDownloadStep,
  stepBusy,
}: {
  design: Design;
  /** The current spec (may be ahead of `design` while it re-solves): picking an option changes this. */
  spec: CoilSpec;
  onChange: (next: CoilSpec) => void;
  /** True once `design` is final-resolution and matches the current spec
   * (issue #7): downloads are disabled otherwise, so exports always use the
   * final resolution. */
  finalReady: boolean;
  onDownloadStl: () => void;
  onDownloadThreeMf: () => void;
  onDownloadStep: () => void;
  stepBusy: boolean;
}) {
  const { solution, notices, parts, resolution } = design;
  const { diagnosis } = solution;
  const totalTriangles = parts.reduce((n, p) => n + p.mesh.indices.length / 3, 0);
  const problems = notices.filter((n) => n.severity === "problem");
  const partNames = parts.map((p) => p.name.replace(/-\d+$/, "").replace(/-/g, " "));

  return (
    <>
      {/* Issue #192: only what matters before printing -- does the cable
          fit, does the coil fit the bed, what gets printed, and anything
          that needs attention. Everything else is under "All numbers". */}
      <Section title="Result">
        <Verdict design={design} problemCount={problems.length} />
        <dl className="facts">
          <div className="fact">
            <dt>Size</dt>
            <dd>
              <span data-testid="fact-size">{sizeText(solution, design.spec.shape.kind)}</span>
              <span className={`fit-chip${design.fitsBed ? "" : " fit-chip-bad"}`} data-testid="bed-fit">
                {design.fitsBed ? "fits your bed" : "too big for your bed"}
              </span>
            </dd>
          </div>
          <div className="fact">
            <dt>To print</dt>
            <dd>
              <span data-testid="fact-parts">
                {parts.length} part{parts.length === 1 ? "" : "s"}
              </span>
              <span className="fact-note">{[...new Set(partNames)].join(", ")}</span>
            </dd>
          </div>
        </dl>
        {problems.length > 0 && (
          <ul className="problems" data-testid="problems">
            {problems.map((n) => (
              <li key={n.message}>{n.message}</li>
            ))}
          </ul>
        )}
      </Section>
      <Options design={design} spec={spec} onChange={onChange} />
      {/* Always collapsed on load, like "Advanced settings": plain DOM state, never in the hash. */}
      <details className="disclosure all-numbers" data-testid="all-numbers">
        <summary className="advanced-summary">All numbers</summary>
        <div className="advanced-body all-numbers-body">
          <Row
            testId="mesh-detail"
            label="Mesh detail"
            value={`${resolution} (${totalTriangles.toLocaleString()} triangles) · ${parts.length} part${parts.length === 1 ? "" : "s"}`}
          />
          <Row testId="mount" label="Mount" value={MOUNT_LABELS[design.spec.mount]} />
          <SolutionSummary solution={solution} prefix="" shapeKind={design.spec.shape.kind} />
          {notices.length > 0 && (
            <>
              <h3 className="all-numbers-heading">Messages</h3>
              <ul className="warnings" data-testid="warnings">
                {notices.map((n) => (
                  <li key={n.message} data-severity={n.severity}>
                    {n.message}
                  </li>
                ))}
              </ul>
            </>
          )}
          <h3 className="all-numbers-heading">Solver</h3>
          <p className={`diagnosis diagnosis-${diagnosis.status}`} data-testid="diagnosis-message">
            <strong data-testid="diagnosis-status">{diagnosis.status}</strong> ({diagnosis.freeCount} free:{" "}
            {diagnosis.freeVariables.map((v) => FREE_VARIABLE_LABELS[v]).join(", ") || "none"}) --{" "}
            {diagnosis.message}
          </p>
        </div>
      </details>
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
