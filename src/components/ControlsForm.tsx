import { useEffect, useRef } from "react";
import type { CoilSpec, CoreSizeLock, JointKind, Lock, Objective, ShapeKind, Solution, TopCapMode, WireTypeId } from "../core";
import { DEFAULT_CORNER_RADIUS, DEFAULT_CUSTOM_BEND_MULTIPLIER, TOLERANCE_MAX, TOLERANCE_MIN, WIRE_TYPE_PRESETS } from "../core";
import { LockRangeField, LockStepperField, RangeField, Section } from "./fields";

const TOP_CAP_OPTIONS: Array<{ id: TopCapMode; label: string }> = [
  { id: "auto", label: "Auto (on when layers > 1)" },
  { id: "on", label: "On" },
  { id: "off", label: "Off" },
];

const JOINT_OPTIONS: Array<{ id: JointKind; label: string }> = [
  { id: "press", label: "Press-fit" },
  { id: "bayonet", label: "Bayonet / twist-lock" },
  { id: "snap", label: "Snap clips" },
];

const WIRE_TYPE_OPTIONS: Array<{ id: WireTypeId; label: string }> = [
  { id: "usb", label: WIRE_TYPE_PRESETS.usb.label },
  { id: "flex", label: WIRE_TYPE_PRESETS.flex.label },
  { id: "stiff", label: WIRE_TYPE_PRESETS.stiff.label },
  { id: "custom", label: "Custom" },
];

const SHAPE_OPTIONS: Array<{ id: ShapeKind; label: string }> = [
  { id: "round", label: "Round" },
  { id: "sq", label: "Rounded square" },
  { id: "tri", label: "Rounded triangle" },
];

export function ControlsForm({
  spec,
  solution,
  onChange,
}: {
  spec: CoilSpec;
  /** The current design's solved numbers, so free fields can show them instead of a placeholder. Undefined before the first design() resolves. */
  solution?: Solution;
  onChange: (next: CoilSpec) => void;
}) {
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

  const setShapeKind = (kind: ShapeKind) => {
    onChange({ ...spec, shape: kind === "round" ? { kind } : { kind, cornerRadius: DEFAULT_CORNER_RADIUS } });
  };
  const setShapeCornerRadius = (cornerRadius: number) => {
    if (spec.shape.kind === "round") return;
    onChange({ ...spec, shape: { kind: spec.shape.kind, cornerRadius } });
  };

  const freeCount = [spec.coreSize.locked, spec.height.locked, spec.layers.locked].filter((locked) => !locked).length;
  const showObjective = freeCount >= 2;

  // "Advanced settings" (winding quality, custom bend multiplier, objective)
  // stay collapsed behind a disclosure (issue #16 AC) so the form isn't a
  // wall of fields -- except the objective picker forces the disclosure open
  // the moment it becomes relevant (2+ free dimensions), so the choice
  // driving which candidate is shown is never hidden from the user.
  const advancedRef = useRef<HTMLDetailsElement | null>(null);
  useEffect(() => {
    if (showObjective && advancedRef.current) advancedRef.current.open = true;
  }, [showObjective]);

  return (
    <form className="controls" onSubmit={(e) => e.preventDefault()}>
      <Section title="Cable">
        <RangeField testId="wireLength" label="Cable length" unit="mm" min={1} max={15000} step={10} value={spec.wire.length} onChange={(v) => setWire({ length: v })} />
        <RangeField testId="wireDiameter" label="Cable diameter" unit="mm" min={0.5} max={20} step={0.1} value={spec.wire.diameter} onChange={(v) => setWire({ diameter: v })} />

        <label className="field">
          <span className="field-label">Cable type</span>
          <select
            className="field-select"
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
      </Section>

      <Section title="Shape">
        <label className="field">
          <span className="field-label">Core shape</span>
          <select className="field-select" data-testid="select-shape" value={spec.shape.kind} onChange={(e) => setShapeKind(e.target.value as ShapeKind)}>
            {SHAPE_OPTIONS.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        {spec.shape.kind !== "round" && (
          <RangeField
            testId="shapeCornerRadius"
            label="Corner radius"
            unit="mm"
            min={0}
            max={250}
            step={0.5}
            value={spec.shape.cornerRadius}
            onChange={setShapeCornerRadius}
          />
        )}
      </Section>

      <Section title="Core">
        <label className="field">
          <span className="field-label">Locked dimension</span>
          <select
            className="field-select"
            data-testid="select-coreSizeDimension"
            value={spec.coreSize.locked ? spec.coreSize.dimension : "outer"}
            disabled={!spec.coreSize.locked}
            onChange={(e) => setCoreSizeDimension(e.target.value as "outer" | "inner")}
          >
            <option value="outer">Outer (winding surface)</option>
            <option value="inner">Inner (bore)</option>
          </select>
        </label>
        <LockRangeField
          testId="outer"
          label="Core size"
          unit="mm"
          lock={spec.coreSize}
          min={5}
          max={500}
          step={1}
          freeValue={solution?.outerSize ?? 30}
          onChange={setCoreSizeLock}
        />
        <LockRangeField
          testId="height"
          label="Height"
          unit="mm"
          lock={spec.height}
          min={1}
          max={400}
          step={1}
          freeValue={solution?.height ?? 40}
          onChange={(lock) => onChange({ ...spec, height: lock })}
        />
        <LockStepperField
          testId="layers"
          label="Layers"
          lock={spec.layers}
          min={1}
          max={40}
          freeValue={solution?.layers ?? 1}
          onChange={(lock) => onChange({ ...spec, layers: lock })}
        />
      </Section>

      <details className="advanced" ref={advancedRef}>
        <summary className="advanced-summary">Advanced settings</summary>
        <div className="advanced-body">
          <RangeField
            testId="windingQuality"
            label="Winding quality (stacked ↔ orthocyclic)"
            unit=""
            min={0}
            max={1}
            step={0.05}
            value={spec.windingQuality}
            onChange={(v) => onChange({ ...spec, windingQuality: v })}
          />
          {spec.wire.type === "custom" && (
            <RangeField
              testId="customMultiplier"
              label="Custom bend multiplier"
              unit="x diameter"
              min={0.5}
              max={50}
              step={0.5}
              value={spec.wire.customBendMultiplier ?? DEFAULT_CUSTOM_BEND_MULTIPLIER}
              onChange={(v) => setWire({ customBendMultiplier: v })}
            />
          )}
          {showObjective && (
            <label className="field">
              <span className="field-label">Objective ({freeCount} free dimensions)</span>
              <select className="field-select" data-testid="select-objective" value={spec.objective} onChange={(e) => onChange({ ...spec, objective: e.target.value as Objective })}>
                <option value="minVolume">Minimum volume</option>
                <option value="aspectRatio">Cube-like proportions</option>
              </select>
            </label>
          )}
        </div>
      </details>

      <Section title="Top cap & joint">
        <label className="field">
          <span className="field-label">Top cap</span>
          <select className="field-select" data-testid="select-topCap" value={spec.topCap} onChange={(e) => onChange({ ...spec, topCap: e.target.value as TopCapMode })}>
            {TOP_CAP_OPTIONS.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Joint</span>
          <select className="field-select" data-testid="select-joint" value={spec.joint} onChange={(e) => onChange({ ...spec, joint: e.target.value as JointKind })}>
            {JOINT_OPTIONS.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <RangeField
          testId="tolerance"
          label="Joint tolerance"
          unit="mm"
          min={TOLERANCE_MIN}
          max={TOLERANCE_MAX}
          step={0.05}
          value={spec.tolerance}
          onChange={(v) => onChange({ ...spec, tolerance: v })}
        />
      </Section>
    </form>
  );
}
