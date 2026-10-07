import * as THREE from "three";
import type { CoilMesh, Design, JointKind, MountKind, Part, WireLayerPath } from "../core";
import { GuideFigure, renderAllGuideFigures } from "../viewer/GuideFigure";
import { EXPLODE_GAP } from "../viewer/CoilScene";
import { partLabel } from "../viewer/partLabels";
import { partInPrintPose } from "./printOrientation";
import { approxRimPoint, computeGuideFit, explodedParts, meshBounds, partsBounds, projectToFigure, type GuideFit } from "./projection";
import { CircleMark, ClickMark, CornerInset, Figure, InsetMark, PolylineArrow, SlotOutlines, StraightArrow, TwistMark, WallPlane, WallQuad, ZoomInset, ZoomLeader, zoomForWindowMm, type Pt } from "./overlays";
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

function pegParts(design: Design): Part[] {
  return design.parts.filter((p) => p.role === "peg");
}

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

function partGroup(part: Part): string {
  return part.name.replace(/-\d+$/, "");
}

function StepPrintParts({ design }: { design: Design }) {
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

function StepThreadInnerEnd({ design, n, clip }: { design: Design; n: number; clip: NonNullable<Design["innerEndClip"]> }) {
  const core = corePart(design);
  const anchor = new THREE.Vector3((clip.from.x + clip.to.x) / 2, (clip.from.y + clip.to.y) / 2, (clip.from.z + clip.to.z) / 2);
  return (
    <StepCard n={n} title="Clip in the inner cable end">
      <div className="guide-figure-row guide-figure-row--solo">
        <Figure parts={[core]} testId="guide-thread-inner" zoomInsetAt={anchor} />
      </div>
      <Callout icons={<KeyholeIcon label="Press the cable into the clip at the base's rim" />}>Press the inner end into the clip at the rim, then lay it along the channel to the groove's start.</Callout>
    </StepCard>
  );
}

const FACE_WINDOW_WIRE_DIAMETERS = 9;

function faceWindowMm(design: Design): number {
  return FACE_WINDOW_WIRE_DIAMETERS * (design.spec.wire.diameter + design.spec.tolerance);
}

const BOTTOM_FACE_TILT = THREE.MathUtils.degToRad(48);
const FROM_BELOW = new THREE.Matrix4()
  .makeRotationAxis(new THREE.Vector3(1, 1, 0).normalize(), BOTTOM_FACE_TILT)
  .multiply(new THREE.Matrix4().makeRotationX(Math.PI));
const CHANNEL_WINDOW_MARGIN = 1.5;

function channelView(lead: Float32Array, level: number): { anchor: THREE.Vector3; windowMm: number } {
  const box = new THREE.Box3();
  for (let i = 0; i < lead.length; i += 3) box.expandByPoint(new THREE.Vector3(lead[i], lead[i + 1], level));
  const centre = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  return { anchor: centre, windowMm: CHANNEL_WINDOW_MARGIN * Math.hypot(size.x, size.y) };
}

function StepThreadFaceInnerEnd({ design, n }: { design: Design; n: number }) {
  const core = corePart(design);
  const lead = design.innerEndLeadIn;
  const innerEnd: WireLayerPath = { layer: 0, turns: 0, points: lead };
  const grooveStart = new THREE.Vector3(lead[lead.length - 3], lead[lead.length - 2], lead[lead.length - 1]);
  const { level, hole } = design.faceChannels!.inner!;
  const holeEntrance = new THREE.Vector3(hole.x, hole.y, level);
  const { anchor, windowMm } = channelView(lead, level);
  return (
    <StepCard n={n} title="Lay in the inner cable end">
      <div className="guide-figure-row guide-figure-row--solo">
        <Figure parts={[core]} wirePaths={[innerEnd]} wireDiameter={design.spec.wire.diameter} showWire testId="guide-thread-inner" zoomInsetAt={grooveStart} zoomInsetWindowMm={Math.max(windowMm, faceWindowMm(design))} zoomInsetView={{ pose: FROM_BELOW, at: anchor, focus: [grooveStart, holeEntrance] }} />
      </div>
      <Callout icons={<KeyholeIcon label="Press the cable into the channel on the bottom face" />}>
        Press the cable into the channel on the bottom face, from the groove's start in to the centre hole. Bring the connector up through the hole and out of the top.
      </Callout>
    </StepCard>
  );
}

const WIND_ARROW_MAX_TURNS = 0.72;
const WIND_ARROW_MIN_SAMPLES = 10;
const WIND_ARROW_START_FRACTION = 0.08;
const WIND_ARROW_SEGMENTS = 18;

function windDirectionPoints(layer: WireLayerPath, fit: GuideFit): Pt[] {
  const path = layer.points;
  const sampleCount = Math.floor(path.length / 3);
  const samplesPerTurn = (sampleCount - 1) / layer.turns;
  const spanTurns = Math.min(layer.turns, WIND_ARROW_MAX_TURNS);
  const spanSamples = Math.max(WIND_ARROW_MIN_SAMPLES, Math.round(spanTurns * samplesPerTurn));
  const startIdx = Math.max(0, Math.floor(sampleCount * WIND_ARROW_START_FRACTION));
  const endIdx = Math.min(sampleCount - 1, startIdx + spanSamples);
  return Array.from({ length: WIND_ARROW_SEGMENTS + 1 }, (_, i) => {
    const idx = startIdx + Math.round(((endIdx - startIdx) * i) / WIND_ARROW_SEGMENTS);
    return projectToFigure(fit, new THREE.Vector3(path[idx * 3], path[idx * 3 + 1], path[idx * 3 + 2]));
  });
}

function StepWind({ design, n }: { design: Design; n: number }) {
  const core = corePart(design);
  const { layers } = design.solution;
  const layer0 = design.wirePaths[0];
  return (
    <StepCard n={n} title="Wind the cable">
      <div className="guide-figure-row guide-figure-row--solo">
        <Figure
          parts={[core]}
          wirePaths={design.wirePaths}
          wireDiameter={design.spec.wire.diameter}
          showWire
          testId="guide-wind"
          renderOverlay={layer0 && layer0.points.length >= 24 && layer0.turns > 0 ? (fit) => <PolylineArrow points={windDirectionPoints(layer0, fit)} /> : undefined}
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

  const partsWithoutMount = design.parts.filter((p) => p.role !== "mountPlate" && p.role !== "peg" && p.role !== "mountClip");
  const posedForAlign = explodedParts(partsWithoutMount, true, EXPLODE_GAP);
  const posedCap = posedForAlign.find((p) => p.role !== "core")!;
  const capBottomExploded = centerAtZ(posedCap.mesh, meshBounds(posedCap.mesh).min.z);
  const coreTop = centerAtZ(core.mesh, meshBounds(core.mesh).max.z);
  const seam = new THREE.Vector3(coreTop.x, coreTop.y, design.solution.height);

  return (
    <StepCard n={n} title="Fit the top cap">
      <div className="guide-figure-row">
        <figure className="guide-part">
          <Figure
            parts={partsWithoutMount}
            exploded
            testId="guide-cap-exploded"
            renderOverlay={(fit) => <StraightArrow from={projectToFigure(fit, capBottomExploded)} to={projectToFigure(fit, coreTop)} />}
          />
          <figcaption>Align</figcaption>
        </figure>
        <figure className="guide-part">
          <Figure
            parts={partsWithoutMount}
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

function StepLayOuterEndFace({ design, n }: { design: Design; n: number }) {
  const core = corePart(design);
  const outer = design.faceChannels!.outer!;
  const anchor = new THREE.Vector3(outer.hole.x, outer.hole.y, outer.level);
  const outerEnd: WireLayerPath = { layer: 0, turns: 0, points: design.outerEndLeadOut };
  return (
    <StepCard n={n} title="Lay in the outer cable end">
      <div className="guide-figure-row guide-figure-row--solo">
        <Figure parts={[core]} wirePaths={[...design.wirePaths, outerEnd]} wireDiameter={design.spec.wire.diameter} showWire testId="guide-secure-outer" zoomInsetAt={anchor} zoomInsetWindowMm={faceWindowMm(design)} />
      </div>
      <Callout icons={<KeyholeIcon label="Press the cable into the channel on the top face" />}>
        Press the outer end into the channel on the top face, from the last turn in to the centre hole. Let the connector hang down through the hole.
      </Callout>
    </StepCard>
  );
}

const SLOT_WINDOW_WIRE_DIAMETERS = 5;

function StepSecureOuterEnd({ design, n }: { design: Design; n: number }) {
  const cap = capPart(design)!;
  const seat = design.rimSlots.cap?.seat;
  const anchor = seat ? new THREE.Vector3(seat.x, seat.y, meshBounds(cap.mesh).max.z) : approxRimPoint(cap.mesh, 0.5, 1);
  const slotWindowMm = SLOT_WINDOW_WIRE_DIAMETERS * (design.spec.wire.diameter + design.spec.tolerance);
  return (
    <StepCard n={n} title="Secure the outer end">
      <div className="guide-figure-row guide-figure-row--solo">
        <Figure parts={design.parts} testId="guide-secure-outer" zoomInsetAt={anchor} zoomInsetWindowMm={seat ? slotWindowMm : undefined} />
      </div>
      <Callout icons={<KeyholeIcon label="Press the cable into the slot in the cap's rim" />}>
        {design.rimSlots.cap
          ? "Bring the outer end up and press it into the slot in the cap's rim, from the edge. It clicks past the narrow neck into the round seat. The base has the same slot, if you'd rather run the end down the side."
          : "Tie the outer end to the coil."}
      </Callout>
    </StepCard>
  );
}

function mountLine(mount: MountKind): string {
  switch (mount) {
    case "keyhole":
      return "Hang the keyhole slot on a screw, then slide down to seat.";
    case "through":
      return "Drive a countersunk screw through each hole into the wall, before winding if the cable will cover the holes. The heads sit flush, under the cable.";
    case "skadis-tclip":
      return "Hold the coil flat on the board, each slot in the core's floor over a board slot. Reach through the core and push each T-clip through with its fin upright, then pinch the fin and turn it a quarter turn clockwise until it stops. Let go: the coil drops about 5 mm onto the clips. To take it down, lift the coil back up and turn the clips back.";
    case "skadis":
      return "Push each bottom clip into its slot and let it drop. Lower the coil's rim into them, then push the top clip into its slot just above the rim and let it drop until it clicks. To take the coil down, lift the top clip firmly.";
    case "none":
    case "opengrid":
    default:
      return "Fix the flange to the wall your own way -- mounts are coming soon.";
  }
}

function mountIcon(mount: MountKind) {
  return mount === "through" ? <ScrewdriverIcon label="Drive a screw through each hole" /> : <WallMountIcon label="Mount on the wall" />;
}

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

function StepMountKeyhole({ design, n }: { design: Design; n: number }) {
  const core = corePart(design);
  const roomRotation = wallRoomRotation(design.mountAxisDeg);
  const roomParts = rotateParts(design.parts, roomRotation);
  const box = partsBounds(roomParts);
  const center = box.getCenter(new THREE.Vector3());
  const extentY = box.max.y - box.min.y;
  const extentZ = box.max.z - box.min.z;
  const wallSize = Math.max(extentY, extentZ) * 0.95;
  const wallBesideCoilOffset = wallSize * 0.98;
  const wallJustBehindFlangeX = box.min.x - wallSize * 0.05;
  const wallY = center.y - wallBesideCoilOffset;
  const half = wallSize / 2;
  const wallCorners: [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3] = [
    new THREE.Vector3(wallJustBehindFlangeX, wallY - half, center.z - half),
    new THREE.Vector3(wallJustBehindFlangeX, wallY + half, center.z - half),
    new THREE.Vector3(wallJustBehindFlangeX, wallY + half, center.z + half),
    new THREE.Vector3(wallJustBehindFlangeX, wallY - half, center.z + half),
  ];
  const approachFrom = new THREE.Vector3(center.x + (box.max.x - box.min.x) * 0.08, wallY, center.z);
  const approachTo = new THREE.Vector3(box.min.x + extentY * 0.02, wallY, center.z);
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

function lowered(part: Part, offset: number): Part {
  const positions = new Float32Array(part.mesh.positions);
  for (let i = 2; i < positions.length; i += 3) positions[i] -= offset;
  return { ...part, mesh: { positions, indices: part.mesh.indices } };
}

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

const SLOT_OUTLINE_ARC_STEPS = 12;

function slotOutline(slotWidth: number, slotLength: number): Array<[number, number]> {
  const r = slotWidth / 2;
  const h = slotLength / 2 - r;
  const outline: Array<[number, number]> = [];
  for (let i = 0; i <= SLOT_OUTLINE_ARC_STEPS; i++) outline.push([r * Math.cos((Math.PI * i) / SLOT_OUTLINE_ARC_STEPS), h + r * Math.sin((Math.PI * i) / SLOT_OUTLINE_ARC_STEPS)]);
  for (let i = 0; i <= SLOT_OUTLINE_ARC_STEPS; i++) outline.push([r * Math.cos(Math.PI + (Math.PI * i) / SLOT_OUTLINE_ARC_STEPS), -h + r * Math.sin(Math.PI + (Math.PI * i) / SLOT_OUTLINE_ARC_STEPS)]);
  return outline;
}

function StepMountSkadis({ design, n }: { design: Design; n: number }) {
  const board = design.pegboard!;
  const tclip = design.spec.mount === "skadis-tclip";
  const mountRotation = wallMountRotation(design.mountAxisDeg);
  const mountParts = rotateParts(design.parts, mountRotation);
  const rimClip = tclip ? undefined : rimClipFocus(design);
  const a = (board.axisDeg * Math.PI) / 180;
  const up = { x: Math.sin(a), y: Math.cos(a) };
  const side = { x: Math.cos(a), y: -Math.sin(a) };
  const z = board.frontZ - board.thickness;
  const outline = slotOutline(board.slotWidth, board.slotLength);
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
const RIM_INSET_SIZE_PX = 140;
const RIM_INSET_WINDOW_MM = 28;
const RIM_INSET_BOARD_REACH_MM = 14;
const RIM_INSET_BOARD_DEPTH_MM = 12;

const BOX_TRIANGLES_OUTWARD_CCW = [0, 4, 6, 0, 6, 2, 1, 3, 7, 1, 7, 5, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6];

function slotBox(name: string, slot: { x: number; y: number }, axisDeg: number, [s0, s1]: [number, number], [u0, u1]: [number, number], [z0, z1]: [number, number]): Part {
  const a = (axisDeg * Math.PI) / 180;
  const positions = new Float32Array(24);
  for (let i = 0; i < 8; i++) {
    const s = i & 1 ? s1 : s0;
    const u = i & 2 ? u1 : u0;
    const z = i & 4 ? z1 : z0;
    positions.set([slot.x + s * Math.cos(a) + u * Math.sin(a), slot.y - s * Math.sin(a) + u * Math.cos(a), z], i * 3);
  }
  return { name, role: "mountPlate", mesh: { positions, indices: new Uint32Array(BOX_TRIANGLES_OUTWARD_CCW) } as CoilMesh, printTransform: { rotateX: 0, translate: [0, 0, 0] } };
}

interface RimClipFocus {
  slot: { x: number; y: number };
  target: THREE.Vector3;
}

const CLIP_ABOVE_RIM_MM = 3;

function rimClipFocus(design: Design): RimClipFocus | undefined {
  const board = design.pegboard!;
  const clip = design.parts.find((p) => p.name === "skadis-top-clip-1") ?? design.parts.find((p) => p.role === "mountClip");
  if (!clip) return undefined;
  const a = (board.axisDeg * Math.PI) / 180;
  const alongUp = (x: number, y: number) => x * Math.sin(a) + y * Math.cos(a);
  const middle = meshBounds(clip.mesh).getCenter(new THREE.Vector3());
  const slot = board.slots.reduce((best, c) => (Math.hypot(c.x - middle.x, c.y - middle.y) < Math.hypot(best.x - middle.x, best.y - middle.y) ? c : best));
  const corePos = corePart(design).mesh.positions;
  let rimUp = -Infinity;
  for (let i = 0; i < corePos.length; i += 3) rimUp = Math.max(rimUp, alongUp(corePos[i], corePos[i + 1]));
  const sideAt = middle.x * Math.cos(a) - middle.y * Math.sin(a);
  const upAt = rimUp + CLIP_ABOVE_RIM_MM;
  return { slot, target: new THREE.Vector3(upAt * Math.sin(a) + sideAt * Math.cos(a), upAt * Math.cos(a) - sideAt * Math.sin(a), middle.z) };
}

function RimClipInset({ design, focus }: { design: Design; focus: RimClipFocus }) {
  const board = design.pegboard!;
  const half = board.slotLength / 2;
  const z: [number, number] = [board.frontZ - board.thickness, board.frontZ];
  const boardParts = [
    slotBox("board-above", focus.slot, board.axisDeg, [0, RIM_INSET_BOARD_DEPTH_MM], [half, half + RIM_INSET_BOARD_REACH_MM], z),
    slotBox("board-below", focus.slot, board.axisDeg, [0, RIM_INSET_BOARD_DEPTH_MM], [-half - RIM_INSET_BOARD_REACH_MM, -half], z),
  ];
  const rotation = wallSideRotation(design.mountAxisDeg);
  const parts = rotateParts([...design.parts, ...boardParts], rotation);
  const fit = computeGuideFit(parts, "iso", RIM_INSET_FILL);
  if (!fit) return null;
  const at = projectToFigure(fit, rotatePoint(focus.target, rotation));
  const zoom = zoomForWindowMm(fit, RIM_INSET_SIZE_PX, RIM_INSET_WINDOW_MM);
  return <ZoomInset parts={parts} preset="iso" fill={RIM_INSET_FILL} at={at} zoom={zoom} size={RIM_INSET_SIZE_PX} corner="top-right" />;
}

const TCLIP_INSET_WINDOW_MM = 22;

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
  const hasPlate = !!platePart(design) && !!design.pegboard;
  const clip = design.innerEndClip;
  const faceInner = design.faceChannels?.inner !== undefined;
  const faceOuter = design.faceChannels?.outer !== undefined;
  const hasBase = clip !== undefined;
  const hasThread = hasBase || faceInner;
  const windN = hasThread ? 3 : 2;
  const capN = windN + 1;
  const capStepCount = topCapEnabled ? 2 : 0;
  const outerFaceN = capN + capStepCount;
  const plateN = outerFaceN + (faceOuter ? 1 : 0);
  const mountN = plateN + (hasPlate ? 1 : 0);
  const unwindN = hasBase ? mountN + 1 : mountN;
  const summary = ["Print", "thread", "wind", ...(topCapEnabled ? ["fit the cap"] : []), ...(hasBase ? ["mount it"] : [])].join(", ");
  return (
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
        <p>{summary}.</p>
      </header>
      <StepPrintParts design={design} />
      {clip && <StepThreadInnerEnd design={design} n={2} clip={clip} />}
      {faceInner && <StepThreadFaceInnerEnd design={design} n={2} />}
      <StepWind design={design} n={windN} />
      {topCapEnabled && <StepFitCap design={design} n={capN} />}
      {topCapEnabled && <StepSecureOuterEnd design={design} n={capN + 1} />}
      {faceOuter && <StepLayOuterEndFace design={design} n={outerFaceN} />}
      {hasPlate && <StepFitPlate design={design} n={plateN} />}
      {hasBase && <StepMount design={design} n={mountN} />}
      <StepUnwind design={design} n={unwindN} />
    </div>
  );
}
