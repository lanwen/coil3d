import { expect, test, type Locator, type Page } from "@playwright/test";

// End-to-end checks for the overall-dimension axes: issue #50's IKEA-style
// dimensions (values fixed by #63), redrawn by issue #69 as 3D axes inside
// the scene -- width, depth and height from a common bottom corner of the
// assembled model's box, fixed on it and rotating with it (issue #93). Solver/geometry numbers are
// covered by vitest against `design()`; these check the viewer seam: the
// values (mirrored as screen-reader text, since the labels are drawn in the
// canvas) agree with the result panel's real numbers, and the axes' own ink
// -- isolated by toggling them off, which leaves the camera where it is --
// is really drawn, stays in the frame and clear of the controls, moves with
// an orbit, and is gone in exploded view.

const ROUND_NO_CAP = "#v=1&L=1000&d=4&lock=outer,ly&size=50&h=40&ly=1&cap=off";
const ROUND_CAP = "#v=1&L=6000&d=3.8&lock=outer,h,ly&size=60&h=60&ly=2&cap=on";
const ROUND_CAP_OFF = "#v=1&L=6000&d=3.8&lock=outer,h,ly&size=60&h=60&ly=2&cap=off";
const SQUARE = "#v=1&L=6000&d=3.8&lock=outer,h,ly&size=60&h=60&ly=2&cap=on&shape=sq&sq.rc=15";
const TRIANGLE = "#v=1&L=6000&d=3.8&lock=outer,h,ly&size=60&h=60&ly=2&cap=on&shape=tri&tri.rc=15";
// A slim, tall coil -- the same proportions as e2e/wire.spec.ts's own
// MANY_TURN fixture (Ø 2.4 cm x 26.1 cm), which is where issue #99 was
// spotted: width and depth start from the same origin corner, so a small
// footprint under a tall body is exactly where their labels can collide.
const SLIM_ROUND = "#v=1&L=15000&d=0.5&size=15";
const SLIM_SQUARE = "#v=1&L=15000&d=0.5&size=15&shape=sq&sq.rc=3";
const SLIM_TRIANGLE = "#v=1&L=15000&d=0.5&size=15&shape=tri&tri.rc=3";
const PRESETS = ["front", "iso", "wallRoom"] as const;

interface LabelRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

// The viewer's test-only probes (declared on Window in src/, a separate tsc
// project): DimensionAxes.tsx's last drawn frame, and LineArtRenderer's
// unwrapped orbit azimuth.
type ProbeWindow = Window & {
  __orbitAzimuthDeg?: number;
  // LineArtRenderer.tsx's own test-only seam (issue #110): rotates the live
  // camera by this many degrees around the orbit target, without simulating
  // a pointer drag. The drag path itself (does a drag actually orbit the
  // camera) is covered by e2e/line-art.spec.ts's issue #84 tests.
  __orbitByDeg?: (deltaDeg: number) => void;
  __dimensionAxes?: {
    mvp: number[];
    canvas: { width: number; height: number };
    box: { min: number[]; max: number[] };
    gap: number;
    origin: number[];
    // `occludedAt` matches DimensionAxes.tsx's own OCCLUSION_PROBE_TS ([0.3,
    // 0.7]): issue #97 -- the axes now draw nothing where the model hides
    // them, so the rigidity test below only checks ink where the app itself
    // says the model doesn't occlude that point. `labelRect` is the drawn
    // label's own canvas-space bounding box (issue #99), or null while it's
    // hidden (occluded, foreshortened, or -- round shapes -- merged away).
    arms: { id: string; from: number[]; to: number[]; occludedAt: boolean[]; labelRect: LabelRect | null }[];
  };
};

function rectsOverlap(a: LabelRect, b: LabelRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

async function gotoDesign(page: Page, hash: string) {
  await page.goto(`/${hash}`);
  await expect(page.getByTestId("coil-viewer").locator("canvas")).toBeVisible();
  // Wait for the FINAL-resolution mesh (download-stl is gated on it, see
  // e2e/line-art.spec.ts): the dimensions are measured off the part meshes.
  await expect(page.getByTestId("download-stl")).toBeEnabled();
  await page.waitForTimeout(500);
}

async function showPreset(page: Page, preset: (typeof PRESETS)[number]) {
  await page.getByTestId(`preset-${preset}`).click();
  await page.waitForTimeout(600);
}

async function readText(locator: Locator): Promise<string> {
  return (await locator.textContent()) ?? "";
}

/** Parses a "<number> <unit>" value into cm, whichever unit it's shown in. */
function toCm(text: string): number {
  const match = text.match(/(-?\d+(?:\.\d+)?)\s*(mm|cm)/i);
  if (!match) throw new Error(`unrecognized dimension value: ${text}`);
  const value = Number(match[1]);
  return match[2].toLowerCase() === "mm" ? value / 10 : value;
}

async function dimensionCm(page: Page, which: "width" | "depth" | "height"): Promise<number> {
  return toCm(await readText(page.getByTestId(`dimension-${which}`)));
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Ink {
  count: number;
  box: { left: number; top: number; right: number; bottom: number } | null;
  /** Ink pixels inside any of the given rects. */
  inRects: number;
  /** The mask itself, row-major, 1 = ink -- for comparing two views. Only
   * built when `includeMask` is requested (most callers only need `count`/
   * `box`/`inRects`, and the mask is a full `width * height` array). */
  mask: number[] | null;
  width: number;
  height: number;
}

/** The canvas's pixels that change when the dimension axes are toggled off
 * (the camera stays put), i.e. the axes' own ink, in canvas CSS px. The
 * toggle itself sits over the canvas and changes its own icon, so its box
 * is left out. Pass `includeMask` to also get the full per-pixel mask (only
 * the "bolder than the model's lines" and "rotate with the model" checks
 * need it, to compare masks pixel-for-pixel). */
async function dimensionInk(page: Page, rects: Rect[] = [], includeMask = false): Promise<Ink> {
  const canvas = page.getByTestId("coil-viewer").locator("canvas");
  const canvasBox = (await canvas.boundingBox())!;
  const toggleBox = (await page.locator(".dimensions-toggle").boundingBox())!;
  const ignore = { x: toggleBox.x - canvasBox.x - 2, y: toggleBox.y - canvasBox.y - 2, width: toggleBox.width + 4, height: toggleBox.height + 4 };
  const withAxes = await canvas.screenshot();
  await page.getByTestId("toggle-dimensions").uncheck();
  await page.waitForTimeout(300);
  const without = await canvas.screenshot();
  await page.getByTestId("toggle-dimensions").check();
  await page.waitForTimeout(300);
  return page.evaluate(
    async ({ a, b, rects, ignore, includeMask }) => {
      const decode = async (b64: string) => {
        const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
        const img = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
        const ctx = new OffscreenCanvas(img.width, img.height).getContext("2d")!;
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, img.width, img.height);
      };
      const [pa, pb] = [await decode(a), await decode(b)];
      const { width, height } = pa;
      const mask = includeMask ? new Array<number>(width * height).fill(0) : null;
      let count = 0;
      let inRects = 0;
      let box: { left: number; top: number; right: number; bottom: number } | null = null;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          const d = Math.abs(pa.data[i] - pb.data[i]) + Math.abs(pa.data[i + 1] - pb.data[i + 1]) + Math.abs(pa.data[i + 2] - pb.data[i + 2]);
          if (d < 120) continue;
          if (x >= ignore.x && x < ignore.x + ignore.width && y >= ignore.y && y < ignore.y + ignore.height) continue;
          if (mask) mask[y * width + x] = 1;
          count++;
          box = box ? { left: Math.min(box.left, x), top: Math.min(box.top, y), right: Math.max(box.right, x), bottom: Math.max(box.bottom, y) } : { left: x, top: y, right: x, bottom: y };
          if (rects.some((r) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height)) inRects++;
        }
      }
      return { count, box, inRects, mask, width, height };
    },
    { a: withAxes.toString("base64"), b: without.toString("base64"), rects, ignore, includeMask },
  );
}

/** The overlay controls' boxes, relative to the canvas. */
async function controlRects(page: Page, extra: string[] = []): Promise<Rect[]> {
  const canvas = (await page.getByTestId("coil-viewer").locator("canvas").boundingBox())!;
  const rects: Rect[] = [];
  for (const selector of [".wire-toggle", ".explode-toggle", ".view-controls", ".wall-view-caption", ...extra]) {
    for (const el of await page.locator(selector).all()) {
      const box = await el.boundingBox();
      if (box) rects.push({ x: box.x - canvas.x, y: box.y - canvas.y, width: box.width, height: box.height });
    }
  }
  return rects;
}

test.describe("overall-dimension axes (issues #50, #69)", () => {
  test("round core: width and depth read as the flange diameter (Ø) and match the result panel's real flange width (issue #63)", async ({ page }) => {
    await gotoDesign(page, ROUND_NO_CAP);
    await expect(page.getByTestId("dimension-width")).toHaveText(/^Ø\s*\d+\.\d cm$/);
    await expect(page.getByTestId("dimension-depth")).toHaveText(/^Ø\s*\d+\.\d cm$/);
    await expect(page.getByTestId("dimension-height")).toHaveText(/^\d+\.\d cm$/);
    const flangeCm = toCm(await readText(page.getByTestId("flange")));
    for (const preset of PRESETS) {
      await showPreset(page, preset);
      expect(await dimensionCm(page, "width"), preset).toBeCloseTo(flangeCm, 1);
      expect(await dimensionCm(page, "depth"), preset).toBeCloseTo(flangeCm, 1);
    }
  });

  test("height is the overall assembled height and matches the result panel's own 'overall height' row (issue #63)", async ({ page }) => {
    await gotoDesign(page, ROUND_NO_CAP);
    await expect(page.getByTestId("caps")).toContainText(/^off/);
    const coreHeightCm = toCm(await readText(page.getByTestId("height")));
    const overallHeightCm = toCm(await readText(page.getByTestId("overall-height")));
    const height = await dimensionCm(page, "height");
    expect(height - coreHeightCm).toBeGreaterThan(0.1);
    expect(height - coreHeightCm).toBeLessThan(1.5);
    expect(height).toBeCloseTo(overallHeightCm, 1);
  });

  test("a top cap adds exactly its own thickness to the overall height", async ({ page, context }) => {
    await gotoDesign(page, ROUND_CAP_OFF);
    await expect(page.getByTestId("caps")).toContainText(/^off/);
    const withoutCap = await dimensionCm(page, "height");
    const capped = await context.newPage(); // a fresh load: a hash-only goto wouldn't reparse the design
    await gotoDesign(capped, ROUND_CAP);
    await expect(capped.getByTestId("caps")).toContainText(/^on/);
    const withCap = await dimensionCm(capped, "height");
    expect(withCap - withoutCap).toBeGreaterThan(0.1);
    expect(withCap - withoutCap).toBeLessThan(0.6);
  });

  for (const [label, hash] of [
    ["square", SQUARE],
    ["triangle", TRIANGLE],
  ] as const) {
    test(`${label} core: width and depth are plain values (no Ø) between the result panel's real across-flats/across-corners extents (issue #63)`, async ({ page }) => {
      await gotoDesign(page, hash);
      const acrossFlatsCm = toCm(await readText(page.getByTestId("flange")));
      const acrossCornersCm = toCm(await readText(page.getByTestId("flange-across-corners")));
      for (const which of ["width", "depth"] as const) {
        await expect(page.getByTestId(`dimension-${which}`)).toHaveText(/^\d+\.\d cm$/);
        const cm = await dimensionCm(page, which);
        expect(cm, which).toBeGreaterThan(acrossFlatsCm - 0.15);
        expect(cm, which).toBeLessThan(acrossCornersCm + 0.15);
        // The axes sit flush with the flats, so a square reads exactly the
        // panel's across-flats flange width on both.
        if (label === "square") expect(cm, which).toBeCloseTo(acrossFlatsCm, 1);
      }
    });
  }

  for (const [label, hash] of [
    ["round", ROUND_CAP],
    ["square", SQUARE],
    ["triangle", TRIANGLE],
  ] as const) {
    test(`${label}: the axes are drawn in the 3D view, inside the frame and clear of the overlay controls, in every view`, async ({ page }) => {
      // A taller canvas than the default: the model grows wider on it, and
      // in Front the height axis's top reaches toward the toggles.
      await page.setViewportSize({ width: 1280, height: 800 });
      await gotoDesign(page, hash);
      for (const preset of PRESETS) {
        await showPreset(page, preset);
        const ink = await dimensionInk(page, await controlRects(page));
        expect(ink.count, `${preset}: axes drawn`).toBeGreaterThan(800);
        expect(ink.box!.left, preset).toBeGreaterThan(2);
        expect(ink.box!.top, preset).toBeGreaterThan(2);
        expect(ink.box!.right, preset).toBeLessThan(ink.width - 3);
        expect(ink.box!.bottom, preset).toBeLessThan(ink.height - 3);
        expect(ink.inRects, `${preset}: axes under a control`).toBe(0);
        // (Ink hidden under a control doesn't show in the diff above: check
        // the axes' own spans, tick bars included, against every control.)
        const rects = await controlRects(page, [".dimensions-toggle"]);
        const probe = (await page.evaluate(() => (window as unknown as ProbeWindow).__dimensionAxes))!;
        const TICK_HALF = 7;
        for (const arm of probe.arms) {
          for (let t = 0; t <= 1; t += 0.01) {
            const x = arm.from[0] + t * (arm.to[0] - arm.from[0]);
            const y = arm.from[1] + t * (arm.to[1] - arm.from[1]);
            const under = rects.some((r) => x > r.x - TICK_HALF && x < r.x + r.width + TICK_HALF && y > r.y - TICK_HALF && y < r.y + r.height + TICK_HALF);
            expect(under, `${preset}: the ${arm.id} axis runs under a control at (${x.toFixed(0)}, ${y.toFixed(0)})`).toBe(false);
          }
        }
      }
    });
  }

  test("the axes are bolder than the model's own lines", async ({ page }) => {
    await gotoDesign(page, ROUND_CAP);
    await showPreset(page, "front");
    // In Front the height axis is a vertical line beside the model: the ink
    // run it leaves across a row above its label (centred on it) is its
    // stroke width.
    const ink = await dimensionInk(page, [], true);
    const y = Math.round(ink.height * 0.3);
    const runs: number[] = [];
    let run = 0;
    for (let x = 0; x < ink.width; x++) {
      if (ink.mask![y * ink.width + x]) run++;
      else if (run) {
        runs.push(run);
        run = 0;
      }
    }
    expect(runs.length, "the height axis crosses the row").toBeGreaterThan(0);
    // The model's pen line is 1-1.6 CSS px (LineArtRenderer's MIN/MAX_LINE_WEIGHT).
    expect(Math.max(...runs)).toBeGreaterThanOrEqual(3);
  });

  test("the axes rotate with the model: an orbit moves their ink, and they stay drawn", async ({ page }) => {
    await gotoDesign(page, ROUND_CAP);
    const before = await dimensionInk(page, [], true);
    const box = (await page.getByTestId("coil-viewer").locator("canvas").boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 220, cy + 40, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    const after = await dimensionInk(page, [], true);
    expect(after.count).toBeGreaterThan(800);
    let shared = 0;
    for (let i = 0; i < before.mask!.length; i++) if (before.mask![i] && after.mask![i]) shared++;
    expect(shared / before.count, "most of the axes' ink moved").toBeLessThan(0.5);
  });

  test("hidden in exploded view, back once collapsed", async ({ page }) => {
    await gotoDesign(page, ROUND_CAP);
    await expect(page.getByTestId("dimensions")).toHaveCount(1);

    await page.getByTestId("toggle-exploded").check();
    await page.waitForTimeout(1200);
    await expect(page.getByTestId("dimensions")).toHaveCount(0);
    // (a handful of stray pixels: re-render noise, not an axis)
    expect((await dimensionInk(page)).count, "nothing drawn while exploded").toBeLessThan(30);

    await page.getByTestId("toggle-exploded").uncheck();
    await page.waitForTimeout(1200);
    await expect(page.getByTestId("dimensions")).toHaveCount(1);
    expect((await dimensionInk(page)).count).toBeGreaterThan(800);
  });

  // Issue #93: the axes are fixed on the model's box -- its front-left-bottom
  // corner and the three box edges from it -- so a full orbit never moves
  // them to another corner or side. Each step, the axes' drawn spans (from
  // the viewer's test probe) must sit where the box's own edges project
  // under the live camera, and there must be ink there.
  for (const [label, hash] of [
    ["round", ROUND_CAP],
    ["square", SQUARE],
    ["triangle", TRIANGLE],
  ] as const) {
    test(`${label}: through a full 360-degree orbit the axes stay on the same box corner and edges (issue #93)`, async ({ page }) => {
      await gotoDesign(page, hash);
      await showPreset(page, "iso");
      const canvas = page.getByTestId("coil-viewer").locator("canvas");
      // Issue #110: this used to drive the orbit with 24 simulated
      // `page.mouse.move` drag steps, each followed by a full canvas
      // screenshot + pixel diff -- 20-29s per shape, right at the suite's
      // 30s timeout. The drag path itself (does dragging actually orbit the
      // camera) is already covered by e2e/line-art.spec.ts's issue #84
      // tests, so this test now drives the SAME 24 steps of a full orbit
      // through LineArtRenderer's `__orbitByDeg` test hook instead, and
      // reads the projected endpoints off the `__dimensionAxes` probe rather
      // than screenshotting every step.
      const STEPS = 24;
      const STEP_DEG = 360 / STEPS;
      // The box/gap/origin -> expected-pixel-position check below is pure
      // arithmetic on the probe's own numbers (no screenshot needed), so it
      // alone still catches an anchor-point regression -- e.g. the "shifted
      // 25mm" mutation -- at EVERY one of the 25 steps, same rigidity
      // coverage as before. Ink is only confirming something is actually
      // DRAWN where the numbers say, which doesn't need checking at every
      // angle: a handful of representative points around the circle is
      // enough, so only these steps pay for a screenshot.
      const INK_STEPS = new Set([0, 6, 12, 18, 24]);
      const startAzimuth = await page.evaluate(() => (window as unknown as ProbeWindow).__orbitAzimuthDeg ?? 0);
      for (let step = 0; step <= STEPS; step++) {
        if (step > 0) {
          // The canvas renders on demand (see LineArtRenderer's own doc
          // comment): __orbitByDeg's `invalidate()` schedules a render, but
          // doesn't wait for it, so the probe would still read the PREVIOUS
          // angle without this. Two rAFs (not one): r3f's own render call is
          // already scheduled by the time this runs, but a demand-mode
          // canvas may take a frame to actually settle before the probe's
          // `scene.onBeforeRender` hook fires with the new camera.
          await page.evaluate(
            (deg) =>
              new Promise<void>((resolve) => {
                (window as unknown as ProbeWindow).__orbitByDeg?.(deg);
                requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
              }),
            STEP_DEG,
          );
        }
        const probe = await page.evaluate(() => (window as unknown as ProbeWindow).__dimensionAxes);
        expect(probe, "the axes are drawn").toBeTruthy();
        const { min, max } = probe!.box;
        const g = probe!.gap;
        const oz = probe!.origin[2];
        expect(oz, "the ground axes run below the box").toBeLessThanOrEqual(min[2] - g + 1e-6);
        expect(probe!.origin, "the origin is the front-left-bottom corner, a gap out").toEqual([min[0] - g, min[1] - g, oz]);
        const expected: Record<string, [number[], number[]]> = {
          width: [[min[0], min[1] - g, oz], [max[0], min[1] - g, oz]],
          depth: [[min[0] - g, min[1], oz], [min[0] - g, max[1], oz]],
          height: [[min[0] - g, min[1] - g, min[2]], [min[0] - g, min[1] - g, max[2]]],
        };
        const project = (p: number[]) => {
          const m = probe!.mvp;
          const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
          const nx = (m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]) / w;
          const ny = (m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]) / w;
          return [((nx + 1) / 2) * probe!.canvas.width, ((1 - ny) / 2) * probe!.canvas.height];
        };
        const near = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= 2;
        expect(probe!.arms.length, `step ${step}: every axis drawn`).toBe(3);
        const samples: number[][] = [];
        // Issue #97: an occluded sample is expected to have NO ink (the
        // model hides it instead of showing it grey), so it's excluded from
        // the "ink along every axis" check below rather than asserted false
        // outright -- the model's own line-art could coincidentally cross
        // the exact same pixel, which isn't what this test is about.
        const visible: boolean[] = [];
        for (const arm of probe!.arms) {
          const [from, to] = expected[arm.id].map(project);
          expect(near(arm.from, from) && near(arm.to, to), `step ${step}: ${arm.id} on its box edge (${arm.from} -> ${arm.to} vs ${from} -> ${to})`).toBe(true);
          [0.3, 0.7].forEach((t, i) => {
            samples.push([from[0] + t * (to[0] - from[0]), from[1] + t * (to[1] - from[1])]);
            visible.push(!arm.occludedAt[i]);
          });
        }
        if (!INK_STEPS.has(step)) continue;
        // Settle a beat before the pixels are actually read, same as every
        // other ink check in this file (dimensionInk's own toggles wait
        // 300ms) -- the rAF wait above only guarantees the PROBE'S numbers
        // are current, not that the compositor has painted them yet.
        await page.waitForTimeout(100);
        const shot = await canvas.screenshot();
        const inked = await page.evaluate(
          async ({ png, samples }) => {
            const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
            const ctx = new OffscreenCanvas(img.width, img.height).getContext("2d")!;
            ctx.drawImage(img, 0, 0);
            const { data, width, height } = ctx.getImageData(0, 0, img.width, img.height);
            return samples.map(([sx, sy]) => {
              for (let dy = -3; dy <= 3; dy++)
                for (let dx = -3; dx <= 3; dx++) {
                  const px = Math.round(sx) + dx;
                  const py = Math.round(sy) + dy;
                  if (px < 0 || py < 0 || px >= width || py >= height) continue;
                  const i = (py * width + px) * 4;
                  if (data[i + 3] > 128 && data[i] + data[i + 1] + data[i + 2] < 3 * 200) return true;
                }
              return false;
            });
          },
          { png: shot.toString("base64"), samples },
        );
        for (let i = 0; i < inked.length; i++) {
          if (!visible[i]) continue;
          expect(inked[i], `step ${step}: ink at the visible sample (${samples[i][0].toFixed(0)}, ${samples[i][1].toFixed(0)})`).toBe(true);
        }
      }
      const turned = (await page.evaluate(() => (window as unknown as ProbeWindow).__orbitAzimuthDeg ?? 0)) - startAzimuth;
      expect(Math.abs(turned), "a full orbit").toBeGreaterThanOrEqual(350);
    });
  }

  test("readable at phone width too", async ({ page }) => {
    await page.setViewportSize({ width: 400, height: 800 });
    await gotoDesign(page, ROUND_CAP);
    const ink = await dimensionInk(page, await controlRects(page));
    expect(ink.count).toBeGreaterThan(500);
    expect(ink.box!.left).toBeGreaterThan(2);
    expect(ink.box!.right).toBeLessThan(ink.width - 3);
    expect(ink.inRects).toBe(0);
  });

  // Issue #99: on a slim, tall coil the width and depth axes -- sharing the
  // same origin corner -- can otherwise draw their labels on top of each
  // other, and (round only) on top of one another's IDENTICAL text ("Ø ..."
  // twice, the same number). Checked against the probe's own `labelRect`
  // (each label's canvas-space bounding box) rather than pixels: exact and
  // immune to font/AA noise, and distinguishes "hidden" (null, e.g.
  // occluded or foreshortened -- unrelated to this issue) from "drawn".
  test.describe("the width/depth labels never collide on a slim coil (issue #99)", () => {
    test("round: only a single Ø label is ever drawn, never both at once", async ({ page }) => {
      await gotoDesign(page, SLIM_ROUND);
      await expect(page.getByTestId("dimension-width")).toHaveText(/^Ø/);
      await expect(page.getByTestId("dimension-depth")).toHaveText(/^Ø/);
      let sawOne = false;
      for (const preset of PRESETS) {
        await showPreset(page, preset);
        const probe = (await page.evaluate(() => (window as unknown as ProbeWindow).__dimensionAxes))!;
        // Foreshortened past MIN_AXIS_PX (DimensionAxes.tsx), an axis isn't
        // drawn AT ALL (no entry in `arms`), same as an occluded/merged
        // label -- both just mean "nothing to see here".
        const width = probe.arms.find((a) => a.id === "width")?.labelRect ?? null;
        const depth = probe.arms.find((a) => a.id === "depth")?.labelRect ?? null;
        expect(width && depth, `${preset}: width AND depth both drawn (should be at most one)`).toBeFalsy();
        if (width || depth) sawOne = true;
      }
      expect(sawOne, "at least one Ø label is drawn somewhere").toBe(true);
    });

    for (const [label, hash] of [
      ["square", SLIM_SQUARE],
      ["triangle", SLIM_TRIANGLE],
    ] as const) {
      test(`${label}: the width and depth labels never overlap, whenever both are drawn`, async ({ page }) => {
        await gotoDesign(page, hash);
        for (const preset of PRESETS) {
          await showPreset(page, preset);
          const probe = (await page.evaluate(() => (window as unknown as ProbeWindow).__dimensionAxes))!;
          const width = probe.arms.find((a) => a.id === "width")?.labelRect ?? null;
          const depth = probe.arms.find((a) => a.id === "depth")?.labelRect ?? null;
          if (!width || !depth) continue; // one is hidden (occluded/foreshortened/not drawn) -- nothing to collide
          expect(rectsOverlap(width, depth), `${preset}: width/depth labels overlap (${JSON.stringify({ width, depth })})`).toBe(false);
        }
      });
    }
  });
});

// End-to-end checks for issue #65 (follow-ups from the #63 review): the
// result panel's "Envelope" row is renamed and hinted so it reads as
// directly comparable to the flange rows, instead of looking like the
// cable pokes out past the flange. (This issue also fixed the height
// dimension's own extension lines in the old SVG overlay; issue #69/#75
// replaced that overlay with the 3D dimension axes above, so that part is
// superseded and dropped here.)
test.describe("the cable/flange rows are comparable (issue #65)", () => {
  test("the cable's own outer size and the flange rows are labelled/hinted so they're directly comparable", async ({ page }) => {
    await gotoDesign(page, SQUARE);
    // Renamed from the old, unqualified "Envelope" (issue #65): it's a
    // circumscribed, across-corners extent, same as "Flange width (across
    // corners)" below it -- not the plain (narrower, across-flats) "Flange
    // width" right above.
    await expect(page.getByTestId("envelope")).toHaveText(/^\d+\.\d mm$/);
    const envelopeRow = page.locator(".result-row").filter({ has: page.getByTestId("envelope") });
    await expect(envelopeRow.locator(".result-label")).toHaveText("Cable outer size (across corners)");

    const envelopeCm = Number((await page.getByTestId("envelope").textContent())!.match(/[\d.]+/)![0]);
    const acrossCornersCm = Number((await page.getByTestId("flange-across-corners").textContent())!.match(/[\d.]+/)![0]);
    expect(envelopeCm).toBeLessThanOrEqual(acrossCornersCm);

    // Every one of the three rows has its own (i) hint, and none of them
    // are empty.
    for (const testId of ["envelope", "flange", "flange-across-corners"]) {
      const row = page.locator(".result-row").filter({ has: page.getByTestId(testId) });
      const hintBtn = row.getByTestId("hint-btn");
      await expect(hintBtn).toHaveCount(1);
      const bubble = row.getByTestId("hint-bubble");
      await hintBtn.hover();
      await expect(bubble).toBeVisible();
      expect((await bubble.textContent())!.length).toBeGreaterThan(20);
    }

    // A design's warnings never include the cable-exceeds-flange safety net
    // (design.ts: the flange margin is sized to clear the envelope) --
    // guarded far more thoroughly across shapes/mounts/cable sizes by
    // vitest (test/design.test.ts), this is just the UI-wiring sanity check.
    const hasCount = await page.getByTestId("warnings").count();
    if (hasCount > 0) {
      await expect(page.getByTestId("warnings")).not.toContainText("stick out past the flange");
    }
  });

  test("round core: 'Cable outer size' (no '(across corners)') matches the flange width directly, since round has no separate across-corners row", async ({ page }) => {
    await gotoDesign(page, ROUND_CAP);
    const envelopeRow = page.locator(".result-row").filter({ has: page.getByTestId("envelope") });
    await expect(envelopeRow.locator(".result-label")).toHaveText("Cable outer size");
    await expect(page.getByTestId("envelope")).toHaveText(/^Ø\s*\d+\.\d mm$/);
    await expect(page.getByTestId("flange-across-corners")).toHaveCount(0);
  });
});
