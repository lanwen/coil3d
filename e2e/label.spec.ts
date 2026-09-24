import { expect, test, type Page } from "@playwright/test";

// End-to-end checks for issue #12 (label on the top cap, docs/research.md
// §1 "Extras"). Solver/geometry numbers themselves are covered by vitest
// against the public `design()` interface (test/label.test.ts); these tests
// check the URL hash <-> UI <-> viewer seam: the label text field, the fit
// warning, and that the engraved text actually shows up in the line-art
// render.

// 6 layers of wound wire on a small 30mm core (mirrors test/label.test.ts's
// own ROOMY_CAP fixture): the flange -- and so the top cap's own annulus --
// grows well past the core's own outline, leaving plenty of room for a
// short label at a legible height.
const ROOMY_ROUND = "#v=1&L=6000&d=3.8&lock=outer,h,ly&size=30&h=60&ly=6";
const ROOMY_SQUARE = `${ROOMY_ROUND}&shape=sq`;

async function gotoDesign(page: Page, hash: string) {
  await page.goto(`/${hash}`);
  await expect(page.getByTestId("coil-viewer").locator("canvas")).toBeVisible();
  await page.waitForTimeout(800);
}

/** Zoom the canvas in on the top cap's face (mirrors top-cap.spec.ts's own
 * rim-keyhole close-up: point near the top-center of the default isometric
 * view, where the cap's room-facing annulus projects, and scroll to zoom). */
async function zoomOnCapFace(page: Page) {
  const canvas = page.getByTestId("coil-viewer").locator("canvas");
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.32);
  for (let i = 0; i < 10; i++) {
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(300);
  return canvas;
}

test.describe("top cap label controls (issue #12)", () => {
  test("the label field reflects the hash on load, and reloading after typing reproduces it", async ({ page }) => {
    await gotoDesign(page, ROOMY_ROUND);
    await expect(page.getByTestId("input-label")).toHaveValue("");

    const input = page.getByTestId("input-label");
    await input.fill("USB-C 2m");
    await input.blur();
    // URLSearchParams' own space encoding (matches test/hash.test.ts).
    await expect(async () => expect(new URL(page.url()).hash).toContain("label=USB-C+2m")).toPass();

    await page.reload();
    await expect(page.getByTestId("coil-viewer").locator("canvas")).toBeVisible();
    await expect(page.getByTestId("input-label")).toHaveValue("USB-C 2m");
  });

  test("a label that fits shows no fit warning", async ({ page }) => {
    await gotoDesign(page, `${ROOMY_ROUND}&label=USB-C%202m`);
    // This roomy fixture (see ROOMY_ROUND's own comment) overshoots the
    // target cable length on purpose, which is its own unrelated warning
    // (solve.ts) -- assert the LABEL fit warning specifically is absent,
    // not that the panel has no warnings at all.
    await expect(page.getByTestId("warnings")).not.toContainText("doesn't fit");
  });

  test("a label too wide for the annulus shows a fit warning and hides the text", async ({ page }) => {
    // 25 characters -- still under the hash/UI's 40-char cap, but too wide
    // for this cap's annulus even at the minimum legible height (verified in
    // test/label.test.ts's own geometry-level fit check).
    await gotoDesign(page, `${ROOMY_ROUND}&label=${encodeURIComponent("The Quick Brown Fox Jumps")}`);
    await expect(page.getByTestId("warnings")).toContainText("doesn't fit");
    await expect(page.getByTestId("warnings")).toContainText("hidden");
  });
});

test.describe("engraved label render, round and square (issue #12)", () => {
  test("round cap: the label is visible, legible in the line-art render", async ({ page }) => {
    await gotoDesign(page, `${ROOMY_ROUND}&label=USB-C%202m`);
    const canvas = await zoomOnCapFace(page);
    await expect(canvas).toHaveScreenshot("label-round.png");
  });

  test("square cap: the label is visible, legible in the line-art render", async ({ page }) => {
    await gotoDesign(page, `${ROOMY_SQUARE}&label=USB-C%202m`);
    const canvas = await zoomOnCapFace(page);
    await expect(canvas).toHaveScreenshot("label-square.png");
  });

  test("engraving the label actually changes the render vs. no label", async ({ page }) => {
    await gotoDesign(page, ROOMY_ROUND);
    const canvas = await zoomOnCapFace(page);
    const plain = await canvas.screenshot();

    // A hash-only `page.goto` is a same-document navigation in Chromium (no
    // reload -- App.tsx reads the hash once, at mount, via `useState`), so a
    // second `gotoDesign` here would leave the app on the FIRST design and
    // merely zoom the still-live camera in further. `page.reload()` forces
    // a genuine remount against the now-current (label) hash, and resets
    // the camera to its default framing before this test re-zooms.
    await page.goto(`/${ROOMY_ROUND}&label=USB-C%202m`);
    await page.reload();
    await expect(page.getByTestId("coil-viewer").locator("canvas")).toBeVisible();
    await page.waitForTimeout(800);
    const canvasAfter = await zoomOnCapFace(page);
    const labelled = await canvasAfter.screenshot();

    expect(labelled.equals(plain), "engraving the label must change the render").toBe(false);
  });
});

test.describe("too-long-text warning (issue #12)", () => {
  test("the result panel shows the fit warning for text that doesn't fit", async ({ page }) => {
    await gotoDesign(page, `${ROOMY_ROUND}&label=${encodeURIComponent("The Quick Brown Fox Jumps")}`);
    const warnings = page.getByTestId("warnings");
    await expect(warnings).toContainText("doesn't fit");
    await expect(warnings).toHaveScreenshot("label-too-long-warning.png");
  });
});
