// The coil core orchestrator: solves the spec (solve.ts) then builds the
// round, grooved wall and fuses the bottom flange (docs/research.md §4).
// The geometry itself is unchanged from the tracer bullet (#2): it still
// renders only the layer-1 groove on a single wall; layers beyond the first
// only affect the solved numbers and the flange size (the flange must clear
// every wound layer, not just the core's own wall). The top cap for
// multi-layer coils is ticket #9.
//
// `wallSpec`/`flangeSpec` are stashed on the returned Design so the STEP
// exporter (issue #11, src/core/step/build.ts) can fit its B-spline from
// the exact same parametric grid the mesh backend used -- the two backends
// must never drift apart (docs/research.md "STEP").
//
// `resolution` (issue #7) only ever changes the mesh's column/row density
// (see constants.ts); the solved numbers, warnings and wall/flange specs are
// identical between draft and final for the same spec.
//
// `wirePaths` (issue #4) is the schematic wound-cable centerline per layer,
// built from the exact same wallSpec/layerResults used above so it can never
// drift from the printed groove or the solved turns/offsets (see wire.ts).
// It doesn't depend on `resolution` beyond the wallSpec fields it reads.

import {
  CAP_THICKNESS,
  FLANGE_MARGIN,
  FLANGE_THICKNESS,
  GROOVE_DEPTH_FACTOR,
  MARGIN,
  MIN_BORE_CORNER_RADIUS,
  MIN_BORE_RADIUS,
  MIN_FLANGE_THICKNESS_FOR_SCREW_MOUNT,
  FINAL_ROWS_PER_PITCH,
  FINAL_COLUMNS,
  DRAFT_ROWS_PER_PITCH,
  DRAFT_COLUMNS,
  TAPER_TURNS,
  CLEARANCE,
  WALL_THICKNESS,
} from "./constants";
import { buildTopCap, fuseFlange } from "./manifold";
import type { CoreJointCut } from "./manifold";
import { printBBox } from "./plate";
import { layoutKeyholeMount, requiredFlangeMargin } from "./mount";
import type { MountLayout } from "./mount";
import { circumscribedRadius, makeOutline } from "./shapes";
import type { ShapeOutline } from "./shapes";
import { resolveLabel } from "./label";
import { solve } from "./solve";
import type { CoilSpec, Design, Part, Resolution } from "./types";
import { buildWall } from "./wall";
import { buildWirePaths } from "./wire";

export async function design(spec: CoilSpec, resolution: Resolution = "final"): Promise<Design> {
  const { solution, warnings } = solve(spec);
  const columns = resolution === "draft" ? DRAFT_COLUMNS : FINAL_COLUMNS;
  const rowsPerPitch = resolution === "draft" ? DRAFT_ROWS_PER_PITCH : FINAL_ROWS_PER_PITCH;

  const outline = makeOutline(spec.shape.kind, solution.outerSize, solution.cornerRadius);

  // The bore is a TRUE inward offset of the wall's own outline by the wall
  // thickness (issue #6 AC: "the triangle wall is computed from the true
  // inward offset", not `outer - 2*wall`): both apothem and corner radius
  // shrink by the same amount (Steiner), floored so the outline never
  // inverts (spikes/s1-grooved-wall/geom.ts's `boreMinCornerR`).
  let boreApothem = outline.apothem - WALL_THICKNESS;
  if (boreApothem < MIN_BORE_RADIUS) {
    warnings.push(`Core size ${solution.outerSize.toFixed(1)} mm is too small for a ${WALL_THICKNESS} mm wall; the bore has been reduced.`);
    boreApothem = MIN_BORE_RADIUS;
  }
  // Round's defining invariant is apothem === cornerRadius (see shapes.ts);
  // apothem and corner radius are floored independently above/below (they
  // guard different things -- MIN_BORE_RADIUS keeps a printable bore at
  // all, MIN_BORE_CORNER_RADIUS keeps a non-round bore's corner from
  // folding), so at the small end they can hit different floors and break
  // that invariant. Preserve it explicitly for round, or a tiny locked core
  // would get a very-slightly-square bore instead of a circle.
  const isRound = outline.cornerRadius === outline.apothem;
  const boreCornerRadius = isRound ? boreApothem : Math.min(Math.max(outline.cornerRadius - WALL_THICKNESS, MIN_BORE_CORNER_RADIUS), boreApothem);
  const boreOutline: ShapeOutline = { n: outline.n, apothem: boreApothem, cornerRadius: boreCornerRadius };

  const wireDiameter = spec.wire.diameter;
  const grooveDepth = GROOVE_DEPTH_FACTOR * wireDiameter;
  const layer1Turns = solution.layerResults[0]?.turns ?? 0;

  const wallSpec = {
    outline,
    boreOutline,
    height: solution.height,
    wireDiameter,
    clearance: CLEARANCE,
    grooveDepth,
    marginBottom: MARGIN,
    marginTop: MARGIN,
    taperTurns: TAPER_TURNS,
    turns: layer1Turns,
    columns,
    rowsPerPitch,
  };
  const wantsKeyhole = spec.mount === "keyhole";

  // The flange must clear the outermost wound layer, not just the core's
  // own wall (docs/research.md §1 "Flange size = final outer envelope +
  // margin"): solution.flangeSize already accounts for every layer, so the
  // effective margin beyond the core's own outline grows with layer count.
  // circumscribedRadius(outline, margin) === circumscribedRadius(outline, 0) + margin
  // (the offset term is additive, see shapes.ts), so this margin is exactly
  // what's needed for the flange's own circumscribed radius to reach
  // solution.flangeSize / 2.
  const baseMargin = Math.max(FLANGE_MARGIN, solution.flangeSize / 2 - circumscribedRadius(outline, 0));
  // Issue #13: the screw-keyhole mount needs a flange annulus (wall
  // thickness + margin) wide enough to hold the whole slot, and a flange
  // thick enough for the recess + a load-bearing shelf above it. Bump both
  // up to the required minimum and warn, rather than silently skipping the
  // mount ("The flange must be thick enough for the recess; enforce a
  // minimum and warn" -- the ticket's own wording, applied to both the
  // radial and axial minimums a real screw mount needs).
  const margin = wantsKeyhole ? Math.max(baseMargin, requiredFlangeMargin(outline, boreOutline)) : baseMargin;
  const thickness = wantsKeyhole ? Math.max(FLANGE_THICKNESS, MIN_FLANGE_THICKNESS_FOR_SCREW_MOUNT) : FLANGE_THICKNESS;
  if (wantsKeyhole && margin > baseMargin) {
    warnings.push(`Flange margin increased to ${margin.toFixed(1)} mm to fit the screw-keyhole mount.`);
  }
  if (wantsKeyhole && thickness > FLANGE_THICKNESS) {
    warnings.push(`Flange thickness increased to ${thickness.toFixed(1)} mm to fit the recessed screw-keyhole mount.`);
  }
  // Kept (not just its warning) so it can be surfaced on the returned
  // Design below: a consumer that wants to actually SHOW the mount's real
  // hung orientation -- not just cut it -- needs `axisDeg` too (see
  // mount.ts's own MountLayout doc comment).
  let mountLayout: MountLayout | undefined;
  if (wantsKeyhole) {
    mountLayout = layoutKeyholeMount(outline, boreOutline, margin);
    if (mountLayout.warning) warnings.push(mountLayout.warning);
  }

  const flangeSpec = {
    outline,
    boreOutline,
    margin,
    thickness,
    columns,
    mount: spec.mount,
  };

  // Top cap (issue #9): `solution.topCapEnabled` (solve.ts) already resolved
  // the spec's auto|on|off override against the automatic recommendation
  // (capsAuto, on when layers > 1). Only bayonet/snap need a core-side cut
  // (a mating groove or retaining ridge in the top rim); press engages the
  // bore's own existing surface directly, so the core mesh is byte-for-byte
  // unchanged whenever the top cap is off OR the joint is "press" -- see
  // manifold.ts's CoreJointCut.
  const topCapEnabled = solution.topCapEnabled;
  const coreJoint: CoreJointCut | undefined =
    topCapEnabled && spec.joint !== "press"
      ? { boreOutline, height: solution.height, joint: spec.joint, tolerance: spec.tolerance }
      : undefined;

  const wall = buildWall(wallSpec);
  const coreMesh = await fuseFlange(wall, flangeSpec, coreJoint);

  const parts: Part[] = [{ name: "core", role: "core", mesh: coreMesh, printTransform: { rotateX: 0, translate: [0, 0, 0] } }];

  // Top cap label (issue #12): resolved against the SAME outline/boreOutline/
  // flange margin the STEP backend re-derives from `wallSpec`/`flangeSpec`
  // (step/build.ts calls the same `resolveLabel`), so the two backends can
  // never fit the text differently -- mirrors how CoreJointCut/wallSpec/
  // flangeSpec already keep the mesh and STEP walls from drifting.
  const { label, warning: labelWarning } = await resolveLabel(spec.label, outline, boreOutline, flangeSpec.margin, topCapEnabled);
  if (labelWarning) warnings.push(labelWarning);

  if (topCapEnabled) {
    const capMesh = await buildTopCap({ flange: flangeSpec, joint: spec.joint, tolerance: spec.tolerance, wireDiameter, label });
    // `capMesh` is built in a LOCAL frame (plate z=[0, CAP_THICKNESS], collar
    // reaching down to z=-JOINT_ENGAGE_DEPTH); translating by `height` lands
    // it in the shared assembly frame, flush against the wall's top rim.
    const assembled = translateMesh(capMesh, [0, 0, solution.height]);
    // Print orientation: flip 180 deg about X so the joint boss/lugs/hooks
    // (pointing down in the assembled frame) print pointing UP with no
    // overhang, and the flat plate face -- not the boss -- sits on the bed.
    // After the flip, the assembled z-range [height, height+CAP_THICKNESS]
    // (the plate, previously the TOP) becomes the new bottom; translating by
    // its negation lands that new bottom at z=0 (see types.ts's RigidTransform).
    parts.push({
      name: "top-cap",
      role: "topCap",
      mesh: assembled,
      printTransform: { rotateX: Math.PI, translate: [0, 0, solution.height + CAP_THICKNESS] },
    });
  }

  const mesh = parts[0].mesh;
  const wirePaths = buildWirePaths(solution.layerResults, wallSpec, spec.windingQuality, resolution);

  // Per-part bed-fit warnings (issue #10 AC): each part in ITS OWN print
  // orientation (printBBox reads printTransform, same as the STL/3MF
  // exporters) against the user's bed size. No auto-rotation-to-fit is
  // attempted -- docs/research.md "Out of scope": the bed size only ever
  // triggers a warning, never an automatic layout/orientation change.
  //
  // `partHeight` is a max-min span, so it's unaffected by the 3MF plate
  // layout's per-part Z snap (plate.ts's `layoutParts`: `dz = -minZ`) --
  // that snap only moves WHERE min Z lands (0), not how tall the part
  // is -- so this is already the same height that ends up printed between
  // z=0 and z=bedZ on the actual plate.
  for (const part of parts) {
    const box = printBBox(part);
    const footprintX = box.maxX - box.minX;
    const footprintY = box.maxY - box.minY;
    const partHeight = box.maxZ - box.minZ;
    if (footprintX > spec.print.bedX || footprintY > spec.print.bedY) {
      warnings.push(
        `Part "${part.name}" footprint (${footprintX.toFixed(1)} x ${footprintY.toFixed(1)} mm) doesn't fit the ${spec.print.bedX} x ${spec.print.bedY} mm bed.`,
      );
    }
    if (partHeight > spec.print.bedZ) {
      warnings.push(`Part "${part.name}" height (${partHeight.toFixed(1)} mm) is taller than the ${spec.print.bedZ} mm bed.`);
    }
  }

  return { spec, solution, warnings, parts, mesh, resolution, wirePaths, wallSpec, flangeSpec, mountAxisDeg: mountLayout?.axisDeg };
}

/** A copy of `mesh` with every vertex shifted by [dx, dy, dz]; `indices` is shared (never mutated). */
function translateMesh(mesh: { positions: Float32Array; indices: Uint32Array }, [dx, dy, dz]: [number, number, number]) {
  const positions = new Float32Array(mesh.positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] = mesh.positions[i] + dx;
    positions[i + 1] = mesh.positions[i + 1] + dy;
    positions[i + 2] = mesh.positions[i + 2] + dz;
  }
  return { positions, indices: mesh.indices };
}
