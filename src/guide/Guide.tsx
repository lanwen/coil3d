// The printable, IKEA-style assembly guide (issue #17). Generated straight
// from the current `Design` (same URL hash the main view solved -- App.tsx
// just swaps which component it renders, see `view=guide`), so a shared
// link opens the exact same guide. Every illustration reuses the interactive
// viewer's own line-art pipeline (`LineArtRenderer`, `presets.ts`, issue #15)
// through `GuideFigure`/`CoilScene` (src/viewer/CoilScene.tsx) -- nothing
// here builds its own render path. Arrows and call-outs are SVG overlays
// positioned from points PROJECTED off the same geometry (src/guide/
// projection.ts, src/guide/overlays.tsx), so they stay attached to the model
// instead of floating at a fixed screen position (issue #17 review).
//
// Steps mirror the ticket's numbered list; each is skipped when it doesn't
// apply to the current design (no top cap -> no "fit the cap"/"secure the
// outer end" steps). The wall-mount step is always shown, but its wording is
// data-driven off `spec.mount` (issue #13's `MountKind`): a real mount gets
// real instructions, "none" (still the only case before #14's clip-plate
// mount ships) gets a generic one. Text is deliberately ONE short line per
// step (issue #17 review: "pictograms carry the meaning") -- the pictogram
// and the illustration's own arrow/call-out do the rest.

import * as THREE from "three";
import type { CoilMesh, Design, JointKind, MountKind, Part } from "../core";
import { GuideFigure } from "../viewer/GuideFigure";
import { EXPLODE_GAP } from "../viewer/CoilScene";
import { partInPrintPose } from "./printOrientation";
import { approxRimPoint, computeGuideFit, explodedParts, meshBounds, partsBounds, projectToFigure } from "./projection";
import { CircleMark, ClickMark, CornerInset, Figure, InsetMark, PolylineArrow, StraightArrow, TwistMark, WallPlane, WallQuad, type Pt } from "./overlays";
import { rotateParts, rotatePoint, wallMountRotation, wallRoomRotation } from "./wallView";
import { ClickIcon, GlueDropIcon, KeyholeIcon, NoPullIcon, NoSupportsIcon, PressIcon, RotateIcon, TwistIcon, WallMountIcon, WindIcon } from "./pictograms";
import "./guide.css";

const PART_LABELS: Record<string, string> = { core: "Core", "top-cap": "Top cap" };

function partLabel(part: Part): string {
  return PART_LABELS[part.name] ?? part.name;
}

function corePart(design: Design): Part {
  return design.parts.find((p) => p.role === "core")!;
}

function capPart(design: Design): Part | undefined {
  return design.parts.find((p) => p.role !== "core");
}

/** The mesh's own X/Y center at a given Z -- a plain bounding-box read (public `CoilMesh` data only), used to anchor an arrow at "the core's top rim, on axis" or "the cap's underside, on axis" without needing any core-internal outline data. */
function centerAtZ(mesh: CoilMesh, z: number): THREE.Vector3 {
  const box = meshBounds(mesh);
  const c = box.getCenter(new THREE.Vector3());
  return new THREE.Vector3(c.x, c.y, z);
}

const JOINT_ICON: Record<JointKind, (props: { label: string }) => React.ReactElement> = {
  press: PressIcon,
  bayonet: TwistIcon,
  snap: ClickIcon,
};

const JOINT_LINE: Record<JointKind, string> = {
  press: "Press the cap down until it seats, then add a dab of glue.",
  bayonet: "Insert, twist to lock, then add a dab of glue.",
  snap: "Press down until the clips click, then add a dab of glue.",
};

function StepCard({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="guide-step" data-testid={`guide-step-${n}`}>
      <div className="guide-step-head">
        <span className="guide-step-number">{n}</span>
        <h2>{title}</h2>
      </div>
      <div className="guide-step-body">{children}</div>
    </section>
  );
}

function Callout({ icons, children }: { icons: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="guide-callout">
      {icons}
      <p>{children}</p>
    </div>
  );
}

function StepPrintParts({ design }: { design: Design }) {
  return (
    <StepCard n={1} title="Print the parts">
      <div className="guide-figure-row">
        {design.parts.map((part) => (
          <figure key={part.name} className="guide-part">
            <Figure parts={[partInPrintPose(part)]} fill={0.9} testId={`guide-print-part-${part.name}`} />
            <figcaption>
              {partLabel(part)} &times;1
            </figcaption>
          </figure>
        ))}
      </div>
      <Callout icons={<NoSupportsIcon label="No supports needed" />}>
        {design.parts.length} part{design.parts.length === 1 ? "" : "s"}, prints upright -- no supports.
      </Callout>
    </StepCard>
  );
}

function StepThreadInnerEnd({ design }: { design: Design }) {
  const core = corePart(design);
  const anchor = approxRimPoint(core.mesh, 0.1, 1);
  return (
    <StepCard n={2} title="Thread the inner cable end">
      <div className="guide-figure-row guide-figure-row--solo">
        <Figure parts={[core]} testId="guide-thread-inner" zoomInsetAt={anchor} />
      </div>
      <Callout icons={<KeyholeIcon label="Thread the cable through the base" />}>Feed the inner end in at the groove's start.</Callout>
    </StepCard>
  );
}

function StepWind({ design }: { design: Design }) {
  const core = corePart(design);
  const { layers } = design.solution;
  const layer0 = design.wirePaths[0];
  return (
    <StepCard n={3} title="Wind the cable">
      <div className="guide-figure-row guide-figure-row--solo">
        <Figure
          parts={[core]}
          wirePaths={design.wirePaths}
          wireDiameter={design.spec.wire.diameter}
          showWire
          testId="guide-wind"
          renderOverlay={
            layer0 && layer0.points.length >= 24 && layer0.turns > 0
              ? (fit) => {
                  const path = layer0.points;
                  const sampleCount = Math.floor(path.length / 3);
                  const samplesPerTurn = (sampleCount - 1) / layer0.turns;
                  // A visible SPIRAL segment (issue #17 review: "follow the
                  // helix direction visibly ... a spiral segment around the
                  // coil, not a sine-like curve across the front"): well
                  // under one turn, but DENSELY sampled (many points, not a
                  // sparse few smoothed together), so the curve genuinely
                  // hugs the coil's own curvature as it wraps, instead of a
                  // few widely-spaced points that a wide multi-turn span
                  // would otherwise stretch into a wandering zigzag.
                  const spanTurns = Math.min(layer0.turns, 0.72);
                  const spanSamples = Math.max(10, Math.round(spanTurns * samplesPerTurn));
                  const startIdx = Math.max(0, Math.floor(sampleCount * 0.08));
                  const endIdx = Math.min(sampleCount - 1, startIdx + spanSamples);
                  const N = 18;
                  const points = Array.from({ length: N + 1 }, (_, i) => {
                    const idx = startIdx + Math.round(((endIdx - startIdx) * i) / N);
                    return projectToFigure(fit, new THREE.Vector3(path[idx * 3], path[idx * 3 + 1], path[idx * 3 + 2]));
                  });
                  return <PolylineArrow points={points} />;
                }
              : undefined
          }
        />
      </div>
      <Callout icons={<WindIcon label="Wind the cable along the groove" />}>
        Wind along the groove -- {layers} layer{layers === 1 ? "" : "s"}.
      </Callout>
    </StepCard>
  );
}

function StepFitCap({ design, n }: { design: Design; n: number }) {
  const core = corePart(design);
  const joint = design.spec.joint;
  const JointIcon = JOINT_ICON[joint];

  const posedForAlign = explodedParts(design.parts, true, EXPLODE_GAP);
  const posedCap = posedForAlign.find((p) => p.role !== "core")!;
  const capBottomExploded = centerAtZ(posedCap.mesh, meshBounds(posedCap.mesh).min.z);
  const coreTop = centerAtZ(core.mesh, meshBounds(core.mesh).max.z);
  const seam = new THREE.Vector3(coreTop.x, coreTop.y, design.solution.height);

  return (
    <StepCard n={n} title="Fit the top cap">
      <div className="guide-figure-row">
        <figure className="guide-part">
          <Figure
            parts={design.parts}
            exploded
            testId="guide-cap-exploded"
            renderOverlay={(fit) => <StraightArrow from={projectToFigure(fit, capBottomExploded)} to={projectToFigure(fit, coreTop)} />}
          />
          <figcaption>Align</figcaption>
        </figure>
        <figure className="guide-part">
          <Figure
            parts={design.parts}
            testId="guide-cap-assembled"
            renderOverlay={(fit) => {
              const at = projectToFigure(fit, seam);
              if (joint === "bayonet") return <TwistMark at={at} r={0.09} />;
              if (joint === "snap") return <ClickMark at={at} r={0.09} />;
              const above = projectToFigure(fit, new THREE.Vector3(seam.x, seam.y, seam.z + Math.max(8, design.solution.height * 0.15)));
              return <StraightArrow from={above} to={at} />;
            }}
          />
          <figcaption>Fit</figcaption>
        </figure>
      </div>
      <Callout icons={[<JointIcon key="joint" label={JOINT_LINE[joint]} />, <GlueDropIcon key="glue" label="Permanent: add glue" />]}>{JOINT_LINE[joint]}</Callout>
    </StepCard>
  );
}

function StepSecureOuterEnd({ design, n }: { design: Design; n: number }) {
  const cap = capPart(design)!;
  const anchor = approxRimPoint(cap.mesh, 0.5, 1);
  return (
    <StepCard n={n} title="Secure the outer end">
      <div className="guide-figure-row guide-figure-row--solo">
        <Figure parts={design.parts} testId="guide-secure-outer" zoomInsetAt={anchor} />
      </div>
      <Callout icons={<KeyholeIcon label="Secure the cable in the cap's rim keyhole" />}>Secure the outer end in the cap's rim keyhole.</Callout>
    </StepCard>
  );
}

/**
 * Data-driven off `spec.mount` (issue #13 landed the "keyhole" case while
 * this ticket was in flight -- `CoilSpec.mount: MountKind` is a real,
 * public core field now, not a guess; issue #14 landed "skadis" the same
 * way, after this ticket shipped). `"none"` falls through to a generic,
 * still-useful instruction rather than an empty step -- exactly the
 * ticket's "render it generically when there's no mount". `"opengrid"` is
 * not reachable from the UI or a shared link (issue #14 PR review round 2:
 * its connector geometry is a placeholder, so the mount is hidden until a
 * real one exists -- see hash.ts/ControlsForm.tsx), so it shares the same
 * generic fallback as "none" rather than getting its own, possibly
 * misleading, line.
 */
function mountLine(mount: MountKind): string {
  switch (mount) {
    case "keyhole":
      return "Hang the keyhole slot on a screw, then slide down to seat.";
    case "skadis":
      return "Glue or snap the mount plate onto the flange, then press its clips onto your SKÅDIS board.";
    // "none" (and "opengrid", not reachable -- see this function's own doc comment).
    default:
      return "Fix the flange to the wall your own way -- mounts are coming soon.";
  }
}

/** No illustrated hung orientation (no mount, or issue #14's SKÅDIS clip-plate mount, which -- unlike the keyhole mount below -- attaches via a separate mount plate rather than rotating the core itself onto the wall) -- the coil stays in its standing pose next to a plain, decorative wall strip (issue #17 review: "for SKÅDIS/none, render generically as before"). `mountLine` still gives SKÅDIS its own accurate instruction text. */
function StepMountGeneric({ design, n }: { design: Design; n: number }) {
  const core = corePart(design);
  const wallAnchor = approxRimPoint(core.mesh, 0.05, -1);
  return (
    <StepCard n={n} title="Mount on the wall">
      <div className="guide-figure-row guide-figure-row--solo">
        <Figure
          parts={design.parts}
          testId="guide-mount"
          renderOverlay={(fit) => {
            const at = projectToFigure(fit, wallAnchor);
            return (
              <>
                <WallPlane />
                <StraightArrow from={{ x: 0.11, y: at.y }} to={at} />
              </>
            );
          }}
        />
      </div>
      <Callout icons={<WallMountIcon label="Mount on the wall" />}>{mountLine(design.spec.mount)}</Callout>
    </StepCard>
  );
}

/**
 * The screw-keyhole mount's REAL hung orientation (issue #17 review: the
 * coil's axis points out of the wall, the bottom flange sits flat against
 * the wall, the top cap faces the room -- docs/research.md, mount.ts's
 * `WALL_UP`). Rotates every part with the SAME matrices `CoilViewer.tsx`
 * uses for its own "wall mount (room side)"/"wall mount (mount side)"
 * presets (src/guide/wallView.ts), so this is the genuine hung pose, not a
 * schematic stand-in.
 *
 * The wall itself is a real, projected `WallQuad`: coplanar with, and
 * parallel to, the flange's own face (constant along the rotated axis),
 * offset SIDEWAYS (along the axis mount.ts calls "left/right between 2
 * slots") so its footprint never overlaps the coil's own silhouette --
 * connected to the flange by an axis-aligned "move onto the wall" arrow, per
 * the review's own ask, rather than attempting a literal behind-the-model
 * plane an SVG overlay can't correctly occlude against the WebGL render
 * beneath it.
 *
 * The inset uses the mount-side face-on rotation to show the flange as the
 * wall would see it. The exact slot count/radius are core internals
 * (mount.ts, "not for UI use"), so the screw mark is a schematic
 * approximation along the real `mountAxisDeg` axis, at a plausible radius
 * inside the flange -- not a precise measurement.
 */
function StepMountKeyhole({ design, n }: { design: Design; n: number }) {
  const core = corePart(design);
  const roomRotation = wallRoomRotation(design.mountAxisDeg);
  const roomParts = rotateParts(design.parts, roomRotation);
  const box = partsBounds(roomParts);
  const center = box.getCenter(new THREE.Vector3());
  const extentY = box.max.y - box.min.y;
  const extentZ = box.max.z - box.min.z;
  const wallSize = Math.max(extentY, extentZ) * 0.95;
  const sideOffset = wallSize * 0.98; // beside the coil, not behind it -- see the file's own doc comment
  const wallX = box.min.x - wallSize * 0.05; // just behind (less than) the flange's own face
  const wallY = center.y - sideOffset;
  const half = wallSize / 2;
  const wallCorners: [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3] = [
    new THREE.Vector3(wallX, wallY - half, center.z - half),
    new THREE.Vector3(wallX, wallY + half, center.z - half),
    new THREE.Vector3(wallX, wallY + half, center.z + half),
    new THREE.Vector3(wallX, wallY - half, center.z + half),
  ];
  // "Moving the coil onto the wall along its axis": the rotated frame's own
  // +X is the coil's axis (WALL_REMAP: local +Z -> world +X).
  const approachFrom = new THREE.Vector3(center.x + (box.max.x - box.min.x) * 0.08, wallY, center.z);
  const approachTo = new THREE.Vector3(box.min.x + extentY * 0.02, wallY, center.z);
  // "Slide down to seat": mount.ts's WALL_UP (local +Y) -> rotated +Z, so
  // sliding DOWN to seat is decreasing rotated Z. Anchored beside the flange
  // (the wall's own offset Y), not on the coil's own silhouette, so the mark
  // reads as "at the wall" rather than floating on the model's surface.
  const slideFrom = new THREE.Vector3(box.min.x, wallY + extentY * 0.35, center.z + extentZ * 0.2);
  const slideTo = new THREE.Vector3(box.min.x, wallY + extentY * 0.35, center.z + extentZ * 0.02);

  const mountRotation = wallMountRotation(design.mountAxisDeg);
  const mountCoreParts = rotateParts([core], mountRotation);
  const screwLocal = new THREE.Vector3(0, Math.max(1, design.solution.flangeSize / 2) * 0.8, meshBounds(core.mesh).min.z + 1);
  const screwRotated = rotatePoint(screwLocal, mountRotation);
  const insetFit = computeGuideFit(mountCoreParts, "iso", 0.92, 1);
  const screwFrac = insetFit ? projectToFigure(insetFit, screwRotated) : { x: 0.5, y: 0.32 };

  return (
    <StepCard n={n} title="Mount on the wall">
      <div className="guide-figure-row guide-figure-row--solo">
        <Figure
          parts={roomParts}
          testId="guide-mount"
          renderOverlay={(fit) => (
            <>
              <WallQuad corners={wallCorners.map((p) => projectToFigure(fit, p)) as [Pt, Pt, Pt, Pt]} />
              <StraightArrow from={projectToFigure(fit, approachFrom)} to={projectToFigure(fit, approachTo)} />
              <StraightArrow from={projectToFigure(fit, slideFrom)} to={projectToFigure(fit, slideTo)} />
              <CircleMark at={projectToFigure(fit, slideFrom)} r={0.035} />
            </>
          )}
        />
        <CornerInset>
          <GuideFigure parts={mountCoreParts} preset="iso" fill={0.92} className="guide-zoom-inset-figure" testId="guide-mount-inset" />
          <InsetMark at={screwFrac} />
        </CornerInset>
      </div>
      <Callout icons={<WallMountIcon label="Mount on the wall" />}>{mountLine("keyhole")}</Callout>
    </StepCard>
  );
}

function StepMount({ design, n }: { design: Design; n: number }) {
  if (design.spec.mount === "keyhole") return <StepMountKeyhole design={design} n={n} />;
  return <StepMountGeneric design={design} n={n} />;
}

function StepUnwind({ design, n }: { design: Design; n: number }) {
  const core = corePart(design);
  const box = meshBounds(core.mesh);
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(1, design.solution.envelopeDiameter / 2) * 1.08;

  return (
    <StepCard n={n} title="Unwinding">
      <div className="guide-figure-row guide-figure-row--solo">
        <Figure
          parts={design.parts}
          wirePaths={design.wirePaths}
          wireDiameter={design.spec.wire.diameter}
          showWire
          testId="guide-unwind"
          renderOverlay={(fit) => {
            const steps = 10;
            const points = Array.from({ length: steps + 1 }, (_, i) => {
              const t = Math.PI * 0.15 + (i / steps) * Math.PI * 1.6;
              const x = center.x + Math.cos(t) * radius;
              const y = center.y + Math.sin(t) * radius;
              return projectToFigure(fit, new THREE.Vector3(x, y, center.z));
            });
            return <PolylineArrow points={points} />;
          }}
        />
      </div>
      <Callout icons={[<RotateIcon key="rotate" label="Rotate to unwind" />, <NoPullIcon key="nopull" label="Don't pull the cable" />]}>
        Rotate the coil to unwind -- don't pull the cable.
      </Callout>
    </StepCard>
  );
}

export function Guide({ design, onBack }: { design: Design; onBack: () => void }) {
  const { topCapEnabled } = design.solution;
  // Steps 1-3 (print/thread/wind) always run; the two cap steps only exist
  // when this design has a top cap, so every step after them renumbers down
  // by 2 when it doesn't (a design with no cap never has a "step 5" gap).
  const mountN = topCapEnabled ? 6 : 4;
  const unwindN = topCapEnabled ? 7 : 5;
  return (
    // data-resolution mirrors ResultPanel's finalReady gate (issue #7):
    // the guide is generated straight from whatever `design` App currently
    // holds, draft or final, so a caller that needs the settled, FDM-tuned
    // render (e.g. before a screenshot) can wait for "final" here the same
    // way the design view waits for `download-stl` to enable (issue #61/#62).
    <div className="guide" data-testid="guide-view" data-resolution={design.resolution}>
      <div className="guide-toolbar" data-testid="guide-toolbar">
        <button type="button" className="btn-primary guide-toolbar-btn" data-testid="guide-back" onClick={onBack}>
          &larr; Back to design
        </button>
        <button type="button" className="btn-primary guide-toolbar-btn" data-testid="guide-print" onClick={() => window.print()}>
          Print guide
        </button>
      </div>
      <header className="guide-header">
        <h1>Assembly guide</h1>
        <p>Print, thread, wind, fit the cap, mount it.</p>
      </header>
      <StepPrintParts design={design} />
      <StepThreadInnerEnd design={design} />
      <StepWind design={design} />
      {topCapEnabled && <StepFitCap design={design} n={4} />}
      {topCapEnabled && <StepSecureOuterEnd design={design} n={5} />}
      <StepMount design={design} n={mountN} />
      <StepUnwind design={design} n={unwindN} />
    </div>
  );
}
