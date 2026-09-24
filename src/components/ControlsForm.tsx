import type { ChangeEvent } from "react";
import type { CoilSpec, CoreSizeLock, Lock, Objective, WireTypeId } from "../core";
import { DEFAULT_CUSTOM_BEND_MULTIPLIER, WIRE_TYPE_PRESETS } from "../core";

const WIRE_TYPE_OPTIONS: Array<{ id: WireTypeId; label: string }> = [
  { id: "usb", label: WIRE_TYPE_PRESETS.usb.label },
  { id: "flex", label: WIRE_TYPE_PRESETS.flex.label },
  { id: "stiff", label: WIRE_TYPE_PRESETS.stiff.label },
  { id: "custom", label: "Custom" },
];

function NumberField({
  testId,
  label,
  unit,
  value,
  min,
  max,
  step,
  disabled,
  onChange,
}: {
  testId: string;
  label: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const next = Number(event.target.value);
    if (!Number.isFinite(next)) return;
    onChange(next);
  };
  return (
    <label className="controls-field">
      <span>
        {label} ({unit})
      </span>
      <input type="number" data-testid={testId} value={value} min={min} max={max} step={step} disabled={disabled} onChange={handleChange} />
    </label>
  );
}

/** A "lock this dimension" checkbox paired with its value input, disabled while free. */
function LockField({
  testId,
  label,
  unit,
  lock,
  min,
  max,
  step,
  defaultValue,
  onChange,
}: {
  testId: string;
  label: string;
  unit: string;
  lock: Lock<number>;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  onChange: (lock: Lock<number>) => void;
}) {
  const toggle = (event: ChangeEvent<HTMLInputElement>) => {
    onChange(event.target.checked ? { locked: true, value: lock.locked ? lock.value : defaultValue } : { locked: false });
  };
  const setValue = (value: number) => {
    if (lock.locked) onChange({ locked: true, value });
  };
  return (
    <div className="controls-lock">
      <label className="controls-lock-toggle">
        <input type="checkbox" data-testid={`lock-${testId}`} checked={lock.locked} onChange={toggle} />
        <span>Lock {label}</span>
      </label>
      <NumberField
        testId={`input-${testId}`}
        label={label}
        unit={unit}
        value={lock.locked ? lock.value : defaultValue}
        min={min}
        max={max}
        step={step}
        disabled={!lock.locked}
        onChange={setValue}
      />
    </div>
  );
}

export function ControlsForm({ spec, onChange }: { spec: CoilSpec; onChange: (next: CoilSpec) => void }) {
  const setWire = (patch: Partial<CoilSpec["wire"]>) => onChange({ ...spec, wire: { ...spec.wire, ...patch } });

  const setCoreSizeLock = (lock: Lock<number>) => {
    const coreSize: CoreSizeLock = lock.locked
      ? { locked: true, dimension: spec.coreSize.locked ? spec.coreSize.dimension : "outer", value: lock.value }
      : { locked: false };
    onChange({ ...spec, coreSize });
  };
  const setCoreSizeDimension = (dimension: "outer" | "inner") => {
    if (!spec.coreSize.locked) return;
    onChange({ ...spec, coreSize: { locked: true, dimension, value: spec.coreSize.value } });
  };

  const freeCount = [spec.coreSize.locked, spec.height.locked, spec.layers.locked].filter((locked) => !locked).length;

  return (
    <form className="controls" onSubmit={(e) => e.preventDefault()}>
      <NumberField testId="input-wireLength" label="Cable length" unit="mm" min={1} max={15000} step={10} value={spec.wire.length} onChange={(v) => setWire({ length: v })} />
      <NumberField testId="input-wireDiameter" label="Cable diameter" unit="mm" min={0.5} max={20} step={0.1} value={spec.wire.diameter} onChange={(v) => setWire({ diameter: v })} />

      <label className="controls-field">
        <span>Cable type</span>
        <select
          data-testid="select-wireType"
          value={spec.wire.type}
          onChange={(e) => setWire({ type: e.target.value as WireTypeId })}
        >
          {WIRE_TYPE_OPTIONS.map((opt) => (
            <option key={opt.id} value={opt.id}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>
      {spec.wire.type === "custom" && (
        <NumberField
          testId="input-customMultiplier"
          label="Custom bend multiplier"
          unit="x diameter"
          min={0.5}
          max={50}
          step={0.5}
          value={spec.wire.customBendMultiplier ?? DEFAULT_CUSTOM_BEND_MULTIPLIER}
          onChange={(v) => setWire({ customBendMultiplier: v })}
        />
      )}

      <label className="controls-field">
        <span>Winding quality (stacked ↔ orthocyclic): {spec.windingQuality.toFixed(2)}</span>
        <input
          type="range"
          data-testid="input-windingQuality"
          min={0}
          max={1}
          step={0.05}
          value={spec.windingQuality}
          onChange={(e) => onChange({ ...spec, windingQuality: Number(e.target.value) })}
        />
      </label>

      <fieldset className="controls-core-size">
        <legend>Core size</legend>
        <label className="controls-field">
          <span>Locked dimension</span>
          <select
            data-testid="select-coreSizeDimension"
            value={spec.coreSize.locked ? spec.coreSize.dimension : "outer"}
            disabled={!spec.coreSize.locked}
            onChange={(e) => setCoreSizeDimension(e.target.value as "outer" | "inner")}
          >
            <option value="outer">Outer (winding surface)</option>
            <option value="inner">Inner (bore)</option>
          </select>
        </label>
        <LockField testId="outer" label="core size" unit="mm" lock={spec.coreSize} min={5} max={500} step={1} defaultValue={30} onChange={setCoreSizeLock} />
      </fieldset>

      <LockField testId="height" label="height" unit="mm" lock={spec.height} min={1} max={400} step={1} defaultValue={40} onChange={(lock) => onChange({ ...spec, height: lock })} />
      <LockField testId="layers" label="layers" unit="" lock={spec.layers} min={1} max={40} step={1} defaultValue={1} onChange={(lock) => onChange({ ...spec, layers: lock })} />

      {freeCount === 2 && (
        <label className="controls-field">
          <span>Objective (two free dimensions)</span>
          <select data-testid="select-objective" value={spec.objective} onChange={(e) => onChange({ ...spec, objective: e.target.value as Objective })}>
            <option value="minVolume">Minimum volume</option>
            <option value="aspectRatio">Cube-like proportions</option>
          </select>
        </label>
      )}
    </form>
  );
}
