import { expect, test, type Page } from "@playwright/test";
import { decodeHashDoc, encodeHashDoc } from "./hashDoc";
import { expectSettled } from "./settled";

// End-to-end checks for issue #254, part 1: the base plate is an option (the
// Base switch, next to the top cap's), and a bare core renders as a plain
// grooved tube. Sizes and the solver's rules are covered by vitest through
// design() (test/bareCore.test.ts); these check the URL hash <-> UI <-> viewer
// seam.

const BARE = encodeHashDoc({ L: 1000, d: 4, size: 40 });
const WITH_BASE = encodeHashDoc({ L: 1000, d: 4, size: 40, base: "on" });

async function gotoDesign(page: Page, hash: string) {
  await page.goto(`/${hash}`);
  await expect(page.getByTestId("coil-viewer").locator("canvas")).toBeVisible();
  // The FINAL mesh, not the draft (see line-art.spec.ts's gotoDesign).
  await expect(page.getByTestId("download-stl")).toBeEnabled();
  await expectSettled(page);
}

test.describe("the base option (issue #254)", () => {
  test("the Base switch reads off by default, and the design is one part", async ({ page }) => {
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

  test("a bare core's size field starts at the smallest core that passes a connector, with the note saying so", async ({ page }) => {
    await gotoDesign(page, encodeHashDoc({ L: 1000, d: 4, size: 20 }));
    // The 22.4 mm hole, the 4.4 mm channel and a 1.2 mm web each side, to the winding surface: 18.2 mm, so 36.4 mm. With the base, 20 mm is not raised.
    const outer = page.getByTestId("input-outer");
    expect(Number(await outer.inputValue())).toBeGreaterThanOrEqual(36);
    await expect(page.getByTestId("core-size-raised-note")).toBeVisible();
  });

  test("with the base and no cap the same 20 mm core is raised too (the top ring's hole); with the cap on it is not (#292)", async ({ page }) => {
    await gotoDesign(page, encodeHashDoc({ L: 1000, d: 4, size: 20, base: "on" }));
    expect(Number(await page.getByTestId("input-outer").inputValue())).toBeGreaterThanOrEqual(36);
    await expect(page.getByTestId("core-size-raised-note")).toBeVisible();
    await page.goto("about:blank");
    await gotoDesign(page, encodeHashDoc({ L: 1000, d: 4, size: 20, base: "on", cap: "on" }));
    await expect(page.getByTestId("input-outer")).toHaveValue("20");
    await expect(page.getByTestId("core-size-raised-note")).toHaveCount(0);
  });

  test("renders a bare core: a grooved tube with a ring at each end and no flange", async ({ page }) => {
    await gotoDesign(page, BARE);
    await expect(page.getByTestId("coil-viewer").locator("canvas")).toHaveScreenshot("bare-core.png");
  });
});
