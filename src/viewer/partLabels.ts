import type { Part } from "../core";

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

export function partLabel(part: Part): string {
  return PART_LABELS[part.name] ?? part.name;
}

export function mountClipsLabel(clips: Part[]): string {
  const kind = clips.every((p) => p.name.startsWith("skadis-tclip-")) ? T_CLIP : RIM_CLIP;
  return `${clips.length === 1 ? kind.one : kind.many} ×${clips.length}`;
}
