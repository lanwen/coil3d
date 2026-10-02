import type { Part } from "../core";

// The parts' display names, shared by the guide's captions and the print
// layout's labels so the two can't drift apart (PR #226 review).

const T_CLIP = { one: "T-clip", many: "T-clips" };
const RIM_CLIP = { one: "Rim clip", many: "Rim clips" };

const PART_LABELS: Record<string, string> = {
  core: "Core",
  "top-cap": "Top cap",
  "mount-plate": "Mount plate",
  "peg-1": "Alignment peg",
  "skadis-top-clip-1": "Top clip",
  "skadis-bottom-clip-1": "Bottom clip",
  "skadis-tclip-1": T_CLIP.one,
};

/** A part's name for people ("T-clip", "Top clip"); its own name when it has none. */
export function partLabel(part: Part): string {
  return PART_LABELS[part.name] ?? part.name;
}

/** One label over all the SKÅDIS clips, naming their kind: "T-clips ×3", "Rim clips ×3". */
export function mountClipsLabel(clips: Part[]): string {
  const kind = clips.every((p) => p.name.startsWith("skadis-tclip-")) ? T_CLIP : RIM_CLIP;
  return `${clips.length === 1 ? kind.one : kind.many} ×${clips.length}`;
}
