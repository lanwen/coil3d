import { expect, test, type Locator, type Page } from "@playwright/test";

// End-to-end checks for the overall-dimension axes: issue #50's IKEA-style
// dimensions (values fixed by #63), redrawn by issue #69 as 3D axes inside
// the scene -- width, depth and height from a common bottom corner of the
// assembled model's box, rotating with it. Solver/geometry numbers are
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
const PRESETS = ["front", "iso", "wallRoom"] as const;

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
  /** The mask itself, row-major, 1 = ink -- for comparing two views. */
  mask: number[];
  width: number;
  height: number;
}

/** The canvas's pixels that change when the dimension axes are toggled off
 * (the camera stays put), i.e. the axes' own ink, in canvas CSS px. The
 * toggle itself sits over the canvas and changes its own icon, so its box
 * is left out. */
async function dimensionInk(page: Page, rects: Rect[] = []): Promise<Ink> {
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
    async ({ a, b, rects, ignore }) => {
      const decode = async (b64: string) => {
        const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
        const img = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
        const ctx = new OffscreenCanvas(img.width, img.height).getContext("2d")!;
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, img.width, img.height);
      };
      const [pa, pb] = [await decode(a), await decode(b)];
      const { width, height } = pa;
      const mask = new Array<number>(width * height).fill(0);
      let count = 0;
      let inRects = 0;
      let box: { left: number; top: number; right: number; bottom: number } | null = null;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          const d = Math.abs(pa.data[i] - pb.data[i]) + Math.abs(pa.data[i + 1] - pb.data[i + 1]) + Math.abs(pa.data[i + 2] - pb.data[i + 2]);
          if (d < 120) continue;
          if (x >= ignore.x && x < ignore.x + ignore.width && y >= ignore.y && y < ignore.y + ignore.height) continue;
          mask[y * width + x] = 1;
          count++;
          box = box ? { left: Math.min(box.left, x), top: Math.min(box.top, y), right: Math.max(box.right, x), bottom: Math.max(box.bottom, y) } : { left: x, top: y, right: x, bottom: y };
          if (rects.some((r) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height)) inRects++;
        }
      }
      return { count, box, inRects, mask, width, height };
    },
    { a: withAxes.toString("base64"), b: without.toString("base64"), rects, ignore },
  );
}

/** The overlay controls' boxes, relative to the canvas. */
async function controlRects(page: Page): Promise<Rect[]> {
  const canvas = (await page.getByTestId("coil-viewer").locator("canvas").boundingBox())!;
  const rects: Rect[] = [];
  for (const selector of [".wire-toggle", ".explode-toggle", ".view-controls", ".wall-view-caption"]) {
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
      }
    });
  }

  for (const [label, hash] of [
    ["round", ROUND_CAP],
    ["square", SQUARE],
    ["triangle", TRIANGLE],
  ] as const) {
    test(`${label}: the axes are drawn in the 3D view, inside the frame and clear of the overlay controls, in every view`, async ({ page }) => {
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
      }
    });
  }

  test("the axes are bolder than the model's own lines", async ({ page }) => {
    await gotoDesign(page, ROUND_CAP);
    await showPreset(page, "front");
    // In Front the height axis is a vertical line beside the model: the ink
    // run it leaves across a mid-height row is its stroke width.
    const ink = await dimensionInk(page);
    const y = Math.round(ink.height * 0.45);
    const runs: number[] = [];
    let run = 0;
    for (let x = 0; x < ink.width; x++) {
      if (ink.mask[y * ink.width + x]) run++;
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
    const before = await dimensionInk(page);
    const box = (await page.getByTestId("coil-viewer").locator("canvas").boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 220, cy + 40, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    const after = await dimensionInk(page);
    expect(after.count).toBeGreaterThan(800);
    let shared = 0;
    for (let i = 0; i < before.mask.length; i++) if (before.mask[i] && after.mask[i]) shared++;
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

  test("readable at phone width too", async ({ page }) => {
    await page.setViewportSize({ width: 400, height: 800 });
    await gotoDesign(page, ROUND_CAP);
    const ink = await dimensionInk(page, await controlRects(page));
    expect(ink.count).toBeGreaterThan(500);
    expect(ink.box!.left).toBeGreaterThan(2);
    expect(ink.box!.right).toBeLessThan(ink.width - 3);
    expect(ink.inRects).toBe(0);
  });
});
