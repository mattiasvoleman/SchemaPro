import { expect, test, type Page } from "@playwright/test";
import { scan, format, setScheme } from "./axe";
import { freezeClock, settle, signIn, watchStubMisses } from "./signed-in";
import { KIND, uid } from "./stub/sessions";

/**
 * Undantag med flit on the card, in a browser (E1b, Klart (e)): the mark is a word on the lesson's card and not only a colour, it is read
 * after the lesson's name, it is the block card's for every member that has one, and nothing reaches past its box, at 1280, 390 and 320 px
 * in both themes, with a wide font.
 *
 * What the words are, key by key, is the unit tests' (page.test.tsx, block-cards.mark.test.tsx); jsdom has no layout. What is asked here is
 * what only a browser can say: that the mark is where the reader looks, that no line of it reaches past the card, that the page does not
 * scroll sideways because of it, and that axe finds nothing on the page with the marks on it. The exemptions are the answers of the stub's
 * lesson reads, edited on their way (the fixture school has none of its own).
 */

const PAGE = "/sv/admin/timetable";
const MISSES = "the backend stub could not answer these reads; each says which file to add it to or fix";
const VIEWPORTS = [
  { name: "1280×800", width: 1280, height: 800 },
  { name: "390×844", width: 390, height: 844 },
  { name: "320×700", width: 320, height: 700 },
];
const SCHEMES = ["light", "dark"] as const;
const WIDE_FONT = "body, button, input, select { font-family: 'DejaVu Sans Mono', monospace !important }";

/** Idrott 7A, Monday 13:00–14:00: given the exemption from the class's lunch. */
const IDROTT = uid(KIND.masterLesson, 3);
/** Språkval åk 7, Thursday 10:40–11:40, both groups at once: one card. Its two members are given an exemption each, for different rules. */
const SPRAKVAL = [uid(KIND.masterLesson, 14), uid(KIND.masterLesson, 15)];
const GIVEN: Record<string, string[]> = { [IDROTT]: ["LUNCH"], [SPRAKVAL[0]!]: ["FRAME"], [SPRAKVAL[1]!]: ["LUNCH"] };

async function open(page: Page, baseURL: string, size: { width: number; height: number }, scheme: (typeof SCHEMES)[number]) {
  await signIn(page.context(), "admin", baseURL);
  await freezeClock(page);
  const misses = watchStubMisses(page);
  await page.route("**/rest/v1/MasterLessons?*", async (route) => {
    const response = await route.fetch();
    const rows = (await response.json()) as Array<Record<string, unknown>>;
    await route.fulfill({ response, json: rows.map((row) => (GIVEN[row["id"] as string] ? { ...row, isLocked: true, exemptFrom: GIVEN[row["id"] as string] } : row)) });
  });
  await page.setViewportSize(size);
  await page.goto(PAGE);
  await settle(page);
  await setScheme(page, scheme, true);
  await expect(page.getByRole("heading", { level: 1, name: "Grundschema" })).toBeVisible();
  await page.addStyleTag({ content: WIDE_FONT });
  return misses;
}

/** On a phone the board draws one day, and the day is chosen first; at a desk every day is drawn. */
async function showDay(page: Page, day: number) {
  const picker = page.getByRole("group", { name: "Visa en dag" });
  if ((page.viewportSize()?.width ?? 1280) < 768) await expect(picker).toBeVisible();
  if (await picker.count()) await picker.getByRole("button").nth(day - 1).click();
}

/** Every line of text in the card lies inside the card, and the mark inside the card's own box. */
function measureCard(page: Page, selector: string) {
  return page.evaluate((cardSelector) => {
    const EPS = 0.5;
    const problems: string[] = [];
    for (const card of document.querySelectorAll(cardSelector)) {
      const outer = card.getBoundingClientRect();
      for (const mark of card.querySelectorAll("[data-lesson-mark]")) {
        const box = mark.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) problems.push("the mark has no box");
        if (box.left < outer.left - EPS || box.right > outer.right + EPS) problems.push(`the mark reaches past its card sideways: ${Math.round(box.left)}–${Math.round(box.right)} in ${Math.round(outer.left)}–${Math.round(outer.right)}`);
      }
    }
    return { problems, scrollWidth: document.documentElement.scrollWidth };
  }, selector);
}

for (const size of VIEWPORTS) {
  for (const scheme of SCHEMES) {
    test.describe(`at ${size.name}, ${scheme}`, () => {
      test("a lesson with an exemption has the word on its card and a name for the screen reader, and nothing reaches past the card", async ({ page, baseURL }) => {
        const misses = await open(page, baseURL!, size, scheme);
        const before = await page.evaluate(() => document.documentElement.scrollWidth);
        await showDay(page, 1);
        const card = page.locator(`[data-lesson-id='${IDROTT}']`);
        await expect(card).toBeVisible();
        const mark = card.locator("[data-lesson-mark]");
        await expect(mark).toBeVisible();
        // The word, in view, and the sentence after it for the one who cannot see it (read after the lesson's name).
        await expect(mark).toContainText("Undantag");
        await expect(mark.locator(".sr-only")).toContainText("klassens lunch");
        const measured = await measureCard(page, `[data-lesson-id='${IDROTT}']`);
        expect(measured.problems).toEqual([]);
        expect(measured.scrollWidth, "the mark widens the page").toBeLessThanOrEqual(before);
        await page.evaluate(() => window.scrollTo(0, 0));
        const violations = (await scan(page)).violations;
        expect(violations, format(violations)).toEqual([]);
        expect(misses, MISSES).toEqual([]);
      });

      test("a block's card has the mark of every member that has one, each with its own subject in front of its words", async ({ page, baseURL }) => {
        await open(page, baseURL!, size, scheme);
        await showDay(page, 4);
        const card = page.locator("[data-lesson-id^='block:']").first();
        await expect(card).toBeVisible();
        const mark = card.locator("[data-lesson-mark]");
        await expect(mark).toHaveCount(1);
        const label = mark.locator(".sr-only");
        // Both members' words: the ramtid of the one and the class's lunch of the other, each after the name of its own subject.
        await expect(label).toContainText("ramtiden");
        await expect(label).toContainText("klassens lunch");
        const measured = await measureCard(page, "[data-lesson-id^='block:']");
        expect(measured.problems).toEqual([]);
      });
    });
  }
}
