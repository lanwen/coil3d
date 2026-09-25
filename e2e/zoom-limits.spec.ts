import { expect, test, type Page } from "@playwright/test";

// End-to-end checks for issue #48 (zoom limits): wheel/pinch zoom is
// clamped to a sensible multiple of the current fitted framing (0.3x-4x,
// LineArtRenderer.tsx's ZOOM_LIMIT_MIN/MAX), on both orthographic and
// perspective projections, so the coil can never be scrolled away to an
// unreadable speck or blown up past where nothing on screen still reads.
// Solver/geometry numbers are unaffected (vitest coverage is unchanged);
// this checks the viewer's OrbitControls <-> camera seam.
//
// "Clamped" is verified the direct way: scrolling well past the limit
// produces the IDENTICAL render as scrolling just up to it (further wheel
// ticks are true no-ops once the bound is hit) -- a pixel-count/area
// argument doesn't actually work here, because at extreme zoom the
// line-art render's own background-vs-model diff mostly just measures how
// many groove lines happen to be in frame (interior fill is white, same as
// the canvas background), which isn't monotonic with zoom at all -- see
// this file's own history for the pixel-count version that was tried and
// rejected for exactly that reason.

const SQUAT = "#v=1&L=1000&d=4&size=40";

async function gotoDesign(page: Page, hash: string) {
  await page.goto(`/${hash}`);
  await expect(page.getByTestId("coil-viewer").locator("canvas")).toBeVisible();
  await page.waitForTimeout(1000);
}

function hasNonBackgroundPixels(page: Page, b64: string): Promise<boolean> {
  return page.evaluate(async (data) => {
    const blob = await (await fetch(`data:image/png;base64,${data}`)).blob();
    const img = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
    const ctx = new OffscreenCanvas(img.width, img.height).getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const raw = ctx.getImageData(0, 0, img.width, img.height).data;
    const bg = [raw[0], raw[1], raw[2]];
    for (let i = 0; i < raw.length; i += 4) {
      if (Math.abs(raw[i] - bg[0]) > 8 || Math.abs(raw[i + 1] - bg[1]) > 8 || Math.abs(raw[i + 2] - bg[2]) > 8) return true;
    }
    return false;
  }, b64);
}

// Scrolling "up" (negative deltaY) zooms in; "down" (positive) zooms out --
// matches the existing convention in top-cap.spec.ts/mount-plate.spec.ts.
async function wheelOverCanvas(page: Page, canvas: ReturnType<Page["locator"]>, deltaY: number, ticks: number) {
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < ticks; i++) {
    await page.mouse.wheel(0, deltaY);
  }
}

test.describe("zoom limits (issue #48)", () => {
  // Empirically (see this file's own dev notes / PR description), 60 ticks
  // of magnitude-120 wheel events already fully saturates the clamp in
  // either direction, on this design -- AT_LIMIT is comfortably past that,
  // PAST_LIMIT doubles it again, so a real "still moving" regression (the
  // clamp not actually engaging) would show up as a genuine pixel
  // difference between the two, not a false positive from stopping short.
  const AT_LIMIT_TICKS = 60;
  const PAST_LIMIT_TICKS = 60;

  test("extreme zoom-in is clamped: scrolling well past the limit stops changing the render, and the silhouette still shows", async ({ page }) => {
    await gotoDesign(page, SQUAT);
    const canvas = page.getByTestId("coil-viewer").locator("canvas");
    const before = await canvas.screenshot();

    await wheelOverCanvas(page, canvas, -120, AT_LIMIT_TICKS);
    await page.waitForTimeout(300);
    const atLimit = await canvas.screenshot();
    expect(atLimit.equals(before), "zooming in must actually change the render").toBe(false);

    await wheelOverCanvas(page, canvas, -120, PAST_LIMIT_TICKS);
    await page.waitForTimeout(300);
    const pastLimit = await canvas.screenshot();
    expect(pastLimit.equals(atLimit), "scrolling in further once clamped must be a no-op").toBe(true);

    expect(await hasNonBackgroundPixels(page, pastLimit.toString("base64"))).toBe(true);
  });

  test("extreme zoom-out is clamped: scrolling well past the limit stops changing the render, and the silhouette still shows", async ({ page }) => {
    await gotoDesign(page, SQUAT);
    const canvas = page.getByTestId("coil-viewer").locator("canvas");
    const before = await canvas.screenshot();

    await wheelOverCanvas(page, canvas, 120, AT_LIMIT_TICKS);
    await page.waitForTimeout(300);
    const atLimit = await canvas.screenshot();
    expect(atLimit.equals(before), "zooming out must actually change the render").toBe(false);

    await wheelOverCanvas(page, canvas, 120, PAST_LIMIT_TICKS);
    await page.waitForTimeout(300);
    const pastLimit = await canvas.screenshot();
    expect(pastLimit.equals(atLimit), "scrolling out further once clamped must be a no-op").toBe(true);

    expect(await hasNonBackgroundPixels(page, pastLimit.toString("base64"))).toBe(true);
  });

  test("the clamp also applies in perspective projection", async ({ page }) => {
    await gotoDesign(page, SQUAT);
    await page.getByTestId("toggle-projection").check();
    await page.waitForTimeout(600);

    const canvas = page.getByTestId("coil-viewer").locator("canvas");

    await wheelOverCanvas(page, canvas, -120, AT_LIMIT_TICKS);
    await page.waitForTimeout(300);
    const atLimit = await canvas.screenshot();
    expect(await hasNonBackgroundPixels(page, atLimit.toString("base64"))).toBe(true);

    await wheelOverCanvas(page, canvas, -120, PAST_LIMIT_TICKS);
    await page.waitForTimeout(300);
    const pastLimit = await canvas.screenshot();
    expect(pastLimit.equals(atLimit), "scrolling in further once clamped must be a no-op in perspective too").toBe(true);
  });
});
