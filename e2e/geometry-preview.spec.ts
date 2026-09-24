import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

// Issue #7 acceptance criteria: design() runs off the main thread with a
// debounced draft-to-final preview, and exports always use the final
// resolution. These checks drive the app through a real edit rather than
// asserting on the narrow (and inherently racy) window right after initial
// load: every assertion here is a `toBe...()` web-first assertion, which
// waits for its condition rather than requiring it to already hold, so
// there's no fixed sleep and no dependency on exact debounce timings.

test("editing disables downloads until the design re-settles to final resolution", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  await page.goto("/#v=1&L=1000&d=4&size=40");
  await expect(page.getByTestId("download-stl")).toBeEnabled();
  await expect(page.getByTestId("download-step")).toBeEnabled();
  await expect(page.getByTestId("mesh-detail")).toContainText("final");
  await expect(page.getByTestId("resolution-settling")).toHaveCount(0);

  await page.getByTestId("input-wireLength").fill("1200");

  // The moment input changes, exports must not be offered against a stale
  // or draft mesh: both downloads disable, with a visible reason.
  await expect(page.getByTestId("download-stl")).toBeDisabled();
  await expect(page.getByTestId("download-step")).toBeDisabled();
  await expect(page.getByTestId("resolution-settling")).toBeVisible();

  // Once input settles, the final mesh comes back and exports re-enable.
  await expect(page.getByTestId("download-stl")).toBeEnabled();
  await expect(page.getByTestId("download-step")).toBeEnabled();
  await expect(page.getByTestId("mesh-detail")).toContainText("final");
  await expect(page.getByTestId("resolution-settling")).toHaveCount(0);

  expect(consoleErrors, `unexpected console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
});

test("the downloaded STL always matches the final-resolution triangle count, never a draft's", async ({ page }) => {
  await page.goto("/#v=1&L=1000&d=4&size=40");
  await expect(page.getByTestId("download-stl")).toBeEnabled();

  const detail = await page.getByTestId("mesh-detail").textContent();
  const match = detail?.match(/final \(([\d,]+) triangles\)/);
  expect(match, `mesh-detail did not report a final triangle count: ${detail}`).not.toBeNull();
  const expectedTriangles = Number(match![1].replace(/,/g, ""));
  expect(expectedTriangles).toBeGreaterThan(0);

  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("download-stl").click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(path).toBeTruthy();
  const buf = readFileSync(path!);
  const triCount = buf.readUInt32LE(80);

  expect(triCount).toBe(expectedTriangles);
});
