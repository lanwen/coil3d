import { expect, test, type Page } from "@playwright/test";
import { encodeHashDoc } from "./hashDoc";
import { expectSettled } from "./settled";

// End-to-end checks for issue #320: the pill (stadium) core. The geometry, the solver rules and the mounts are covered by
// vitest through design() (test/pill.test.ts); these show the pill in each view and on each mount, at the viewer seam, to
// look at the line art on the flat-to-arc tangents. The default pill has a size and radius the solver keeps long enough
// to read as a pill: the radius is the default 20 mm, the size is free.

const PILL = { shape: "pill", L: 2000, d: 3.8, lock: ["h"], h: 40, cap: "on" };
const hashFor = (extra: Record<string, unknown> = {}) => encodeHashDoc({ ...PILL, ...extra });

async function gotoDesign(page: Page, hash: string) {
  await page.goto(`/${hash}`);
  await expect(page.getByTestId("coil-viewer").locator("canvas")).toBeVisible();
  await expect(page.getByTestId("download-stl")).toBeEnabled();
  await expectSettled(page);
}

const canvasOf = (page: Page) => page.getByTestId("coil-viewer").locator("canvas");

test.describe("the default pill in each view (issue #320)", () => {
  test("standing, with the dimension labels reading the length and the width", async ({ page }) => {
    await gotoDesign(page, hashFor());
    await expect(canvasOf(page)).toHaveScreenshot("pill-standing.png");
  });

  test("front view faces the long flat", async ({ page }) => {
    await gotoDesign(page, hashFor());
    await page.getByTestId("preset-front").click();
    await expectSettled(page);
    await expect(canvasOf(page)).toHaveScreenshot("pill-front.png");
  });

  test("print layout", async ({ page }) => {
    await gotoDesign(page, hashFor());
    await page.getByTestId("preset-printLayout").click();
    await expectSettled(page);
    await expect(canvasOf(page)).toHaveScreenshot("pill-print-layout.png");
  });
});

test.describe("a pill on each wall mount (issue #320)", () => {
  for (const mount of ["keyhole", "through", "skadis", "skadis-tclip"]) {
    test(`${mount}: the wall-mount preset hangs the long axis horizontal`, async ({ page }) => {
      await gotoDesign(page, hashFor({ mount }));
      await page.getByTestId("preset-wallRoom").click();
      await expectSettled(page);
      await expect(canvasOf(page)).toHaveScreenshot(`pill-wallroom-${mount}.png`);
    });
  }

  test("skadis: the mount-side view shows every rim clip in a drawn slot", async ({ page }) => {
    await gotoDesign(page, hashFor({ mount: "skadis" }));
    await page.getByTestId("preset-mountSide").click();
    await expectSettled(page);
    await expect(page.getByTestId("wall-view-caption")).toHaveText(/SK.DIS slot/i);
    await expect(canvasOf(page)).toHaveScreenshot("pill-mountside-skadis.png");
  });
});
