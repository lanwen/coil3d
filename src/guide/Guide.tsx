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
import { EXPLODE_GAP } from "../viewer/CoilScene";
import { partInPrintPose } from "./printOrientation";
import { approxRimPoint, explodedParts, meshBounds, projectToFigure } from "./projection";
import { CircleMark, ClickMark, Figure, PolylineArrow, StraightArrow, TwistMark, WallPlane } from "./overlays";
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
  const path = design.wirePaths[0]?.points;
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
            path && path.length >= 12
              ? (fit) => {
                  const n = Math.floor(path.length / 3);
                  const fracs = [0.14, 0.3, 0.46];
                  const points = fracs.map((f) => {
                    const i = Math.min(n - 1, Math.floor(f * n));
                    return projectToFigure(fit, new THREE.Vector3(path[i * 3], path[i * 3 + 1], path[i * 3 + 2]));
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
 * public core field now, not a guess). `"none"` (still the default, and the
 * only case before #14's clip-plate mount ships) falls through to a
 * generic, still-useful instruction rather than an empty step -- exactly
 * the ticket's "render it generically when there's no mount".
 */
function mountLine(mount: MountKind): string {
  switch (mount) {
    case "keyhole":
      return "Hang the keyhole slot on a screw, then slide down to seat.";
    // "none": no mount selected. A pegboard/openGrid clip plate (issue #14)
    // lands here as its own case once it ships.
    default:
      return "Fix the flange to the wall your own way -- mounts are coming soon.";
  }
}

function StepMount({ design, n }: { design: Design; n: number }) {
  const core = corePart(design);
  const mount = design.spec.mount;
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
                {mount === "keyhole" && (
                  <>
                    <CircleMark at={{ x: 0.06, y: Math.max(0.1, at.y - 0.14) }} r={0.02} />
                    <StraightArrow from={{ x: 0.06, y: Math.max(0.1, at.y - 0.1) }} to={{ x: 0.06, y: at.y }} />
                  </>
                )}
              </>
            );
          }}
        />
      </div>
      <Callout icons={<WallMountIcon label="Mount on the wall" />}>{mountLine(mount)}</Callout>
    </StepCard>
  );
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
    <div className="guide" data-testid="guide-view">
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
