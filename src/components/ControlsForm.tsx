import { useEffect, useId, useRef } from "react";
import type { CoilSpec, CoreSizeLock, JointKind, KeyholeRotation, Lock, MountKind, Objective, ShapeKind, Solution, WireTypeId } from "../core";
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
import { FieldTop, LockRangeField, LockStepperField, RangeField, Section, Switch, TextField, cmToMm, mmToCm, roundMm } from "./fields";
import { HINTS } from "./hints";
import { ShapePicker } from "./ShapePicker";

/** Slider bounds in cm (issue #51 AC: "20-1500 cm"); converted to the mm `CoilSpec` stores. */
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
//
// Issue #131: no "None" entry any more -- that state is now the mount
// toggle's OFF position (see `mountOn` below), not a dropdown option.
const MOUNT_KIND_OPTIONS: Array<{ id: Exclude<MountKind, "none">; label: string }> = [
  { id: "keyhole", label: "Screw keyhole (wall mount)" },
  { id: "through", label: "Through-holes (screw straight on)" },
  { id: "skadis", label: "IKEA SKÅDIS clip plate" },
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

  // Issue #105 AC #4: the corner radius's own bend-limit floor for the
  // CURRENT shape/cable -- `solve.ts`'s `bendCornerRadiusFloor`, surfaced on
  // `Solution.cornerRadiusRange[0]` so the UI never derives its own,
  // possibly-drifting copy of that math. Round has no corner radius at all;
  // `solution` is undefined only before the very first solve, when 0 (no
  // floor yet known) is a safe placeholder.
  //
  // PR review: rounded UP (never to the nearest, which could round DOWN
  // past the true floor) to the field's own 0.5mm step, so the displayed
  // min-note and the field's own clamped value always agree, and neither
  // can ever read as below the real, unrounded floor.
  const cornerRadiusMinRaw = spec.shape.kind === "round" ? 0 : (solution?.cornerRadiusRange[0] ?? 0);
  const cornerRadiusMin = Math.ceil(cornerRadiusMinRaw / 0.5) * 0.5;

  // Issue #134: the slider's own maximum follows `Solution.cornerRadiusRange[1]`
  // -- the largest corner radius that still keeps the shape reading as a
  // square/triangle rather than a circle (solve.ts's `usefulMaxCornerRadius`),
  // not the old fixed 250mm (which let the slider keep moving for a long
  // stretch after the shape had already become visually indistinguishable
  // from round). `solution` is undefined only before the very first solve,
  // when 250 (the field's old static ceiling) is as good a placeholder as
  // any.
  //
  // Rounded DOWN to the field's own 0.5mm step (the opposite direction from
  // the min above): rounding UP here could push the field's max past the
  // true, unrounded ceiling.
  //
  // PR review: when the useful max and the bend-limit floor sit within the
  // SAME 0.5mm step of each other (the two criteria agree almost exactly --
  // see `usefulMaxCornerRadius`'s own doc comment on why they can coincide),
  // rounding each one in its own safe direction can flip their order --
  // ceil(14.44) = 14.5 but floor(14.44) = 14, an inverted [14.5, 14]
  // min/max that left the field's clamped VALUE (min(max, ...)) reading
  // BELOW the bend-limit floor it must never go under. `Math.max` against
  // `cornerRadiusMin` guarantees a valid, non-inverted range, at the cost of
  // the max occasionally reading up to 0.5mm past the true useful ceiling --
  // the same order of rounding slop the min side already accepts.
  const cornerRadiusMaxRaw = spec.shape.kind === "round" ? 250 : (solution?.cornerRadiusRange[1] ?? 250);
  const cornerRadiusMax = Math.max(cornerRadiusMin, Math.floor(cornerRadiusMaxRaw / 0.5) * 0.5);

  // Issue #140: no useful room to move the slider at all -- either the
  // bend-limit floor and the useful max already coincide exactly (a
  // literally empty range) or they're close enough that they round to the
  // SAME 0.5mm step (the same coincidence `cornerRadiusMax`'s own
  // `Math.max` clamp above already guards against), leaving only one
  // reachable value on the slider's own grid. Kept as its own flag, not
  // reused from `disabled`'s existing "hide the slider" meaning elsewhere
  // in this file (`LockRangeField`, a free dimension) -- this field must
  // stay VISIBLE while unmovable (the issue's own "grey out the slider",
  // not "hide it"), via `RangeField`'s opt-in `keepSliderWhenDisabled`.
  const cornerRadiusDisabled = spec.shape.kind !== "round" && cornerRadiusMax <= cornerRadiusMin;

  // Issue #140: the (i) hint explains WHY, once the field is disabled --
  // appended rather than replacing `HINTS.shapeCornerRadius` outright, so
  // the hint still says what the field normally does too.
  const cornerRadiusHint = cornerRadiusDisabled ? `${HINTS.shapeCornerRadius} The core is too small for a larger radius; grow the core to unlock.` : HINTS.shapeCornerRadius;

  // Issue #105 AC #5: "enabled" tracks whether the user switched the label
  // ON, not whether it currently has text -- an empty label while the
  // switch is on must stay revealed, not snap shut. `spec.label` is only
  // ever `undefined` (never `""`) while the switch is off: the switch's own
  // onChange below is the one place that clears it back to `undefined`.
  const labelEnabled = spec.label !== undefined;
  const setLabelEnabled = (checked: boolean) => onChange({ ...spec, label: checked ? (spec.label ?? "") : undefined });

  const setShapeKind = (kind: ShapeKind) => {
    onChange({ ...spec, shape: kind === "round" ? { kind } : { kind, cornerRadius: DEFAULT_CORNER_RADIUS } });
  };
  const setShapeCornerRadius = (cornerRadius: number) => {
    if (spec.shape.kind === "round") return;
    // Issue #105 AC #4: never let a manual edit (slider drag OR typed
    // number) push the corner radius below this cable's own bend-limit
    // floor -- `solution.cornerRadiusRange[0]` is that exact floor for the
    // CURRENT shape/cable (solve.ts's `bendCornerRadiusFloor`), so this
    // can't drift from what the solver would clamp to anyway. Issue #134:
    // the SAME immediate-clamp treatment for the other end -- a manual edit
    // above `cornerRadiusMax` snaps right back down, matching the slider's
    // own max attribute instead of silently accepting a request the solver
    // would just clamp down to anyway.
    onChange({ ...spec, shape: { kind: spec.shape.kind, cornerRadius: Math.min(cornerRadiusMax, Math.max(cornerRadiusMin, cornerRadius)) } });
  };

  // Ids for the plain `<select>` fields below, so each one's `FieldTop`
  // label is a real `<label for>` (issue #53's (i) button sits next to that
  // label, as a sibling -- never nested inside a wrapping `<label>`).
  const wireTypeId = useId();
  const coreSizeDimensionId = useId();
  const mountId = useId();
  const keyholeRotationId = useId();
  const objectiveId = useId();
  const jointId = useId();

  const freeCount = [spec.coreSize.locked, spec.height.locked, spec.layers.locked].filter((locked) => !locked).length;
  const showObjective = freeCount >= 2;

  // Issue #119 AC #1: at most 2 of {core size, height, layers} can be locked
  // at once -- something has to stay free so the solver can fit the cable
  // length. `lockedCount >= 2` disables locking any dimension that ISN'T
  // already locked (an already-locked one must always stay toggleable back
  // to free); `LockRangeField`/`LockStepperField` render the explanatory
  // note themselves (see fields.tsx's `LOCK_LIMIT_NOTE`) once disabled.
  const lockedCount = [spec.coreSize.locked, spec.height.locked, spec.layers.locked].filter(Boolean).length;
  const coreSizeLockDisabled = !spec.coreSize.locked && lockedCount >= 2;
  const heightLockDisabled = !spec.height.locked && lockedCount >= 2;
  const layersLockDisabled = !spec.layers.locked && lockedCount >= 2;

  // Issue #119 AC #3: the top-cap switch is "auto" (untouched) exactly when
  // `spec.topCap === "auto"` -- `TopCapMode` already distinguishes that from
  // an explicit "on"/"off" (issue #9), so no new field is needed. While
  // auto, the switch shows the CURRENT automatic recommendation
  // (`solution.capsAuto`, layers > 1); `solution` is undefined only before
  // the very first solve, when "no cap yet" (false) is as good a placeholder
  // as any (matches the default layers=1). Touching the switch writes an
  // explicit "on"/"off" (stored in the hash, see hash.ts's `doc.cap`); the
  // "Reset to auto" link is the documented way back.
  const topCapAuto = spec.topCap === "auto";
  const topCapOn = topCapAuto ? (solution?.capsAuto ?? false) : spec.topCap === "on";
  const setTopCapExplicit = (checked: boolean) => onChange({ ...spec, topCap: checked ? "on" : "off" });
  const resetTopCapToAuto = () => onChange({ ...spec, topCap: "auto" });

  // Issue #131: the Wall-mount section now leads with a pill toggle instead
  // of a "None" entry in the dropdown -- off IS `spec.mount === "none"`
  // (already the hash's own backward-compatible default, hash.ts: absent or
  // "none" means off), so no new spec/hash field is needed. Turning it back
  // on restores whichever real kind was last selected rather than resetting
  // to a fixed one -- a plain "latest ref" kept in sync with `spec.mount`
  // on every render where it's a real kind, defaulting to "keyhole" before
  // the user has ever picked one (including a link that starts with the
  // mount already off).
  const lastMountKindRef = useRef<Exclude<MountKind, "none">>(spec.mount !== "none" ? spec.mount : "keyhole");
  if (spec.mount !== "none") lastMountKindRef.current = spec.mount;
  const mountOn = spec.mount !== "none";
  const setMountOn = (checked: boolean) => onChange({ ...spec, mount: checked ? lastMountKindRef.current : "none" });

  // Issue #54/#58: for a square or triangle core, this cable's bend limit
  // can force a bigger minimum core size than a round core needs (a bigger
  // corner radius, at a fixed size, erodes the straight sides). The size
  // slider's own minimum follows that (never lets the user drag below a
  // size the solver would just raise anyway); `solution` is undefined only
  // before the very first solve, when 5mm is as good a placeholder as any.
  //
  // PR review: rounded to the SAME whole/half-mm precision the field
  // already shows a free (solver-set) size at (`roundMm`, issue #72 AC) --
  // matching that existing convention, rather than a stricter ceiling, so
  // this reads exactly like every other core-size number in the app.
  // `LockRangeField` clamps the FIELD's own displayed value (and every
  // edit) to this exact number, so the field can never show a stale/
  // shared-link request below it -- it always shows the effective size,
  // matching the note below. (A locked value can, in rare cases, still be a
  // hair's-width under the solver's own unrounded floor after this rounding
  // -- the solver's existing "Core size raised from X to Y" warning already
  // covers that residual, sub-millimetre gap.)
  const outerSizeMin = spec.shape.kind === "round" ? 5 : roundMm(Math.max(5, solution?.minOuterSizeForShape ?? 5));
  // A LOCKED size below that floor only reaches the spec via a shared link
  // predating this clamp (any edit through the UI is clamped immediately,
  // by `LockRangeField` above) -- this note explains why the field's own
  // displayed value doesn't match what that link asked for. Both the field
  // and this note read off the SAME `outerSizeMin`, so they can never
  // disagree (issue #105 PR review).
  const coreSizeRaised = spec.shape.kind !== "round" && spec.coreSize.locked && spec.coreSize.value < outerSizeMin - 0.05;

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
        {/* Issue #105 AC #6: the custom bend multiplier lives directly under
            "Cable type" (not tucked away in "Advanced settings") and only
            when it's actually read (wire.type === "custom", see
            `bendMultiplierOf`) -- every other cable type has this baked into
            its own preset, so the field would be inert noise otherwise. */}
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
            // PR review: the FIELD must show the effective (clamped) value,
            // never a stale/shared-link request below the bend-limit floor
            // or above the useful max -- `cornerRadiusMin`/`cornerRadiusMax`
            // are already the safe, rounded floor/ceiling (never inside the
            // true one), so this can't drift from the min-note's own number
            // below or the slider's own `max` attribute.
            value={Math.min(cornerRadiusMax, Math.max(cornerRadiusMin, spec.shape.cornerRadius))}
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
        {/* Issue #119 AC #2: directly under the core-size lock, and only
            while core size is locked -- a free core size has no "locked
            dimension" to speak of (the dropdown was previously always
            rendered, just disabled). */}
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
        <LockStepperField
          testId="layers"
          label="Layers"
          lock={spec.layers}
          min={1}
          max={40}
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
        {/* Issue #131: the kind picker only exists once the toggle above is
            on -- off is exactly today's "none", nothing left to pick. */}
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
        {/* Issue #131: a small, unobtrusive credit for SKÅDIS's own clip
            geometry, which this app's clip profile is based on (see
            docs/research.md's "skapa" section) -- shown only for the mount
            it actually describes. */}
        {spec.mount === "skadis" && (
          <p className="field-note mount-credit-note" data-testid="mount-credit">
            Clip design after{" "}
            <a href="https://github.com/nmattia/skapa" target="_blank" rel="noreferrer">
              skapa
            </a>
            .
          </p>
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
          <div className="field-top">
            <FieldTop label="Top cap" hint={HINTS.topCap} />
            {/* Issue #131: the "auto" tag sits BEFORE the switch (matching
                its pill height) so the row reads left-to-right as "current
                mode, then state" -- once touched, that same spot shows a
                "reset" link back to auto instead, and the separate
                "Reset to auto" line that used to sit below the switch is
                gone (issue #119's own version of this row). */}
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
                    ? `Auto -- currently ${topCapOn ? "on" : "off"} (on once there's more than one layer). Touch to set it explicitly.`
                    : `${topCapOn ? "On" : "Off"} (explicit) -- click to change`
                }
                onChange={setTopCapExplicit}
              />
            </span>
          </div>
        </div>
        {/* Issue #131 AC #4: the joint/tolerance/label controls only apply
            to a cap that actually exists -- hidden whenever the cap is off,
            whether that's the user's own explicit override or just the
            current automatic (layers <= 1) decision. Their values stay put
            in `spec` either way (only the CONTROLS hide, nothing resets),
            so they're exactly as the user left them once the cap comes back. */}
        {topCapOn && (
          <>
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
            <div className="field">
              <div className="field-top">
                <FieldTop label="Label (engraved on the top cap)" hint={HINTS.label} />
                <Switch testId="label-enabled" ariaLabel="Engrave a label on the top cap" checked={labelEnabled} onChange={setLabelEnabled} />
              </div>
            </div>
            {/* Issue #105 AC #5: off by default, and the text input stays
                collapsed until switched on -- `labelEnabled` reads "the user
                turned this on", not "there's text in it" (an empty label
                while the switch is on is still a deliberate, revealed field,
                not a reason to re-collapse it). Switching off clears the
                label back to `undefined`, which `toHash` already omits from
                the URL (see hash.ts's `if (spec.label) doc.label = ...`), so
                "clears the hash" falls out of the existing encode rule for
                free. */}
            {labelEnabled && (
              <TextField
                testId="label"
                label="Label text"
                placeholder="e.g. USB-C 2m"
                maxLength={LABEL_MAX_LENGTH}
                value={spec.label ?? ""}
                onChange={(v) => onChange({ ...spec, label: v })}
              />
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
