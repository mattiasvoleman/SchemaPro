import { expect, test, type Page } from "@playwright/test";
import { freezeClock, settle, signIn, watchStubMisses } from "./signed-in";
import { STUB_ORIGIN } from "./stub/sessions";
import { SUBJECTS } from "./stub/fixtures/world";

/**
 * Ämne on Timplansposter: the matrix narrowed to one subject, in a browser.
 *
 * The rule itself (which rows, which columns, which posts the sums count) is
 * lib/requirements-subject-filter.ts's and has its own tests; jsdom has no
 * layout, so what is asked here is what only a browser can say: the picker and
 * its checkbox fit the header beside Läsår without pushing the page sideways,
 * the one column's cells are where a pointer reaches them and not under the
 * pinned sums, and the address carries the choice.
 *
 * The fixture school (e2e/stub/fixtures/world.ts): Matematik is posted for 7A,
 * 7B and 9A and for no teaching group; 8A has none. The year has four classes
 * and five teaching groups, the two halves of 7A among them.
 */

const REQUIREMENTS = "/sv/admin/requirements";
const MISSES = "the backend stub could not answer these reads; each says which file to add it to or fix";

const VIEWPORTS = [
  { name: "1280×800", width: 1280, height: 800 },
  { name: "375×812", width: 375, height: 812 },
];

async function open(page: Page, baseURL: string, size: { width: number; height: number }, path = REQUIREMENTS) {
  await signIn(page.context(), "admin", baseURL);
  await freezeClock(page);
  const misses = watchStubMisses(page);
  await page.setViewportSize(size);
  await page.goto(path);
  await settle(page);
  await expect(page.getByRole("table")).toBeVisible();
  return misses;
}

async function chooseSubject(page: Page, name: string) {
  await page.getByRole("combobox", { name: "Ämne" }).click();
  await page.getByRole("option", { name, exact: true }).click();
  await expect(page.getByRole("listbox")).toBeHidden();
}

/** The table's column headers, as a reader moving along the header row hears them. */
const headers = (page: Page) => page.getByRole("table").getByRole("columnheader").allInnerTexts();

/**
 * What a pointer would hit at the centre of each cell button, and the page's
 * and the matrix's sideways scroll. A button under a pinned column still has
 * a box inside the window, so the box alone would not catch it.
 */
function reach(page: Page) {
  return page.evaluate(() => {
    const table = document.querySelector("table")!;
    const scroller = table.parentElement!;
    const cells = [...table.querySelectorAll("tbody td button")].map((button) => {
      // Into view as a reader would scroll to it; "nearest" sideways, so a
      // column pinned over it at every scroll position is still caught.
      button.scrollIntoView({ block: "center", inline: "nearest" });
      const { left, right, top, bottom } = button.getBoundingClientRect();
      const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
      return { name: button.getAttribute("aria-label") ?? "", reached: !!hit && button.contains(hit) };
    });
    window.scrollTo(0, 0);
    const header = document.querySelector("h1")!.parentElement!.parentElement!;
    const controls = [...header.querySelectorAll("button, label")].map((control) => {
      const { left, right } = control.getBoundingClientRect();
      return { text: control.textContent?.trim() ?? "", left, right };
    });
    return {
      cells,
      controls,
      viewport: window.innerWidth,
      pageScrollsSideways: document.documentElement.scrollWidth > window.innerWidth,
      matrixScrollsSideways: scroller.scrollWidth > scroller.clientWidth,
    };
  });
}

function expectReachable(facts: Awaited<ReturnType<typeof reach>>, where: string) {
  expect(facts.cells.length, `${where}: the matrix has cells`).toBeGreaterThan(0);
  for (const cell of facts.cells) expect(cell.reached, `${where}: ${cell.name} is on top where it is pressed`).toBe(true);
  for (const control of facts.controls) {
    expect(control.right, `${where}: "${control.text}" ends inside the window`).toBeLessThanOrEqual(facts.viewport + 0.5);
    expect(control.left, `${where}: "${control.text}" starts inside the window`).toBeGreaterThanOrEqual(-0.5);
  }
  expect(facts.pageScrollsSideways, `${where}: the page does not scroll sideways`).toBe(false);
}

for (const size of VIEWPORTS) {
  test(`Ämne at ${size.name}: one subject's column and its groups, every cell reachable`, async ({ page, baseURL }) => {
    const misses = await open(page, baseURL!, size);
    // Alla ämnen first: the page as it was, and no checkbox.
    await expect(page.getByRole("combobox", { name: "Ämne" })).toHaveText("Alla ämnen");
    await expect(page.getByRole("checkbox", { name: "Visa grupper utan post" })).toHaveCount(0);

    await chooseSubject(page, "Matematik");
    await expect(page).toHaveURL(new RegExp(`[?&]subject=${SUBJECTS.ma.id}(&|$)`));
    expect(await headers(page)).toEqual(["Klass", "MA", "Max / vecka i ämnet", "Timmar / läsår i ämnet"]);
    await expect(page.getByRole("table").getByText("Klasser (3 av 4)")).toBeVisible();
    await expect(page.getByRole("table").getByText(/^Undervisningsgrupper/)).toHaveCount(0);
    for (const name of ["7A", "7B", "9A"]) await expect(page.getByRole("rowheader", { name, exact: true })).toBeVisible();
    await expect(page.getByRole("rowheader", { name: "8A", exact: true })).toHaveCount(0);
    // Three posts of 3 × 60, all weeks: nine lessons in the school's busiest week of Matematik.
    await expect(page.getByRole("status").first()).toHaveText(/^I Matematik: 9 lektioner den tyngsta veckan · /);
    expectReachable(await reach(page), "Matematik");
    if (size.width < 768) {
      // One subject's column fits a phone: nothing scrolls under the pinned sums.
      expect((await reach(page)).matrixScrollsSideways, "the one-subject matrix does not scroll sideways at 375").toBe(false);
    }

    // The year's other groups, to add Matematik for 8A or a teaching group.
    await page.getByRole("checkbox", { name: "Visa grupper utan post" }).check();
    await expect(page.getByRole("table").getByText("Klasser (4 av 4)")).toBeVisible();
    await expect(page.getByRole("table").getByText("Undervisningsgrupper (5 av 5)")).toBeVisible();
    await expect(page.getByRole("button", { name: "Matematik för 8A" })).toBeVisible();
    expectReachable(await reach(page), "Matematik with every group");

    expect(misses, MISSES).toEqual([]);
  });

  test(`Ämne at ${size.name}: the address carries the subject, and the cell opens its own post`, async ({ page, baseURL }) => {
    const misses = await open(page, baseURL!, size, `${REQUIREMENTS}?subject=${SUBJECTS.bl.id}`);
    await expect(page.getByRole("combobox", { name: "Ämne" })).toHaveText("Bild");
    expect(await headers(page)).toEqual(["Klass", "BL", "Max / vecka i ämnet", "Timmar / läsår i ämnet"]);
    await page.getByRole("button", { name: "Bild för 8A: 1 lektion à 80 minuter" }).click();
    await expect(page.getByRole("dialog", { name: "8A · Bild" })).toBeVisible();
    await page.getByRole("button", { name: "Avbryt" }).click();

    // Alla ämnen takes the subject out of the address and every column back.
    await chooseSubject(page, "Alla ämnen");
    await expect(page).not.toHaveURL(/subject=/);
    expect((await headers(page)).length).toBe(1 + Object.keys(SUBJECTS).length + 2);

    expect(misses, MISSES).toEqual([]);
  });

  test(`Ämne at ${size.name}: an id that is no subject of the school reads as Alla ämnen`, async ({ page, baseURL }) => {
    const misses = await open(page, baseURL!, size, `${REQUIREMENTS}?subject=00000000-0000-4000-8000-000000000000`);
    await expect(page.getByRole("combobox", { name: "Ämne" })).toHaveText("Alla ämnen");
    expect((await headers(page)).length).toBe(1 + Object.keys(SUBJECTS).length + 2);
    expect(misses, MISSES).toEqual([]);
  });
}

// Review of #297, LÅG-5: the picker was 176 px, and "Samhällsorienterande ämnen" (26 characters, a name the national
// plan itself uses) read "Samhällsorienterande …" in it. The whole name stands in the sentence under the matrix, but
// the picker is where one reads which subject is chosen.
for (const size of [{ name: "320×800", width: 320, height: 800 }, ...VIEWPORTS]) {
  test(`Ämne at ${size.name}: the picker shows a long subject's whole name`, async ({ page, baseURL }) => {
    const LONG = "Samhällsorienterande ämnen";
    await page.route(`${STUB_ORIGIN}/**`, async (route) => {
      const response = await route.fetch();
      if (!(response.headers()["content-type"] ?? "").includes("json")) return route.fulfill({ response });
      await route.fulfill({ response, body: (await response.text()).replaceAll("Idrott och hälsa", LONG) });
    });
    const misses = await open(page, baseURL!, size);
    await chooseSubject(page, LONG);

    const picker = page.getByRole("combobox", { name: "Ämne" });
    await expect(picker).toContainText(LONG);
    const facts = await picker.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const text = element.firstElementChild!;
      const range = document.createRange();
      range.selectNodeContents(text);
      const rects = [...range.getClientRects()];
      return {
        pickerRight: box.right,
        textRight: Math.max(...rects.map((rect) => rect.right)),
        // The span clips to one line; text drawn past its own box is the cut name.
        spanRight: text.getBoundingClientRect().right,
        rows: new Set(rects.map((rect) => Math.round(rect.top))).size,
        pageScrollsSideways: document.documentElement.scrollWidth > window.innerWidth,
      };
    });
    expect(facts.rows, "the name is on one row").toBe(1);
    expect(facts.textRight, "the name ends inside the picker's own text box, not cut at its edge").toBeLessThanOrEqual(facts.spanRight + 1);
    expect(facts.textRight, "the name ends inside the picker").toBeLessThanOrEqual(facts.pickerRight + 0.5);
    expect(facts.pageScrollsSideways, "the page does not scroll sideways").toBe(false);
    expect(misses, MISSES).toEqual([]);
  });
}
