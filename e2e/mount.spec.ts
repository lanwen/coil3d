import { expect, test } from "@playwright/test";

// Issue #13 acceptance criteria: a `mount` option (none|keyhole) in the UI
// and hash, the core still prints flat (no supports) with a recessed
// keyhole slot cut into the flange, the part stays manifold, and the
// viewer can show the wall orientation. Solver/geometry/STEP math itself is
// covered by vitest against the public `design()` interface (test/design.
// test.ts, test/geometry.test.ts); these check the UI wiring and the
// end-to-end render.

// A comfortably large, fully-locked core: big enough that the mount
// actually fits (see test/design.test.ts's "too narrow" case for the small
// end), so these checks exercise the real cut, not the graceful skip.
const KEYHOLE_HASH = "#v=1&L=2000&d=4&lock=outer,ly&size=100&h=60&mount=keyhole";

test("mount defaults to none, with no mount param in the hash", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("select-mount")).toHaveValue("none");
  await expect(page.getByTestId("mount")).toHaveText("None");
  expect(page.url()).not.toContain("mount=");
});

test("switching to the screw-keyhole mount updates the hash + result panel, and reproduces on reload", async ({ page }) => {
  await page.goto("/#v=1&L=2000&d=4&lock=outer,ly&size=100&h=60");
  await page.getByTestId("select-mount").selectOption("keyhole");

  await expect(async () => {
    expect(new URL(page.url()).hash).toContain("mount=keyhole");
  }).toPass();
  await expect(page.getByTestId("mount")).toHaveText("Screw keyhole");
  // The bumped flange margin/thickness (design.ts) surface as warnings.
  await expect(page.getByTestId("warnings")).toContainText(/margin increased/i);
  await expect(page.getByTestId("warnings")).toContainText(/thickness increased/i);

  await page.reload();
  await expect(page.getByTestId("select-mount")).toHaveValue("keyhole");
  await expect(page.getByTestId("mount")).toHaveText("Screw keyhole");
});

test("a tiny, sharp core still fits the mount by growing the flange (warned about), never crashing", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  // design.ts's requiredFlangeMargin has no ceiling: even a tiny, sharp core
  // gets a flange grown just wide enough to fit the mount, not a silent skip.
  await page.goto("/#v=1&L=20&d=1&lock=outer,ly&size=6&h=20&mount=keyhole");
  await expect(page.getByTestId("select-mount")).toHaveValue("keyhole");
  await expect(page.getByTestId("warnings")).toContainText(/margin increased/i);
  await expect(page.getByTestId("warnings")).not.toContainText(/too narrow/i);
  await expect(page.getByTestId("coil-viewer").locator("canvas")).toBeVisible();

  expect(consoleErrors, `unexpected console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
});

test("the keyhole-mount core renders, stays manifold end to end, and both STL and STEP download", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  await page.goto(`/${KEYHOLE_HASH}`);
  await expect(page.getByTestId("hash-notice")).toHaveCount(0);
  await expect(page.getByTestId("diagnosis-status")).toBeVisible();
  await expect(page.getByTestId("coil-viewer").locator("canvas")).toBeVisible();
  await expect(page.getByTestId("download-stl")).toBeEnabled();

  const stlDownload = page.waitForEvent("download");
  await page.getByTestId("download-stl").click();
  const stl = await stlDownload;
  expect(stl.suggestedFilename()).toBe("coil.stl");
  expect(await stl.path()).toBeTruthy();

  const stepDownload = page.waitForEvent("download");
  await page.getByTestId("download-step").click();
  const step = await stepDownload;
  expect(step.suggestedFilename()).toBe("coil.step");
  expect(await step.path()).toBeTruthy();

  expect(consoleErrors, `unexpected console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
});

test("the wall-mount viewer presets (room side, mount side) each change the render and show their own caption", async ({ page }) => {
  await page.goto(`/${KEYHOLE_HASH}`);
  const canvas = page.getByTestId("coil-viewer").locator("canvas");
  const toggle = page.getByTestId("toggle-wall-view");
  await expect(canvas).toBeVisible();
  await page.waitForTimeout(500); // let the pipeline settle a few frames, matching e2e/line-art.spec.ts

  await expect(page.getByTestId("wall-view-caption")).toHaveCount(0);
  const standing = await canvas.screenshot();

  // Room-side preset (the coil as it hangs, flange against the wall).
  await toggle.click();
  await expect(page.getByTestId("wall-view-caption")).toHaveText(/top cap faces the room/i);
  await page.waitForTimeout(500);
  const wallRoom = await canvas.screenshot();
  expect(wallRoom.equals(standing), "the room-side wall preset must change the render").toBe(false);

  // Mount-side preset (issue #13 PR review round 2: the flange's outer,
  // keyhole-bearing face turned to face the camera, "what the wall sees").
  await toggle.click();
  await expect(page.getByTestId("wall-view-caption")).toHaveText(/line up screws with the keyhole slots/i);
  await page.waitForTimeout(500);
  const wallMount = await canvas.screenshot();
  expect(wallMount.equals(standing), "the mount-side wall preset must change the render").toBe(false);
  expect(wallMount.equals(wallRoom), "the mount-side preset must render differently from the room-side preset").toBe(false);

  await toggle.click();
  await expect(page.getByTestId("wall-view-caption")).toHaveCount(0);
});

test("the debug axis overlay stays hidden by default and only appears in the mount-side preset behind ?debugAxis=1", async ({ page }) => {
  await page.goto(`/${KEYHOLE_HASH}`);
  await expect(page.getByTestId("coil-viewer").locator("canvas")).toBeVisible();
  await expect(page.getByTestId("debug-axis-overlay")).toHaveCount(0);
  const toggle = page.getByTestId("toggle-wall-view");
  await toggle.click(); // room side
  await expect(page.getByTestId("debug-axis-overlay")).toHaveCount(0);
  await toggle.click(); // mount side
  await expect(page.getByTestId("debug-axis-overlay")).toHaveCount(0);

  // The debug flag is a URL query param, which lives before the hash.
  await page.goto(`/?debugAxis=1${KEYHOLE_HASH}`);
  await expect(page.getByTestId("coil-viewer").locator("canvas")).toBeVisible();
  await expect(page.getByTestId("debug-axis-overlay")).toHaveCount(0); // still standing view
  await page.getByTestId("toggle-wall-view").click(); // room side
  await expect(page.getByTestId("debug-axis-overlay")).toHaveCount(0);
  await page.getByTestId("toggle-wall-view").click(); // mount side
  await expect(page.getByTestId("debug-axis-overlay")).toBeVisible();
});
