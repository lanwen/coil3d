import { expect, test, type Page } from "@playwright/test";

// End-to-end checks for issue #4 (docs/research.md §5, §10b): the schematic
// wound-cable render. A distinct wound body at ordinary turn counts, legible
// (not a black mass) at a few hundred turns, and an on/off toggle mirrored in
// the URL hash. Screenshot baselines for the 1-layer and multi-layer cases
// live in e2e/line-art.spec.ts (SQUAT/LONG/TWO_LAYER), which this ticket's
// wire render now shows by default; this file adds the many-turn case and
// the toggle behaviour those don't cover.

const ONE_LAYER = "#v=1&L=1000&d=4&size=40";
// A single layer with ~300 turns: well past the full-tube-to-envelope
// switchover, so this exercises the "doesn't read as a black mass" path.
const MANY_TURN = "#v=1&L=15000&d=0.5&size=15";

async function gotoDesign(page: Page, hash: string) {
  await page.goto(`/${hash}`);
  await expect(page.getByTestId("coil-viewer").locator("canvas")).toBeVisible();
  await page.waitForTimeout(800);
}

type Rgb = [number, number, number];

async function readPixels(page: Page, png: Buffer): Promise<{ width: number; height: number; data: Rgb[] }> {
  return page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const img = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
    const ctx = new OffscreenCanvas(img.width, img.height).getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const raw = ctx.getImageData(0, 0, img.width, img.height).data;
    const px: Rgb[] = [];
    for (let i = 0; i < raw.length; i += 4) px.push([raw[i], raw[i + 1], raw[i + 2]]);
    return { width: img.width, height: img.height, data: px };
  }, png.toString("base64"));
}

test.describe("wound-cable schematic (issue #4)", () => {
  test("a many-turn (~300 turns) single layer still reads mostly white, not a black mass", async ({ page }) => {
    await gotoDesign(page, MANY_TURN);
    // Confirm this is genuinely a high-turn-count case, not an accidental low one.
    const turnsText = await page.getByTestId("layer-table").locator("tbody tr td").nth(1).textContent();
    expect(Number(turnsText)).toBeGreaterThan(100);

    const png = await page.getByTestId("coil-viewer").locator("canvas").screenshot();
    const { data } = await readPixels(page, png);
    const bg = data[0];
    const differsFromBg = (p: Rgb) => p.some((v, i) => Math.abs(v - bg[i]) > 8);
    const isNearBlack = (p: Rgb) => p[0] < 40 && p[1] < 40 && p[2] < 40;

    const modelPixels = data.filter(differsFromBg);
    expect(modelPixels.length, "the model must actually be visible").toBeGreaterThan(1000);
    const blackFraction = modelPixels.filter(isNearBlack).length / modelPixels.length;
    // A "black mass" would paint most of the model's own pixels near-black;
    // a legible wound body (envelope + a few hint turns, see
    // src/viewer/wireGeometry.ts) keeps this a thin minority of lines.
    expect(blackFraction).toBeLessThan(0.35);
  });

  test("toggling the wire off hides it and is reflected in the URL hash", async ({ page }) => {
    await gotoDesign(page, ONE_LAYER);
    const canvas = page.getByTestId("coil-viewer").locator("canvas");
    // A named baseline, reused below: SwiftShader's software rasterizer isn't
    // bit-exact across separate draws of the same scene, so a perceptual
    // diff (the project's configured maxDiffPixelRatio) is used throughout
    // rather than a raw byte comparison.
    await expect(canvas).toHaveScreenshot("wire-toggle-on.png");

    await page.getByTestId("toggle-wire").uncheck();
    await page.waitForTimeout(300);
    await expect(canvas, "unchecking the toggle must change the render").not.toHaveScreenshot("wire-toggle-on.png");
    await expect(page).toHaveURL(/(?:[?&]|#).*wire=0/);

    await page.getByTestId("toggle-wire").check();
    await page.waitForTimeout(300);
    await expect(canvas, "re-checking the toggle must restore the original render").toHaveScreenshot(
      "wire-toggle-on.png",
    );
    await expect(page).not.toHaveURL(/wire=0/);
  });

  test("a wire=0 link loads with the toggle unchecked and no wire drawn", async ({ page }) => {
    await gotoDesign(page, `${ONE_LAYER}&wire=0`);
    await expect(page.getByTestId("toggle-wire")).not.toBeChecked();

    const canvas = page.getByTestId("coil-viewer").locator("canvas");
    await expect(canvas).toHaveScreenshot("wire-toggle-off-from-link.png");
    await page.getByTestId("toggle-wire").check();
    await page.waitForTimeout(300);
    await expect(canvas).not.toHaveScreenshot("wire-toggle-off-from-link.png");
  });

  test("many-turn coil screenshot baseline (envelope + hint-turn legibility mode)", async ({ page }) => {
    await gotoDesign(page, MANY_TURN);
    await expect(page.getByTestId("coil-viewer").locator("canvas")).toHaveScreenshot("wire-many-turn.png");
  });
});
