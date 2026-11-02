import { expect, test, type Page } from "@playwright/test";
import { decodeHashDoc, encodeHashDoc, withHashDoc } from "./hashDoc";
import { expectSettled } from "./settled";

// Issue #404: the controls panel says why it overrides or limits a choice, in
// visible text under the row it concerns.

const ROUND_CAP = encodeHashDoc({ L: 5000, d: 3.8, lock: ["outer", "h"], size: 60, h: 60, cap: "on", base: "on" });
const TINY_CORE_SNAP = encodeHashDoc({ L: 500, d: 1.2, wt: "usb", lock: ["outer", "h"], size: 10, h: 20, cap: "on", base: "on", joint: "snap" });
const PHONE = { width: 390, height: 844 };

async function gotoDesign(page: Page, hash: string) {
  await page.goto(`/${hash}`);
  await expect(page.getByTestId("download-stl")).toBeEnabled();
  await expectSettled(page);
}

const lineCount = (page: Page, testId: string) =>
  page.getByTestId(testId).evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return new Set(Array.from(range.getClientRects()).map((rect) => Math.round(rect.top))).size;
  });

test.describe("joint fallback note", () => {
  test("a square core with twist-lock chosen explains the press-fit cap and drops the suffix from the selected option", async ({ page }) => {
    await gotoDesign(page, withHashDoc(ROUND_CAP, { shape: "sq", joint: "bayonet" }));
    const note = page.getByTestId("joint-fallback-note");
    await expect(note).toHaveText("Twist-lock needs a round core, so this cap is press-fit. Pick Snap clips, or a round core.");
    const bayonet = page.getByTestId("select-joint").locator('option[value="bayonet"]');
    await expect(bayonet).toHaveText("Bayonet / twist-lock");
    await expect(bayonet).toBeDisabled();
    await expect(page.getByTestId("select-joint")).toHaveValue("bayonet");
    await expect(page.getByTestId("select-joint")).toHaveAttribute("aria-describedby", (await note.getAttribute("id"))!);
  });

  test("the suffix stays on the disabled option while another joint is selected", async ({ page }) => {
    await gotoDesign(page, withHashDoc(ROUND_CAP, { shape: "sq", joint: "snap" }));
    await expect(page.getByTestId("joint-fallback-note")).toHaveCount(0);
    await expect(page.getByTestId("select-joint").locator('option[value="bayonet"]')).toContainText("round core only");
  });

  test("a round core has no note", async ({ page }) => {
    await gotoDesign(page, withHashDoc(ROUND_CAP, { joint: "bayonet" }));
    await expect(page.getByTestId("joint-fallback-note")).toHaveCount(0);
  });

  test("switching a twist-lock design to a square core keeps the joint and shows the note; back to round hides it", async ({ page }) => {
    await gotoDesign(page, withHashDoc(ROUND_CAP, { joint: "bayonet" }));
    await page.getByTestId("shape-option-sq").check();
    await expect(page.getByTestId("joint-fallback-note")).toContainText("Twist-lock needs a round core");
    await expect(page.getByTestId("select-joint")).toHaveValue("bayonet");
    await expect(async () => expect(decodeHashDoc(page.url())).toMatchObject({ shape: "sq", joint: "bayonet" })).toPass();
    await page.getByTestId("shape-option-round").check();
    await expect(page.getByTestId("joint-fallback-note")).toHaveCount(0);
  });

  test("a core too small for the snap clips says so, and picking Press-fit clears the note", async ({ page }) => {
    await gotoDesign(page, TINY_CORE_SNAP);
    await expect(page.getByTestId("joint-fallback-note")).toHaveText("This core is too small for the snap clips, so the cap is press-fit. Make the core bigger or pick Press-fit.");
    await page.getByTestId("select-joint").selectOption("press");
    await expect(page.getByTestId("joint-fallback-note")).toHaveCount(0);
  });

  test("the notes fit in two lines at phone width", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await gotoDesign(page, withHashDoc(ROUND_CAP, { shape: "sq", joint: "bayonet" }));
    expect(await lineCount(page, "joint-fallback-note")).toBeLessThanOrEqual(2);
    await page.goto("about:blank");
    await gotoDesign(page, TINY_CORE_SNAP);
    expect(await lineCount(page, "joint-fallback-note")).toBeLessThanOrEqual(2);
  });
});

test.describe("greyed controls say why", () => {
  test("a wall mount forces the Base switch on and the note says so", async ({ page }) => {
    await gotoDesign(page, encodeHashDoc({ mount: "skadis" }));
    await expect(page.getByTestId("base")).toBeChecked();
    await expect(page.getByTestId("base")).toBeDisabled();
    const note = page.getByTestId("base-forced-note");
    await expect(note).toHaveText("On, because a wall mount needs a base.");
    await expect(page.getByTestId("base")).toHaveAttribute("aria-describedby", (await note.getAttribute("id"))!);
  });

  test("without a mount there is no forced-base note", async ({ page }) => {
    await gotoDesign(page, encodeHashDoc({}));
    await expect(page.getByTestId("base-forced-note")).toHaveCount(0);
  });

  test("the default design's Customize row says what turns it on", async ({ page }) => {
    await gotoDesign(page, encodeHashDoc({}));
    await expect(page.getByTestId("customize-summary")).toHaveText("Turn on the top cap or the base to add a label or strap slots.");
  });

  test("with a cap the summary goes back to Nothing added", async ({ page }) => {
    await gotoDesign(page, encodeHashDoc({ cap: "on" }));
    await expect(page.getByTestId("customize-summary")).toHaveText("Nothing added");
  });

  test("the notes fit in two lines at phone width", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await gotoDesign(page, encodeHashDoc({ mount: "skadis" }));
    expect(await lineCount(page, "base-forced-note")).toBeLessThanOrEqual(2);
    await page.goto("about:blank");
    await gotoDesign(page, encodeHashDoc({}));
    expect(await lineCount(page, "customize-summary")).toBeLessThanOrEqual(2);
  });
});

test.describe("plain top cap switch", () => {
  test("the default design has no AUTO tag and no reset link", async ({ page }) => {
    await gotoDesign(page, encodeHashDoc({}));
    await expect(page.getByTestId("topCap")).not.toBeChecked();
    await expect(page.getByTestId("topCap-auto-tag")).toHaveCount(0);
    await expect(page.getByTestId("topCap-reset-auto")).toHaveCount(0);
  });
});

test.describe("lock note", () => {
  test("names the two locked fields and what to do", async ({ page }) => {
    await gotoDesign(page, encodeHashDoc({}));
    await expect(page.getByTestId("height-lock-note")).toHaveText("Unlock core size or layers to lock height. One size stays free to fit the cable.");
  });

  test("follows which two are locked", async ({ page }) => {
    await gotoDesign(page, encodeHashDoc({ lock: ["h", "ly"] }));
    await expect(page.getByTestId("outer-lock-note")).toHaveText("Unlock height or layers to lock core size. One size stays free to fit the cable.");
  });
});
