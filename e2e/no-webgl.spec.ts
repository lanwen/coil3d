import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { decodeHashDoc, encodeHashDoc } from "./hashDoc";

// Issue #249: the 3D view is the only part of the app that needs WebGL (the
// geometry is solved in a worker), so a browser without it must still get the
// controls, the share link, the guide and the downloads, with a short note
// where the 3D view would be.

const NOTE = "3D preview unavailable in this browser. Downloads still work.";

test.describe("without WebGL", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...args: unknown[]) {
        if (type === "webgl" || type === "webgl2" || type === "experimental-webgl") return null;
        return (getContext as (...a: unknown[]) => unknown).call(this, type, ...args);
      } as typeof getContext;
    });
  });

  test("the page stays usable: note shown, controls change the hash, STL downloads", async ({ page }) => {
    await page.goto(`/${encodeHashDoc({ L: 2000, d: 3.8, size: 40 })}`);
    await expect(page.getByTestId("viewer-unavailable")).toHaveText(NOTE);
    await expect(page.getByTestId("coil-viewer")).toHaveCount(0);

    await page.getByTestId("input-bedX").fill("20");
    await page.getByTestId("input-bedX").blur();
    await expect(async () => expect(decodeHashDoc(page.url()).bx).toBe(20)).toPass();
    await expect(page.getByTestId("viewer-unavailable")).toBeVisible();

    await expect(page.getByTestId("download-stl")).toBeEnabled();
    const downloadPromise = page.waitForEvent("download");
    await page.getByTestId("download-stl").click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("coil.stl");
    const path = await download.path();
    expect(path).toBeTruthy();
    expect(readFileSync(path!).byteLength).toBeGreaterThan(84);
  });

  test("the guide still opens and its figures show a note", async ({ page }) => {
    await page.goto(`/${encodeHashDoc({ L: 2000, d: 3.8, size: 40 })}`);
    await expect(page.getByTestId("viewer-unavailable")).toBeVisible();
    await page.getByTestId("open-guide").click();
    await expect(page.getByTestId("guide-view")).toBeVisible();
    await expect(page.getByText("Illustration unavailable in this browser.").first()).toBeVisible();
    await page.getByTestId("guide-back").click();
    await expect(page.getByTestId("viewer-unavailable")).toBeVisible();
  });
});

test("losing the WebGL context later swaps the viewer for the note", async ({ page }) => {
  await page.goto(`/${encodeHashDoc({ L: 2000, d: 3.8, size: 40 })}`);
  await expect(page.getByTestId("coil-viewer")).toBeVisible();
  await expect(page.getByTestId("download-stl")).toBeEnabled();

  await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="coil-viewer"] canvas')!;
    const gl = (canvas.getContext("webgl2") ?? canvas.getContext("webgl")) as WebGLRenderingContext;
    gl.getExtension("WEBGL_lose_context")!.loseContext();
  });

  await expect(page.getByTestId("viewer-unavailable")).toHaveText(NOTE);
  await expect(page.getByTestId("download-stl")).toBeEnabled();
});
