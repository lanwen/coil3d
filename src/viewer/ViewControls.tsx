import { TwoSidedToggle } from "../components/fields";
import { HINTS } from "../components/hints";
import { VIEW_PRESETS, type PresetId } from "./lineArt/presets";
import { PresetIcon } from "./presetIcons";
import type { Projection } from "./lineArt/LineArtRenderer";

export interface ViewControlsProps {
  preset: PresetId;
  onPresetChange: (preset: PresetId) => void;
  showMountSide?: boolean;
}

export function ViewControls({ preset, onPresetChange, showMountSide = false }: ViewControlsProps) {
  return (
    <div className="view-controls preset-bar" role="group" aria-label="Camera view">
      {VIEW_PRESETS.filter((p) => p.id !== "mountSide" || showMountSide).map((p) => (
        <button
          key={p.id}
          type="button"
          className={`preset-btn preset-btn-${p.id}${preset === p.id ? " active" : ""}`}
          data-testid={`preset-${p.id}`}
          aria-pressed={preset === p.id}
          aria-label={`${p.label} view`}
          onClick={() => onPresetChange(p.id)}
        >
          <PresetIcon id={p.id} />
          <span className="preset-tip" aria-hidden="true">
            {p.label}
          </span>
        </button>
      ))}
    </div>
  );
}

export function ProjectionToggle({ projection, onProjectionChange }: { projection: Projection; onProjectionChange: (projection: Projection) => void }) {
  return (
    <div className="view-controls projection-toggle-box">
      <TwoSidedToggle
        testId="projection"
        leftLabel="Isometric"
        rightLabel="Perspective"
        ariaLabel="Isometric / Perspective"
        checked={projection === "perspective"}
        hint={HINTS.projection}
        title={projection === "ortho" ? "Switch to perspective" : "Switch to isometric"}
        onChange={(checked) => onProjectionChange(checked ? "perspective" : "ortho")}
      />
    </div>
  );
}
