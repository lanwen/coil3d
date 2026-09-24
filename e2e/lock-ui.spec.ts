import { expect, test } from "@playwright/test";

// Issue #5 acceptance criteria: lock toggles update both the result panel
// and the URL hash, and any subset of {outer/inner size, height, layers}
// can be locked.

test("the default state locks outer size + layers, leaving height free", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("lock-outer")).toBeChecked();
  await expect(page.getByTestId("lock-layers")).toBeChecked();
  await expect(page.getByTestId("lock-height")).not.toBeChecked();
  await expect(page.getByTestId("input-height")).toBeDisabled();
  expect(page.url()).not.toContain("lock=");
});

test("locking height updates the result panel and adds it to the hash's lock list", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("diagnosis-status")).toHaveText("ok"); // 1 free (height) by default

  await page.getByTestId("lock-height").check();
  await expect(page.getByTestId("input-height")).toBeEnabled();

  // Now 0 free (outer + layers + height all locked): the hash must record it.
  await expect(async () => {
    const hash = new URL(page.url()).hash;
    const params = new URLSearchParams(hash.replace(/^#/, ""));
    const lockTokens = (params.get("lock") ?? "").split(",");
    expect(lockTokens).toContain("h");
  }).toPass();
  await expect(page.getByTestId("diagnosis-status")).toHaveText(/ok|over-constrained/);
});

test("changing the locked outer size value updates both the result panel and the hash", async ({ page }) => {
  await page.goto("/");
  const outerInput = page.getByTestId("input-outer");
  await outerInput.fill("50");
  await outerInput.blur();

  await expect(page.getByTestId("outer-size")).toHaveText("50.0 mm");
  await expect(async () => {
    expect(new URL(page.url()).hash).toContain("size=50");
  }).toPass();
});

test("switching the locked core-size dimension to inner and reloading reproduces the same view", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("select-coreSizeDimension").selectOption("inner");
  const innerInput = page.getByTestId("input-outer");
  await innerInput.fill("20");
  await innerInput.blur();

  await expect(async () => {
    const hash = new URL(page.url()).hash;
    expect(hash).toContain("lock=inner");
    expect(hash).toContain("size=20");
  }).toPass();
  const innerBoreBefore = await page.getByTestId("inner-bore").textContent();

  await page.reload();
  await expect(page.getByTestId("select-coreSizeDimension")).toHaveValue("inner");
  await expect(page.getByTestId("input-outer")).toHaveValue("20");
  await expect(page.getByTestId("inner-bore")).toHaveText(innerBoreBefore!);
});

test("unlocking layers (2 free: height + layers) shows an alternate candidate", async ({ page }) => {
  await page.goto("/");
  // Default state locks outer size + layers, leaving height free (1 free).
  // Unlocking layers too leaves outer size locked and height + layers free.
  await page.getByTestId("lock-layers").uncheck();

  await expect(page.getByTestId("select-objective")).toBeVisible();
  await expect(page.getByTestId("alternate-candidate")).toBeVisible();
});
