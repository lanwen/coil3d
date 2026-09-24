import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

// STEP export (issue #11): replicad (OpenCascade WASM) must load lazily,
// in a Worker, only once the user clicks "Download STEP" — never on
// initial page load (docs/research.md "STEP export", S2 RESULT.md).

test("replicad's WASM is not requested on initial load, only after Download STEP is clicked", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (req) => requests.push(req.url()));
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  await page.goto("/#v=1&L=1000&d=4&size=40");
  await expect(page.getByTestId("download-step")).toBeVisible();
  // Give any stray background fetches a moment to show up before we snapshot.
  await page.waitForTimeout(300);

  const requestsBeforeClick = [...requests];
  expect(
    requestsBeforeClick.some((url) => url.includes("replicad")),
    `replicad was requested before the STEP button was clicked:\n${requestsBeforeClick.join("\n")}`,
  ).toBe(false);

  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("download-step").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("coil.step");

  const path = await download.path();
  expect(path).toBeTruthy();
  const buf = readFileSync(path!);
  expect(buf.byteLength).toBeGreaterThan(0);
  // STEP (ISO 10303-21) files start with this exact header line.
  expect(buf.toString("utf8", 0, 20)).toContain("ISO-10303-21");

  expect(
    requests.some((url) => url.includes("replicad") && url.endsWith(".wasm")),
    `replicad's WASM was never fetched after clicking Download STEP:\n${requests.join("\n")}`,
  ).toBe(true);

  expect(consoleErrors, `unexpected console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
});
