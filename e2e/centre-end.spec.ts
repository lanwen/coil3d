import { expect, test, type Page } from "@playwright/test";
import { encodeHashDoc } from "./hashDoc";

// Issue #254, part 2: every design holds the cable's inner end in the bore, so the whole matrix renders it: round,
// square and triangle cores, one and two layers, the base plate on and off, the top cap on and off. Each is a
// screenshot of the iso view (the rib, the cable hanging out of the top of the bore and the line-art outline); the
// close-up of the rib itself is in inner-end.spec.ts.

const SHAPES = [
  { id: "round", doc: {} },
  { id: "square", doc: { shape: "sq", rc: 12 } },
  { id: "triangle", doc: { shape: "tri", rc: 12 } },
] as const;

async function gotoDesign(page: Page, hash: string) {
  await page.goto(`/${hash}`);
  await expect(page.getByTestId("coil-viewer").locator("canvas")).toBeVisible();
  await expect(page.getByTestId("download-stl")).toBeEnabled();
  await page.waitForTimeout(800);
}

test.describe("the centre-held inner end across the matrix (issue #254)", () => {
  for (const shape of SHAPES) {
    for (const layers of [1, 2]) {
      for (const base of ["off", "on"] as const) {
        for (const cap of ["off", "on"] as const) {
          test(`${shape.id}, ${layers} layer${layers > 1 ? "s" : ""}, base ${base}, cap ${cap}`, async ({ page }) => {
            const doc = { L: layers === 1 ? 1500 : 3500, d: 3.8, size: 56, ly: layers, lock: ["outer", "ly"], base, cap, ...shape.doc };
            await gotoDesign(page, encodeHashDoc(doc as Parameters<typeof encodeHashDoc>[0]));
            await expect(page.getByTestId("layers")).toHaveText(String(layers));
            await expect(page.getByTestId("caps")).toContainText(cap);
            await expect(page.getByTestId("coil-viewer").locator("canvas")).toHaveScreenshot(`centre-${shape.id}-${layers}l-base-${base}-cap-${cap}.png`);
          });
        }
      }
    }
  }
});
