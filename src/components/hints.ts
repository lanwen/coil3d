// Plain-English hint text for every control (issue #53), plus a few result
// rows (issue #65) whose numbers are easy to misread side by side. Kept in
// this one module, separate from the field/row components that render it,
// so the text is easy to find and edit without touching any component
// markup. Each entry is shown by an (i) button next to its control or row
// (see Hint.tsx) and stays short: 1-3 plain sentences, active voice, no
// jargon left undefined.
//
// Keys match the field/row's own `testId` (ControlsForm.tsx/App.tsx,
// ResultPanel.tsx), so a hint is easy to look up from the control or row
// that uses it.

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
    "This is the size of the core, in millimetres. Lock it to set an exact size, or leave it free and let the solver pick a size that fits your cable. The cable's bend limit sets a minimum size. For a square or triangle core, a stiffer or thicker cable needs bigger rounded corners, so the minimum size can be bigger than for a round core.",
  height: "This is how tall the core stands, in millimetres. Lock it to set an exact height, or leave it free and let the solver pick one.",
  layers:
    "This is how many layers of cable the coil has. A layer is one full row of turns from the bottom of the core to the top; the next layer winds on top of it. Lock it to set an exact count, or leave it free.",
  mount:
    "This adds a way to hang the coil on a wall: a screw keyhole (hang it, then slide down to seat), plain through-holes (screw straight through, no sliding), or clips for an IKEA SKÅDIS pegboard: rim clips that hook into the board's slots and grip the flange's rim, or T-clips that pass through lugs on the rim and twist a quarter turn to lock (no glue either way).",
  skadisLatch:
    "The top clip gets a small spring tooth that clicks into its slot, so pulling the cable can't lift the coil off the board. To take the coil down, lift the top clip firmly. Turn it off for a plain hook.",
  keyholeRotation: "This rotates the keyhole slot's own position on the core, in fixed steps. The coil still hangs level at every setting -- only which side faces up changes.",
  throughHoleDiameter: "This is the diameter of the screw-shank holes drilled straight through the flange. Match it to the screws you plan to mount with.",
  windingQuality:
    "This sets how tightly each layer's turns nest into the layer below it. Stacked (0) lines every turn up directly above the turn beneath it. Orthocyclic (1, the tightest packing) settles every turn into the valley between two turns below, so more cable fits in the same space.",
  options:
    "When two or more of core size, height and layers are free, more than one design holds your cable. \"Smallest\" takes up the least space; \"Even proportions\" is about as wide as it is tall. With all three free, the options differ in layer count, and picking one locks its height and layers.",
  topCap:
    "This controls whether the coil gets a flat lid on top. Until you touch this switch it stays in auto mode (tagged \"auto\"), turning the cap on once there is more than one layer of cable; the switch always shows that current on/off state. Touch it and it becomes an explicit override, saved in the link -- use \"Reset to auto\" to go back.",
  joint: "This is how the top cap attaches to the core: pressed on, twisted into a bayonet lock, or snapped on with printable clips. All three are meant to be permanent, once assembled.",
  tolerance: "This is the extra gap added to every joint so printed parts fit together. Raise it if your printer runs a bit oversized. Lower it for a tighter fit.",
  label: "This is text engraved into the top cap, for example the cable type or length. Leave it blank for no label.",
  bedX: "This is your 3D printer's build volume along the X axis, in millimetres. The design warns you when a part is too big to print in one piece.",
  bedY: "This is your 3D printer's build volume along the Y axis, in millimetres. The design warns you when a part is too big to print in one piece.",
  bedZ: "This is your 3D printer's build volume along the Z axis, in millimetres. The design warns you when a part is too big to print in one piece.",
  wire: "This shows or hides the schematic cable path wound around the core in the 3D view. It does not change the printed design.",
  dimensions: "This shows or hides the overall width, depth and height, in centimetres, drawn around the 3D view. It does not change the printed design.",
  exploded: "This pulls the parts apart in the 3D view so you can see how they fit together. It does not change the printed design.",
  projection:
    "Off shows an isometric view with no depth distortion, like an assembly manual. On shows a perspective view, like a photo.",
  // Result-panel rows (issue #65): the wound cable's own outer size and the
  // flange's two outer-extent rows read as unrelated numbers unless a hint
  // spells out which of them are actually measured the same way.
  envelope:
    "This is the wound cable's own outer size, at its widest point. For a square or triangle core, that's measured across the corners, so compare it to the flange's own \"across corners\" number below, not the narrower \"Flange width\" (measured across flats). The flange is sized to clear this.",
  flange:
    "This is the flange's real outer size, measured across its flat sides. For a square or triangle core that's the narrower of its two extents, so it reads smaller than the cable's own outer size above -- compare against \"Flange width (across corners)\" below instead.",
  flangeAcrossCorners:
    "This is the flange's real outer size measured across its corners, the wider of its two extents -- the same way the cable's own outer size above is measured, so the two are directly comparable.",
} as const;

export type HintKey = keyof typeof HINTS;
