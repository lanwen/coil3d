import { expect, test, type Page } from "@playwright/test";
import { decodeHashDoc } from "./hashDoc";

// End-to-end checks for issue #12 (label on the top cap, docs/design.md,
// Decisions). Solver/geometry numbers themselves are covered by vitest
// against the public `design()` interface (test/label.test.ts); these tests
// check the URL hash <-> UI <-> viewer seam: the label text field, the fit
// warning, and that the engraved text actually shows up in the line-art
// render.

// 6 layers of wound wire on a small 30mm core (mirrors test/label.test.ts's
// own ROOMY_CAP fixture): the flange -- and so the top cap's own annulus --
// grows well past the core's own outline, leaving plenty of room for a
// short label at a legible height.
const ROOMY_ROUND = "#v=1&L=6000&d=3.8&lock=outer,h,ly&size=30&h=60&ly=6";
// A bigger core (70mm, vs. round's 30mm) so a requested corner radius of 16
// clears the bend-limit floor for the default "usb" wire type at 3.8mm
// (MBR = 4 x 3.8 = 15.2mm) instead of being silently clamped UP to it --
// issue #12 review: the earlier fixture used the default corner radius
// (8mm) at size=30, which the solver clamps to the apothem (15mm), so the
// "square"/"triangle" core rendered fully round. rc=16 is comfortably above
// that floor, so these actually render as a rounded square/triangle.
const ROOMY_SQUARE = `${ROOMY_ROUND.replace("size=30", "size=70")}&shape=sq&sq.rc=16`;
const ROOMY_TRIANGLE = `${ROOMY_ROUND.replace("size=30", "size=70")}&shape=tri&tri.rc=16`;

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
  test("the label switch is off by default; switching it on reveals the text field, and reloading after typing reproduces both", async ({ page }) => {
    await gotoDesign(page, ROOMY_ROUND);
    // Issue #105 AC #5: off by default, and the text field stays hidden
    // until switched on.
    await expect(page.getByTestId("label-enabled")).not.toBeChecked();
    await expect(page.getByTestId("input-label")).toHaveCount(0);

    await page.getByTestId("label-enabled").check();
    await expect(page.getByTestId("input-label")).toHaveValue("");

    const input = page.getByTestId("input-label");
    await input.fill("USB-C 2m");
    await input.blur();
    await expect(async () => expect(decodeHashDoc(page.url()).label).toBe("USB-C 2m")).toPass();

    await page.reload();
    await expect(page.getByTestId("coil-viewer").locator("canvas")).toBeVisible();
    // A non-empty label in the hash auto-enables the switch and reveals the field.
    await expect(page.getByTestId("label-enabled")).toBeChecked();
    await expect(page.getByTestId("input-label")).toHaveValue("USB-C 2m");
  });

  test("switching the label off clears the text and hides the field from the hash", async ({ page }) => {
    await gotoDesign(page, `${ROOMY_ROUND}&label=USB-C%202m`);
    await expect(page.getByTestId("label-enabled")).toBeChecked();
    await expect(page.getByTestId("input-label")).toHaveValue("USB-C 2m");
    expect(decodeHashDoc(page.url()).label).toBe("USB-C 2m");

    await page.getByTestId("label-enabled").uncheck();
    await expect(page.getByTestId("input-label")).toHaveCount(0);
    await expect(async () => expect(decodeHashDoc(page.url()).label).toBeUndefined()).toPass();
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

test.describe("engraved label render, round/square/triangle (issue #12)", () => {
  test("round cap: the label is visible, legible in the line-art render", async ({ page }) => {
    await gotoDesign(page, `${ROOMY_ROUND}&label=USB-C%202m`);
    const canvas = await zoomOnCapFace(page);
    await expect(canvas).toHaveScreenshot("label-round.png");
  });

  test("square cap: a real rounded square (not clamped round), label centered on a flat side", async ({ page }) => {
    await gotoDesign(page, `${ROOMY_SQUARE}&label=USB-C%202m`);
    await expect(page.getByTestId("corner-radius")).toContainText("16.0 mm"); // not clamped up to the apothem -- see ROOMY_SQUARE's own comment
    const canvas = await zoomOnCapFace(page);
    await expect(canvas).toHaveScreenshot("label-square.png");
  });

  test("triangle cap: label centered on a flat side, not pointing at a corner", async ({ page }) => {
    await gotoDesign(page, `${ROOMY_TRIANGLE}&label=USB-C%202m`);
    await expect(page.getByTestId("corner-radius")).toContainText("16.0 mm");
    const canvas = await zoomOnCapFace(page);
    await expect(canvas).toHaveScreenshot("label-triangle.png");
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
    // Issue #192: a problem, so it's in the visible problems list (and also
    // under "All numbers", with every other message).
    await expect(page.getByTestId("warnings")).toContainText("doesn't fit");
    const problems = page.getByTestId("problems");
    await expect(problems).toContainText("doesn't fit");
    await expect(problems).toHaveScreenshot("label-too-long-warning.png");
  });
});

// Default cable and core with the top cap forced on: ABCDEFGH is the longest
// all-caps prefix of ABCDEFGHIJKLMNOP that fits this cap (test/label.test.ts).
const DEFAULT_CAP_ON = "#v=1&cap=on";

test.describe("the label field stops at what the cap can hold", () => {
  async function openLabelField(page: Page, hash: string) {
    await gotoDesign(page, hash);
    await page.getByTestId("label-enabled").check();
    return page.getByTestId("input-label");
  }

  test("typing past the cap's room cuts the text to the fitting prefix and says so", async ({ page }) => {
    const input = await openLabelField(page, DEFAULT_CAP_ON);
    await expect(page.getByTestId("label-full-note")).toHaveCount(0);
    await input.pressSequentially("ABCDEFGHIJKLMNOP");
    await expect(input).toHaveValue("ABCDEFGH");
    await expect(page.getByTestId("label-full-note")).toBeVisible();
    await expect(page.getByTestId("download-stl")).toBeEnabled();
    await expect(page.getByTestId("warnings")).not.toContainText("doesn't fit");
  });

  test("pasting a long string is cut the same way", async ({ page }) => {
    const input = await openLabelField(page, DEFAULT_CAP_ON);
    await input.fill("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    await expect(input).toHaveValue("ABCDEFGH");
    await expect(page.getByTestId("label-full-note")).toBeVisible();
  });

  test("text that fits is kept and shows no note; deleting clears the note", async ({ page }) => {
    const input = await openLabelField(page, DEFAULT_CAP_ON);
    await input.fill("USB-C 2m");
    await expect(page.getByTestId("download-stl")).toBeEnabled();
    await expect(input).toHaveValue("USB-C 2m");
    await expect(page.getByTestId("label-full-note")).toHaveCount(0);

    await input.fill("ABCDEFGHIJK");
    await expect(input).toHaveValue("ABCDEFGH");
    await expect(page.getByTestId("label-full-note")).toBeVisible();
    await input.press("Backspace");
    await expect(page.getByTestId("label-full-note")).toHaveCount(0);
  });

  test("shrinking the core after typing keeps the text and shows the fit warning", async ({ page }) => {
    const input = await openLabelField(page, "#v=1&cap=on&lock=outer,ly&size=80");
    await input.fill("ABCDEFGHI");
    await expect(page.getByTestId("download-stl")).toBeEnabled();
    await expect(input).toHaveValue("ABCDEFGHI");
    await expect(page.getByTestId("warnings")).not.toContainText("doesn't fit");

    await page.getByTestId("input-outer").fill("50");
    await page.getByTestId("input-outer").blur();
    await expect(page.getByTestId("warnings")).toContainText("doesn't fit");
    await expect(page.getByTestId("download-stl")).toBeEnabled();
    await expect(input).toHaveValue("ABCDEFGHI");
    await expect(page.getByTestId("label-full-note")).toHaveCount(0);
  });

  test("a link with an overlong label loads it unchanged and warns instead of cutting", async ({ page }) => {
    await gotoDesign(page, `${DEFAULT_CAP_ON}&label=ABCDEFGHIJKLMNOP`);
    await expect(page.getByTestId("input-label")).toHaveValue("ABCDEFGHIJKLMNOP");
    await expect(page.getByTestId("warnings")).toContainText("doesn't fit");
    await expect(page.getByTestId("label-full-note")).toHaveCount(0);
    expect(decodeHashDoc(page.url()).label).toBe("ABCDEFGHIJKLMNOP");
  });
});
