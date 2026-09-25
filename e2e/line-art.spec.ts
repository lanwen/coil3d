import { expect, test, type Page } from "@playwright/test";

// End-to-end checks for issue #3 (docs/research.md §5, §10b): the IKEA
// line-art look. White fill, a continuous black silhouette plus crease lines,
// a transparent background, an orthographic camera that frames the model,
// and hit-testing that only lets orbit start on the model.

const SQUAT = "#v=1&L=1000&d=4&size=40";
const LONG = "#v=1&L=6000&d=4&size=30";
// Layers locked at 2: the solver sizes the flange to clear both wound layers.
const TWO_LAYER = "#v=1&L=3000&d=4&size=40&ly=2";

async function gotoDesign(page: Page, hash: string) {
  await page.goto(`/${hash}`);
  await expect(page.getByTestId("coil-viewer").locator("canvas")).toBeVisible();
  // Wait for the FINAL-resolution mesh, not just the fast draft
  // (src/geometry/useDesignPreview.ts, issue #7): the final design is solved
  // off a worker on its own debounce and swaps in whenever that finishes,
  // which is CPU-time-dependent, not wall-clock-dependent -- under a loaded,
  // software-rendered CI run the swap can land well past a fixed sleep,
  // right in the middle of the next few lines of a test. `download-stl` is
  // already gated on the very same `finalReady` flag for the same "never
  // trust a stale mesh" reason (issue #7 AC), so wait on it here too instead
  // of guessing a duration.
  await expect(page.getByTestId("download-stl")).toBeEnabled();
  // Let the pipeline render a few settled frames past that point.
  await page.waitForTimeout(800);
}

type Rgb = [number, number, number];

/** Decode a PNG screenshot in the page and return the given pixel rows. */
async function readRows(page: Page, png: Buffer, rowFractions: number[]): Promise<Rgb[][]> {
  const rows = await page.evaluate(
    async ({ b64, fractions }) => {
      const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
      const img = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
      const ctx = new OffscreenCanvas(img.width, img.height).getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      return fractions.map((f) => Array.from(ctx.getImageData(0, Math.round(f * (img.height - 1)), img.width, 1).data));
    },
    { b64: png.toString("base64"), fractions: rowFractions },
  );
  return rows.map((data) => {
    const px: Rgb[] = [];
    for (let i = 0; i < data.length; i += 4) px.push([data[i], data[i + 1], data[i + 2]]);
    return px;
  });
}

const differs = (a: Rgb, b: Rgb) => a.some((v, i) => Math.abs(v - b[i]) > 8);
const luma = (p: Rgb) => 0.3 * p[0] + 0.59 * p[1] + 0.11 * p[2];

/**
 * Walk one row in from each side to the first pixel that is not the page
 * background (the white fill is too close to the off-white page to count, so
 * only a line can end the walk) and return the darkest luma within the next
 * few pixels: the silhouette line. Returns null when the row misses the model.
 */
function silhouette(row: Rgb[]): { first: number; last: number; left: number; right: number } | null {
  const bg = row[0];
  const first = row.findIndex((p) => differs(p, bg));
  if (first < 0) return null;
  let last = row.length - 1;
  while (!differs(row[last], bg)) last--;
  const darkest = (from: number, to: number) => Math.min(...row.slice(from, to + 1).map(luma));
  return { first, last, left: darkest(first, first + 3), right: darkest(last - 3, last) };
}

test.describe("IKEA line-art renderer", () => {
  test("renders the squat coil: white fill, thin black lines, transparent background", async ({ page }) => {
    await gotoDesign(page, SQUAT);
    await expect(page.getByTestId("coil-viewer").locator("canvas")).toHaveScreenshot("lineart-round.png");
  });

  test("renders the long, many-turn coil with continuous groove rings", async ({ page }) => {
    await gotoDesign(page, LONG);
    await expect(page.getByTestId("coil-viewer").locator("canvas")).toHaveScreenshot("lineart-long.png");
  });

  test("renders a 2-layer coil with its large flange", async ({ page }) => {
    await gotoDesign(page, TWO_LAYER);
    await expect(page.getByTestId("layers")).toHaveText("2");
    await expect(page.getByTestId("coil-viewer").locator("canvas")).toHaveScreenshot("lineart-two-layer.png");
  });

  test("the fill is pure white and the silhouette is a dark line against the background", async ({ page }) => {
    await gotoDesign(page, SQUAT);
    const png = await page.getByTestId("coil-viewer").locator("canvas").screenshot();
    const [row] = await readRows(page, png, [0.5]);

    const sil = silhouette(row);
    expect(sil, "the middle row must cross the model").not.toBeNull();
    expect(sil!.left).toBeLessThan(80);
    expect(sil!.right).toBeLessThan(80);

    // The fill between the lines is pure white (no tone mapping or shading).
    // The row also crosses groove rings near the sides, hence not ~100%.
    const model = row.slice(sil!.first, sil!.last + 1);
    const white = model.filter((p) => p.every((v) => v === 255));
    expect(white.length / model.length).toBeGreaterThan(0.5);
  });

  test("the silhouette of the long coil is unbroken from top to bottom", async ({ page }) => {
    await gotoDesign(page, LONG);
    // The dimension axes (issue #69) are drawn in the canvas beside the
    // model; this scan cares only about the model's own silhouette, so it
    // turns them off first (the camera stays put).
    await page.getByTestId("toggle-dimensions").uncheck();
    await page.waitForTimeout(300);
    const png = await page.getByTestId("coil-viewer").locator("canvas").screenshot();
    const fractions = Array.from({ length: 60 }, (_, i) => 0.25 + (0.5 * i) / 59);
    const rows = await readRows(page, png, fractions);
    for (const [i, row] of rows.entries()) {
      const sil = silhouette(row);
      expect(sil, `row ${fractions[i].toFixed(3)} must cross the model`).not.toBeNull();
      expect(Math.max(sil!.left, sil!.right), `silhouette gap at row ${fractions[i].toFixed(3)}`).toBeLessThan(110);
    }
  });

  test("orbit only starts when the drag begins on the outlined model, not the transparent background", async ({
    page,
  }) => {
    await gotoDesign(page, SQUAT);
    const canvas = page.getByTestId("coil-viewer").locator("canvas");
    const box = await canvas.boundingBox();
    if (!box) throw new Error("canvas has no bounding box");

    const before = await canvas.screenshot();

    // The model fills 75% of the canvas, centred, so a corner is background.
    await page.mouse.move(box.x + 8, box.y + 8);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 8, box.y + box.height - 8, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    const afterBackgroundDrag = await canvas.screenshot();
    expect(afterBackgroundDrag.equals(before), "a drag started on the background must not orbit the camera").toBe(
      true,
    );

    // The framed model sits at the canvas centre.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 60, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    const afterModelDrag = await canvas.screenshot();
    expect(afterModelDrag.equals(afterBackgroundDrag), "a drag started on the model must orbit the camera").toBe(
      false,
    );
  });

  test("reframes the orthographic camera when the canvas is resized", async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 800 });
    await gotoDesign(page, SQUAT);
    const canvas = page.getByTestId("coil-viewer").locator("canvas");
    const wide = await canvas.screenshot();

    await page.setViewportSize({ width: 500, height: 800 });
    await page.waitForTimeout(300);
    const narrow = await canvas.screenshot();

    expect(narrow.equals(wide), "the render must adapt when the canvas is resized").toBe(false);
  });
});
