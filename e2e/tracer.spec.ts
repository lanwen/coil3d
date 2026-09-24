import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

// End-to-end checks for the coil core's URL-hash <-> UI <-> solver loop.
// Solver math itself is covered by vitest against the public `design()`
// interface (test/design.test.ts); these tests check the seam described in
// docs/research.md's testing decisions: a hash drives the UI, editing
// controls updates the hash, and reloading reproduces the view.

test("a hash URL with explicit locks drives the result panel and the STL download works", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  await page.goto("/#v=1&L=1000&d=4&lock=outer,ly&size=40");

  await expect(page.getByTestId("hash-notice")).toHaveCount(0);
  await expect(page.getByTestId("outer-size")).toHaveText("40.0 mm");
  await expect(page.getByTestId("layers")).toHaveText("1");
  await expect(page.getByTestId("diagnosis-status")).toBeVisible();

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

test("an unknown lock token in the hash falls back to defaults with a notice", async ({ page }) => {
  await page.goto("/#v=1&lock=bogus");
  await expect(page.getByTestId("hash-notice")).toBeVisible();
});
