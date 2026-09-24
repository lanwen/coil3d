// Round-core convex-outline math (docs/research.md §2 ShapePlugin interface,
// §3 Steiner perimeter). Only round ships in this ticket; #6 turns this into
// a per-shape registry keyed by ShapeKind, with a corner-radius parameter.
// Every function here already matches the shape-generic contract research.md
// proposes (Steiner offset perimeter, uniform-offset size growth, footprint),
// so lifting it into a registry later is a rename, not a redesign.

/**
 * Steiner offset perimeter: P(o) = S + 2*pi*(cornerRadius + o). For a round
 * cross-section, S = 0 and cornerRadius = outerSize / 2 (the whole radius).
 */
export function offsetPerimeter(outerSize: number, o: number): number {
  return 2 * Math.PI * (outerSize / 2 + o);
}

/**
 * "size" (diameter) after a uniform outward Minkowski offset by `o`. A
 * uniform offset grows a round shape's diameter by exactly 2*o.
 */
export function growSize(size: number, o: number): number {
  return size + 2 * o;
}

/** Circumscribed footprint diameter -- for round this equals the (grown) size. */
export function footprintDiameter(size: number): number {
  return size;
}
