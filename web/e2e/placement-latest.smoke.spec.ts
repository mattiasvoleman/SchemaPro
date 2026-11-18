import { expect, test, type Page } from "@playwright/test";
import { scanBothSchemes } from "./axe";
import { askForScenario, freezeClock, settle, signIn, watchStubMisses } from "./signed-in";
import { PLACEMENT_WEEK_SCENARIO } from "./stub/fixtures/timplan-board";

/**
 * Förlägg i veckan, "Visa senaste schemat" in a browser: the lessons the last Generera laid, drawn pale behind the week for the class that is
 * picked. What jsdom cannot say: the pale lessons are where their time is and beside each other when they are parallel, they take no pointer
 * from the week (a click on the empty slot beneath one still lays a lesson there), nothing is cut or sticks out at a phone's width, and
 * axe finds nothing in either theme with the layer on.
 *
 * The world's scenario (timplan-board.ts) has Svenska 7A placed on Tuesday 10:00; the latest schedule (latestOfYear) has a lesson there too
 * (both show), a Monday and a Wednesday lesson in free hours, and two lessons at Thursday 08:00.
 */

const PAGE = "/sv/admin/placements";
const MISSES = "the backend stub could not answer these reads; each says which file to add it to or fix";

async function openWithLayer(page: Page, baseURL: string, size: { width: number; height: number }) {
  await signIn(page.context(), "admin", baseURL);
  await freezeClock(page);
  await askForScenario(page, PLACEMENT_WEEK_SCENARIO);
  const misses = watchStubMisses(page);
  await page.setViewportSize(size);
  await page.goto(PAGE);
  await settle(page);
  await expect(page.getByRole("heading", { level: 1, name: "Förlägg i veckan" })).toBeVisible();
  await page.getByRole("checkbox", { name: "Visa senaste schemat" }).check();
  await page.getByRole("button", { name: /Grupper/ }).click();
  await page.getByRole("menuitemcheckbox", { name: "7A", exact: true }).click();
  await page.keyboard.press("Escape");
  return misses;
}

test("Visa senaste schemat: says what to pick, then draws the class's lessons pale, parallel ones side by side", async ({ page, baseURL }) => {
  await signIn(page.context(), "admin", baseURL!);
  await freezeClock(page);
  await askForScenario(page, PLACEMENT_WEEK_SCENARIO);
  const misses = watchStubMisses(page);
  await page.goto(PAGE);
  await settle(page);
  const sw = page.getByRole("checkbox", { name: "Visa senaste schemat" });
  await expect(sw).not.toBeChecked();
  await expect(page.getByTestId("placement-ghost")).toHaveCount(0);
  await sw.check();
  await expect(page.getByTestId("placement-latest-said")).toHaveText("Välj en klass, en lärare eller en sal för att se det senaste schemat.");
  await page.getByRole("button", { name: /Grupper/ }).click();
  await page.getByRole("menuitemcheckbox", { name: "7A", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("placement-ghost")).toHaveCount(5);
  await expect(page.getByTestId("placement-latest-said")).toHaveText("5 lektioner ur det senaste schemat visas bleka.");

  // Two lessons at Thursday 08:00 stand side by side, each in half the column, and the lessons of the other days keep the whole of theirs.
  const boxes = await page.getByTestId("placement-ghost").evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      const column = element.parentElement!.getBoundingClientRect();
      return { label: element.getAttribute("aria-label") ?? "", top: rect.top, left: rect.left - column.left, width: rect.width, column: column.width };
    }),
  );
  const thursday = boxes.filter((box) => box.label.includes("08:00–09:00"));
  expect(thursday).toHaveLength(2);
  expect(thursday[0]!.top).toBeCloseTo(thursday[1]!.top, 0);
  expect(thursday[0]!.width).toBeLessThan(thursday[0]!.column * 0.55);
  expect(thursday[1]!.left).toBeGreaterThan(thursday[0]!.left + thursday[0]!.width / 2);
  const monday = boxes.find((box) => box.label.includes("09:15–10:15"))!;
  expect(monday.width).toBeGreaterThan(monday.column * 0.9);

  // Off again: the week is as it was.
  await sw.uncheck();
  await expect(page.getByTestId("placement-ghost")).toHaveCount(0);
  expect(misses, MISSES).toEqual([]);
});

test("Visa senaste schemat: the pale lessons take no pointer, and a placed card stands on a pale lesson with both showing", async ({ page, baseURL }) => {
  const misses = await openWithLayer(page, baseURL!, { width: 1280, height: 800 });
  await expect(page.getByTestId("placement-ghost")).toHaveCount(5);
  // The pale lessons take no pointer: the element at the centre of one is the column, not the lesson (the grid's own slot click depends on it).
  const hit = await page.getByTestId("placement-ghost").first().evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const atCentre = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return { onTheLesson: element.contains(atCentre), pointerEvents: getComputedStyle(element).pointerEvents };
  });
  expect(hit).toEqual({ onTheLesson: false, pointerEvents: "none" });
  // The scenario's placed Svenska 7A on Tuesday 10:00 is a card of its own, and the pale lesson under it is still drawn.
  await expect(page.locator("[data-lesson-id^='placement:']").first()).toBeVisible();
  expect(misses, MISSES).toEqual([]);
});

for (const size of [
  { name: "320×700", width: 320, height: 700 },
  { name: "375×812", width: 375, height: 812 },
  { name: "1280×800", width: 1280, height: 800 },
]) {
  test(`Visa senaste schemat at ${size.name}: the page does not scroll sideways, and no lesson of the layer reaches past its column`, async ({ page, baseURL }) => {
    const misses = await openWithLayer(page, baseURL!, size);
    await expect(page.getByTestId("placement-ghost")).toHaveCount(5);
    const out = await page.evaluate(() => {
      const root = document.documentElement;
      const stray = [...document.querySelectorAll<HTMLElement>("[data-testid=placement-ghost]")].filter((element) => {
        const rect = element.getBoundingClientRect();
        const column = element.parentElement!.getBoundingClientRect();
        return rect.left < column.left - 1 || rect.right > column.right + 1;
      }).length;
      return { sideways: root.scrollWidth > root.clientWidth, stray };
    });
    expect(out).toEqual({ sideways: false, stray: 0 });
    expect(misses, MISSES).toEqual([]);
  });
}

test("Visa senaste schemat: no automated accessibility violation in either theme with the layer on, at a phone's width", async ({ page, baseURL }) => {
  const misses = await openWithLayer(page, baseURL!, { width: 375, height: 812 });
  await expect(page.getByTestId("placement-ghost")).toHaveCount(5);
  await page.evaluate(() => window.scrollTo(0, 0));
  const reports = await scanBothSchemes(page, "placements-latest", true);
  expect(reports, reports.join("\n")).toEqual([]);
  expect(misses, MISSES).toEqual([]);
});
