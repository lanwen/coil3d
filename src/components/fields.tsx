import { useId } from "react";
import type { ChangeEvent, ReactNode } from "react";
import type { Lock } from "../core";
import { Hint } from "./Hint";

/** Core size/height rounding (issue #72 AC: "sliders step 1 mm; the
 * displayed solver values are rounded to 1 mm (0.5 mm if needed for small
 * coils)"; supersedes issue #16's own, finer-grained `round1`, which this
 * replaces -- these two fields were its only callers). Whole millimetres are
 * already coarse relative to the 5-500mm (core size) / 1-400mm (height)
 * range these two fields cover, EXCEPT down near the solver's own
 * small-coil floor (`SIZE_LO_FLOOR` = 5mm): a size that small can
 * meaningfully differ from its neighbour by well under 1mm, so a value
 * below `SMALL_COIL_MM` rounds to the nearest 0.5mm instead. Used for BOTH
 * the displayed free (solver-produced) value and whatever the user types
 * into the paired number input -- `LockRangeField` is only ever used for
 * these two fields, so this is safe to bake in here rather than at each
 * call site. */
const SMALL_COIL_MM = 20;
export function roundMm(value: number): number {
  const step = value < SMALL_COIL_MM ? 0.5 : 1;
  return Math.round(value / step) * step;
}

/**
 * Cable length is entered and shown in centimetres (issue #51); `CoilSpec`
 * itself keeps it in millimetres exactly like every other dimension -- the
 * core, the hash and the solver never see a unit change. This is a pure
 * UI-layer conversion, shared by the length input (ControlsForm) and every
 * result row that reports a wound-cable length (ResultPanel), so both sides
 * of that seam agree on the same unit.
 */
export const MM_PER_CM = 10;
export const mmToCm = (mm: number) => mm / MM_PER_CM;
export const cmToMm = (cm: number) => cm * MM_PER_CM;

/**
 * A field's own label, plus an optional (i) hint button (issue #53) shown
 * right after it -- never overlapping the value, which sits in its own
 * column to the right of this row. `htmlFor` links the label text to its
 * control the normal way (a real `<label for>`, not a wrapping `<label>`),
 * which keeps the hint button a plain sibling rather than nested inside a
 * label that would also forward clicks to an unrelated control.
 */
export function FieldTop({
  label,
  hint,
  htmlFor,
  labelId,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  /** An id on just the label text itself (not the hint) -- for a caller
   * that needs to name something ELSE by this label (e.g. `ShapePicker`'s
   * `role="radiogroup"` via `aria-labelledby`), so that name is exactly the
   * label text, never polluted by the hint button's own accessible name or
   * its (always-mounted) tooltip text. */
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
 *
 * Issue #105 AC #1: a `disabled` field (a locked/free dimension currently
 * left free, so the solver -- not the user -- sets it) hides the slider
 * entirely rather than showing an inert one; the number input alone (itself
 * `:disabled`, so it reads as plainly non-interactive) is "only the value,
 * read-only". A locked field keeps the slider, exactly as before.
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
  /** Plain-English explanation shown by an (i) button next to the label (issue #53). */
  hint,
  /** A short plain-English note about this field's own floor (issue #105 AC
   * #4: the corner radius's bend-limit minimum) shown right under the
   * slider -- omitted when there's nothing special to say about `min`. */
  minNote,
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
          <input
            id={numberId}
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
      {!disabled && (
        <input
          type="range"
          className="field-slider"
          aria-label={label}
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={handleRange}
        />
      )}
      {minNote && (
        <p className="field-note" data-testid={`${testId}-min-note`}>
          {minNote}
        </p>
      )}
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

/** A +/- stepper paired with a number input, for small integer counts (layers). */
export function StepperField({
  testId,
  label,
  value,
  min,
  max,
  disabled,
  leading,
  hint,
  onChange,
}: {
  testId: string;
  label: string;
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  leading?: ReactNode;
  hint?: string;
  onChange: (value: number) => void;
}) {
  const numberId = useId();
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
          <FieldTop label={label} hint={hint} htmlFor={numberId} />
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
          id={numberId}
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
 * The one shared boolean toggle for the whole app (issue #94): a real
 * checkbox (so Playwright's check()/uncheck()/toBeChecked() keep working
 * unchanged, and keyboard Space/Enter work for free) wearing `role="switch"`
 * plus an explicit `aria-checked` -- overriding the implicit checkbox role,
 * since this reads to assistive tech as an on/off switch, not a checkbox in
 * a list. Painted as a black/white pill: an outlined track plus a round
 * knob that slides between the two ends and carries the state's own digit
 * ("0"/"1") printed on itself in whichever ink is legible against its own
 * fill -- so the digit is never printed on the track, where it would be
 * covered by the very knob sliding over it (issue #94: "the knob slides...
 * showing '0' on the off side and '1' on the on side"). Off = white track,
 * black outline, black knob at the left carrying a white "0"; on = black
 * track, white knob at the right carrying a black "1". Replaces the old
 * per-purpose eye/padlock/projection pictograms (issue #16/#15): every
 * boolean toggle in the app now shares this one component, with only its
 * accessible name and any trailing label/glyph differing per call site.
 *
 * The input's hit target is deliberately oversized past the visible pill
 * (`.switch-input`'s negative `inset` in App.css) -- comfortably >= 44px on
 * mobile widths -- rather than growing the pill itself to a clumsy size.
 * The knob's slide is a plain CSS transition, skipped under
 * `prefers-reduced-motion: reduce` (App.css) so it's instant there instead
 * of animated, matching every other transition in the app.
 */
export function Switch({
  testId,
  ariaLabel,
  checked,
  title,
  onChange,
  children,
}: {
  testId: string;
  ariaLabel: string;
  checked: boolean;
  title?: string;
  onChange: (checked: boolean) => void;
  /** Optional trailing content (a text label, a decorative glyph) rendered
   * inside the same `<label>` as the input, so clicking it toggles the
   * switch too -- exactly like the pill itself. */
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
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="switch-track" aria-hidden="true">
        <span className="switch-knob">{checked ? "1" : "0"}</span>
      </span>
      {children}
    </label>
  );
}

/**
 * The lock toggle: {@link Switch} plus a small static padlock glyph beside
 * it (issue #94 AC: "the label 'Lock' (or a small padlock glyph beside the
 * switch)") -- the glyph is purely decorative context (the switch's own 0/1
 * already carries the actual state), so it never reflects locked/free
 * itself. Rendered as a `leading` element inline on the field's own label
 * row (issue #16 review: a lock on a row of its own, above the field, left
 * it ambiguous which field it controlled), with an explicit "Lock {label}"
 * accessible name since the visible row carries the switch and glyph only,
 * no text.
 */
function LockToggle({ testId, label, checked, onChange }: { testId: string; label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <Switch
      testId={`lock-${testId}`}
      ariaLabel={`Lock ${label}`}
      checked={checked}
      title={checked ? `Locked -- click to let ${label} be solved` : `Free -- click to lock ${label}`}
      onChange={onChange}
    >
      <span className="lock-glyph" aria-hidden="true">
        <span className="lock-glyph-shackle" />
        <span className="lock-glyph-body" />
      </span>
    </Switch>
  );
}

/** A lockable numeric range field: pairs {@link LockToggle} with {@link RangeField}. */
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
  onChange: (lock: Lock<number>) => void;
}) {
  // Issue #72 AC: "the spec stores rounded values when the user edits" --
  // `setValue` rounds here (not just the free-value display below) so a
  // value typed into the paired number input (which, unlike the slider,
  // isn't clamped to `step` by the browser) can never push a long decimal
  // into the spec.
  const toggle = (checked: boolean) => onChange(checked ? { locked: true, value: lock.locked ? lock.value : roundMm(freeValue) } : { locked: false });
  const setValue = (value: number) => {
    if (lock.locked) onChange({ locked: true, value: roundMm(value) });
  };
  return (
    <RangeField
      testId={testId}
      label={label}
      unit={unit}
      value={lock.locked ? lock.value : roundMm(freeValue)}
      min={min}
      max={max}
      step={step}
      disabled={!lock.locked}
      leading={<LockToggle testId={testId} label={label} checked={lock.locked} onChange={toggle} />}
      hint={hint}
      onChange={setValue}
    />
  );
}

/** A lockable integer stepper field: pairs {@link LockToggle} with {@link StepperField}. */
export function LockStepperField({
  testId,
  label,
  lock,
  min,
  max,
  freeValue,
  hint,
  onChange,
}: {
  testId: string;
  label: string;
  lock: Lock<number>;
  min: number;
  max: number;
  freeValue: number;
  hint?: string;
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
      leading={<LockToggle testId={testId} label={label} checked={lock.locked} onChange={toggle} />}
      hint={hint}
      onChange={setValue}
    />
  );
}

/**
 * A view-only toggle over the viewer (e.g. "show wound cable"/"Dimensions"/
 * "Exploded view", and the camera's perspective/orthographic mode):
 * {@link Switch} plus its own trailing text label -- replaces the old eye/
 * crossed-out-eye pictogram (issue #16 review; issue #94 folded it, and
 * every other overlay pictogram, into the one shared switch).
 */
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
  /** Overrides the default "Show X"/"Hide X" tooltip -- for a call site
   * that isn't a plain visibility toggle (issue #94 review: the
   * perspective/orthographic toggle is a MODE switch, not a show/hide one,
   * so "Hide perspective" would read wrong). */
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
