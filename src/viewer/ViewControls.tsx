import { TwoSidedToggle } from "../components/fields";
import { HINTS } from "../components/hints";
import { VIEW_PRESETS, type BarPresetId, type FaceId } from "./lineArt/presets";
import { PresetIcon } from "./presetIcons";
import type { Projection } from "./lineArt/LineArtRenderer";

interface ViewControlsProps {
  preset: BarPresetId;
  onPresetChange: (preset: BarPresetId) => void;
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

const FACE_LABELS: Record<FaceId, string> = { cap: "Cap", base: "Base" };

export function FaceToggle({ faces, face, onFaceChange }: { faces: FaceId[]; face: FaceId; onFaceChange: (face: FaceId) => void }) {
  return (
    <div className="view-controls preset-bar face-toggle" role="group" aria-label="Face to customize">
      {faces.map((id) => (
        <button
          key={id}
          type="button"
          className={`preset-btn face-btn${face === id ? " active" : ""}`}
          data-testid={`customize-face-${id}`}
          aria-pressed={face === id}
          onClick={() => onFaceChange(id)}
        >
          {FACE_LABELS[id]}
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
