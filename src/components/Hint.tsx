import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

export function Hint({ text }: { text: string }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [tapped, setTapped] = useState(false);
  const open = hovered || focused || tapped;
  const bubbleId = useId();
  const rootRef = useRef<HTMLSpanElement | null>(null);
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
    const close = () => {
      setHovered(false);
      setFocused(false);
      setTapped(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      buttonRef.current?.focus();
      close();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  return (
    <span ref={rootRef} className="hint">
      <button
        ref={buttonRef}
        type="button"
        className="hint-btn"
        data-testid="hint-btn"
        aria-label="What does this setting do?"
        aria-describedby={bubbleId}
        aria-expanded={open}
        onPointerEnter={(event) => setHovered(event.pointerType === "mouse")}
        onPointerLeave={() => setHovered(false)}
        onFocus={(event) => setFocused(event.currentTarget.matches(":focus-visible"))}
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
