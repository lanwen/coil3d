import type { ChangeEvent } from "react";
import type { CoilSpec } from "../core";

interface Field {
  key: keyof CoilSpec;
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
}

const FIELDS: Field[] = [
  { key: "wireLength", label: "Cable length", unit: "mm", min: 1, max: 15000, step: 10 },
  { key: "wireDiameter", label: "Cable diameter", unit: "mm", min: 0.5, max: 20, step: 0.1 },
  { key: "coreSize", label: "Core outer size", unit: "mm", min: 5, max: 500, step: 1 },
];

export function ControlsForm({
  spec,
  onChange,
}: {
  spec: CoilSpec;
  onChange: (next: CoilSpec) => void;
}) {
  const handleChange = (key: keyof CoilSpec) => (event: ChangeEvent<HTMLInputElement>) => {
    const value = Number(event.target.value);
    if (!Number.isFinite(value)) return;
    onChange({ ...spec, [key]: value });
  };

  return (
    <form className="controls" onSubmit={(e) => e.preventDefault()}>
      {FIELDS.map((field) => (
        <label key={field.key} className="controls-field">
          <span>
            {field.label} ({field.unit})
          </span>
          <input
            type="number"
            data-testid={`input-${field.key}`}
            value={spec[field.key]}
            min={field.min}
            max={field.max}
            step={field.step}
            onChange={handleChange(field.key)}
          />
        </label>
      ))}
    </form>
  );
}
