import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

// Tracer-bullet end-to-end check (issue #2): a hash URL drives the result
// panel, and the STL download works. Expected values are computed
// independently here, mirroring the solver's documented contract
// (docs/research.md §3), not by importing the app's source.
function expectedResults(wireLength: number, wireDiameter: number, coreSize: number) {
  const grooveDepth = 0.3 * wireDiameter;
  const wireOffset = wireDiameter / 2 - grooveDepth;
  const centerlineRadius = coreSize / 2 + wireOffset;
  const perimeter = 2 * Math.PI * centerlineRadius;
  const pitch = wireDiameter + 0.3;
  const turns = Math.floor(wireLength / perimeter);
  const woundLength = turns * perimeter;
  const leftoverTail = wireLength - woundLength;
  const height = 2 * 3 + turns * pitch;
  return { turns, woundLength, leftoverTail, height };
}

test("a hash URL drives the result panel and the STL download works", async ({ page }) => {
  const wireLength = 1000;
  const wireDiameter = 4;
  const coreSize = 40;
  const expected = expectedResults(wireLength, wireDiameter, coreSize);

  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  await page.goto(`/#v=1&L=${wireLength}&d=${wireDiameter}&size=${coreSize}`);

  await expect(page.getByTestId("hash-notice")).toHaveCount(0);
  await expect(page.getByTestId("turns")).toHaveText(String(expected.turns));
  await expect(page.getByTestId("wound-length")).toContainText(expected.woundLength.toFixed(1));
  await expect(page.getByTestId("leftover-tail")).toContainText(expected.leftoverTail.toFixed(1));
  await expect(page.getByTestId("height")).toContainText(expected.height.toFixed(1));

  // The 3D viewer mounted and rendered something (a <canvas>).
  await expect(page.getByTestId("coil-viewer").locator("canvas")).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("download-stl").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("coil.stl");

  const path = await download.path();
  expect(path).toBeTruthy();
  const buf = readFileSync(path!);
  expect(buf.byteLength).toBeGreaterThan(84);
  const triCount = buf.readUInt32LE(80);
  expect(buf.byteLength).toBe(84 + triCount * 50);

  expect(consoleErrors, `unexpected console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
});

test("a garbage hash falls back to defaults with a visible notice", async ({ page }) => {
  await page.goto("/#v=1&L=not-a-number");
  await expect(page.getByTestId("hash-notice")).toBeVisible();
  await expect(page.getByTestId("input-wireLength")).toHaveValue("2000");
});
