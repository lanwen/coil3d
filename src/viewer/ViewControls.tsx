import { Switch } from "../components/fields";
import { VIEW_PRESETS, type PresetId } from "./lineArt/presets";
import type { Projection } from "./lineArt/LineArtRenderer";

export interface ViewControlsProps {
  preset: PresetId;
  onPresetChange: (preset: PresetId) => void;
  projection: Projection;
  onProjectionChange: (projection: Projection) => void;
}

/**
 * Camera-view overlay controls: three preset-view buttons -- Front, Iso and
 * Wall mount (issue #49 trimmed the original issue #15 bar of front/side/
 * top/iso down to just these, folding in the wall-mount preset that used to
 * live behind a separate toggle button) -- and a perspective/orthographic
 * toggle, the latter the shared {@link Switch} (issue #94: every boolean
 * toggle in the app, this one included, is now that one pill component --
 * checked = perspective, unchecked = orthographic -- rather than its own
 * converging/parallel-lines pictogram). Purely a view concern:
 * LineArtRenderer owns the actual camera math this drives (see its
 * `preset`/`projection` props); CoilViewer owns the wall-mount geometry
 * rotation the "Wall mount" preset also triggers (see its `handlePresetChange`).
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
      <Switch
        testId="toggle-projection"
        ariaLabel="Perspective projection"
        checked={projection === "perspective"}
        title={projection === "ortho" ? "Switch to perspective" : "Switch to orthographic"}
        onChange={(checked) => onProjectionChange(checked ? "perspective" : "ortho")}
      />
    </div>
  );
}
