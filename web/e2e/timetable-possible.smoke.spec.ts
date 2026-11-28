import { expect, test, type Page } from "@playwright/test";
import { scanBothSchemes, setScheme } from "./axe";
import { freezeClock, settle, signIn, watchStubMisses } from "./signed-in";
import { STUB_ORIGIN } from "./stub/sessions";
import { MASTER_LESSONS } from "./stub/fixtures/world";

/**
 * Grundschemat as a board, E3 "Se": a lesson taken up is asked about, and the board paints where it can stand.
 *
 * What the painting is made of (the runs, the words, the numbers) is possible-layer.test.tsx's, and what the line says of a square
 * is board-keys.possible.test.tsx's, both in jsdom. What is asked here is what only a browser can say:
 *
 *   - the painting comes, behind the lessons, and goes when the lesson is let go;
 *   - it is a picture only: no pointer is taken by it, and a lesson under it can still be pressed;
 *   - 1 to 9 take the marker to the best times and Enter lays the lesson there, with no pointer at all;
 *   - a click (a press and a let go) asks the gateway nothing;
 *   - it passes axe in both themes with the painting up, and does not make the page scroll sideways on a phone with a wide font.
 *
 * The answer is the stub gateway's (e2e/stub/fixtures/gateway-possible-times.ts): the shape the real one has, over the fixture school.
 */

const PAGE = "/sv/admin/timetable";
const MISSES = "the backend stub could not answer these reads; each says which file to add it to or fix";
const MATH_LESSON = MASTER_LESSONS[1]!;
const WIDE_FONT = "body, button, input, select { font-family: 'DejaVu Sans Mono', monospace !important }";

declare global {
  interface Window {
    __pointerPresses: number;
  }
}

async function open(page: Page, baseURL: string, size: { width: number; height: number }, scheme: "light" | "dark") {
  await signIn(page.context(), "admin", baseURL);
  await freezeClock(page);
  const misses = watchStubMisses(page);
  const written: Array<{ id: string; body: Record<string, unknown> }> = [];
  const asked: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/v1/master-lessons/possible-times")) asked.push(request.postData() ?? "");
  });
  await page.route(`${STUB_ORIGIN}/api/v1/master-lessons/*`, async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    const id = route.request().url().split("/").pop()!;
    const body = route.request().postDataJSON() as Record<string, unknown>;
    written.push({ id, body });
    const row = MASTER_LESSONS.find((lesson) => lesson.id === id)!;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...row, startTime: row.startTime.slice(0, 5), endTime: row.endTime.slice(0, 5), ...body, propagatedLessons: 0, removedCalendarLessons: 0, warnings: [] }),
    });
  });
  await page.addInitScript(() => {
    window.__pointerPresses = 0;
    window.addEventListener("pointerdown", () => (window.__pointerPresses += 1), true);
  });
  await page.setViewportSize(size);
  await page.goto(PAGE);
  await settle(page);
  await setScheme(page, scheme, true);
  await expect(page.getByRole("heading", { level: 1, name: "Grundschema" })).toBeVisible();
  await expect(page.locator("[data-board-status]").first()).toBeAttached();
  return { misses, written, asked };
}

const card = (page: Page, id: string) => page.locator(`[data-lesson-id="${id}"]`);

test("Grundschemat: a lesson taken up is painted with where it can stand, and the painting goes when it is let go", async ({ page, baseURL }) => {
  const { misses, asked } = await open(page, baseURL!, { width: 1280, height: 800 }, "light");
  await expect(page.locator("[data-possible-day]")).toHaveCount(0);
  expect(asked, "nothing is asked of a lesson that is not in hand").toEqual([]);

  await card(page, MATH_LESSON.id).focus();
  await page.keyboard.press("Space");
  await expect(page.locator("[data-possible-day]").first()).toBeAttached();
  expect(asked).toHaveLength(1);
  expect(JSON.parse(asked[0]!)).toMatchObject({ lessonId: MATH_LESSON.id, stepMinutes: 5 });

  // Free stretches in words, the class's lunch shut, and the best times numbered from 1.
  await expect(page.locator('[data-possible-run="FREE"]').first()).toContainText("Ledigt");
  await expect(page.locator('[data-possible-run="CLOSED"]').first()).toContainText("Lunch");
  await expect(page.locator('[data-possible-rank="1"]')).toBeVisible();

  // A picture only: the layer is hidden from a screen reader and takes no pointer, and it stands behind the lessons.
  const facts = await page.evaluate((id) => {
    const layer = document.querySelector("[data-possible-day]")!;
    const cardEl = document.querySelector(`[data-lesson-id="${id}"]`)!;
    const rect = cardEl.getBoundingClientRect();
    const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return {
      hidden: layer.getAttribute("aria-hidden"),
      pointer: getComputedStyle(layer).pointerEvents,
      cardIsOnTop: top?.closest("[data-lesson-id]")?.getAttribute("data-lesson-id") === id,
      sideways: document.documentElement.scrollWidth > window.innerWidth,
    };
  }, MATH_LESSON.id);
  expect(facts).toEqual({ hidden: "true", pointer: "none", cardIsOnTop: true, sideways: false });

  // The gateway answers for 07:00 to 18:00 and the board's day is 08:00 to 16:00: what lies outside the column is cut off, so that the grid
  // keeps the height it has (a vertical scrollbar inside the grid's own box that came with the layer and went with it).
  const box = await page.evaluate(() => {
    const wrapper = document.querySelector("[data-possible-day]")!.closest<HTMLElement>(".overflow-x-auto")!;
    return { scrollHeight: wrapper.scrollHeight, clientHeight: wrapper.clientHeight };
  });
  expect(box.scrollHeight, "the painting makes the grid scroll").toBe(box.clientHeight);

  await page.keyboard.press("Escape");
  await expect(page.locator("[data-possible-day]")).toHaveCount(0);
  expect(misses, MISSES).toEqual([]);
});

test("Grundschemat: 1 takes the marker to the best time and Enter lays the lesson there, with no pointer", async ({ page, baseURL }) => {
  const { misses, written } = await open(page, baseURL!, { width: 1280, height: 800 }, "light");
  const status = page.locator("[data-board-status]").first();
  await card(page, MATH_LESSON.id).focus();
  await page.keyboard.press("Space");
  await expect(page.locator('[data-possible-rank="1"]')).toBeAttached();

  await page.keyboard.press("1");
  await expect(status).toContainText(/: förslag 1\. Enter lägger\./);
  const best = await page.locator('[data-possible-rank="1"]').evaluate((badge) => badge.getAttribute("data-possible-rank"));
  expect(best).toBe("1");
  await page.keyboard.press("Enter");
  await expect.poll(() => written.length).toBe(1);
  expect(written[0]!.id).toBe(MATH_LESSON.id);
  expect(Object.keys(written[0]!.body).sort()).toEqual(["dayOfWeek", "endTime", "expected", "startTime"]);
  expect(await page.evaluate(() => window.__pointerPresses), "no pointer was pressed").toBe(0);

  // A suggestion that does not exist is said, and moves nothing.
  await card(page, MATH_LESSON.id).focus();
  await page.keyboard.press("Space");
  await expect(page.locator("[data-possible-day]").first()).toBeAttached();
  await page.keyboard.press("9");
  await expect.poll(async () => (await status.textContent()) ?? "").toMatch(/förslag 9|Det finns inget förslag 9|förslag 9\./);
  expect(misses, MISSES).toEqual([]);
});

test("Grundschemat: the list of possible times below the week lays a lesson with a button, and a typed clock moves the marker", async ({ page, baseURL }) => {
  const { misses, written } = await open(page, baseURL!, { width: 1280, height: 800 }, "light");
  const status = page.locator("[data-board-status]").first();
  await card(page, MATH_LESSON.id).focus();
  await page.keyboard.press("Space");
  const list = page.locator("[data-possible-list]");
  await expect(list).toBeVisible();
  await expect(list.getByRole("heading", { name: /^Möjliga tider för Matematik/ })).toBeVisible();
  // The numbered times are an ordered list of sentences, each with a button that has the whole sentence for a name.
  const buttons = list.getByRole("button", { name: /^Lägg Matematik/ });
  await expect(buttons.first()).toBeVisible();
  expect(await buttons.count()).toBeGreaterThan(1);

  // A typed clock moves the marker, on the marker's own day, and the line says what the gateway says of it.
  await list.getByLabel("Skriv en tid").fill("11:30");
  await list.getByRole("button", { name: "Flytta markören" }).click();
  await expect(status).toContainText(/11:30–12:30: /);

  // A button lays the lesson at the time it names, with the page's own write: no drag, no marker.
  await buttons.first().click();
  await expect.poll(() => written.length).toBe(1);
  expect(written[0]!.id).toBe(MATH_LESSON.id);
  expect(Object.keys(written[0]!.body).sort()).toEqual(["dayOfWeek", "endTime", "expected", "startTime"]);
  expect(misses, MISSES).toEqual([]);
});

test("Grundschemat on a phone: Justera lektion lists the possible times, and a button fills the fields, with nothing dragged", async ({ page, baseURL }) => {
  const { misses, asked } = await open(page, baseURL!, { width: 375, height: 812 }, "light");
  await page.getByRole("button", { name: /^Måndag: 4 lektioner/ }).click();
  await card(page, MATH_LESSON.id).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // Closed until opened, and nothing asked of the gateway before.
  expect(asked).toEqual([]);
  await dialog.getByText("Möjliga tider", { exact: true }).click();
  const first = dialog.getByRole("button", { name: /^1\. / });
  await expect(first).toBeVisible();
  expect(asked).toHaveLength(1);
  const chosen = (await first.textContent())!;
  const times = /(\d\d:\d\d)–(\d\d:\d\d)/.exec(chosen)!;
  await first.click();
  await expect(dialog.getByLabel("Start")).toHaveValue(times[1]!);
  await expect(dialog.getByLabel("Slut")).toHaveValue(times[2]!);
  await expect(first).toHaveAttribute("aria-pressed", "true");
  // The rooms for that time, ranked, and a button fills the Sal field.
  await dialog.getByText("Salar för den här tiden", { exact: true }).click();
  const rooms = dialog.getByRole("list").nth(1).getByRole("button");
  await expect(rooms.first()).toBeVisible();
  expect(await rooms.count()).toBeGreaterThan(2);
  const second = rooms.nth(1);
  await second.click();
  await expect(second).toHaveAttribute("aria-pressed", "true");
  const roomName = (await second.locator("span").first().textContent())!.replace(/\d+ platser.*$/, "").replace(/\d+ plats.*$/, "").trim();
  await expect(dialog.getByRole("combobox", { name: "Sal" })).toContainText(roomName.split(" ")[0]!);
  // The button is a finger's size and the dialog does not scroll sideways under it.
  const box = (await first.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  const scan = await scanBothSchemes(page, "justera-lektion-mojliga-tider", true);
  expect(scan, scan.join("\n")).toEqual([]);
  expect(await page.evaluate(() => window.__pointerPresses), "taps, never a drag").toBeGreaterThan(0);
  expect(misses, MISSES).toEqual([]);
});

test("Grundschemat: a click is a press and a let go, and asks the gateway nothing", async ({ page, baseURL }) => {
  const { asked } = await open(page, baseURL!, { width: 1280, height: 800 }, "light");
  await card(page, MATH_LESSON.id).click();
  await page.waitForTimeout(400);
  expect(asked).toEqual([]);
});

test("Grundschemat: the painting passes axe in both themes, and a phone with a wide font does not scroll sideways under it", async ({ page, baseURL }) => {
  const { misses } = await open(page, baseURL!, { width: 1280, height: 800 }, "light");
  await card(page, MATH_LESSON.id).focus();
  await page.keyboard.press("Space");
  await expect(page.locator("[data-possible-day]").first()).toBeAttached();
  const desk = await scanBothSchemes(page, "timetable-possible", true);
  expect(desk, desk.join("\n")).toEqual([]);

  await page.setViewportSize({ width: 375, height: 812 });
  await page.addStyleTag({ content: WIDE_FONT });
  await expect(page.locator("[data-possible-day]").first()).toBeAttached();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), "the page scrolls sideways on a phone").toBe(false);
  expect(misses, MISSES).toEqual([]);
});
