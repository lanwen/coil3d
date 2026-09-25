import { useEffect, useId, useRef, useState } from "react";

/**
 * The (i) hint button next to a control (issue #53): a short, plain-English
 * explanation of what the setting does. Opens on hover/focus (desktop) and
 * on tap (touch); Esc closes it and returns focus to the button. The bubble
 * is always in the DOM (never `display:none`), just visually collapsed when
 * closed (see `.hint-bubble` in App.css), so `aria-describedby` keeps
 * pointing at real, readable content for assistive tech rather than a
 * hidden node.
 *
 * Open state is tracked as three independent reasons -- `hovered`,
 * `focused`, `tapped` -- rather than one toggle. A tap/click is itself
 * SYNTHESISED as a mouseenter+click pair by every browser (touch or mouse),
 * so a plain toggle on click would immediately flip back to closed (the
 * preceding synthetic mouseenter having already opened it). Tracking tap as
 * its own reason sidesteps that race: hovering away (`mouseleave`) only
 * clears the hover reason, so a tap-opened hint stays open until Esc, a
 * blur, or another tap closes it.
 *
 * Rendered as a sibling of the field's own label/control -- never nested
 * inside another `<label>` -- so tapping it can never also toggle/focus an
 * unrelated control; `onClick`'s `stopPropagation` is a second, defensive
 * guard against that for any caller that does nest it.
 */
export function Hint({ text }: { text: string }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [tapped, setTapped] = useState(false);
  const open = hovered || focused || tapped;
  const bubbleId = useId();
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setHovered(false);
      setFocused(false);
      setTapped(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <span className="hint">
      <button
        ref={buttonRef}
        type="button"
        className="hint-btn"
        data-testid="hint-btn"
        aria-label="What does this setting do?"
        aria-describedby={bubbleId}
        aria-expanded={open}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onClick={(event) => {
          event.stopPropagation();
          setTapped((was) => !was);
        }}
      >
        i
      </button>
      <span id={bubbleId} role="tooltip" className="hint-bubble" data-testid="hint-bubble" data-open={open || undefined}>
        {text}
      </span>
    </span>
  );
}
