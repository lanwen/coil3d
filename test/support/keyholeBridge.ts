/**
 * The keyhole mount's undercut roof is a flat bridge as wide as the screw
 * head (8 mm), accepted by design (maintainer decision, #175): most printers
 * bridge this span, and a 45 degree roof would need a 3.5 mm thicker pad.
 * Both test/printability.test.ts and test/mount.test.ts hold the roof to
 * this span (the head width plus a small margin), so it can't grow unnoticed.
 */
export const KEYHOLE_ROOF_MAX_SPAN = 8.5; // mm
