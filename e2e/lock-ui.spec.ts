import { expect, test } from "@playwright/test";
import { openAdvanced } from "./advanced";
import { decodeHashDoc } from "./hashDoc";

// Issue #5 acceptance criteria: lock toggles update both the result panel
// and the URL hash, and any subset of {outer/inner size, height, layers}
// can be locked.
//
// The hash's own lock/size fields are asserted via `decodeHashDoc` (issue
// #56: the hash is now `#s=<base64url(JSON)>`, not a flat `key=value`
// string), not a literal substring check on `page.url()`.

test("the default state locks outer size + layers, leaving height free", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("lock-outer")).toBeChecked();
  await expect(page.getByTestId("lock-layers")).toBeChecked();
  await expect(page.getByTestId("lock-height")).not.toBeChecked();
  await expect(page.getByTestId("input-height")).toBeDisabled();
  expect(decodeHashDoc(page.url()).lock).toBeUndefined();
});

test("locking height updates the result panel and adds it to the hash's lock list", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("diagnosis-status")).toHaveText("ok"); // 1 free (height) by default

  // Issue #119: the default already locks 2 (outer + layers) -- height's own
  // lock toggle is disabled until one of those frees up.
  await page.getByTestId("lock-layers").uncheck();
  await page.getByTestId("lock-height").check();
  await expect(page.getByTestId("input-height")).toBeEnabled();

  // Now outer + height locked (2, the new limit), layers free: the hash must record it.
  await expect(async () => {
    const lockTokens = decodeHashDoc(page.url()).lock;
    expect(lockTokens).toContain("h");
    expect(lockTokens).not.toContain("ly");
  }).toPass();
  await expect(page.getByTestId("diagnosis-status")).toHaveText(/ok|over-constrained|under-constrained/);
});

test("changing the locked outer size value updates both the result panel and the hash", async ({ page }) => {
  await page.goto("/");
  const outerInput = page.getByTestId("input-outer");
  await outerInput.fill("50");
  await outerInput.blur();

  await expect(page.getByTestId("outer-size")).toHaveText("50.0 mm");
  await expect(async () => {
    expect(decodeHashDoc(page.url()).size).toBe(50);
  }).toPass();
});

test("switching the locked core-size dimension to inner and reloading reproduces the same view", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("select-coreSizeDimension").selectOption("inner");
  const innerInput = page.getByTestId("input-outer");
  await innerInput.fill("20");
  await innerInput.blur();

  await expect(async () => {
    const doc = decodeHashDoc(page.url());
    expect(doc.lock).toContain("inner");
    expect(doc.size).toBe(20);
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

  // Advanced settings stays collapsed (issue #169): open it to reach the picker.
  await openAdvanced(page);
  await expect(page.getByTestId("select-objective")).toBeVisible();
  await expect(page.getByTestId("alternate-candidate")).toBeVisible();
});

// Issue #119 AC #1: at most 2 of {core size, height, layers} can be locked
// at once -- something has to stay free so the solver can fit the cable
// length. These tests fail on main (no such restriction exists there: main
// lets `lock-height` be checked straight from the default state, making all
// three locked).
test.describe("at most 2 of core size / height / layers can be locked (issue #119)", () => {
  test("the default state (2 locked) disables the third lock toggle, with an explanatory note", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("lock-outer")).toBeChecked();
    await expect(page.getByTestId("lock-layers")).toBeChecked();
    await expect(page.getByTestId("lock-height")).not.toBeChecked();

    await expect(page.getByTestId("lock-height")).toBeDisabled();
    await expect(page.getByTestId("height-lock-note")).toContainText(/free/i);
    // The already-locked toggles stay enabled -- either can still be freed.
    await expect(page.getByTestId("lock-outer")).toBeEnabled();
    await expect(page.getByTestId("lock-layers")).toBeEnabled();
  });

  test("freeing one lock re-enables the third, and locking it disables whichever is now the odd one out", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("lock-layers").uncheck(); // 1 locked (outer), 2 free (height, layers)
    await expect(page.getByTestId("lock-height")).toBeEnabled();
    await expect(page.getByTestId("lock-layers")).toBeEnabled();

    await page.getByTestId("lock-height").check(); // 2 locked (outer, height)
    await expect(page.getByTestId("lock-layers")).toBeDisabled();
    await expect(page.getByTestId("layers-lock-note")).toContainText(/free/i);
    // outer and height stay freely toggleable.
    await expect(page.getByTestId("lock-outer")).toBeEnabled();
    await expect(page.getByTestId("lock-height")).toBeEnabled();
  });

  test("a link locking all three (current #s= format) parses to a valid, at-most-2-locked state and shows a notice, instead of crashing", async ({
    page,
  }) => {
    // #s=<base64url({v:2, L:6000, lock:["outer","h","ly"], size:60, h:60, ly:2})>
    const doc = { v: 2, L: 6000, lock: ["outer", "h", "ly"], size: 60, h: 60, ly: 2 };
    const s = Buffer.from(JSON.stringify(doc)).toString("base64url");
    await page.goto(`/#s=${s}`);

    await expect(page.getByTestId("diagnosis-status")).toBeVisible(); // renders -- no crash
    await expect(page.getByTestId("hash-notice")).toContainText(/layers/i);
    // Normalized down to 2 locked: core size + height stay locked (as requested), layers ends up free.
    await expect(page.getByTestId("lock-outer")).toBeChecked();
    await expect(page.getByTestId("lock-height")).toBeChecked();
    await expect(page.getByTestId("lock-layers")).not.toBeChecked();
    // Still 2 locked (core size + height) -- layers stays free, and locking
    // it back is disabled by the very same rule that dropped it.
    await expect(page.getByTestId("lock-layers")).toBeDisabled();
  });
});

// Issue #119 AC #2: the "Locked dimension" dropdown moves directly under the
// core-size lock toggle, and shows only while core size is locked (it used
// to always render, just disabled).
test.describe("the locked-dimension dropdown only shows while core size is locked, directly under it (issue #119)", () => {
  test("hidden while core size is free, appears immediately under the core-size field once locked", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("lock-outer").uncheck(); // 1 locked (layers), 2 free (outer, height)
    await expect(page.getByTestId("select-coreSizeDimension")).toHaveCount(0);

    await page.getByTestId("lock-outer").check();
    await expect(page.getByTestId("select-coreSizeDimension")).toBeVisible();

    // "Directly under the core-size lock": within the Core section, the
    // dimension dropdown's own `.field` is the very next one after the
    // core-size field (the one containing the `lock-outer` toggle).
    const coreSection = page.locator(".ctl-section").filter({ has: page.getByTestId("lock-outer") });
    const fields = coreSection.locator(".field");
    const count = await fields.count();
    let coreSizeIndex = -1;
    for (let i = 0; i < count; i++) {
      if (await fields.nth(i).locator('[data-testid="lock-outer"]').count()) {
        coreSizeIndex = i;
        break;
      }
    }
    expect(coreSizeIndex).toBeGreaterThanOrEqual(0);
    await expect(fields.nth(coreSizeIndex + 1).getByTestId("select-coreSizeDimension")).toBeVisible();
  });
});

// Issue #164: layers is a slider row like core size and height, and the
// padlock shows before the value only while a dimension is locked.
test.describe("padlock before the value, layers slider (issue #164)", () => {
  const ids = ["outer", "height", "layers"] as const;

  test("a padlock is visible only on locked dimensions, for all three", async ({ page }) => {
    await page.goto("/"); // core size + layers locked, height free
    await expect(page.getByTestId("lock-icon-outer")).toBeVisible();
    await expect(page.getByTestId("lock-icon-layers")).toBeVisible();
    await expect(page.getByTestId("lock-icon-height")).toHaveCount(0);

    await page.getByTestId("lock-layers").uncheck();
    await expect(page.getByTestId("lock-icon-layers")).toHaveCount(0);
    await page.getByTestId("lock-height").check();
    await expect(page.getByTestId("lock-icon-height")).toBeVisible();
    await expect(page.getByTestId("lock-icon-outer")).toBeVisible();

    await page.getByTestId("lock-outer").uncheck();
    await page.getByTestId("lock-height").uncheck();
    for (const id of ids) await expect(page.getByTestId(`lock-icon-${id}`)).toHaveCount(0);
  });

  test("the padlock is decorative and the toggles keep their names and state", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("lock-icon-layers")).toHaveAttribute("aria-hidden", "true");
    await expect(page.getByRole("switch", { name: "Lock layers" })).toBeChecked();
    await expect(page.getByRole("switch", { name: "Lock height" })).not.toBeChecked();
    await expect(page.getByRole("switch", { name: "Lock height" })).toBeDisabled();
  });

  test("layers has no bordered number box and sits on the right like core size", async ({ page }) => {
    await page.goto("/");
    const border = await page.getByTestId("input-layers").evaluate((el) => getComputedStyle(el).borderTopWidth);
    expect(border).toBe("0px");
    await expect(page.locator(".stepper")).toHaveCount(0);
    const layers = (await page.getByTestId("input-layers").boundingBox())!;
    const outer = (await page.getByTestId("input-outer").boundingBox())!;
    expect(Math.abs(layers.x + layers.width - (outer.x + outer.width))).toBeLessThan(40);
  });

  test("the layers slider changes the value and the hash; a free layers has no slider", async ({ page }) => {
    await page.goto("/");
    const slider = page.getByRole("slider", { name: "Layers" });
    await slider.focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("input-layers")).toHaveValue("2");
    await expect(async () => {
      expect(decodeHashDoc(page.url()).ly).toBe(2);
    }).toPass();

    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("input-layers")).toHaveValue("3");
    await expect(async () => {
      expect(decodeHashDoc(page.url()).ly).toBe(3);
    }).toPass();

    await page.getByTestId("lock-layers").uncheck();
    await expect(page.getByRole("slider", { name: "Layers" })).toHaveCount(0);
    await expect(page.getByTestId("input-layers")).toBeDisabled();
  });

  test("typing a layer count rounds to a whole number", async ({ page }) => {
    await page.goto("/");
    const input = page.getByTestId("input-layers");
    await input.fill("4");
    await input.blur();
    await expect(async () => {
      expect(decodeHashDoc(page.url()).ly).toBe(4);
    }).toPass();
  });

  // Core size and height do not clamp a typed value (or a hash value) to
  // their slider's max; they only floor it. Layers behave the same way, so a
  // value past the slider's 40 is kept as typed and a link's value is never
  // rewritten.
  test("a typed layer count above the slider max is kept, like height; a link's value is left alone", async ({ page }) => {
    await page.goto("/");
    const layers = page.getByTestId("input-layers");
    await layers.fill("60");
    await layers.blur();
    await expect(layers).toHaveValue("60");
    await expect(async () => {
      expect(decodeHashDoc(page.url()).ly).toBe(60);
    }).toPass();

    // Reference behaviour: height (slider max 400) keeps a typed 450.
    await page.getByTestId("lock-layers").uncheck();
    await page.getByTestId("lock-height").check();
    const height = page.getByTestId("input-height");
    await height.fill("450");
    await height.blur();
    await expect(height).toHaveValue("450");
    await expect(async () => {
      expect(decodeHashDoc(page.url()).h).toBe(450);
    }).toPass();

    // A link carrying layers past the slider max shows it and keeps it.
    const doc = { v: 2, L: 6000, lock: ["outer", "ly"], size: 60, ly: 60 };
    await page.goto(`/#s=${Buffer.from(JSON.stringify(doc)).toString("base64url")}`);
    await page.reload();
    await expect(page.getByTestId("input-layers")).toHaveValue("60");
    expect(decodeHashDoc(page.url()).ly).toBe(60);
  });
});
