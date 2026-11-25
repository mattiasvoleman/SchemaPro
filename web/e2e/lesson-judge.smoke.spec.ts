import { expect, test, type Page } from "@playwright/test";
import { scan, format, setScheme } from "./axe";
import { freezeClock, settle, signIn, watchStubMisses } from "./signed-in";
import { MASTER_LESSONS, SUBJECTS } from "./stub/fixtures/world";
import { KIND, uid } from "./stub/sessions";

/**
 * Grundschemat says why, in a browser (E1, Klart (c)): the judge's refusal with the other lesson's class, subject, day and time, in
 * Justera lektion while its fields are filled in, in the toast of a save that is refused, and in the krocklista, at 1280, 390 and 320 px
 * in both themes, with a long name and a wide font.
 *
 * What the page makes of each answer, key by key, is the unit tests'; jsdom has no layout. What is asked here is what only a browser can
 * say: that the sentence is where the reader looks, that no line of it reaches past its box and the page does not scroll sideways, and
 * that axe finds nothing in the dialog or the list. The answers are the stub's (stub/fixtures/gateway-lesson-judge.ts), which judges the
 * fixture school's own lessons by the clash rule's arms and the class's meal.
 */

const PAGE = "/sv/admin/timetable";
const MISSES = "the backend stub could not answer these reads; each says which file to add it to or fix";
const VIEWPORTS = [
  { name: "1280×800", width: 1280, height: 800 },
  { name: "390×844", width: 390, height: 844 },
  { name: "320×700", width: 320, height: 700 },
];
const SCHEMES = ["light", "dark"] as const;
const scrollWidthOf = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth);
const WIDE_FONT = "body, button, input, select { font-family: 'DejaVu Sans Mono', monospace !important }";

/** Idrott 7A, Monday 13:00–14:00 (David, the gym): free of everything until it is dragged. */
const IDROTT = uid(KIND.masterLesson, 3);
/** The day of both: the lessons of the stub's 7A below are on Monday. */
const MONDAY = 1;
/** Matematik 7A, Monday 09:25–10:25 (Bo, 101). */
const MATEMATIK = uid(KIND.masterLesson, 2);

async function open(page: Page, baseURL: string, size: { width: number; height: number }, scheme: (typeof SCHEMES)[number], clash = false) {
  await signIn(page.context(), "admin", baseURL);
  await freezeClock(page);
  const misses = watchStubMisses(page);
  if (clash) {
    // A second lesson of 7A on Matematik's Monday hour, with Bo and room 101 as well: the teacher, the room and the class all clash.
    const template = MASTER_LESSONS.find((lesson) => lesson.id === MATEMATIK)!;
    await page.route("**/rest/v1/MasterLessons?*", async (route) => {
      const response = await route.fetch();
      const rows = (await response.json()) as Array<Record<string, unknown>>;
      const clone = { ...template, id: uid(KIND.masterLesson, 90), subjectId: SUBJECTS.no.id, isGenerated: true, extraGroups: [], participants: [] };
      await route.fulfill({ response, json: [...rows, clone] });
    });
  }
  await page.setViewportSize(size);
  await page.goto(PAGE);
  await settle(page);
  await setScheme(page, scheme, true);
  await expect(page.getByRole("heading", { level: 1, name: "Grundschema" })).toBeVisible();
  return misses;
}

/**
 * Every line of text of the boxes lies inside its box. What the PAGE does sideways is not this suite's to judge (timetable-board.smoke.spec.ts
 * holds that it does not scroll sideways at 320 px; the header's own buttons reached 339 px before they were let wrap): `scrollWidth` is read
 * so that opening the dialog can be held to adding nothing to it.
 */
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
    return { problems, scrollWidth: document.documentElement.scrollWidth };
  }, selector);
}

async function openJustera(page: Page, lessonId: string, day: number) {
  // On a phone the board draws one day, today's (E2): the day the lesson is on is chosen first. At a desk there is no such choice to make.
  const picker = page.getByRole("group", { name: "Visa en dag" });
  if (await picker.count()) await picker.getByRole("button").nth(day - 1).click();
  await page.locator(`[data-lesson-id='${lessonId}']`).click();
  await expect(page.getByRole("dialog").getByRole("heading", { name: "Justera lektion" })).toBeVisible();
}

for (const size of VIEWPORTS) {
  for (const scheme of SCHEMES) {
    test.describe(`at ${size.name}, ${scheme}`, () => {
      test("Justera lektion says why while the fields are filled in: the other lesson by class, subject, day and time", async ({ page, baseURL }) => {
        const misses = await open(page, baseURL!, size, scheme);
        await page.addStyleTag({ content: WIDE_FONT });
        const before = await scrollWidthOf(page);
        await openJustera(page, IDROTT, MONDAY);
        const dialog = page.getByRole("dialog");
        // Nothing moved: nothing asked and nothing said.
        await expect(dialog.getByRole("status")).toHaveText("");

        await dialog.locator("#edit-start").fill("09:25");
        await dialog.locator("#edit-end").fill("10:25");
        const status = dialog.getByRole("status");
        await expect(status).toContainText("Det går inte att spara så här:");
        await expect(status).toContainText("Klassen har redan Matematik med 7A, måndag 09:25–10:25.");
        await expect(dialog.locator("#edit-start")).toHaveAttribute("aria-invalid", "true");
        await expect(dialog.locator("#edit-end")).toHaveAttribute("aria-describedby", "edit-judgement");
        // The save is still allowed: the gateway's own answer is the judge.
        await expect(dialog.getByRole("button", { name: "Spara" })).toBeEnabled();

        const measured = await measure(page, "[role='dialog']");
        expect(measured.problems).toEqual([]);
        expect(measured.scrollWidth, "the dialog widens the page").toBeLessThanOrEqual(before);
        const violations = (await scan(page)).violations;
        expect(violations, format(violations)).toEqual([]);

        // A drag that stands says so, and marks nothing.
        await dialog.locator("#edit-start").fill("14:30");
        await dialog.locator("#edit-end").fill("15:30");
        await expect(status).toHaveText("Kontrollen hittar inget som hindrar.");
        await expect(dialog.locator("#edit-start")).not.toHaveAttribute("aria-invalid", "true");
        expect(misses, MISSES).toEqual([]);
      });

      test("a rule that names no other lesson is said as it is: the class's meal", async ({ page, baseURL }) => {
        await open(page, baseURL!, size, scheme);
        await openJustera(page, IDROTT, MONDAY);
        const dialog = page.getByRole("dialog");
        await dialog.locator("#edit-start").fill("11:40");
        await dialog.locator("#edit-end").fill("12:40");
        await expect(dialog.getByRole("status")).toContainText("Tiden ligger på klassens lunch.");
      });

      test("a save the gateway refuses is toasted in the catalogue's sentence, with no 'Schemakonflikt' in front, and the dialog stays", async ({ page, baseURL }) => {
        await open(page, baseURL!, size, scheme);
        await openJustera(page, IDROTT, MONDAY);
        const dialog = page.getByRole("dialog");
        await dialog.locator("#edit-start").fill("09:25");
        await dialog.locator("#edit-end").fill("10:25");
        await dialog.getByRole("button", { name: "Spara" }).click();
        const toast = page.locator("[data-sonner-toast]").first();
        await expect(toast).toContainText("Klassen har redan Matematik med 7A, måndag 09:25–10:25.");
        await expect(toast).not.toContainText("Schemakonflikt");
        await expect(dialog).toBeVisible();
      });

      test("the krocklista says each lesson that clashes and what it clashes with, and opens the lesson", async ({ page, baseURL }) => {
        const misses = await open(page, baseURL!, size, scheme, true);
        await page.addStyleTag({ content: WIDE_FONT });
        const before = await scrollWidthOf(page);
        const way = page.getByRole("button", { name: "Visa vilka" });
        // The way to the list is in its row, inside the screen.
        const box = (await way.boundingBox())!;
        expect(box.x + box.width).toBeLessThanOrEqual(size.width);
        await way.click();
        const list = page.getByRole("dialog", { name: "Konflikter i schemat" });
        await expect(list).toBeVisible();
        await expect(list).toContainText("Biologi med 7A, måndag 09:25–10:25");
        await expect(list).toContainText("Läraren har redan Matematik med 7A, måndag 09:25–10:25.");
        await expect(list).toContainText("Läraren har redan Biologi med 7A, måndag 09:25–10:25.");
        await expect(list).toContainText("Salen är redan upptagen av Matematik med 7A, måndag 09:25–10:25.");
        await expect(list).toContainText("Klassen har redan Biologi med 7A, måndag 09:25–10:25.");

        const measured = await measure(page, "[role='dialog']");
        expect(measured.problems).toEqual([]);
        expect(measured.scrollWidth, "the list widens the page").toBeLessThanOrEqual(before);
        const violations = (await scan(page)).violations;
        expect(violations, format(violations)).toEqual([]);

        await list.getByRole("button", { name: "Öppna" }).first().click();
        await expect(page.getByRole("dialog").getByRole("heading", { name: "Justera lektion" })).toBeVisible();
        expect(misses, MISSES).toEqual([]);
      });
    });
  }
}

test("a week with no clash has no way to the list", async ({ page, baseURL }) => {
  await open(page, baseURL!, VIEWPORTS[0]!, "light");
  await expect(page.getByRole("button", { name: "Visa vilka" })).toHaveCount(0);
});
