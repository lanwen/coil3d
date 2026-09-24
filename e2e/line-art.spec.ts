import { expect, test, type Page } from "@playwright/test";

// End-to-end checks for issue #3 (docs/research.md §5, §10b): the IKEA
// line-art look — white fill, thin black outlines, a transparent
// background, an orthographic camera that auto-frames the model, and
// hit-testing that only lets orbit start on the outlined model.

async function gotoDesign(page: Page, hash: string) {
  await page.goto(`/${hash}`);
  await expect(page.getByTestId("coil-viewer").locator("canvas")).toBeVisible();
  // Let the design solve and the line-art pipeline render a few settled
  // frames (the reframe effect needs at least one render after mount).
  await page.waitForTimeout(800);
}

test.describe("IKEA line-art renderer", () => {
  test("renders white fill, thin black outlines and a transparent background", async ({ page }) => {
    await gotoDesign(page, "#v=1&L=1000&d=4&size=40");
    await expect(page.getByTestId("coil-viewer").locator("canvas")).toHaveScreenshot("lineart-round.png", {
      maxDiffPixelRatio: 0.02,
    });
  });

  test("stays thin at a very different aspect ratio (long, many-turn coil)", async ({ page }) => {
    await gotoDesign(page, "#v=1&L=6000&d=4&size=30");
    await expect(page.getByTestId("coil-viewer").locator("canvas")).toHaveScreenshot("lineart-long.png", {
      maxDiffPixelRatio: 0.02,
    });
  });

  test("orbit only starts when the drag begins on the outlined model, not the transparent background", async ({
    page,
  }) => {
    await gotoDesign(page, "#v=1&L=1000&d=4&size=40");
    const canvas = page.getByTestId("coil-viewer").locator("canvas");
    const box = await canvas.boundingBox();
    if (!box) throw new Error("canvas has no bounding box");

    const before = await canvas.screenshot();

    // The camera auto-frames the model with margin around it (§10b "reframe"),
    // so a canvas corner is reliably transparent background (outline alpha 0).
    await page.mouse.move(box.x + 8, box.y + 8);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 8, box.y + box.height - 8, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    const afterBackgroundDrag = await canvas.screenshot();
    expect(afterBackgroundDrag.equals(before), "a drag started on the background must not orbit the camera").toBe(
      true,
    );

    // The auto-framed model sits at the canvas centre.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 60, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    const afterModelDrag = await canvas.screenshot();
    expect(afterModelDrag.equals(afterBackgroundDrag), "a drag started on the model must orbit the camera").toBe(
      false,
    );
  });

  test("reframes the orthographic camera when the canvas is resized", async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 800 });
    await gotoDesign(page, "#v=1&L=1000&d=4&size=40");
    const canvas = page.getByTestId("coil-viewer").locator("canvas");
    const wide = await canvas.screenshot();

    await page.setViewportSize({ width: 500, height: 800 });
    await page.waitForTimeout(300);
    const narrow = await canvas.screenshot();

    expect(narrow.equals(wide), "the render must adapt when the canvas is resized").toBe(false);
  });
});
