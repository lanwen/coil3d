import { TwoSidedToggle } from "../components/fields";
import { HINTS } from "../components/hints";
import { VIEW_PRESETS, type PresetId } from "./lineArt/presets";
import { PresetIcon } from "./presetIcons";
import type { Projection } from "./lineArt/LineArtRenderer";

export interface ViewControlsProps {
  preset: PresetId;
  onPresetChange: (preset: PresetId) => void;
  projection: Projection;
  onProjectionChange: (projection: Projection) => void;
  /** Issue #106: offer the "Mount side" preset (only while the design has a SKÅDIS clip plate to show). */
  showMountSide?: boolean;
}

/**
 * Camera-view overlay controls: three preset-view buttons -- Front, Iso and
 * Wall mount (issue #49 trimmed the original issue #15 bar of front/side/
 * top/iso down to just these, folding in the wall-mount preset that used to
 * live behind a separate toggle button) -- and a perspective/isometric
 * toggle (internally still the `ortho`/`perspective` `Projection` type --
 * this app only ever frames the orthographic camera from the Iso preset's
 * angle, which is what makes calling it "isometric" in the UI accurate),
 * the latter a boxed {@link TwoSidedToggle} (issue #94: every boolean toggle
 * in the app, this one included, is built on the one shared pill switch --
 * checked = perspective, unchecked = isometric -- rather than its own
 * converging/parallel-lines pictogram; issue #104: promoted from a plain
 * {@link EyeToggle} labelled just "Perspective" to a two-sided toggle
 * labelled "Isometric"/"Perspective" on either side of the track, since this
 * switches between two named modes rather than showing/hiding something,
 * and reviewers found the single trailing label didn't say what the OFF
 * state even was). Purely a view concern:
 * LineArtRenderer owns the actual camera math this drives (see its
 * `preset`/`projection` props); CoilViewer owns the wall-mount geometry
 * rotation the "Wall mount" preset also triggers (see its `handlePresetChange`).
 *
 * Issue #141: the preset buttons moved out of the old outlined box next to
 * the projection switch into their own borderless bar at the top centre of
 * the viewport (bottom centre when the viewport is too narrow -- see
 * App.css's `.preset-bar`), each with a line-art pictogram of that view
 * (presetIcons.tsx), a Switch-style black pill behind the active one and a
 * visible label on hover/focus. Both groups keep the shared `view-controls`
 * class, so e2e's overlay-avoidance checks treat them alike.
 */
export function ViewControls({ preset, onPresetChange, projection, onProjectionChange, showMountSide = false }: ViewControlsProps) {
  return (
    <>
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
    </>
  );
}
