import { expect, test, type Page } from "@playwright/test";
import { expectAriaBaseline } from "./aria-baseline";
import { scanBothSchemes } from "./axe";
import { freezeClock, settle, signIn, watchStubMisses } from "./signed-in";
import { SHARE_TOKEN } from "./stub/fixtures/gateway-public";
import { CALENDAR_LESSON_TEACHERS, CALENDAR_LESSONS, GROUPS, TEACHERS } from "./stub/fixtures/world";
import type { Persona } from "./stub/sessions";

/**
 * What a screen reader is told on the screens each role works in: the
 * accessibility tree (roles, names, headings and their levels, states, live
 * regions) of the key screens, held against e2e/aria-baselines/. A change to
 * any of it fails here and shows as a diff of that file, to be read like code:
 * a lost name, a heading that skipped a level or a button that became a
 * generic element is a regression even when axe has no rule for it.
 *
 * The screens follow the main tasks of docs/skarmlasartest.md, the script for
 * the recorded pass a person does with VoiceOver or NVDA.
 */

const annasLesson = CALENDAR_LESSONS.find(
  (lesson) =>
    lesson.status === "SCHEDULED" &&
    CALENDAR_LESSON_TEACHERS.some((row) => row.calendarLessonId === lesson.id && row.teacherId === TEACHERS.anna.id),
)!;

interface Screen {
  name: string;
  url: string;
  persona: Persona | null;
  /**
   * What to take the tree of: the page's own content, everything (shell
   * included), or a CSS selector for part of it.
   */
  scope: string;
}

const SCREENS: Screen[] = [
  { name: "public-login", url: "/sv/login", persona: null, scope: "body" },
  { name: "public-tillganglighet", url: "/sv/tillganglighet", persona: null, scope: "body" },
  { name: "public-schemavisaren", url: `/v/${SHARE_TOKEN}?target=${GROUPS.g7A.id}`, persona: null, scope: "body" },
  // The frame's own order: the week's links, then the way out.
  { name: "public-schemavisaren-ram", url: `/v/${SHARE_TOKEN}/embed?target=${GROUPS.g7A.id}`, persona: null, scope: "body" },
  // The shell once per role, through the one page every role has.
  { name: "admin-notiser", url: "/sv/notifications", persona: "admin", scope: "body" },
  { name: "teacher-notiser", url: "/sv/notifications", persona: "teacher", scope: "body" },
  { name: "student-notiser", url: "/sv/notifications", persona: "student", scope: "body" },
  { name: "guardian-notiser", url: "/sv/notifications", persona: "guardian", scope: "body" },
  // The heading and the shortcuts: the counts are rendered on the Next.js
  // server with the real day, which no spec can freeze.
  { name: "admin-oversikt", url: "/sv/admin", persona: "admin", scope: "main h1, main section" },
  { name: "admin-personer", url: "/sv/admin/people", persona: "admin", scope: "main" },
  { name: "admin-schema", url: "/sv/admin/timetable", persona: "admin", scope: "main" },
  { name: "admin-ledighet", url: "/sv/admin/leave", persona: "admin", scope: "main" },
  { name: "admin-vikarier", url: "/sv/admin/cover", persona: "admin", scope: "main" },
  { name: "teacher-schema", url: "/sv/teacher", persona: "teacher", scope: "main" },
  { name: "teacher-narvaro", url: `/sv/teacher/attendance/${annasLesson.id}`, persona: "teacher", scope: "main" },
  { name: "teacher-franvaro", url: "/sv/teacher/franvaro", persona: "teacher", scope: "main" },
  // The mentor's inbox (#142): Ella's three days are Anna's to decide.
  { name: "teacher-ledighet", url: "/sv/teacher/ledighet", persona: "teacher", scope: "main" },
  { name: "student-schema", url: "/sv/student", persona: "student", scope: "main" },
  { name: "student-narvaro", url: "/sv/student/attendance", persona: "student", scope: "main" },
  { name: "guardian-barn", url: "/sv/guardian", persona: "guardian", scope: "main" },
];

const MISSES = "the backend stub could not answer these reads; each says which file to add it to or fix";

/** Opens a screen; the misses it returns keep collecting, for a test that clicks on. */
async function open(page: Page, screen: Pick<Screen, "url" | "persona">, baseURL: string) {
  if (screen.persona) await signIn(page.context(), screen.persona, baseURL);
  await freezeClock(page);
  const misses = watchStubMisses(page);
  await page.goto(screen.url);
  await settle(page);
  expect(misses, MISSES).toEqual([]);
  return misses;
}

for (const screen of SCREENS) {
  test(`the accessibility tree of ${screen.name} is the reviewed one`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(page, screen, baseURL!);
    await expectAriaBaseline(page.locator(screen.scope), screen.name);
  });
}

test("the menu drawer on a phone is a named modal dialog that holds the menu, and passes axe open", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, { url: "/sv/teacher", persona: "teacher" }, baseURL!);
  await page.getByRole("button", { name: "Öppna meny" }).click();
  const drawer = page.getByRole("dialog");
  await expect(drawer).toBeVisible();
  await expectAriaBaseline(drawer, "teacher-menylada");
  // And axe, open, in both themes: the page scans see it closed.
  expect((await scanBothSchemes(page, "drawer open", true)).join("\n"), "WCAG 2.1 AA violations").toBe("");
  await expect(drawer).toBeVisible();
});

test("the notification menu names its unread count, lists the notices, and passes axe open", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page, { url: "/sv/guardian", persona: "guardian" }, baseURL!);
  const bell = page.getByRole("button", { name: /^Notiser/ });
  await expect(bell).toHaveAccessibleName(/^Notiser, \d+ olästa?$/);
  await bell.click();
  await expectAriaBaseline(page.getByRole("menu"), "guardian-notismeny");
  expect((await scanBothSchemes(page, "menu open", true)).join("\n"), "WCAG 2.1 AA violations").toBe("");
  await expect(page.getByRole("menu")).toBeVisible();
});

test("the parallel blocks panel on Timplansposter names its block and what each action does, and passes axe open", async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const misses = await open(page, { url: "/sv/admin/requirements", persona: "admin" }, baseURL!);
  // The panel and its read load on the toggle, not with the page (#144).
  await page.getByRole("button", { name: "Block", exact: true }).click();
  const panel = page.getByRole("region", { name: "Parallella block" });
  await expect(panel.getByRole("button", { name: "Ändra lektionerna i blocket Språkval åk 7" })).toBeVisible();
  await settle(page);
  expect(misses, MISSES).toEqual([]);
  await expectAriaBaseline(panel, "admin-block");
  expect((await scanBothSchemes(page, "blocks open", true)).join("\n"), "WCAG 2.1 AA violations").toBe("");
});

test("a parallel block on the grundschema is one card, and its dialog names each lesson and the lock, and passes axe open", async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const misses = await open(page, { url: "/sv/admin/timetable", persona: "admin" }, baseURL!);
  // Språkval åk 7's hour on Thursday: both groups' lessons on one card, which
  // its module draws once the timplan names a block (Block i schemat).
  const card = page.getByRole("button", { name: /Språkval åk 7/ });
  await expect(card).toHaveCount(1);
  await card.click();
  const dialog = page.getByRole("dialog", { name: "Språkval åk 7" });
  await expect(dialog.getByRole("button", { name: "Lås blocket" })).toBeVisible();
  await settle(page);
  expect(misses, MISSES).toEqual([]);
  await expectAriaBaseline(dialog, "admin-blockkort");
  expect((await scanBothSchemes(page, "block card open", true)).join("\n"), "WCAG 2.1 AA violations").toBe("");
});
