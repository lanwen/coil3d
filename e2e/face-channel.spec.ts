import { expect, test, type Page } from "@playwright/test";
import { encodeHashDoc, withHashDoc } from "./hashDoc";

// End-to-end checks for issue #254, part 2: a bare core's cable ends run in channels on its end faces
// and turn through a hole in the middle. The geometry is covered by vitest through design()
// (test/faceChannel.test.ts); these check what the guide tells the user, and that the design
// builds and downloads, through the URL hash and the UI.

const ONE_LAYER = encodeHashDoc({ L: 1000, d: 4, size: 60 });
const TWO_LAYER_CAP = encodeHashDoc({ L: 3800, d: 3.8, size: 60, ly: 2, cap: "on" });

const GUIDE_TIMEOUT = process.env.CI ? 120_000 : 25_000;

async function gotoGuide(page: Page, hash: string) {
  await page.goto(`/${withHashDoc(hash, { ui: { view: "guide" } })}`);
  await expect(page.getByTestId("guide-view")).toBeVisible();
  await expect(page.getByTestId("guide-view")).toHaveAttribute("data-resolution", "final", { timeout: GUIDE_TIMEOUT });
}

test.describe("a bare core's face channels (issue #254)", () => {
  test("one layer, no cap: the guide lays in the inner end on the bottom face and the outer end on the top face", async ({ page }) => {
    await gotoGuide(page, ONE_LAYER);
    await expect(page.getByTestId("guide-step-2")).toContainText("Lay in the inner cable end");
    await expect(page.getByTestId("guide-step-2")).toContainText("bottom face");
    await expect(page.getByTestId("guide-step-4")).toContainText("Lay in the outer cable end");
    await expect(page.getByTestId("guide-step-4")).toContainText("top face");
  });

  test("two layers with a cap: the inner end goes through the bottom face and the outer end stays under the cap's slot", async ({ page }) => {
    await gotoGuide(page, TWO_LAYER_CAP);
    await expect(page.getByTestId("guide-step-2")).toContainText("Lay in the inner cable end");
    await expect(page.getByTestId("guide-step-5")).toContainText("Secure the outer end");
    await expect(page.getByText("Lay in the outer cable end")).toHaveCount(0);
  });

  test("the design builds and offers its files", async ({ page }) => {
    await page.goto(`/${ONE_LAYER}`);
    await expect(page.getByTestId("coil-viewer").locator("canvas")).toBeVisible();
    await expect(page.getByTestId("download-stl")).toBeEnabled();
    await expect(page.getByTestId("mesh-detail")).toContainText("1 part");
  });
});
