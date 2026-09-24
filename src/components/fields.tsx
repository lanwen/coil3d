import type { ChangeEvent, ReactNode } from "react";
import type { Lock } from "../core";

/** Round to the nearest 0.1 -- the solver's raw floats (e.g. 34.65625mm) are
 * never shown to the user; every displayed/seeded number is sane. See issue
 * #16: "the solved values in free fields must be rounded". */
export const round1 = (n: number) => Math.round(n * 10) / 10;

/** A labelled group of fields (Cable / Shape / Core / Result / Export). Pure
 * presentation: calm vertical rhythm instead of a flat wall of inputs. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="ctl-section">
      <h2 className="ctl-section-title">{title}</h2>
      <div className="ctl-section-body">{children}</div>
    </section>
  );
}

/**
 * A custom range slider synced with a number input and a unit suffix (issue
 * #16 AC). The number input keeps the field's stable `input-${testId}`
 * testid; the slider is a purely visual companion.
 */
export function RangeField({
  testId,
  label,
  unit,
  value,
  min,
  max,
  step,
  disabled,
  /** Rendered before the label, on the same row (e.g. the lock pictogram) --
   * issue #16 review: the lock must sit inline with the field it controls,
   * not on a row of its own above it. */
  leading,
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
  leading?: ReactNode;
  onChange: (value: number) => void;
}) {
  const handleNumber = (event: ChangeEvent<HTMLInputElement>) => {
    const next = Number(event.target.value);
    if (!Number.isFinite(next)) return;
    onChange(next);
  };
  const handleRange = (event: ChangeEvent<HTMLInputElement>) => onChange(Number(event.target.value));
  return (
    <div className="field">
      <div className="field-top">
        <span className="field-top-label">
          {leading}
          <span className="field-label">{label}</span>
        </span>
        <span className="field-value">
          <input
            type="number"
            className="field-number"
            data-testid={`input-${testId}`}
            value={value}
            min={min}
            max={max}
            step={step}
            disabled={disabled}
            onChange={handleNumber}
          />
          {unit && <span className="field-unit">{unit}</span>}
        </span>
      </div>
      <input
        type="range"
        className="field-slider"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={handleRange}
      />
    </div>
  );
}

/** A plain single-line text field (issue #12: the top cap label). Styled
 * like `.field-select` (a bordered box) rather than the underlined
 * `.field-number`, since there's no unit/slider companion here. */
export function TextField({
  testId,
  label,
  value,
  placeholder,
  maxLength,
  onChange,
}: {
  testId: string;
  label: string;
  value: string;
  placeholder?: string;
  maxLength?: number;
  onChange: (value: string) => void;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        type="text"
        className="field-text"
        data-testid={`input-${testId}`}
        value={value}
        placeholder={placeholder}
        maxLength={maxLength}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

/** A +/- stepper paired with a number input, for small integer counts (layers). */
export function StepperField({
  testId,
  label,
  value,
  min,
  max,
  disabled,
  leading,
  onChange,
}: {
  testId: string;
  label: string;
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  leading?: ReactNode;
  onChange: (value: number) => void;
}) {
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  const handleNumber = (event: ChangeEvent<HTMLInputElement>) => {
    const next = Number(event.target.value);
    if (!Number.isFinite(next)) return;
    onChange(clamp(Math.round(next)));
  };
  return (
    <div className="field">
      <div className="field-top">
        <span className="field-top-label">
          {leading}
          <span className="field-label">{label}</span>
        </span>
      </div>
      <div className="stepper">
        <button
          type="button"
          className="stepper-btn"
          aria-label={`Decrease ${label}`}
          disabled={disabled || value <= min}
          onClick={() => onChange(clamp(value - 1))}
        >
          &minus;
        </button>
        <input
          type="number"
          className="stepper-number"
          data-testid={`input-${testId}`}
          value={value}
          min={min}
          max={max}
          step={1}
          disabled={disabled}
          onChange={handleNumber}
        />
        <button
          type="button"
          className="stepper-btn"
          aria-label={`Increase ${label}`}
          disabled={disabled || value >= max}
          onClick={() => onChange(clamp(value + 1))}
        >
          +
        </button>
      </div>
    </div>
  );
}

/**
 * The lock toggle: a real checkbox (so Playwright's check()/uncheck()/
 * toBeChecked() keep working unchanged) styled entirely via CSS as a black
 * and white padlock pictogram -- open when free, closed (solid) when locked
 * -- never a raw square checkbox (issue #16 AC). Rendered as a `leading`
 * element inline on the field's own label row (issue #16 review: a lock on
 * a row of its own, above the field, left it ambiguous which field it
 * controlled), with an explicit "Lock {label}" accessible name since the
 * visible row carries the pictogram only, no text.
 */
function LockCheckbox({ testId, label, checked, onChange }: { testId: string; label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="lock-toggle" title={checked ? `Locked -- click to let ${label} be solved` : `Free -- click to lock ${label}`}>
      <input
        type="checkbox"
        className="lock-toggle-input"
        data-testid={`lock-${testId}`}
        aria-label={`Lock ${label}`}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="lock-icon" aria-hidden="true">
        <span className="lock-icon-shackle" />
        <span className="lock-icon-body" />
      </span>
    </label>
  );
}

/** A lockable numeric range field: pairs {@link LockCheckbox} with {@link RangeField}. */
export function LockRangeField({
  testId,
  label,
  unit,
  lock,
  min,
  max,
  step,
  freeValue,
  onChange,
}: {
  testId: string;
  label: string;
  unit: string;
  lock: Lock<number>;
  min: number;
  max: number;
  step: number;
  freeValue: number;
  onChange: (lock: Lock<number>) => void;
}) {
  const toggle = (checked: boolean) => onChange(checked ? { locked: true, value: lock.locked ? lock.value : freeValue } : { locked: false });
  const setValue = (value: number) => {
    if (lock.locked) onChange({ locked: true, value });
  };
  return (
    <RangeField
      testId={testId}
      label={label}
      unit={unit}
      value={lock.locked ? lock.value : round1(freeValue)}
      min={min}
      max={max}
      step={step}
      disabled={!lock.locked}
      leading={<LockCheckbox testId={testId} label={label} checked={lock.locked} onChange={toggle} />}
      onChange={setValue}
    />
  );
}

/** A lockable integer stepper field: pairs {@link LockCheckbox} with {@link StepperField}. */
export function LockStepperField({
  testId,
  label,
  lock,
  min,
  max,
  freeValue,
  onChange,
}: {
  testId: string;
  label: string;
  lock: Lock<number>;
  min: number;
  max: number;
  freeValue: number;
  onChange: (lock: Lock<number>) => void;
}) {
  const toggle = (checked: boolean) => onChange(checked ? { locked: true, value: lock.locked ? lock.value : freeValue } : { locked: false });
  const setValue = (value: number) => {
    if (lock.locked) onChange({ locked: true, value });
  };
  return (
    <StepperField
      testId={testId}
      label={label}
      value={lock.locked ? lock.value : Math.round(freeValue)}
      min={min}
      max={max}
      disabled={!lock.locked}
      leading={<LockCheckbox testId={testId} label={label} checked={lock.locked} onChange={toggle} />}
      onChange={setValue}
    />
  );
}

/**
 * A view-only visibility toggle (currently: "show wound cable" over the
 * viewer), styled the same way as the lock toggle -- a real checkbox behind
 * a black/white pictogram, here an eye / crossed-out eye -- never a raw
 * checkbox (issue #16 review).
 */
export function EyeToggle({ testId, label, checked, onChange }: { testId: string; label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="eye-toggle" title={checked ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}>
      <input
        type="checkbox"
        className="eye-toggle-input"
        data-testid={`toggle-${testId}`}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="eye-icon" aria-hidden="true">
        <span className="eye-icon-outer" />
        <span className="eye-icon-pupil" />
        <span className="eye-icon-slash" />
      </span>
      <span className="eye-toggle-text">{label}</span>
    </label>
  );
}
