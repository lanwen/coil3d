import { useEffect, useId, useRef } from "react";
import type { CoilSpec, CoreSizeLock, JointKind, KeyholeRotation, Lock, MountKind, Objective, PlateJoint, ShapeKind, Solution, TopCapMode, WireTypeId } from "../core";
import {
  BED_SIZE_MAX,
  BED_SIZE_MIN,
  DEFAULT_CORNER_RADIUS,
  DEFAULT_CUSTOM_BEND_MULTIPLIER,
  DEFAULT_THROUGH_HOLE_DIAMETER,
  KEYHOLE_ROTATION_OPTIONS,
  LABEL_MAX_LENGTH,
  SHAPES,
  THROUGH_HOLE_DIAMETER_MAX,
  THROUGH_HOLE_DIAMETER_MIN,
  TOLERANCE_MAX,
  TOLERANCE_MIN,
  WIRE_TYPE_PRESETS,
} from "../core";
import { FieldTop, LockRangeField, LockStepperField, RangeField, Section, TextField, cmToMm, mmToCm, roundMm } from "./fields";
import { HINTS } from "./hints";
import { ShapePicker } from "./ShapePicker";

/** Slider bounds in cm (issue #51 AC: "20-1500 cm"); converted to the mm `CoilSpec` stores. */
const WIRE_LENGTH_MIN_CM = 20;
const WIRE_LENGTH_MAX_CM = 1500;

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

// openGrid (issue #14 PR review): the grid pitch is verified, but its real
// snap/connector geometry isn't published anywhere as plain dimensions (see
// constants.ts's OPENGRID_PLACEHOLDER_PEG_SIZE comment) -- shipping a
// placeholder peg under a real "openGrid" option would mislead users into
// printing a plate that doesn't actually fit an openGrid board. Hidden from
// this list (and rejected from the hash, see hash.ts) until the real
// connector geometry lands -- tracked in issue #38. The underlying
// `mount: "opengrid"` capability stays implemented and tested (mountPlate.ts,
// manifold.ts, step/build.ts) so that follow-up is just swapping the
// connector solid, not building the feature from scratch.
const MOUNT_OPTIONS: Array<{ id: MountKind; label: string }> = [
  { id: "none", label: "None" },
  { id: "keyhole", label: "Screw keyhole (wall mount)" },
  { id: "through", label: "Through-holes (screw straight on)" },
  { id: "skadis", label: "IKEA SKÅDIS clip plate" },
];

const PLATE_JOINT_OPTIONS: Array<{ id: PlateJoint; label: string }> = [
  { id: "glue", label: "Glue (alignment pegs)" },
  { id: "snap", label: "Snap tabs" },
];

const KEYHOLE_ROTATION_LABELS: Record<KeyholeRotation, string> = {
  0: "0°",
  45: "45°",
};

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
  const setPrint = (patch: Partial<CoilSpec["print"]>) => onChange({ ...spec, print: { ...spec.print, ...patch } });

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

  // Ids for the plain `<select>` fields below, so each one's `FieldTop`
  // label is a real `<label for>` (issue #53's (i) button sits next to that
  // label, as a sibling -- never nested inside a wrapping `<label>`).
  const wireTypeId = useId();
  const coreSizeDimensionId = useId();
  const mountId = useId();
  const plateJointId = useId();
  const keyholeRotationId = useId();
  const objectiveId = useId();
  const topCapId = useId();
  const jointId = useId();

  const freeCount = [spec.coreSize.locked, spec.height.locked, spec.layers.locked].filter((locked) => !locked).length;
  const showObjective = freeCount >= 2;

  // Issue #54/#58: for a square or triangle core, this cable's bend limit
  // can force a bigger minimum core size than a round core needs (a bigger
  // corner radius, at a fixed size, erodes the straight sides). The size
  // slider's own minimum follows that (never lets the user drag below a
  // size the solver would just raise anyway); `solution` is undefined only
  // before the very first solve, when 5mm is as good a placeholder as any.
  const outerSizeMin = spec.shape.kind === "round" ? 5 : Math.max(5, solution?.minOuterSizeForShape ?? 5);
  // The solver silently raises a LOCKED size below that floor (with its own
  // warning in the Result panel) -- the input itself still shows the raw
  // value the user typed (never swapped out from under them mid-edit, which
  // would fight typing), but this note next to it says plainly that the
  // built core is actually bigger, and why.
  const coreSizeRaised =
    spec.shape.kind !== "round" && spec.coreSize.locked && solution && solution.outerSize > spec.coreSize.value + 0.05
      ? { requested: spec.coreSize.value, built: solution.outerSize }
      : undefined;

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
        <RangeField
          testId="wireLength"
          label="Cable length"
          unit="cm"
          min={WIRE_LENGTH_MIN_CM}
          max={WIRE_LENGTH_MAX_CM}
          step={1}
          value={mmToCm(spec.wire.length)}
          hint={HINTS.wireLength}
          onChange={(v) => setWire({ length: cmToMm(v) })}
        />
        <RangeField
          testId="wireDiameter"
          label="Cable diameter"
          unit="mm"
          min={0.5}
          max={20}
          step={0.1}
          value={spec.wire.diameter}
          hint={HINTS.wireDiameter}
          onChange={(v) => setWire({ diameter: v })}
        />

        <div className="field">
          <FieldTop label="Cable type" hint={HINTS.wireType} htmlFor={wireTypeId} />
          <select
            id={wireTypeId}
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
        </div>
      </Section>

      <Section title="Shape">
        <ShapePicker testId="shape" label="Core shape" hint={HINTS.shape} value={spec.shape.kind} onChange={setShapeKind} />
        {spec.shape.kind !== "round" && (
          <RangeField
            testId="shapeCornerRadius"
            label="Corner radius"
            unit="mm"
            min={0}
            max={250}
            step={0.5}
            value={spec.shape.cornerRadius}
            hint={HINTS.shapeCornerRadius}
            onChange={setShapeCornerRadius}
          />
        )}
      </Section>

      <Section title="Core">
        <div className="field">
          <FieldTop label="Locked dimension" hint={HINTS.coreSizeDimension} htmlFor={coreSizeDimensionId} />
          <select
            id={coreSizeDimensionId}
            className="field-select"
            data-testid="select-coreSizeDimension"
            value={spec.coreSize.locked ? spec.coreSize.dimension : "outer"}
            disabled={!spec.coreSize.locked}
            onChange={(e) => setCoreSizeDimension(e.target.value as "outer" | "inner")}
          >
            <option value="outer">Outer (winding surface)</option>
            <option value="inner">Inner (bore)</option>
          </select>
        </div>
        <LockRangeField
          testId="outer"
          label="Core size"
          unit="mm"
          lock={spec.coreSize}
          min={outerSizeMin}
          max={500}
          step={1}
          freeValue={solution?.outerSize ?? 30}
          hint={HINTS.outer}
          onChange={setCoreSizeLock}
        />
        {coreSizeRaised && (
          <p className="field-note" data-testid="core-size-raised-note">
            Built at {roundMm(coreSizeRaised.built)} mm, not {roundMm(coreSizeRaised.requested)} mm: a {SHAPES[spec.shape.kind].label.toLowerCase()} core needs
            this much room for this cable's rounded corners.
          </p>
        )}
        <LockRangeField
          testId="height"
          label="Height"
          unit="mm"
          lock={spec.height}
          min={1}
          max={400}
          step={1}
          freeValue={solution?.height ?? 40}
          hint={HINTS.height}
          onChange={(lock) => onChange({ ...spec, height: lock })}
        />
        <LockStepperField
          testId="layers"
          label="Layers"
          lock={spec.layers}
          min={1}
          max={40}
          freeValue={solution?.layers ?? 1}
          hint={HINTS.layers}
          onChange={(lock) => onChange({ ...spec, layers: lock })}
        />
      </Section>

      <Section title="Mount">
        <div className="field">
          <FieldTop label="Wall mount" hint={HINTS.mount} htmlFor={mountId} />
          <select id={mountId} className="field-select" data-testid="select-mount" value={spec.mount} onChange={(e) => onChange({ ...spec, mount: e.target.value as MountKind })}>
            {MOUNT_OPTIONS.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        {(spec.mount === "skadis" || spec.mount === "opengrid") && (
          <div className="field">
            <FieldTop label="Plate joint" hint={HINTS.plateJoint} htmlFor={plateJointId} />
            <select
              id={plateJointId}
              className="field-select"
              data-testid="select-plateJoint"
              value={spec.plateJoint}
              onChange={(e) => onChange({ ...spec, plateJoint: e.target.value as PlateJoint })}
            >
              {PLATE_JOINT_OPTIONS.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        )}
        {spec.mount === "keyhole" && (
          <div className="field">
            <FieldTop label="Keyhole rotation" hint={HINTS.keyholeRotation} htmlFor={keyholeRotationId} />
            <select
              id={keyholeRotationId}
              className="field-select"
              data-testid="select-keyholeRotation"
              value={spec.keyholeRotation ?? 0}
              onChange={(e) => onChange({ ...spec, keyholeRotation: Number(e.target.value) as KeyholeRotation })}
            >
              {KEYHOLE_ROTATION_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {KEYHOLE_ROTATION_LABELS[opt]}
                </option>
              ))}
            </select>
          </div>
        )}
        {spec.mount === "through" && (
          <RangeField
            testId="throughHoleDiameter"
            label="Through-hole diameter"
            unit="mm"
            min={THROUGH_HOLE_DIAMETER_MIN}
            max={THROUGH_HOLE_DIAMETER_MAX}
            step={0.5}
            value={spec.throughHoleDiameter ?? DEFAULT_THROUGH_HOLE_DIAMETER}
            hint={HINTS.throughHoleDiameter}
            onChange={(v) => onChange({ ...spec, throughHoleDiameter: v })}
          />
        )}
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
            hint={HINTS.windingQuality}
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
              hint={HINTS.customMultiplier}
              onChange={(v) => setWire({ customBendMultiplier: v })}
            />
          )}
          {showObjective && (
            <div className="field">
              <FieldTop label={`Objective (${freeCount} free dimensions)`} hint={HINTS.objective} htmlFor={objectiveId} />
              <select
                id={objectiveId}
                className="field-select"
                data-testid="select-objective"
                value={spec.objective}
                onChange={(e) => onChange({ ...spec, objective: e.target.value as Objective })}
              >
                <option value="minVolume">Minimum volume</option>
                <option value="aspectRatio">Cube-like proportions</option>
              </select>
            </div>
          )}
        </div>
      </details>

      <Section title="Top cap & joint">
        <div className="field">
          <FieldTop label="Top cap" hint={HINTS.topCap} htmlFor={topCapId} />
          <select id={topCapId} className="field-select" data-testid="select-topCap" value={spec.topCap} onChange={(e) => onChange({ ...spec, topCap: e.target.value as TopCapMode })}>
            {TOP_CAP_OPTIONS.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <FieldTop label="Joint" hint={HINTS.joint} htmlFor={jointId} />
          <select id={jointId} className="field-select" data-testid="select-joint" value={spec.joint} onChange={(e) => onChange({ ...spec, joint: e.target.value as JointKind })}>
            {JOINT_OPTIONS.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        <RangeField
          testId="tolerance"
          label="Joint tolerance"
          unit="mm"
          min={TOLERANCE_MIN}
          max={TOLERANCE_MAX}
          step={0.05}
          value={spec.tolerance}
          hint={HINTS.tolerance}
          onChange={(v) => onChange({ ...spec, tolerance: v })}
        />
        <TextField
          testId="label"
          label="Label (engraved on the top cap)"
          placeholder="e.g. USB-C 2m"
          maxLength={LABEL_MAX_LENGTH}
          value={spec.label ?? ""}
          hint={HINTS.label}
          onChange={(v) => onChange({ ...spec, label: v })}
        />
      </Section>

      <Section title="Print bed">
        <RangeField testId="bedX" label="Bed X" unit="mm" min={BED_SIZE_MIN} max={BED_SIZE_MAX} step={1} value={spec.print.bedX} hint={HINTS.bedX} onChange={(v) => setPrint({ bedX: v })} />
        <RangeField testId="bedY" label="Bed Y" unit="mm" min={BED_SIZE_MIN} max={BED_SIZE_MAX} step={1} value={spec.print.bedY} hint={HINTS.bedY} onChange={(v) => setPrint({ bedY: v })} />
        <RangeField testId="bedZ" label="Bed Z" unit="mm" min={BED_SIZE_MIN} max={BED_SIZE_MAX} step={1} value={spec.print.bedZ} hint={HINTS.bedZ} onChange={(v) => setPrint({ bedZ: v })} />
      </Section>
    </form>
  );
}
