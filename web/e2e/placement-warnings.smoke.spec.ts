import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { scanBothSchemes, setScheme } from "./axe";
import { askForScenario, freezeClock, settle, signIn, signInAs, watchStubMisses } from "./signed-in";
import { PLACEMENT_WRITE_SCENARIO } from "./stub/fixtures/timplan-board";
import { PLACEMENT_WARNINGS_SCENARIO } from "./stub/fixtures/timplan-warnings";
import { EXPEDITION, KIND, READER, STUB_ORIGIN, uid } from "./stub/sessions";

/**
 * Förlägg i veckan, the warnings (D1), in a browser.
 *
 * What the page makes of `warnings` and `holds` and of the answer of a save, sentence by sentence and key by key, is page.warnings.test.tsx's, in jsdom.
 * jsdom has no layout and no screen reader's name for a button, so what is asked here is what only a browser can say:
 *
 *   - a card with a warning has a mark in its header, in words ("Varning", "Vägrar" where Generera will refuse the week), the whole of it drawn, and its
 *     accessible name carries the sentences, so that the reader who tabs through the week hears them without opening anything;
 *   - the list under the week says each warning once for a post, with the word and, after one that refuses, what that means; the card's dialog says
 *     each warning and, for one that does not refuse, that the lesson is saved and that the warning does not stop Generera;
 *   - a save reads its warnings out in the page's polite status, and the card the keyboard goes to has the mark the moment it is focused;
 *   - the other schools' bands for a teacher or a room that is picked, in words, and none for one that is not;
 *   - at 320 px, 375 px and 1280 px, in both themes, with a wide font and a long room type: no line of the list, the status or the dialog reaches past its
 *     box (the rectangle of the text, not the element's box), a mark is not cut by the card it is on, and the page does not scroll sideways;
 *     axe for the administrator, the läsare and the expedition.
 *
 * The stub remembers what it is written, per scenario name (stub/fixtures/timplan-warnings.ts PLACEMENT_WARNINGS_SCENARIO says which rows and
 * warnings): every test names its own, since the suites run side by side against one stub.
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
const LONG_ROOM_TYPE = "Specialsalsförpraktiskaochestetiskaämnenmedettmycketlångtnamnutanmellanslag";

const SVENSKA = uid(KIND.requirement, 1);
const MATEMATIK = uid(KIND.requirement, 2);
const IDROTT = uid(KIND.requirement, 4);

/** The three cards of the scenario, by the lesson's key: post, teacher (none on a post that shares nothing), length, day, start and weeks. */
const svenska = (page: Page) => page.locator(`[data-lesson-id='placement:${SVENSKA}||60|2|10:00|ALL_WEEKS']`);
const matematik = (page: Page) => page.locator(`[data-lesson-id='placement:${MATEMATIK}||60|4|13:15|ALL_WEEKS']`);
const idrott = (page: Page) => page.locator(`[data-lesson-id='placement:${IDROTT}||60|5|17:00|ODD_WEEKS']`);

const scenarioName = (kind: string) => `${kind}:${randomUUID()}`;

interface Opened {
  misses: string[];
  puts: Array<{ url: string; body: { placements: Array<Record<string, unknown>>; baseKey?: string } }>;
}

async function open(
  page: Page,
  baseURL: string,
  options: { size?: { width: number; height: number }; scheme?: (typeof SCHEMES)[number]; scenario?: string; persona?: "admin" | "reader" | "expedition" } = {},
): Promise<Opened> {
  const persona = options.persona ?? "admin";
  if (persona === "admin") await signIn(page.context(), "admin", baseURL);
  else await signInAs(page.context(), persona === "reader" ? READER : EXPEDITION, baseURL);
  await freezeClock(page);
  await askForScenario(page, options.scenario ?? scenarioName(PLACEMENT_WARNINGS_SCENARIO));
  const misses = watchStubMisses(page);
  const puts: Opened["puts"] = [];
  page.on("request", (request) => {
    if (request.method() === "PUT" && request.url().startsWith(STUB_ORIGIN) && request.url().endsWith("/placements")) {
      puts.push({ url: request.url(), body: JSON.parse(request.postData() ?? "{}") });
    }
  });
  await page.setViewportSize(options.size ?? { width: 1280, height: 1200 });
  await page.goto(PAGE);
  await settle(page);
  await setScheme(page, options.scheme ?? "light", true);
  await expect(page.getByRole("heading", { level: 1, name: "Förlägg i veckan" })).toBeVisible();
  return { misses, puts };
}

/**
 * Text for a reader that cannot be seen is not measured; every other line of text must lie inside the box it stands in. And a MARK on a card
 * (the badge in its header, which the grid never truncates) must lie inside the card it is on: a card clips what is past its edge.
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
    const marks = [...document.querySelectorAll("[data-lesson-id] > div > div > span[title]")].map((mark) => {
      const card = mark.closest("[data-lesson-id]")!.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(mark.firstChild!);
      const rects = [...range.getClientRects()].filter((rect) => rect.width > 0);
      const cut = rects.some((rect) => rect.left < card.left - EPS || rect.right > card.right + EPS);
      return { text: (mark.firstChild!.textContent ?? "").trim(), cut };
    });
    for (const mark of marks) if (mark.cut) problems.push(`a mark is cut by its card: "${mark.text}"`);
    return { problems, marks: marks.length, pageScrollsSideways: document.documentElement.scrollWidth > window.innerWidth };
  }, selector);
}

const BOXES = "[data-testid='placement-warnings'], [data-testid='placement-status'], [role='dialog']";

test.describe("the card", () => {
  test("has a mark in words, the stronger one where Generera will refuse, and carries the sentences in its name", async ({ page, baseURL }) => {
    const { misses } = await open(page, baseURL!);
    // The mark is words, and a card whose warnings none refuses has the quieter one.
    await expect(svenska(page)).toContainText("Varning");
    await expect(svenska(page)).not.toContainText("Vägrar");
    await expect(matematik(page)).toContainText("Vägrar");
    await expect(idrott(page)).toContainText("Vägrar");
    // The name a screen reader reads on the card: its sentences, and what a refusal means once the card refuses.
    await expect(svenska(page)).toHaveAccessibleName(/Läraren undervisar 470 min på tisdag, över taket på 420 min\./);
    await expect(svenska(page)).toHaveAccessibleName(/Läraren undervisar 240 min i följd på tisdag, över gränsen på 180 min \(rast 20 min\)\./);
    await expect(svenska(page)).not.toHaveAccessibleName(/vägra veckan/);
    await expect(matematik(page)).toHaveAccessibleName(/Klassen får ingen lunch på torsdag: lektionerna lämnar inte 30 min ledigt mellan 10:30 och 13:00\. Generera kommer att vägra veckan på grund av detta\./);
    await expect(matematik(page)).toHaveAccessibleName(/Läraren undervisar 5 dagar i veckan, över gränsen på 4\./);
    // The reader without HR-läs is told there is a limit and not what it is; the room type is named.
    await expect(idrott(page)).toHaveAccessibleName(/Ingen sal av typen Idrottssal är ledig fredag 17:00–18:00\./);
    await expect(idrott(page)).toHaveAccessibleName(/Läraren går över sin gräns för antal undervisningsdagar\./);
    await expect(idrott(page)).toHaveAccessibleName(/Läraren går över sin gräns för undervisning i följd\./);
    // The legend names both marks.
    await expect(page.getByRole("list", { name: "Teckenförklaring" })).toContainText("Märket Varning");
    await expect(page.getByRole("list", { name: "Teckenförklaring" })).toContainText("Märket Vägrar");
    expect(misses, MISSES).toEqual([]);
  });

  test("has none of it in a week from a gateway that sends no warnings", async ({ page, baseURL }) => {
    const { misses } = await open(page, baseURL!, { scenario: scenarioName(PLACEMENT_WRITE_SCENARIO) });
    await expect(page.locator("[data-lesson-id^='placement:']")).toHaveCount(2);
    await expect(page.locator("[data-lesson-id^='placement:'] span[title]")).toHaveCount(0);
    await expect(page.getByTestId("placement-warnings")).toHaveCount(0);
    await expect(page.getByRole("list", { name: "Teckenförklaring" })).not.toContainText("Märket Varning");
    expect(misses, MISSES).toEqual([]);
  });

  test("is marked for the läsare and the expedition too, who see the week and no bricks", async ({ page, baseURL }) => {
    const { misses } = await open(page, baseURL!, { persona: "reader", size: { width: 1280, height: 900 } });
    await expect(svenska(page)).toContainText("Varning");
    await expect(page.getByTestId("brick-post")).toHaveCount(0);
    expect(misses, MISSES).toEqual([]);
  });
});

test.describe("the lists", () => {
  test("a post says each warning once, with the word and after one that refuses what that means; the dialog says that the lesson is saved when it does not", async ({ page, baseURL }) => {
    const { misses } = await open(page, baseURL!);
    const lines = (post: string) => page.locator(`#post-${post}`).getByTestId("placement-warning");
    await expect(lines(SVENSKA)).toHaveCount(2);
    await expect(lines(MATEMATIK)).toHaveCount(2);
    await expect(lines(IDROTT)).toHaveCount(3);
    await expect(lines(SVENSKA).first()).toContainText("Varning: Läraren undervisar 470 min på tisdag");
    await expect(lines(MATEMATIK).first()).toContainText("Generera kommer att vägra veckan på grund av detta.");
    // In the list a warning that does not refuse says nothing of the save: that is the dialog's sentence.
    await expect(page.locator(`#post-${SVENSKA}`)).not.toContainText("Lektionen är sparad");
    await svenska(page).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("card-verdict")).toHaveText("Håller.");
    await expect(dialog.getByTestId("placement-warning")).toHaveCount(2);
    await expect(dialog.getByTestId("placement-warning").first()).toContainText("Lektionen är sparad, och den här varningen stoppar inte Generera.");
    await page.keyboard.press("Escape");
    await matematik(page).click();
    await expect(page.getByRole("dialog").getByTestId("placement-warning").first()).toContainText("Generera kommer att vägra veckan på grund av detta.");
    expect(misses, MISSES).toEqual([]);
  });
});

test.describe("a save", () => {
  test("reads the warnings out in the polite status, and the card the keyboard goes to has its mark the moment it is focused", async ({ page, baseURL }) => {
    const { puts, misses } = await open(page, baseURL!);
    const status = page.getByTestId("placement-status");
    await expect(status).toHaveAttribute("role", "status");
    await expect(status).toHaveAttribute("aria-live", "polite");
    await svenska(page).focus();
    // A quarter of an hour earlier: later would be onto the class's meal.
    await page.keyboard.press("ArrowUp");
    await expect.poll(() => puts.length).toBe(1);
    const moved = page.locator(`[data-lesson-id='placement:${SVENSKA}||60|2|09:45|ALL_WEEKS']`);
    await expect(moved).toBeFocused();
    await expect(status).toContainText("Gäller från nästa Generera.");
    await expect(status).toContainText("2 varningar: Läraren undervisar 470 min på tisdag, över taket på 420 min.");
    await expect(moved).toContainText("Varning");
    await expect(moved).toHaveAccessibleName(/Läraren undervisar 240 min i följd på tisdag/);
    expect(misses, MISSES).toEqual([]);
  });
});

test.describe("the other schools' bands", () => {
  test("are drawn for a teacher that is picked, with the school by name, and for no other: nothing is drawn until one is picked", async ({ page, baseURL }) => {
    const { misses } = await open(page, baseURL!);
    await expect(page.getByText(/Bokad på/)).toHaveCount(0);
    await page.getByRole("button", { name: "Lärare", exact: true }).click();
    await page.getByRole("menuitemcheckbox", { name: "Anna Lind", exact: true }).click();
    await page.keyboard.press("Escape");
    // Anna's hold, not Bo's.
    await expect(page.getByText("Bokad på Östra skolan", { exact: true })).toBeVisible();
    await expect(page.getByText(/Södra skolan/)).toHaveCount(0);
    expect(misses, MISSES).toEqual([]);
  });

  test("are drawn for a room that is picked, with both schools by name, behind the cards and taking no pointer", async ({ page, baseURL }) => {
    const { misses } = await open(page, baseURL!);
    await page.getByRole("button", { name: "Salar", exact: true }).click();
    await page.getByRole("menuitemcheckbox", { name: "NO-salen", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByText("Bokad på Norra skolan och Östra skolan", { exact: true })).toBeVisible();
    // The band is behind the cards and takes no pointer: a press on the hour under it still reaches the week.
    await expect(page.getByText("Bokad på Norra skolan och Östra skolan", { exact: true })).toHaveCSS("pointer-events", "none");
    expect(misses, MISSES).toEqual([]);
  });
});

for (const size of VIEWPORTS) {
  for (const scheme of SCHEMES) {
    test(`at ${size.name}, ${scheme}: a mark is not cut, the lists, the status and the dialog stay inside their boxes, and the page does not scroll sideways`, async ({ page, baseURL }) => {
      const { misses } = await open(page, baseURL!, { size, scheme });
      let facts = await measure(page, BOXES);
      expect(facts.marks, "the three cards have a mark").toBe(3);
      expect(facts.problems, "text measured by its own rectangles").toEqual([]);
      expect(facts.pageScrollsSideways, "the page scrolls sideways").toBe(false);
      await matematik(page).click();
      await expect(page.getByRole("dialog").getByTestId("placement-warning")).toHaveCount(2);
      facts = await measure(page, BOXES);
      expect(facts.problems, "the dialog's text").toEqual([]);
      expect(facts.pageScrollsSideways).toBe(false);
      expect(misses, MISSES).toEqual([]);
    });

    test(`at ${size.name}, ${scheme}: a wide font and a long room type stay inside the lists and the dialog`, async ({ page, baseURL }) => {
      await page.route(`${STUB_ORIGIN}/api/v1/teaching-requirements/placements/board*`, async (route) => {
        const response = await route.fetch();
        const board = (await response.json()) as { warnings: Array<{ code: string; params?: Record<string, string | number> }> };
        const warnings = board.warnings.map((warning) => (warning.code === "NO_ROOM_FREE" ? { ...warning, params: { ...warning.params, roomType: LONG_ROOM_TYPE } } : warning));
        await route.fulfill({ response, body: JSON.stringify({ ...board, warnings }) });
      });
      const { misses } = await open(page, baseURL!, { size, scheme });
      await page.addStyleTag({ content: WIDE_FONT });
      await expect(page.locator(`#post-${IDROTT}`).getByText(LONG_ROOM_TYPE)).toBeVisible();
      let facts = await measure(page, BOXES);
      expect(facts.problems, "text measured by its own rectangles").toEqual([]);
      expect(facts.pageScrollsSideways, "the page scrolls sideways").toBe(false);
      await idrott(page).click();
      await expect(page.getByRole("dialog").getByTestId("placement-warning")).toHaveCount(3);
      facts = await measure(page, BOXES);
      expect(facts.problems, "the dialog's text").toEqual([]);
      expect(facts.pageScrollsSideways).toBe(false);
      expect(misses, MISSES).toEqual([]);
    });
  }
}

test.describe("axe", () => {
  test("the administrator, with a card opened: no violation in either theme, at a phone's width", async ({ page, baseURL }) => {
    const { misses } = await open(page, baseURL!, { size: { width: 375, height: 812 } });
    let reports = await scanBothSchemes(page, "placement-warnings-week", true);
    expect(reports, reports.join("\n")).toEqual([]);
    await matematik(page).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    reports = await scanBothSchemes(page, "placement-warnings-card", true);
    expect(reports, reports.join("\n")).toEqual([]);
    expect(misses, MISSES).toEqual([]);
  });

  test("the administrator, with the other schools' bands drawn: no violation in either theme", async ({ page, baseURL }) => {
    const { misses } = await open(page, baseURL!, { size: { width: 375, height: 812 } });
    await page.getByRole("button", { name: "Lärare", exact: true }).click();
    await page.getByRole("menuitemcheckbox", { name: "Anna Lind", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByText("Bokad på Östra skolan", { exact: true })).toBeVisible();
    const reports = await scanBothSchemes(page, "placement-warnings-bands", true);
    expect(reports, reports.join("\n")).toEqual([]);
    expect(misses, MISSES).toEqual([]);
  });

  for (const persona of ["reader", "expedition"] as const) {
    test(`the ${persona}: no violation in either theme, at a phone's width`, async ({ page, baseURL }) => {
      const { misses } = await open(page, baseURL!, { persona, size: { width: 375, height: 812 } });
      await expect(svenska(page)).toContainText("Varning");
      const reports = await scanBothSchemes(page, `placement-warnings-${persona}`, true);
      expect(reports, reports.join("\n")).toEqual([]);
      expect(misses, MISSES).toEqual([]);
    });
  }
});
