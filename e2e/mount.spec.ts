import { expect, test } from "@playwright/test";
import { decodeHashDoc } from "./hashDoc";

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

test("mount defaults to off (no dropdown, toggle unchecked), with no mount param in the hash", async ({ page }) => {
  await page.goto("/");
  // Issue #131: off is the toggle's own state now, not a "None" dropdown
  // entry -- the dropdown doesn't exist at all until the toggle is on.
  await expect(page.getByTestId("mount-enabled")).not.toBeChecked();
  await expect(page.getByTestId("select-mount")).toHaveCount(0);
  await expect(page.getByTestId("mount")).toHaveText("None");
  expect(decodeHashDoc(page.url()).mount).toBeUndefined();
});

test("switching to the screw-keyhole mount updates the hash + result panel, and reproduces on reload", async ({ page }) => {
  // A 2 mm cable: its channel pad (3.5 mm) is thinner than the keyhole's
  // own 5 mm, so the mount really does thicken the flange (issue #122).
  await page.goto("/#v=1&L=2000&d=2&lock=outer,ly&size=100&h=60");
  // Issue #131: the kind picker only appears once the wall-mount toggle is
  // switched on (defaulting to keyhole, the first time).
  await page.getByTestId("mount-enabled").check();
  await expect(page.getByTestId("select-mount")).toHaveValue("keyhole");
  await page.getByTestId("select-mount").selectOption("keyhole");

  await expect(async () => {
    expect(decodeHashDoc(page.url()).mount).toBe("keyhole");
  }).toPass();
  await expect(page.getByTestId("mount")).toHaveText("Screw keyhole");
  // The bumped flange margin/thickness (design.ts) surface as warnings.
  await expect(page.getByTestId("warnings")).toContainText(/margin increased/i);
  await expect(page.getByTestId("warnings")).toContainText(/thickness increased/i);

  await page.reload();
  await expect(page.getByTestId("mount-enabled")).toBeChecked();
  await expect(page.getByTestId("select-mount")).toHaveValue("keyhole");
  await expect(page.getByTestId("mount")).toHaveText("Screw keyhole");
});

test("turning the mount toggle off and back on remembers the last chosen kind (issue #131)", async ({ page }) => {
  await page.goto("/#v=1&L=2000&d=2&lock=outer,ly&size=100&h=60");
  await page.getByTestId("mount-enabled").check();
  await page.getByTestId("select-mount").selectOption("through");
  await expect(async () => expect(decodeHashDoc(page.url()).mount).toBe("through")).toPass();

  await page.getByTestId("mount-enabled").uncheck();
  await expect(page.getByTestId("select-mount")).toHaveCount(0);
  await expect(async () => expect(decodeHashDoc(page.url()).mount).toBeUndefined()).toPass();
  await expect(page.getByTestId("mount")).toHaveText("None");

  await page.getByTestId("mount-enabled").check();
  await expect(page.getByTestId("select-mount")).toHaveValue("through");
  await expect(async () => expect(decodeHashDoc(page.url()).mount).toBe("through")).toPass();
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

// Issue #49 trimmed the viewer's own view controls down to just Front, Iso
// and a single "Wall mount" preset (the hung, room-side view) -- the
// standalone `toggle-wall-view` button that used to cycle standing -> room
// side -> mount side is gone (its room-side state is now just the "Wall
// mount" preset button, alongside Front/Iso, in the same bar), and the
// mount-side ("what the wall sees") camera view no longer exists in the
// interactive viewer at all -- it stays available in the assembly guide
// (`guide/Guide.tsx`'s `StepMountKeyhole`, which never used this viewer's
// preset bar in the first place).
//
// The wall-mount preset's own render/caption behavior on this identical
// keyhole hash is covered by e2e/view-controls.spec.ts ("front, iso and
// wall-mount each render a distinct view" and "the wall-mount preset shows a
// caption; front/iso don't") and e2e/mount-plate.spec.ts, so it isn't
// re-asserted here.

// Issue #71 acceptance criteria: a `keyholeRotation` 0/45 option in the
// UI/hash, with a hint, that follows through to the geometry (and the
// guide's own mount-side inset, see guide.spec.ts) -- vitest (test/mount.
// test.ts) covers the actual placement math; these check the UI wiring.
test.describe("keyhole mount rotation (issue #71)", () => {
  test("the rotation field only shows for the keyhole mount, defaults to 0 (omitted from the hash), and updates on change", async ({ page }) => {
    await page.goto("/#v=1&L=2000&d=4&lock=outer,ly&size=100&h=60");
    await expect(page.getByTestId("select-keyholeRotation")).toHaveCount(0);

    await page.getByTestId("mount-enabled").check();
    await page.getByTestId("select-mount").selectOption("keyhole");
    await expect(page.getByTestId("select-keyholeRotation")).toHaveValue("0");
    expect(decodeHashDoc(page.url()).kr).toBeUndefined();

    await page.getByTestId("select-keyholeRotation").selectOption("45");
    await expect(async () => {
      expect(decodeHashDoc(page.url()).kr).toBe(45);
    }).toPass();

    await page.getByTestId("select-mount").selectOption("through");
    await expect(page.getByTestId("select-keyholeRotation")).toHaveCount(0);
  });

  test("a rotated keyhole mount reproduces on reload and stays manifold, with no console errors", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await page.goto("/#v=1&L=2000&d=4&lock=outer,ly&size=100&h=60&mount=keyhole&shape=sq");
    await page.getByTestId("select-keyholeRotation").selectOption("45");
    await expect(async () => {
      expect(decodeHashDoc(page.url()).kr).toBe(45);
    }).toPass();
    await expect(page.getByTestId("coil-viewer").locator("canvas")).toBeVisible();
    await expect(page.getByTestId("download-stl")).toBeEnabled();

    await page.reload();
    await expect(page.getByTestId("select-keyholeRotation")).toHaveValue("45");

    expect(consoleErrors, `unexpected console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
  });
});

// Issue #70 acceptance criteria (revised #129): a `mount=through` option in
// the UI/hash with a hole-diameter parameter and a hint, cutting plain,
// constant-radius through-holes (near the corners for sq/tri, evenly spaced
// for round), no counterbore and no pad -- vitest (test/mount.test.ts)
// covers the placement/manifold math; these check the UI wiring end to end.
// "through" is a NEW mount kind, added long after issue #56's `#v=1&...`
// legacy format was frozen (mirrors "opengrid", which never reached that
// format either -- see hash.ts's own comment), so these navigate via a base
// legacy link + the UI's own mount selector, never a hand-written
// `&mount=through` legacy hash the codec can't read.
const BASE_HASH = "#v=1&L=2000&d=4&lock=outer,ly&size=100&h=60";

test.describe("through-hole mount (issue #70)", () => {
  test("switching to the through-hole mount updates the hash + result panel, shows the hole-diameter field, and reproduces on reload", async ({ page }) => {
    await page.goto(`/${BASE_HASH}`);
    await expect(page.getByTestId("input-throughHoleDiameter")).toHaveCount(0);

    await page.getByTestId("mount-enabled").check();
    await page.getByTestId("select-mount").selectOption("through");
    await expect(async () => {
      expect(decodeHashDoc(page.url()).mount).toBe("through");
    }).toPass();
    await expect(page.getByTestId("mount")).toHaveText("Through-holes");
    await expect(page.getByTestId("input-throughHoleDiameter")).toBeVisible();
    // Issue #129: no counterbore any more, so the mount never needs its own
    // thickness floor -- only the flange margin ever grows to fit it.
    await expect(page.getByTestId("warnings")).toContainText(/margin increased/i);
    await expect(page.getByTestId("warnings")).not.toContainText(/thickness increased/i);

    await page.getByTestId("input-throughHoleDiameter").fill("6");
    await expect(async () => {
      expect(decodeHashDoc(page.url()).thd).toBe(6);
    }).toPass();

    await page.reload();
    await expect(page.getByTestId("select-mount")).toHaveValue("through");
    await expect(page.getByTestId("input-throughHoleDiameter")).toHaveValue("6");
  });

  // "also works for square and triangle cores" used to live here as a
  // second `page.goto` inside the same test, one per shape -- but a
  // hash-only `page.goto` is a same-document navigation, and the app only
  // reads the hash at mount (App.tsx's `readInitialState`, no `hashchange`/
  // `popstate` listener), so the second iteration silently kept re-testing
  // the FIRST shape's already-loaded state. The real per-shape placement
  // math (one hole per corner) is owned by test/mount.test.ts ("places one
  // hole per corner for square/triangle", the through-hole mesh genus checks
  // and the hard-clearance sq/tri matrix); the browser wiring for the
  // through-hole mount is already covered by the two tests around this one.
  test("the through-hole mount core renders, stays manifold end to end, and both STL and STEP download", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await page.goto(`/${BASE_HASH}`);
    await page.getByTestId("mount-enabled").check();
    await page.getByTestId("select-mount").selectOption("through");
    await expect(async () => {
      expect(decodeHashDoc(page.url()).mount).toBe("through");
    }).toPass();
    await expect(page.getByTestId("coil-viewer").locator("canvas")).toBeVisible();
    await expect(page.getByTestId("download-stl")).toBeEnabled();

    const stlDownload = page.waitForEvent("download");
    await page.getByTestId("download-stl").click();
    const stl = await stlDownload;
    expect(await stl.path()).toBeTruthy();

    const stepDownload = page.waitForEvent("download");
    await page.getByTestId("download-step").click();
    const step = await stepDownload;
    expect(await step.path()).toBeTruthy();

    expect(consoleErrors, `unexpected console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
  });
});
