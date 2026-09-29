import { EyeToggle } from "../components/fields";
import { HINTS } from "../components/hints";
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
 * live behind a separate toggle button) -- and a perspective/isometric
 * toggle (internally still the `ortho`/`perspective` `Projection` type --
 * this app only ever frames the orthographic camera from the Iso preset's
 * angle, which is what makes calling it "isometric" in the UI accurate),
 * the latter a boxed, labelled {@link EyeToggle} (issue #94: every boolean
 * toggle in the app, this one included, is now that one shared pill switch
 * -- checked = perspective, unchecked = isometric -- rather than its own
 * converging/parallel-lines pictogram; issue #94 PR review: unlike the bare
 * switch the other two overlay toggles never had, this one needs its own
 * visible label and hint, since nothing else here hints at what a bare
 * switch would even mean). Purely a view concern:
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
      <div className="projection-toggle-box">
        <EyeToggle
          testId="projection"
          label="Perspective"
          checked={projection === "perspective"}
          hint={HINTS.projection}
          title={projection === "ortho" ? "Switch to perspective" : "Switch to isometric"}
          onChange={(checked) => onProjectionChange(checked ? "perspective" : "ortho")}
        />
      </div>
    </div>
  );
}
