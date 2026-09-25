// Plain-English hint text for every control (issue #53). Kept in this one
// module, separate from the field components that render it, so the text is
// easy to find and edit without touching any component markup. Each entry is
// shown by an (i) button next to its control (see Hint.tsx) and stays short:
// 1-3 plain sentences, active voice, no jargon left undefined.
//
// Keys match the field's own `testId` (ControlsForm.tsx/App.tsx), so a hint
// is easy to look up from the control that uses it.

export const HINTS = {
  wireLength:
    "This is the total length of cable the coil must hold, in centimetres. The solver sizes the coil so it has room for this length.",
  wireDiameter: "This is the outer width of your cable, measured straight across it. A wrong diameter makes the groove too tight or too loose for the cable.",
  wireType: "This tells the solver your cable's minimum bend radius: the tightest turn the cable can make before it kinks. USB and audio cables bend tighter than stiff cords, so they allow a smaller core.",
  customMultiplier: "This sets the cable's minimum bend radius as a multiple of its diameter. It is used only when the cable type is set to Custom.",
  shape: "This sets the cross-section of the core: round, a rounded square, or a rounded triangle. The core is the tube the cable wraps around.",
  shapeCornerRadius:
    "This is the radius of the rounded corners on a square or triangle core. The solver limits it so a corner never bends the cable past its minimum bend radius.",
  coreSizeDimension:
    "This chooses which core measurement you lock: the outer size (the winding surface) or the inner bore (the hollow center). The solver then works out the other one for you.",
  outer:
    "This is the size of the core, in millimetres. Lock it to set an exact size, or leave it free and let the solver pick a size that fits your cable. For a square or triangle core, a stiffer cable needs bigger rounded corners, so the minimum size can be bigger than for a round core.",
  height: "This is how tall the core stands, in millimetres. Lock it to set an exact height, or leave it free and let the solver pick one.",
  layers: "This is how many times the cable wraps around the core, one layer stacked on the next. Lock it to set an exact count, or leave it free.",
  mount: "This adds a way to hang the coil on a wall: a screw keyhole, or a clip plate for an IKEA SKÅDIS pegboard.",
  plateJoint: "This sets how the clip plate attaches to the core: glued on with small alignment pegs, or snapped on with printable tabs.",
  windingQuality:
    "This sets how tightly each layer nests into the layer below it. Stacked (0) lines each turn up directly above the last. Orthocyclic (1, the tightest packing) nests each turn into the valley between two turns below, so more cable fits in the same space.",
  objective:
    "When two or more dimensions are free, more than one design fits your cable. This picks which design the solver prefers: the smallest overall volume, or a shape close to a cube.",
  topCap: "This controls whether the coil gets a flat lid on top. Auto adds one only when there is more than one layer, so the cable does not spill over the top.",
  joint: "This is how the top cap attaches to the core: pressed on, twisted into a bayonet lock, or snapped on with printable clips. All three are meant to be permanent, once assembled.",
  tolerance: "This is the extra gap added to every joint so printed parts fit together. Raise it if your printer runs a bit oversized. Lower it for a tighter fit.",
  label: "This is text engraved into the top cap, for example the cable type or length. Leave it blank for no label.",
  bedX: "This is your 3D printer's build volume along the X axis, in millimetres. The design warns you when a part is too big to print in one piece.",
  bedY: "This is your 3D printer's build volume along the Y axis, in millimetres. The design warns you when a part is too big to print in one piece.",
  bedZ: "This is your 3D printer's build volume along the Z axis, in millimetres. The design warns you when a part is too big to print in one piece.",
  wire: "This shows or hides the schematic cable path wound around the core in the 3D view. It does not change the printed design.",
  exploded: "This pulls the parts apart in the 3D view so you can see how they fit together. It does not change the printed design.",
} as const;

export type HintKey = keyof typeof HINTS;
