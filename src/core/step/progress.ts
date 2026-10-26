import type { Design } from "../types";

export type StepStageId = "engine" | "wall" | "flange" | "join" | "joints" | "topCap" | "mountPlate" | "clips" | "tclips" | "pegs" | "write";

export interface StepStage {
  id: StepStageId;
  count?: number;
}

export type StepProgress = { kind: "plan"; stages: StepStage[] } | { kind: "stage"; id: StepStageId };

export type StepProgressListener = (event: StepProgress) => void;

const countOf = (design: Design, role: Design["parts"][number]["role"]) => design.parts.filter((p) => p.role === role).length;

export function planStepStages(design: Design): StepStage[] {
  const { flangeSpec } = design;
  const clips = flangeSpec.skadis ? countOf(design, "mountClip") : 0;
  const tclips = flangeSpec.skadisTclip ? countOf(design, "mountClip") : 0;
  const pegs = countOf(design, "peg");
  const stages: StepStage[] = [{ id: "engine" }, { id: "wall" }];
  if (flangeSpec.thickness > 0) stages.push({ id: "flange" }, { id: "join" });
  stages.push({ id: "joints" });
  if (countOf(design, "topCap") > 0) stages.push({ id: "topCap" });
  if (countOf(design, "mountPlate") > 0) stages.push({ id: "mountPlate" });
  if (clips > 0) stages.push({ id: "clips", count: clips });
  if (tclips > 0) stages.push({ id: "tclips", count: tclips });
  if (pegs > 0) stages.push({ id: "pegs", count: pegs });
  stages.push({ id: "write" });
  return stages;
}

export type StepWorkerMessage = StepProgress | { kind: "done"; bytes: Uint8Array<ArrayBuffer> } | { kind: "error"; message: string };

export interface StepOptions {
  onProgress?: StepProgressListener;
  signal?: AbortSignal;
}
