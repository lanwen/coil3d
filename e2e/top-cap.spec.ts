import { expect, test, type Page } from "@playwright/test";
import { decodeHashDoc } from "./hashDoc";

// End-to-end checks for issue #9 (top cap, joints, exploded view,
// docs/research.md §1 "Cap joint" & §4 "Joints / tolerances"). Solver/geometry
// numbers themselves are covered by vitest against the public `design()`
// interface (test/topCap.test.ts); these tests check the URL hash <-> UI <->
// viewer seam: the cap/joint/tolerance controls, the auto-cap decision
// showing/hiding the exploded-view toggle, and the exploded animation itself.

// outer=60, height=60 (both locked), layers=2 locked -> layers > 1, so the
// top cap is auto-on and every joint has room for its features (>= the
// JOINT_ENGAGE_DEPTH + margin floor in src/core/constants.ts).
const TWO_LAYER = "#v=1&L=6000&d=3.8&lock=outer,h,ly&size=60&h=60&ly=2";
const ONE_LAYER = "#v=1&L=1000&d=4&size=40"; // layers=1 (default): no top cap

async function gotoDesign(page: Page, hash: string) {
  await page.goto(`/${hash}`);
  await expect(page.getByTestId("coil-viewer").locator("canvas")).toBeVisible();
  // Wait for the FINAL-resolution mesh before settling: the draft->final
  // swap (issue #7) is CPU-time-, not wall-clock-bound, so a fixed sleep
  // alone can race it under a loaded/slow CI run (see line-art.spec.ts's
  // gotoDesign, issue #61/#62, for the full story).
  await expect(page.getByTestId("download-stl")).toBeEnabled();
  await page.waitForTimeout(800);
}

test.describe("top cap controls and auto-decision (issue #9)", () => {
  test("layers=1 (auto): no top cap, no exploded-view toggle, result panel says off", async ({ page }) => {
    await gotoDesign(page, ONE_LAYER);
    await expect(page.getByTestId("caps")).toContainText("off");
    await expect(page.getByTestId("toggle-exploded")).toHaveCount(0);
    await expect(page.getByTestId("mesh-detail")).toContainText("1 part");
  });

  test("layers=2 (auto): a top cap is added, and the exploded-view toggle appears", async ({ page }) => {
    await gotoDesign(page, TWO_LAYER);
    await expect(page.getByTestId("caps")).toContainText("on");
    await expect(page.getByTestId("toggle-exploded")).toBeVisible();
    await expect(page.getByTestId("mesh-detail")).toContainText("2 parts");
  });

  test("overriding the top cap off removes it even with layers=2", async ({ page }) => {
    await gotoDesign(page, `${TWO_LAYER}&cap=off`);
    await expect(page.getByTestId("select-topCap")).toHaveValue("off");
    await expect(page.getByTestId("caps")).toContainText("off");
    await expect(page.getByTestId("toggle-exploded")).toHaveCount(0);
  });

  test("changing the joint and tolerance controls updates the hash, and reloading reproduces them", async ({ page }) => {
    await gotoDesign(page, TWO_LAYER);
    await page.getByTestId("select-joint").selectOption("bayonet");
    await expect(async () => expect(decodeHashDoc(page.url()).joint).toBe("bayonet")).toPass();

    const tol = page.getByTestId("input-tolerance");
    await tol.fill("0.35");
    await tol.blur();
    await expect(async () => expect(decodeHashDoc(page.url()).tol).toBe(0.35)).toPass();

    await page.reload();
    await expect(page.getByTestId("select-joint")).toHaveValue("bayonet");
    await expect(page.getByTestId("input-tolerance")).toHaveValue("0.35");
  });
});

// This describe (and "assembled and exploded screenshots per joint" below)
// is specifically ABOUT the exploded-view animation, so both opt back into
// real motion over the suite-wide `reducedMotion: "reduce"` default
// (playwright.config.ts), matching how these screenshots' baselines were
// originally shot.
test.describe("exploded-view animation (issue #9)", () => {
  test.use({ contextOptions: { reducedMotion: "no-preference" } });

  test("the exploded-view toggle changes the render and can be turned back off", async ({ page }) => {
    await gotoDesign(page, TWO_LAYER);
    const canvas = page.getByTestId("coil-viewer").locator("canvas");
    await expect(canvas).toHaveScreenshot("top-cap-assembled-press.png");
    const assembled = await canvas.screenshot();

    await page.getByTestId("toggle-exploded").check();
    // The explode animation eases in (CoilViewer.tsx); give it time to settle.
    await page.waitForTimeout(1000);
    const exploded = await canvas.screenshot();
    // An exact byte comparison, not `toHaveScreenshot`'s tolerant perceptual
    // diff (maxDiffPixelRatio 0.02, see playwright.config.ts): the cap lifts
    // along the coil's own axis, which under this oblique camera can shift
    // only a modest, well-under-2%, slice of the canvas -- a real change,
    // but not one the tolerant comparison is guaranteed to flag as "different".
    expect(exploded.equals(assembled), "exploding must change the render").toBe(false);
    // The joint=press (default) exploded baseline, once also re-asserted by
    // the JOINTS loop below with its own real-motion page load -- moved here
    // since this test already explodes and settles the same design/joint.
    await expect(canvas).toHaveScreenshot("top-cap-exploded-press.png");

    await page.getByTestId("toggle-exploded").uncheck();
    await page.waitForTimeout(1000);
    await expect(canvas, "collapsing back must restore the assembled render").toHaveScreenshot("top-cap-assembled-press.png");
  });
});

// "press" (the default joint) is covered above: "the exploded-view toggle
// changes the render..." already exercises the identical design/joint and
// now asserts both its assembled and exploded baselines, so it isn't
// repeated here -- press's own "assembled looks identical" baseline
// (top-cap-assembled-bayonet.png has the same bytes as ...-press.png, since
// the assembled view hides the joint) still stands on the bayonet entry.
const JOINTS: Array<{ id: "bayonet" | "snap"; label: string }> = [
  { id: "bayonet", label: "bayonet" },
  { id: "snap", label: "snap" },
];

test.describe("assembled and exploded screenshots per joint (issue #9)", () => {
  test.use({ contextOptions: { reducedMotion: "no-preference" } });

  for (const { id, label } of JOINTS) {
    test(`joint=${id}: assembled and exploded views`, async ({ page }) => {
      await gotoDesign(page, `${TWO_LAYER}&joint=${id}`);
      await expect(page.getByTestId("select-joint")).toHaveValue(id);
      const canvas = page.getByTestId("coil-viewer").locator("canvas");

      await expect(canvas).toHaveScreenshot(`top-cap-assembled-${label}.png`);

      await page.getByTestId("toggle-exploded").check();
      await page.waitForTimeout(1000);
      await expect(canvas).toHaveScreenshot(`top-cap-exploded-${label}.png`);
    });
  }
});

test.describe("rim keyhole close-up (issue #9)", () => {
  test("zooming in on the assembled cap shows the rim keyhole cutout", async ({ page }) => {
    await gotoDesign(page, TWO_LAYER);
    const canvas = page.getByTestId("coil-viewer").locator("canvas");
    const box = (await canvas.boundingBox())!;
    // Orbit controls zoom on wheel; scrolling "up" (negative deltaY) zooms in,
    // centered on the pointer -- point it near the cap's own rim so the
    // keyhole ends up in frame, not just the coil's center.
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.35);
    for (let i = 0; i < 8; i++) {
      await page.mouse.wheel(0, -120);
      await page.waitForTimeout(50);
    }
    await expect(canvas).toHaveScreenshot("top-cap-keyhole-closeup.png");
  });
});
