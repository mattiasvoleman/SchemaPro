import { expect, test, type Page } from "@playwright/test";
import { settle, signIn, watchStubMisses } from "./signed-in";
import { loadWorld, serveLoadWorld, type LoadLesson, type LoadWorld } from "./timetable-world";
import { STUB_ORIGIN } from "./stub/sessions";

/**
 * /admin/timetable with 800 lessons (e2e/timetable-world.ts): what the board does under the load it is built for.
 *
 * The page is drawn, a lesson is carried over the week by the pointer and put down, and the spec reads
 *
 *   - when the 800 cards are in the page (from the start of the navigation),
 *   - what the browser spent on 60 pointer moves of the carry (CDP Performance.getMetrics: script, style, layout, task),
 *   - what the person sees after the drop: when the card stands on its new square, and which requests had gone
 *     out and come back by then.
 *
 * The numbers are printed (E2_LOAD_REPORT, and as a test annotation) and are the measurement the PR text quotes.
 * They depend on the machine, so what the spec holds them to is what the person must see (every card, the card on
 * its square before the write is answered) and a ceiling that main's grid was over by four times and this one is
 * under by more than ten: the script a pointer move costs.
 * The count of cards drawn per pointer move is not read here, since a browser cannot see a render: it is
 * components/schedule/timetable-grid.render.test.tsx.
 */

const PAGE = "/sv/admin/timetable";
const READ_DELAY = Number(process.env.E2E_LOAD_READ_DELAY ?? 0);
// A round trip to the gateway: the write is answered this long after it is sent.
const WRITE_DELAY = Number(process.env.E2E_LOAD_WRITE_DELAY ?? 400);

interface Marks {
  drawnAt: number | null;
  paintedAt: number | null;
  upAt: number | null;
  movedAt: number | null;
  long: Array<[number, number]>;
}

declare global {
  interface Window {
    __load: Marks;
  }
}

/** The first free square for a lesson: its class, its teacher and its room are all free there. */
function squareFor(world: LoadWorld, lesson: LoadLesson): { day: number; startMinutes: number } {
  const busy = (field: "studentGroupId" | "teacherId" | "roomId", day: number, start: number) =>
    world.lessons.some(
      (other) => other.id !== lesson.id && other[field] === lesson[field] && other.dayOfWeek === day && other.startMinutes < start + 60 && start < other.startMinutes + 60,
    );
  for (let day = 2; day <= 5; day++) {
    for (let start = 480; start <= 900; start += 60) {
      if (!busy("studentGroupId", day, start) && !busy("teacherId", day, start) && !busy("roomId", day, start)) return { day, startMinutes: start };
    }
  }
  throw new Error("the world has no free square for the lesson");
}

async function open(page: Page, baseURL: string, world: LoadWorld) {
  await signIn(page.context(), "admin", baseURL);
  await serveLoadWorld(page, world, { read: READ_DELAY });
  // The write: the gateway's answer is the lesson as it now stands.
  await page.route(`${STUB_ORIGIN}/api/v1/master-lessons/*`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    const id = route.request().url().split("/").pop()!;
    const lesson = world.lessons.find((held) => held.id === id)!;
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if (WRITE_DELAY) await new Promise((resolve) => setTimeout(resolve, WRITE_DELAY));
    // The gateway remembers: the next read of the year has the lesson where it was put.
    if (typeof body.dayOfWeek === "number") lesson.dayOfWeek = body.dayOfWeek;
    if (typeof body.startTime === "string") {
      const [hours = 0, minutes = 0] = body.startTime.split(":").map(Number);
      lesson.startMinutes = hours * 60 + minutes;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id,
        academicYearId: "",
        subjectId: lesson.subjectId,
        studentGroupId: lesson.studentGroupId,
        teacherId: lesson.teacherId,
        coTeacherId: null,
        roomId: lesson.roomId,
        dayOfWeek: lesson.dayOfWeek,
        startTime: "08:00",
        endTime: "09:00",
        isLocked: false,
        isParked: false,
        recurrence: "ALL_WEEKS",
        startDate: null,
        endDate: null,
        extraGroupIds: [],
        studentIds: [],
        ...body,
        propagatedLessons: 0,
        removedCalendarLessons: 0,
        warnings: [],
      }),
    });
  });
  await page.addInitScript(() => {
    const marks: Marks = { drawnAt: null, paintedAt: null, upAt: null, movedAt: null, long: [] };
    window.__load = marks;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) marks.long.push([entry.startTime, entry.duration]);
    }).observe({ type: "longtask", buffered: true });
    const watch = new MutationObserver(() => {
      if (marks.drawnAt !== null || document.querySelectorAll("[data-lesson-id]").length < 800) return;
      marks.drawnAt = performance.now();
      requestAnimationFrame(() => requestAnimationFrame(() => (marks.paintedAt = performance.now())));
    });
    document.addEventListener("DOMContentLoaded", () => watch.observe(document.body, { childList: true, subtree: true }));
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(PAGE);
  await page.waitForFunction(() => window.__load.paintedAt !== null, undefined, { timeout: 60_000 });
}

test.describe("the board under 800 lessons", () => {
  test("draws the week, carries a lesson over it and puts it down on a square that stands at once", async ({ page, baseURL }) => {
    test.setTimeout(120_000);
    const world = loadWorld();
    const misses = watchStubMisses(page);
    await open(page, baseURL!, world);
    await settle(page);

    await expect(page.locator("[data-lesson-id]")).toHaveCount(800);
    const marks = await page.evaluate(() => ({ drawnAt: window.__load.drawnAt, paintedAt: window.__load.paintedAt }));

    // The lesson in hand, pressed at the middle of the first card: the lesson that is there (a day holds a
    // hundred and sixty, and a card is a twentieth of a column wide).
    const first = world.lessons[0]!;
    const firstCard = page.locator(`[data-lesson-id="${first.id}"]`);
    await firstCard.scrollIntoViewIfNeeded();
    const box = (await firstCard.boundingBox())!;
    const perMinute = box.height / 60;
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    const heldId = await page.evaluate(([x, y]) => (document.elementFromPoint(x!, y!) as HTMLElement | null)?.closest("[data-lesson-id]")?.getAttribute("data-lesson-id") ?? null, [startX, startY]);
    const lesson = world.lessons.find((held) => held.id === heldId)!;
    expect(lesson).toBeTruthy();
    const target = squareFor(world, lesson);
    const card = page.locator(`[data-lesson-id="${lesson.id}"]`);
    const body = await card.evaluate((element) => {
      // The grid's body: the box whose columns the lessons are placed in.
      const grid = element.closest("div.relative.grid")!.getBoundingClientRect();
      return { left: grid.left, top: grid.top, width: grid.width };
    });
    const dayWidth = (body.width - 56) / 5;

    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    const metrics = async () => Object.fromEntries(((await cdp.send("Performance.getMetrics")).metrics as Array<{ name: string; value: number }>).map((m) => [m.name, m.value]));

    // What 60 pointer moves cost with nothing in hand: the browser's own work of taking them in (hit-testing
    // 800 cards, :hover, the tooltip), the floor of the figure below.
    const idleFrom = await metrics();
    for (let step = 0; step < 60; step++) await page.mouse.move(startX + ((step % 2) * 6), startY + step);
    const idleTo = await metrics();
    await page.mouse.move(startX, startY);
    await page.mouse.down();

    // Sixty moves, each to a new place on the way to the square.
    const endX = body.left + 56 + (target.day - 0.5) * dayWidth;
    const endY = body.top + (target.startMinutes + 30 - 480) * perMinute;
    const before = await metrics();
    const moves = 60;
    for (let step = 1; step <= moves; step++) {
      await page.mouse.move(startX + ((endX - startX) * step) / moves, startY + ((endY - startY) * step) / moves);
    }
    const after = await metrics();
    const per = (name: string) => (((after[name] ?? 0) - (before[name] ?? 0)) * 1000) / moves;
    const idle = (name: string) => (((idleTo[name] ?? 0) - (idleFrom[name] ?? 0)) * 1000) / 60;
    const beforeDrop = await metrics();

    await page.evaluate(
      ({ id }) => {
        const marksOf = window.__load;
        const rectOf = () => document.querySelector(`[data-lesson-id="${id}"]`)?.getBoundingClientRect();
        const first = rectOf()!;
        marksOf.upAt = performance.now();
        const poll = () => {
          const now = rectOf();
          if (now && (Math.abs(now.top - first.top) > 2 || Math.abs(now.left - first.left) > 2)) {
            marksOf.movedAt = performance.now();
            return;
          }
          if (performance.now() - (marksOf.upAt ?? 0) < 10_000) requestAnimationFrame(poll);
        };
        requestAnimationFrame(poll);
      },
      { id: lesson.id },
    );
    await page.mouse.up();
    await page.waitForFunction(() => window.__load.movedAt !== null, undefined, { timeout: 15_000 });
    const atTheNewSquare = await metrics();
    // Long enough for a slow write to be answered, and for a read of the year (there is none to wait for any more).
    await page.waitForTimeout(WRITE_DELAY + 400);
    await settle(page);

    const done = await page.evaluate(() => {
      const upAt = window.__load.upAt!;
      return {
        movedAfter: window.__load.movedAt! - upAt,
        requests: performance
          .getEntriesByType("resource")
          .map((entry) => entry as PerformanceResourceTiming)
          .filter((entry) => entry.startTime >= upAt - 5 && /master-lessons|MasterLessons/.test(entry.name))
          .map((entry) => ({ what: `${entry.name.includes("MasterLessons") ? "read of the year" : "write"}`, from: Math.round(entry.startTime - upAt), to: Math.round(entry.responseEnd - upAt) })),
      };
    });

    const report = {
      load: { delays: { read: READ_DELAY, write: WRITE_DELAY } },
      cards: await page.locator("[data-lesson-id]").count(),
      cardsDrawnAtMs: Math.round(marks.drawnAt!),
      paintedAtMs: Math.round(marks.paintedAt!),
      longTasksBeforeTheDrag: await page.evaluate(() => window.__load.long.filter(([at]) => at < (window.__load.upAt ?? Infinity)).length),
      perPointerMoveMs: {
        task: Number(per("TaskDuration").toFixed(2)),
        script: Number(per("ScriptDuration").toFixed(2)),
        style: Number(per("RecalcStyleDuration").toFixed(2)),
        layout: Number(per("LayoutDuration").toFixed(2)),
      },
      perHoverMoveMs: { task: Number(idle("TaskDuration").toFixed(2)), script: Number(idle("ScriptDuration").toFixed(2)) },
      afterTheDrop: {
        cardOnItsNewSquareAfterMs: Math.round(done.movedAfter),
        scriptUntilThenMs: Math.round(((atTheNewSquare.ScriptDuration ?? 0) - (beforeDrop.ScriptDuration ?? 0)) * 1000),
        taskUntilThenMs: Math.round(((atTheNewSquare.TaskDuration ?? 0) - (beforeDrop.TaskDuration ?? 0)) * 1000),
        requests: done.requests,
      },
    };
    console.log(`E2_LOAD_REPORT ${JSON.stringify(report)}`);
    test.info().annotations.push({ type: "load-report", description: JSON.stringify(report) });

    expect(misses.filter((miss) => !/master-lessons/.test(miss))).toEqual([]);
    // The card is where it was put before the write has been answered. The ceiling is wide on purpose.
    expect(done.movedAfter).toBeLessThan(WRITE_DELAY > 0 ? WRITE_DELAY : 2_000);
    // A pointer move is a step of five minutes at most, and it asks the page whether the square is free and moves
    // the ghost: a fraction of a millisecond of script. The grid it replaced drew its 800 cards again for each one,
    // 7 ms of script on the machine this was measured on, and the ceiling is between the two.
    expect(report.perPointerMoveMs.script).toBeLessThan(2);
  });
});
