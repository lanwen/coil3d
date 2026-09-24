import { VIEW_PRESETS, type PresetId } from "./lineArt/presets";
import type { Projection } from "./lineArt/LineArtRenderer";

export interface ViewControlsProps {
  preset: PresetId;
  onPresetChange: (preset: PresetId) => void;
  projection: Projection;
  onProjectionChange: (projection: Projection) => void;
}

/**
 * Camera-view overlay controls (issue #15): four preset-view buttons (front/
 * side/top/iso) and a perspective/orthographic toggle, styled the same way
 * as the existing eye/lock toggles (fields.tsx) -- real, keyboard-usable
 * controls behind black/white pictograms, never a raw checkbox or a plain
 * text button. Purely a view concern: LineArtRenderer owns the actual
 * camera math this drives (see its `preset`/`projection` props).
 */
export function ViewControls({ preset, onPresetChange, projection, onProjectionChange }: ViewControlsProps) {
  return (
    <div className="view-controls">
      <div className="preset-group" role="group" aria-label="Camera view">
        {VIEW_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`preset-btn preset-btn-${p.id}${preset === p.id ? " active" : ""}`}
            data-testid={`preset-${p.id}`}
            aria-pressed={preset === p.id}
            title={`${p.label} view`}
            onClick={() => onPresetChange(p.id)}
          >
            <span className={`preset-icon preset-icon-${p.id}`} aria-hidden="true" />
          </button>
        ))}
      </div>
      <label className="projection-toggle" title={projection === "ortho" ? "Switch to perspective" : "Switch to orthographic"}>
        <input
          type="checkbox"
          className="projection-toggle-input"
          data-testid="toggle-projection"
          checked={projection === "perspective"}
          onChange={(e) => onProjectionChange(e.target.checked ? "perspective" : "ortho")}
        />
        <span className="projection-icon" aria-hidden="true">
          <span className="projection-icon-ortho" />
          <span className="projection-icon-persp" />
        </span>
      </label>
    </div>
  );
}
