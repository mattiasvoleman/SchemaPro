import { expect, test, type Page } from "@playwright/test";
import { scanBothSchemes, setScheme } from "./axe";
import { askForScenario, freezeClock, settle, signIn, watchStubMisses } from "./signed-in";
import { PLACEMENT_WEEK_SCENARIO } from "./stub/fixtures/timplan-board";
import { STUB_ORIGIN } from "./stub/sessions";
import { SUBJECTS, TEACHERS } from "./stub/fixtures/world";

/**
 * Förlägg i veckan, where its text and its boxes stand.
 *
 * What the page makes of the gateway's answer (the figures, the verdicts, the
 * filters, the cards) is page.test.tsx's, in jsdom. jsdom has no layout, so
 * what is asked here is what only a browser can say, at a phone's width and a
 * desk's, in both themes, with a long name and with a wide font:
 *
 *   - the page does not scroll sideways; the week scrolls inside its own box;
 *   - no line of the list, the summary or the notice about a row that no longer
 *     holds reaches past the box it stands in, measured by the rectangle of the
 *     text itself (a Range) and not by an element's box, because a parent that
 *     clips hides a name that is cut;
 *   - no line of a card in the week is cut across its height (the grid drops a
 *     line that does not fit, and a half-letter would be a fault; a long line
 *     is shortened with an ellipsis on purpose, and its whole text is on the
 *     card's title);
 *   - the day is drawn to 18:00 (the strips) when nothing else reaches it, and
 *     to the last row when something does.
 *
 * The scenario (e2e/stub/fixtures/timplan-board.ts) places three rows (one that
 * does not hold, one on Friday 17:00–18:00), keeps one lesson and one meal.
 */

const PAGE = "/sv/admin/placements";
const MISSES = "the backend stub could not answer these reads; each says which file to add it to or fix";

const VIEWPORTS = [
  { name: "320×700", width: 320, height: 700 },
  { name: "375×812", width: 375, height: 812 },
  { name: "1280×800", width: 1280, height: 800 },
];
const SCHEMES = ["light", "dark"] as const;

const LONG_SUBJECT = "Samhällsorienterande ämnen med ett mycket långt namn för övning";
const LONG_SURNAME = "Långefternamnsson-Mycketlångaefternamnsdotter";

/** The wide font of the CI runner's kind: every text measured in it is wider than on this Mac. */
const WIDE_FONT = "body, button, input, select { font-family: 'DejaVu Sans Mono', monospace !important }";

async function open(page: Page, baseURL: string, size: { width: number; height: number }, scheme: (typeof SCHEMES)[number], scenario: boolean) {
  await signIn(page.context(), "admin", baseURL);
  await freezeClock(page);
  if (scenario) await askForScenario(page, PLACEMENT_WEEK_SCENARIO);
  const misses = watchStubMisses(page);
  await page.setViewportSize(size);
  await page.goto(PAGE);
  await settle(page);
  await setScheme(page, scheme, true);
  await expect(page.getByRole("heading", { level: 1, name: "Förlägg i veckan" })).toBeVisible();
  return misses;
}

/** What the browser is told the school's subject and one teacher are called: long enough to need wrapping. */
async function nameThingsLong(page: Page) {
  await page.route(`${STUB_ORIGIN}/rest/v1/Subjects*`, async (route) => {
    const response = await route.fetch();
    const rows = (await response.json()) as Array<{ id: string; name: string }>;
    await route.fulfill({ response, body: JSON.stringify(rows.map((row) => (row.id === SUBJECTS.ma.id ? { ...row, name: LONG_SUBJECT } : row))) });
  });
  await page.route(`${STUB_ORIGIN}/api/v1/users*`, async (route) => {
    const response = await route.fetch();
    const rows = (await response.json()) as Array<{ id: string; lastName: string }>;
    await route.fulfill({ response, body: JSON.stringify(rows.map((row) => (row.id === TEACHERS.bo.id ? { ...row, lastName: LONG_SURNAME } : row))) });
  });
}

/** Every line of text in the list and the notices, and every card of the week, read in one pass. */
function measure(page: Page) {
  return page.evaluate(() => {
    const EPS = 0.5;
    const problems: string[] = [];
    const textNodes = (root: Element): Text[] => {
      const found: Text[] = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node as Text;
        if (!text.data.trim()) continue;
        // Text for a screen reader only is a clipped pixel on purpose.
        if (text.parentElement?.closest(".sr-only")) continue;
        found.push(text);
      }
      return found;
    };
    const rectsOf = (text: Text): DOMRect[] => {
      const range = document.createRange();
      range.selectNodeContents(text);
      return [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
    };

    // The list, the summary, the notice and the legend: each line inside the box that holds it, sideways.
    const boxes = [
      ...document.querySelectorAll("[data-testid='placement-post'], [data-testid='placement-summary'], #placement-failing, [aria-label='Teckenförklaring'] li, [data-testid='placement-detail'] > div"),
    ];
    for (const box of boxes) {
      const outer = box.getBoundingClientRect();
      for (const text of textNodes(box)) {
        for (const rect of rectsOf(text)) {
          if (rect.left < outer.left - EPS || rect.right > outer.right + EPS) {
            problems.push(`text past its box sideways: "${text.data.trim().slice(0, 40)}" ${Math.round(rect.left)}–${Math.round(rect.right)} in ${Math.round(outer.left)}–${Math.round(outer.right)}`);
          }
        }
      }
      if (box.scrollWidth > box.clientWidth + 1) problems.push(`a box scrolls sideways: ${(box.textContent ?? "").trim().slice(0, 40)}`);
    }

    // The week: no card's line is cut across its height (the grid drops a line that does not fit).
    const cards = [...document.querySelectorAll("[data-lesson-id]")];
    for (const card of cards) {
      const outer = card.getBoundingClientRect();
      for (const text of textNodes(card)) {
        for (const rect of rectsOf(text)) {
          if (rect.top < outer.top - EPS || rect.bottom > outer.bottom + EPS) {
            problems.push(`card line cut across: "${text.data.trim().slice(0, 40)}" ${Math.round(rect.top)}–${Math.round(rect.bottom)} in ${Math.round(outer.top)}–${Math.round(outer.bottom)} (${card.getAttribute("data-lesson-id")})`);
          }
        }
      }
    }

    const grid = document.querySelector("[data-lesson-id]")?.closest("[class*='overflow-x']") ?? null;
    return {
      problems,
      cards: cards.length,
      pageScrollsSideways: document.documentElement.scrollWidth > window.innerWidth,
      gridScrollsInside: grid ? grid.scrollWidth > grid.clientWidth : null,
      dayEnd: document.querySelectorAll("[data-lesson-id^='day-end:']").length,
      hours: [...document.querySelectorAll("section#placement-week *")].map((element) => element.textContent ?? "").filter((text) => /^\d\d:00$/.test(text)),
    };
  });
}

for (const size of VIEWPORTS) {
  for (const scheme of SCHEMES) {
    test(`Förlägg i veckan at ${size.name}, ${scheme}: nothing is cut, the page does not scroll sideways, and the day goes to 18:00`, async ({ page, baseURL }) => {
      const misses = await open(page, baseURL!, size, scheme, true);
      await expect(page.getByTestId("failing-row")).toHaveCount(1);
      const facts = await measure(page);
      expect(facts.problems, "text measured by its own rectangles").toEqual([]);
      expect(facts.pageScrollsSideways, "the page scrolls sideways").toBe(false);
      // The Friday row reaches 18:00, so the grid draws to it without help.
      expect(facts.dayEnd, "strips for the end of the day").toBe(0);
      expect(facts.hours.at(-1)).toBe("17:00");
      expect(misses, MISSES).toEqual([]);
    });

    test(`Förlägg i veckan at ${size.name}, ${scheme}: a long subject, a long surname and a wide font stay inside their boxes`, async ({ page, baseURL }) => {
      await nameThingsLong(page);
      const misses = await open(page, baseURL!, size, scheme, true);
      await page.addStyleTag({ content: WIDE_FONT });
      await expect(page.getByTestId("failing-row")).toHaveCount(1);
      await expect(page.getByText(LONG_SUBJECT).first()).toBeVisible();
      const facts = await measure(page);
      expect(facts.problems, "text measured by its own rectangles").toEqual([]);
      expect(facts.pageScrollsSideways, "the page scrolls sideways").toBe(false);
      expect(misses, MISSES).toEqual([]);
    });
  }

  test(`Förlägg i veckan at ${size.name}: a week with nothing in it is said and not drawn`, async ({ page, baseURL }) => {
    const misses = await open(page, baseURL!, size, "light", false);
    await expect(page.getByText("Inget är förlagt än")).toBeVisible();
    await expect(page.getByTestId("placement-week-empty")).toBeVisible();
    const facts = await measure(page);
    expect(facts.problems).toEqual([]);
    expect(facts.pageScrollsSideways).toBe(false);
    expect(facts.cards).toBe(0);
    expect(misses, MISSES).toEqual([]);
  });

  test(`Förlägg i veckan at ${size.name}: a week whose lessons end early is still drawn to 18:00`, async ({ page, baseURL }) => {
    const misses = await open(page, baseURL!, size, "light", true);
    // Anna's one förläggning is Tuesday 10:00–11:00: the grid would stop at 16:00 for it.
    await page.getByRole("button", { name: /Lärare/ }).click();
    await page.getByRole("menuitemcheckbox", { name: "Anna Lind", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-lesson-id^='placement:']")).toHaveCount(1);
    const facts = await measure(page);
    expect(facts.problems).toEqual([]);
    expect(facts.pageScrollsSideways).toBe(false);
    expect(facts.dayEnd, "the strips that end the school day").toBe(5);
    expect(facts.hours.at(-1)).toBe("17:00");
    expect(misses, MISSES).toEqual([]);
  });
}

test("Förlägg i veckan: opening a card says its verdict in words, and a class shows its meal", async ({ page, baseURL }) => {
  const misses = await open(page, baseURL!, { width: 375, height: 812 }, "light", true);
  // The row that no longer holds is told in words in the notice, and again when its card is opened.
  await expect(page.getByTestId("failing-row")).toContainText("Läraren har redan");
  await page.locator("[data-lesson-id^='placement:']").nth(1).click();
  await expect(page.getByTestId("placement-detail")).toContainText("Läraren har redan");
  await page.getByRole("button", { name: /Grupper/ }).click();
  await page.getByRole("menuitemcheckbox", { name: "7A", exact: true }).click();
  await expect(page.getByText("Måltid 7A")).toBeVisible();
  expect(misses, MISSES).toEqual([]);
});

test("Förlägg i veckan: no automated accessibility violation in either theme, at a phone's width", async ({ page, baseURL }) => {
  const misses = await open(page, baseURL!, { width: 375, height: 812 }, "light", true);
  const reports = await scanBothSchemes(page, "placements", true);
  expect(reports, reports.join("\n")).toEqual([]);
  expect(misses, MISSES).toEqual([]);
});
