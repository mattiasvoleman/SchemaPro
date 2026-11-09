import { expect, test, type Locator, type Page } from "@playwright/test";
import { askForScenario, freezeClock, settle, signIn, watchStubMisses } from "./signed-in";
import { SHARED_PLACEMENTS_SCENARIO, SHARED_POST, SHARED_POST_SHAPE } from "./stub/fixtures/timplan-placements";
import { STUB_ORIGIN } from "./stub/sessions";
import { TEACHERS } from "./stub/fixtures/world";

/**
 * Förlägg on a post that shares its lessons between teachers, where its fields
 * and its lines stand.
 *
 * What the dialog offers (a teacher per lesson, the lengths that teacher has,
 * who has a lesson left) is placement-dialog.test.tsx's, in jsdom. jsdom has no
 * layout, so what is asked here is what only a browser can say: the "Lärare"
 * field and the line that counts each teacher's placed lessons are inside the
 * dialog at a phone's width as at a desk's, a label stands above its field, the
 * rows and what follows them do not overlap, and nothing makes the dialog or
 * the page scroll sideways. And that the choices reach the gateway: choosing a
 * teacher limits the lengths, the add button gives the new row to the teacher
 * who has a lesson left, and every row is sent with its teacher.
 *
 * The post is the fixture school's Biologi för 7A in the scenario that shares
 * it (e2e/stub/fixtures/timplan-placements.ts): four lessons, Cecilia's one of
 * 60, Bo's of 60 and 40, and one of 60 whose teacher was deleted. Two are
 * placed. The browser is told the post has four lessons of two lengths in what
 * it reads of the table, because PostgREST knows no scenario.
 */

const REQUIREMENTS = "/sv/admin/requirements";
const MISSES = "the backend stub could not answer these reads; each says which file to add it to or fix";

const VIEWPORTS = [
  { name: "1280×800", width: 1280, height: 800 },
  { name: "375×812", width: 375, height: 812 },
];

/** A dialog once it has zoomed in: a box measured mid-animation is 95 % of itself. */
async function settled(dialog: Locator) {
  await expect(dialog).toBeVisible();
  await dialog.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
  return dialog;
}

/** The browser's read of the table, with the shared post made the four lessons of two lengths the scenario shares. */
async function shapeTheSharedPost(page: Page) {
  await page.route(`${STUB_ORIGIN}/rest/v1/TeachingRequirements*`, async (route) => {
    const response = await route.fetch();
    if (!(response.headers()["content-type"] ?? "").includes("json")) return route.fulfill({ response });
    const rows = (await response.json()) as unknown;
    if (!Array.isArray(rows)) return route.fulfill({ response });
    const shaped = rows.map((row: { id?: string }) => (row.id === SHARED_POST.id ? { ...row, ...SHARED_POST_SHAPE } : row));
    await route.fulfill({ response, body: JSON.stringify(shaped) });
  });
}

async function openPlacement(page: Page, baseURL: string, size: { width: number; height: number }) {
  await signIn(page.context(), "admin", baseURL);
  await freezeClock(page);
  await askForScenario(page, SHARED_PLACEMENTS_SCENARIO);
  const misses = watchStubMisses(page);
  await shapeTheSharedPost(page);
  await page.setViewportSize(size);
  await page.goto(REQUIREMENTS);
  await settle(page);
  // The post's own cell (the marks of its placed lessons follow its name), not 7A's empty Biologi cells beside it.
  await page.getByRole("button", { name: /^Biologi för 7A: 3 lektioner à 60 minuter och 1 lektion à 40 minuter/ }).click();
  const cell = await settled(page.getByRole("dialog"));
  await cell.getByRole("button", { name: "Förlägg …" }).click();
  const dialog = await settled(page.getByRole("dialog", { name: /^Förlägg 7A/ }));
  // The rows are read once the second one is there.
  await expect(dialog.getByRole("group", { name: /^Lektion 2/ })).toBeVisible();
  return { dialog, misses };
}

const row = (dialog: Locator, n: number) => dialog.getByRole("group", { name: new RegExp(`^Lektion ${n}`) });
const teacherOf = (dialog: Locator, n: number) => row(dialog, n).getByLabel("Lärare", { exact: true });
const lengthsOf = (dialog: Locator, n: number) => row(dialog, n).getByLabel("Längd", { exact: true });
const addButton = (dialog: Locator) => dialog.getByRole("button", { name: "Lägg till lektion" });
const optionsOf = (select: Locator) => select.locator("option").allInnerTexts();

/** Every box the layout promises something about, read in one pass. */
function layout(dialog: Locator) {
  return dialog.evaluate((root) => {
    const box = (element: Element | null | undefined) => {
      if (!element) throw new Error("an element the layout check needs is missing");
      const { top, bottom, left, right } = element.getBoundingClientRect();
      return { top, bottom, left, right };
    };
    const rows = [...root.querySelectorAll("fieldset")]
      .filter((fieldset) => fieldset.querySelector(":scope > legend") !== null)
      .map((fieldset) => ({
        row: box(fieldset),
        label: box(fieldset.querySelector("label[for*='-teacher-']")),
        teacher: box(fieldset.querySelector("select[id*='-teacher-']")),
        fields: [...fieldset.querySelectorAll("select, input, button")].map((control) => box(control)),
      }));
    const paragraph = (start: string) => [...root.querySelectorAll("p, div")].find((p) => p.textContent?.startsWith(start));
    return {
      dialog: box(root),
      rows,
      counts: box(paragraph("Förlagda lektioner per lärare")),
      add: box([...root.querySelectorAll("button")].find((button) => button.textContent?.includes("Lägg till lektion"))),
      scrollsSideways: root.scrollWidth > root.clientWidth,
      pageScrollsSideways: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
}

type Layout = Awaited<ReturnType<typeof layout>>;

/** Half a pixel for subpixel rounding: boxes are compared, not drawn. */
const EPS = 0.5;

function expectInFlow(facts: Layout, where: string) {
  const inside = (box: { left: number; right: number }) =>
    box.left >= facts.dialog.left - EPS && box.right <= facts.dialog.right + EPS;
  expect(inside(facts.counts), `${where}: the count per teacher is inside the dialog`).toBe(true);
  expect(facts.rows.length, `${where}: the rows`).toBeGreaterThan(0);
  expect(facts.counts.bottom, `${where}: the count stands above the first row`).toBeLessThanOrEqual(facts.rows[0]!.row.top + EPS);
  facts.rows.forEach((fact, index) => {
    const at = `${where}, row ${index + 1}`;
    expect(inside(fact.row), `${at}: the row is inside the dialog`).toBe(true);
    expect(inside(fact.teacher), `${at}: the teacher field is inside the dialog`).toBe(true);
    for (const field of fact.fields) {
      expect(field.right, `${at}: no field past the row's edge`).toBeLessThanOrEqual(fact.row.right + EPS);
      expect(field.left, `${at}: no field before the row's edge`).toBeGreaterThanOrEqual(fact.row.left - EPS);
    }
    expect(fact.label.bottom, `${at}: "Lärare" stands above its field`).toBeLessThanOrEqual(fact.teacher.top + EPS);
    expect(fact.teacher.bottom, `${at}: the field is inside its row`).toBeLessThanOrEqual(fact.row.bottom + EPS);
    const below = facts.rows[index + 1]?.row ?? facts.add;
    expect(fact.row.bottom, `${at}: the row ends above what follows it`).toBeLessThanOrEqual(below.top + EPS);
  });
  expect(inside(facts.add), `${where}: the add button is inside the dialog`).toBe(true);
  expect(facts.scrollsSideways, `${where}: the dialog does not scroll sideways`).toBe(false);
  expect(facts.pageScrollsSideways, `${where}: the page does not scroll sideways`).toBe(false);
}

for (const size of VIEWPORTS) {
  test(`Förlägg a shared post at ${size.name}: the teacher field and the count per teacher stand inside the dialog`, async ({
    page,
    baseURL,
  }) => {
    const { dialog, misses } = await openPlacement(page, baseURL!, size);

    // Each row says whose lesson it is, among the post's teachers that have a part, and not the part nobody has.
    for (const n of [1, 2]) await expect(teacherOf(dialog, n)).toBeVisible();
    expect(await optionsOf(teacherOf(dialog, 1))).toEqual(["Välj lärare", "Cecilia Ås", "Bo Ek"]);
    await expect(teacherOf(dialog, 1)).toHaveValue(TEACHERS.cecilia.id);
    await expect(teacherOf(dialog, 2)).toHaveValue(TEACHERS.bo.id);

    // The line counts each teacher's placed lessons against their part, and the part nobody teaches is said apart.
    await expect(dialog.getByText("Förlagda lektioner per lärare: Cecilia Ås 1 av 1, Bo Ek 1 av 2.")).toBeVisible();
    await expect(dialog.getByText(/^1 lektion utan lärare behöver en lärare innan den kan förläggas/)).toBeVisible();

    expectInFlow(await layout(dialog), "two rows");
    expect(misses, MISSES).toEqual([]);
  });

  test(`Förlägg a shared post at ${size.name}: choosing a teacher limits the lengths to theirs`, async ({ page, baseURL }) => {
    const { dialog, misses } = await openPlacement(page, baseURL!, size);

    // Cecilia has one lesson of 60, Bo one of 60 and one of 40.
    expect(await optionsOf(lengthsOf(dialog, 1))).toEqual(["60 min"]);
    expect(await optionsOf(lengthsOf(dialog, 2))).toEqual(["60 min", "40 min"]);
    await expect(lengthsOf(dialog, 2)).toHaveValue("40");

    // Bo takes the first row: his lengths, and the row keeps its 60.
    await teacherOf(dialog, 1).selectOption({ label: "Bo Ek" });
    expect(await optionsOf(lengthsOf(dialog, 1))).toEqual(["60 min", "40 min"]);
    await expect(lengthsOf(dialog, 1)).toHaveValue("60");

    // Cecilia takes the second, who has no lesson of 40: hers, 60.
    await teacherOf(dialog, 2).selectOption({ label: "Cecilia Ås" });
    expect(await optionsOf(lengthsOf(dialog, 2))).toEqual(["60 min"]);
    await expect(lengthsOf(dialog, 2)).toHaveValue("60");

    // The count follows the rows.
    await expect(dialog.getByText("Förlagda lektioner per lärare: Cecilia Ås 1 av 1, Bo Ek 1 av 2.")).toBeVisible();
    expectInFlow(await layout(dialog), "after the choices");
    expect(misses, MISSES).toEqual([]);
  });

  test(`Förlägg a shared post at ${size.name}: the add button gives a row to the teacher with a lesson left, and closes when none has`, async ({
    page,
    baseURL,
  }) => {
    const { dialog, misses } = await openPlacement(page, baseURL!, size);

    // Cecilia's lesson and one of Bo's two are placed: his other is the one left.
    await expect(addButton(dialog)).toBeEnabled();
    await addButton(dialog).click();
    await expect(row(dialog, 3)).toBeVisible();
    await expect(teacherOf(dialog, 3)).toHaveValue(TEACHERS.bo.id);
    await expect(lengthsOf(dialog, 3)).toHaveValue("60");
    await expect(dialog.getByText("Förlagda lektioner per lärare: Cecilia Ås 1 av 1, Bo Ek 2 av 2.")).toBeVisible();

    // Every lesson that has a teacher is placed; the one nobody teaches cannot be.
    await expect(addButton(dialog)).toBeDisabled();
    await expect(dialog.getByText("Alla lektioner som har en lärare är förlagda.")).toBeVisible();
    await expect(dialog.getByText(/^1 lektion utan lärare behöver en lärare/)).toBeVisible();

    expectInFlow(await layout(dialog), "three rows");
    expect(misses, MISSES).toEqual([]);
  });

  test(`Förlägg a shared post at ${size.name}: every row is sent with its teacher`, async ({ page, baseURL }) => {
    const { dialog, misses } = await openPlacement(page, baseURL!, size);

    await addButton(dialog).click();
    await row(dialog, 3).getByLabel("Starttid", { exact: true }).fill("14:00");
    await row(dialog, 3).getByLabel("Sal", { exact: true }).selectOption({ label: "Sal 101" });

    const sent = page.waitForRequest((request) => request.method() === "PUT" && request.url().includes("/placements"));
    await dialog.getByRole("button", { name: "Spara" }).click();

    const body = (await sent).postDataJSON() as { placements: { teacherId?: string; minutes: number }[] };
    expect(body.placements.map((placement) => placement.teacherId)).toEqual([
      TEACHERS.cecilia.id,
      TEACHERS.bo.id,
      TEACHERS.bo.id,
    ]);
    expect(body.placements.map((placement) => placement.minutes)).toEqual([60, 40, 60]);
    await expect(dialog).toBeHidden();
    expect(misses, MISSES).toEqual([]);
  });
}
