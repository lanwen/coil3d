import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

export function Hint({ text }: { text: string }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [tapped, setTapped] = useState(false);
  const open = hovered || focused || tapped;
  const bubbleId = useId();
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const bubbleRef = useRef<HTMLSpanElement | null>(null);
  const [alignEnd, setAlignEnd] = useState(false);
  useLayoutEffect(() => {
    const bubble = bubbleRef.current;
    if (!open || !bubble) return;
    bubble.removeAttribute("data-align");
    const overflows = bubble.getBoundingClientRect().right > document.documentElement.clientWidth - 4;
    if (overflows) bubble.setAttribute("data-align", "end");
    setAlignEnd(overflows);
  }, [open]);

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
      <span
        ref={bubbleRef}
        id={bubbleId}
        role="tooltip"
        className="hint-bubble"
        data-testid="hint-bubble"
        data-open={open || undefined}
        data-align={open && alignEnd ? "end" : undefined}
      >
        {text}
      </span>
    </span>
  );
}
