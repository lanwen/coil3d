import { TwoSidedToggle } from "../components/fields";
import { HINTS } from "../components/hints";
import { VIEW_PRESETS, type PresetId } from "./lineArt/presets";
import { PresetIcon } from "./presetIcons";
import type { Projection } from "./lineArt/LineArtRenderer";

export interface ViewControlsProps {
  preset: PresetId;
  onPresetChange: (preset: PresetId) => void;
  /** Issue #106: offer the "Mount side" preset (only while the design has SKÅDIS clips to show). */
  showMountSide?: boolean;
}

/**
 * Camera-view overlay controls: the preset-view buttons -- Front, Iso and
 * Wall mount (issue #49 trimmed the original issue #15 bar of front/side/
 * top/iso down to just these, folding in the wall-mount preset that used to
 * live behind a separate toggle button), plus Mount side (#106) and Print
 * layout (#78). Purely a view concern: LineArtRenderer owns the actual
 * camera math this drives (see its `preset` prop); CoilViewer owns the
 * wall-mount geometry rotation the "Wall mount" preset also triggers (see
 * its `handlePresetChange`).
 *
 * Issue #141: the preset buttons sit in their own borderless bar at the top
 * centre of the viewport (bottom centre when the viewport is too narrow --
 * see App.css's `.preset-bar`), each with a line-art pictogram of that view
 * (presetIcons.tsx), a Switch-style black pill behind the active one and a
 * visible label on hover/focus. It keeps the shared `view-controls` class
 * (like {@link ProjectionToggle}), so e2e's overlay-avoidance checks treat
 * both alike.
 */
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

/**
 * The perspective/isometric toggle (internally still the `ortho`/
 * `perspective` `Projection` type -- this app only ever frames the
 * orthographic camera from the Iso preset's angle, which is what makes
 * calling it "isometric" in the UI accurate): a {@link TwoSidedToggle}
 * (issue #94: built on the one shared pill switch, checked = perspective;
 * issue #104: labelled "Isometric"/"Perspective" on either side of the
 * track, since it switches between two named modes).
 *
 * Issue #145: rendered by App next to the other viewport toggles (it used
 * to live inside CoilViewer), so on a phone all four can move out of the
 * canvas into one strip under it; on desktop it still sits top right.
 */
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
