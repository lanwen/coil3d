import { expect, test, type Page } from "@playwright/test";
import { decodeHashDoc } from "./hashDoc";

// End-to-end checks for issue #14 (clip mount plate: SKÅDIS and openGrid).
// Solver/geometry numbers themselves are covered by vitest against the
// public `design()` interface (test/mountPlate.test.ts); these check the
// URL hash <-> UI <-> viewer seam: the mount/plate-joint controls, the
// mount plate showing up as a second part, the exploded view separating it
// from the flange, and the wall-mount-face preset showing it in place.

// A comfortably large round core: big enough that the plate actually fits
// (>= 2 SKÅDIS clips on the 40mm grid) -- mirrors mount.spec.ts's own
// KEYHOLE_HASH convention for the same reason.
const SKADIS_ROUND = "#v=1&L=2000&d=3.8&lock=outer,ly&size=100&h=60&mount=skadis";
const SKADIS_SQUARE = "#v=1&L=2000&d=3.8&lock=outer,ly&size=100&h=60&shape=sq&sq.rc=15&mount=skadis";
const SKADIS_TRIANGLE = "#v=1&L=2000&d=3.8&lock=outer,ly&size=120&h=60&shape=tri&tri.rc=15&mount=skadis";

async function gotoDesign(page: Page, hash: string) {
  await page.goto(`/${hash}`);
  await expect(page.getByTestId("coil-viewer").locator("canvas")).toBeVisible();
  // Wait for the FINAL-resolution mesh before settling: the draft->final
  // swap (issue #7) is CPU-time-, not wall-clock-bound, so a fixed sleep
  // alone can race it under a loaded/slow CI run (see line-art.spec.ts's
  // gotoDesign, issue #61/#62, for the full story).
  await expect(page.getByTestId("download-stl")).toBeEnabled();
  await page.waitForTimeout(800);
}

test.describe("mount plate controls (issue #14)", () => {
  test("skadis appears in the mount select, but openGrid is hidden (issue #14 PR review, issue #38: placeholder connector geometry only)", async ({ page }) => {
    await page.goto("/");
    const options = await page.getByTestId("select-mount").locator("option").allTextContents();
    expect(options.join(" ")).toMatch(/SK.DIS/i);
    expect(options.join(" ")).not.toMatch(/openGrid/i);
    await expect(page.getByTestId("select-plateJoint")).toHaveCount(0); // mount=none by default
  });

  test("a shared link with mount=opengrid falls back to defaults with a notice, not a silently-wrong plate", async ({ page }) => {
    await page.goto("/#v=1&mount=opengrid");
    await expect(page.getByTestId("hash-notice")).toBeVisible();
    await expect(page.getByTestId("select-mount")).toHaveValue("none");
  });

  test("switching to skadis adds the plate, jumps to the mount-side view once, and reproduces on reload (issue #106)", async ({ page }) => {
    await gotoDesign(page, "#v=1&L=2000&d=3.8&lock=outer,ly&size=100&h=60");
    await expect(page.getByTestId("preset-mountSide")).toHaveCount(0); // no plate, no mount-side view
    await page.getByTestId("select-mount").selectOption("skadis");
    await expect(async () => expect(decodeHashDoc(page.url()).mount).toBe("skadis")).toPass();
    await expect(page.getByTestId("mount")).toContainText(/SK.DIS/i);
    await expect(page.getByTestId("mesh-detail")).toContainText("2 parts");
    // The plate sits behind the flange, where Iso never looks: selecting it shows it.
    await expect(page.getByTestId("preset-mountSide")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("wall-view-caption")).toHaveText(/SK.DIS slot/i);
    // The plate joint is always pins + glue now (snap tabs couldn't print without supports).
    await expect(page.getByTestId("select-plateJoint")).toHaveCount(0);

    // A link that already has the plate opens in the usual Iso view, with the mount-side view one click away.
    await page.reload();
    await expect(page.getByTestId("select-mount")).toHaveValue("skadis");
    await expect(page.getByTestId("preset-iso")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("preset-mountSide")).toBeVisible();
  });

  test("an old snap-tab link still opens, builds the pin + glue plate and says so", async ({ page }) => {
    await gotoDesign(page, `#v=1&L=2000&d=3.8&lock=outer,ly&size=100&h=60&mount=skadis&pj=snap`);
    await expect(page.getByTestId("hash-notice")).toHaveCount(0);
    await expect(page.getByTestId("mesh-detail")).toContainText("2 parts");
    await expect(page.getByTestId("warnings")).toContainText(/snap tabs can't print without supports/i);
  });

  test("a small core warns and keeps a single part (no mount plate fits)", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    await gotoDesign(page, "#v=1&L=20&d=1&lock=outer,ly&size=12&h=20&mount=skadis");
    await expect(page.getByTestId("warnings")).toContainText(/too small to fit at least 2 clips/i);
    await expect(page.getByTestId("mesh-detail")).toContainText("1 part");
    expect(consoleErrors, `unexpected console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
  });
});

test.describe("mount plate render, exports and manifold end-to-end (issue #14)", () => {
  test("the skadis plate renders, stays manifold end to end, and STL/3MF/STEP all download", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await gotoDesign(page, SKADIS_ROUND);
    await expect(page.getByTestId("hash-notice")).toHaveCount(0);
    await expect(page.getByTestId("download-stl")).toBeEnabled();

    const stlDownload = page.waitForEvent("download");
    await page.getByTestId("download-stl").click();
    const stl = await stlDownload;
    expect(stl.suggestedFilename()).toBe("coil-parts.zip"); // 2 parts -> zip, mirrors issue #9's own convention
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

test.describe("mount plate screenshots (issue #14)", () => {
  // Issue #49 trimmed the interactive viewer's view controls down to Front,
  // Iso and one "Wall mount" preset (the hung, room-side view); issue #106
  // brings back a "Mount side" preset ("what the wall sees", with the
  // SKÅDIS slot grid drawn in), offered only while a SKÅDIS plate exists.
  // The room-side wall view draws the board's slots around the coil too.
  for (const { label, hash } of [
    { label: "round", hash: SKADIS_ROUND },
    { label: "square", hash: SKADIS_SQUARE },
  ]) {
    test(`${label} core: the wall-mount (room-side) preset changes the render`, async ({ page }) => {
      await gotoDesign(page, hash);
      const canvas = page.getByTestId("coil-viewer").locator("canvas");
      const standing = await canvas.screenshot();
      await page.getByTestId("preset-wallRoom").click();
      await expect(page.getByTestId("wall-view-caption")).toHaveText(/top cap faces the room/i);
      await page.waitForTimeout(900);
      const wallRoom = await canvas.screenshot();
      expect(wallRoom.equals(standing), "the wall-mount preset must change the render").toBe(false);
      await expect(canvas).toHaveScreenshot(`mount-plate-wallroom-${label}.png`);
    });
  }

  for (const { label, hash } of [
    { label: "round", hash: SKADIS_ROUND },
    { label: "square", hash: SKADIS_SQUARE },
    { label: "triangle", hash: SKADIS_TRIANGLE },
  ]) {
    test(`${label} core: the mount-side view shows every clip in a drawn SKÅDIS slot (issue #106)`, async ({ page }) => {
      await gotoDesign(page, hash);
      await page.getByTestId("preset-mountSide").click();
      await expect(page.getByTestId("wall-view-caption")).toHaveText(/SK.DIS slot/i);
      await expect(page.getByTestId("coil-viewer").locator("canvas")).toHaveScreenshot(`mount-plate-mountside-${label}.png`);
    });
  }

  test("exploded view separates the mount plate from the flange", async ({ page }) => {
    await gotoDesign(page, SKADIS_ROUND);
    const canvas = page.getByTestId("coil-viewer").locator("canvas");
    await expect(canvas).toHaveScreenshot("mount-plate-assembled.png");
    const assembled = await canvas.screenshot();

    await page.getByTestId("toggle-exploded").check();
    await page.waitForTimeout(1000);
    const exploded = await canvas.screenshot();
    expect(exploded.equals(assembled), "exploding must change the render").toBe(false);
    await expect(canvas).toHaveScreenshot("mount-plate-exploded.png");
  });

  test("a close-up on the exploded, separated plate shows its own clip/peg geometry clearly", async ({ page }) => {
    // Illustrative only (not a literal print-bed render -- there's no
    // print-orientation preview in the viewer): the plate's own printTransform
    // (design.ts) is just a 180deg flip about X, so this exploded, separated
    // view already shows the same clip/panel geometry a slicer would load,
    // just not re-oriented flat-on-the-bed.
    await gotoDesign(page, SKADIS_ROUND);
    await page.getByTestId("toggle-exploded").check();
    await page.waitForTimeout(1000);
    const canvas = page.getByTestId("coil-viewer").locator("canvas");
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.82);
    for (let i = 0; i < 4; i++) {
      await page.mouse.wheel(0, -120);
      await page.waitForTimeout(50);
    }
    await expect(canvas).toHaveScreenshot("mount-plate-closeup.png");
  });
});
