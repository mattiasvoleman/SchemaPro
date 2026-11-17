import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { scanBothSchemes, setScheme } from "./axe";
import { askForScenario, freezeClock, settle, signIn, watchStubMisses } from "./signed-in";
import { PLACEMENT_WRITE_SCENARIO } from "./stub/fixtures/timplan-board";
import { TEACHERS } from "./stub/fixtures/world";
import { KIND, STUB_ORIGIN, uid } from "./stub/sessions";

/**
 * Förlägg i veckan, a PAIR and the week picked (D2), in a browser.
 *
 * What the page does with a half held, key by key, is page.pair.test.tsx's, in jsdom. What only a browser can say is asked here:
 *
 *   - a pair laid with the keyboard alone: the weeks, a day, a start, a room and the button, twice; the first half is held and
 *     WRITES NOTHING (the stub is asked once, by the second half, for both rows on top of the key that was read);
 *   - the held half is a dashed card that says it is not saved, and Ctrl+Z takes it back without a write;
 *   - leaving by a link asks (the dialog's words), and a no leaves the reader where they were;
 *   - the week picker for a läsår that starts on a SATURDAY (the stub's year is made one): the first week is the Monday after, week
 *     53 and week 1 are both odd, a week picked shows only what runs that week under its own dates, and "Alla veckor" shows both halves;
 *   - at 320 px, 375 px and 1280 px, in both themes, with a wide font: no line of the picker, the pair's fields, the held half's block,
 *     the row or the message reaches past its box (the rectangle of the text, not the element's box), and the page does not scroll
 *     sideways; axe with a half held and with the picker.
 *
 * The stub remembers what it is written, per scenario name (stub/fixtures/timplan-board.ts PLACEMENT_WRITE_SCENARIO): every test names its own.
 */

const PAGE = "/sv/admin/placements";
const MISSES = "the backend stub could not answer these reads; each says which file to add it to or fix";

const VIEWPORTS = [
  { name: "320×700", width: 320, height: 700 },
  { name: "375×812", width: 375, height: 812 },
  { name: "1280×800", width: 1280, height: 800 },
];
const SCHEMES = ["light", "dark"] as const;
const WIDE_FONT = "body, button, input, select { font-family: 'DejaVu Sans Mono', monospace !important }";

/** Svenska 7A (Anna, every week): three lessons, one placed on Tuesday 10:00 in NO-salen; the pair is its second lesson. */
const SVENSKA = uid(KIND.requirement, 1);
const ANNA = TEACHERS.anna.id;
const BRICK = `[data-brick='${SVENSKA}|${ANNA}|60#1']`;
const HELD = "[data-lesson-id^='pairhalf:']";
const cardAt = (page: Page, day: number, start: string, weeks: string) => page.locator(`[data-lesson-id='placement:${SVENSKA}||60|${day}|${start}|${weeks}']`);

const scenarioName = () => `${PLACEMENT_WRITE_SCENARIO}:${randomUUID()}`;

interface Opened {
  misses: string[];
  puts: Array<{ url: string; body: { placements: Array<Record<string, unknown>>; baseKey?: string } }>;
}

async function open(page: Page, baseURL: string, options: { size?: { width: number; height: number }; scheme?: (typeof SCHEMES)[number]; saturday?: boolean } = {}): Promise<Opened> {
  await signIn(page.context(), "admin", baseURL);
  await freezeClock(page);
  await askForScenario(page, scenarioName());
  if (options.saturday) {
    // The stub's läsår starts on a Monday (the Monday before the school year the clock is in); production's starts on a Saturday.
    await page.route(`${STUB_ORIGIN}/rest/v1/AcademicYears*`, async (route) => {
      const response = await route.fetch();
      const rows = (await response.json()) as Array<{ id: string; isActive: boolean; startDate: string; endDate: string }>;
      await route.fulfill({ response, body: JSON.stringify(rows.map((row) => (row.isActive ? { ...row, startDate: "2026-08-15", endDate: "2027-06-11" } : row))) });
    });
  }
  const misses = watchStubMisses(page);
  const puts: Opened["puts"] = [];
  page.on("request", (request) => {
    if (request.method() === "PUT" && request.url().startsWith(STUB_ORIGIN) && request.url().endsWith("/placements")) {
      puts.push({ url: request.url(), body: JSON.parse(request.postData() ?? "{}") });
    }
  });
  await page.setViewportSize(options.size ?? { width: 1280, height: 1600 });
  await page.goto(PAGE);
  await settle(page);
  await setScheme(page, options.scheme ?? "light", true);
  await expect(page.getByRole("heading", { level: 1, name: "Förlägg i veckan" })).toBeVisible();
  return { misses, puts };
}

const columns = (page: Page) => page.locator("[data-writes-inert='SCHEMALAGGNING DRIFT']");

/** A press on a day column at a time (1.1 px a minute from 08:00). */
async function pressWeek(page: Page, day: number, hour: number, minute = 0) {
  const column = columns(page).nth(day - 1);
  await column.scrollIntoViewIfNeeded();
  await column.click({ position: { x: 20, y: (hour * 60 + minute - 480) * 1.1 + 4 } });
}

/** The brick chosen, the weeks and the room picked: the row is ready for the first half. */
async function readyPair(page: Page, weeks: "ODD_WEEKS" | "EVEN_WEEKS") {
  await page.locator(BRICK).click();
  const row = page.getByTestId("lay-row");
  await expect(row).toBeVisible();
  await row.getByRole("combobox", { name: "Veckor" }).selectOption(weeks);
  await row.getByLabel("Sal").selectOption({ label: "NO-salen" });
  return row;
}

/** Text that cannot be seen is not measured; every other line of text must lie inside the box it stands in. */
function measure(page: Page, selector: string) {
  return page.evaluate((boxSelector) => {
    const EPS = 0.5;
    const problems: string[] = [];
    for (const box of document.querySelectorAll(boxSelector)) {
      const outer = box.getBoundingClientRect();
      const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node as Text;
        if (!text.data.trim() || text.parentElement?.closest(".sr-only")) continue;
        const range = document.createRange();
        range.selectNodeContents(text);
        for (const rect of range.getClientRects()) {
          if (rect.width > 0 && (rect.left < outer.left - EPS || rect.right > outer.right + EPS)) {
            problems.push(`text past its box sideways: "${text.data.trim().slice(0, 40)}" ${Math.round(rect.left)}–${Math.round(rect.right)} in ${Math.round(outer.left)}–${Math.round(outer.right)}`);
          }
        }
      }
      if (box.scrollWidth > box.clientWidth + 1) problems.push(`a box scrolls sideways: ${(box.textContent ?? "").trim().slice(0, 40)}`);
    }
    return { problems, pageScrollsSideways: document.documentElement.scrollWidth > window.innerWidth };
  }, selector);
}

const BOXES = "#placement-to-lay, [data-testid='lay-row'], [data-testid='pair-fields'], [data-testid='pair-held'], [data-testid='week-picker'], [data-testid='placement-message'], [data-testid='placement-status']";

test.describe("a pair laid half by half", () => {
  test("with the keyboard alone: the first half is held and writes nothing, the second writes both in one PUT on the key that was read", async ({ page, baseURL }) => {
    const { puts, misses } = await open(page, baseURL!);
    await page.locator(BRICK).focus();
    await page.keyboard.press("Enter");
    const row = page.getByTestId("lay-row");
    await expect(row.getByLabel("Dag")).toBeFocused();
    // The weeks: a select is set by its value (its arrow keys are the platform's).
    await row.getByRole("combobox", { name: "Veckor" }).selectOption("ODD_WEEKS");
    // The post's other lesson stands in NO-salen, which is offered; leaving the room to the engine is no choice for a half: the button waits, and the sentence says why.
    await row.getByLabel("Sal").selectOption("");
    await expect(row.getByTestId("place-verdict")).toContainText("Ett par behöver en sal på båda halvorna.");
    await expect(row.getByRole("button", { name: "Lägg första halvan" })).toBeDisabled();
    await row.getByLabel("Sal").selectOption({ label: "NO-salen" });
    await row.getByLabel("Dag").selectOption("3");
    await row.getByLabel("Starttid").focus();
    await page.keyboard.type("0900");
    await row.getByRole("button", { name: "Lägg första halvan" }).focus();
    await page.keyboard.press("Enter");

    // Held: a dashed card that says it is not saved, a block that says what to do, and NOTHING written.
    const held = page.locator(HELD);
    await expect(held).toBeVisible();
    await expect(held).toContainText("udda veckor · inte sparad");
    await expect(held).toHaveCSS("outline-style", "dashed");
    await expect(page.getByTestId("pair-held")).toContainText("Första halvan ligger inte sparad");
    await expect(page.getByTestId("placement-status")).toContainText("Första halvan (udda veckor)");
    expect(puts).toHaveLength(0);

    // The fields are the second half's now, with the keyboard on the day and the same room.
    await expect(row.getByLabel("Dag")).toBeFocused();
    await expect(row.getByLabel("Sal")).toHaveValue(/^[0-9a-f-]{36}$/);
    await row.getByLabel("Dag").selectOption("5");
    await row.getByLabel("Starttid").focus();
    await page.keyboard.type("1015");
    await row.getByRole("button", { name: "Lägg andra halvan och spara paret" }).focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => puts.length).toBe(1);
    expect(puts[0]!.body.baseKey).toBe("k000000000000001");
    expect(puts[0]!.body.placements).toHaveLength(3);
    expect(puts[0]!.body.placements[1]).toMatchObject({ dayOfWeek: 3, startTime: "09:00", minutes: 60, recurrence: "ODD_WEEKS" });
    expect(puts[0]!.body.placements[2]).toMatchObject({ dayOfWeek: 5, startTime: "10:15", minutes: 60, recurrence: "EVEN_WEEKS" });
    expect(puts[0]!.body.placements[1]!["roomId"]).toBe(puts[0]!.body.placements[2]!["roomId"]);

    // Both are cards now, the half is gone, the keyboard is on the second card, and the pair is said as a pair.
    await expect(cardAt(page, 3, "09:00", "ODD_WEEKS")).toBeVisible();
    await expect(cardAt(page, 5, "10:15", "EVEN_WEEKS")).toBeFocused();
    await expect(held).toHaveCount(0);
    await expect(page.getByTestId("placement-status")).toContainText("som par");
    await expect(page.getByTestId("placement-status")).toContainText("udda veckor Onsdag 09:00–10:00");
    expect(misses, MISSES).toEqual([]);
  });

  test("with the mouse: choose the brick and the weeks, press a time for each half; the held half is let go with its button and writes nothing", async ({ page, baseURL }) => {
    const { puts, misses } = await open(page, baseURL!);
    await readyPair(page, "EVEN_WEEKS");
    // Thursday 10:00: Thursday 13:15 is 7A's other lesson (Matematik), which the class cannot be in two places for.
    await pressWeek(page, 4, 10);
    const held = page.locator(HELD);
    await expect(held).toContainText("jämna veckor · inte sparad");
    expect(puts).toHaveLength(0);
    await page.getByRole("button", { name: "Släpp halvan" }).click();
    await expect(held).toHaveCount(0);
    await expect(page.getByTestId("placement-status")).toContainText("Släppte halvan. Ingenting var sparat.");
    expect(puts).toHaveLength(0);
    // Again, and now to the end: the even half first, so the pair's rows are the even half and then the odd.
    await readyPair(page, "EVEN_WEEKS");
    await pressWeek(page, 4, 10);
    await expect(held).toBeVisible();
    await pressWeek(page, 1, 10);
    await expect.poll(() => puts.length).toBe(1);
    expect(puts[0]!.body.placements.slice(1).map((entry) => [entry["dayOfWeek"], entry["startTime"], entry["recurrence"]])).toEqual([
      [4, "10:00", "EVEN_WEEKS"],
      [1, "10:00", "ODD_WEEKS"],
    ]);
    await expect(cardAt(page, 1, "10:00", "ODD_WEEKS")).toBeVisible();
    await expect(cardAt(page, 4, "10:00", "EVEN_WEEKS")).toBeVisible();
    expect(misses, MISSES).toEqual([]);
  });

  test("Ctrl+Z takes the held half back before any written step, and writes nothing", async ({ page, baseURL }) => {
    const { puts } = await open(page, baseURL!);
    await readyPair(page, "ODD_WEEKS");
    await pressWeek(page, 3, 9);
    await expect(page.locator(HELD)).toBeVisible();
    await page.locator("body").click({ position: { x: 2, y: 2 } });
    await page.keyboard.press("Control+z");
    await expect(page.locator(HELD)).toHaveCount(0);
    await expect(page.getByTestId("placement-status")).toContainText("Tog tillbaka halvan. Ingenting var sparat.");
    expect(puts).toHaveLength(0);
  });

  test("a link inside the app asks before it is followed with a half held, and a no leaves the reader where they were", async ({ page, baseURL }) => {
    const { puts } = await open(page, baseURL!);
    await readyPair(page, "ODD_WEEKS");
    await pressWeek(page, 3, 9);
    await expect(page.locator(HELD)).toBeVisible();
    const asked: string[] = [];
    page.once("dialog", async (dialog) => {
      asked.push(dialog.message());
      await dialog.dismiss();
    });
    await page.locator("a[data-writes='SCHEMALAGGNING']").click();
    await expect.poll(() => asked.length).toBe(1);
    expect(asked[0]).toBe("Du har en halv lektion som inte är sparad. Lämna sidan ändå?");
    expect(new URL(page.url()).pathname).toBe(PAGE);
    await expect(page.locator(HELD)).toBeVisible();
    expect(puts).toHaveLength(0);
  });
});

test.describe("the week picker, for a läsår that starts on a Saturday", () => {
  test("starts on the Monday after, has week 53 and week 1 as two odd weeks, and shows a week with its own dates and the lessons that run it", async ({ page, baseURL }) => {
    const { puts, misses } = await open(page, baseURL!, { saturday: true });
    const picker = page.getByTestId("week-picker");
    const select = picker.getByRole("combobox");
    const options = select.locator("option");
    await expect(options.nth(0)).toHaveText("Alla veckor");
    // The week that holds the Saturday (10–14 August) is not one: the first is week 34, from Monday the 17th.
    await expect(options.nth(1)).toHaveText("v. 34 · 17 aug.–21 aug. · jämna (B)");
    await expect(select.locator("option", { hasText: "10 aug." })).toHaveCount(0);
    await expect(select.locator("option", { hasText: /^v\. 53 · .* · udda \(A\)$/ })).toHaveCount(1);
    await expect(select.locator("option", { hasText: /^v\. 1 · .* · udda \(A\)$/ })).toHaveCount(1);
    await expect(picker.getByTestId("week-picker-status")).toContainText("Visar alla veckor");

    // A pair laid first: odd weeks Wednesday 09:00, even weeks Friday 10:15.
    await readyPair(page, "ODD_WEEKS");
    await pressWeek(page, 3, 9);
    await expect(page.locator(HELD)).toBeVisible();
    await pressWeek(page, 5, 10, 15);
    await expect.poll(() => puts.length).toBe(1);
    const odd = cardAt(page, 3, "09:00", "ODD_WEEKS");
    const even = cardAt(page, 5, "10:15", "EVEN_WEEKS");
    await expect(odd).toBeVisible();
    await expect(even).toBeVisible();
    // Every card says its weeks.
    await expect(odd).toContainText("udda");
    await expect(even).toContainText("jämna");

    // An odd week: the odd half only, and its dates under the days.
    await select.selectOption("2026-08-24");
    await expect(picker.getByTestId("week-picker-status")).toContainText("Visar vecka 35, 24 aug.–28 aug., udda (A).");
    await expect(odd).toBeVisible();
    await expect(even).toHaveCount(0);
    for (const date of ["24/8", "25/8", "26/8", "27/8", "28/8"]) await expect(page.getByText(date, { exact: true })).toBeVisible();
    // An even week: the other.
    await select.selectOption("2026-08-17");
    await expect(odd).toHaveCount(0);
    await expect(even).toBeVisible();
    await expect(page.getByText("17/8", { exact: true })).toBeVisible();
    // The turn of the year: week 53 and week 1 are both odd, so the odd half stands in both, and the dates cross into January.
    await select.selectOption("2026-12-28");
    await expect(odd).toBeVisible();
    await expect(even).toHaveCount(0);
    await expect(page.getByText("1/1", { exact: true })).toBeVisible();
    await select.selectOption("2027-01-04");
    await expect(picker.getByTestId("week-picker-status")).toContainText("Visar vecka 1");
    await expect(odd).toBeVisible();
    await expect(even).toHaveCount(0);
    await select.selectOption("2027-01-11");
    await expect(odd).toHaveCount(0);
    await expect(even).toBeVisible();
    // Every week again: both halves.
    await select.selectOption("");
    await expect(odd).toBeVisible();
    await expect(even).toBeVisible();
    // The figures and the lists are the year's, whatever week is shown.
    await expect(page.getByTestId("placement-summary")).toBeVisible();
    expect(misses, MISSES).toEqual([]);
  });

  test("steps with the buttons, and the half being laid follows the week to a week of its own parity", async ({ page, baseURL }) => {
    const { puts } = await open(page, baseURL!, { saturday: true });
    const picker = page.getByTestId("week-picker");
    const select = picker.getByRole("combobox");
    await picker.getByRole("button", { name: "Nästa vecka" }).click();
    await expect(select).toHaveValue("2026-08-17");
    await expect(picker.getByRole("button", { name: "Föregående vecka" })).toBeDisabled();
    await picker.getByRole("button", { name: "Nästa vecka" }).click();
    await expect(select).toHaveValue("2026-08-24");
    // Week 35 is odd. A pair that starts with the EVEN weeks is laid looking at an even week: 36.
    await page.locator(BRICK).click();
    await page.getByTestId("lay-row").getByRole("combobox", { name: "Veckor" }).selectOption("EVEN_WEEKS");
    await expect(select).toHaveValue("2026-08-31");
    await page.getByTestId("lay-row").getByLabel("Sal").selectOption({ label: "NO-salen" });
    await pressWeek(page, 4, 10);
    await expect(page.locator(HELD)).toBeVisible();
    // And the second half, which is odd, is laid looking at an odd week: 37.
    await expect(select).toHaveValue("2026-09-07");
    await expect(page.getByTestId("placement-status")).toContainText("Visar nu vecka 37 (udda (A)), för den andra halvan.");
    expect(puts).toHaveLength(0);
  });
});

for (const size of VIEWPORTS) {
  for (const scheme of SCHEMES) {
    test(`at ${size.name}, ${scheme}: the picker, the pair's fields and the held half stay inside their boxes, with a wide font too`, async ({ page, baseURL }) => {
      const { misses } = await open(page, baseURL!, { size, scheme, saturday: true });
      await page.addStyleTag({ content: WIDE_FONT });
      let facts = await measure(page, BOXES);
      expect(facts.problems, "the picker").toEqual([]);
      expect(facts.pageScrollsSideways, "the page scrolls sideways").toBe(false);
      await page.getByTestId("week-picker").getByRole("combobox").selectOption("2026-08-24");
      await readyPair(page, "ODD_WEEKS");
      facts = await measure(page, BOXES);
      expect(facts.problems, "the row with the pair's choice").toEqual([]);
      await pressWeek(page, 3, 9);
      await expect(page.locator(HELD)).toBeVisible();
      facts = await measure(page, BOXES);
      expect(facts.problems, "the held half's block and the message").toEqual([]);
      expect(facts.pageScrollsSideways, "the page scrolls sideways with a half held").toBe(false);
      // The held card is on the week, and a card of the week is not wider than its column.
      const box = await page.locator(HELD).boundingBox();
      expect(box, "the held half has a box").not.toBeNull();
      expect(misses, MISSES).toEqual([]);
    });
  }
}

test.describe("axe", () => {
  test("the picker and a half held: no violation in either theme, at a phone's width", async ({ page, baseURL }) => {
    const { misses } = await open(page, baseURL!, { size: { width: 375, height: 812 }, saturday: true });
    let reports = await scanBothSchemes(page, "placements-picker", true);
    expect(reports, reports.join("\n")).toEqual([]);
    await page.getByTestId("week-picker").getByRole("combobox").selectOption("2026-08-24");
    await readyPair(page, "ODD_WEEKS");
    await pressWeek(page, 3, 9);
    await expect(page.locator(HELD)).toBeVisible();
    reports = await scanBothSchemes(page, "placements-held-half", true);
    expect(reports, reports.join("\n")).toEqual([]);
    expect(misses, MISSES).toEqual([]);
  });
});
