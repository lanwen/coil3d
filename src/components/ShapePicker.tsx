import { useId } from "react";
import { SHAPES } from "../core";
import type { ShapeKind, ShapePlugin } from "../core";
import { FieldTop } from "./fields";

/**
 * Pictogram radio buttons for the core's cross-section (issue #52),
 * replacing the plain `<select>` dropdown: a row of black/white icons, the
 * selected one inverted, one real `<input type="radio">` per shape so
 * keyboard (arrow keys move the native radiogroup selection, exactly like a
 * `<select>` did) and screen readers (each radio's own accessible name is
 * its shape's label) both keep working for free.
 *
 * Generated from the shape registry (`SHAPES`, `core/shapes.ts`) rather than
 * a hand-written list: a new shape plugin gets a button here the moment it's
 * added to that registry, with no change to this component. Only the icon
 * itself is per-kind (see `SHAPE_ICONS` below); an unrecognised future kind
 * still gets a button (labelled from the registry) and a generic fallback
 * icon shaped by its own corner count, so nothing is silently dropped.
 */
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

/** Hand-drawn icons for the shapes this project ships today -- plain,
 * schematic outlines (same spirit as `guide/pictograms.tsx`'s icons), not
 * exact renders of the solved core geometry. */
const SHAPE_ICONS: Partial<Record<ShapeKind, React.ReactNode>> = {
  round: <circle cx="32" cy="32" r="22" {...STROKE} />,
  sq: <rect x="10" y="10" width="44" height="44" rx="12" {...STROKE} />,
  tri: <path d="M32 8 L56 50 Q58 54 53 54 H11 Q6 54 8 50 Z" {...STROKE} />,
};

/** A generic rounded regular n-gon, for any future shape plugin this project
 * hasn't drawn a bespoke icon for yet -- so a new registry entry always gets
 * a recognisable button, never a blank one. */
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
