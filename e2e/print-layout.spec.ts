import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { encodeHashDoc } from "./hashDoc";
import { expectSettled } from "./settled";

// End-to-end checks for issue #78: a "Print layout" view showing every part
// exactly as it lies on the print bed -- the SAME transform the 3MF export
// places it at (core's `printPlacements`, plate.ts's `bedRestingTransform` +
// `layoutParts`), drawn on a rectangle the size of the configured bed, in
// the viewer's own line-art style, with part names and a "no supports
// needed" note. Solver/geometry numbers are unaffected (vitest coverage is
// unchanged); these check the viewer seam: the preset exists next to
// Front/Iso/Wall mount, its own scene (bed + placed parts + captions), and
// -- the AC's own "shared function" claim -- that the view's own exposed
// per-part transform (mirrored as accessible text, like DimensionAxes' own
// hidden list) EXACTLY matches the 3MF export's own per-item transform.

const ONE_PART = encodeHashDoc({ L: 1000, d: 4, size: 50, h: 40, ly: 1, cap: "off" }); // core only
const TWO_PART = encodeHashDoc({ L: 5000, d: 3.8, lock: ["outer", "h"], size: 60, h: 60, cap: "on" }); // core + top cap
const SKADIS = encodeHashDoc({ L: 2000, d: 3.8, size: 100, h: 60, mount: "skadis" }); // core + 3 SKÅDIS rim clips
const TRIANGLE_TWO_PART = encodeHashDoc({ L: 6000, d: 3.8, lock: ["outer", "h"], size: 60, h: 60, cap: "on", shape: "tri", rc: 15 });

async function gotoDesign(page: Page, hash: string) {
  await page.goto(`/${hash}`);
  await expect(page.getByTestId("coil-viewer").locator("canvas")).toBeVisible();
  await expect(page.getByTestId("download-stl")).toBeEnabled();
  await expectSettled(page);
}

async function showPrintLayout(page: Page) {
  await page.getByTestId("preset-printLayout").click();
  await expectSettled(page);
}

/**
 * Every `<item transform="...">` in a written-out 3MF, as parsed rotateX +
 * translate. The zip's one entry (`3D/3dmodel.model`) is stored (not
 * deflated, see core/zip.ts's own header comment), so its XML text is
 * verbatim, searchable directly in the raw downloaded bytes -- no zip
 * reader needed for a read-only check like this one.
 */
function parseThreeMfItemTransforms(buf: Buffer): Array<{ rotateZ: number; rotateX: number; translate: [number, number, number] }> {
  const text = buf.toString("latin1");
  const matches = [...text.matchAll(/<item[^>]*transform="([^"]+)"/g)];
  expect(matches.length, "at least one <item transform=...> in the 3MF").toBeGreaterThan(0);
  return matches.map((m) => {
    const n = m[1].trim().split(/\s+/).map(Number);
    expect(n).toHaveLength(12);
    // 3MF's own 4x3 row-major matrix (threeMf.ts's `transformAttr`): each row
    // the image of one axis under Rz then Rx -- row 1 starts [-sin z, cos z ...]
    // over row 0's [cos z ...], and row 2 is [0, -sin x, cos x].
    const rotateZ = Math.atan2(-n[3], n[0]);
    const rotateX = Math.atan2(-n[7], n[8]);
    return { rotateZ, rotateX, translate: [n[9], n[10], n[11]] };
  });
}

/** The print-layout view's own exposed per-part transform (CoilViewer.tsx's
 * accessible `print-layout-parts` list), parsed the same shape. */
async function readViewTransforms(page: Page): Promise<Record<string, { rotateZ: number; rotateX: number; translate: [number, number, number] }>> {
  const items = await page.getByTestId("print-layout-parts").locator("li").allTextContents();
  const out: Record<string, { rotateZ: number; rotateX: number; translate: [number, number, number] }> = {};
  for (const line of items) {
    const m = line.match(/^(.+?): rotateZ=(-?[\d.]+), rotateX=(-?[\d.]+), x=(-?[\d.]+)mm, y=(-?[\d.]+)mm, z=(-?[\d.]+)mm$/);
    expect(m, `unrecognized print-layout-parts line: ${line}`).toBeTruthy();
    const [, name, rotateZ, rotateX, x, y, z] = m!;
    out[name] = { rotateZ: Number(rotateZ), rotateX: Number(rotateX), translate: [Number(x), Number(y), Number(z)] };
  }
  return out;
}

test.describe("Print layout view (issue #78)", () => {
  test("the preset sits alongside Front/Iso/Wall mount, unselected by default", async ({ page }) => {
    await gotoDesign(page, ONE_PART);
    await expect(page.getByTestId("preset-printLayout")).toBeVisible();
    await expect(page.getByTestId("preset-printLayout")).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("preset-front")).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("preset-iso")).toHaveAttribute("aria-pressed", "true");
  });

  test("selecting it shows the bed, part names and the no-supports caption, and hides the dimension axes", async ({ page }) => {
    await gotoDesign(page, TWO_PART);
    await expect(page.getByTestId("dimensions")).toHaveCount(1);

    await showPrintLayout(page);
    await expect(page.getByTestId("preset-printLayout")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("wall-view-caption")).toHaveText(/no supports needed/i);
    await expect(page.getByTestId("dimensions")).toHaveCount(0); // issue #78 AC: hidden (or showing the bed size)

    const parts = page.getByTestId("print-layout-parts");
    await expect(parts).toBeVisible();
    await expect(parts.getByTestId("print-layout-part-core")).toBeVisible();
    await expect(parts.getByTestId("print-layout-part-top-cap")).toBeVisible();

    // Back to a standing preset: the caption and the print-layout-only list disappear again.
    await page.getByTestId("preset-iso").click();
    await expect(page.getByTestId("wall-view-caption")).toHaveCount(0);
    await expect(page.getByTestId("print-layout-parts")).toHaveCount(0);
    await expect(page.getByTestId("dimensions")).toHaveCount(1);
  });

  test("the wire/dimensions/exploded toggles (which have no effect here -- both are force-hidden) disappear, and reappear with the user's own settings restored", async ({ page }) => {
    await gotoDesign(page, TWO_PART);
    // Uncheck wire, so its restored state is provably NOT just the default.
    await page.getByTestId("toggle-wire").uncheck();
    await expect(page.getByTestId("toggle-wire")).not.toBeChecked();
    await expect(page.getByTestId("toggle-dimensions")).toBeChecked();
    await expect(page.getByTestId("toggle-exploded")).toBeVisible();

    await showPrintLayout(page);
    await expect(page.getByTestId("toggle-wire")).toHaveCount(0);
    await expect(page.getByTestId("toggle-dimensions")).toHaveCount(0);
    await expect(page.getByTestId("toggle-exploded")).toHaveCount(0);

    await page.getByTestId("preset-iso").click();
    await expect(page.getByTestId("toggle-wire")).not.toBeChecked(); // restored, not reset to the default (checked)
    await expect(page.getByTestId("toggle-dimensions")).toBeChecked();
    await expect(page.getByTestId("toggle-exploded")).toBeVisible();
  });

  test("switching into it changes the render (bed + placed parts, not the assembled coil)", async ({ page }) => {
    await gotoDesign(page, TWO_PART);
    const canvas = page.getByTestId("coil-viewer").locator("canvas");
    const assembled = await canvas.screenshot();
    await showPrintLayout(page);
    const laidOut = await canvas.screenshot();
    expect(laidOut.equals(assembled), "print layout must change the render").toBe(false);
  });

  for (const [label, hash, names] of [
    ["one-part", ONE_PART, ["core"]],
    ["two-part", TWO_PART, ["core", "top-cap"]],
    ["skadis", SKADIS, ["core", "skadis-top-clip-1", "skadis-bottom-clip-1", "skadis-bottom-clip-2"]],
  ] as const) {
    test(`${label} design: view placement matches the 3MF export's own placement (shared function, issue #78 AC)`, async ({ page }) => {
      await gotoDesign(page, hash);
      await showPrintLayout(page);

      const viewTransforms = await readViewTransforms(page);
      expect(Object.keys(viewTransforms).sort()).toEqual([...names].sort());

      const downloadPromise = page.waitForEvent("download");
      await page.getByTestId("download-3mf").click();
      const download = await downloadPromise;
      const path = await download.path();
      expect(path).toBeTruthy();
      const threeMfTransforms = parseThreeMfItemTransforms(readFileSync(path!));
      expect(threeMfTransforms).toHaveLength(names.length);

      // threeMf.ts writes one <object>/<item> per `design.parts`, in that
      // array's own order -- the same order `print-layout-parts` lists them
      // in (both ultimately from the same `printPlacements(parts, bed)`
      // call), so they line up positionally without needing a name
      // attribute on the 3MF item itself (the OBJECT carries the name; the
      // ITEM, which carries the transform, doesn't).
      names.forEach((name, i) => {
        const view = viewTransforms[name];
        const threeMf = threeMfTransforms[i];
        expect(Math.cos(view.rotateZ - threeMf.rotateZ), `${name} rotateZ`).toBeCloseTo(1, 5);
        expect(Math.cos(view.rotateX - threeMf.rotateX), `${name} rotateX`).toBeCloseTo(1, 5);
        expect(view.translate[0], `${name} x`).toBeCloseTo(threeMf.translate[0], 1);
        expect(view.translate[1], `${name} y`).toBeCloseTo(threeMf.translate[1], 1);
        expect(view.translate[2], `${name} z`).toBeCloseTo(threeMf.translate[2], 1);
      });
    });
  }

  // Screenshots (issue #78 AC): one design per test, each a fresh `goto` --
  // a hash-only `page.goto` on the SAME path is a same-document navigation
  // (real browsers never reload for a fragment-only change), so batching
  // several designs' screenshots into one test via repeated `gotoDesign`
  // calls would silently keep rendering the FIRST design throughout.
  for (const [label, hash] of [
    ["one-part", ONE_PART],
    ["two-part", TWO_PART],
    ["skadis", SKADIS],
    ["triangle", TRIANGLE_TWO_PART],
  ] as const) {
    test(`screenshot: ${label} design`, async ({ page }) => {
      await gotoDesign(page, hash);
      await showPrintLayout(page);
      await expect(page.getByTestId("coil-viewer").locator("canvas")).toHaveScreenshot(`print-layout-${label}.png`);
    });
  }

  test("prefers-reduced-motion jumps to the print-layout scene instantly instead of tweening", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await gotoDesign(page, TWO_PART);
    const canvas = page.getByTestId("coil-viewer").locator("canvas");

    await page.getByTestId("preset-printLayout").click();
    await page.waitForTimeout(60);
    const soonAfterClick = await canvas.screenshot();
    await expectSettled(page);
    const settled = await canvas.screenshot();
    expect(soonAfterClick.equals(settled), "reduced motion must already show the settled print-layout view almost immediately").toBe(true);
  });
});
