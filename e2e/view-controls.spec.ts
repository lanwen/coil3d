import { expect, test, type Page } from "@playwright/test";

// End-to-end checks for issue #15 (viewer controls polish, docs/research.md
// §10b "dual persp/ortho camera rig ... preset views with slerp transitions
// ... tweened parameter changes"). Solver/geometry numbers are unaffected by
// this ticket (vitest coverage is unchanged); these tests check the viewer
// overlay <-> camera seam: preset-view buttons, the perspective/orthographic
// toggle, and prefers-reduced-motion turning every transition instant.

const SQUAT = "#v=1&L=1000&d=4&size=40";
// layers=2 locked, so the exploded-view toggle is present too (issue #9),
// letting the explode-toggle's own camera reframe (issue #9 review) share
// coverage with the preset/projection tests below.
const TWO_LAYER = "#v=1&L=6000&d=3.8&lock=outer,h,ly&size=60&h=60&ly=2";

async function gotoDesign(page: Page, hash: string) {
  await page.goto(`/${hash}`);
  await expect(page.getByTestId("coil-viewer").locator("canvas")).toBeVisible();
  // A full second, not the usual 800ms (e.g. top-cap.spec.ts): the sidebar's
  // "Kanit" webfont can still be loading at 800ms, and its arrival reflows
  // the header/sidebar and so the canvas's own CSS size by a few px -- which
  // re-fits the camera (LineArtRenderer's own resize effect) right as this
  // file's tests take their first screenshot. Otherwise harmless (every
  // other suite's 800ms-then-go-straight-to-interacting tests never
  // happen to sample a screenshot in that exact narrow window), but these
  // tests specifically compare a "before" screenshot byte-for-byte/near-
  // exactly against later ones, so they need the layout fully settled first.
  await page.waitForTimeout(1000);
}

const PRESETS = ["front", "side", "top", "iso"] as const;

test.describe("camera view presets (issue #15)", () => {
  test("iso is the default, active preset on load", async ({ page }) => {
    await gotoDesign(page, SQUAT);
    await expect(page.getByTestId("preset-iso")).toHaveAttribute("aria-pressed", "true");
    for (const id of ["front", "side", "top"]) {
      await expect(page.getByTestId(`preset-${id}`)).toHaveAttribute("aria-pressed", "false");
    }
  });

  test("each preset renders a distinct view, and clicking one marks it active", async ({ page }) => {
    await gotoDesign(page, SQUAT);
    const canvas = page.getByTestId("coil-viewer").locator("canvas");
    const shots: Record<string, Buffer> = {};

    for (const id of PRESETS) {
      await page.getByTestId(`preset-${id}`).click();
      await expect(page.getByTestId(`preset-${id}`)).toHaveAttribute("aria-pressed", "true");
      await page.waitForTimeout(700); // slerp settles (ORIENT_TWEEN_MS in LineArtRenderer.tsx)
      shots[id] = await canvas.screenshot();
    }

    // Every preset must actually change the render -- an exact byte
    // comparison (not toHaveScreenshot's tolerant perceptual diff): a
    // camera rotation moves real silhouette pixels well past the 2%
    // maxDiffPixelRatio tolerance, so an exact inequality is the honest check.
    for (let i = 0; i < PRESETS.length; i++) {
      for (let j = i + 1; j < PRESETS.length; j++) {
        expect(shots[PRESETS[i]].equals(shots[PRESETS[j]]), `${PRESETS[i]} vs ${PRESETS[j]} must differ`).toBe(false);
      }
    }
  });

  test("returning to iso after visiting the other presets reproduces the original render", async ({ page }) => {
    await gotoDesign(page, SQUAT);
    const canvas = page.getByTestId("coil-viewer").locator("canvas");
    await page.waitForTimeout(600);
    // A tolerant baseline compare (like the rest of the suite's round-trip
    // checks, e.g. top-cap.spec.ts's assembled/exploded/assembled cycle),
    // not an exact byte match: several chained slerps accumulate float
    // noise nowhere near visible but easily enough to flip an antialiased
    // edge pixel by 1 unit.
    await expect(canvas).toHaveScreenshot("view-controls-iso-baseline.png");

    for (const id of ["front", "top", "side", "iso"] as const) {
      await page.getByTestId(`preset-${id}`).click();
      await page.waitForTimeout(700);
    }
    await expect(canvas).toHaveScreenshot("view-controls-iso-baseline.png");
  });

  test("prefers-reduced-motion jumps to the preset instantly instead of slerping", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await gotoDesign(page, SQUAT);
    const canvas = page.getByTestId("coil-viewer").locator("canvas");

    await page.getByTestId("preset-top").click();
    await page.waitForTimeout(60); // well under the normal-motion slerp duration
    const soonAfterClick = await canvas.screenshot();

    await page.waitForTimeout(700);
    const settled = await canvas.screenshot();
    expect(soonAfterClick.equals(settled), "reduced motion must already show the settled top view almost immediately").toBe(true);
  });
});

test.describe("perspective/orthographic toggle (issue #15)", () => {
  test("defaults to orthographic, unchecked", async ({ page }) => {
    await gotoDesign(page, SQUAT);
    await expect(page.getByTestId("toggle-projection")).not.toBeChecked();
  });

  test("toggling on and back off reproduces the original orthographic render", async ({ page }) => {
    await gotoDesign(page, SQUAT);
    const canvas = page.getByTestId("coil-viewer").locator("canvas");
    const orthoBefore = await canvas.screenshot();
    // A tolerant baseline for the "restores exactly" half below (matching
    // top-cap.spec.ts's own assembled/exploded/assembled pattern): the
    // ortho<->perspective refit (LineArtRenderer.tsx's own projection-toggle
    // effect) is exact in world units, but re-deriving it through a camera
    // round trip isn't guaranteed bit-identical at the pixel level.
    await expect(canvas).toHaveScreenshot("view-controls-ortho-baseline.png");

    await page.getByTestId("toggle-projection").check();
    await page.waitForTimeout(600);
    const perspective = await canvas.screenshot();
    expect(perspective.equals(orthoBefore), "switching to perspective must change the render").toBe(false);

    await page.getByTestId("toggle-projection").uncheck();
    await page.waitForTimeout(600);
    await expect(canvas).toHaveScreenshot("view-controls-ortho-baseline.png");
  });

  test("the model stays comfortably on screen after toggling to perspective (on-screen scale preserved)", async ({ page }) => {
    await gotoDesign(page, SQUAT);
    const canvas = page.getByTestId("coil-viewer").locator("canvas");
    const countModelPixels = async () =>
      page.evaluate(async (b64) => {
        const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
        const img = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
        const ctx = new OffscreenCanvas(img.width, img.height).getContext("2d")!;
        ctx.drawImage(img, 0, 0);
        const raw = ctx.getImageData(0, 0, img.width, img.height).data;
        const bg = [raw[0], raw[1], raw[2]];
        let count = 0;
        for (let i = 0; i < raw.length; i += 4) {
          if (Math.abs(raw[i] - bg[0]) > 8 || Math.abs(raw[i + 1] - bg[1]) > 8 || Math.abs(raw[i + 2] - bg[2]) > 8) count++;
        }
        return count;
      }, (await canvas.screenshot()).toString("base64"));

    const beforeCount = await countModelPixels();

    await page.getByTestId("toggle-projection").check();
    await page.waitForTimeout(600);
    const afterCount = await countModelPixels();

    // "Preserves on-screen scale" means the toggle neither shrinks the
    // model to a speck nor blows it up past the frame -- a generous band
    // (not an exact match) around the ortho pixel count catches an actual
    // regression (e.g. a clipped-out model, or one suddenly a tenth its
    // former size) without being brittle.
    expect(afterCount).toBeGreaterThan(beforeCount * 0.7);
    expect(afterCount).toBeLessThan(beforeCount * 1.4);
  });

  test("a deep, edge-on, tightly-framed model (exploded + side view) stays clearly visible in perspective too", async ({ page }) => {
    await gotoDesign(page, TWO_LAYER);
    // A side-on preset stresses foreshortening the most (the model's own
    // depth extent, seen edge-on, is largest relative to its projected
    // width, and the exploded view's own tighter fill leaves less margin
    // to absorb it) -- see LineArtRenderer.tsx's computeFit doc comment.
    await page.getByTestId("preset-side").click();
    await page.waitForTimeout(700);
    await page.getByTestId("toggle-exploded").check();
    await page.waitForTimeout(1200);

    const canvas = page.getByTestId("coil-viewer").locator("canvas");
    const countModelPixels = async () =>
      page.evaluate(async (b64) => {
        const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
        const img = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
        const ctx = new OffscreenCanvas(img.width, img.height).getContext("2d")!;
        ctx.drawImage(img, 0, 0);
        const raw = ctx.getImageData(0, 0, img.width, img.height).data;
        const bg = [raw[0], raw[1], raw[2]];
        let count = 0;
        for (let i = 0; i < raw.length; i += 4) {
          if (Math.abs(raw[i] - bg[0]) > 8 || Math.abs(raw[i + 1] - bg[1]) > 8 || Math.abs(raw[i + 2] - bg[2]) > 8) count++;
        }
        return count;
      }, (await canvas.screenshot()).toString("base64"));

    const beforeCount = await countModelPixels();
    await page.getByTestId("toggle-projection").check();
    await page.waitForTimeout(600);
    const afterCount = await countModelPixels();

    // Loose sanity, not a scale match: this specific view legitimately asks
    // perspective to pad more for foreshortening than ortho ever needed to
    // (computeFit's own doc comment), so it reads visibly smaller -- the
    // point of this test is only to catch a REAL regression (the model
    // clipped almost entirely out of frame, or reduced to a speck), which
    // an earlier version of the projection-toggle math actually did.
    expect(afterCount).toBeGreaterThan(beforeCount * 0.3);
    expect(afterCount).toBeLessThan(beforeCount * 2);
  });
});
