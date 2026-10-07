import { useId, useRef } from "react";
import type { CoilSpec, CoreSizeLock, Design, JointKind, KeyholeRotation, Lock, MountKind, ShapeKind, Solution, WireTypeId } from "../core";
import {
  BED_SIZE_MAX,
  BED_SIZE_MIN,
  DEFAULT_BASE,
  DEFAULT_CORNER_RADIUS,
  DEFAULT_CUSTOM_BEND_MULTIPLIER,
  DEFAULT_THROUGH_HOLE_DIAMETER,
  KEYHOLE_ROTATION_OPTIONS,
  SHAPES,
  THROUGH_HOLE_DIAMETER_MAX,
  THROUGH_HOLE_DIAMETER_MIN,
  TOLERANCE_MAX,
  TOLERANCE_MIN,
  WIRE_TYPE_PRESETS,
} from "../core";
import { FieldTop, LockRangeField, RangeField, Section, Switch, cmToMm, mmToCm, roundMm } from "./fields";
import { HINTS } from "./hints";
import { LabelField } from "./LabelField";
import { ShapePicker } from "./ShapePicker";

const WIRE_LENGTH_MIN_CM = 20;
const WIRE_LENGTH_MAX_CM = 1500;

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

const MOUNT_KIND_OPTIONS: Array<{ id: Exclude<MountKind, "none">; label: string }> = [
  { id: "keyhole", label: "Screw keyhole (wall mount)" },
  { id: "through", label: "Through-holes (screw straight on)" },
  { id: "skadis", label: "IKEA SKÅDIS rim clips: hook on, lift off" },
  { id: "skadis-tclip", label: "IKEA SKÅDIS T-clips: twist to lock" },
];

const CORNER_RADIUS_STEP_MM = 0.5;
const ROUND_CORNER_RADIUS_MAX_MM = 250;
const CORE_SIZE_FLOOR_MM = 5;

const ceilToStep = (mm: number) => Math.ceil(mm / CORNER_RADIUS_STEP_MM) * CORNER_RADIUS_STEP_MM;
const floorToStep = (mm: number) => Math.floor(mm / CORNER_RADIUS_STEP_MM) * CORNER_RADIUS_STEP_MM;

const KEYHOLE_ROTATION_LABELS: Record<KeyholeRotation, string> = {
  0: "0°",
  45: "45°",
};

export function ControlsForm({
  spec,
  solution,
  design,
  finalReady,
  onChange,
}: {
  spec: CoilSpec;
  solution?: Solution;
  design?: Design | null;
  finalReady?: boolean;
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

  const bendLimitCornerRadius = spec.shape.kind === "round" ? 0 : (solution?.cornerRadiusRange[0] ?? 0);
  const cornerRadiusMin = ceilToStep(bendLimitCornerRadius);

  const usefulMaxCornerRadius = spec.shape.kind === "round" ? ROUND_CORNER_RADIUS_MAX_MM : (solution?.cornerRadiusRange[1] ?? ROUND_CORNER_RADIUS_MAX_MM);
  const cornerRadiusMax = Math.max(cornerRadiusMin, floorToStep(usefulMaxCornerRadius));
  const clampCornerRadius = (cornerRadius: number) => Math.min(cornerRadiusMax, Math.max(cornerRadiusMin, cornerRadius));

  const cornerRadiusDisabled = spec.shape.kind !== "round" && cornerRadiusMax <= cornerRadiusMin;

  const cornerRadiusHint = cornerRadiusDisabled ? `${HINTS.shapeCornerRadius} The core is too small for a larger radius; grow the core to unlock.` : HINTS.shapeCornerRadius;

  const bayonetUnavailable = spec.shape.kind !== "round";
  const jointHint = bayonetUnavailable ? `${HINTS.joint} Twist lock needs a round core.` : HINTS.joint;

  const labelEnabled = spec.label !== undefined;
  const setLabelEnabled = (checked: boolean) => onChange({ ...spec, label: checked ? (spec.label ?? "") : undefined });

  const setShapeKind = (kind: ShapeKind) => {
    onChange({ ...spec, shape: kind === "round" ? { kind } : { kind, cornerRadius: DEFAULT_CORNER_RADIUS } });
  };
  const setShapeCornerRadius = (cornerRadius: number) => {
    if (spec.shape.kind === "round") return;
    onChange({ ...spec, shape: { kind: spec.shape.kind, cornerRadius: clampCornerRadius(cornerRadius) } });
  };

  const wireTypeId = useId();
  const coreSizeDimensionId = useId();
  const mountId = useId();
  const keyholeRotationId = useId();
  const jointId = useId();

  const lockedCount = [spec.coreSize.locked, spec.height.locked, spec.layers.locked].filter(Boolean).length;
  const coreSizeLockDisabled = !spec.coreSize.locked && lockedCount >= 2;
  const heightLockDisabled = !spec.height.locked && lockedCount >= 2;
  const layersLockDisabled = !spec.layers.locked && lockedCount >= 2;

  const topCapAuto = spec.topCap === "auto";
  const topCapOn = topCapAuto ? (solution?.capsAuto ?? false) : spec.topCap === "on";
  const setTopCapExplicit = (checked: boolean) => onChange({ ...spec, topCap: checked ? "on" : "off" });
  const resetTopCapToAuto = () => onChange({ ...spec, topCap: "auto" });

  const lastMountKindRef = useRef<Exclude<MountKind, "none">>(spec.mount !== "none" ? spec.mount : "keyhole");
  if (spec.mount !== "none") lastMountKindRef.current = spec.mount;
  const mountOn = spec.mount !== "none";
  const baseOn = mountOn || (spec.base ?? DEFAULT_BASE) === "on";
  const setMountOn = (checked: boolean) => onChange({ ...spec, mount: checked ? lastMountKindRef.current : "none" });

  const outerSizeMin = roundMm(Math.max(CORE_SIZE_FLOOR_MM, solution?.minOuterSizeForShape ?? CORE_SIZE_FLOOR_MM));
  const coreSizeRaised = spec.coreSize.locked && spec.coreSize.value < outerSizeMin - 0.05;

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
        {spec.wire.type === "custom" && (
          <RangeField
            testId="customMultiplier"
            label="Custom bend multiplier"
            unit="x diameter"
            min={0.5}
            max={50}
            step={0.1}
            value={spec.wire.customBendMultiplier ?? DEFAULT_CUSTOM_BEND_MULTIPLIER}
            hint={HINTS.customMultiplier}
            onChange={(v) => setWire({ customBendMultiplier: v })}
          />
        )}
      </Section>

      <Section title="Shape">
        <ShapePicker testId="shape" label="Core shape" hint={HINTS.shape} value={spec.shape.kind} onChange={setShapeKind} />
        {spec.shape.kind !== "round" && (
          <RangeField
            testId="shapeCornerRadius"
            label="Corner radius"
            unit="mm"
            min={cornerRadiusMin}
            max={cornerRadiusMax}
            step={0.5}
            value={clampCornerRadius(spec.shape.cornerRadius)}
            disabled={cornerRadiusDisabled}
            keepSliderWhenDisabled
            maxLabel
            hint={cornerRadiusHint}
            minNote={cornerRadiusMin > 0.05 ? `Minimum for this cable's bend limit: ${cornerRadiusMin} mm` : undefined}
            onChange={setShapeCornerRadius}
          />
        )}
      </Section>

      <Section title="Core">
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
          lockDisabled={coreSizeLockDisabled}
          onChange={setCoreSizeLock}
        />
        {spec.coreSize.locked && (
          <div className="field">
            <FieldTop label="Locked dimension" hint={HINTS.coreSizeDimension} htmlFor={coreSizeDimensionId} />
            <select
              id={coreSizeDimensionId}
              className="field-select"
              data-testid="select-coreSizeDimension"
              value={spec.coreSize.dimension}
              onChange={(e) => setCoreSizeDimension(e.target.value as "outer" | "inner")}
            >
              <option value="outer">Outer (winding surface)</option>
              <option value="inner">Inner (bore)</option>
            </select>
          </div>
        )}
        {coreSizeRaised && (
          <p className="field-note" data-testid="core-size-raised-note">
            Minimum for this {SHAPES[spec.shape.kind].label.toLowerCase()} shape and cable: {outerSizeMin} mm. Your value was raised to it.
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
          lockDisabled={heightLockDisabled}
          onChange={(lock) => onChange({ ...spec, height: lock })}
        />
        <LockRangeField
          testId="layers"
          label="Layers"
          unit=""
          lock={spec.layers}
          min={1}
          max={40}
          step={1}
          normalize={Math.round}
          freeValue={solution?.layers ?? 1}
          hint={HINTS.layers}
          lockDisabled={layersLockDisabled}
          onChange={(lock) => onChange({ ...spec, layers: lock })}
        />
      </Section>

      <Section title="Mount">
        <div className="field">
          <div className="field-top">
            <FieldTop label="Wall mount" hint={HINTS.mount} />
            <Switch testId="mount-enabled" ariaLabel="Wall mount" checked={mountOn} onChange={setMountOn} />
          </div>
        </div>
        {mountOn && (
          <div className="field">
            <FieldTop label="Mount type" hint={HINTS.mount} htmlFor={mountId} />
            <select id={mountId} className="field-select" data-testid="select-mount" value={spec.mount} onChange={(e) => onChange({ ...spec, mount: e.target.value as MountKind })}>
              {MOUNT_KIND_OPTIONS.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        )}
        {spec.mount === "skadis-tclip" && (
          <p className="field-note mount-credit-note" data-testid="mount-note">
            Twist-lock clips pass through slots in the core's floor: reach in, push each one through upright, then pinch its fin and turn it a quarter turn. After the{" "}
            <a href="https://www.printables.com/model/256896" target="_blank" rel="noreferrer">
              Skadis T-Clip System
            </a>{" "}
            by Line Arc Line (CC BY 4.0).
          </p>
        )}
        {spec.mount === "skadis" && (
          <>
            <p className="field-note mount-credit-note" data-testid="mount-note">
              Separate clips hook into the board and grip the flange's rim. Hang the coil on them, lift it off.
            </p>
            <div className="field">
              <div className="field-top">
                <FieldTop label="Anti-lift latch" hint={HINTS.skadisLatch} />
                <Switch testId="skadis-latch" ariaLabel="Anti-lift latch" checked={spec.skadisLatch ?? true} onChange={(on) => onChange({ ...spec, skadisLatch: on })} />
              </div>
            </div>
          </>
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

      <details className="advanced">
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
        </div>
      </details>

      <Section title="Base, top cap & joint">
        <div className="field">
          <div className="field-top">
            <FieldTop label="Base" hint={HINTS.base} />
            <Switch
              testId="base"
              ariaLabel="Base"
              checked={baseOn}
              disabled={mountOn}
              title={mountOn ? "On -- a wall mount needs the base" : `${baseOn ? "On" : "Off"} -- click to change`}
              onChange={(checked) => onChange({ ...spec, base: checked ? "on" : "off" })}
            />
          </div>
        </div>
        <div className="field">
          <div className="field-top">
            <FieldTop label="Top cap" hint={HINTS.topCap} />
            <span className="cap-toggle-row">
              {topCapAuto ? (
                <span className="tag-auto" data-testid="topCap-auto-tag">
                  auto
                </span>
              ) : (
                <button type="button" className="reset-auto-btn" data-testid="topCap-reset-auto" onClick={resetTopCapToAuto}>
                  reset
                </button>
              )}
              <Switch
                testId="topCap"
                ariaLabel="Top cap"
                checked={topCapOn}
                title={
                  topCapAuto
                    ? `Auto -- currently ${topCapOn ? "on" : "off"}. Touch to set it explicitly.`
                    : `${topCapOn ? "On" : "Off"} (explicit) -- click to change`
                }
                onChange={setTopCapExplicit}
              />
            </span>
          </div>
        </div>
        {topCapOn && (
          <>
            <div className="field">
              <FieldTop label="Joint" hint={jointHint} htmlFor={jointId} />
              <select id={jointId} className="field-select" data-testid="select-joint" value={spec.joint} onChange={(e) => onChange({ ...spec, joint: e.target.value as JointKind })}>
                {JOINT_OPTIONS.map((opt) => (
                  <option key={opt.id} value={opt.id} disabled={opt.id === "bayonet" && bayonetUnavailable}>
                    {opt.id === "bayonet" && bayonetUnavailable ? `${opt.label} (round core only)` : opt.label}
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
            <div className="field">
              <div className="field-top">
                <FieldTop label="Label (engraved on the top cap)" hint={HINTS.label} />
                <Switch testId="label-enabled" ariaLabel="Engrave a label on the top cap" checked={labelEnabled} onChange={setLabelEnabled} />
              </div>
            </div>
            {labelEnabled && (
              <LabelField spec={spec} design={design} finalReady={finalReady} onChange={onChange} />
            )}
          </>
        )}
      </Section>

      <Section title="Print bed">
        <RangeField testId="bedX" label="Bed X" unit="mm" min={BED_SIZE_MIN} max={BED_SIZE_MAX} step={1} value={spec.print.bedX} hint={HINTS.bedX} onChange={(v) => setPrint({ bedX: v })} />
        <RangeField testId="bedY" label="Bed Y" unit="mm" min={BED_SIZE_MIN} max={BED_SIZE_MAX} step={1} value={spec.print.bedY} hint={HINTS.bedY} onChange={(v) => setPrint({ bedY: v })} />
        <RangeField testId="bedZ" label="Bed Z" unit="mm" min={BED_SIZE_MIN} max={BED_SIZE_MAX} step={1} value={spec.print.bedZ} hint={HINTS.bedZ} onChange={(v) => setPrint({ bedZ: v })} />
      </Section>
    </form>
  );
}
