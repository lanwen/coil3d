import { expect, test } from "@playwright/test";

// This file is specifically ABOUT the camera-framing tween itself (issue
// #72's own AC: "produces exactly one framing tween"), so -- like
// view-controls.spec.ts and top-cap.spec.ts's exploded-view describe block
// -- it opts back into real motion over the suite-wide `reducedMotion:
// "reduce"` default (playwright.config.ts, issue #18/#47's CI landing):
// under reduced motion, LineArtRenderer applies every fit change instantly
// and never runs (or counts) a tween at all, which would make the "exactly
// one tween" assertion below vacuous.
test.use({ contextOptions: { reducedMotion: "no-preference" } });

// `window.__framingTweenCount` is declared as an ambient `Window` property
// only in `src/viewer/lineArt/LineArtRenderer.tsx` (its own test-only
// instrumentation, see that file's doc comment) -- e2e/ is a separate tsc
// project (tsconfig.node.json) from src/ (tsconfig.app.json), so that
// augmentation isn't visible here. This local type stands in for it.
type InstrumentedWindow = Window & { __framingTweenCount?: number };

// Issue #72: a parameter edit used to show the raw draft mesh first, then
// re-render with a camera tween that visibly "grew" the model from the
// draft's own (slightly different) bounds up to the final's -- because the
// old debounce fired a fast draft (60ms) unconditionally on every edit,
// always ahead of the heavier final (400ms). The fix (useDesignPreview.ts)
// keeps the previous FINAL result on screen untouched while an edit is
// still resolving, and LineArtRenderer.tsx additionally never lets a
// non-final geometry drive the camera fit -- so a normal-speed edit goes
// straight from one final mesh/framing to the next, with nothing in
// between. These checks drive the app through a REAL rapid slider drag
// (many native "input" events, well inside the debounce window) rather than
// asserting on a fixed sleep, and read the app's own state (mesh-detail's
// resolution text, LineArtRenderer's tween counter) rather than guessing at
// timings.

const LOCKED = "#v=1&L=1000&d=4&lock=outer,h&size=40&h=40";

test("a rapid drag settles into exactly one framing tween, never shows a draft frame, and the value label updates immediately", async ({ page }) => {
  await page.goto(`/${LOCKED}`);
  await expect(page.getByTestId("download-stl")).toBeEnabled();
  await expect(page.getByTestId("mesh-detail")).toContainText("final");

  const sizeInput = page.getByTestId("input-outer");
  await expect(sizeInput).toHaveValue("40");

  const result = await page.evaluate(async () => {
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    const slider = document.querySelector('input[type="range"][aria-label="Core size"]') as HTMLInputElement;
    const meshDetail = document.querySelector('[data-testid="mesh-detail"]') as HTMLElement;
    const numberInput = document.querySelector('[data-testid="input-outer"]') as HTMLInputElement;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    (window as InstrumentedWindow).__framingTweenCount = 0;

    // Sample the reported mesh resolution every ~15ms for the whole drag
    // plus a generous settle window, so a draft frame -- however briefly
    // shown -- can't hide between two widely-spaced checks.
    const samples: string[] = [];
    let sampling = true;
    const sampleLoop = (async () => {
      while (sampling) {
        samples.push(meshDetail?.textContent ?? "");
        await sleep(15);
      }
    })();

    // A real drag: many intermediate values, ~20ms apart (well under
    // EDIT_DEBOUNCE_MS's 300ms), dispatched as native "input" events the
    // same way a browser's own <input type="range"> fires them continuously
    // while the user drags -- not a single jump straight to the end value.
    const values = [42, 44, 46, 48, 50, 52, 54, 56, 58, 60, 62, 64, 66, 68, 70];
    let midDragValue: string | null = null;
    for (const v of values) {
      nativeSetter.call(slider, String(v));
      slider.dispatchEvent(new Event("input", { bubbles: true }));
      if (v === 48) {
        await sleep(5); // let React re-render before reading
        midDragValue = numberInput.value; // captured mid-drag, well before any debounce fires
      }
      await sleep(20);
    }

    // Settle: EDIT_DEBOUNCE_MS (300ms) + build time + a margin.
    await sleep(2000);
    sampling = false;
    await sampleLoop;

    return { samples, tweenCount: (window as InstrumentedWindow).__framingTweenCount ?? 0, midDragValue, finalValue: numberInput.value };
  });

  // The displayed value tracks the drag immediately -- it's plain React
  // state, never gated on the (debounced) design preview.
  expect(result.midDragValue).toBe("48");
  expect(result.finalValue).toBe("70");

  // No draft frame was ever shown for this normal-speed edit.
  expect(result.samples.some((s) => s.includes("draft")), `mesh-detail samples included a draft frame:\n${result.samples.join("\n")}`).toBe(false);
  expect(result.samples.some((s) => s.includes("final")), "mesh-detail never reported final at all").toBe(true);

  // Exactly one camera-framing tween ran for the whole drag, not one per
  // intermediate value and not a separate one for a draft mesh.
  expect(result.tweenCount).toBe(1);

  // The design itself did settle to the new value (not just the input).
  await expect(page.getByTestId("outer-size")).toContainText("70");
  await expect(page.getByTestId("mesh-detail")).toContainText("final");
});

test("core size and height round to whole millimetres (0.5mm below 20mm) when the user types a value", async ({ page }) => {
  await page.goto(`/${LOCKED}`);
  await expect(page.getByTestId("download-stl")).toBeEnabled();

  const sizeInput = page.getByTestId("input-outer");
  await expect(sizeInput).toHaveAttribute("step", "1");
  await sizeInput.fill("42.83");
  await sizeInput.blur();
  await expect(sizeInput).toHaveValue("43"); // rounds to the nearest 1mm at this size

  const heightInput = page.getByTestId("input-height");
  await expect(heightInput).toHaveAttribute("step", "1");
  await heightInput.fill("7.3");
  await heightInput.blur();
  await expect(heightInput).toHaveValue("7.5"); // small-coil range (<20mm): rounds to the nearest 0.5mm
});
