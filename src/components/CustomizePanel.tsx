import { useEffect, useRef } from "react";
import type { CoilSpec, Design } from "../core";
import type { FaceId } from "../viewer/lineArt/presets";
import { FieldTop, Section, Switch } from "./fields";
import { HINTS } from "./hints";
import { LabelField } from "./LabelField";

const FACE_TITLES: Record<FaceId, string> = { cap: "Top cap", base: "Base" };

export function CustomizePanel({
  spec,
  design,
  finalReady,
  face,
  onChange,
  onSave,
  onCancel,
}: {
  spec: CoilSpec;
  design?: Design | null;
  finalReady: boolean;
  face: FaceId;
  onChange: (next: CoilSpec) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const labelEnabled = spec.label !== undefined;
  const setLabelEnabled = (checked: boolean) => onChange({ ...spec, label: checked ? (spec.label ?? "") : undefined });
  const panelRef = useRef<HTMLFormElement>(null);
  useEffect(() => panelRef.current?.focus(), []);
  const problems = design?.notices.filter((n) => n.severity === "problem") ?? [];

  return (
    <form ref={panelRef} tabIndex={-1} className="controls customize-panel" data-testid="customize-panel" data-face={face} data-final-ready={finalReady} onSubmit={(e) => e.preventDefault()}>
      <Section title={`Customize the ${FACE_TITLES[face].toLowerCase()}`}>
        {face === "cap" && (
          <>
            <div className="field">
              <div className="field-top">
                <FieldTop label="Label (engraved on the top cap)" hint={HINTS.label} />
                <Switch testId="label-enabled" ariaLabel="Engrave a label on the top cap" checked={labelEnabled} onChange={setLabelEnabled} />
              </div>
            </div>
            {labelEnabled && <LabelField spec={spec} design={design} finalReady={finalReady} onChange={onChange} />}
          </>
        )}
        <div className="field">
          <div className="field-top">
            <FieldTop label="Strap slots" hint={HINTS.strapSlots} />
            <Switch testId="strap-slots" ariaLabel="Strap slots" checked={spec.strapSlots ?? false} onChange={(on) => onChange({ ...spec, strapSlots: on })} />
          </div>
          <p className="field-note" data-testid="strap-slots-scope">
            One setting for the cap and the base.
          </p>
          {spec.strapSlots && design?.strapSlotsNote && (
            <p className="field-note" data-testid="strap-slots-note">
              {design.strapSlotsNote}
            </p>
          )}
        </div>
      </Section>
      {problems.length > 0 && (
        <ul className="problems" data-testid="problems">
          {problems.map((n) => (
            <li key={n.message}>{n.message}</li>
          ))}
        </ul>
      )}
      <div className="customize-actions">
        <button type="button" className="btn-primary btn-secondary" data-testid="customize-cancel" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn-primary" data-testid="customize-save" onClick={onSave}>
          Save
        </button>
      </div>
    </form>
  );
}
