import { DEFAULT_CUSTOM_BEND_MULTIPLIER, WIRE_TYPE_PRESETS } from "../../src/core";
import type { WireSpec } from "../../src/core";

/** The tightest radius (mm) the cable may bend to: the wire type's multiplier times its diameter. */
export function minBendRadius(wire: WireSpec): number {
  const multiplier = wire.type === "custom" ? (wire.customBendMultiplier ?? DEFAULT_CUSTOM_BEND_MULTIPLIER) : WIRE_TYPE_PRESETS[wire.type].bendMultiplier;
  return multiplier * wire.diameter;
}
