import { expect, test, type Page } from "@playwright/test";
import { DESKTOP, PHONE, scanBothSchemes, setScheme } from "./axe";
import { cardsOf } from "./card-edge";
import { freezeClock, settle, signIn, watchStubMisses } from "./signed-in";
import { PEOPLE } from "./stub/sessions";

/**
 * Undervisningsuppdragets omfattning (SFS 2026:1487), drawn by the browser gates. The report the stub answers carries the `scope` block (e2e/stub/fixtures/
 * staffing-load.ts), so that the cards it is drawn from are on a page for the first time in a gate: Min tjänst's "Omfattning enligt förordningen", and the two
 * cards of tjänstefördelningens lärarlåda, the scope card and the rektor's assessment ("Rektorns bedömning"). Neither the signed-in scan of the routes
 * (a11y-app.spec.ts: the page as it loads, the drawer closed) nor the accessibility-tree baselines draw the drawer, so this suite opens it.
 *
 * What is asked: that the page is answered in full (no read the stub could not answer), axe at desktop and phone width in both schemes, and that at 320 px no
 * element of a card reaches past the page's edge (measured on the card's own elements, as the Generera smoke specs do: the läsår choice in the header runs
 * past the edge at 320 px on pages that are not these, and scrollWidth would say so).
 */

const MISSES = "the backend stub could not answer these reads; each says which file to add it to or fix";
const NARROW = { width: 320, height: 700 };

/**
 * How many elements of the cards whose headings are `titles` reach past the page's left or right edge, how many cards were found and how many
 * elements were measured (e2e/card-edge.ts: the card is the section the heading is in, and the heading has an id of its own, so "the nearest
 * element with an id" is the heading itself).
 */
function beyondTheEdge(page: Page, titles: string[]) {
  return page.evaluate(cardsOf, titles);
}

async function scanAt(page: Page, label: string, reports: string[]) {
  await page.setViewportSize(DESKTOP);
  await settle(page);
  reports.push(...(await scanBothSchemes(page, `${label} desktop`, true)));
  await page.setViewportSize(PHONE);
  await settle(page);
  reports.push(...(await scanBothSchemes(page, `${label} phone`, true)));
}

test("Min tjänst: the scope card is drawn for a teacher, axe finds nothing on it, and at 320 px none of it reaches past the edge", async ({ page, context, baseURL }) => {
  test.slow();
  await signIn(context, "teacher", baseURL!);
  await freezeClock(page);
  const misses = watchStubMisses(page);
  await page.setViewportSize(DESKTOP);
  await setScheme(page, "light", false);
  const load = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/staffing/load");
  await page.goto("/sv/teacher/tjanst");
  await settle(page);
  // A teacher is answered with her own row of the report, scope included: a colleague's hours are HR data (as the gateway answers it).
  const answered = (await (await load).json()) as { scope: { teachers: { userId: string }[] } };
  expect(answered.scope.teachers.map((row) => row.userId)).toEqual([PEOPLE.teacher.userId]);
  await expect(page.getByRole("heading", { level: 1, name: "Min tjänst" })).toBeVisible();
  const card = page.locator("#scope-card");
  await expect(card.getByRole("heading", { level: 2, name: "Omfattning enligt förordningen" })).toBeVisible();
  // Anna Lind's hours are all in årskurs 7-9, and within the ordinance's highest level for her post.
  await expect(card).toContainText("Inte över förordningens högsta nivå");
  await expect(card).toContainText("SFS 2026:1487");
  expect.soft(misses, MISSES).toEqual([]);

  const reports: string[] = [];
  await scanAt(page, "Min tjänst", reports);
  await setScheme(page, "light", true);
  await page.setViewportSize(NARROW);
  await settle(page);
  const edge = await beyondTheEdge(page, ["Omfattning enligt förordningen"]);
  expect(edge, "the card, measured whole (a heading alone is one element)").toMatchObject({ cards: 1, beyond: 0 });
  expect(edge.measured, "elements of the card measured").toBeGreaterThan(10);
  reports.push(...(await scanBothSchemes(page, "Min tjänst 320", true)));
  expect(reports.join("\n"), "WCAG 2.1 AA violations").toBe("");
});

for (const teacher of [
  { name: "Bo Ek", says: "Över förordningens högsta nivå med" },
  { name: "Anna Lind", says: "Inte över förordningens högsta nivå" },
  { name: "David Berg", says: "Ingen tjänst registrerad" },
]) {
  test(`tjänstefördelningens lärarlåda for ${teacher.name}: the scope card and the rektor's assessment are drawn, axe finds nothing, and at 320 px none of it reaches past the edge`, async ({ page, context, baseURL }) => {
    test.slow();
    await signIn(context, "admin", baseURL!);
    await freezeClock(page);
    const misses = watchStubMisses(page);
    await page.setViewportSize(DESKTOP);
    await setScheme(page, "light", false);
    await page.goto("/sv/admin/staffing");
    await settle(page);
    await page.getByRole("button", { name: `Visa ${teacher.name}` }).click();
    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();
    const card = drawer.locator("#scope-card");
    await expect(card.getByRole("heading", { level: 3, name: "Omfattning enligt förordningen" })).toBeVisible();
    await expect(card).toContainText(teacher.says);
    await expect(drawer.getByRole("heading", { name: "Rektorns bedömning" })).toBeVisible();
    expect.soft(misses, MISSES).toEqual([]);

    const reports: string[] = [];
    await scanAt(page, `drawer of ${teacher.name}`, reports);
    await setScheme(page, "light", true);
    await page.setViewportSize(NARROW);
    await settle(page);
    const edge = await beyondTheEdge(page, ["Omfattning enligt förordningen", "Rektorns bedömning"]);
    expect(edge.cards, "the two cards of the drawer").toBe(2);
    expect(edge.measured, "elements of the two cards measured: more than their headings").toBeGreaterThan(15);
    expect(edge.beyond, "elements of the cards past the page's edge at 320 px").toBe(0);
    reports.push(...(await scanBothSchemes(page, `drawer of ${teacher.name} 320`, true)));
    expect(reports.join("\n"), "WCAG 2.1 AA violations").toBe("");
  });
}
