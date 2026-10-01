import { expect, test, type Page } from "@playwright/test";
import { decodeHashDoc, encodeHashDoc } from "./hashDoc";

// End-to-end checks for the SKÅDIS rim clips (issue #207; the clip mount
// plate before it was issues #14 and #106). The geometry and the fit on a
// board built from the SKÅDIS facts are covered by vitest against the public
// `design()` interface (test/skadisFit.test.ts); these check the URL hash <->
// UI <-> viewer seam: the mount controls, the clips showing up as parts, the
// mount-side view with the slot grid, and the exports.

const ROUND_60 = encodeHashDoc({ L: 2000, d: 3.8, size: 60, mount: "skadis" });
const ROUND_85 = encodeHashDoc({ L: 2000, d: 3.8, size: 85, mount: "skadis" });
const ROUND_120 = encodeHashDoc({ L: 2000, d: 3.8, size: 120, mount: "skadis" });
const SQUARE_85 = encodeHashDoc({ L: 2000, d: 3.8, size: 85, shape: "sq", rc: 10, mount: "skadis" });
const TRIANGLE_85 = encodeHashDoc({ L: 2000, d: 3.8, size: 85, shape: "tri", rc: 10, mount: "skadis" });

async function gotoDesign(page: Page, hash: string) {
  await page.goto(`/${hash}`);
  await expect(page.getByTestId("coil-viewer").locator("canvas")).toBeVisible();
  // Wait for the FINAL-resolution mesh before settling: the draft->final
  // swap (issue #7) is CPU-time-, not wall-clock-bound, so a fixed sleep
  // alone can race it under a loaded/slow run (see line-art.spec.ts's
  // gotoDesign, issue #61/#62, for the full story).
  await expect(page.getByTestId("download-stl")).toBeEnabled();
  await page.waitForTimeout(800);
}

test.describe("SKÅDIS mount controls (issue #207)", () => {
  test("the picker offers the SKÅDIS rim clips with a plain-language label, openGrid stays hidden", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("mount-enabled").check();
    const options = await page.getByTestId("select-mount").locator("option").allTextContents();
    expect(options.join(" ")).toMatch(/SK.DIS rim clips: hook on, lift off/i);
    expect(options.join(" ")).not.toMatch(/openGrid/i);
    expect(options.join(" ")).not.toMatch(/none/i);
  });

  test("a shared link with mount=opengrid falls back to defaults with a notice, not a silently-wrong plate", async ({ page }) => {
    await page.goto(`/${encodeHashDoc({ mount: "opengrid" })}`);
    await expect(page.getByTestId("hash-notice")).toBeVisible();
    await expect(page.getByTestId("mount-enabled")).not.toBeChecked();
    await expect(page.getByTestId("select-mount")).toHaveCount(0);
  });

  test("the SKÅDIS note and the latch switch show only for the SKÅDIS mount", async ({ page }) => {
    await page.goto(`/${encodeHashDoc({ L: 2000, d: 4, size: 100 })}`);
    await page.getByTestId("mount-enabled").check();
    for (const kind of ["keyhole", "through"]) {
      await page.getByTestId("select-mount").selectOption(kind);
      await expect(page.getByTestId("mount-note")).toHaveCount(0);
      await expect(page.getByTestId("skadis-latch")).toHaveCount(0);
    }
    await page.getByTestId("select-mount").selectOption("skadis");
    await expect(page.getByTestId("mount-note")).toContainText(/grip the flange's rim/i);
    await expect(page.getByTestId("skadis-latch")).toBeChecked();
  });

  test("switching to SKÅDIS adds three clips, jumps to the mount-side view once, and reproduces on reload", async ({ page }) => {
    await gotoDesign(page, encodeHashDoc({ L: 2000, d: 3.8, size: 85 }));
    await expect(page.getByTestId("preset-mountSide")).toHaveCount(0);
    await page.getByTestId("mount-enabled").check();
    await page.getByTestId("select-mount").selectOption("skadis");
    await expect(async () => expect(decodeHashDoc(page.url()).mount).toBe("skadis")).toPass();
    await expect(page.getByTestId("mount")).toContainText(/SK.DIS rim clips/i);
    await expect(page.getByTestId("mesh-detail")).toContainText("4 parts");
    await expect(page.getByTestId("preset-mountSide")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("wall-view-caption")).toHaveText(/SK.DIS slot/i);

    // A link that already has the clips opens in the usual Iso view, with the mount-side view one click away.
    await page.reload();
    await expect(page.getByTestId("select-mount")).toHaveValue("skadis");
    await expect(page.getByTestId("preset-iso")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("preset-mountSide")).toBeVisible();
  });

  test("turning the latch off is saved in the link (and only then)", async ({ page }) => {
    await gotoDesign(page, ROUND_85);
    expect(decodeHashDoc(page.url()).latch).toBeUndefined();
    await page.getByTestId("skadis-latch").uncheck();
    await expect(async () => expect(decodeHashDoc(page.url()).latch).toBe(false)).toPass();
    await page.reload();
    await expect(page.getByTestId("skadis-latch")).not.toBeChecked();
    await page.getByTestId("skadis-latch").check();
    await expect(async () => expect(decodeHashDoc(page.url()).latch).toBeUndefined()).toPass();
  });

  test("a heavy cable gets a second top clip", async ({ page }) => {
    await gotoDesign(page, encodeHashDoc({ L: 10000, d: 8, wt: "flex", size: 85, ly: 4, mount: "skadis" }));
    await expect(page.getByTestId("mesh-detail")).toContainText("6 parts"); // core, cap, 2 top + 2 bottom clips
  });

  // Issue #120: a tiny, locked core used to silently skip the mount; the
  // flange's margin grows just wide enough to fit the clips instead.
  test("a small core still gets the clips by growing the flange margin (never a silent skip)", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    await gotoDesign(page, encodeHashDoc({ L: 20, d: 1, size: 12, h: 20, mount: "skadis" }));
    await expect(page.getByTestId("warnings")).toContainText(/margin increased.*SK.DIS/i);
    await expect(page.getByTestId("warnings")).not.toContainText(/too small/i);
    expect(consoleErrors, `unexpected console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
  });
});

test.describe("SKÅDIS clips render and export end to end (issue #207)", () => {
  test("the clips render, and STL/3MF/STEP all download", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await gotoDesign(page, ROUND_85);
    await expect(page.getByTestId("hash-notice")).toHaveCount(0);

    const stlDownload = page.waitForEvent("download");
    await page.getByTestId("download-stl").click();
    const stl = await stlDownload;
    expect(stl.suggestedFilename()).toBe("coil-parts.zip"); // 4 parts (core, 3 clips) -> zip, mirrors issue #9's own convention
    expect(await stl.path()).toBeTruthy();

    const threeMfDownload = page.waitForEvent("download");
    await page.getByTestId("download-3mf").click();
    const threeMf = await threeMfDownload;
    expect(threeMf.suggestedFilename()).toBe("coil.3mf");
    expect(await threeMf.path()).toBeTruthy();

    const stepDownload = page.waitForEvent("download");
    await page.getByTestId("download-step").click();
    const step = await stepDownload;
    expect(step.suggestedFilename()).toBe("coil.step");
    expect(await step.path()).toBeTruthy();

    expect(consoleErrors, `unexpected console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
  });
});

test.describe("SKÅDIS clip screenshots (issue #207)", () => {
  for (const { label, hash } of [
    { label: "round-60", hash: ROUND_60 },
    { label: "round-85", hash: ROUND_85 },
    { label: "round-120", hash: ROUND_120 },
    { label: "square-85", hash: SQUARE_85 },
    { label: "triangle-85", hash: TRIANGLE_85 },
  ]) {
    test(`${label}: the mount-side view shows every clip in a drawn SKÅDIS slot`, async ({ page }) => {
      await gotoDesign(page, hash);
      await page.getByTestId("preset-mountSide").click();
      await expect(page.getByTestId("wall-view-caption")).toHaveText(/SK.DIS slot/i);
      await expect(page.getByTestId("coil-viewer").locator("canvas")).toHaveScreenshot(`skadis-mountside-${label}.png`);
    });
  }

  test("round-85: the wall-mount (room-side) preset shows the clips on the board", async ({ page }) => {
    await gotoDesign(page, ROUND_85);
    const canvas = page.getByTestId("coil-viewer").locator("canvas");
    await page.getByTestId("preset-wallRoom").click();
    await expect(page.getByTestId("wall-view-caption")).toHaveText(/top cap faces the room/i);
    await page.waitForTimeout(900);
    await expect(canvas).toHaveScreenshot("skadis-wallroom-round-85.png");
  });

  test("round-85: the assembled clips, and the exploded view that separates them from the rim", async ({ page }) => {
    await gotoDesign(page, ROUND_85);
    const canvas = page.getByTestId("coil-viewer").locator("canvas");
    await expect(canvas).toHaveScreenshot("skadis-assembled-round-85.png");
    const assembled = await canvas.screenshot();
    await page.getByTestId("toggle-exploded").check();
    await page.waitForTimeout(1000);
    const exploded = await canvas.screenshot();
    expect(exploded.equals(assembled), "exploding must change the render").toBe(false);
    await expect(canvas).toHaveScreenshot("skadis-exploded-round-85.png");
  });
});
