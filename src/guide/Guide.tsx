// The printable, IKEA-style assembly guide (issue #17). Generated straight
// from the current `Design` (same URL hash the main view solved -- App.tsx
// just swaps which component it renders, see `ui.view`), so a shared
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
import { GuideFigure, renderAllGuideFigures } from "../viewer/GuideFigure";
import { EXPLODE_GAP } from "../viewer/CoilScene";
import { partLabel } from "../viewer/partLabels";
import { partInPrintPose } from "./printOrientation";
import { approxRimPoint, computeGuideFit, explodedParts, meshBounds, partsBounds, projectToFigure } from "./projection";
import { CircleMark, ClickMark, CornerInset, Figure, InsetMark, PolylineArrow, SlotOutlines, StraightArrow, TwistMark, WallPlane, WallQuad, ZoomInset, ZoomLeader, HOST_FIGURE_WIDTH, type Pt } from "./overlays";
import { rotateParts, rotatePoint, wallMountRotation, wallRoomRotation, wallSideRotation } from "./wallView";
import { ClickIcon, GlueDropIcon, KeyholeIcon, NoPullIcon, NoSupportsIcon, PressIcon, RotateIcon, ScrewdriverIcon, TwistIcon, WallMountIcon, WindIcon } from "./pictograms";
import "./guide.css";

function corePart(design: Design): Part {
  return design.parts.find((p) => p.role === "core")!;
}

function capPart(design: Design): Part | undefined {
  return design.parts.find((p) => p.role === "topCap");
}

function platePart(design: Design): Part | undefined {
  return design.parts.find((p) => p.role === "mountPlate");
}

/** Issue #132: the mount plate's two printed alignment pegs (empty without a plate). */
function pegParts(design: Design): Part[] {
  return design.parts.filter((p) => p.role === "peg");
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

/** A numbered part's group ("peg-2" -> "peg", "skadis-bottom-clip-2" -> "skadis-bottom-clip"): copies of one shape share a figure. */
function partGroup(part: Part): string {
  return part.name.replace(/-\d+$/, "");
}

function StepPrintParts({ design }: { design: Design }) {
  // Issue #132: the two identical pegs share one figure, "x2"; issue #207:
  // so do the SKÅDIS clips of each kind.
  const groups = new Map<string, Part[]>();
  for (const part of design.parts) groups.set(partGroup(part), [...(groups.get(partGroup(part)) ?? []), part]);
  const pegs = pegParts(design);
  const clips = design.parts.filter((p) => p.role === "mountClip");
  const onSide = [pegs.length > 0 ? "the pegs" : "", clips.length > 0 ? "the clips" : ""].filter(Boolean).join(" and ");
  return (
    <StepCard n={1} title="Print the parts">
      <div className="guide-figure-row">
        {[...groups.values()].map(([part, ...more]) => (
          <figure key={part.name} className="guide-part">
            <Figure parts={[partInPrintPose(part)]} fill={0.9} testId={`guide-print-part-${part.name}`} />
            <figcaption>
              {partLabel(part)} &times;{1 + more.length}
            </figcaption>
          </figure>
        ))}
      </div>
      <Callout icons={<NoSupportsIcon label="No supports needed" />}>
        {design.parts.length} part{design.parts.length === 1 ? "" : "s"}, prints upright{onSide ? ` (${onSide} lying on their side)` : ""} -- no supports.
      </Callout>
    </StepCard>
  );
}

function StepThreadInnerEnd({ design }: { design: Design }) {
  const core = corePart(design);
  // The inner end's clip (issue #117), on the flange's inner face (z=0).
  const clip = design.innerEndClip;
  const anchor = design.innerEndLeadIn.length >= 3 ? new THREE.Vector3((clip.from.x + clip.to.x) / 2, (clip.from.y + clip.to.y) / 2, 0) : approxRimPoint(core.mesh, 0.1, 1);
  return (
    <StepCard n={2} title="Clip in the inner cable end">
      <div className="guide-figure-row guide-figure-row--solo">
        <Figure parts={[core]} testId="guide-thread-inner" zoomInsetAt={anchor} />
      </div>
      <Callout icons={<KeyholeIcon label="Press the cable into the clip at the base's rim" />}>Press the inner end into the clip at the rim, then lay it along the channel to the groove's start.</Callout>
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

  // The mount plate (and its pegs, issue #132) sits UNDER the flange, and the SKÅDIS clips (issue #207) on its rim: lifting them with the cap would push them up through the core (issue #106).
  const capParts = design.parts.filter((p) => p.role !== "mountPlate" && p.role !== "peg" && p.role !== "mountClip");
  const posedForAlign = explodedParts(capParts, true, EXPLODE_GAP);
  const posedCap = posedForAlign.find((p) => p.role !== "core")!;
  const capBottomExploded = centerAtZ(posedCap.mesh, meshBounds(posedCap.mesh).min.z);
  const coreTop = centerAtZ(core.mesh, meshBounds(core.mesh).max.z);
  const seam = new THREE.Vector3(coreTop.x, coreTop.y, design.solution.height);

  return (
    <StepCard n={n} title="Fit the top cap">
      <div className="guide-figure-row">
        <figure className="guide-part">
          <Figure
            parts={capParts}
            exploded
            testId="guide-cap-exploded"
            renderOverlay={(fit) => <StraightArrow from={projectToFigure(fit, capBottomExploded)} to={projectToFigure(fit, coreTop)} />}
          />
          <figcaption>Align</figcaption>
        </figure>
        <figure className="guide-part">
          <Figure
            parts={capParts}
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
  // The cap's clips (issues #117, #121) hang under it; the one the drawn cable runs through is marked from above.
  const clip = design.capClip?.clips[0].path;
  const mid = clip ? clip[Math.floor(clip.length / 4)] : undefined;
  const anchor = mid ? new THREE.Vector3(mid.x, mid.y, meshBounds(cap.mesh).max.z) : approxRimPoint(cap.mesh, 0.5, 1);
  return (
    <StepCard n={n} title="Secure the outer end">
      <div className="guide-figure-row guide-figure-row--solo">
        <Figure parts={design.parts} testId="guide-secure-outer" zoomInsetAt={anchor} />
      </div>
      <Callout icons={<KeyholeIcon label="Press the cable into a clip under the cap" />}>
        {(design.capClip?.clips.length ?? 1) > 1
          ? "Press the outer end into a clip under the cap. There are clips all around it: after unwinding a little more cable, use the next one."
          : "Press the outer end into the clip under the cap."}
      </Callout>
    </StepCard>
  );
}

/**
 * Data-driven off `spec.mount` (issue #13 landed the "keyhole" case while
 * this ticket was in flight -- `CoilSpec.mount: MountKind` is a real,
 * public core field now, not a guess; issue #14 landed "skadis" the same
 * way, after this ticket shipped; issue #70 landed "through" the same way
 * too). `"none"` falls through to a generic, still-useful instruction
 * rather than an empty step -- exactly the ticket's "render it generically
 * when there's no mount". `"opengrid"` is not reachable from the UI or a
 * shared link (issue #14 PR review round 2: its connector geometry is a
 * placeholder, so the mount is hidden until a real one exists -- see
 * hash.ts/ControlsForm.tsx), so it shares the same generic fallback as
 * "none" rather than getting its own, possibly misleading, line.
 */
function mountLine(mount: MountKind): string {
  switch (mount) {
    case "keyhole":
      return "Hang the keyhole slot on a screw, then slide down to seat.";
    case "through":
      return "Drive a screw straight through each hole, into the wall -- reachable through the open bore or around the winding, no sliding needed.";
    case "skadis-tclip":
      return "Hold the coil flat on the board, each slot in the core's floor over a board slot. Reach through the core and push each T-clip through with its fin upright, then pinch the fin and turn it a quarter turn clockwise until it stops. Let go: the coil drops about 5 mm onto the clips. To take it down, lift the coil back up and turn the clips back.";
    case "skadis":
      return "Push each bottom clip into its slot and let it drop. Lower the coil's rim into them, then push the top clip into its slot just above the rim and let it drop until it clicks. To take the coil down, lift the top clip firmly.";
    // "none" (and "opengrid", not reachable -- see this function's own doc comment).
    default:
      return "Fix the flange to the wall your own way -- mounts are coming soon.";
  }
}

/** The pictogram beside `mountLine`'s own instruction (issue #70: the through-hole mount gets its own screwdriver-through-a-hole icon; every other case keeps the generic hatched-wall-and-screw icon). */
function mountIcon(mount: MountKind) {
  return mount === "through" ? <ScrewdriverIcon label="Drive a screw through each hole" /> : <WallMountIcon label="Mount on the wall" />;
}

/** No illustrated hung orientation (no mount, or issue #70's through-hole mount -- unlike the keyhole mount below, neither rotates the core itself onto the wall: the through-hole mount has no gravity-seated "hung orientation" to show since it isn't sliding onto anything) -- the coil stays in its standing pose next to a plain, decorative wall strip (issue #17 review: "for SKÅDIS/none, render generically as before"). `mountLine`/`mountIcon` still give each mount its own accurate instruction text/icon.
 *
 * Issue #70 AC ("Screenshots: mount-side face-on view for round/sq/tri"): the
 * through-hole mount has no gravity-seated hung ORIENTATION to show (unlike
 * the keyhole mount below), but its own hole placement is still worth seeing
 * face-on -- unlike the keyhole's single schematic screw mark (mount.ts's
 * exact slot count/radius are core internals, "not for UI use"), the
 * through-holes are REAL cut geometry, already in `core.mesh`, so this inset
 * needs no schematic overlay at all: just the same mount-side rotation
 * (`wallMountRotation`) StepMountKeyhole's own inset uses, with
 * `mountAxisDeg` undefined (design.ts never sets one for "through" -- there's
 * no hung axis to correct for), which is exactly the identity/base rotation.
 */
function StepMountGeneric({ design, n }: { design: Design; n: number }) {
  const core = corePart(design);
  const wallAnchor = approxRimPoint(core.mesh, 0.05, -1);
  const showThroughInset = design.spec.mount === "through";
  const mountCoreParts = showThroughInset ? rotateParts([core], wallMountRotation(design.mountAxisDeg)) : undefined;
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
        {mountCoreParts && (
          <CornerInset>
            <GuideFigure parts={mountCoreParts} preset="iso" fill={0.7} className="guide-zoom-inset-figure" testId="guide-mount-inset" />
          </CornerInset>
        )}
      </div>
      <Callout icons={mountIcon(design.spec.mount)}>{mountLine(design.spec.mount)}</Callout>
    </StepCard>
  );
}

/**
 * The screw-keyhole mount's REAL hung orientation (issue #17 review: the
 * coil's axis points out of the wall, the bottom flange sits flat against
 * the wall, the top cap faces the room -- docs/design.md, Orientation, mount.ts's
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
  const insetFit = computeGuideFit(mountCoreParts, "iso", 0.7, 1);
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
          <GuideFigure parts={mountCoreParts} preset="iso" fill={0.7} className="guide-zoom-inset-figure" testId="guide-mount-inset" />
          <InsetMark at={screwFrac} />
        </CornerInset>
      </div>
      <Callout icons={<WallMountIcon label="Mount on the wall" />}>{mountLine("keyhole")}</Callout>
    </StepCard>
  );
}

/** `part` moved down Z by `offset` (the guide's own "exploded" pose for the parts under the flange: `explodedParts` lifts every non-core part UP, which for these would push them through the core). */
function lowered(part: Part, offset: number): Part {
  const positions = new Float32Array(part.mesh.positions);
  for (let i = 2; i < positions.length; i += 3) positions[i] -= offset;
  return { ...part, mesh: { positions, indices: part.mesh.indices } };
}

/** Issues #106, #132: glue the SKÅDIS plate onto the flange, on its two printed pegs -- drawn exploded, the pegs halfway between the flange and the lowered plate, in line with their holes. */
function StepFitPlate({ design, n }: { design: Design; n: number }) {
  const core = corePart(design);
  const plate = platePart(design)!;
  const { min, max } = meshBounds(plate.mesh);
  const drop = max.z - min.z + EXPLODE_GAP;
  const plateDown = lowered(plate, drop);
  const pegsDown = pegParts(design).map((peg) => lowered(peg, drop / 2));
  const from = centerAtZ(plateDown.mesh, meshBounds(plateDown.mesh).max.z);
  const to = centerAtZ(core.mesh, meshBounds(core.mesh).min.z);
  const figureParts = [core, ...pegsDown, plateDown];
  // A close-up of the peg nearest the camera (the pegs are only 3 mm across).
  const fit = computeGuideFit(figureParts, "iso", 1);
  const depth = (p: THREE.Vector3) => (fit ? p.clone().sub(fit.center).applyMatrix4(fit.inverse).z : 0);
  const pegCentres = pegsDown.map((peg) => meshBounds(peg.mesh).getCenter(new THREE.Vector3()));
  const nearestPeg = pegCentres.sort((a, b) => depth(b) - depth(a))[0];
  return (
    <StepCard n={n} title="Fit the mount plate">
      <div className="guide-figure-row guide-figure-row--solo">
        <Figure
          parts={figureParts}
          testId="guide-fit-plate"
          zoomInsetAt={nearestPeg}
          renderOverlay={(fit) => <StraightArrow from={projectToFigure(fit, from)} to={projectToFigure(fit, to)} />}
        />
      </div>
      <Callout icons={[<PressIcon key="press" label="Press the plate on" />, <GlueDropIcon key="glue" label="Permanent: add glue" />]}>
        {pegsDown.length > 0
          ? "Push the two printed pegs into the plate's two holes. Add glue, then press the plate onto the flange, pegs into its holes."
          : "Add glue, then press the plate flat onto the flange."}
      </Callout>
    </StepCard>
  );
}

/**
 * Issues #106, #207: the SKÅDIS rim clips. Main figure: the mount side,
 * face-on (the same `wallMountRotation` as the keyhole step's inset), with
 * the board's slot grid (`Design.pegboard`, drawn on its back plane, nearer
 * this camera than anything but the clips' tongues) outlined over it --
 * every clip sits in a slot. The inset is a side-view close-up of the top
 * clip hooking its slot and holding the rim (`RimClipInset`, issue #215).
 * Issue #213: for the T-clips, the inset is a close-up of the same view
 * instead, on the top clip's T bar turned across its slot.
 */
function StepMountSkadis({ design, n }: { design: Design; n: number }) {
  const board = design.pegboard!;
  const tclip = design.spec.mount === "skadis-tclip";
  const mountRotation = wallMountRotation(design.mountAxisDeg);
  const mountParts = rotateParts(design.parts, mountRotation);
  const rimClip = tclip ? undefined : rimClipFocus(design);
  const a = (board.axisDeg * Math.PI) / 180;
  const up = { x: Math.sin(a), y: Math.cos(a) };
  const side = { x: Math.cos(a), y: -Math.sin(a) };
  const r = board.slotWidth / 2;
  const h = board.slotLength / 2 - r;
  const z = board.frontZ - board.thickness;
  const outline: Array<[number, number]> = [];
  for (let i = 0; i <= 12; i++) outline.push([r * Math.cos((Math.PI * i) / 12), h + r * Math.sin((Math.PI * i) / 12)]);
  for (let i = 0; i <= 12; i++) outline.push([r * Math.cos(Math.PI + (Math.PI * i) / 12), -h + r * Math.sin(Math.PI + (Math.PI * i) / 12)]);
  return (
    <StepCard n={n} title="Mount on the SKÅDIS board">
      <div className="guide-figure-row guide-figure-row--solo">
        <Figure
          parts={mountParts}
          testId="guide-mount"
          zoomInsetAt={tclip ? tclipBarAnchor(design, mountRotation) : undefined}
          zoomInsetWindowMm={TCLIP_INSET_WINDOW_MM}
          renderOverlay={(fit) => (
            <>
              <SlotOutlines
                slots={board.slots.map((c) =>
                  outline.map(([s, u]) => projectToFigure(fit, rotatePoint(new THREE.Vector3(c.x + s * side.x + u * up.x, c.y + s * side.y + u * up.y, z), mountRotation))),
                )}
              />
              {rimClip && <ZoomLeader at={projectToFigure(fit, rotatePoint(rimClip.target, mountRotation))} corner="top-right" />}
            </>
          )}
        />
        {rimClip && <RimClipInset design={design} focus={rimClip} />}
      </div>
      <Callout icons={tclip ? <TwistIcon label="Push in upright, turn a quarter turn" /> : <WallMountIcon label="Mount on the SKÅDIS board" />}>{mountLine(design.spec.mount)}</Callout>
    </StepCard>
  );
}

const RIM_INSET_FILL = 0.85;
const RIM_INSET_SIZE = 140; // CSS px
const RIM_INSET_WINDOW_MM = 28; // how much of the model the window shows, across
const RIM_INSET_BOARD_REACH = 14; // mm of board drawn past each end of the slot
const RIM_INSET_BOARD_DEPTH = 12; // mm of board drawn along the camera's line of sight

/** An axis-aligned box in a slot's own (side, up, z) frame, as a part in the design's frame. */
function slotBox(name: string, slot: { x: number; y: number }, axisDeg: number, [s0, s1]: [number, number], [u0, u1]: [number, number], [z0, z1]: [number, number]): Part {
  const a = (axisDeg * Math.PI) / 180;
  const positions = new Float32Array(24);
  for (let i = 0; i < 8; i++) {
    const s = i & 1 ? s1 : s0;
    const u = i & 2 ? u1 : u0;
    const z = i & 4 ? z1 : z0;
    positions.set([slot.x + s * Math.cos(a) + u * Math.sin(a), slot.y - s * Math.sin(a) + u * Math.cos(a), z], i * 3);
  }
  // Outward, counter-clockwise: -s, +s, -u, +u, -z, +z.
  const indices = new Uint32Array([0, 4, 6, 0, 6, 2, 1, 3, 7, 1, 7, 5, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6]);
  return { name, role: "mountPlate", mesh: { positions, indices } as CoilMesh, printTransform: { rotateX: 0, translate: [0, 0, 0] } };
}

interface RimClipFocus {
  /** The slot the top clip hangs in. */
  slot: { x: number; y: number };
  /** Where the clip meets the rim (just above it, on the clip's mid-plane): what the circle marks and the inset centres on. */
  target: THREE.Vector3;
}

/** The top clip's slot, and the point where it holds the rim. */
function rimClipFocus(design: Design): RimClipFocus | undefined {
  const board = design.pegboard!;
  const clip = design.parts.find((p) => p.name === "skadis-top-clip-1") ?? design.parts.find((p) => p.role === "mountClip");
  if (!clip) return undefined;
  const a = (board.axisDeg * Math.PI) / 180;
  const alongUp = (x: number, y: number) => x * Math.sin(a) + y * Math.cos(a);
  // The clip's slot: the one nearest the clip's middle. The rim: the core's top along up.
  const middle = meshBounds(clip.mesh).getCenter(new THREE.Vector3());
  const slot = board.slots.reduce((best, c) => (Math.hypot(c.x - middle.x, c.y - middle.y) < Math.hypot(best.x - middle.x, best.y - middle.y) ? c : best));
  const corePos = corePart(design).mesh.positions;
  let rimUp = -Infinity;
  for (let i = 0; i < corePos.length; i += 3) rimUp = Math.max(rimUp, alongUp(corePos[i], corePos[i + 1]));
  const sideAt = middle.x * Math.cos(a) - middle.y * Math.sin(a); // the clip's own place along the board (a triangle's top clips are off-centre)
  const upAt = rimUp + 3;
  return { slot, target: new THREE.Vector3(upAt * Math.sin(a) + sideAt * Math.cos(a), upAt * Math.cos(a) - sideAt * Math.sin(a), middle.z) };
}

/**
 * Issue #215: the rim clip's engagement, close up from the side: the top clip's stem through its board slot and its
 * jaws holding the flange's rim, with the board cut away at the clip's mid-plane so the slot shows. The whole coil at
 * inset size drew as a dark blob, so this crops the side view tight instead (like the T-clips' close-up).
 */
function RimClipInset({ design, focus }: { design: Design; focus: RimClipFocus }) {
  const board = design.pegboard!;
  const half = board.slotLength / 2;
  const z: [number, number] = [board.frontZ - board.thickness, board.frontZ];
  const boardParts = [
    slotBox("board-above", focus.slot, board.axisDeg, [0, RIM_INSET_BOARD_DEPTH], [half, half + RIM_INSET_BOARD_REACH], z),
    slotBox("board-below", focus.slot, board.axisDeg, [0, RIM_INSET_BOARD_DEPTH], [-half - RIM_INSET_BOARD_REACH, -half], z),
  ];
  const rotation = wallSideRotation(design.mountAxisDeg);
  const parts = rotateParts([...design.parts, ...boardParts], rotation);
  const fit = computeGuideFit(parts, "iso", RIM_INSET_FILL);
  if (!fit) return null;
  const at = projectToFigure(fit, rotatePoint(focus.target, rotation));
  // Show RIM_INSET_WINDOW_MM across: the host figure is HOST_FIGURE_WIDTH px for 2 * halfHeight * aspect mm.
  const zoom = (RIM_INSET_SIZE * 2 * fit.halfHeight * fit.aspect) / (HOST_FIGURE_WIDTH * RIM_INSET_WINDOW_MM);
  return <ZoomInset parts={parts} preset="iso" fill={RIM_INSET_FILL} at={at} zoom={zoom} size={RIM_INSET_SIZE} corner="top-right" />;
}

/** How much of the model the T-clip close-up shows, across: one slot and its turned T bar, at every coil size (issue #221). */
const TCLIP_INSET_WINDOW_MM = 22;

/** The top T-clip's T bar (behind the board), in the mount-side figure's frame: where the close-up looks. */
function tclipBarAnchor(design: Design, rotation: THREE.Matrix4): THREE.Vector3 | undefined {
  const clip = design.parts.find((p) => p.role === "mountClip");
  if (!clip) return undefined;
  const box = meshBounds(clip.mesh);
  const c = box.getCenter(new THREE.Vector3());
  return rotatePoint(new THREE.Vector3(c.x, c.y, box.min.z + 1.5), rotation);
}

function StepMount({ design, n }: { design: Design; n: number }) {
  if (design.spec.mount === "keyhole") return <StepMountKeyhole design={design} n={n} />;
  if ((design.spec.mount === "skadis" || design.spec.mount === "skadis-tclip") && design.pegboard) return <StepMountSkadis design={design} n={n} />;
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
  // Issue #106: a mount plate (openGrid) gets its own "fit the plate" step first.
  const hasPlate = !!platePart(design) && !!design.pegboard;
  const plateN = topCapEnabled ? 6 : 4;
  const mountN = plateN + (hasPlate ? 1 : 0);
  const unwindN = mountN + 1;
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
        <button type="button" className="btn-primary guide-toolbar-btn" data-testid="guide-print" onClick={() => void renderAllGuideFigures().then(() => window.print())}>
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
      {hasPlate && <StepFitPlate design={design} n={plateN} />}
      <StepMount design={design} n={mountN} />
      <StepUnwind design={design} n={unwindN} />
    </div>
  );
}
