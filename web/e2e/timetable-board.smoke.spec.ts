import { expect, test, type Page } from "@playwright/test";
import { scanBothSchemes, setScheme } from "./axe";
import { freezeClock, settle, signIn, watchStubMisses } from "./signed-in";
import { STUB_ORIGIN } from "./stub/sessions";
import { MASTER_LESSONS, SUBJECTS, TEACHERS } from "./stub/fixtures/world";

/**
 * Grundschemat as a board (E2): where its boxes stand on a phone and at a desk, and a lesson moved, locked, parked and undone with no
 * mouse at all.
 *
 * What the page makes of its reads (the figures, the verdicts, the dialogs) is page.test.tsx's, in jsdom, which has no layout. What
 * is asked here is what only a browser can say, in both themes and with a wide font:
 *
 *   - the page does not scroll sideways at 320 px (the year choice in the header ran 19 px past the edge, and made it);
 *   - under 768 px one day is drawn, with five buttons that choose another, each at least 44 px tall and reachable in its whole
 *     width and not only in the middle; at a desk all five days, and no such buttons;
 *   - no line of a card is cut across its height, measured by the rectangle of the text itself and not by an element's box, since a
 *     parent that clips hides a name that is cut;
 *   - a lesson is taken up, moved, locked, parked and undone from the keyboard alone: the spec counts the pointer's presses and says
 *     there were none;
 *   - a card that clashes says what it clashes with in its own name, in words, and not only by a ring and a triangle.
 *
 * The world is the stub's school (e2e/stub/fixtures/world.ts): 7A's Monday has Svenska (locked), Matematik and Idrott, and the clock is
 * stopped on its Wednesday, which is the day a phone opens on.
 */

const PAGE = "/sv/admin/timetable";
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

const SV_LESSON = MASTER_LESSONS[0]!;
const MATH_LESSON = MASTER_LESSONS[1]!;
const IDH_LESSON = MASTER_LESSONS[2]!;

declare global {
  interface Window {
    __pointerPresses: number;
  }
}

/** The gateway's answer to a write of a lesson: the lesson as it now stands. Everything else the page does not write here is a miss. */
async function answerWrites(page: Page, written: Array<{ id: string; body: Record<string, unknown> }>) {
  await page.route(`${STUB_ORIGIN}/api/v1/master-lessons/*`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    const id = route.request().url().split("/").pop()!;
    const body = route.request().postDataJSON() as Record<string, unknown>;
    written.push({ id, body });
    const row = MASTER_LESSONS.find((lesson) => lesson.id === id)!;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...row,
        startTime: row.startTime.slice(0, 5),
        endTime: row.endTime.slice(0, 5),
        ...body,
        propagatedLessons: 0,
        removedCalendarLessons: 0,
        warnings: [],
      }),
    });
  });
}

async function nameThingsLong(page: Page) {
  await page.route(`${STUB_ORIGIN}/rest/v1/Subjects*`, async (route) => {
    const response = await route.fetch();
    const rows = (await response.json()) as Array<{ id: string; name: string }>;
    await route.fulfill({ response, body: JSON.stringify(rows.map((row) => (row.id === SUBJECTS.ma.id ? { ...row, name: LONG_SUBJECT } : row))) });
  });
  await page.route(`${STUB_ORIGIN}/api/v1/users*`, async (route) => {
    if (route.request().method() !== "GET" || new URL(route.request().url()).pathname !== "/api/v1/users") return route.continue();
    const response = await route.fetch();
    const rows = (await response.json()) as Array<{ id: string; lastName: string }>;
    await route.fulfill({ response, body: JSON.stringify(rows.map((row) => (row.id === TEACHERS.bo.id ? { ...row, lastName: LONG_SURNAME } : row))) });
  });
}

async function open(page: Page, baseURL: string, size: { width: number; height: number }, scheme: (typeof SCHEMES)[number]) {
  await signIn(page.context(), "admin", baseURL);
  await freezeClock(page);
  const misses = watchStubMisses(page);
  const written: Array<{ id: string; body: Record<string, unknown> }> = [];
  await answerWrites(page, written);
  await page.addInitScript(() => {
    window.__pointerPresses = 0;
    window.addEventListener("pointerdown", () => (window.__pointerPresses += 1), true);
  });
  await page.setViewportSize(size);
  await page.goto(PAGE);
  await settle(page);
  await setScheme(page, scheme, true);
  await expect(page.getByRole("heading", { level: 1, name: "Grundschema" })).toBeVisible();
  // The keys are a chunk the grid fetches once it is editable: the line they speak in is the sign that they have come.
  await expect(page.locator("[data-board-status]").first()).toBeAttached();
  return { misses, written };
}

/** What a browser can say of the board: the cards, the day buttons, and every line of text against the box it stands in. */
function measure(page: Page) {
  return page.evaluate(() => {
    const EPS = 0.5;
    const problems: string[] = [];
    const textNodes = (root: Element): Text[] => {
      const found: Text[] = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node as Text;
        if (!text.data.trim() || text.parentElement?.closest(".sr-only")) continue;
        found.push(text);
      }
      return found;
    };
    const rectsOf = (text: Text): DOMRect[] => {
      const range = document.createRange();
      range.selectNodeContents(text);
      return [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
    };

    const cards = [...document.querySelectorAll("[data-lesson-id]")];
    for (const card of cards) {
      const outer = card.getBoundingClientRect();
      for (const text of textNodes(card)) {
        for (const rect of rectsOf(text)) {
          if (rect.top < outer.top - EPS || rect.bottom > outer.bottom + EPS) {
            problems.push(`card line cut across: "${text.data.trim().slice(0, 40)}" ${Math.round(rect.top)}–${Math.round(rect.bottom)} in ${Math.round(outer.top)}–${Math.round(outer.bottom)}`);
          }
        }
      }
    }

    // The day buttons: each whole, and reachable at its left end, its middle and its right end (a middle that is reachable says nothing of a
    // button that a neighbour covers at its edge).
    const picker = document.querySelector("[role='group'][aria-label='Visa en dag']");
    // Scrolled to the middle of the window first: a point under the fold is no element, and says nothing of what covers the button.
    picker?.scrollIntoView({ block: "center" });
    const buttons = picker ? [...picker.querySelectorAll("button")] : [];
    const dayButtons = buttons.map((button) => {
      const rect = button.getBoundingClientRect();
      const at = (x: number) => document.elementFromPoint(x, rect.top + rect.height / 2)?.closest("button") === button;
      return {
        height: rect.height,
        inside: rect.left >= -EPS && rect.right <= window.innerWidth + EPS,
        reachable: at(rect.left + 3) && at(rect.left + rect.width / 2) && at(rect.right - 3),
        pressed: button.getAttribute("aria-pressed"),
      };
    });

    const grid = document.querySelector("[data-lesson-id]")?.closest("[class*='overflow-x']") ?? null;
    return {
      problems,
      cards: cards.length,
      pageScrollsSideways: document.documentElement.scrollWidth > window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      gridScrollsInside: grid ? grid.scrollWidth > grid.clientWidth + 1 : null,
      dayButtons,
      dayHeaders: [...document.querySelectorAll("[class*='uppercase']")].filter((el) => /^(mån|tis|ons|tor|fre)/i.test(el.textContent ?? "")).length,
    };
  });
}

for (const size of VIEWPORTS) {
  const phone = size.width < 768;
  for (const scheme of SCHEMES) {
    test(`Grundschemat at ${size.name}, ${scheme}: nothing is cut, the page does not scroll sideways, and ${phone ? "one day is drawn with buttons for the others" : "the whole week is drawn"}`, async ({ page, baseURL }) => {
      const { misses } = await open(page, baseURL!, size, scheme);
      const facts = await measure(page);
      expect(facts.problems, "text measured by its own rectangles").toEqual([]);
      expect(facts.pageScrollsSideways, `the page scrolls sideways (${facts.scrollWidth} px)`).toBe(false);
      if (phone) {
        // The clock is stopped on a Wednesday: its two lessons (7A's Svenska and Matematik) and no other day's.
        expect(facts.cards).toBe(2);
        expect(facts.gridScrollsInside, "the day has a width of its own to scroll in").toBe(false);
        expect(facts.dayButtons).toHaveLength(5);
        for (const [index, button] of facts.dayButtons.entries()) {
          expect(button.height, `button ${index} is at least 44 px tall`).toBeGreaterThanOrEqual(44);
          expect(button.inside, `button ${index} is inside the window`).toBe(true);
          expect(button.reachable, `button ${index} is reachable at both ends and in the middle`).toBe(true);
        }
        expect(facts.dayButtons.map((button) => button.pressed)).toEqual(["false", "false", "true", "false", "false"]);
      } else {
        expect(facts.dayButtons).toEqual([]);
        expect(facts.cards).toBeGreaterThan(5);
      }
      expect(misses, MISSES).toEqual([]);
    });

    test(`Grundschemat at ${size.name}, ${scheme}: a long subject, a long surname and a wide font stay inside their boxes`, async ({ page, baseURL }) => {
      await nameThingsLong(page);
      const { misses } = await open(page, baseURL!, size, scheme);
      await page.addStyleTag({ content: WIDE_FONT });
      if (phone) await page.getByRole("button", { name: /^Onsdag: / }).click();
      await expect(page.locator("[data-lesson-id]").first()).toBeVisible();
      const facts = await measure(page);
      expect(facts.problems, "text measured by its own rectangles").toEqual([]);
      expect(facts.pageScrollsSideways, `the page scrolls sideways (${facts.scrollWidth} px)`).toBe(false);
      expect(misses, MISSES).toEqual([]);
    });
  }
}

test("Grundschemat on a phone: a button chooses a day, and the lessons of that day are the ones drawn", async ({ page, baseURL }) => {
  const { misses } = await open(page, baseURL!, { width: 375, height: 812 }, "light");
  await page.getByRole("button", { name: /^Måndag: 4 lektioner/ }).click();
  await expect(page.locator("[data-lesson-id]")).toHaveCount(4);
  await expect(page.getByRole("button", { name: /^Måndag: 4 lektioner/ })).toHaveAttribute("aria-pressed", "true");
  // A tap opens the lesson in its dialog, where day, time, length, parking and removal are fields and buttons: nothing is dragged.
  await page.locator(`[data-lesson-id="${MATH_LESSON.id}"]`).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(misses, MISSES).toEqual([]);
});

test("Grundschemat: a lesson is taken up, moved, locked, parked and undone from the keyboard, with no pointer", async ({ page, baseURL }) => {
  const { misses, written } = await open(page, baseURL!, { width: 1280, height: 800 }, "light");
  const status = page.locator("[data-board-status]").first();
  const card = (id: string) => page.locator(`[data-lesson-id="${id}"]`);

  // Tab goes into the week and stops at ONE card; the arrows go the rest of the way.
  await card(MATH_LESSON.id).focus();
  await expect(card(MATH_LESSON.id)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(card(SV_LESSON.id)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(card(MATH_LESSON.id)).toBeFocused();
  expect(written, "focus moves nothing").toEqual([]);

  // Space takes it up, an arrow moves the marker a quarter of an hour, Enter puts it down.
  await page.keyboard.press("Space");
  await expect(status).toContainText("Tog upp");
  await page.keyboard.press("ArrowDown");
  await expect(status).toContainText("09:40–10:40: går att lägga");
  await page.keyboard.press("Enter");
  await expect(status).toContainText("Flyttar");
  await expect.poll(() => written.length).toBe(1);
  // The write says what the page saw of the fields it sets (E9), so that a colleague's change of one of them is refused and not written over.
  expect(written[0]).toEqual({ id: MATH_LESSON.id, body: { dayOfWeek: 1, startTime: "09:40", endTime: "10:40", expected: { dayOfWeek: 1, startTime: "09:25", endTime: "10:25" } } });

  // The card is drawn again and focus is on it.
  await expect(card(MATH_LESSON.id)).toBeFocused();

  // L locks it, and the line says so: "Låser Matematik 7A." (#464's sentence, which says what is done and not what came of it) or, in a tree
  // without that sentence, "Matematik 7A är låst." The line is read in the catalogue's words, so the spec reads either.
  await page.keyboard.press("l");
  await expect(status).toContainText(/Låser Matematik 7A|Matematik 7A är låst/);
  await expect.poll(() => written.length).toBe(2);
  expect(written[1]).toEqual({ id: MATH_LESSON.id, body: { isLocked: true, expected: { isLocked: false } } });

  // P parks the idrottslektion.
  await card(IDH_LESSON.id).focus();
  await page.keyboard.press("p");
  await expect.poll(() => written.length).toBe(3);
  expect(written[2]).toEqual({ id: IDH_LESSON.id, body: { isParked: true, expected: { isParked: false } } });
  await expect(card(IDH_LESSON.id)).toHaveCount(0);

  // Ctrl+Z puts the last write back: the lesson is not parked.
  await page.keyboard.press("Control+z");
  await expect.poll(() => written.length).toBe(4);
  expect(written[3]!.id).toBe(IDH_LESSON.id);
  expect(written[3]!.body).toMatchObject({ isParked: false });

  // Nothing of this was done with a pointer.
  expect(await page.evaluate(() => window.__pointerPresses)).toBe(0);
  expect(misses, MISSES).toEqual([]);
});

test("Grundschemat: Esc lets go of a lesson in hand, and a square that does not hold opens the list of the nearest that do", async ({ page, baseURL }) => {
  const { misses, written } = await open(page, baseURL!, { width: 1280, height: 800 }, "light");
  const status = page.locator("[data-board-status]").first();
  await page.locator(`[data-lesson-id="${MATH_LESSON.id}"]`).focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");
  await expect(status).toContainText("Släppte");
  expect(written).toEqual([]);

  // Matematik 7A onto Svenska 7A's hour (Monday 08:10–09:10, the class's own lesson): the class cannot be in two places.
  await page.keyboard.press("Space");
  for (let step = 0; step < 5; step++) await page.keyboard.press("ArrowUp");
  await expect(status).toContainText("går inte att lägga här");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toContainText("närmaste");
  expect(written).toEqual([]);
  expect(misses, MISSES).toEqual([]);
});

test("Grundschemat: a card that clashes says what it clashes with in its own name, in words", async ({ page, baseURL }) => {
  // 7B's Matematik at the same hour with the same teacher as 7A's: Bo is in two places.
  await page.route(`${STUB_ORIGIN}/rest/v1/MasterLessons*`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const rows = (await response.json()) as Array<Record<string, unknown>>;
    const same = rows.find((row) => row.id === MATH_LESSON.id)!;
    await route.fulfill({
      response,
      body: JSON.stringify([...rows, { ...same, id: "00000060-0000-4000-8000-0000000000aa", studentGroupId: MASTER_LESSONS[8]!.studentGroupId }]),
    });
  });
  const { misses } = await open(page, baseURL!, { width: 1280, height: 800 }, "light");
  const clashing = page.locator(`[data-lesson-id="${MATH_LESSON.id}"]`);
  // The picture is there at once (ring and triangle); the words come a moment after, from a module fetched because something clashes.
  await expect(clashing).toHaveAccessibleName(/Krock: .*Läraren/);
  await expect(clashing).toHaveAttribute("title", /Krock: .*Läraren/);
  expect(misses, MISSES).toEqual([]);
});

test("Grundschemat: no automated accessibility violation in either theme, on a phone and at a desk", async ({ page, baseURL }) => {
  const { misses } = await open(page, baseURL!, { width: 375, height: 812 }, "light");
  const phone = await scanBothSchemes(page, "timetable-phone", true);
  expect(phone, phone.join("\n")).toEqual([]);
  await page.setViewportSize({ width: 1280, height: 800 });
  const desk = await scanBothSchemes(page, "timetable-desk", true);
  expect(desk, desk.join("\n")).toEqual([]);
  expect(misses, MISSES).toEqual([]);
});
