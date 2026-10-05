import { expect, test, type Page } from "@playwright/test";
import { decodeHashDoc, encodeHashDoc } from "./hashDoc";

// End-to-end checks for issue #254: the base plate is an option (the Base
// switch, next to the top cap's), off by default, and a bare core renders as a
// plain grooved tube with the inner end held in its bore. Sizes and the
// solver's rules are covered by vitest through design() (test/bareCore.test.ts,
// test/centreEnds.test.ts); these check the URL hash <-> UI <-> viewer seam.

const BARE = encodeHashDoc({ L: 1000, d: 4, size: 40 });
const WITH_BASE = encodeHashDoc({ L: 1000, d: 4, size: 40, base: "on" });

async function gotoDesign(page: Page, hash: string) {
  await page.goto(`/${hash}`);
  await expect(page.getByTestId("coil-viewer").locator("canvas")).toBeVisible();
  // The FINAL mesh, not the draft (see line-art.spec.ts's gotoDesign).
  await expect(page.getByTestId("download-stl")).toBeEnabled();
  await page.waitForTimeout(800);
}

test.describe("the base option (issue #254)", () => {
  test("the Base switch reads off by default", async ({ page }) => {
    await gotoDesign(page, BARE);
    await expect(page.getByTestId("base")).not.toBeChecked();
    await expect(page.getByTestId("mesh-detail")).toContainText("1 part");
  });

  test("the Base switch reads on for a link with base on", async ({ page }) => {
    await gotoDesign(page, WITH_BASE);
    await expect(page.getByTestId("base")).toBeChecked();
  });

  test("touching the switch stores base in the hash, and turning it back off leaves it out again", async ({ page }) => {
    await gotoDesign(page, BARE);
    expect(decodeHashDoc(page.url()).base).toBeUndefined();
    await page.getByTestId("base").check();
    await expect(async () => expect(decodeHashDoc(page.url()).base).toBe("on")).toPass();
    await page.getByTestId("base").uncheck();
    await expect(async () => expect(decodeHashDoc(page.url()).base).toBeUndefined()).toPass();
  });

  test("a wall mount forces the base on: the switch is on and disabled", async ({ page }) => {
    await gotoDesign(page, encodeHashDoc({ L: 1000, d: 4, size: 50, mount: "keyhole" }));
    await expect(page.getByTestId("base")).toBeChecked();
    await expect(page.getByTestId("base")).toBeDisabled();
  });

  test("the size field starts at the smallest core that passes a connector past the rib, with the note saying so", async ({ page }) => {
    await gotoDesign(page, encodeHashDoc({ L: 1000, d: 4, size: 20 }));
    // 22.4 mm of free bore, the rib's 6.2 mm and two 3.1 mm walls: 34.8 mm.
    const outer = page.getByTestId("input-outer");
    expect(Number(await outer.inputValue())).toBeGreaterThanOrEqual(34.5);
    await expect(page.getByTestId("core-size-raised-note")).toBeVisible();
  });

  test("with the base, the same 20 mm core is raised just the same", async ({ page }) => {
    await gotoDesign(page, encodeHashDoc({ L: 1000, d: 4, size: 20, base: "on" }));
    expect(Number(await page.getByTestId("input-outer").inputValue())).toBeGreaterThanOrEqual(34.5);
    await expect(page.getByTestId("core-size-raised-note")).toBeVisible();
  });

  test("renders a bare core: a grooved tube with no flange", async ({ page }) => {
    await gotoDesign(page, BARE);
    await expect(page.getByTestId("coil-viewer").locator("canvas")).toHaveScreenshot("bare-core.png");
  });
});
