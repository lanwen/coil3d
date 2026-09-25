import { expect, test } from "@playwright/test";
import { decodeHashDoc } from "./hashDoc";

// Issue #6 acceptance criteria: the user can choose a rounded-square or
// rounded-triangle core, with a corner-radius control, and the result panel
// / hash reflect the choice. Solver math itself is covered by vitest
// against the public `design()` interface (test/design.test.ts).
//
// The hash's own shape/rc fields are asserted via `decodeHashDoc` (issue
// #56: the hash is now `#s=<base64url(JSON)>`, and no longer namespaces the
// corner radius per shape -- a single `rc` key, paired with `shape`).

test("the default shape is round, with no corner-radius control shown", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("select-shape")).toHaveValue("round");
  await expect(page.getByTestId("input-shapeCornerRadius")).toHaveCount(0);
  expect(decodeHashDoc(page.url()).shape).toBeUndefined();
});

test("switching to a rounded square shows the corner-radius control and updates the hash + result panel", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("select-shape").selectOption("sq");

  await expect(page.getByTestId("input-shapeCornerRadius")).toBeVisible();
  await expect(async () => {
    expect(decodeHashDoc(page.url()).shape).toBe("sq");
  }).toPass();
  await expect(page.getByTestId("corner-radius")).toBeVisible();
});

test("editing the corner radius for a rounded triangle updates the hash and reproduces on reload", async ({ page }) => {
  // A large-enough locked outer size that the requested corner radius (15mm)
  // isn't clamped by the bend limit (see test/design.test.ts for the
  // clamping/"became round" cases).
  await page.goto("/#v=1&shape=tri&tri.rc=15&lock=outer,ly&size=60");
  await expect(page.getByTestId("select-shape")).toHaveValue("tri");
  await expect(page.getByTestId("input-shapeCornerRadius")).toHaveValue("15");
  await expect(page.getByTestId("corner-radius")).toHaveText("15.0 mm");

  const cornerInput = page.getByTestId("input-shapeCornerRadius");
  await cornerInput.fill("18");
  await cornerInput.blur();
  await expect(async () => {
    expect(decodeHashDoc(page.url()).rc).toBe(18);
  }).toPass();

  await page.reload();
  await expect(page.getByTestId("select-shape")).toHaveValue("tri");
  await expect(page.getByTestId("input-shapeCornerRadius")).toHaveValue("18");
});

test("a rounded-square core renders and the STL download works", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  await page.goto("/#v=1&L=1500&d=4&shape=sq&sq.rc=15&lock=outer,ly&size=60");
  await expect(page.getByTestId("hash-notice")).toHaveCount(0);
  await expect(page.getByTestId("diagnosis-status")).toBeVisible();
  await expect(page.getByTestId("coil-viewer").locator("canvas")).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("download-stl").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("coil.stl");
  const path = await download.path();
  expect(path).toBeTruthy();

  expect(consoleErrors, `unexpected console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
});
