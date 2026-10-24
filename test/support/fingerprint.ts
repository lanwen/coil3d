import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import type { Design } from "../../src/core";

/** The file `COIL3D_FINGERPRINT` names, or undefined when no fingerprint run is on. */
const FILE = process.env.COIL3D_FINGERPRINT;

const sha = (a?: ArrayBufferView) => (a ? createHash("sha256").update(new Uint8Array(a.buffer, a.byteOffset, a.byteLength)).digest("hex") : null);

/**
 * Appends one JSON line describing `d` to the file named by `COIL3D_FINGERPRINT`: a hash of each part's buffers and
 * its notices, label fit and strap slot note. Two runs over the same cases compare with `sort a | diff - <(sort b)`.
 * It does nothing when the variable is unset.
 */
export function recordFingerprint(name: string, d: Design): void {
  if (!FILE) return;
  const parts = d.parts.map((p) => ({
    role: p.role,
    name: p.name,
    positions: sha(p.mesh.positions),
    indices: sha(p.mesh.indices),
    labelTriangles: sha(p.mesh.labelTriangles),
    rimTriangles: p.mesh.rimTriangles ? { chamfer: sha(p.mesh.rimTriangles.chamfer), land: sha(p.mesh.rimTriangles.land) } : null,
  }));
  const problems = d.notices.filter((n) => n.severity === "problem").map((n) => n.message);
  const notes = d.notices.filter((n) => n.severity === "note").map((n) => n.message);
  appendFileSync(FILE, `${JSON.stringify({ name, parts, notes, problems, warnings: d.warnings, labelFit: d.labelFit ?? null, strapSlotsNote: d.strapSlotsNote ?? null })}\n`);
}
