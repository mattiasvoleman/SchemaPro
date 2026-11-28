import { expect, test, type Page } from "@playwright/test";
import { format, scan, setScheme } from "./axe";
import { freezeClock, settle, signIn, watchStubMisses } from "./signed-in";
import { KIND, STUB_ORIGIN, uid } from "./stub/sessions";

/**
 * Grundschemat, E5a: Byt plats and Gör plats in a browser, at 1280, 375 and 320 px.
 *
 *   - Byt plats: two lessons marked, the button asks the gateway for the swap of the two, the swap is drawn on the board with its price in the
 *     list, and Tillämpa sends the moves with the second lesson named as the person's own choice.
 *   - Gör plats: a lesson put down on a time that is taken is refused, the dialog offers Byt and Gör plats beside the free times, Gör plats shows
 *     what makes room and draws it on the board, and Tillämpa sends the proposal chosen.
 *
 * What the lists say, key by key, is swap-proposals.test.tsx's, and what the board draws is swap-layer.test.tsx's, both in jsdom; the search, the
 * judge and the price are the gateway's (src/swaps/swap-make-room.spec.ts, swaps.room.spec.ts). jsdom has no layout, so what is asked here is
 * what only a browser can say: that the list and the buttons fit and can be pressed on a phone, that the dialog does not make the page scroll
 * sideways with a wide font, that the board is in reach beside it, that the picture is drawn over the lessons it concerns, and that axe finds
 * nothing with it all up. The gateway's answers are made here from the fixture school's own lessons (the stub has no swap search).
 */

const PAGE = "/sv/admin/timetable";
const MISSES = "the backend stub could not answer these reads; each says which file to add it to or fix";
const VIEWPORTS = [
  { name: "1280×800", width: 1280, height: 800 },
  { name: "375×812", width: 375, height: 812 },
  { name: "320×700", width: 320, height: 700 },
];
const WIDE_FONT = "body, button, input, select { font-family: 'DejaVu Sans Mono', monospace !important }";

/** Matematik 7A, Monday 09:25–10:25, and Svenska 7B, Monday 10:40–11:40: the two that are marked. */
const MATH_7A = uid(KIND.masterLesson, 2);
const SWEDISH_7B = uid(KIND.masterLesson, 9);
/** Svenska 7A, Wednesday 10:40–11:40 (what stands in the way), and Matematik 7A, Wednesday 13:00–14:00 (what is put down on it). */
const SWEDISH_7A_WED = uid(KIND.masterLesson, 6);
const MATH_7A_WED = uid(KIND.masterLesson, 7);

const slot = (dayOfWeek: number, startMinutes: number, length = 60) => ({ dayOfWeek, startMinutes, endMinutes: startMinutes + length });
const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const view = (id: string, subjectName: string, groupName: string, isLocked = false) => ({ id, subjectName, groupName, teacherId: null, coTeacherId: null, roomId: null, isLocked });
const COSTS = (before: number, after: number, moved: number) => [
  { code: "PUPIL_GAPS", unit: "MINUTES", before, after, delta: after - before },
  { code: "TEACHER_GAPS", unit: "MINUTES", before: 0, after: 0, delta: 0 },
  { code: "DISTRIBUTION", unit: "BREACHES", before: 0, after: 0, delta: 0 },
  { code: "TEACHER_DAY", unit: "BREACHES", before: 0, after: 0, delta: 0 },
  { code: "MOVED_LESSONS", unit: "LESSONS", before: 0, after: moved, delta: moved },
];

/** The swap of the two marked lessons: each takes the other's start. */
const SWAP = {
  id: "swap-1",
  kind: "SWAP",
  moves: [
    { lessonId: MATH_7A, from: slot(1, 565), to: slot(1, 640) },
    { lessonId: SWEDISH_7B, from: slot(1, 640), to: slot(1, 565) },
  ],
  parallels: [],
  external: [],
  hard: ["CLASH", "FRAME", "LUNCH"],
  soft: COSTS(60, 30, 2),
  lessons: [view(MATH_7A, "Matematik", "7A"), view(SWEDISH_7B, "Svenska", "7B")],
  removedCalendarLessons: 0,
};

/** Gör plats for Matematik 7A on Wednesday 10:45: Svenska 7A goes to Friday 08:10, and Matematik takes its place. Two ways. */
const ROOM = (id: string, to: ReturnType<typeof slot>, before: number, after: number) => ({
  id,
  kind: "MAKE_ROOM",
  moves: [
    { lessonId: MATH_7A_WED, from: slot(3, 780), to: slot(3, 645) },
    { lessonId: SWEDISH_7A_WED, from: slot(3, 640), to: to },
  ],
  parallels: [],
  external: [],
  hard: ["CLASH", "FRAME", "LUNCH"],
  soft: COSTS(before, after, 2),
  lessons: [view(MATH_7A_WED, "Matematik", "7A"), view(SWEDISH_7A_WED, "Svenska", "7A")],
  removedCalendarLessons: 0,
  levels: { [MATH_7A_WED]: 0, [SWEDISH_7A_WED]: 1 },
  depth: 1,
});
const ROOM_ANSWER = {
  lessonId: MATH_7A_WED,
  academicYearId: "y1",
  unit: { lessonIds: [MATH_7A_WED], links: [] },
  selectedLocked: false,
  proposals: [ROOM("room-1", slot(5, 490), 60, 30), ROOM("room-2", slot(2, 565), 60, 90)],
  makeRoom: { target: slot(3, 645), blockers: [{ lessonIds: [SWEDISH_7A_WED], subjectName: "Svenska", groupName: "7A", isLocked: false }], depth: 3, landingsCut: false },
  stats: { partners: 14, candidates: 2, judged: 2, refused: 0, truncated: false, chainsCut: false, elapsedMs: 12, phasesMs: { read: 1, index: 1, warm: 1, search: 1 } },
};

interface Asked {
  pair: unknown[];
  suggest: unknown[];
  apply: unknown[];
}

async function open(page: Page, baseURL: string, size: { width: number; height: number }, answers: { pair?: unknown } = {}) {
  await signIn(page.context(), "admin", baseURL);
  await freezeClock(page);
  const misses = watchStubMisses(page);
  const asked: Asked = { pair: [], suggest: [], apply: [] };
  await page.route(`${STUB_ORIGIN}/api/v1/swaps/pair`, async (route) => {
    asked.pair.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(answers.pair ?? { academicYearId: "y1", ok: true, proposal: SWAP, refusals: [] }) });
  });
  await page.route(`${STUB_ORIGIN}/api/v1/swaps/suggest`, async (route) => {
    asked.suggest.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(ROOM_ANSWER) });
  });
  await page.route(`${STUB_ORIGIN}/api/v1/swaps/apply`, async (route) => {
    const body = route.request().postDataJSON() as { moves: Array<{ lessonId: string; from: unknown; to: unknown }> };
    asked.apply.push(body);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ lessons: [], propagatedLessons: 0, removedCalendarLessons: 0, versionId: "v-1", undo: body.moves.map((move) => ({ lessonId: move.lessonId, from: move.to, to: move.from })), exemptionsEnded: [], lockedLessonIds: [], }),
    });
  });
  await page.setViewportSize(size);
  await page.goto(PAGE);
  await settle(page);
  await expect(page.getByRole("heading", { level: 1, name: "Grundschema" })).toBeVisible();
  await page.addStyleTag({ content: WIDE_FONT });
  return { misses, asked };
}

/** On a phone the board draws one day, and the day is chosen first; at a desk every day is drawn. */
async function showDay(page: Page, day: number) {
  const picker = page.getByRole("group", { name: "Visa en dag" });
  if ((page.viewportSize()?.width ?? 1280) < 768) await expect(picker).toBeVisible();
  if (await picker.count()) await picker.getByRole("button").nth(day - 1).click();
}

const card = (page: Page, id: string) => page.locator(`[data-lesson-id="${id}"]`).first();

/** Marks a lesson the way the board already does for a reader with a keyboard (Shift+Enter): a tap on a phone opens the lesson, and marking by touch is E5b's. */
async function mark(page: Page, id: string) {
  await card(page, id).focus();
  await page.keyboard.press("Shift+Enter");
}

/** What was asked, once each: the dev server runs effects twice (StrictMode), and the first of the two answers is thrown away by the list. */
const distinct = (asked: unknown[]) => [...new Set(asked.map((entry) => JSON.stringify(entry)))].map((entry) => JSON.parse(entry) as unknown);

/** What a sheet must be at: inside the window, with no sideways scroll of the page, and every button of it a size a finger can press. */
async function fits(page: Page, scope: string) {
  // The sheet is measured where it comes to rest. It opens with the dialogs' own 200 ms zoom-in, and Tailwind 3's `enter` keyframes carry no
  // translate of their own: until it ends the sheet is drawn at left 50 % of the window and slides in from the right, so measured at once it
  // "reaches past the window" at 375 and 320 px (CI, 51–421 of 375). The other smoke rows wait the same way before they measure a dialog.
  await page.locator(scope).first().evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
  return page.evaluate((selector) => {
    const root = document.querySelector(selector) as HTMLElement | null;
    const problems: string[] = [];
    if (!root) return { problems: ["the sheet is not there"], scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth };
    const box = root.getBoundingClientRect();
    if (box.left < -0.5 || box.right > window.innerWidth + 0.5) problems.push(`the sheet reaches past the window: ${Math.round(box.left)}–${Math.round(box.right)} of ${window.innerWidth}`);
    if (box.bottom > window.innerHeight + 0.5) problems.push(`the sheet reaches below the window: ${Math.round(box.bottom)} of ${window.innerHeight}`);
    for (const button of root.querySelectorAll("button")) {
      const rect = button.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const name = (button.textContent ?? "").trim() || button.getAttribute("aria-label") || "(unnamed)";
      // The cross every dialog of the app has (components/ui/dialog.tsx, 16×16) is the shared component's and not this list's.
      if (name === "Stäng" && button.classList.contains("absolute")) continue;
      if (rect.height < 24 || rect.width < 24) problems.push(`"${name}" is smaller than 24×24: ${Math.round(rect.width)}×${Math.round(rect.height)}`);
      if (window.innerWidth <= 640 && /Tillämpa|Visa på brädet|Visas på brädet|Försök igen/.test(name) && rect.height < 43.5) problems.push(`"${name}" is lower than 44 px on a phone: ${Math.round(rect.height)}`);
      if (rect.right > box.right + 0.5 || rect.left < box.left - 0.5) problems.push(`"${name}" reaches past the sheet`);
    }
    return { problems, scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth };
  }, scope);
}

for (const size of VIEWPORTS) {
  test.describe(`at ${size.name}`, () => {
    test("Byt plats: two lessons marked, the swap is drawn on the board with its price, and applied with the second lesson named", async ({ page, baseURL }) => {
      const { misses, asked } = await open(page, baseURL!, size);
      await showDay(page, 1);
      const bar = page.getByRole("button", { name: "Byt plats" });
      await mark(page, MATH_7A);
      await expect(bar).toBeDisabled();
      await mark(page, SWEDISH_7B);
      await expect(bar).toBeEnabled();
      expect(asked.pair, "nothing is asked until the button is pressed").toEqual([]);
      await bar.click();

      const sheet = page.getByRole("dialog", { name: "Byt plats" });
      await expect(sheet).toBeVisible();
      expect(distinct(asked.pair)).toEqual([{ lessonId: MATH_7A, otherLessonId: SWEDISH_7B }]);
      // The swap with its price, before and after, and the lessons in words.
      await expect(sheet.getByRole("heading", { level: 3, name: /^Byte/ })).toBeVisible();
      await expect(sheet.getByText("60 min → 30 min")).toBeVisible();
      await expect(sheet.getByText("Matematik 7A").first()).toBeVisible();
      // The board draws it, over the two lessons, in words and not in colour alone.
      const layer = page.locator('[data-swap-layer="1"]');
      await expect(layer).toBeAttached();
      await expect(layer.locator('[data-swap-box="arrives"]').first()).toContainText("kommer hit");
      await expect(layer.locator('[data-swap-box="leaves"]').first()).toContainText("lämnar");
      expect(await layer.evaluate((node) => getComputedStyle(node).pointerEvents)).toBe("none");

      const measured = await fits(page, '[role="dialog"]');
      expect(measured.problems).toEqual([]);
      expect(measured.scrollWidth).toBeLessThanOrEqual(measured.innerWidth + 1);
      // The board is in reach beside the dialog: nothing behind it is inert.
      expect(await page.evaluate(() => document.querySelector("main")?.getAttribute("aria-hidden") ?? null)).toBeNull();
      const found = await scan(page);
      expect(format(found.violations)).toBe("");

      await sheet.getByRole("button", { name: "Tillämpa" }).click();
      await expect.poll(() => asked.apply.length).toBe(1);
      expect(asked.apply[0]).toMatchObject({ lessonId: MATH_7A, alsoPicked: [SWEDISH_7B] });
      expect((asked.apply[0] as { moves: unknown[] }).moves).toHaveLength(2);
      await expect(sheet).toBeHidden();
      await expect(page.locator("[data-swap-layer]")).toHaveCount(0);
      expect(misses, MISSES).toEqual([]);
    });

    test("Byt plats: when the swap does not go, the judge's reasons are said by lesson and nothing is drawn or applied", async ({ page, baseURL }) => {
      const refused = {
        academicYearId: "y1",
        ok: false,
        refusals: [{ lessonId: SWEDISH_7B, reason: "FRAME", params: {}, text: "Svenska 7B får inte börja 09:25: tiden ligger utanför klassens ramtid." }],
      };
      const { asked } = await open(page, baseURL!, size, { pair: refused });
      await showDay(page, 1);
      await mark(page, MATH_7A);
      await mark(page, SWEDISH_7B);
      await page.getByRole("button", { name: "Byt plats" }).click();
      const sheet = page.getByRole("dialog", { name: "Byt plats" });
      await expect(sheet.getByText("Bytet går inte:")).toBeVisible();
      await expect(sheet.getByText("Måndag 10:40:")).toBeVisible();
      await expect(sheet.getByText(/utanför klassens ramtid/)).toBeVisible();
      await expect(sheet.getByRole("button", { name: "Tillämpa" })).toHaveCount(0);
      await expect(page.locator("[data-swap-layer]")).toHaveCount(0);
      const measured = await fits(page, '[role="dialog"]');
      expect(measured.problems).toEqual([]);
      expect(measured.scrollWidth).toBeLessThanOrEqual(measured.innerWidth + 1);
      expect(asked.apply).toEqual([]);
    });

    test("Gör plats: a lesson put down on a taken time offers it, shows what makes room on the board, and applies the proposal chosen", async ({ page, baseURL }) => {
      const { misses, asked } = await open(page, baseURL!, size);
      await showDay(page, 3);
      // Take Matematik 7A (Wednesday 13:00) up and put it down at 10:45, where Svenska 7A stands: nine quarters of an hour up.
      await card(page, MATH_7A_WED).focus();
      await page.keyboard.press("Space");
      for (let step = 0; step < 9; step += 1) await page.keyboard.press("ArrowUp");
      await page.keyboard.press("Enter");

      const sheet = page.getByRole("dialog", { name: /Platsen är upptagen/ });
      await expect(sheet).toBeVisible();
      await expect(sheet.getByRole("button", { name: "Byt", exact: true })).toBeVisible();
      await sheet.getByRole("button", { name: "Gör plats" }).click();

      const room = page.getByRole("dialog", { name: "Gör plats" });
      await expect(room).toBeVisible();
      await expect(room.getByText("2 förslag, de bästa först")).toBeVisible();
      expect(distinct(asked.suggest)).toEqual([{ lessonId: MATH_7A_WED, makeRoom: { dayOfWeek: 3, startTime: "10:45" }, limit: 8 }]);
      await expect(room.getByText("Svenska 7A").first()).toBeVisible();
      await expect(room.getByText("60 min → 30 min")).toBeVisible();
      await expect(room.getByText("(flyttas för att göra plats, nivå 1)").first()).toBeVisible();
      // The first proposal is the one in view, and the board draws it on Wednesday and not on the days it does not touch.
      await expect(page.locator('[data-swap-layer="3"]')).toBeAttached();
      await expect(page.locator('[data-swap-layer="3"] [data-swap-box="arrives"]').first()).toContainText("Matematik 7A kommer hit");

      // The second one in view instead: Svenska goes to Tuesday, so Wednesday no longer says "lämnar, till Fredag".
      await room.getByRole("button", { name: "Visa på brädet" }).first().click();
      await expect(room.getByRole("button", { name: "Visas på brädet" })).toHaveCount(1);
      await expect(page.locator('[data-swap-layer="3"] [data-swap-box="leaves"]').filter({ hasText: "Tisdag 09:25" })).toHaveCount(1);

      const measured = await fits(page, '[role="dialog"]');
      expect(measured.problems).toEqual([]);
      expect(measured.scrollWidth).toBeLessThanOrEqual(measured.innerWidth + 1);
      const found = await scan(page);
      expect(format(found.violations)).toBe("");

      await room.getByRole("button", { name: "Tillämpa" }).nth(1).click();
      await expect.poll(() => asked.apply.length).toBe(1);
      expect(asked.apply[0]).toMatchObject({ lessonId: MATH_7A_WED });
      expect((asked.apply[0] as { alsoPicked?: unknown }).alsoPicked).toBeUndefined();
      expect(((asked.apply[0] as { moves: Array<{ lessonId: string; to: { dayOfWeek: number; startTime: string } }> }).moves).find((move) => move.lessonId === SWEDISH_7A_WED)?.to).toMatchObject({ dayOfWeek: 2, startTime: clock(565) });
      await expect(room).toBeHidden();
      expect(misses, MISSES).toEqual([]);
    });

    test("Gör plats: dark theme, and the dialog's own buttons bring the free times back", async ({ page, baseURL }) => {
      await open(page, baseURL!, size);
      await setScheme(page, "dark", true);
      await showDay(page, 3);
      await card(page, MATH_7A_WED).focus();
      await page.keyboard.press("Space");
      for (let step = 0; step < 9; step += 1) await page.keyboard.press("ArrowUp");
      await page.keyboard.press("Enter");
      const sheet = page.getByRole("dialog", { name: /Platsen är upptagen/ });
      await sheet.getByRole("button", { name: "Byt", exact: true }).click();
      const swapSheet = page.getByRole("dialog", { name: "Byt med lektionen som står där" });
      await expect(swapSheet).toBeVisible();
      await page.evaluate(() => window.scrollTo(0, 0));
      const found = await scan(page);
      expect(format(found.violations)).toBe("");
      await swapSheet.getByRole("button", { name: "Tillbaka till tiderna" }).click();
      await expect(page.getByRole("dialog", { name: /Platsen är upptagen/ })).toBeVisible();
    });
  });
}
