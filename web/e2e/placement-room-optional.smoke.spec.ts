import { expect, test, type Locator, type Page } from "@playwright/test";
import { setScheme } from "./axe";
import { askForScenario, freezeClock, settle, signIn, watchStubMisses } from "./signed-in";
import { PLACEMENT_WEEK_ANY_ROOM_SCENARIO } from "./stub/fixtures/timplan-board";
import { NO_ROOM_PLACEMENTS_SCENARIO } from "./stub/fixtures/timplan-placements";
import { ROOMS } from "./stub/fixtures/world";
import { KIND, uid } from "./stub/sessions";

/**
 * Salen är valfri: where the dialog Förlägg's room field and the week's lines stand when a förläggning leaves the room to
 * the engine ("Motorn väljer sal").
 *
 * What the dialog sends, refuses and says is placement-dialog.test.tsx's, and what the week makes of a row with no room is
 * the page's test, in jsdom. jsdom has no layout, so what is asked here is what only a browser can say, at 320, 375 and
 * 1280 px, in both themes and in a wide font: the room field, the sentence under it and the sentence about a pair's half
 * with no room stand inside their row and the dialog; the empty choice is what the select shows; the label stands above its
 * field and the sentence below it; nothing overlaps; and nothing scrolls sideways. Then the two things that reach the
 * gateway: a pair's half with no room is refused before it is sent, and a row with no room is sent as null.
 *
 * The dialog's post is the fixture school's Biologi för 7A in the scenario that places it without a room
 * (e2e/stub/fixtures/timplan-placements.ts): three rows, the first with no room, the second the odd half of a pair with no
 * room (which the judge refuses: PAIR_ROOM), the third its even half in NO-salen. The week is the scenario that adds a row
 * with no room to Förlägg i veckan's own (e2e/stub/fixtures/timplan-board.ts).
 */

const REQUIREMENTS = "/sv/admin/requirements";
const WEEK = "/sv/admin/placements";
const MISSES = "the backend stub could not answer these reads; each says which file to add it to or fix";

const VIEWPORTS = [
  { name: "320×700", width: 320, height: 700 },
  { name: "375×812", width: 375, height: 812 },
  { name: "1280×800", width: 1280, height: 800 },
];
const SCHEMES = ["light", "dark"] as const;

/** The wide font of the CI runner's kind: every text measured in it is wider than on this Mac. */
const WIDE_FONT = "body, button, input, select { font-family: 'DejaVu Sans Mono', monospace !important }";

/** Half a pixel for subpixel rounding: boxes are compared, not drawn. */
const EPS = 0.5;

/** A dialog once it has zoomed in: a box measured mid-animation is 95 % of itself. */
async function settled(dialog: Locator) {
  await expect(dialog).toBeVisible();
  await dialog.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
  return dialog;
}

async function openDialog(page: Page, baseURL: string, size: { width: number; height: number }, scheme: (typeof SCHEMES)[number]) {
  await signIn(page.context(), "admin", baseURL);
  await freezeClock(page);
  await askForScenario(page, NO_ROOM_PLACEMENTS_SCENARIO);
  const misses = watchStubMisses(page);
  await page.setViewportSize(size);
  await page.goto(REQUIREMENTS);
  await settle(page);
  await setScheme(page, scheme, true);
  // The post's own cell, opened by the page's own click handler: that a phone's pinned columns leave the cell reachable is
  // requirement-matrix.smoke.spec.ts's to say, and this spec is about what stands in the dialog.
  await page
    .getByRole("button", { name: /^Biologi för 7A: 2 lektioner à 60 minuter/ })
    .evaluate((button) => (button as HTMLElement).click());
  const cell = await settled(page.getByRole("dialog"));
  await cell.getByRole("button", { name: "Förlägg …" }).click();
  const dialog = await settled(page.getByRole("dialog", { name: /^Förlägg 7A/ }));
  await expect(dialog.getByRole("group", { name: /^Lektion 3/ })).toBeVisible();
  return { dialog, misses };
}

const row = (dialog: Locator, n: number) => dialog.getByRole("group", { name: new RegExp(`^Lektion ${n}`) });
const roomOf = (dialog: Locator, n: number) => row(dialog, n).getByLabel("Sal", { exact: true });

/** Every box the room fields promise something about, read in one pass. */
function layout(dialog: Locator) {
  return dialog.evaluate((root) => {
    const box = (element: Element | null | undefined) => {
      if (!element) throw new Error("an element the layout check needs is missing");
      const { top, bottom, left, right } = element.getBoundingClientRect();
      return { top, bottom, left, right };
    };
    /** Where the text itself ends, not where its element does: a parent that clips hides a line that is cut. */
    const textRight = (element: Element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return Math.max(...[...range.getClientRects()].filter((rect) => rect.width > 0).map((rect) => rect.right));
    };
    const rows = [...root.querySelectorAll("fieldset")]
      .filter((fieldset) => fieldset.querySelector(":scope > legend") !== null)
      .map((fieldset) => {
        const select = fieldset.querySelector("select[id*='-room-']") as HTMLSelectElement;
        const hint = fieldset.querySelector("p[id*='-room-'][id$='-hint']");
        // The sentences said at the row: the judge's (or a refusal's) at its foot, the save's check beside the field.
        const sentences = [...fieldset.querySelectorAll("p.text-destructive")];
        const selected = select.selectedOptions[0]?.textContent ?? "";
        const style = getComputedStyle(select);
        const context = document.createElement("canvas").getContext("2d")!;
        context.font = style.font;
        return {
          row: box(fieldset),
          label: box(fieldset.querySelector("label[for*='-room-']")),
          select: box(select),
          hint: box(hint),
          hintTextRight: textRight(hint!),
          sentences: sentences.map((sentence) => ({ box: box(sentence), textRight: textRight(sentence) })),
          selected,
          // The text the select shows, against the width it has for it: the arrow and the padding are not the text's.
          selectedWidth: context.measureText(selected).width,
          selectRoom: select.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 24,
          fields: [...fieldset.querySelectorAll("select, input, button")].map((control) => box(control)),
        };
      });
    return {
      dialog: box(root),
      rows,
      add: box([...root.querySelectorAll("button")].find((button) => button.textContent?.includes("Lägg till lektion"))),
      scrollsSideways: root.scrollWidth > root.clientWidth,
      pageScrollsSideways: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
}

type Layout = Awaited<ReturnType<typeof layout>>;

function expectInFlow(facts: Layout, where: string) {
  const inside = (box: { left: number; right: number }, outer: { left: number; right: number }) =>
    box.left >= outer.left - EPS && box.right <= outer.right + EPS;
  expect(facts.rows.length, `${where}: the rows`).toBe(3);
  facts.rows.forEach((fact, index) => {
    const at = `${where}, row ${index + 1}`;
    expect(inside(fact.row, facts.dialog), `${at}: the row is inside the dialog`).toBe(true);
    expect(inside(fact.select, fact.row), `${at}: the room field is inside the row`).toBe(true);
    for (const field of fact.fields) expect(inside(field, fact.row), `${at}: no field past the row's edge`).toBe(true);
    expect(fact.label.bottom, `${at}: "Sal" stands above its field`).toBeLessThanOrEqual(fact.select.top + EPS);
    expect(fact.hint.top, `${at}: the hint stands below the room field`).toBeGreaterThanOrEqual(fact.select.bottom - EPS);
    expect(inside(fact.hint, fact.row), `${at}: the hint's box is inside the row`).toBe(true);
    expect(fact.hintTextRight, `${at}: the hint's text ends inside the row`).toBeLessThanOrEqual(fact.row.right + EPS);
    for (const sentence of fact.sentences) {
      expect(inside(sentence.box, fact.row), `${at}: a sentence about the row is inside it`).toBe(true);
      expect(sentence.textRight, `${at}: the text of a sentence about the row ends inside it`).toBeLessThanOrEqual(fact.row.right + EPS);
      expect(sentence.box.bottom, `${at}: a sentence about the row is inside it, below`).toBeLessThanOrEqual(fact.row.bottom + EPS);
    }
    expect(fact.selectedWidth, `${at}: the select has room for what it shows ("${fact.selected}")`).toBeLessThanOrEqual(fact.selectRoom);
    const below = facts.rows[index + 1]?.row ?? facts.add;
    expect(fact.row.bottom, `${at}: the row ends above what follows it`).toBeLessThanOrEqual(below.top + EPS);
  });
  expect(inside(facts.add, facts.dialog), `${where}: the add button is inside the dialog`).toBe(true);
  expect(facts.scrollsSideways, `${where}: the dialog does not scroll sideways`).toBe(false);
  expect(facts.pageScrollsSideways, `${where}: the page does not scroll sideways`).toBe(false);
}

for (const size of VIEWPORTS) {
  for (const scheme of SCHEMES) {
    test(`Förlägg a post with a row that names no room at ${size.name}, ${scheme}: the room field says "Motorn väljer sal", and its hint and sentences stay inside the row`, async ({
      page,
      baseURL,
    }) => {
      const { dialog, misses } = await openDialog(page, baseURL!, size, scheme);

      // The empty choice is what the select shows, on the two rows with no room, and the room it has on the third.
      await expect(roomOf(dialog, 1)).toHaveValue("");
      await expect(roomOf(dialog, 1).locator("option:checked")).toHaveText("Motorn väljer sal");
      await expect(roomOf(dialog, 2).locator("option:checked")).toHaveText("Motorn väljer sal");
      await expect(roomOf(dialog, 3).locator("option:checked")).toHaveText(ROOMS.lab.name);
      // The empty choice comes first, before the school's rooms.
      const options = await roomOf(dialog, 1).locator("option").allInnerTexts();
      expect(options[0]).toBe("Motorn väljer sal");
      expect(options.slice(1).sort()).toEqual(Object.values(ROOMS).map((room) => room.name).sort());

      // What the empty choice means is said under every room field, and the pair's half with no room is said at its row.
      await expect(dialog.getByText(/^Lämnas salen tom väljer schemat sal vid varje Generera/)).toHaveCount(3);
      await expect(row(dialog, 2).getByText(/^Udda och jämna veckor av samma längd är en lektion på två platser/)).toBeVisible();

      expectInFlow(await layout(dialog), `${size.name} ${scheme}`);
      expect(misses, MISSES).toEqual([]);
    });
  }
}

test("Förlägg a post with a row that names no room at 320×700 in a wide font: the room field, its hint and the pair's sentence stay inside the row", async ({
  page,
  baseURL,
}) => {
  const { dialog, misses } = await openDialog(page, baseURL!, { width: 320, height: 700 }, "light");
  await page.addStyleTag({ content: WIDE_FONT });

  expectInFlow(await layout(dialog), "wide font");
  expect(misses, MISSES).toEqual([]);
});

for (const size of VIEWPORTS) {
  test(`Förlägg a post at ${size.name}: a pair's half with no room is refused before it is sent, and moves to its room`, async ({
    page,
    baseURL,
  }) => {
    const { dialog, misses } = await openDialog(page, baseURL!, size, "light");
    const sent: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "PUT") sent.push(request.url());
    });

    await dialog.getByRole("button", { name: "Spara" }).click();

    // The judge's sentence stands at the row already; the check of the save adds none beside it, and keeps the dialog open.
    await expect(roomOf(dialog, 2)).toBeFocused();
    await expect(roomOf(dialog, 2)).toHaveAttribute("aria-invalid", "true");
    await expect(row(dialog, 2).getByText(/^Udda och jämna veckor av samma längd är en lektion på två platser/)).toHaveCount(1);
    await expect(dialog).toBeVisible();
    expect(sent, "nothing is sent while a half has no room").toEqual([]);
    expectInFlow(await layout(dialog), `${size.name} after the save was refused`);
    expect(misses, MISSES).toEqual([]);
  });

  test(`Förlägg a post at ${size.name}: a row with no room is sent as null, and the pair's halves with the rooms chosen`, async ({
    page,
    baseURL,
  }) => {
    const { dialog, misses } = await openDialog(page, baseURL!, size, "light");

    await roomOf(dialog, 2).selectOption({ label: ROOMS.r101.name });
    // The judge's sentence was said of the row as it was.
    await expect(row(dialog, 2).getByText(/^Udda och jämna veckor av samma längd är en lektion på två platser/)).toHaveCount(0);

    const sent = page.waitForRequest((request) => request.method() === "PUT" && request.url().includes("/placements"));
    await dialog.getByRole("button", { name: "Spara" }).click();

    const body = (await sent).postDataJSON() as { placements: { roomId: string | null; recurrence: string }[] };
    expect(body.placements.map((placement) => placement.roomId)).toEqual([null, ROOMS.r101.id, ROOMS.lab.id]);
    expect(body.placements.map((placement) => placement.recurrence)).toEqual(["ALL_WEEKS", "ODD_WEEKS", "EVEN_WEEKS"]);
    await expect(dialog).toBeHidden();
    expect(misses, MISSES).toEqual([]);
  });
}

// --- Förlägg i veckan -----------------------------------------------------------------------------------------------

async function openWeek(page: Page, baseURL: string, size: { width: number; height: number }, scheme: (typeof SCHEMES)[number]) {
  await signIn(page.context(), "admin", baseURL);
  await freezeClock(page);
  await askForScenario(page, PLACEMENT_WEEK_ANY_ROOM_SCENARIO);
  const misses = watchStubMisses(page);
  await page.setViewportSize(size);
  await page.goto(WEEK);
  await settle(page);
  await setScheme(page, scheme, true);
  await expect(page.getByRole("heading", { level: 1, name: "Förlägg i veckan" })).toBeVisible();
  return misses;
}

/** The list's lines inside their boxes, sideways, by the rectangles of the text itself; and the page's own scroll. */
function weekFacts(page: Page) {
  return page.evaluate(() => {
    const problems: string[] = [];
    for (const item of document.querySelectorAll("[data-testid='placement-row'], [data-testid='placement-detail'] > div")) {
      const outer = item.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(item);
      for (const rect of range.getClientRects()) {
        if (rect.width > 0 && (rect.left < outer.left - 0.5 || rect.right > outer.right + 0.5)) {
          problems.push(`text past its box sideways: "${(item.textContent ?? "").trim().slice(0, 50)}" ${Math.round(rect.left)}–${Math.round(rect.right)} in ${Math.round(outer.left)}–${Math.round(outer.right)}`);
        }
      }
      if (item.scrollWidth > item.clientWidth + 1) problems.push(`a box scrolls sideways: ${(item.textContent ?? "").trim().slice(0, 50)}`);
    }
    return { problems, pageScrollsSideways: document.documentElement.scrollWidth > window.innerWidth };
  });
}

for (const size of VIEWPORTS) {
  for (const scheme of SCHEMES) {
    test(`Förlägg i veckan at ${size.name}, ${scheme}: a row with no room says "Motorn väljer sal" in the list and when its card is opened, and nothing scrolls sideways`, async ({
      page,
      baseURL,
    }) => {
      const misses = await openWeek(page, baseURL!, size, scheme);

      // Engelska 7A's one row, in the list of posts: the day, the time and where the room's name would stand.
      const post = page.getByTestId("placement-post").filter({ hasText: "Engelska 7A" });
      await expect(post.getByTestId("placement-row")).toContainText("Motorn väljer sal");
      await expect(post.getByTestId("placement-row")).not.toContainText("null");

      // Its card opens on the same words (the card itself may drop the line when the hour is short).
      await page.locator(`[data-lesson-id='placement:${uid(KIND.misc, 804)}']`).click();
      await expect(page.getByTestId("placement-detail")).toContainText("Motorn väljer sal");

      const facts = await weekFacts(page);
      expect(facts.problems, "text measured by its own rectangles").toEqual([]);
      expect(facts.pageScrollsSideways, "the page scrolls sideways").toBe(false);
      expect(misses, MISSES).toEqual([]);
    });
  }

  test(`Förlägg i veckan at ${size.name}: a row with no room is there with no room picked, and is not there for a room that is`, async ({
    page,
    baseURL,
  }) => {
    const misses = await openWeek(page, baseURL!, size, "light");
    const english = page.getByTestId("placement-post").filter({ hasText: "Engelska 7A" }).getByTestId("placement-row");
    await expect(english).toHaveCount(1);

    await page.getByRole("button", { name: "Salar", exact: true }).click();
    await page.getByRole("menuitemcheckbox", { name: ROOMS.lab.name, exact: true }).click();
    await page.keyboard.press("Escape");

    // The room picked is the NO-salen's: the row that stands in no room matches none, and its post goes with it.
    await expect(page.getByTestId("placement-post").filter({ hasText: "Engelska 7A" })).toHaveCount(0);
    expect((await weekFacts(page)).pageScrollsSideways).toBe(false);
    expect(misses, MISSES).toEqual([]);
  });
}
