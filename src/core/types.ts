import type { WallSpec } from "./wall";
import type { FlangeSpec } from "./manifold";
import type { RimSlot } from "./innerEnd";
import type { StrapNotch } from "./strapNotch";
import type { FaceChannelLayout } from "./faceChannel";

export type { ShapeKind } from "./shapes";

export type ShapeSpec = { kind: "round" } | { kind: "sq"; cornerRadius: number } | { kind: "tri"; cornerRadius: number };

export type TopCapMode = "auto" | "on" | "off";

export type BaseMode = "on" | "off";

export type JointKind = "press" | "bayonet" | "snap";

export type WireTypeId = "usb" | "flex" | "stiff" | "custom";

export interface WireTypePreset {
  id: WireTypeId;
  label: string;
  bendMultiplier: number;
}

export const WIRE_TYPE_PRESETS: Record<Exclude<WireTypeId, "custom">, WireTypePreset> = {
  usb: { id: "usb", label: "USB / audio cable", bendMultiplier: 2.6 },
  flex: { id: "flex", label: "Flexible cord", bendMultiplier: 2.6 },
  stiff: { id: "stiff", label: "Stiff / solid cord", bendMultiplier: 6.5 },
};

export const DEFAULT_CUSTOM_BEND_MULTIPLIER = 2.6;

export interface WireSpec {
  length: number;
  diameter: number;
  type: WireTypeId;
  customBendMultiplier?: number;
}

export function bendMultiplierOf(wire: WireSpec): number {
  if (wire.type === "custom") return wire.customBendMultiplier ?? DEFAULT_CUSTOM_BEND_MULTIPLIER;
  return WIRE_TYPE_PRESETS[wire.type].bendMultiplier;
}

export type Lock<T> = { locked: true; value: T } | { locked: false };

export type CoreSizeLock = { locked: true; dimension: "outer" | "inner"; value: number } | { locked: false };

export type Objective = "minVolume" | "aspectRatio";

export interface PrintSpec {
  bedX: number;
  bedY: number;
  bedZ: number;
}

export type MountKind = "none" | "keyhole" | "through" | "skadis" | "skadis-tclip" | "opengrid";

export type KeyholeRotation = 0 | 45;

export type PlateJoint = "glue" | "snap";

export interface CoilSpec {
  wire: WireSpec;
  shape: ShapeSpec;
  windingQuality: number;
  coreSize: CoreSizeLock;
  height: Lock<number>;
  layers: Lock<number>;
  objective: Objective;
  base?: BaseMode;
  topCap: TopCapMode;
  joint: JointKind;
  tolerance: number;
  print: PrintSpec;
  label?: string;
  mount: MountKind;
  plateJoint: PlateJoint;
  skadisLatch?: boolean;
  strapSlots?: boolean;
  keyholeRotation?: KeyholeRotation;
  throughHoleDiameter?: number;
}

export interface Notice {
  severity: "problem" | "note";
  message: string;
}

export function noticeCollector() {
  const notices: Notice[] = [];
  return {
    notices,
    problem: (message: string) => void notices.push({ severity: "problem", message }),
    note: (message: string) => void notices.push({ severity: "note", message }),
  };
}

export interface LayerResult {
  layer: number;
  turns: number;
  offset: number;
  perimeter: number;
  length: number;
}

export interface Diagnosis {
  freeCount: 0 | 1 | 2 | 3;
  freeVariables: Array<"coreSize" | "height" | "layers">;
  status: "ok" | "over-constrained" | "under-constrained" | "infeasible";
  message: string;
}

export interface FlangeExtent {
  acrossFlats: number;
  acrossCorners: number;
}

export interface Solution {
  diagnosis: Diagnosis;
  objectiveUsed?: Objective;
  outerSize: number;
  cornerRadius: number;
  cornerRadiusRange: [bendLimitFloor: number, usefulMax: number];
  innerBore: number;
  height: number;
  layers: number;
  layerResults: LayerResult[];
  totalWoundLength: number;
  totalWireLength: number;
  targetWireLength: number;
  lengthDeltaPct: number;
  capacityRange: [stacked: number, orthocyclic: number];
  envelopeDiameter: number;
  flangeSize: number;
  overallHeight?: number;
  flangeExtent?: FlangeExtent;
  topCapEnabled: boolean;
  minOuterSizeForBend: number;
  minOuterSizeForShape: number;
  alternates: Solution[];
}

export interface CoilMesh {
  positions: Float32Array;
  indices: Uint32Array;
  labelTriangles?: Uint32Array;
  rimTriangles?: { chamfer: Uint32Array; land: Uint32Array };
  fadeTriangles?: Uint32Array;
}

export interface WireLayerPath {
  layer: number;
  turns: number;
  points: Float32Array;
}

export type PartRole = "core" | "topCap" | "mountPlate" | "peg" | "mountClip";

export interface RigidTransform {
  rotateZ?: number;
  rotateX: number;
  translate: [number, number, number];
}

export interface Part {
  name: string;
  role: PartRole;
  mesh: CoilMesh;
  printTransform: RigidTransform;
}

export interface PegboardSection {
  slots: Array<{ x: number; y: number }>;
  slotWidth: number;
  slotLength: number;
  thickness: number;
  frontZ: number;
  axisDeg: number;
}

export interface Design {
  spec: CoilSpec;
  solution: Solution;
  notices: Notice[];
  warnings: string[];
  fitsBed: boolean;
  labelFit?: { fits: boolean; maxChars: number };
  parts: Part[];
  mesh: CoilMesh;
  resolution: Resolution;
  wirePaths: WireLayerPath[];
  wallSpec: WallSpec;
  flangeSpec: FlangeSpec;
  mountAxisDeg?: number;
  pegboard?: PegboardSection;
  innerEndLeadIn: Float32Array;
  innerEndClip?: { from: { x: number; y: number; z: number }; to: { x: number; y: number; z: number } };
  layerTransitions: Float32Array[];
  outerEndLeadOut: Float32Array;
  cablePath: Float32Array;
  rimSlots: { base?: RimSlot; cap?: RimSlot };
  strapNotches: { base: StrapNotch[]; cap: StrapNotch[]; mountPlate: StrapNotch[] };
  faceChannels?: FaceChannelLayout;
}

export type ExportFormat = "stl" | "step" | "3mf";

export type Resolution = "draft" | "final";
