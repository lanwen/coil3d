import { describe, expect, it } from "vitest";
import { design, exportDesign, parseHash } from "../src/core";
import type { StepProgress } from "../src/core";
import { STEP_TIMEOUT_MS } from "./support/step";

const hashOf = (doc: object) => `#s=${Buffer.from(JSON.stringify({ v: 2, L: 1500, d: 3.8, lock: ["outer", "h"], size: 40, h: 25, ...doc })).toString("base64url")}`;

async function exportWithProgress(doc: object) {
  const d = await design(parseHash(hashOf(doc)).spec);
  const events: StepProgress[] = [];
  const bytes = await exportDesign(d, "step", { onProgress: (event) => events.push(event) });
  return { d, events, bytes };
}

describe.sequential("STEP export progress (issue #396)", () => {
  it(
    "reports the plan first, then every planned stage in order, before the bytes arrive",
    async () => {
      const { d, events, bytes } = await exportWithProgress({ mount: "skadis-tclip" });
      expect(bytes.byteLength).toBeGreaterThan(0);
      const [plan, ...stages] = events;
      expect(plan.kind).toBe("plan");
      if (plan.kind !== "plan") return;
      expect(stages.every((e) => e.kind === "stage")).toBe(true);
      expect(stages.map((e) => (e.kind === "stage" ? e.id : ""))).toEqual(plan.stages.map((s) => s.id));
      expect(plan.stages.map((s) => s.id)).toEqual(["engine", "wall", "flange", "join", "joints", "tclips", "write"]);
      expect(plan.stages.find((s) => s.id === "tclips")?.count).toBe(d.parts.filter((p) => p.role === "mountClip").length);
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "plans the top cap only for a design that has one, and no plate or clip stage without them",
    async () => {
      const { d, events } = await exportWithProgress({ mount: "keyhole", cap: "on" });
      expect(d.parts.map((p) => p.role)).toEqual(["core", "topCap"]);
      const ids = events.flatMap((e) => (e.kind === "plan" ? e.stages.map((s) => s.id) : []));
      expect(ids).toContain("topCap");
      expect(ids).not.toContain("mountPlate");
      expect(ids).not.toContain("tclips");
      expect(ids).not.toContain("clips");
      expect(ids).not.toContain("pegs");
    },
    STEP_TIMEOUT_MS,
  );

  it("rejects with an AbortError when the signal is already aborted", async () => {
    const d = await design(parseHash("").spec);
    await expect(exportDesign(d, "step", { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("leaves STL and 3MF exports unchanged when given options", async () => {
    const d = await design(parseHash("").spec);
    const seen: StepProgress[] = [];
    const options = { onProgress: (e: StepProgress) => seen.push(e) };
    expect(await exportDesign(d, "stl", options)).toEqual(await exportDesign(d, "stl"));
    expect((await exportDesign(d, "3mf", options)).byteLength).toBe((await exportDesign(d, "3mf")).byteLength);
    expect(seen).toEqual([]);
  });
});
