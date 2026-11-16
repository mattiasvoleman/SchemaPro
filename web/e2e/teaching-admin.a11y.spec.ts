import { expect, test } from "@playwright/test";
import { DESKTOP, PHONE, scanBothSchemes } from "./axe";
import { freezeClock, settle, signInAs, watchStubMisses } from "./signed-in";
import { TEACHING_ADMIN_LESSON_TEACHERS } from "./stub/fixtures/world";
import { STUB_ORIGIN, TEACHING_ADMIN } from "./stub/sessions";

/**
 * Administratör som lärare: the pages of the group "Min undervisning", read as
 * the administrator who carries Users.teaches, in both schemes at desktop and
 * phone width, and the switch that sets the mark on Personer.
 *
 * Two things at once. axe reads each page as she reads it, which the signed-in
 * scan of the routes (a11y-app.spec.ts) never does: that opens them as a teacher
 * or as an administrator, never as the one person who has both. And every page
 * must be answered in full by the stub: a page whose read was refused her
 * (a route the gateway admits only a teacher to) draws an error card, and an
 * error card is a page axe passes, so the misses are held empty as well, and no
 * request goes to a route that is a teacher's alone.
 */

const MISSES = "the backend stub could not answer these reads; each says which file to add it to or fix";
const LESSON = TEACHING_ADMIN_LESSON_TEACHERS[0]!.calendarLessonId;

/** Her seven pages, the lesson page they open and the register of a lesson she stands on. */
const PAGES = [
  { name: "Mitt schema", url: "/sv/teacher", heading: "Mitt schema" },
  { name: "Larm", url: "/sv/teacher/crisis", heading: "Larm" },
  { name: "Närvaro", url: "/sv/teacher/attendance", heading: "Närvaro" },
  { name: "Närvaro på en lektion", url: `/sv/teacher/attendance/${LESSON}`, heading: null },
  { name: "Min tjänst", url: "/sv/teacher/tjanst", heading: "Min tjänst" },
  { name: "Min frånvaro", url: "/sv/teacher/franvaro", heading: "Min frånvaro" },
  { name: "Ledighet", url: "/sv/teacher/ledighet", heading: "Ledighet" },
  { name: "Min rapportering", url: "/sv/teacher/reporting-rate", heading: "Min rapportering" },
  { name: "Lektionen", url: `/sv/teacher/lektion/${LESSON}`, heading: null },
] as const;

for (const entry of PAGES) {
  test(`${entry.name} as an administrator who teaches: answered in full, no refused read, axe clean`, async ({ page, context, baseURL }) => {
    test.slow();
    await signInAs(context, TEACHING_ADMIN, baseURL!);
    await freezeClock(page);
    const misses = watchStubMisses(page);
    // The reads this person must never make: the colleague side of the cover requests is a teacher's alone (SP409).
    const refusedRoutes: string[] = [];
    page.on("request", (request) => {
      const { pathname } = new URL(request.url());
      if (request.url().startsWith(STUB_ORIGIN) && /\/api\/v1\/cover-requests\//.test(pathname)) refusedRoutes.push(`${request.method()} ${pathname}`);
    });

    await page.setViewportSize(DESKTOP);
    await page.goto(entry.url);
    await settle(page);
    if (entry.heading) await expect(page.getByRole("heading", { level: 1, name: entry.heading })).toBeVisible();
    expect.soft(misses, MISSES).toEqual([]);

    const results = await scanBothSchemes(page, `${entry.name} desktop`, true);
    await page.setViewportSize(PHONE);
    await settle(page);
    results.push(...(await scanBothSchemes(page, `${entry.name} phone`, true)));
    expect(results.join("\n"), "WCAG 2.1 AA violations").toBe("");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, "the page scrolls sideways on a phone").toBeLessThanOrEqual(0);
    expect(refusedRoutes, "reads of a teacher's alone route").toEqual([]);
  });
}

test("Mitt schema holds the lessons she stands on, and the other suites' school has none of them", async ({ page, context, baseURL }) => {
  await signInAs(context, TEACHING_ADMIN, baseURL!);
  await freezeClock(page);
  const misses = watchStubMisses(page);
  await page.setViewportSize(DESKTOP);
  await page.goto("/sv/teacher");
  await settle(page);
  // Tuesday's English in 7A and mathematics in 7B, which she stands on as a second teacher.
  await expect(page.getByText("Engelska").first()).toBeVisible();
  await expect(page.getByText("Matematik").first()).toBeVisible();
  expect(misses, MISSES).toEqual([]);
});

test("the lesson she stands on is hers as the lesson's own teacher: the note to the substitute is read and written", async ({
  page,
  context,
  baseURL,
}) => {
  await signInAs(context, TEACHING_ADMIN, baseURL!);
  await freezeClock(page);
  const misses = watchStubMisses(page);
  await page.setViewportSize(DESKTOP);
  await page.goto(`/sv/teacher/lektion/${LESSON}`);
  await settle(page);
  await expect(page.getByRole("textbox", { name: /^Notis/ })).toBeEditable();
  await expect(page.getByRole("link", { name: "Ta närvaro" })).toBeVisible();
  expect(misses, MISSES).toEqual([]);
});

test("Larm leads to the leadership's view, and Ledighet shows the pupil she is mentor of and no other", async ({ page, context, baseURL }) => {
  await signInAs(context, TEACHING_ADMIN, baseURL!);
  await freezeClock(page);
  await page.setViewportSize(DESKTOP);
  await page.goto("/sv/teacher/crisis");
  await settle(page);
  await expect(page.getByRole("link", { name: "Ledningens vy" })).toHaveAttribute("href", "/sv/admin/crisis");

  await page.goto("/sv/teacher/ledighet");
  await settle(page);
  // Ella's three days are hers as a mentor; Ines's five are rektor's, and the school's other requests are not on her page.
  await expect(page.getByText("Ella Nord").first()).toBeVisible();
  await expect(page.getByText("Ines Vik")).toHaveCount(0);
});

test("Personer: the switch Undervisar on an administrator, with its explanation, passes axe in the open dialog", async ({ page, context, baseURL }) => {
  test.slow();
  await signInAs(context, TEACHING_ADMIN, baseURL!);
  await freezeClock(page);
  const misses = watchStubMisses(page);
  await page.setViewportSize(DESKTOP);
  await page.goto("/sv/admin/people");
  await settle(page);
  await page.getByRole("button", { name: /^Redigera Rut Rektorsson/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // The chooser is its own chunk, fetched when the person is an administrator.
  const mark = dialog.getByRole("switch", { name: "Undervisar" });
  await expect(mark).toBeVisible();
  await expect(mark).not.toBeChecked();
  await expect(mark).toHaveAccessibleDescription(/lärarens egna sidor och roll i larmet/);
  await settle(page);
  expect.soft(misses, MISSES).toEqual([]);

  const results = await scanBothSchemes(page, "people dialog desktop", true);
  await page.setViewportSize(PHONE);
  await settle(page);
  results.push(...(await scanBothSchemes(page, "people dialog phone", true)));
  expect(results.join("\n"), "WCAG 2.1 AA violations").toBe("");
});
