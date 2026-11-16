import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { scanBothSchemes, setScheme } from "./axe";
import { askForScenario, freezeClock, settle, signIn, signInAs, watchStubMisses } from "./signed-in";
import {
  PLACEMENT_WRITE_REFUSE_SCENARIO,
  PLACEMENT_WRITE_SCENARIO,
  PLACEMENT_WRITE_STALE_SCENARIO,
} from "./stub/fixtures/timplan-board";
import { SUBJECTS, TEACHERS } from "./stub/fixtures/world";
import { EXPEDITION, KIND, READER, STUB_ORIGIN, uid } from "./stub/sessions";

/**
 * Förlägg i veckan, laying, moving and removing, in a browser.
 *
 * What the page makes of an answer, key by key, is page.test.tsx's, in jsdom. jsdom has no layout, no pointer and no
 * focus that moves, so what is asked here is what only a browser can say:
 *
 *   - a brick pulled with the mouse lands where it is let go; a brick chosen and a time pressed (a phone cannot drag, at
 *     320 px and 375 px); and a lesson laid, moved and removed with the keyboard alone (Tab, Enter, the arrow keys);
 *   - the keyboard is left on the card that was laid, and the sentence for what was done is said in a live region;
 *   - undo and redo, a drop the gateway refuses (the reason, and the brick left where it was), and a post somebody else
 *     has written (409 REQUIREMENT_PLACEMENTS_STALE: read again, and the same drop made on top of the new key);
 *   - the room: "Motorn väljer sal" is sent as no room;
 *   - at 320 px, 375 px and 1280 px, in both themes, with a long name and a wide font: no line of the list of bricks, the
 *     row, the message or the dialog reaches past its box (the rectangle of the text, not the element's box), and the
 *     page does not scroll sideways; axe for the administrator, the läsare and the expedition.
 *
 * The stub remembers what it is written, per scenario name (stub/fixtures/timplan-board.ts PLACEMENT_WRITE_SCENARIO):
 * every test names its own, since the suites run side by side against one stub.
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
const WIDE_FONT = "body, button, input, select { font-family: 'DejaVu Sans Mono', monospace !important }";

/** The posts of the world the tests lay: Svenska 7A (Anna, three lessons, one placed) and Matematik 7A (Bo). */
const SVENSKA = uid(KIND.requirement, 1);
const ANNA = TEACHERS.anna.id;
const BRICK = `[data-brick='${SVENSKA}|${ANNA}|60#1']`;

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
  await askForScenario(page, options.scenario ?? scenarioName(PLACEMENT_WRITE_SCENARIO));
  const misses = watchStubMisses(page);
  const puts: Opened["puts"] = [];
  page.on("request", (request) => {
    if (request.method() === "PUT" && request.url().startsWith(STUB_ORIGIN) && request.url().endsWith("/placements")) {
      puts.push({ url: request.url(), body: JSON.parse(request.postData() ?? "{}") });
    }
  });
  // Tall: the list of bricks and the whole week are in view at once, so that a pointer can go from one to the other without scrolling.
  await page.setViewportSize(options.size ?? { width: 1280, height: 1600 });
  await page.goto(PAGE);
  await settle(page);
  await setScheme(page, options.scheme ?? "light", true);
  await expect(page.getByRole("heading", { level: 1, name: "Förlägg i veckan" })).toBeVisible();
  return { misses, puts };
}

/** The five day columns of the editable week, in order. */
const columns = (page: Page) => page.locator("[data-writes-inert='SCHEMALAGGNING DRIFT']");

/** The middle of a day column at a time (the grid is 1.1 px a minute from 08:00 for a week of hour-long lessons). */
async function spot(page: Page, day: number, hour: number, minute = 0) {
  const box = (await columns(page).nth(day - 1).boundingBox())!;
  // Half a pixel into the minute: the grid snaps a drop to five minutes, and a few pixels more would land on the next.
  return { x: box.x + box.width / 2, y: box.y + (hour * 60 + minute - 480) * 1.1 + 0.5 };
}

async function pull(page: Page, brick: Locator, to: { x: number; y: number }) {
  const from = (await brick.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2 + 12, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}

const cardAt = (page: Page, day: number, start: string, weeks = "ALL_WEEKS") => page.locator(`[data-lesson-id^='placement:${SVENSKA}|'][data-lesson-id$='|60|${day}|${start}|${weeks}']`);

/** Text for a reader that cannot be seen is not measured; every other line of text must lie inside the box it stands in. */
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

const BOXES = "#placement-to-lay, [data-testid='lay-row'], [data-testid='placement-message'], [data-testid='placement-status'], [role='dialog']";

test.describe("laying a lesson", () => {
  test("a brick pulled into the week is laid where it is let go, on top of the key that was read", async ({ page, baseURL }) => {
    const { puts, misses } = await open(page, baseURL!);
    await pull(page, page.locator(BRICK), await spot(page, 3, 9));
    await expect.poll(() => puts.length).toBe(1);
    // The post's whole list: the row that stood there, and the new one, no teacher (the post shares nothing) and the room its other lesson stands in.
    expect(puts[0]!.body.baseKey).toBe("k000000000000001");
    expect(puts[0]!.body.placements).toHaveLength(2);
    expect(puts[0]!.body.placements[1]).toMatchObject({ dayOfWeek: 3, startTime: "09:00", minutes: 60, recurrence: "ALL_WEEKS" });
    await expect(cardAt(page, 3, "09:00")).toBeVisible();
    await expect(page.getByTestId("placement-status")).toContainText("Gäller från nästa Generera.");
    expect(misses, MISSES).toEqual([]);
  });

  test("a brick pulled onto a time the teacher is busy is refused in words, and nothing is written", async ({ page, baseURL }) => {
    // Anna teaches Svenska on Tuesday 10:00 (placed): her next lesson cannot stand on it.
    const { puts } = await open(page, baseURL!);
    await pull(page, page.locator(BRICK), await spot(page, 2, 10, 15));
    await expect(page.getByTestId("placement-message")).toContainText("Läraren har redan");
    expect(puts).toHaveLength(0);
    await expect(page.locator(BRICK)).toBeVisible();
  });

  for (const size of VIEWPORTS.slice(0, 2)) {
    test(`at ${size.name}: a brick chosen and a time pressed lays the lesson (a phone cannot drag)`, async ({ page, baseURL }) => {
      const { puts, misses } = await open(page, baseURL!, { size });
      await page.locator(BRICK).click();
      await expect(page.locator(BRICK)).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByTestId("lay-row")).toBeVisible();
      const column = columns(page).nth(2);
      await column.scrollIntoViewIfNeeded();
      await column.click({ position: { x: 20, y: (13 * 60 - 480) * 1.1 + 4 } });
      await expect.poll(() => puts.length).toBe(1);
      expect(puts[0]!.body.placements.at(-1)).toMatchObject({ dayOfWeek: 3, startTime: "13:00" });
      await expect(cardAt(page, 3, "13:00")).toHaveCount(1);
      expect(misses, MISSES).toEqual([]);
    });
  }

  test("with the keyboard alone: choose the brick, give a time and the room the engine chooses, lay it, move it, and take it away", async ({ page, baseURL }) => {
    const { puts, misses } = await open(page, baseURL!);
    await page.locator(BRICK).focus();
    await page.keyboard.press("Enter");
    const row = page.getByTestId("lay-row");
    await expect(row).toBeVisible();
    // The first field has the keyboard, and says in words that the time is free.
    await expect(row.getByLabel("Dag")).toBeFocused();
    await expect(row.getByTestId("place-verdict")).toContainText("Ledigt");
    await page.keyboard.press("ArrowDown"); // the day
    await page.keyboard.press("Tab");
    await expect(row.getByLabel("Starttid")).toBeFocused();
    // The hours, and the minutes after them: a time is typed digit by digit.
    await page.keyboard.type("1315");
    // Tab leaves the minutes for the clock's own button, then for the room: press it until the room has the keyboard.
    for (let tabs = 0; tabs < 4 && !(await row.getByLabel("Sal").evaluate((element) => element === document.activeElement)); tabs++) {
      await page.keyboard.press("Tab");
    }
    await expect(row.getByLabel("Sal")).toBeFocused();
    // "Motorn väljer sal" is the first choice of the list (a select's arrow keys are the platform's: set it by its value).
    await row.getByLabel("Sal").selectOption("");
    await expect(row.getByLabel("Sal")).toHaveValue("");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter"); // Lägg
    await expect.poll(() => puts.length).toBe(1);
    expect(puts[0]!.body.placements.at(-1)).toMatchObject({ startTime: "13:15", roomId: null, minutes: 60 });
    const day = puts[0]!.body.placements.at(-1)!["dayOfWeek"] as number;

    // The keyboard is left on the card that was laid; an arrow key moves it a quarter of an hour.
    const card = cardAt(page, day, "13:15");
    await expect(card).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect.poll(() => puts.length).toBe(2);
    expect(puts[1]!.body.placements.at(-1)).toMatchObject({ dayOfWeek: day, startTime: "13:30" });
    await expect(cardAt(page, day, "13:30")).toBeFocused();

    // Enter opens it: change or take it away. The brick it was is back in Att lägga.
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Dag")).toBeFocused();
    await dialog.getByRole("button", { name: "Ta bort" }).focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => puts.length).toBe(3);
    expect(puts[2]!.body.placements).toHaveLength(1);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator(BRICK)).toBeVisible();
    expect(misses, MISSES).toEqual([]);
  });

  test("the room: 'Motorn väljer sal' is sent as no room, and a chosen room as its id", async ({ page, baseURL }) => {
    const { puts } = await open(page, baseURL!);
    await page.locator(BRICK).click();
    const row = page.getByTestId("lay-row");
    await row.getByLabel("Dag").selectOption("4");
    await row.getByLabel("Starttid").fill("09:00");
    await row.getByLabel("Sal").selectOption({ label: "NO-salen" });
    await row.getByRole("button", { name: "Lägg", exact: true }).click();
    await expect.poll(() => puts.length).toBe(1);
    expect(puts[0]!.body.placements.at(-1)!["roomId"]).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
    // The next lesson of the post: the room its other lessons stand in is offered, and the engine's choice is one pick away.
    await page.locator(`[data-brick^='${SVENSKA}|${ANNA}|60#']`).first().click();
    await expect(page.getByTestId("lay-row").getByLabel("Sal")).not.toHaveValue("");
    await page.getByTestId("lay-row").getByLabel("Dag").selectOption("5");
    await page.getByTestId("lay-row").getByLabel("Starttid").fill("10:00");
    await page.getByTestId("lay-row").getByLabel("Sal").selectOption("");
    await page.getByTestId("lay-row").getByRole("button", { name: "Lägg", exact: true }).click();
    await expect.poll(() => puts.length).toBe(2);
    expect(puts[1]!.body.placements.at(-1)).toMatchObject({ dayOfWeek: 5, startTime: "10:00", roomId: null });
  });
});

test.describe("undo and redo", () => {
  test("write the list as it was, on top of the key the last write left; Ctrl+Z does the same", async ({ page, baseURL }) => {
    const { puts, misses } = await open(page, baseURL!);
    await pull(page, page.locator(BRICK), await spot(page, 4, 9));
    await expect.poll(() => puts.length).toBe(1);
    await expect(cardAt(page, 4, "09:00")).toBeVisible();
    await page.getByRole("button", { name: "Ångra" }).click();
    await expect.poll(() => puts.length).toBe(2);
    expect(puts[1]!.body.placements).toHaveLength(1);
    expect(puts[1]!.body.baseKey).not.toBe("k000000000000001");
    await expect(cardAt(page, 4, "09:00")).toHaveCount(0);
    await page.getByRole("button", { name: "Gör om" }).click();
    await expect.poll(() => puts.length).toBe(3);
    await expect(cardAt(page, 4, "09:00")).toBeVisible();
    await page.keyboard.press("Control+z");
    await expect.poll(() => puts.length).toBe(4);
    await expect(cardAt(page, 4, "09:00")).toHaveCount(0);
    expect(misses, MISSES).toEqual([]);
  });
});

test.describe("what the gateway says", () => {
  test("a refused drop says why, leaves the brick where it was, and writes nothing", async ({ page, baseURL }) => {
    const { puts } = await open(page, baseURL!, { scenario: scenarioName(PLACEMENT_WRITE_REFUSE_SCENARIO) });
    await pull(page, page.locator(BRICK), await spot(page, 5, 9));
    await expect(page.getByTestId("placement-message")).toContainText("Läraren har redan");
    expect(puts).toHaveLength(1);
    await expect(page.locator(BRICK)).toBeVisible();
    await expect(cardAt(page, 5, "09:00")).toHaveCount(0);
  });

  test("a post somebody else has written is refused with its own message, read again, and the same drop is then made on top of the new key", async ({ page, baseURL }) => {
    const { puts } = await open(page, baseURL!, { scenario: scenarioName(PLACEMENT_WRITE_STALE_SCENARIO) });
    const board = page.waitForResponse((response) => response.url().includes("/placements/board") && response.status() === 200, { timeout: 15_000 });
    await pull(page, page.locator(BRICK), await spot(page, 5, 9));
    await expect(page.getByTestId("placement-message")).toContainText("Någon annan har ändrat");
    await board;
    expect(puts).toHaveLength(1);
    await expect(cardAt(page, 5, "09:00")).toHaveCount(0);
    // Read again: the page holds the key the gateway has now, and the same drop is accepted.
    await pull(page, page.locator(BRICK), await spot(page, 5, 9));
    await expect.poll(() => puts.length).toBe(2);
    expect(puts[1]!.body.baseKey).not.toBe(puts[0]!.body.baseKey);
    await expect(cardAt(page, 5, "09:00")).toBeVisible();
  });
});

for (const size of VIEWPORTS) {
  for (const scheme of SCHEMES) {
    test(`at ${size.name}, ${scheme}: the list of bricks, the row, the message and the dialog stay inside their boxes, and the page does not scroll sideways`, async ({ page, baseURL }) => {
      const { misses } = await open(page, baseURL!, { size, scheme });
      await page.locator(BRICK).click();
      await expect(page.getByTestId("lay-row")).toBeVisible();
      await expect(page.getByTestId("lay-row").getByLabel("Dag")).toBeVisible();
      let facts = await measure(page, BOXES);
      expect(facts.problems, "text measured by its own rectangles").toEqual([]);
      expect(facts.pageScrollsSideways, "the page scrolls sideways").toBe(false);
      // A refused press says why in the message; then a card opened in its dialog.
      await page.getByTestId("lay-row").getByLabel("Dag").selectOption("2");
      await page.getByTestId("lay-row").getByLabel("Starttid").fill("10:15");
      await expect(page.getByTestId("place-verdict")).toContainText("Läraren har redan");
      facts = await measure(page, BOXES);
      expect(facts.problems).toEqual([]);
      await page.locator("[data-lesson-id^='placement:']").first().click();
      await expect(page.getByRole("dialog")).toBeVisible();
      facts = await measure(page, BOXES);
      expect(facts.problems, "the dialog's text").toEqual([]);
      expect(facts.pageScrollsSideways).toBe(false);
      expect(misses, MISSES).toEqual([]);
    });

    test(`at ${size.name}, ${scheme}: a long subject, a long surname and a wide font stay inside the row and the dialog`, async ({ page, baseURL }) => {
      await page.route(`${STUB_ORIGIN}/rest/v1/Subjects*`, async (route) => {
        const response = await route.fetch();
        const rows = (await response.json()) as Array<{ id: string; name: string }>;
        await route.fulfill({ response, body: JSON.stringify(rows.map((row) => (row.id === SUBJECTS.sv.id ? { ...row, name: LONG_SUBJECT } : row))) });
      });
      await page.route(`${STUB_ORIGIN}/api/v1/users*`, async (route) => {
        const response = await route.fetch();
        const rows = (await response.json()) as Array<{ id: string; lastName: string }>;
        await route.fulfill({ response, body: JSON.stringify(rows.map((row) => (row.id === ANNA ? { ...row, lastName: LONG_SURNAME } : row))) });
      });
      const { misses } = await open(page, baseURL!, { size, scheme });
      await page.addStyleTag({ content: WIDE_FONT });
      await page.locator(BRICK).click();
      await expect(page.getByTestId("lay-row")).toContainText(LONG_SUBJECT);
      let facts = await measure(page, BOXES);
      expect(facts.problems, "text measured by its own rectangles").toEqual([]);
      expect(facts.pageScrollsSideways).toBe(false);
      await page.locator("[data-lesson-id^='placement:']").first().click();
      await expect(page.getByRole("dialog")).toBeVisible();
      facts = await measure(page, BOXES);
      expect(facts.problems).toEqual([]);
      expect(misses, MISSES).toEqual([]);
    });
  }
}

test.describe("who may write", () => {
  test("the läsare sees the week, opens a card, and is offered nothing that writes", async ({ page, baseURL }) => {
    const { puts, misses } = await open(page, baseURL!, { persona: "reader", scenario: scenarioName(PLACEMENT_WRITE_SCENARIO), size: { width: 1280, height: 900 } });
    await expect(page.getByTestId("brick-post")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Ångra" })).toBeHidden();
    await expect(columns(page)).toHaveCount(0);
    await page.locator("[data-lesson-id^='placement:']").first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Spara" })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Ta bort" })).toHaveCount(0);
    expect(puts).toHaveLength(0);
    expect(misses, MISSES).toEqual([]);
  });

  test("the expedition reads the week and is offered nothing that writes Planering", async ({ page, baseURL }) => {
    const { puts, misses } = await open(page, baseURL!, { persona: "expedition" });
    await expect(page.getByRole("heading", { level: 1, name: "Förlägg i veckan" })).toBeVisible();
    await expect(page.getByTestId("brick-post")).toHaveCount(0);
    await expect(columns(page)).toHaveCount(0);
    // The link to a page it does not write is hidden (the layout's style rule, by data-writes).
    await expect(page.getByRole("link", { name: "Timplansposter" })).toBeHidden();
    expect(puts).toHaveLength(0);
    expect(misses, MISSES).toEqual([]);
  });
});

test.describe("axe", () => {
  test("the administrator with a brick chosen and a card opened: no violation in either theme, at a phone's width", async ({ page, baseURL }) => {
    const { misses } = await open(page, baseURL!, { size: { width: 375, height: 812 } });
    await page.locator(BRICK).click();
    await expect(page.getByTestId("lay-row").getByLabel("Dag")).toBeVisible();
    let reports = await scanBothSchemes(page, "placements-lay", true);
    expect(reports, reports.join("\n")).toEqual([]);
    await page.getByRole("button", { name: "Välj bort" }).click();
    await page.locator("[data-lesson-id^='placement:']").first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    reports = await scanBothSchemes(page, "placements-card", true);
    expect(reports, reports.join("\n")).toEqual([]);
    expect(misses, MISSES).toEqual([]);
  });

  test("the administrator's empty week: its scrolling box has something to focus", async ({ page, baseURL }) => {
    // The world places nothing without a scenario: the week is empty, and drawn.
    const { misses } = await open(page, baseURL!, { size: { width: 375, height: 812 }, scenario: "none" });
    await expect(page.getByTestId("placement-week-empty")).toBeVisible();
    const reports = await scanBothSchemes(page, "placements-empty", true);
    expect(reports, reports.join("\n")).toEqual([]);
    expect(misses, MISSES).toEqual([]);
  });

  for (const persona of ["reader", "expedition"] as const) {
    test(`the ${persona}: no violation in either theme, at a phone's width`, async ({ page, baseURL }) => {
      const { misses } = await open(page, baseURL!, { persona, size: { width: 375, height: 812 } });
      const reports = await scanBothSchemes(page, `placements-${persona}`, true);
      expect(reports, reports.join("\n")).toEqual([]);
      expect(misses, MISSES).toEqual([]);
    });
  }
});
