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
 *
 * Issue #140: `keepSliderWhenDisabled` opts a caller out of that hide
 * behaviour instead -- the slider stays visible but greyed out and
 * unmovable (a native `:disabled` range input), for a field that's always
 * manually editable in principle but currently has no useful range to move
 * across at all (the corner radius, when the current core size leaves no
 * room between its bend-limit floor and its useful max).
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
  /** Issue #140: when `disabled` is set, keep the slider itself in the DOM
   * (greyed out via the native `:disabled` style, `.field-slider:disabled`
   * in App.css) instead of the default "hide it entirely" behaviour above.
   * Opt-in, and independent of `disabled` itself, so the free/locked
   * dimension fields (`LockRangeField`, issue #105 AC #1) keep their
   * existing hide-the-slider behaviour unchanged -- only a caller that
   * passes this explicitly gets the new "visible but unmovable" treatment
   * (the corner-radius field, when this cable/core leaves no useful range
   * to slide across at all). */
  keepSliderWhenDisabled,
  /** Issue #140: shows the field's own `max` (in `unit`) as a small muted
   * number right under the slider's own right end, e.g. "max 23 mm" -- so a
   * shared slider doesn't grow this label unless a caller opts in. Sits on
   * its own row below the slider (never beside it), which is what keeps the
   * knob's bounding box clear of the label's at every position, including
   * all the way at max: the two never share a row to overlap in. */
  maxLabel,
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
 * The one shared boolean toggle for the whole app (issue #94, revised by
 * #104): a real checkbox (so Playwright's check()/uncheck()/toBeChecked()
 * keep working unchanged, and keyboard Space/Enter work for free) wearing
 * `role="switch"` plus an explicit `aria-checked` -- overriding the
 * implicit checkbox role, since this reads to assistive tech as an on/off
 * switch, not a checkbox in a list. Painted as a black/white pill: an
 * outlined track plus a plain round knob that slides between the two ends,
 * vertically centred in the track at every size (`top: 50%` + `translateY(
 * -50%)`, not a hardcoded pixel inset -- issue #104: an earlier fixed
 * `top: 1px` left it 1px off-centre, since the border-box track's content
 * height doesn't divide evenly by the knob's). The state indicator now
 * lives in the track's own FREE space instead of on the knob (issue #104
 * review of #94: it used to ride the knob itself, which meant restyling it
 * as a plain circle would have lost the indicator entirely, and reviewers
 * found the digit-on-the-knob layout harder to read at a glance than
 * digit-in-the-empty-track): off = white track, black outline, knob at the
 * left, "0" in the free right side; on = black track, white knob at the
 * right, "I" in the free left side. `showState` turns the indicator off
 * entirely (the perspective toggle, whose own two side labels already say
 * what each state means); `offContent`/`onContent` swap the default "0"/"I"
 * digits for something else (the lock toggle's open/closed padlock icon).
 * Replaces the old per-purpose eye/padlock/projection pictograms (issue
 * #16/#15): every boolean toggle in the app shares this one component, with
 * only its accessible name, its state content and any trailing label
 * differing per call site.
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
  /** Issue #119: the lock toggle disables itself (rather than disappearing)
   * once two of {core size, height, layers} are already locked -- see
   * `LockToggle` below. */
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  /** False hides the track's state indicator entirely (issue #104: the
   * two-sided perspective toggle, whose own side labels already say what
   * each state means, so a redundant "0"/"I" inside would be noise). */
  showState?: boolean;
  /** Content shown in the track's free space when off/on (issue #104),
   * defaulting to the "0"/"I" state digits. Ignored when `showState` is
   * false. */
  offContent?: ReactNode;
  onContent?: ReactNode;
  /** Optional trailing content (a text label) rendered inside the same
   * `<label>` as the input, so clicking it toggles the switch too --
   * exactly like the pill itself. */
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

/** The lock toggle's open/closed padlock icon (issue #104), rendered inside
 * the switch's own track (via `offContent`/`onContent`) rather than beside
 * it as a separate static glyph -- issue #94's own padlock-beside-the-switch
 * glyph never reflected locked/free itself (redundant with the switch's own
 * digit), which is exactly what #104 asked to fix: replace it with an icon
 * that DOES carry the state, standing in for "0"/"I" the same way the lock
 * toggle already stood in for a plain boolean. Closed = locked (shackle
 * down, over the body); open = free (shackle swung aside). */
function LockIcon({ locked }: { locked: boolean }) {
  return (
    <span className={`lock-icon${locked ? "" : " lock-icon-open"}`} aria-hidden="true">
      <span className="lock-icon-shackle" />
      <span className="lock-icon-body" />
    </span>
  );
}

/**
 * The lock toggle: {@link Switch} with its state indicator replaced by
 * {@link LockIcon} (issue #104) instead of the default "0"/"I" digits.
 * Rendered as a `leading` element inline on the field's own label row
 * (issue #16 review: a lock on a row of its own, above the field, left it
 * ambiguous which field it controlled), with an explicit "Lock {label}"
 * accessible name since the visible row carries only the switch, no text.
 */
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
  /** Issue #119: at most 2 of {core size, height, layers} can be locked at
   * once -- true here means this one is currently FREE and locking it would
   * make a third, so the toggle is disabled (never for an already-locked
   * field, which must always stay free to unlock). */
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
      offContent={<LockIcon locked={false} />}
      onContent={<LockIcon locked={true} />}
    />
  );
}

/** Issue #119: the note shown under a lock toggle disabled by the max-2-locked rule. */
export const LOCK_LIMIT_NOTE = "Two of core size, height and layers are already locked -- something has to stay free to fit the cable length.";

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
  minNote,
  /** Issue #119: disables the lock toggle (this field is currently free, and
   * two others are already locked) and shows {@link LOCK_LIMIT_NOTE} below. */
  lockDisabled,
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
  onChange: (lock: Lock<number>) => void;
}) {
  // Issue #72 AC: "the spec stores rounded values when the user edits" --
  // `setValue` rounds here (not just the free-value display below) so a
  // value typed into the paired number input (which, unlike the slider,
  // isn't clamped to `step` by the browser) can never push a long decimal
  // into the spec.
  //
  // Issue #105 PR review: `Math.max(min, ...)` is the OUTERMOST step in
  // both the display value and every edit path (toggle-on and typed/dragged
  // edits), so the field can never show -- or be pushed to -- a number
  // below `min` (the shape's own bend-limit floor, for the core-size
  // field). This also covers a shared link whose stored value predates this
  // clamp: the field always DISPLAYS the effective (clamped) value, never
  // the raw, too-small stored one, even before the user touches it.
  const displayValue = lock.locked ? Math.max(min, roundMm(lock.value)) : roundMm(freeValue);
  const toggle = (checked: boolean) => onChange(checked ? { locked: true, value: lock.locked ? Math.max(min, roundMm(lock.value)) : roundMm(freeValue) } : { locked: false });
  const setValue = (value: number) => {
    if (lock.locked) onChange({ locked: true, value: Math.max(min, roundMm(value)) });
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

/** A lockable integer stepper field: pairs {@link LockToggle} with {@link StepperField}. */
export function LockStepperField({
  testId,
  label,
  lock,
  min,
  max,
  freeValue,
  hint,
  /** Issue #119: see {@link LockRangeField}'s own `lockDisabled`. */
  lockDisabled,
  onChange,
}: {
  testId: string;
  label: string;
  lock: Lock<number>;
  min: number;
  max: number;
  freeValue: number;
  hint?: string;
  lockDisabled?: boolean;
  onChange: (lock: Lock<number>) => void;
}) {
  const toggle = (checked: boolean) => onChange(checked ? { locked: true, value: lock.locked ? lock.value : freeValue } : { locked: false });
  const setValue = (value: number) => {
    if (lock.locked) onChange({ locked: true, value });
  };
  const showLockNote = !lock.locked && lockDisabled;
  return (
    <>
      <StepperField
        testId={testId}
        label={label}
        value={lock.locked ? lock.value : Math.round(freeValue)}
        min={min}
        max={max}
        disabled={!lock.locked}
        leading={<LockToggle testId={testId} label={label} checked={lock.locked} disabled={showLockNote} onChange={toggle} />}
        hint={hint}
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

/**
 * A view-only toggle over the viewer ("show wound cable"/"Dimensions"/
 * "Exploded view"): {@link Switch} plus its own trailing text label --
 * replaces the old eye/crossed-out-eye pictogram (issue #16 review; issue
 * #94 folded it, and every other overlay pictogram, into the one shared
 * switch). No surrounding border box (issue #104: these sit directly over
 * the 3D canvas, so App.css gives their wrapping element only a subtle
 * translucent backdrop for legibility, not a hard-edged box).
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
  /** Overrides the default "Show X"/"Hide X" tooltip. */
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

/**
 * A two-sided mode switch: {@link Switch} with a plain-language label on
 * BOTH sides of the track instead of a state digit inside it (issue #104:
 * the perspective/isometric toggle used to be a bare {@link EyeToggle}
 * carrying just "Perspective" as its trailing label plus an internal "0"/
 * "I" -- clear enough for a show/hide toggle, but this one switches between
 * two named modes, and reviewers found "Perspective 0/I" didn't say what
 * the OFF state actually was. Flanking the track with both names --
 * `leftLabel` for off, `rightLabel` for on, whichever is currently active
 * shown in ink and the other muted -- says both sides at a glance, so the
 * track itself needs no internal indicator (`showState={false}`).
 */
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
