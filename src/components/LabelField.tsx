import { useEffect, useRef, useState } from "react";
import type { CoilSpec, Design } from "../core";
import { LABEL_MAX_LENGTH } from "../core";
import { TextField } from "./fields";

const geometryKey = (spec: CoilSpec) => JSON.stringify({ ...spec, label: undefined });

export function LabelField({ spec, design, finalReady, onChange }: { spec: CoilSpec; design?: Design | null; finalReady?: boolean; onChange: (next: CoilSpec) => void }) {
  const value = spec.label ?? "";
  const lastInsert = useRef<{ text: string; geometry: string } | null>(null);
  const [full, setFull] = useState(false);

  useEffect(() => {
    const insert = lastInsert.current;
    if (!insert || !design || !finalReady) return;
    if (design.spec.label !== insert.text || geometryKey(design.spec) !== insert.geometry || spec.label !== insert.text || geometryKey(spec) !== insert.geometry) return;
    lastInsert.current = null;
    const maxChars = design.labelFit?.maxChars;
    if (maxChars !== undefined && maxChars < insert.text.length) {
      setFull(true);
      onChange({ ...spec, label: insert.text.slice(0, maxChars) });
    } else {
      setFull(false);
    }
  }, [design, finalReady, spec, onChange]);

  const handleChange = (text: string) => {
    if (text.length > value.length) lastInsert.current = { text, geometry: geometryKey(spec) };
    else {
      lastInsert.current = null;
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
