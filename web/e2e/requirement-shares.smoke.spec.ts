import { expect, test, type Locator, type Page } from "@playwright/test";
import { freezeClock, settle, signIn, watchStubMisses } from "./signed-in";
import { STUB_ORIGIN } from "./stub/sessions";

/**
 * Delade lektioner in the requirement dialog, where each row's fields stand.
 *
 * Reported from production: with a teacher chosen on a row, the name sat on
 * top of the row's label "Lärare", and the red "… min/v över mål" under the
 * picker was covered by "Lägg till lärare". Nothing was positioned: the
 * picker's box was a fixed 36 px, and the chosen teacher's line (name,
 * behörighet badge, minutes; candidateLine in the page) wraps to three rows
 * in the row's narrow column. Centred in the box and not clipped, it stuck
 * out 18 px above and below. jsdom has no layout, so only a browser can say
 * where a box is; that is what this file is for.
 *
 * Asked of every row: the chosen value inside the picker's box, the label
 * above the picker, the remove button level with the row's other fields,
 * nothing past the fieldset's edge, and each row above the next one, the
 * add button under the last and the line under the rows (problem or sums)
 * under the add button.
 */

const REQUIREMENTS = "/sv/admin/requirements";
const MISSES = "the backend stub could not answer these reads; each says which file to add it to or fix";

const VIEWPORTS = [
  { name: "1280×800", width: 1280, height: 800 },
  { name: "375×812", width: 375, height: 812 },
];

async function openShares(page: Page, baseURL: string, size: { width: number; height: number }, post: string) {
  await signIn(page.context(), "admin", baseURL);
  await freezeClock(page);
  const misses = watchStubMisses(page);
  await page.setViewportSize(size);
  await page.goto(REQUIREMENTS);
  await settle(page);
  await page.getByRole("button", { name: post }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // The dialog zooms in; a box measured mid-animation is 95 % of itself.
  await dialog.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
  await dialog.getByRole("button", { name: "Dela lektionerna mellan lärare" }).click();
  const shares = dialog.getByRole("group", { name: "Delade lektioner" });
  await expect(shares).toBeVisible();
  return { dialog, shares, misses };
}

/** Chooses a teacher on the row's picker, by the start of the option's name. */
async function choose(page: Page, picker: Locator, option: RegExp) {
  await picker.click();
  await page.getByRole("option", { name: option }).click();
  await expect(page.getByRole("listbox")).toBeHidden();
}

/** Every box the layout promises something about, read in one pass. */
function layout(shares: Locator) {
  return shares.evaluate((fieldset) => {
    const box = (element: Element | null | undefined) => {
      if (!element) throw new Error("an element the layout check needs is missing");
      const { top, bottom, left, right } = element.getBoundingClientRect();
      return { top, bottom, left, right };
    };
    const rows = [...fieldset.children]
      .filter((child) => child.querySelector("button[role=combobox]"))
      .map((row) => {
        const picker = row.querySelector("button[role=combobox]")!;
        const value = picker.firstElementChild;
        return {
          text: picker.textContent ?? "",
          row: box(row),
          label: box(row.querySelector("label")),
          picker: box(picker),
          value: box(value),
          // The name, the badge and the minutes one by one, by their text's
          // own lines: the value's box clips, so a name cut at its edge would
          // leave the box inside, and a span is as wide as its row however
          // its text is aligned in it.
          parts: [...(value?.querySelectorAll("*") ?? [])]
            .filter((part) => part.childElementCount === 0 && part.textContent?.trim())
            .flatMap((part) => {
              const range = document.createRange();
              range.selectNodeContents(part);
              return [...range.getClientRects()].map(({ top, bottom, left, right }) => ({
                text: part.textContent!,
                top,
                bottom,
                left,
                right,
              }));
            }),
          lessons: box(row.querySelector("input[type=number]")),
          remove: box([...row.querySelectorAll("button")].find((b) => b.getAttribute("aria-label")?.startsWith("Ta bort"))),
        };
      });
    const add = [...fieldset.querySelectorAll("button")].find((b) => b.textContent?.includes("Lägg till lärare"));
    const dialog = fieldset.closest("[role=dialog]")!;
    return {
      fieldset: box(fieldset),
      rows,
      add: box(add),
      line: box(fieldset.querySelector("[aria-live]")),
      scrollsSideways: dialog.scrollWidth > dialog.clientWidth,
    };
  });
}

type Layout = Awaited<ReturnType<typeof layout>>;

/** Half a pixel for subpixel rounding: boxes are compared, not drawn. */
const EPS = 0.5;

function expectInFlow(facts: Layout, where: string) {
  facts.rows.forEach((row, index) => {
    const at = `${where}, row ${index + 1} (${row.text})`;
    expect(row.value.top, `${at}: the chosen line starts inside the picker`).toBeGreaterThanOrEqual(row.picker.top - EPS);
    expect(row.value.bottom, `${at}: the chosen line ends inside the picker`).toBeLessThanOrEqual(row.picker.bottom + EPS);
    expect(row.value.right, `${at}: the chosen line stops at the picker's edge`).toBeLessThanOrEqual(row.picker.right + EPS);
    expect(row.parts.length, `${at}: the chosen line has its parts`).toBeGreaterThan(0);
    expect(Math.abs(row.parts[0]!.left - row.value.left), `${at}: the name starts at the picker's left, as a field's text does`).toBeLessThanOrEqual(1);
    for (const part of row.parts) {
      expect(
        part.left >= row.value.left - EPS &&
          part.right <= row.value.right + EPS &&
          part.top >= row.value.top - EPS &&
          part.bottom <= row.value.bottom + EPS,
        `${at}: "${part.text}" is whole inside the picker, not cut at its edge`,
      ).toBe(true);
    }
    expect(row.label.bottom, `${at}: "Lärare" stands above its picker`).toBeLessThanOrEqual(row.picker.top + EPS);
    expect(Math.abs(row.remove.top - row.lessons.top), `${at}: the remove button is level with Lektioner`).toBeLessThanOrEqual(1);
    expect(Math.max(row.picker.right, row.remove.right), `${at}: nothing past the fieldset`).toBeLessThanOrEqual(facts.fieldset.right + EPS);
    const below = facts.rows[index + 1]?.row ?? facts.add;
    expect(row.row.bottom, `${at}: the row ends above what follows it`).toBeLessThanOrEqual(below.top + EPS);
    expect(row.picker.bottom, `${at}: the picker ends above what follows its row`).toBeLessThanOrEqual(below.top + EPS);
  });
  expect(facts.add.bottom, `${where}: the line under the rows is under "Lägg till lärare"`).toBeLessThanOrEqual(facts.line.top + EPS);
  expect(facts.scrollsSideways, `${where}: the dialog does not scroll sideways`).toBe(false);
}

for (const size of VIEWPORTS) {
  test(`Delade lektioner at ${size.name}: a chosen teacher's line stays in its picker, one row or two`, async ({ page, baseURL }) => {
    const { shares, misses } = await openShares(page, baseURL!, size, "Biologi för 7A: 2 lektioner à 60 minuter");
    const pickers = shares.getByRole("combobox");

    // The production report: a teacher without behörighet, over their mål —
    // the longest line the picker shows, three rows in the row's column.
    await choose(page, pickers.nth(0), /^Bo Ek/);
    await expect(pickers.nth(0), "the fixture still makes this the long line").toContainText(/Saknar behörighet.*över mål/);
    expectInFlow(await layout(shares), "one row");

    // A second row on a two-lesson post: the lead would keep none, so the
    // problem line stands under the add button, which stands under both rows.
    await shares.getByRole("button", { name: "Lägg till lärare" }).click();
    await choose(page, pickers.nth(1), /^Eva Holm/);
    await expect(shares.locator("[aria-live]")).toContainText("Läraren ovan behåller minst en lektion");
    expectInFlow(await layout(shares), "two rows and a problem");

    expect(misses, MISSES).toEqual([]);
  });

  test(`Delade lektioner at ${size.name}: a name longer than the picker breaks inside it`, async ({ page, baseURL }) => {
    // The fixture school's names are short. This one is Bo Ek's, renamed in
    // what the stub answers the browser, so his badge and minutes come along:
    // wider than the picker at both sizes, so it has to break to stay inside.
    await page.route(`${STUB_ORIGIN}/**`, async (route) => {
      const response = await route.fetch();
      if (!(response.headers()["content-type"] ?? "").includes("json")) return route.fulfill({ response });
      const body = (await response.text())
        .replaceAll('"firstName":"Bo"', '"firstName":"Maria-Kristina Charlotte"')
        .replaceAll('"lastName":"Ek"', '"lastName":"Lindblom-Johansson Söderström"');
      await route.fulfill({ response, body });
    });
    const { shares, misses } = await openShares(page, baseURL!, size, "Biologi för 7A: 2 lektioner à 60 minuter");
    const picker = shares.getByRole("combobox").nth(0);
    await choose(page, picker, /^Maria-Kristina Charlotte Lindblom-Johansson Söderström/);
    await expect(picker).toContainText(/Saknar behörighet.*över mål/);
    expectInFlow(await layout(shares), "a long name");

    expect(misses, MISSES).toEqual([]);
  });

  test(`Delade lektioner at ${size.name}: on a post of two lengths, Längd stands in the row too`, async ({ page, baseURL }) => {
    const { shares, misses } = await openShares(
      page,
      baseURL!,
      size,
      "Moderna språk för Moderna språk franska 7: 1 lektion à 60 minuter och 1 lektion à 40 minuter",
    );
    await choose(page, shares.getByRole("combobox").nth(0), /^Bo Ek/);
    await choose(page, shares.getByRole("combobox", { name: "Längd" }), /^40 min/);
    const facts = await layout(shares);
    expectInFlow(facts, "two lengths");
    expect(facts.rows).toHaveLength(1);

    expect(misses, MISSES).toEqual([]);
  });
}
