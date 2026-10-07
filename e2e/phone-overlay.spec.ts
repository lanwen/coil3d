import { expect, test, type Page } from "@playwright/test";
import { encodeHashDoc } from "./hashDoc";
import { expectSettled } from "./settled";

// Issue #145: at phone widths the viewport overlay used to be crowded --
// the projection switch sat on the Dimensions toggle's (i) button and the
// Exploded-view box covered the model. The fix moves the toggles out of the
// canvas into a strip under it (App.css's `.viewport-toggles`). These
// checks are layout-only: every overlay control's box is disjoint from
// every other's, and none of them lands on what the canvas actually drew
// (model plus its dimension axes) at the default Iso and Front framings.

const DESIGNS = {
  // Several parts (core + mount plate + pegs), so the Exploded-view toggle
  // shows too, plus a SKÅDIS mount for the fifth preset button.
  skadis: encodeHashDoc({ L: 2000, d: 3.8, size: 100, h: 60, mount: "skadis" }),
  // One part, no exploded toggle: a different row wrap in the strip.
  plain: encodeHashDoc({ L: 1000, d: 4, size: 40 }),
};
const CONTROLS = [".wire-toggle", ".dimensions-toggle", ".explode-toggle", ".projection-toggle-box", ".preset-bar", ".wall-view-caption"];

interface Box {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const intersects = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

async function controlBoxes(page: Page): Promise<Box[]> {
  const boxes: Box[] = [];
  for (const selector of CONTROLS) {
    for (const el of await page.locator(selector).all()) {
      const box = await el.boundingBox();
      if (box) boxes.push({ name: selector, ...box });
    }
  }
  return boxes;
}

/** The page-space bounding box of everything the canvas drew, found from a screenshot with the overlay controls hidden. */
async function drawnBounds(page: Page): Promise<Box> {
  const canvas = page.getByTestId("coil-viewer").locator("canvas");
  const canvasBox = (await canvas.boundingBox())!;
  const png = await canvas.screenshot({ style: `${CONTROLS.join(", ")} { visibility: hidden !important; }` });
  const px = await page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const img = await createImageBitmap(blob);
    const ctx = new OffscreenCanvas(img.width, img.height).getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const { data, width, height } = ctx.getImageData(0, 0, img.width, img.height);
    const bg = [data[0], data[1], data[2]];
    let left = width, top = height, right = -1, bottom = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        if (Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]) < 90) continue;
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
    return { left, top, right, bottom, width };
  }, png.toString("base64"));
  expect(px.right, "the canvas drew something").toBeGreaterThan(px.left);
  const scale = canvasBox.width / px.width; // screenshot px -> CSS px
  return { name: "drawn model", x: canvasBox.x + px.left * scale, y: canvasBox.y + px.top * scale, width: (px.right - px.left + 1) * scale, height: (px.bottom - px.top + 1) * scale };
}

for (const width of [390, 680]) {
  for (const [design, hash] of Object.entries(DESIGNS)) {
    test(`${width}px, ${design}: overlay controls never overlap each other or the model at Iso and Front (issue #145)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/${hash}`);
      await expect(page.getByTestId("download-stl")).toBeEnabled();
      await expectSettled(page);

      for (const preset of ["iso", "front"] as const) {
        await page.getByTestId(`preset-${preset}`).click();
        await expect(page.getByTestId(`preset-${preset}`)).toHaveAttribute("aria-pressed", "true");
        await expectSettled(page);
        const boxes = await controlBoxes(page);
        expect(boxes.length, "toggles, projection switch and preset bar all present").toBeGreaterThanOrEqual(4);
        for (let i = 0; i < boxes.length; i++) {
          for (let j = i + 1; j < boxes.length; j++) {
            expect(intersects(boxes[i], boxes[j]), `${preset}: ${boxes[i].name} overlaps ${boxes[j].name}`).toBe(false);
          }
        }
        const drawn = await drawnBounds(page);
        for (const box of boxes) {
          expect(intersects(box, drawn), `${preset}: ${box.name} covers the drawn model`).toBe(false);
        }
      }
    });
  }
}

test("390px: the toggles sit in one strip under the canvas, and their hints still open", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`/${DESIGNS.skadis}`);
  await expect(page.getByTestId("download-stl")).toBeEnabled();
  const canvas = (await page.getByTestId("coil-viewer").boundingBox())!;
  const strip = (await page.getByTestId("viewport-toggles").boundingBox())!;
  expect(strip.y, "strip starts under the canvas").toBeGreaterThanOrEqual(canvas.y + canvas.height - 1);
  for (const id of ["wire", "dimensions", "exploded", "projection"]) {
    await expect(page.getByTestId("viewport-toggles").getByTestId(`toggle-${id}`)).toHaveCount(1);
  }
  // Still plain switches: toggling works from the strip.
  await page.getByTestId("toggle-exploded").check();
  await expect(page.getByTestId("toggle-exploded")).toBeChecked();
  // And the (i) hint opens its bubble on tap, fully on screen.
  const hint = page.locator(".dimensions-toggle").getByTestId("hint-btn");
  await hint.click();
  const bubble = page.locator(".dimensions-toggle").getByTestId("hint-bubble");
  await expect(bubble).toBeVisible();
  const bubbleBox = (await bubble.boundingBox())!;
  expect(bubbleBox.x).toBeGreaterThanOrEqual(0);
  expect(bubbleBox.x + bubbleBox.width).toBeLessThanOrEqual(390);
});
