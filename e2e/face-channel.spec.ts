import { expect, test, type Page } from "@playwright/test";
import { encodeHashDoc, withHashDoc } from "./hashDoc";
import { expectSettled } from "./settled";

// End-to-end checks for issue #254, part 2: a bare core's cable ends run in channels on its end faces
// and turn through a hole in the middle. The geometry is covered by vitest through design()
// (test/faceChannel.test.ts); these check what the guide tells the user, and that the design
// builds and downloads, through the URL hash and the UI.

const ONE_LAYER = encodeHashDoc({ L: 1000, d: 4, size: 60 });
const TWO_LAYER = encodeHashDoc({ L: 1600, d: 3, ly: 2, lock: ["ly"] });
const THICK_FOUR_LAYER = encodeHashDoc({ L: 4800, d: 6, ly: 4, lock: ["ly"], shape: "tri", rc: 12 });
const THREE_LAYER = encodeHashDoc({ L: 2400, d: 3, ly: 3, lock: ["ly"] });
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

  test("three layers, no cap: the guide lifts the outer end over the top turns into the top face's channel (issue #286)", async ({ page }) => {
    await gotoGuide(page, THREE_LAYER);
    await expect(page.getByTestId("guide-step-4")).toContainText("Lay in the outer cable end");
    await expect(page.getByTestId("guide-step-4")).toContainText("over the top turns");
    await expect(page.getByTestId("guide-step-4")).toContainText("top face");
  });

  test("two layers, no cap: the guide leads the outer end up the outside of the coil into the top face's channel (issue #286)", async ({ page }) => {
    await gotoGuide(page, TWO_LAYER);
    await expect(page.getByTestId("guide-step-4")).toContainText("Lay in the outer cable end");
    await expect(page.getByTestId("guide-step-4")).toContainText("up the outside of the coil");
    await expect(page.getByTestId("guide-step-4")).toContainText("top face");
  });

  test("four layers of a thick cable: the outer end's climb stays inside the viewer, in the iso and front views (issue #286)", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/${THICK_FOUR_LAYER}`);
    await expect(page.getByTestId("download-stl")).toBeEnabled();
    await expectSettled(page);
    for (const view of ["iso", "front"]) {
      await page.getByTestId(`preset-${view}`).click();
      await expectSettled(page);
      const png = await page
        .getByTestId("coil-viewer")
        .locator("canvas")
        .screenshot({ mask: [page.locator(".wire-toggle, .dimensions-toggle, .explode-toggle, .view-controls")], maskColor: "#ffffff" });
      const inkOnEdge = await page.evaluate(async (b64) => {
        const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
        const img = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
        const ctx = new OffscreenCanvas(img.width, img.height).getContext("2d")!;
        ctx.drawImage(img, 0, 0);
        const { data, width, height } = ctx.getImageData(0, 0, img.width, img.height);
        const EDGE = 3;
        let ink = 0;
        for (let y = 0; y < height; y++)
          for (let x = 0; x < width; x++) {
            if (x >= EDGE && x < width - EDGE && y >= EDGE && y < height - EDGE) continue;
            const i = (y * width + x) * 4;
            if (data[i] < 128 && data[i + 1] < 128 && data[i + 2] < 128) ink++;
          }
        return ink;
      }, png.toString("base64"));
      expect(inkOnEdge, `${view} view: the cable is cut off by the viewer's edge`).toBe(0);
    }
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
