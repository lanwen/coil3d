import { expect, test, type Page } from "@playwright/test";
import { decodeHashDoc, encodeHashDoc } from "./hashDoc";

// End-to-end checks for the SKÅDIS T-clips (issues #213, #221, after the
// CC BY 4.0 Skadis T-Clip System), in slots through a floor in the bore. The fit, the twist lock and printability are
// covered by vitest against the public `design()` interface
// (test/skadisFit.test.ts); these check the hash <-> UI <-> viewer seam, the
// credit, the exports and the screenshots.

const tclips = (doc: Record<string, unknown>) => encodeHashDoc({ L: 2000, d: 3.8, mount: "skadis-tclip", ...doc });
const ROUND_40 = tclips({ size: 40 });
const ROUND_60 = tclips({ size: 60 });
const ROUND_85 = tclips({ size: 85 });
const ROUND_120 = tclips({ size: 120 });

async function gotoDesign(page: Page, hash: string) {
  await page.goto(`/${hash}`);
  await expect(page.getByTestId("coil-viewer").locator("canvas")).toBeVisible();
  // Wait for the FINAL-resolution mesh before settling (see skadis-clips.spec.ts).
  await expect(page.getByTestId("download-stl")).toBeEnabled();
  await page.waitForTimeout(800);
}

test.describe("SKÅDIS T-clip controls (issues #213, #221)", () => {
  test("the picker offers both SKÅDIS mounts with their plain-language hints", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("mount-enabled").check();
    const options = await page.getByTestId("select-mount").locator("option").allTextContents();
    expect(options.join(" ")).toMatch(/SK.DIS rim clips: hook on, lift off/i);
    expect(options.join(" ")).toMatch(/SK.DIS T-clips: twist to lock/i);
  });

  test("selecting the T-clips adds three clips, credits the T-Clip System, has no latch switch, and reproduces on reload", async ({ page }) => {
    await gotoDesign(page, encodeHashDoc({ L: 2000, d: 3.8, size: 85 }));
    await page.getByTestId("mount-enabled").check();
    await page.getByTestId("select-mount").selectOption("skadis-tclip");
    await expect(async () => expect(decodeHashDoc(page.url()).mount).toBe("skadis-tclip")).toPass();
    await expect(page.getByTestId("mount")).toContainText(/SK.DIS T-clips/i);
    await expect(page.getByTestId("mesh-detail")).toContainText("4 parts");
    await expect(page.getByTestId("skadis-latch")).toHaveCount(0);
    const note = page.getByTestId("mount-note");
    await expect(note).toContainText(/quarter turn/i);
    await expect(note).toContainText(/core's floor/i);
    await expect(note).toContainText(/pinch its fin/i);
    await expect(note).toContainText(/Line Arc Line/);
    await expect(note).toContainText(/CC BY 4\.0/);
    await expect(note.getByRole("link", { name: "Skadis T-Clip System" })).toHaveAttribute("href", "https://www.printables.com/model/256896");
    await expect(page.getByTestId("preset-mountSide")).toHaveAttribute("aria-pressed", "true");
    await page.reload();
    await expect(page.getByTestId("select-mount")).toHaveValue("skadis-tclip");
  });

  for (const { label, hash, parts, message } of [
    { label: "round-60", hash: ROUND_60, parts: "3 parts", message: /room for 2 SK.DIS T-clips/i },
    { label: "round-40", hash: ROUND_40, parts: "2 parts", message: /room for 1 SK.DIS T-clip.*lift the coil/i },
  ]) {
    test(`${label}: a smaller bore gets fewer clips, and says how the coil hangs`, async ({ page }) => {
      await gotoDesign(page, hash);
      await expect(page.getByTestId("mesh-detail")).toContainText(parts);
      await expect(page.getByTestId("warnings")).toContainText(message);
    });
  }

  test("the clips render, and STL/3MF/STEP all download", async ({ page }) => {
    test.slow();
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    await gotoDesign(page, ROUND_85);
    for (const [id, name] of [
      ["download-stl", "coil-parts.zip"],
      ["download-3mf", "coil.3mf"],
      ["download-step", "coil.step"],
    ] as const) {
      const download = page.waitForEvent("download");
      await page.getByTestId(id).click();
      expect((await download).suggestedFilename()).toBe(name);
    }
    expect(consoleErrors, `unexpected console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
  });
});

test.describe("SKÅDIS T-clip screenshots (issues #213, #221)", () => {
  for (const { label, hash } of [
    { label: "round-40", hash: ROUND_40 },
    { label: "round-60", hash: ROUND_60 },
    { label: "round-85", hash: ROUND_85 },
    { label: "round-120", hash: ROUND_120 },
  ]) {
    test(`${label}: the mount-side view shows every T-clip turned across a drawn SKÅDIS slot`, async ({ page }) => {
      await gotoDesign(page, hash);
      await page.getByTestId("preset-mountSide").click();
      await expect(page.getByTestId("wall-view-caption")).toHaveText(/SK.DIS slot/i);
      await expect(page.getByTestId("coil-viewer").locator("canvas")).toHaveScreenshot(`skadis-tclip-mountside-${label}.png`);
    });
  }

  test("round-85: the print layout lays the T-clips flat beside the core, fins and all", async ({ page }) => {
    await gotoDesign(page, ROUND_85);
    await page.getByTestId("preset-printLayout").click();
    await expect(page.getByTestId("wall-view-caption")).toHaveText(/no supports needed/i);
    await expect(page.getByTestId("coil-viewer").locator("canvas")).toHaveScreenshot("skadis-tclip-print-round-85.png");
  });
});
