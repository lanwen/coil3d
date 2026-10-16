import { expect, test, type Page } from "@playwright/test";
import { decodeHashDoc, encodeHashDoc } from "./hashDoc";
import { expectSettled } from "./settled";

// Issue #336: Share and Reset in the header. The header height must not move
// (every screenshot baseline depends on it): these are the heights measured on
// the header before the buttons existed.
const HEADER_HEIGHT = { desktop: 107, phone: 110 };
const COPY_FEEDBACK_TIMEOUT_MS = 5_000;

async function openWithNonDefaultDesign(page: Page) {
  await page.goto("/");
  await page.getByTestId("input-wireLength").fill("350");
  await page.getByTestId("input-wireLength").blur();
  await page.getByTestId("shape-option-sq").check();
  await expect(async () => {
    const doc = decodeHashDoc(page.url());
    expect(doc.L).toBe(3500);
    expect(doc.shape).toBe("sq");
  }).toPass();
}

async function readClipboard(page: Page) {
  return page.evaluate(() => navigator.clipboard.readText());
}

test("Share opens the system share sheet with the current link", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __shared: unknown[] };
    w.__shared = [];
    navigator.share = async (data) => {
      w.__shared.push(data);
    };
  });
  await openWithNonDefaultDesign(page);
  await page.getByTestId("share").click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __shared: unknown[] }).__shared)).toEqual([{ title: "coil3d", url: page.url() }]);
  expect(page.url()).toContain("#s=");
  await expect(page.getByTestId("share")).toHaveText("Share");
});

test("cancelling the share sheet is silent and copies nothing", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.addInitScript(() => {
    navigator.share = async () => {
      throw new DOMException("cancelled", "AbortError");
    };
  });
  await page.goto("/");
  await page.evaluate(() => navigator.clipboard.writeText("untouched"));
  await page.getByTestId("share").click();
  await expect(page.getByTestId("share")).toHaveText("Share");
  await expect(page.getByText("Couldn't copy")).toHaveCount(0);
  await expect(page.getByText("Copied")).toHaveCount(0);
  expect(await readClipboard(page)).toBe("untouched");
});

test("a share sheet that fails for another reason falls back to copying", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.addInitScript(() => {
    navigator.share = async () => {
      throw new DOMException("denied", "NotAllowedError");
    };
  });
  await page.goto("/");
  await page.getByTestId("share").click();
  await expect(page.getByTestId("share")).toHaveText("Copied");
  expect(await readClipboard(page)).toBe(page.url());
});

test("without a share sheet, Share copies the link and says so for a moment", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "share", { value: undefined, configurable: true });
  });
  await openWithNonDefaultDesign(page);
  await page.getByTestId("share").click();
  await expect(page.getByTestId("share")).toHaveText("Copied");
  await expect(page.getByRole("status")).toHaveText("Link copied to the clipboard");
  expect(await readClipboard(page)).toBe(page.url());
  await expect(page.getByTestId("share")).toHaveText("Share", { timeout: COPY_FEEDBACK_TIMEOUT_MS });
  await expect(page.getByRole("status")).toHaveText("");
});

test("a failed copy says so", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "share", { value: undefined, configurable: true });
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async () => {
          throw new DOMException("blocked", "NotAllowedError");
        },
      },
      configurable: true,
    });
  });
  await page.goto("/");
  await page.getByTestId("share").click();
  await expect(page.getByTestId("share")).toHaveText("Couldn't copy");
  await expect(page.getByTestId("share")).toHaveText("Share", { timeout: COPY_FEEDBACK_TIMEOUT_MS });
});

test("Reset is absent at the default design and appears after a change", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("reset")).toHaveCount(0);
  await expect(page.getByTestId("reset-confirm")).toHaveCount(0);
  await expect(page.getByTestId("share")).toBeVisible();
  const atDefault = (await page.getByTestId("share").boundingBox())!;
  await openWithNonDefaultDesign(page);
  await expect(page.getByTestId("reset")).toBeVisible();
  const changed = (await page.getByTestId("share").boundingBox())!;
  expect(Math.abs(changed.x - atDefault.x)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(changed.width - atDefault.width)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(changed.y - atDefault.y)).toBeLessThanOrEqual(0.5);
});

test("Reset comes first and Share last, in the tab order too", async ({ page }) => {
  await openWithNonDefaultDesign(page);
  const reset = (await page.getByTestId("reset").boundingBox())!;
  const share = (await page.getByTestId("share").boundingBox())!;
  expect(reset.x + reset.width).toBeLessThanOrEqual(share.x);
  await page.getByTestId("reset").focus();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("share")).toBeFocused();
});

test("Share isn't rendered while confirming and returns to its position", async ({ page }) => {
  await openWithNonDefaultDesign(page);
  const before = (await page.getByTestId("share").boundingBox())!;
  const sameAsBefore = async () => {
    const now = (await page.getByTestId("share").boundingBox())!;
    for (const key of ["x", "y", "width", "height"] as const) expect(Math.abs(now[key] - before[key])).toBeLessThanOrEqual(0.5);
  };
  for (const leave of [
    () => page.getByTestId("reset-no").click(),
    () => page.keyboard.press("Escape"),
    () => page.locator(".viewer").click({ position: { x: 300, y: 300 } }),
  ]) {
    await page.getByTestId("reset").click();
    await expect(page.getByTestId("reset-confirm")).toBeVisible();
    await expect(page.getByTestId("share")).toHaveCount(0);
    await leave();
    await expect(page.getByTestId("reset-confirm")).toHaveCount(0);
    await expect(page.getByTestId("share")).toBeVisible();
    await sameAsBefore();
  }
  await page.getByTestId("reset").click();
  await expect(page.getByTestId("share")).toHaveCount(0);
  await page.getByTestId("reset-yes").click();
  await expect(page.getByTestId("share")).toBeVisible();
  await sameAsBefore();
});

test("Reset asks first, then puts the design back to its defaults", async ({ page }) => {
  await openWithNonDefaultDesign(page);
  await expect(page.getByTestId("download-stl")).toBeEnabled();
  await page.getByTestId("reset").click();
  await expect(page.getByTestId("reset-confirm").locator(".reset-confirm-prompt")).toHaveText("Sure to reset?");
  await expect(page.getByTestId("reset-yes")).toBeVisible();
  await expect(page.getByTestId("reset-no")).toBeVisible();
  await expect(page.getByTestId("reset-no")).toBeFocused();
  expect(decodeHashDoc(page.url()).L).toBe(3500);

  await page.getByTestId("reset-yes").click();
  await expect(page.getByTestId("input-wireLength")).toHaveValue("200");
  await expect(page.getByTestId("shape-option-round")).toBeChecked();
  await expect(async () => {
    expect(decodeHashDoc(page.url())).toEqual({ v: 2 });
  }).toPass();
  await expect(page.getByTestId("reset")).toHaveCount(0);
  await expect(page.getByTestId("reset-confirm")).toHaveCount(0);
  await expect(page.getByTestId("share")).toBeFocused();
  await expect(page.getByTestId("download-stl")).toBeEnabled();
  await expectSettled(page);
});

test("Reset clears a hash notice", async ({ page }) => {
  await page.goto(`/${encodeHashDoc({ lock: ["outer", "h", "ly"] })}`);
  await expect(page.getByTestId("hash-notice")).toBeVisible();
  await page.getByTestId("reset").click();
  await page.getByTestId("reset-yes").click();
  await expect(page.getByTestId("hash-notice")).toHaveCount(0);
});

test("Reset forgets the form's own memory too", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("mount-enabled").check();
  await page.getByTestId("select-mount").selectOption("skadis");
  await page.getByTestId("mount-enabled").uncheck();
  await page.getByTestId("shape-option-sq").check();
  await page.getByTestId("reset").click();
  await page.getByTestId("reset-yes").click();
  await page.getByTestId("mount-enabled").check();
  await expect(page.getByTestId("select-mount")).toHaveValue("keyhole");
});

const CANCELS: { name: string; cancel: (page: Page) => Promise<void>; focusReturns: boolean }[] = [
  { name: "No", cancel: (page) => page.getByTestId("reset-no").click(), focusReturns: true },
  { name: "Escape", cancel: (page) => page.keyboard.press("Escape"), focusReturns: true },
  { name: "a click elsewhere on the page", cancel: (page) => page.locator(".viewer").click({ position: { x: 300, y: 300 } }), focusReturns: false },
];

for (const { name, cancel, focusReturns } of CANCELS) {
  test(`${name} cancels the reset and keeps the design`, async ({ page }) => {
    await openWithNonDefaultDesign(page);
    await page.getByTestId("reset").click();
    await expect(page.getByTestId("reset-confirm")).toBeVisible();
    await cancel(page);
    await expect(page.getByTestId("reset-confirm")).toHaveCount(0);
    await expect(page.getByTestId("reset")).toBeVisible();
    if (focusReturns) await expect(page.getByTestId("reset")).toBeFocused();
    await expect(page.getByTestId("input-wireLength")).toHaveValue("350");
    await expect(page.getByTestId("shape-option-sq")).toBeChecked();
    expect(decodeHashDoc(page.url()).L).toBe(3500);
  });
}

test("moving focus out of the confirmation cancels it", async ({ page }) => {
  await openWithNonDefaultDesign(page);
  await page.getByTestId("reset").click();
  await expect(page.getByTestId("reset-no")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("reset-confirm")).toHaveCount(0);
  await expect(page.getByTestId("reset")).toBeVisible();
});

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800, header: HEADER_HEIGHT.desktop },
  { name: "phone 390", width: 390, height: 800, header: HEADER_HEIGHT.phone },
  { name: "phone 360", width: 360, height: 800, header: HEADER_HEIGHT.phone },
];

for (const { name, width, height, header } of VIEWPORTS) {
  test(`the header keeps its height and the buttons fit beside the title (${name})`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto("/");
    await page.evaluate(() => document.fonts.ready);

    const box = async (testId: string) => (await page.getByTestId(testId).boundingBox())!;
    const h1 = (await page.locator("header h1").boundingBox())!;
    const headerHeight = async () => (await page.locator("header").boundingBox())!.height;
    const noOverflow = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const h1TextRight = await page.locator("header h1").evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return range.getBoundingClientRect().right;
    });

    expect(await headerHeight()).toBe(header);
    const shareAtDefault = await box("share");
    expect(shareAtDefault.x + shareAtDefault.width).toBeLessThanOrEqual(width);
    expect(h1TextRight).toBeLessThanOrEqual(shareAtDefault.x);
    await noOverflow();

    await openWithNonDefaultDesign(page);
    expect(await headerHeight()).toBe(header);
    const share = await box("share");
    const reset = await box("reset");
    expect(Math.abs(share.x - shareAtDefault.x)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(share.width - shareAtDefault.width)).toBeLessThanOrEqual(0.5);
    expect(reset.x + reset.width).toBeLessThanOrEqual(share.x);
    expect(share.x + share.width).toBeLessThanOrEqual(width);
    expect(h1TextRight).toBeLessThanOrEqual(reset.x);
    for (const b of [share, reset]) {
      expect(b.y).toBeGreaterThanOrEqual(h1.y);
      expect(b.y + b.height).toBeLessThanOrEqual(h1.y + h1.height);
    }
    await noOverflow();

    await page.getByTestId("reset").click();
    await expect(page.getByTestId("share")).toHaveCount(0);
    const confirm = await box("reset-confirm");
    expect(Math.abs(confirm.x + confirm.width - (shareAtDefault.x + shareAtDefault.width))).toBeLessThanOrEqual(0.5);
    expect(confirm.x + confirm.width).toBeLessThanOrEqual(width);
    expect(h1TextRight).toBeLessThanOrEqual(confirm.x);
    expect(confirm.height).toBeLessThanOrEqual(h1.height);
    expect(await headerHeight()).toBe(header);
    await noOverflow();
  });
}
