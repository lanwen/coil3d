import { readFileSync, statSync } from "node:fs";
import { expect, test, type Download, type Page } from "@playwright/test";
import { encodeHashDoc } from "./hashDoc";

// Issues #396, #398: the STEP build takes 15-35 s, so the button shows a
// stripe and a timer, a stage list shows how far it got, the busy button
// cancels it, and a design change during the build restarts it so the file
// matches the screen.

// A T-clip design: it has a flange, so the join stage runs, and it takes about 10 s.
const TCLIP = { d: 3.8, lock: ["outer", "h"], size: 40, h: 25, mount: "skadis-tclip" };
const DESIGN = encodeHashDoc({ L: 1500, ...TCLIP });
const CHANGED = encodeHashDoc({ L: 2000, ...TCLIP });

const stepButton = (page: Page) => page.getByTestId("download-step");
const exportSection = (page: Page) => page.locator(".ctl-section").filter({ has: stepButton(page) });

async function openDesign(page: Page, hash: string) {
  await page.goto(`/${hash}`);
  await expect(stepButton(page)).toBeEnabled();
  await expect(page.getByTestId("mesh-detail")).toContainText("final");
}

async function stepFileSize(download: Download) {
  return statSync((await download.path())!).size;
}

test.describe("STEP export progress (issue #396)", () => {
  test.slow();

  test("the button turns busy at once with a counting timer, the stages advance, and it all goes away on success", async ({ page }) => {
    await openDesign(page, DESIGN);
    const download = page.waitForEvent("download");
    await stepButton(page).click();

    await expect(stepButton(page)).toBeEnabled();
    await expect(stepButton(page)).toHaveAccessibleName("Cancel STEP export");
    await expect(stepButton(page)).toContainText("Preparing STEP…");
    await expect(page.getByTestId("step-timer")).toHaveText("0 s", { timeout: 1000 });
    await expect(page.getByTestId("step-timer")).toHaveText(/^[1-9]\d* s$/);

    await expect(page.getByTestId("step-stages")).toBeVisible();
    await expect(page.getByTestId("step-stage-engine")).toHaveAttribute("data-state", /done|current/);
    await expect(page.getByTestId("step-stage-write")).toHaveAttribute("data-state", "waiting");
    await expect(page.getByTestId("step-stage-join")).toHaveAttribute("data-state", "current");
    await expect(page.getByTestId("step-stage-wall")).toHaveAttribute("data-state", "done");
    await expect(page.getByTestId("step-stages").getByRole("button")).toHaveCount(0);
    await expect(page.getByTestId("step-elapsed-sr")).toContainText(/Elapsed \d+ seconds/);

    expect((await download).suggestedFilename()).toBe("coil.step");
    await expect(page.getByTestId("step-stages")).toHaveCount(0);
    await expect(page.getByTestId("step-timer")).toHaveCount(0);
    await expect(stepButton(page)).toBeEnabled();
    await expect(stepButton(page)).toHaveText("Download STEP");
  });

  test("a failing build shows the error and clears the indicator", async ({ page }) => {
    await page.route(/replicad.*\.wasm/, (route) => route.fulfill({ status: 500, body: "" }));
    await openDesign(page, DESIGN);
    await stepButton(page).click();
    await expect(page.getByTestId("step-error")).toBeVisible();
    await expect(page.getByTestId("step-stages")).toHaveCount(0);
    await expect(page.getByTestId("step-timer")).toHaveCount(0);
    await expect(stepButton(page)).toBeEnabled();
  });

  test("clicking the busy button stops the build without an error, and the next export works", async ({ page }) => {
    const downloads: Download[] = [];
    page.on("download", (d) => downloads.push(d));
    await openDesign(page, DESIGN);
    await stepButton(page).click();
    await expect(page.getByTestId("step-stage-wall")).toBeVisible();
    await stepButton(page).click();

    await expect(page.getByTestId("step-stages")).toHaveCount(0);
    await expect(stepButton(page)).toBeEnabled();
    await expect(stepButton(page)).toHaveText("Download STEP");
    await expect(page.getByTestId("step-error")).toHaveCount(0);

    const next = page.waitForEvent("download");
    await stepButton(page).click();
    await expect(stepButton(page)).toHaveAccessibleName("Cancel STEP export");
    expect((await next).suggestedFilename()).toBe("coil.step");
    await expect(stepButton(page)).toBeEnabled();
    await page.waitForTimeout(1500);
    expect(downloads).toHaveLength(1);
  });

  test("changing the design during a build restarts it, and the one file that lands is the new design", async ({ page }) => {
    await openDesign(page, CHANGED);
    const reference = page.waitForEvent("download");
    await stepButton(page).click();
    const referenceSize = await stepFileSize(await reference);
    await expect(stepButton(page)).toBeEnabled();

    const downloads: Download[] = [];
    await page.goto("about:blank");
    await openDesign(page, DESIGN);
    page.on("download", (d) => downloads.push(d));
    await stepButton(page).click();
    await expect(page.getByTestId("step-stage-wall")).toBeVisible();

    await page.getByTestId("input-wireLength").fill("200");
    await expect(page.getByTestId("step-restarting")).toHaveText("Design changed, restarting…");
    await expect(stepButton(page)).toHaveAccessibleName("Cancel STEP export");
    await expect(page.getByTestId("step-restarting")).toHaveCount(0);
    await expect(page.getByTestId("step-stage-wall")).toBeVisible();

    await expect.poll(() => downloads.length, { timeout: 120_000 }).toBe(1);
    expect(await stepFileSize(downloads[0])).toBe(referenceSize);
    expect(readFileSync((await downloads[0].path())!, "utf8").slice(0, 20)).toContain("ISO-10303-21");
    await page.waitForTimeout(1500);
    expect(downloads).toHaveLength(1);
  });
});

test.describe("STEP progress screenshots, with a scripted build (issues #396, #398)", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((stages) => {
      const w = window as unknown as { __stepRuns: number };
      w.__stepRuns = 0;
      const RealWorker = window.Worker;
      window.Worker = class extends RealWorker {
        postMessage(data: unknown, ...rest: unknown[]) {
          if (!(data && typeof data === "object" && "flangeSpec" in data)) {
            (super.postMessage as (...args: unknown[]) => void)(data, ...rest);
            return;
          }
          const run = ++w.__stepRuns;
          if (run > 1) return;
          const plan = [{ id: "engine" }, { id: "wall" }, { id: "flange" }, { id: "join" }, { id: "joints" }, { id: "tclips", count: 3 }, { id: "write" }];
          const send = (message: unknown) => setTimeout(() => this.onmessage?.({ data: message } as MessageEvent), 0);
          send({ kind: "plan", stages: plan });
          for (const id of stages) send({ kind: "stage", id });
        }
      };
      Date.now = () => 1_700_000_000_000;
    }, ["engine", "wall", "flange", "join"]);
  });

  async function startScriptedBuild(page: Page) {
    await openDesign(page, DESIGN);
    await stepButton(page).click();
    await expect(page.getByTestId("step-stage-join")).toHaveAttribute("data-state", "current");
    await expect(page.getByTestId("step-timer")).toHaveText("0 s");
    await page.mouse.move(0, 0);
  }

  test("desktop: busy button and the stage list part way", async ({ page }) => {
    await startScriptedBuild(page);
    await expect(exportSection(page)).toHaveScreenshot("step-progress-desktop.png");
  });

  test("desktop: hovering the busy button inverts it and reads Cancel, and moving away restores it", async ({ page }) => {
    await startScriptedBuild(page);
    const busyLabel = page.getByTestId("step-label-busy");
    const cancelLabel = page.getByTestId("step-label-cancel");
    await expect(busyLabel).toBeVisible();
    await expect(cancelLabel).toBeHidden();
    await expect(stepButton(page)).toHaveCSS("background-color", "rgb(255, 255, 255)");

    await exportSection(page).scrollIntoViewIfNeeded();
    await stepButton(page).hover();
    await expect(cancelLabel).toBeVisible();
    await expect(busyLabel).toBeHidden();
    await expect(stepButton(page)).toHaveCSS("background-color", "rgb(0, 0, 0)");
    await expect(stepButton(page)).toHaveCSS("color", "rgb(255, 255, 255)");
    await expect(exportSection(page)).toHaveScreenshot("step-progress-hover.png");

    await page.mouse.move(0, 0);
    await expect(busyLabel).toBeVisible();
    await expect(cancelLabel).toBeHidden();
    await expect(stepButton(page)).toHaveCSS("background-color", "rgb(255, 255, 255)");
  });

  test("keyboard focus on the busy button reads Cancel, and Enter cancels", async ({ page }) => {
    await openDesign(page, DESIGN);
    await stepButton(page).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("step-stage-join")).toHaveAttribute("data-state", "current");
    await expect(page.getByTestId("step-label-cancel")).toBeVisible();
    await expect(stepButton(page)).toHaveCSS("background-color", "rgb(0, 0, 0)");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("step-stages")).toHaveCount(0);
    await expect(stepButton(page)).toHaveText("Download STEP");
  });

  test("phone: busy button and the stage list part way", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await startScriptedBuild(page);
    await exportSection(page).scrollIntoViewIfNeeded();
    await expect(exportSection(page)).toHaveScreenshot("step-progress-phone.png");
  });

  test("a design change shows Design changed, restarting…", async ({ page }) => {
    await startScriptedBuild(page);
    await page.getByTestId("input-wireLength").fill("200");
    await expect(page.getByTestId("step-restarting")).toBeVisible();
    await expect(page.getByTestId("step-stage-wall")).toHaveCount(0);
    await expect(exportSection(page)).toHaveScreenshot("step-progress-restarting.png");
  });
});
