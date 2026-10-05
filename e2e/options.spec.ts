import { expect, test, type Page } from "@playwright/test";
import { decodeHashDoc } from "./hashDoc";

// Issue #192: the result panel shows only the essentials, and each solver
// alternative is a card you can pick. Picking renders it (design + hash), a
// shared link reproduces it, and the card says exactly what picking builds.

const link = (doc: Record<string, unknown>) => `/#s=${Buffer.from(JSON.stringify({ v: 2, ...doc })).toString("base64url")}`;

/** Core size locked, height and layers free: two options, one per objective. */
const TWO_FREE = link({ lock: ["outer"], size: 60 });
/** Nothing locked: one option per layer count. */
const THREE_FREE = link({ lock: [] });

/** A fresh page load of `url` (the app reads the hash once, on load, so a hash-only goto wouldn't reload it). */
async function open(page: Page, url: string) {
  await page.goto("about:blank");
  await page.goto(url);
}

/** Waits for the FINAL mesh of whatever the page shows now (AGENTS.md: never a fixed sleep). */
async function settled(page: Page) {
  await expect(page.getByTestId("download-stl")).toBeEnabled({ timeout: 30_000 });
}

/** Waits until the shown design is the one for the current spec: its final mesh, after the summary size reads `size`. */
async function shows(page: Page, size: string) {
  await expect(page.getByTestId("fact-size")).toHaveText(size, { timeout: 30_000 });
  await settled(page);
  await expect(page.getByTestId("fact-size")).toHaveText(size);
}

const options = (page: Page) => page.getByTestId("options").getByRole("radio");
const card = (page: Page, title: string) => page.getByTestId("options").locator("label", { has: page.getByRole("radio", { name: title, exact: true }) });

test.describe("two free dimensions: Smallest / Even proportions", () => {
  test("picking a card renders it and stores it in the link; the other card goes back", async ({ page }) => {
    await page.goto(TWO_FREE);
    await settled(page);
    await expect(options(page)).toHaveCount(2);
    await expect(page.getByRole("radio", { name: "Smallest" })).toBeChecked();
    const smallestSize = await page.getByTestId("fact-size").textContent();
    const evenSize = (await card(page, "Even proportions").locator('[data-testid^="option-size-"]').textContent())!;
    expect(evenSize).not.toBe(smallestSize);
    expect(decodeHashDoc(page.url()).obj).toBeUndefined();

    await page.getByRole("radio", { name: "Even proportions" }).check();
    await shows(page, evenSize);
    await expect(page.getByRole("radio", { name: "Even proportions" })).toBeChecked();
    await expect(card(page, "Even proportions")).toHaveAttribute("data-active", "true");
    await expect(card(page, "Even proportions")).toContainText("showing");
    // The card it came from now describes how it differs from what's shown.
    await expect(card(page, "Smallest")).toContainText(smallestSize!);
    await expect.poll(() => decodeHashDoc(page.url()).obj).toBe("ar");

    // The link reproduces it.
    await open(page, page.url());
    await shows(page, evenSize);
    await expect(page.getByRole("radio", { name: "Even proportions" })).toBeChecked();

    // And the other card is the way back.
    await page.getByRole("radio", { name: "Smallest" }).check();
    await shows(page, smallestSize!);
    await expect.poll(() => decodeHashDoc(page.url()).obj).toBeUndefined();
  });

  test("the keyboard moves between the cards and renders each", async ({ page }) => {
    await page.goto(TWO_FREE);
    await settled(page);
    const evenSize = (await card(page, "Even proportions").locator('[data-testid^="option-size-"]').textContent())!;
    const smallest = page.getByRole("radio", { name: "Smallest" });
    await smallest.focus();
    await expect(smallest).toBeFocused();

    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("radio", { name: "Even proportions" })).toBeChecked();
    await expect(page.getByRole("radio", { name: "Even proportions" })).toBeFocused();
    await shows(page, evenSize);
    await expect.poll(() => decodeHashDoc(page.url()).obj).toBe("ar");

    await page.keyboard.press("ArrowUp");
    await expect(smallest).toBeChecked();
    await expect.poll(() => decodeHashDoc(page.url()).obj).toBeUndefined();
  });
});

test.describe("three free dimensions: one card per layer count", () => {
  test("every card builds exactly the size it shows, keeps it in the link, and can go back", async ({ page }) => {
    await page.goto(THREE_FREE);
    await settled(page);
    const count = await options(page).count();
    expect(count).toBeGreaterThanOrEqual(3);
    const titles = await page.getByTestId("options").locator('[data-testid^="option-title-"]').allTextContents();
    const sizes = await page.getByTestId("options").locator('[data-testid^="option-size-"]').allTextContents();
    const activeIndex = await options(page).evaluateAll((radios) => radios.findIndex((r) => (r as HTMLInputElement).checked));
    const startSize = sizes[activeIndex];

    let picked = 0;
    for (let i = 0; i < count; i++) {
      if (i === activeIndex) continue;
      await open(page, THREE_FREE);
      await settled(page);
      await page.getByRole("radio", { name: titles[i], exact: true }).check();
      // The built design is the card's size, exactly as the card wrote it.
      await shows(page, sizes[i]);
      await expect(page.getByTestId("input-layers")).toHaveValue(titles[i].split(" ")[0]);
      const doc = decodeHashDoc(page.url());
      expect(doc.lock).toEqual(expect.arrayContaining(["h", "ly"]));
      // Layers and height locked to the card's values (1 layer is the default, so the link leaves `ly` out).
      expect(doc.ly ?? 1).toBe(Number(titles[i].split(" ")[0]));
      expect(typeof doc.h).toBe("number");

      // The link alone reproduces it.
      await open(page, page.url());
      await shows(page, sizes[i]);
      picked++;
    }
    expect(picked).toBe(count - 1);

    // Back to all options (this session only): the cards return, as they were.
    await open(page, THREE_FREE);
    await settled(page);
    const other = titles.find((_, i) => i !== activeIndex)!;
    await page.getByRole("radio", { name: other, exact: true }).check();
    await expect(page.getByTestId("option-back")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("option-back").click();
    await shows(page, startSize);
    await expect(options(page)).toHaveCount(count);
    await expect.poll(() => decodeHashDoc(page.url()).lock).toEqual([]);
  });
});

test("the objective picker is gone from Advanced settings", async ({ page }) => {
  await page.goto(TWO_FREE);
  await settled(page);
  await page.locator("details.advanced summary").click();
  await expect(page.getByTestId("input-windingQuality")).toBeVisible();
  await expect(page.getByTestId("select-objective")).toHaveCount(0);
});

test.describe("the summary shows only what matters before printing", () => {
  test("a design that fits: a ready verdict, size and parts, notes kept under All numbers", async ({ page }) => {
    await page.goto("/");
    await settled(page);
    await expect(page.getByTestId("verdict")).toHaveAttribute("data-tone", "good");
    await expect(page.getByTestId("verdict-title")).toHaveText("Holds your 200 cm cable");
    await expect(page.getByTestId("bed-fit")).toHaveText("fits your bed");
    await expect(page.getByTestId("fact-parts")).toHaveText("1 part");
    await expect(page.getByTestId("problems")).toHaveCount(0);
    // The full numbers and the automatic-adjustment note stay available, collapsed.
    await expect(page.getByTestId("outer-size")).toBeHidden();
    await expect(page.getByTestId("warnings")).toBeHidden();
    await page.getByTestId("all-numbers").locator("summary").click();
    await expect(page.getByTestId("outer-size")).toHaveText("34.4 mm");
    await expect(page.getByTestId("warnings")).toContainText("Core size raised from 30.0 mm to 34.4 mm");
  });

  test("problems are listed in plain words, in cm, and the bed chip says it's too big", async ({ page }) => {
    await page.goto(link({ L: 6000, label: "Garage extension", bx: 220, by: 220, bz: 180 }));
    await settled(page);
    await expect(page.getByTestId("verdict")).toHaveAttribute("data-tone", "warn");
    await expect(page.getByTestId("bed-fit")).toHaveText("too big for your bed");
    const problems = page.getByTestId("problems");
    await expect(problems).toContainText(/The core is [\d.]+ cm tall; your printer fits 18 cm\./);
    await expect(problems).toContainText('The label "Garage extension" needs a top cap');
    await expect(problems).not.toContainText("Flange margin increased");
  });

  test("a cable that won't fit says so first", async ({ page }) => {
    await page.goto(link({ L: 10000 }));
    await settled(page);
    await expect(page.getByTestId("verdict")).toHaveAttribute("data-tone", "bad");
    await expect(page.getByTestId("verdict-title")).toHaveText("Your 1000 cm cable won't fit");
  });

  // Issue #199: a 15 cm stiff cable on a locked 80 mm core, one layer, height
  // free. One turn already holds 25 cm (and the inner end in the bore, the rest). The cable fits, so the headline says
  // so, and a note under All numbers names the lock that forces the extra room.
  test("a coil the locks make bigger than needed still holds the cable", async ({ page }) => {
    await page.goto(link({ L: 150, d: 3.6, wt: "stiff", lock: ["outer", "ly"], size: 80, ly: 1 }));
    await settled(page);
    await expect(page.getByTestId("verdict")).toHaveAttribute("data-tone", "good");
    await expect(page.getByTestId("verdict-title")).toHaveText("Holds your 15 cm cable");
    await expect(page.getByTestId("verdict")).toContainText(/\d+% more than you need/);
    await expect(page.getByTestId("problems")).toHaveCount(0);
    await page.getByTestId("all-numbers").locator("summary").click();
    await expect(page.getByTestId("diagnosis-status")).toHaveText("ok");
    await expect(page.getByTestId("warnings").locator("li", { hasText: "because of the locked core size (80 mm)" })).toHaveAttribute("data-severity", "note");
  });
});
