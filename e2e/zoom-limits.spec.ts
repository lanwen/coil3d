import { expect, test, type Locator, type Page } from "@playwright/test";
import { encodeHashDoc } from "./hashDoc";

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
// input is a true no-op once the bound is hit) -- a pixel-count/area
// argument doesn't actually work here, because at extreme zoom the
// line-art render's own background-vs-model diff mostly just measures how
// many groove lines happen to be in frame (interior fill is white, same as
// the canvas background), which isn't monotonic with zoom at all -- see
// this file's own history for the pixel-count version that was tried and
// rejected for exactly that reason.
//
// PR #59 review: the original version drove this with dozens of small
// sequential `page.mouse.wheel()` calls plus fixed `waitForTimeout`s, which
// timed out under `--workers=2` load. Two fixes:
// - `three`'s OrbitControls scales its zoom per wheel EVENT by a roughly
//   constant ~5% (`Math.pow(0.95, zoomSpeed * |deltaY| * 0.01)`,
//   `node_modules/three/examples/jsm/controls/OrbitControls.js`) --
//   empirically, a single `page.mouse.wheel()` call, regardless of the
//   magnitude passed to it, only ever contributes about one such step (the
//   synthetic event Chromium actually dispatches doesn't scale with the
//   requested delta the way a real trackpad's would), so reaching the
//   clamp genuinely needs many discrete wheel events, not a few huge ones.
//   What DOES cut this down to a single fast round trip: dispatching many
//   native `WheelEvent`s directly on the canvas from inside the page (one
//   `page.evaluate` call, a tight synchronous loop) instead of many
//   separate Playwright protocol round trips -- confirmed to reach and
//   hold the exact clamp in <5ms for 60+ events, vs. dozens of real
//   round trips previously.
// - `waitForSettled` polls the canvas screenshot until it stops changing
//   (bounded, short-interval), instead of a fixed sleep -- fast when the
//   machine is idle, and correspondingly patient under load, rather than
//   racing a guessed constant either way.

const SQUAT = encodeHashDoc({ L: 1000, d: 4, size: 40 });
// Comfortably more than the ~30-40 events three's own ~5%-per-event scale
// needs to cross the 0.3x-4x range from a fitted start; the SECOND batch
// below (same size again) is the "well past the limit" half of the check.
const TICKS = 60;

async function gotoDesign(page: Page, hash: string) {
  await page.goto(`/${hash}`);
  await expect(page.getByTestId("coil-viewer").locator("canvas")).toBeVisible();
  // Wait for the FINAL-resolution mesh before settling: the draft->final
  // swap (issue #7) is CPU-time-, not wall-clock-bound, so a fixed sleep
  // alone can race it under a loaded/slow CI run (see line-art.spec.ts's
  // gotoDesign, issue #61/#62, for the full story). This suite's baseline
  // screenshots were always taken against the final mesh; without this wait
  // a slow/loaded run could take its "before" capture off the draft mesh
  // instead, which is a determinism risk, not a speed one.
  await expect(page.getByTestId("download-stl")).toBeEnabled();
  await page.waitForTimeout(1000);
}

/** Polls `canvas.screenshot()` until two consecutive reads are byte-identical (the render has settled) or `maxWaitMs` elapses, whichever comes first -- a real "wait for the render to finish changing" signal instead of a fixed sleep, so this test is neither slower than it needs to be when idle nor flaky under load. */
async function waitForSettled(canvas: Locator, maxWaitMs = 3000, pollMs = 100): Promise<Buffer> {
  let prev = await canvas.screenshot();
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    const next = await canvas.screenshot();
    if (next.equals(prev)) return next;
    prev = next;
  }
  return prev;
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

/** Dispatches `count` native `WheelEvent`s directly on the canvas, all inside one `page.evaluate` round trip (see the file header for why this replaces separate `page.mouse.wheel()` calls). Scrolling "up" (negative deltaY) zooms in; "down" (positive) zooms out -- matches the existing convention in top-cap.spec.ts/mount-plate.spec.ts. */
async function dispatchWheel(page: Page, deltaY: number, count: number) {
  await page.evaluate(
    ({ deltaY, count }) => {
      const canvas = document.querySelector('[data-testid="coil-viewer"] canvas') as HTMLCanvasElement;
      const rect = canvas.getBoundingClientRect();
      const init: WheelEventInit = { bubbles: true, cancelable: true, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2, deltaY, deltaMode: 0 };
      for (let i = 0; i < count; i++) canvas.dispatchEvent(new WheelEvent("wheel", init));
    },
    { deltaY, count },
  );
}

test.describe("zoom limits (issue #48)", () => {
  test("extreme zoom-in is clamped: well past the limit stops changing the render, and the silhouette still shows", async ({ page }) => {
    await gotoDesign(page, SQUAT);
    const canvas = page.getByTestId("coil-viewer").locator("canvas");
    const before = await canvas.screenshot();

    await dispatchWheel(page, -120, TICKS);
    const atLimit = await waitForSettled(canvas);
    expect(atLimit.equals(before), "zooming in must actually change the render").toBe(false);

    await dispatchWheel(page, -120, TICKS); // well past whatever it took to hit the ceiling
    const pastLimit = await waitForSettled(canvas);
    expect(pastLimit.equals(atLimit), "scrolling in further once clamped must be a no-op").toBe(true);

    expect(await hasNonBackgroundPixels(page, pastLimit.toString("base64"))).toBe(true);
  });

  test("extreme zoom-out is clamped: well past the limit stops changing the render, and the silhouette still shows", async ({ page }) => {
    await gotoDesign(page, SQUAT);
    const canvas = page.getByTestId("coil-viewer").locator("canvas");
    const before = await canvas.screenshot();

    await dispatchWheel(page, 120, TICKS);
    const atLimit = await waitForSettled(canvas);
    expect(atLimit.equals(before), "zooming out must actually change the render").toBe(false);

    await dispatchWheel(page, 120, TICKS);
    const pastLimit = await waitForSettled(canvas);
    expect(pastLimit.equals(atLimit), "scrolling out further once clamped must be a no-op").toBe(true);

    expect(await hasNonBackgroundPixels(page, pastLimit.toString("base64"))).toBe(true);
  });

  test("the clamp also applies in perspective projection", async ({ page }) => {
    await gotoDesign(page, SQUAT);
    await page.getByTestId("toggle-projection").check();
    await waitForSettled(page.getByTestId("coil-viewer").locator("canvas"));

    const canvas = page.getByTestId("coil-viewer").locator("canvas");

    await dispatchWheel(page, -120, TICKS);
    const atLimit = await waitForSettled(canvas);
    expect(await hasNonBackgroundPixels(page, atLimit.toString("base64"))).toBe(true);

    await dispatchWheel(page, -120, TICKS);
    const pastLimit = await waitForSettled(canvas);
    expect(pastLimit.equals(atLimit), "scrolling in further once clamped must be a no-op in perspective too").toBe(true);
  });
});
