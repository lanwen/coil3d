import { useId } from "react";
import { SHAPES } from "../core";
import type { ShapeKind, ShapePlugin } from "../core";
import { FieldTop } from "./fields";

export function ShapePicker({
  testId,
  label,
  hint,
  value,
  onChange,
}: {
  testId: string;
  label: string;
  hint?: string;
  value: ShapeKind;
  onChange: (kind: ShapeKind) => void;
}) {
  const labelId = useId();
  return (
    <div className="field">
      <FieldTop label={label} hint={hint} labelId={labelId} />
      <div className="shape-picker" role="radiogroup" aria-labelledby={labelId} data-testid={`shape-picker-${testId}`}>
        {Object.values(SHAPES).map((plugin) => (
          <label key={plugin.kind} className="shape-option" title={plugin.label}>
            <input
              type="radio"
              name={`${testId}-shape`}
              className="shape-option-input"
              data-testid={`shape-option-${plugin.kind}`}
              aria-label={plugin.label}
              checked={plugin.kind === value}
              onChange={() => onChange(plugin.kind)}
            />
            <span className="shape-option-icon" aria-hidden="true">
              {shapeIcon(plugin)}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

const STROKE = { fill: "none", stroke: "currentColor", strokeWidth: 3.5, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

const SHAPE_ICONS: Partial<Record<ShapeKind, React.ReactNode>> = {
  round: <circle cx="32" cy="32" r="22" {...STROKE} />,
  sq: <rect x="10" y="10" width="44" height="44" rx="12" {...STROKE} />,
  tri: <path d="M32 8 L56 50 Q58 54 53 54 H11 Q6 54 8 50 Z" {...STROKE} />,
};

function genericPolygon(corners: number): React.ReactNode {
  const cx = 32;
  const cy = 32;
  const r = 22;
  const points = Array.from({ length: corners }, (_, i) => {
    const theta = (2 * Math.PI * i) / corners - Math.PI / 2;
    return `${cx + r * Math.cos(theta)},${cy + r * Math.sin(theta)}`;
  }).join(" ");
  return <polygon points={points} {...STROKE} />;
}

function shapeIcon(plugin: ShapePlugin): React.ReactNode {
  return (
    <svg viewBox="0 0 64 64" width="28" height="28" role="img" aria-hidden="true">
      {SHAPE_ICONS[plugin.kind] ?? genericPolygon(plugin.corners)}
    </svg>
  );
}
