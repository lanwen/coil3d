// The printable, IKEA-style assembly guide (issue #17). Generated straight
// from the current `Design` (same URL hash the main view solved -- App.tsx
// just swaps which component it renders, see `view=guide`), so a shared
// link opens the exact same guide. Every illustration reuses the interactive
// viewer's own line-art pipeline through `GuideFigure`/`CoilScene`
// (src/viewer/CoilScene.tsx) -- nothing here builds its own render path.
//
// Steps mirror the ticket's numbered list; each is skipped when it doesn't
// apply to the current design (no top cap -> no "fit the cap"/"secure the
// outer end" steps). The wall-mount step is always shown, but its wording is
// data-driven off `spec.mount` (issue #13's `MountKind`): a real mount gets
// real instructions, "none" (still the only case before #14's clip-plate
// mount ships) gets a generic one.

import type { Design, JointKind, MountKind, Part } from "../core";
import { GuideFigure } from "../viewer/GuideFigure";
import { partInPrintPose } from "./printOrientation";
import { ClickIcon, GlueDropIcon, KeyholeIcon, NoSupportsIcon, PressIcon, RotateIcon, TwistIcon, WallMountIcon, WindIcon } from "./pictograms";
import "./guide.css";

const PART_LABELS: Record<string, string> = { core: "Core", "top-cap": "Top cap" };

function partLabel(part: Part): string {
  return PART_LABELS[part.name] ?? part.name;
}

const JOINT_ICON: Record<JointKind, (props: { label: string }) => React.ReactElement> = {
  press: PressIcon,
  bayonet: TwistIcon,
  snap: ClickIcon,
};

const JOINT_INSTRUCTION: Record<JointKind, string> = {
  press: "Press the top cap straight down onto the core until it seats fully.",
  bayonet: "Insert the top cap, then twist to lock it in place.",
  snap: "Press the top cap down until the clips click into place.",
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

function Callout({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="guide-callout">
      {icon}
      <p>{children}</p>
    </div>
  );
}

function StepPrintParts({ design }: { design: Design }) {
  return (
    <StepCard n={1} title="Print the parts">
      <p className="guide-lede">
        This design prints as {design.parts.length} part{design.parts.length === 1 ? "" : "s"}. Every part is shown here in its own print
        orientation -- slice it as-is, no reorienting needed.
      </p>
      <div className="guide-figure-row">
        {design.parts.map((part) => (
          <figure key={part.name} className="guide-part">
            <GuideFigure parts={[partInPrintPose(part)]} testId={`guide-print-part-${part.name}`} />
            <figcaption>
              {partLabel(part)} &times;1
            </figcaption>
          </figure>
        ))}
      </div>
      <Callout icon={<NoSupportsIcon label="No supports needed" />}>Prints upright, no supports needed.</Callout>
    </StepCard>
  );
}

function StepThreadInnerEnd({ design }: { design: Design }) {
  const core = design.parts.find((p) => p.role === "core")!;
  return (
    <StepCard n={2} title="Thread the inner cable end">
      <div className="guide-figure-row">
        <GuideFigure parts={[core]} testId="guide-thread-inner" />
      </div>
      <Callout icon={<KeyholeIcon label="Thread the cable through the base" />}>
        Feed the cable's inner end in at the base of the core, where the groove begins, and hold it in place as you start winding.
      </Callout>
    </StepCard>
  );
}

function StepWind({ design }: { design: Design }) {
  const core = design.parts.find((p) => p.role === "core")!;
  const { layers } = design.solution;
  return (
    <StepCard n={3} title="Wind the cable">
      <div className="guide-figure-row">
        <GuideFigure parts={[core]} wirePaths={design.wirePaths} wireDiameter={design.spec.wire.diameter} showWire testId="guide-wind" />
      </div>
      <Callout icon={<WindIcon label="Wind the cable along the groove" />}>
        Wind the cable along the groove, layer by layer -- {layers} layer{layers === 1 ? "" : "s"} in total.
      </Callout>
    </StepCard>
  );
}

function StepFitCap({ design, n }: { design: Design; n: number }) {
  const JointIcon = JOINT_ICON[design.spec.joint];
  return (
    <StepCard n={n} title="Fit the top cap">
      <div className="guide-figure-row">
        <figure className="guide-part">
          <GuideFigure parts={design.parts} exploded testId="guide-cap-exploded" />
          <figcaption>Align</figcaption>
        </figure>
        <figure className="guide-part">
          <GuideFigure parts={design.parts} testId="guide-cap-assembled" />
          <figcaption>Fit</figcaption>
        </figure>
      </div>
      <Callout icon={<JointIcon label={JOINT_INSTRUCTION[design.spec.joint]} />}>{JOINT_INSTRUCTION[design.spec.joint]}</Callout>
      <Callout icon={<GlueDropIcon label="Add a dab of glue for a permanent bond" />}>This joint is permanent: add a dab of glue for a solid, wall-ready bond.</Callout>
    </StepCard>
  );
}

function StepSecureOuterEnd({ design, n }: { design: Design; n: number }) {
  return (
    <StepCard n={n} title="Secure the outer end">
      <div className="guide-figure-row">
        <GuideFigure parts={design.parts} testId="guide-secure-outer" />
      </div>
      <Callout icon={<KeyholeIcon label="Secure the cable in the cap's rim keyhole" />}>Secure the outer end of the cable in the top cap's rim keyhole.</Callout>
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
function mountInstruction(mount: MountKind): string {
  switch (mount) {
    case "keyhole":
      return "This design has a recessed screw-keyhole slot in the bottom flange. Drive a screw partway into the wall, then hang the slot over it and slide the coil down until it seats.";
    // "none": no mount selected. A pegboard/openGrid clip plate (issue #14)
    // lands here as its own case once it ships.
    default:
      return "No wall mount is selected for this design. Pick the screw-keyhole mount in the design panel, or fix the coil to the wall through its bottom flange your own way.";
  }
}

function StepMount({ design, n }: { design: Design; n: number }) {
  return (
    <StepCard n={n} title="Mount on the wall">
      <div className="guide-figure-row">
        <GuideFigure parts={design.parts} testId="guide-mount" />
      </div>
      <Callout icon={<WallMountIcon label="Mount on the wall" />}>
        Hang it with the bottom flange against the wall and the {design.solution.topCapEnabled ? "top cap" : "open end"} facing the room.{" "}
        {mountInstruction(design.spec.mount)}
      </Callout>
    </StepCard>
  );
}

function StepUnwind({ design, n }: { design: Design; n: number }) {
  return (
    <StepCard n={n} title="Unwinding">
      <div className="guide-figure-row">
        <GuideFigure parts={design.parts} wirePaths={design.wirePaths} wireDiameter={design.spec.wire.diameter} showWire testId="guide-unwind" />
      </div>
      <Callout icon={<RotateIcon label="Unwind by rotating the coil" />}>
        To unwind, rotate the whole coil -- don't pull the cable. This keeps the cable from twisting.
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
        <p>Print the parts, wind the cable, fit the cap, mount it on the wall.</p>
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
