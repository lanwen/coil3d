import { expect, test, type Page } from "@playwright/test";
import { cancelCustomize, openCustomize, saveCustomize } from "./customize";
import { hoverHint } from "./hint";
import { decodeHashDoc, encodeHashDoc } from "./hashDoc";
import { expectSettled } from "./settled";

// End-to-end checks for the strap slots (issues #240, #314, #316): the switch
// under the top cap switch, its place in the hash, the note under it when a
// plate gets no slots, and screenshots of the closed slots in the plates. The slot layout itself is covered by vitest against the
// public `design()` interface (test/strapSlot.test.ts).

const SQUARE = encodeHashDoc({ L: 4000, d: 3.8, size: 60, shape: "sq", rc: 10, ly: 3, base: "on", cap: "on", strap: true });
const THROUGH_HOLES = encodeHashDoc({ size: 38, cap: "on", mount: "through", strap: true });
const KEYHOLE_SMALL = encodeHashDoc({ size: 20, cap: "on", mount: "keyhole", strap: true });
const TRIANGLE = encodeHashDoc({ L: 3000, d: 3.8, size: 60, shape: "tri", rc: 10, ly: 2, base: "on", cap: "on", strap: true });

async function gotoDesign(page: Page, hash: string) {
  await page.goto(`/${hash}`);
  await expect(page.getByTestId("coil-viewer").locator("canvas")).toBeVisible();
  await expect(page.getByTestId("download-stl")).toBeEnabled();
  await expectSettled(page);
}

async function lookDown(page: Page) {
  const box = (await page.getByTestId("coil-viewer").locator("canvas").boundingBox())!;
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 600, { steps: 20 });
  await page.mouse.up();
  await expectSettled(page);
}

test.describe("strap slots switch (issues #240, #314, #385)", () => {
  test("it is offered only while the base or the top cap is on, in the Customize panel, with a hint", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("strap-slots")).toHaveCount(0);
    await expect(page.getByTestId("customize-open")).toBeDisabled();

    await page.getByTestId("base").check();
    await expect(page.getByTestId("customize-open")).toBeEnabled();
    await expect(page.getByTestId("strap-slots")).toHaveCount(0);
    await openCustomize(page);
    await expect(page.getByTestId("strap-slots")).toBeVisible();
    await expect(page.getByTestId("strap-slots")).not.toBeChecked();
    await cancelCustomize(page);
    await page.getByTestId("base").uncheck();
    await expect(page.getByTestId("customize-open")).toBeDisabled();
    await expect(page.getByTestId("strap-slots")).toHaveCount(0);

    await page.getByTestId("topCap").check();
    await expect(page.getByTestId("customize-open")).toBeEnabled();
    await openCustomize(page);
    await expect(page.getByTestId("strap-slots")).toBeVisible();

    const field = page.locator(".field").filter({ hasText: "Strap slots" });
    await hoverHint(page, field.getByTestId("hint-btn"));
    await expect(field.getByTestId("hint-bubble")).toContainText(/closed slots/i);
  });

  test("switching it on puts strap in the hash, off takes it out, and a reload keeps it", async ({ page }) => {
    await gotoDesign(page, encodeHashDoc({ base: "on", cap: "on" }));
    expect(decodeHashDoc(page.url()).strap).toBeUndefined();

    await openCustomize(page);
    await page.getByTestId("strap-slots").check();
    expect(decodeHashDoc(page.url()).strap).toBeUndefined();
    await saveCustomize(page);
    await expect(async () => expect(decodeHashDoc(page.url()).strap).toBe(true)).toPass();
    await page.reload();
    await expect(page.getByTestId("customize-open")).toBeEnabled();
    await openCustomize(page);
    await expect(page.getByTestId("strap-slots")).toBeChecked();

    await page.getByTestId("strap-slots").uncheck();
    await saveCustomize(page);
    await expect(async () => expect(decodeHashDoc(page.url()).strap).toBeUndefined()).toPass();
  });

  test("it sits in the same row layout as the switches around it", async ({ page }) => {
    await gotoDesign(page, SQUARE);
    await openCustomize(page);
    const rowOf = (testId: string) => page.locator(".field-top").filter({ has: page.getByTestId(testId) });
    const strap = (await rowOf("strap-slots").boundingBox())!;
    const cap = (await rowOf("label-enabled").boundingBox())!;
    expect(Math.abs(strap.x - cap.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(strap.width - cap.width)).toBeLessThanOrEqual(1);
    expect(strap.y).toBeGreaterThan(cap.y);
  });
});

test.describe("strap slots note (issue #316)", () => {
  test("a design whose base and cap both get slots shows no note", async ({ page }) => {
    await gotoDesign(page, THROUGH_HOLES);
    await openCustomize(page);
    await expect(page.getByTestId("strap-slots")).toBeChecked();
    await expect(page.getByTestId("strap-slots-note")).toHaveCount(0);
  });

  test("a plate left without slots gets a note under the switch, which goes with the switch", async ({ page }) => {
    await gotoDesign(page, KEYHOLE_SMALL);
    await openCustomize(page);
    const note = page.getByTestId("strap-slots-note");
    await expect(note).toContainText(/strap slots don't fit anywhere round the rim of the base/i);
    const field = page.locator(".field").filter({ has: page.getByTestId("strap-slots") });
    await expect(field.getByTestId("strap-slots-note")).toBeVisible();

    await page.getByTestId("strap-slots").uncheck();
    await expect(note).toHaveCount(0);
  });
});

test.describe("strap slots screenshots (issues #240, #314, #316)", () => {
  test("a rounded square with a base and a cap: the closed slots, isometric", async ({ page }) => {
    await gotoDesign(page, SQUARE);
    await expect(page.getByTestId("coil-viewer").locator("canvas")).toHaveScreenshot("strap-slots-square-iso.png");
  });

  test("a rounded triangle with a base and a cap, from above: the slots beside the cable's rim slot", async ({ page }) => {
    await gotoDesign(page, TRIANGLE);
    await lookDown(page);
    await expect(page.getByTestId("coil-viewer").locator("canvas")).toHaveScreenshot("strap-slots-triangle-top.png");
  });

  test("a round core with a base, a through-hole mount and a cap, from above: the cap's own pair, opposite", async ({ page }) => {
    await gotoDesign(page, THROUGH_HOLES);
    await lookDown(page);
    await expect(page.getByTestId("coil-viewer").locator("canvas")).toHaveScreenshot("strap-slots-through-cap-top.png");
  });
});
