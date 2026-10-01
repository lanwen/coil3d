import { useEffect, useRef, useState } from "react";
import type { CoilSpec, Design } from "../core";
import { LABEL_MAX_LENGTH } from "../core";
import { TextField } from "./fields";

// Everything in the spec except the label: a typed character is only judged
// against the geometry it was typed under.
const withoutLabel = (spec: CoilSpec) => JSON.stringify({ ...spec, label: undefined });

/**
 * The label text input. The cap decides how much text fits: when the user
 * INSERTS characters (typing or pasting) and the final design for that exact
 * text says only `maxChars` of them fit, the text is cut back to `maxChars`
 * and a note says so. Text that stops fitting because the coil changed, or
 * that arrived from the URL, is never cut -- the design's "doesn't fit"
 * warning covers it.
 */
export function LabelField({ spec, design, finalReady, onChange }: { spec: CoilSpec; design?: Design | null; finalReady?: boolean; onChange: (next: CoilSpec) => void }) {
  const value = spec.label ?? "";
  // The text the user last inserted, and the geometry it was typed under.
  const pending = useRef<{ text: string; rest: string } | null>(null);
  const [full, setFull] = useState(false);

  useEffect(() => {
    const p = pending.current;
    if (!p || !design || !finalReady) return;
    // Only the FINAL design for this exact text and geometry may decide.
    if (design.spec.label !== p.text || withoutLabel(design.spec) !== p.rest || spec.label !== p.text || withoutLabel(spec) !== p.rest) return;
    pending.current = null;
    const maxChars = design.labelFit?.maxChars;
    if (maxChars !== undefined && maxChars < p.text.length) {
      setFull(true);
      onChange({ ...spec, label: p.text.slice(0, maxChars) });
    } else {
      setFull(false);
    }
  }, [design, finalReady, spec, onChange]);

  const handleChange = (text: string) => {
    if (text.length > value.length) pending.current = { text, rest: withoutLabel(spec) };
    else {
      pending.current = null;
      setFull(false);
    }
    onChange({ ...spec, label: text });
  };

  return (
    <>
      <TextField testId="label" label="Label text" placeholder="e.g. USB-C 2m" maxLength={LABEL_MAX_LENGTH} value={value} onChange={handleChange} />
      {full && (
        <p className="field-note" role="status" data-testid="label-full-note">
          Label is full for this cap size.
        </p>
      )}
    </>
  );
}
