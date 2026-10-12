import { expect, test, type Page } from "@playwright/test";
import { hoverHint } from "./hint";
import { decodeHashDoc, encodeHashDoc } from "./hashDoc";
import { expectSettled } from "./settled";

// End-to-end checks for the strap slots (issues #240, #314): the switch under
// the top cap switch, its place in the hash, and two screenshots of the closed
// slots in the plates. The slot layout itself is covered by vitest against the
// public `design()` interface (test/strapSlot.test.ts). The core size stays
// free in these links: with it locked the plates have no room for the slots.

const SQUARE = encodeHashDoc({ L: 4000, d: 3.8, shape: "sq", rc: 10, ly: 3, h: 50, lock: ["h", "ly"], base: "on", cap: "on", strap: true });
const TRIANGLE = encodeHashDoc({ L: 3000, d: 3.8, shape: "tri", rc: 10, ly: 2, h: 50, lock: ["h", "ly"], base: "on", cap: "on", strap: true });

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

test.describe("strap slots switch (issues #240, #314)", () => {
  test("it shows only while the base or the top cap is on, with a hint", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("strap-slots")).toHaveCount(0);

    await page.getByTestId("base").check();
    await expect(page.getByTestId("strap-slots")).toBeVisible();
    await expect(page.getByTestId("strap-slots")).not.toBeChecked();
    await page.getByTestId("base").uncheck();
    await expect(page.getByTestId("strap-slots")).toHaveCount(0);

    await page.getByTestId("topCap").check();
    await expect(page.getByTestId("strap-slots")).toBeVisible();

    const field = page.locator(".field").filter({ hasText: "Strap slots" });
    await hoverHint(page, field.getByTestId("hint-btn"));
    await expect(field.getByTestId("hint-bubble")).toContainText(/closed slots/i);
  });

  test("switching it on puts strap in the hash, off takes it out, and a reload keeps it", async ({ page }) => {
    await gotoDesign(page, encodeHashDoc({ base: "on", cap: "on" }));
    expect(decodeHashDoc(page.url()).strap).toBeUndefined();

    await page.getByTestId("strap-slots").check();
    await expect(async () => expect(decodeHashDoc(page.url()).strap).toBe(true)).toPass();
    await page.reload();
    await expect(page.getByTestId("strap-slots")).toBeChecked();

    await page.getByTestId("strap-slots").uncheck();
    await expect(async () => expect(decodeHashDoc(page.url()).strap).toBeUndefined()).toPass();
  });

  test("it sits in the same row layout as the switches around it", async ({ page }) => {
    await gotoDesign(page, SQUARE);
    const rowOf = (testId: string) => page.locator(".field-top").filter({ has: page.getByTestId(testId) });
    const strap = (await rowOf("strap-slots").boundingBox())!;
    const cap = (await rowOf("topCap").boundingBox())!;
    expect(Math.abs(strap.x - cap.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(strap.width - cap.width)).toBeLessThanOrEqual(1);
    expect(strap.y).toBeGreaterThan(cap.y);
  });
});

test.describe("strap slots screenshots (issues #240, #314)", () => {
  test("a rounded square with a base and a cap: the closed slots, isometric", async ({ page }) => {
    await gotoDesign(page, SQUARE);
    await expect(page.getByTestId("coil-viewer").locator("canvas")).toHaveScreenshot("strap-slots-square-iso.png");
  });

  test("a rounded triangle with a base and a cap, from above: the slots beside the cable's rim slot", async ({ page }) => {
    await gotoDesign(page, TRIANGLE);
    await lookDown(page);
    await expect(page.getByTestId("coil-viewer").locator("canvas")).toHaveScreenshot("strap-slots-triangle-top.png");
  });
});
