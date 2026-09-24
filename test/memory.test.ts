import { describe, expect, it } from "vitest";
import { design } from "../src/core";
import type { CoilSpec } from "../src/core";

// Issue #7 AC: "WASM objects are freed; memory stays stable over 100
// consecutive designs." manifold-3d's WASM linear memory only grows, never
// shrinks (typical of a WASM allocator), so an object nobody `.delete()`d
// keeps consuming a fresh slice of it on every call; a leak therefore shows
// up as roughly linear RSS growth across iterations. Proper cleanup (every
// manifold.delete() -- see src/core/manifold.ts's `track`/`trash`) reaches a
// plateau instead, once the allocator's already-freed regions are large
// enough to satisfy every subsequent call, however many there are.
//
// This test measures that trend (a linear-regression slope across samples),
// not an absolute RSS number, and skips the first iterations (JIT warmup,
// one-time WASM heap growth) before sampling, so it stays robust rather than
// flaky: a single noisy GC pause moves one sample, not the fitted slope.

const spec: CoilSpec = {
  wire: { length: 1500, diameter: 3.2, type: "usb" },
  shape: { kind: "round" },
  windingQuality: 0.6,
  coreSize: { locked: true, dimension: "outer", value: 26 },
  height: { locked: true, value: 45 },
  layers: { locked: true, value: 1 },
  objective: "minVolume",
  topCap: "auto",
  joint: "press",
  tolerance: 0.2,
  print: { bedX: 256, bedY: 256, bedZ: 256 },
};

describe("memory stability across repeated designs (issue #7)", () => {
  it("keeps RSS from growing roughly linearly over 100 consecutive designs", async () => {
    const WARMUP = 20;
    const TOTAL = 120;
    const SAMPLE_EVERY = 10;

    const samples: number[] = [];
    for (let i = 0; i < TOTAL; i++) {
      await design(spec, "draft");
      if (i >= WARMUP && (i - WARMUP) % SAMPLE_EVERY === 0) {
        samples.push(process.memoryUsage().rss);
      }
    }

    // Linear-regression slope over the post-warmup samples: bytes of RSS
    // growth per `SAMPLE_EVERY`-design step. Robust to one noisy sample,
    // unlike a plain first-vs-last difference.
    const n = samples.length;
    const xs = samples.map((_, i) => i);
    const meanX = xs.reduce((a, b) => a + b, 0) / n;
    const meanY = samples.reduce((a, b) => a + b, 0) / n;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      num += (xs[i] - meanX) * (samples[i] - meanY);
      den += (xs[i] - meanX) ** 2;
    }
    const slopePerStep = den === 0 ? 0 : num / den;

    // Empirically (with this spec/resolution): proper cleanup plateaus at
    // well under 1 MB of slope per 10-design step, while reverting
    // manifold.ts's `for (const m of trash) m.delete()` to a no-op (i.e. a
    // real leak) produces roughly 9-10 MB per step -- a clean order-of-
    // magnitude gap. This cap sits comfortably above normal allocator/GC
    // noise and comfortably below that leak signal.
    const MAX_SLOPE_BYTES_PER_STEP = 4 * 1024 * 1024;
    expect(
      slopePerStep,
      `RSS grew by ~${(slopePerStep / 1024 / 1024).toFixed(2)} MB per ${SAMPLE_EVERY} designs ` +
        `(samples, MB: ${samples.map((s) => (s / 1024 / 1024).toFixed(1)).join(", ")})`,
    ).toBeLessThan(MAX_SLOPE_BYTES_PER_STEP);
  }, 30_000);
});
