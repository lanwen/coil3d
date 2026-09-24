// Shared joint-geometry numbers (issue #9, docs/research.md §1 "Cap joint" &
// §4 "Joints / tolerances"): both the mesh backend (manifold.ts, via
// manifold-3d primitives) and the STEP backend (step/build.ts, via
// replicad/OCCT primitives) derive their joint dimensions from this ONE
// function, so the two backends can never drift apart on fit -- mirroring
// how wallSpec/flangeSpec keep the mesh and STEP walls from drifting.
//
// All three joints share one circular engagement collar centered on the
// coil axis, regardless of the core's own cross-section (round/sq/tri): a
// circular collar is simple, always manifold, and needs only the one global
// `tolerance` the ticket asks for. For a non-round bore the collar contacts
// the bore's flat sides, not its corners -- a normal, printable press/twist/
// snap fit, not a defect.

import { JOINT_FIT_GAP, BAYONET_GAP, SNAP_GAP } from "./constants";
import { inscribedRadius } from "./shapes";
import type { ShapeOutline } from "./shapes";
import type { JointKind } from "./types";

export interface JointGeometry {
  /** The bore's own inscribed (flat-side) radius, mm -- the collar's absolute ceiling. */
  boreRadius: number;
  /** The engagement collar's nominal radius before the per-kind fit clearance: the bore's inscribed radius, minus a fixed gap so a non-round bore's corners are never touched. */
  jointRadius: number;
  /** The collar/finger OD actually used, after `tolerance` and (for bayonet/snap) the extra sliding/flex clearance those joints need. */
  collarRadius: number;
}

export function jointGeometry(boreOutline: ShapeOutline, kind: JointKind, tolerance: number): JointGeometry {
  const boreRadius = inscribedRadius(boreOutline, 0);
  const jointRadius = Math.max(2, boreRadius - JOINT_FIT_GAP);
  const collarRadius =
    kind === "press"
      ? Math.max(1, jointRadius - tolerance)
      : kind === "bayonet"
        ? Math.max(1, jointRadius - BAYONET_GAP - tolerance)
        : Math.max(1, jointRadius - SNAP_GAP - tolerance);
  return { boreRadius, jointRadius, collarRadius };
}
