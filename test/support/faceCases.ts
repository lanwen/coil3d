import { design, parseHash } from "../../src/core";
import type { CoilSpec, Design } from "../../src/core";

export const D1_HASH = "#s=eyJ2IjoyLCJMIjoxNzIwLCJkIjozLCJzaGFwZSI6InNxIiwic2l6ZSI6NTAsImxvY2siOlsib3V0ZXIiXSwiY2FwIjoib2ZmIiwiam9pbnQiOiJzbmFwIn0";

export const base: CoilSpec = parseHash(D1_HASH).spec;

export interface Case {
  name: string;
  spec: CoilSpec;
}

export function variant(name: string, overrides: Partial<CoilSpec>, layers = 1): Case[] {
  return (["off", "on"] as const).map((plates) => ({ name: `${name}, base ${plates}`, spec: { ...base, layers: { locked: true, value: layers }, ...overrides, base: plates } }));
}

export const CASES: Case[] = [
  ...variant("D1 square 50 mm, 1 layer", {}),
  ...variant("HDMI 7 mm square, 1 layer", { wire: { length: 2500, diameter: 7, type: "usb" }, coreSize: { locked: false } }),
  ...variant("round, 1 layer", { shape: { kind: "round" } }),
  ...variant("triangle, 1 layer", { shape: { kind: "tri", cornerRadius: 12 } }),
  ...variant("square, 2 layers", {}, 2),
  ...variant("square, 3 layers", {}, 3),
  ...variant("pill, 1 layer", { shape: { kind: "pill", cornerRadius: 15 }, coreSize: { locked: true, dimension: "outer", value: 80 } }),
  ...variant("pill, 2 layers", { shape: { kind: "pill", cornerRadius: 15 }, coreSize: { locked: true, dimension: "outer", value: 80 } }, 2),
];

const designs = new Map<string, Promise<Design>>();
export function designOf({ name, spec }: Case): Promise<Design> {
  let d = designs.get(name);
  if (!d) designs.set(name, (d = design(spec)));
  return d;
}
