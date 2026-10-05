import { useId } from "react";
import type { ChangeEvent, ReactNode } from "react";
import type { Lock } from "../core";
import { Hint } from "./Hint";

const SMALL_COIL_MM = 20;
export function roundMm(value: number): number {
  const step = value < SMALL_COIL_MM ? 0.5 : 1;
  return Math.round(value / step) * step;
}

export const MM_PER_CM = 10;
export const mmToCm = (mm: number) => mm / MM_PER_CM;
export const cmToMm = (cm: number) => cm * MM_PER_CM;

export function FieldTop({
  label,
  hint,
  htmlFor,
  labelId,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  labelId?: string;
}) {
  return (
    <span className="field-label-row">
      {htmlFor ? (
        <label id={labelId} htmlFor={htmlFor} className="field-label">
          {label}
        </label>
      ) : (
        <span id={labelId} className="field-label">
          {label}
        </span>
      )}
      {hint && <Hint text={hint} />}
    </span>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="ctl-section">
      <h2 className="ctl-section-title">{title}</h2>
      <div className="ctl-section-body">{children}</div>
    </section>
  );
}

const fitToDigitsStyle = (value: number) => ({ width: `calc(${String(value).length + 0.4}ch + 0.8em)` });

export function RangeField({
  testId,
  label,
  unit,
  value,
  min,
  max,
  step,
  disabled,
  leading,
  hint,
  minNote,
  keepSliderWhenDisabled,
  maxLabel,
  valuePrefix,
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
  hint?: string;
  minNote?: string;
  keepSliderWhenDisabled?: boolean;
  maxLabel?: boolean;
  valuePrefix?: ReactNode;
  onChange: (value: number) => void;
}) {
  const numberId = useId();
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
          <FieldTop label={label} hint={hint} htmlFor={numberId} />
        </span>
        <span className="field-value">
          {valuePrefix}
          <input
            id={numberId}
            type="number"
            className={valuePrefix ? "field-number field-number-fit" : "field-number"}
            style={valuePrefix ? fitToDigitsStyle(value) : undefined}
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
      {(!disabled || keepSliderWhenDisabled) && (
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
      )}
      {maxLabel && (
        <p className="field-note field-max-label" data-testid={`${testId}-max-label`}>
          {`max ${max}${unit ? ` ${unit}` : ""}`}
        </p>
      )}
      {minNote && (
        <p className="field-note" data-testid={`${testId}-min-note`}>
          {minNote}
        </p>
      )}
    </div>
  );
}

export function TextField({
  testId,
  label,
  value,
  placeholder,
  maxLength,
  hint,
  onChange,
}: {
  testId: string;
  label: string;
  value: string;
  placeholder?: string;
  maxLength?: number;
  hint?: string;
  onChange: (value: string) => void;
}) {
  const inputId = useId();
  return (
    <div className="field">
      <FieldTop label={label} hint={hint} htmlFor={inputId} />
      <input
        id={inputId}
        type="text"
        className="field-text"
        data-testid={`input-${testId}`}
        value={value}
        placeholder={placeholder}
        maxLength={maxLength}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

export function Switch({
  testId,
  ariaLabel,
  checked,
  title,
  disabled,
  onChange,
  showState = true,
  offContent = "0",
  onContent = "I",
  children,
}: {
  testId: string;
  ariaLabel: string;
  checked: boolean;
  title?: string;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  showState?: boolean;
  offContent?: ReactNode;
  onContent?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <label className="switch" title={title}>
      <input
        type="checkbox"
        role="switch"
        className="switch-input"
        data-testid={testId}
        aria-label={ariaLabel}
        aria-checked={checked}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="switch-track" aria-hidden="true">
        {showState && (
          <>
            <span className="switch-state switch-state-off">{offContent}</span>
            <span className="switch-state switch-state-on">{onContent}</span>
          </>
        )}
        <span className="switch-knob" />
      </span>
      {children}
    </label>
  );
}

function LockIcon({ testId }: { testId: string }) {
  return (
    <span className="lock-icon" data-testid={`lock-icon-${testId}`} aria-hidden="true">
      <span className="lock-icon-shackle" />
      <span className="lock-icon-body" />
    </span>
  );
}

function LockToggle({
  testId,
  label,
  checked,
  disabled,
  onChange,
}: {
  testId: string;
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <Switch
      testId={`lock-${testId}`}
      ariaLabel={`Lock ${label}`}
      checked={checked}
      disabled={disabled}
      title={
        checked
          ? `Locked -- click to let ${label} be solved`
          : disabled
            ? "Two dimensions are already locked -- something has to stay free to fit the cable length"
            : `Free -- click to lock ${label}`
      }
      onChange={onChange}
      showState={false}
    />
  );
}

export const LOCK_LIMIT_NOTE = "Two of core size, height and layers are already locked -- something has to stay free to fit the cable length.";

export function LockRangeField({
  testId,
  label,
  unit,
  lock,
  min,
  max,
  step,
  freeValue,
  hint,
  minNote,
  lockDisabled,
  normalize = roundMm,
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
  hint?: string;
  minNote?: string;
  lockDisabled?: boolean;
  normalize?: (value: number) => number;
  onChange: (lock: Lock<number>) => void;
}) {
  const clampToMin = (value: number) => Math.max(min, normalize(value));
  const displayValue = lock.locked ? clampToMin(lock.value) : normalize(freeValue);
  const toggle = (checked: boolean) => onChange(checked ? { locked: true, value: displayValue } : { locked: false });
  const setValue = (value: number) => {
    if (lock.locked) onChange({ locked: true, value: clampToMin(value) });
  };
  const showLockNote = !lock.locked && lockDisabled;
  return (
    <>
      <RangeField
        testId={testId}
        label={label}
        unit={unit}
        value={displayValue}
        min={min}
        max={max}
        step={step}
        disabled={!lock.locked}
        leading={<LockToggle testId={testId} label={label} checked={lock.locked} disabled={showLockNote} onChange={toggle} />}
        valuePrefix={lock.locked ? <LockIcon testId={testId} /> : undefined}
        hint={hint}
        minNote={minNote}
        onChange={setValue}
      />
      {showLockNote && (
        <p className="field-note" data-testid={`${testId}-lock-note`}>
          {LOCK_LIMIT_NOTE}
        </p>
      )}
    </>
  );
}

export function EyeToggle({
  testId,
  label,
  checked,
  hint,
  title,
  onChange,
}: {
  testId: string;
  label: string;
  checked: boolean;
  hint?: string;
  title?: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <span className="eye-toggle-row">
      <Switch
        testId={`toggle-${testId}`}
        ariaLabel={label}
        checked={checked}
        title={title ?? (checked ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`)}
        onChange={onChange}
      >
        <span className="eye-toggle-text">{label}</span>
      </Switch>
      {hint && <Hint text={hint} />}
    </span>
  );
}

export function TwoSidedToggle({
  testId,
  leftLabel,
  rightLabel,
  ariaLabel,
  checked,
  hint,
  title,
  onChange,
}: {
  testId: string;
  leftLabel: string;
  rightLabel: string;
  ariaLabel: string;
  checked: boolean;
  hint?: string;
  title?: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <span className="two-sided-toggle-row">
      <span className={`two-sided-toggle-text${checked ? "" : " two-sided-toggle-text-active"}`}>{leftLabel}</span>
      <Switch testId={`toggle-${testId}`} ariaLabel={ariaLabel} checked={checked} title={title} onChange={onChange} showState={false} />
      <span className={`two-sided-toggle-text${checked ? " two-sided-toggle-text-active" : ""}`}>{rightLabel}</span>
      {hint && <Hint text={hint} />}
    </span>
  );
}
