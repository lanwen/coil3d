import { expect, test } from "@playwright/test";
import { decodeHashDoc, encodeHashDoc } from "./hashDoc";
import { openAllNumbers } from "./advanced";

// Issue #6 acceptance criteria: the user can choose a rounded-square or
// rounded-triangle core, with a corner-radius control, and the result panel
// / hash reflect the choice. Solver math itself is covered by vitest
// against the public `design()` interface (test/design.test.ts).
//
// Issue #52 replaced the `<select>` dropdown with a row of pictogram radio
// buttons (one real `<input type="radio">` per shape, generated from the
// shape registry): `shape-option-<kind>` is now how a shape is selected
// and asserted on, in place of the old `select-shape` testid.
//
// The hash's own shape/rc fields are asserted via `decodeHashDoc` (issue
// #56: the hash is now `#s=<base64url(JSON)>`, and no longer namespaces the
// corner radius per shape -- a single `rc` key, paired with `shape`).

test("the default shape is round, with no corner-radius control shown", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("shape-option-round")).toBeChecked();
  await expect(page.getByTestId("shape-option-sq")).not.toBeChecked();
  await expect(page.getByTestId("shape-option-tri")).not.toBeChecked();
  await expect(page.getByTestId("input-shapeCornerRadius")).toHaveCount(0);
  expect(decodeHashDoc(page.url()).shape).toBeUndefined();
});

test("every shape in the registry gets its own accessible radio button", async ({ page }) => {
  await page.goto("/");
  const group = page.getByRole("radiogroup", { name: "Core shape" });
  await expect(group).toBeVisible();
  await expect(page.getByRole("radio", { name: "Round", exact: true })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Rounded square", exact: true })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Rounded triangle", exact: true })).toBeVisible();
});

test("switching to a rounded square shows the corner-radius control and updates the hash + result panel", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("shape-option-sq").check();

  await expect(page.getByTestId("shape-option-sq")).toBeChecked();
  await expect(page.getByTestId("input-shapeCornerRadius")).toBeVisible();
  await expect(async () => {
    expect(decodeHashDoc(page.url()).shape).toBe("sq");
  }).toPass();
  // The corner-radius row is under "All numbers" (issue #192).
  await openAllNumbers(page);
  await expect(page.getByTestId("corner-radius")).toBeVisible();
});

test("keyboard: arrow keys move the selection within the shape radiogroup", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("shape-option-round").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("shape-option-sq")).toBeChecked();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("shape-option-tri")).toBeChecked();
});

test("editing the corner radius for a rounded triangle updates the hash and reproduces on reload", async ({ page }) => {
  // A large-enough locked outer size that the requested corner radius (15mm)
  // isn't clamped by the bend limit (see test/design.test.ts for the
  // clamping/"became round" cases).
  await page.goto(`/${encodeHashDoc({ shape: "tri", rc: 15, size: 60 })}`);
  await expect(page.getByTestId("shape-option-tri")).toBeChecked();
  await expect(page.getByTestId("input-shapeCornerRadius")).toHaveValue("15");
  await expect(page.getByTestId("corner-radius")).toHaveText("15.0 mm");

  const cornerInput = page.getByTestId("input-shapeCornerRadius");
  await cornerInput.fill("18");
  await cornerInput.blur();
  await expect(async () => {
    expect(decodeHashDoc(page.url()).rc).toBe(18);
  }).toPass();

  await page.reload();
  await expect(page.getByTestId("shape-option-tri")).toBeChecked();
  await expect(page.getByTestId("input-shapeCornerRadius")).toHaveValue("18");
});

test("a rounded-square core renders and the STL download works", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  await page.goto(`/${encodeHashDoc({ L: 1500, d: 4, shape: "sq", rc: 15, size: 60 })}`);
  await expect(page.getByTestId("hash-notice")).toHaveCount(0);
  await expect(page.getByTestId("verdict")).toBeVisible();
  await expect(page.getByTestId("coil-viewer").locator("canvas")).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("download-stl").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("coil.stl");
  const path = await download.path();
  expect(path).toBeTruthy();

  expect(consoleErrors, `unexpected console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
});
