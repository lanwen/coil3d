import { expect, test, type Page } from "@playwright/test";
import { encodeHashDoc } from "./hashDoc";

// This whole file is ABOUT the transition system itself, so it opts back
// into real motion over the suite-wide `reducedMotion: "reduce"` default
// (playwright.config.ts): the two "prefers-reduced-motion" tests below
// still need a real, non-instant baseline to prove reduced motion actually
// changes anything, and the rest capture real (settled-after-slerp)
// screenshots the same way the checked-in baselines were shot.
test.use({ contextOptions: { reducedMotion: "no-preference" } });

// End-to-end checks for the viewer's camera-view controls. Issue #15
// originally shipped four standing presets (front/side/top/iso) plus a
// perspective/orthographic toggle; issue #49 trimmed the bar down to just
// Front, Iso and Wall mount (the room-side hung view) -- see presets.ts's
// own file header for why side/top/the mount-side wall preset are gone
// entirely, not just hidden. Solver/geometry numbers are unaffected by
// either ticket (vitest coverage is unchanged); these tests check the
// viewer overlay <-> camera seam: preset-view buttons, the perspective/
// orthographic toggle, and prefers-reduced-motion turning every transition
// instant.

const SQUAT = encodeHashDoc({ L: 1000, d: 4, size: 40 });
// layers=2 locked, so the exploded-view toggle is present too (issue #9),
// letting the explode-toggle's own camera reframe (issue #9 review) share
// coverage with the preset/projection tests below.
const TWO_LAYER = encodeHashDoc({ L: 5000, d: 3.8, lock: ["outer", "h"], size: 60, h: 60 });
// A screw-keyhole mount so the "Wall mount" preset actually rotates the
// geometry into a real hung pose (unmounted designs still show the room-side
// preset -- it's just a plain standing-on-the-flange rotation with no real
// mount feature to look at).
const KEYHOLE = encodeHashDoc({ L: 2000, d: 4, size: 100, h: 60, mount: "keyhole" });

async function gotoDesign(page: Page, hash: string) {
  await page.goto(`/${hash}`);
  await expect(page.getByTestId("coil-viewer").locator("canvas")).toBeVisible();
  // Wait for the FINAL-resolution mesh before settling: the draft->final
  // swap (issue #7) is CPU-time-, not wall-clock-bound, so a fixed sleep
  // alone can race it under a loaded/slow CI run (see line-art.spec.ts's
  // gotoDesign, issue #61/#62, for the full story).
  await expect(page.getByTestId("download-stl")).toBeEnabled();
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

test.describe("camera view presets (issue #15/#49)", () => {
  test("only Front, Iso and Wall mount are offered; iso is the default, active preset on load", async ({ page }) => {
    await gotoDesign(page, SQUAT);
    await expect(page.getByTestId("preset-iso")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("preset-front")).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("preset-wallRoom")).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("preset-side")).toHaveCount(0);
    await expect(page.getByTestId("preset-top")).toHaveCount(0);
    await expect(page.getByTestId("toggle-wall-view")).toHaveCount(0); // the standalone cycling button (issue #13) is gone -- folded into this bar
  });

  test("front, iso and wall-mount each render a distinct view (and screenshot each preset)", async ({ page }) => {
    await gotoDesign(page, KEYHOLE);
    const canvas = page.getByTestId("coil-viewer").locator("canvas");
    const shots: Record<string, Buffer> = {};

    for (const id of ["front", "iso", "wallRoom"] as const) {
      await page.getByTestId(`preset-${id}`).click();
      await expect(page.getByTestId(`preset-${id}`)).toHaveAttribute("aria-pressed", "true");
      await page.waitForTimeout(900); // slerp (ORIENT_TWEEN_MS) + wall-mount's own geometry-swap scale tween
      shots[id] = await canvas.screenshot();
      await expect(canvas).toHaveScreenshot(`view-controls-preset-${id}.png`);
    }

    // Every preset must actually change the render -- an exact byte
    // comparison (not toHaveScreenshot's tolerant perceptual diff): a
    // camera rotation/geometry swap moves real silhouette pixels well past
    // the 0.5% maxDiffPixelRatio tolerance, so an exact inequality is the
    // honest check.
    const ids = ["front", "iso", "wallRoom"] as const;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        expect(shots[ids[i]].equals(shots[ids[j]]), `${ids[i]} vs ${ids[j]} must differ`).toBe(false);
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

    for (const id of ["front", "wallRoom", "iso"] as const) {
      await page.getByTestId(`preset-${id}`).click();
      await page.waitForTimeout(900);
    }
    await expect(canvas).toHaveScreenshot("view-controls-iso-baseline.png");
  });

  test("prefers-reduced-motion jumps to the preset instantly instead of slerping", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await gotoDesign(page, SQUAT);
    const canvas = page.getByTestId("coil-viewer").locator("canvas");

    await page.getByTestId("preset-front").click();
    await page.waitForTimeout(60); // well under the normal-motion slerp duration
    const soonAfterClick = await canvas.screenshot();

    await page.waitForTimeout(900);
    const settled = await canvas.screenshot();
    expect(soonAfterClick.equals(settled), "reduced motion must already show the settled front view almost immediately").toBe(true);
  });

  test("prefers-reduced-motion also makes the wall-mount preset's transition instant", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await gotoDesign(page, KEYHOLE);
    const canvas = page.getByTestId("coil-viewer").locator("canvas");

    await page.getByTestId("preset-wallRoom").click();
    await page.waitForTimeout(60);
    const soonAfterClick = await canvas.screenshot();

    await page.waitForTimeout(900);
    const settled = await canvas.screenshot();
    expect(soonAfterClick.equals(settled), "reduced motion must already show the settled wall-mount view almost immediately").toBe(true);
  });

  test("the wall-mount preset shows a caption; front/iso don't", async ({ page }) => {
    await gotoDesign(page, KEYHOLE);
    await expect(page.getByTestId("wall-view-caption")).toHaveCount(0);

    await page.getByTestId("preset-wallRoom").click();
    await expect(page.getByTestId("wall-view-caption")).toHaveText(/top cap faces the room/i);

    await page.getByTestId("preset-front").click();
    await expect(page.getByTestId("wall-view-caption")).toHaveCount(0);
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

  test("a deep, exploded model stays clearly visible in perspective too", async ({ page }) => {
    await gotoDesign(page, TWO_LAYER);
    // Exploded view (its own tighter fill leaves less margin to absorb
    // foreshortening) -- see LineArtRenderer.tsx's computeFit doc comment.
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

// Issue #141: the preset picker is its own borderless bar -- top centre of
// the viewport, clear of the top-left toggles and the top-right projection
// switch, or bottom centre when the viewport is too narrow for that (phone).
const SKADIS = encodeHashDoc({ L: 2000, d: 3.8, size: 100, h: 60, mount: "skadis" });
const OVERLAYS = [".wire-toggle", ".dimensions-toggle", ".explode-toggle", ".projection-toggle-box", ".wall-view-caption"];

async function expectBarClearOfOverlays(page: Page) {
  const bar = (await page.locator(".preset-bar").boundingBox())!;
  for (const selector of OVERLAYS) {
    for (const el of await page.locator(selector).all()) {
      const box = await el.boundingBox();
      if (!box) continue; // unmounted between all() and here (e.g. a caption swapping out)
      const overlaps = bar.x < box.x + box.width && box.x < bar.x + bar.width && bar.y < box.y + box.height && box.y < bar.y + bar.height;
      expect(overlaps, `preset bar overlaps ${selector}`).toBe(false);
    }
  }
  return bar;
}

test.describe("preset bar layout (issue #141)", () => {
  // Only the bar's own layout/state matters here, not the camera tween.
  test.use({ contextOptions: { reducedMotion: "reduce" } });

  test("desktop: top centre, no border, active preset is a solid ink pill, clear of every other overlay", async ({ page }) => {
    await gotoDesign(page, SKADIS);
    const viewer = (await page.locator(".viewer").boundingBox())!;
    const bar = await expectBarClearOfOverlays(page);
    expect(Math.abs(bar.x + bar.width / 2 - (viewer.x + viewer.width / 2)), "horizontally centred").toBeLessThan(2);
    expect(bar.y - viewer.y, "at the top").toBeLessThan(20);
    expect(await page.locator(".preset-bar").evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe("0px");

    for (const id of ["front", "iso", "wallRoom", "mountSide", "printLayout"] as const) {
      await page.getByTestId(`preset-${id}`).click();
      await expect(page.getByTestId(`preset-${id}`)).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator('.preset-btn[aria-pressed="true"]')).toHaveCount(1);
      await expect(page.locator(".wire-toggle")).toHaveCount(id === "printLayout" ? 0 : 1); // settle the print layout's toggle unmount
      const [bg, fg] = await page.getByTestId(`preset-${id}`).evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).color]);
      expect(bg).toBe("rgb(0, 0, 0)");
      expect(fg).toBe("rgb(255, 255, 255)");
      await expectBarClearOfOverlays(page);
      await expect(page.locator(".preset-bar")).toHaveScreenshot(`preset-bar-${id}.png`);
    }
  });

  test("every preset has an accessible name and shows its label on keyboard focus", async ({ page }) => {
    await gotoDesign(page, SKADIS);
    const names = { front: "Front view", iso: "Iso view", wallRoom: "Wall mount view", mountSide: "Mount side view", printLayout: "Print layout view" };
    for (const [id, name] of Object.entries(names)) {
      await expect(page.getByRole("button", { name, exact: true })).toHaveAttribute("data-testid", `preset-${id}`);
    }
    const tip = page.getByTestId("preset-front").locator(".preset-tip");
    await expect(tip).toHaveCSS("opacity", "0");
    await page.getByTestId("preset-iso").focus();
    await page.keyboard.press("Shift+Tab"); // keyboard focus -> :focus-visible
    await expect(page.getByTestId("preset-front")).toBeFocused();
    await expect(tip).toHaveCSS("opacity", "1");
    await expect(tip).toHaveText("Front");
  });

  test("phone width: the bar falls back to the bottom centre, clear of the toggles and captions", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoDesign(page, SKADIS);
    // The canvas frame, not `.viewer`: on a phone `.viewer` also holds the
    // toggle strip under the canvas (issue #145).
    const viewer = (await page.getByTestId("coil-viewer").boundingBox())!;
    for (const id of ["iso", "wallRoom", "mountSide", "printLayout"] as const) {
      await page.getByTestId(`preset-${id}`).click();
      await expect(page.getByTestId(`preset-${id}`)).toHaveAttribute("aria-pressed", "true");
      // The caption (the thing the bar is most likely to collide with at
      // the bottom) must be settled in before the overlap check.
      await expect(page.getByTestId("wall-view-caption")).toHaveCount(id === "iso" ? 0 : 1);
      // Print layout unmounts the toggles (App's `isPrintLayout`) a render
      // later; let that settle too, or boundingBox() waits on a gone node.
      await expect(page.locator(".wire-toggle")).toHaveCount(id === "printLayout" ? 0 : 1);
      const bar = await expectBarClearOfOverlays(page);
      expect(Math.abs(bar.x + bar.width / 2 - (viewer.x + viewer.width / 2)), "horizontally centred").toBeLessThan(2);
      expect(viewer.y + viewer.height - (bar.y + bar.height), "at the bottom").toBeLessThan(12);
      expect(bar.x).toBeGreaterThanOrEqual(viewer.x);
      expect(bar.x + bar.width).toBeLessThanOrEqual(viewer.x + viewer.width);
    }
  });
});
