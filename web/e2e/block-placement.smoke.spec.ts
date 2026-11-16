import { expect, test, type Locator, type Page } from "@playwright/test";
import { format, scan, setScheme } from "./axe";
import { askForScenario, freezeClock, settle, signIn, watchStubMisses } from "./signed-in";
import {
  BLOCK,
  BLOCK_PLACEMENTS_SCENARIO,
  BLOCK_PLACEMENTS_STALE_SCENARIO,
  BLOCK_PLACEMENTS_VERDICTS_SCENARIO,
  BLOCK_POST_IDS,
  THIRD_POST,
} from "./stub/fixtures/timplan-block-placements";
import { ROOMS } from "./stub/fixtures/world";
import { STUB_ORIGIN } from "./stub/sessions";

/**
 * Förlägg blocket on Timplansposter, where its fields and its sentences stand.
 *
 * What the dialog offers (a lesson of each length the block has and no more, a room for each post, the engine's choice as the
 * empty one), what it sends and how it words each refusal is block-placement-dialog.test.tsx's, in jsdom. jsdom has no layout, so
 * what is asked here is what only a browser can say, at 320, 375 and 1280 px, in both themes and in a wide font: the three posts'
 * room fields, their labels, the verdicts and the refusal that names a post stand inside their lesson and the dialog; a label
 * stands above its field; nothing overlaps; no text is cut (read by the rectangles of the text itself, because a dialog that clips
 * hides a line that is cut); nothing scrolls sideways; axe finds nothing. Then what reaches the gateway: a lesson with a room for
 * one post only is sent with that room alone, and a save the gateway refuses says which post clashes and leaves the dialog open.
 * And the keyboard: the focus starts in the dialog, stays in it, runs in reading order and comes back to the button on Escape.
 *
 * The block is the world's "Språkval åk 7" with a third post added to what the browser reads of the table (the world has two:
 * e2e/stub/fixtures/timplan-block-placements.ts), so the dialog shows three posts, two of them named by groups of long names.
 */

const REQUIREMENTS = "/sv/admin/requirements";
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

/** The block's posts as the dialog lists them: the teaching groups first, by the group's name, then the class. */
const POST_NAMES = [
  "Moderna språk för Moderna språk franska 7",
  "Moderna språk för Moderna språk spanska 7–9",
  "Moderna språk för 7B",
];
/** Names that are one long word, with no space to break at (a compound, a code): the block's, and the class the third post is read in. */
const LONG_BLOCK = "Språkvalsblockförårskursenmedmodernaspråkochannatval";
const LONG_CLASS = "Sjundeårskursensklassförspråkvalsgruppernasomläserfranska";

/** The posts' ids (the fixture lists them by id: spanska 11, franska 13, the third 14). */
const [SPANSKA, FRANSKA, TREDJE] = BLOCK_POST_IDS as [string, string, string];

/** A dialog once it has zoomed in: a box measured mid-animation is 95 % of itself. */
async function settled(dialog: Locator) {
  await expect(dialog).toBeVisible();
  await dialog.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
  return dialog;
}

/** The browser's read of the table, with the third post of the block added (PostgREST knows no scenario). */
async function addTheThirdPost(page: Page) {
  await page.route(`${STUB_ORIGIN}/rest/v1/TeachingRequirements*`, async (route) => {
    const response = await route.fetch();
    if (!(response.headers()["content-type"] ?? "").includes("json")) return route.fulfill({ response });
    const rows = (await response.json()) as { id?: string }[] | unknown;
    if (!Array.isArray(rows)) return route.fulfill({ response });
    const added = rows.some((row: { id?: string }) => row.id === THIRD_POST.id) ? rows : [...rows, THIRD_POST];
    await route.fulfill({ response, body: JSON.stringify(added) });
  });
}

/**
 * The browser's read of the blocks, with the world's block taking the times of another block (a block that follows) and/or
 * another name. One route for both: a route fetches the network and does not hand on to another.
 */
async function rewriteTheBlocks(page: Page, change: { follows?: boolean; name?: string }) {
  await page.route(`${STUB_ORIGIN}/rest/v1/TeachingBlocks*`, async (route) => {
    const response = await route.fetch();
    if (!(response.headers()["content-type"] ?? "").includes("json")) return route.fulfill({ response });
    const rows = (await response.json()) as { id: string }[];
    const other = { ...BLOCK, id: "00000000-0000-4000-8000-000000000999", name: "Elevens val åk 7", sameTimesAsBlockId: null };
    const changed = rows.map((row) =>
      row.id === BLOCK.id
        ? { ...row, ...(change.name ? { name: change.name } : {}), ...(change.follows ? { sameTimesAsBlockId: other.id } : {}) }
        : row,
    );
    await route.fulfill({ response, body: JSON.stringify(change.follows ? [...changed, other] : changed) });
  });
}

/** The browser's read of the groups, with the class of the third post named by one long word. */
async function nameTheClassOfTheThirdPost(page: Page, name: string) {
  await page.route(`${STUB_ORIGIN}/rest/v1/StudentGroups*`, async (route) => {
    const response = await route.fetch();
    if (!(response.headers()["content-type"] ?? "").includes("json")) return route.fulfill({ response });
    const rows = (await response.json()) as { id?: string }[] | unknown;
    if (!Array.isArray(rows)) return route.fulfill({ response });
    await route.fulfill({
      response,
      body: JSON.stringify(rows.map((row: { id?: string }) => (row.id === THIRD_POST.studentGroupId ? { ...row, name } : row))),
    });
  });
}

async function openDialog(
  page: Page,
  baseURL: string,
  size: { width: number; height: number },
  scheme: (typeof SCHEMES)[number],
  options: { scenario?: string; follows?: boolean; blockName?: string; thirdClassName?: string } = {},
) {
  await signIn(page.context(), "admin", baseURL);
  await freezeClock(page);
  await askForScenario(page, options.scenario ?? BLOCK_PLACEMENTS_SCENARIO);
  const misses = watchStubMisses(page);
  await addTheThirdPost(page);
  if (options.follows || options.blockName) await rewriteTheBlocks(page, { follows: options.follows, name: options.blockName });
  if (options.thirdClassName) await nameTheClassOfTheThirdPost(page, options.thirdClassName);
  await page.setViewportSize(size);
  await page.goto(REQUIREMENTS);
  await settle(page);
  await setScheme(page, scheme, true);
  await page.getByRole("button", { name: "Block", exact: true }).click();
  const blockName = options.blockName ?? "Språkval åk 7";
  const opener = page.getByRole("button", { name: `Förlägg lektionerna i blocket ${blockName}` });
  await opener.click();
  const dialog = await settled(page.getByRole("dialog", { name: new RegExp(`^Förlägg blocket ${blockName}`) }));
  // What the dialog says once the block has been read.
  await expect(dialog.getByText(/^Blockets lektioner:/).or(dialog.getByText(/förläggs inte själv|inga poster/))).toBeVisible();
  return { dialog, misses, opener };
}

const row = (dialog: Locator, n: number) => dialog.getByRole("group", { name: new RegExp(`^Lektion ${n}`) });
const roomOf = (dialog: Locator, n: number, post: number) => row(dialog, n).getByLabel(`Sal: ${POST_NAMES[post]}`, { exact: true });
const saveButton = (dialog: Locator) => dialog.getByRole("button", { name: "Spara", exact: true });

/** Every box the layout promises something about, read in one pass, and every text by the rectangles of the text itself. */
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
      const rects = [...range.getClientRects()].filter((rect) => rect.width > 0);
      return rects.length === 0 ? Number.NEGATIVE_INFINITY : Math.max(...rects.map((rect) => rect.right));
    };
    const textLeft = (element: Element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const rects = [...range.getClientRects()].filter((rect) => rect.width > 0);
      return rects.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...rects.map((rect) => rect.left));
    };
    const context = document.createElement("canvas").getContext("2d")!;
    const rows = [...root.querySelectorAll("fieldset")]
      .filter((fieldset) => fieldset.querySelector(":scope > legend") !== null)
      .map((fieldset) => {
        const controls = [...fieldset.querySelectorAll("select, input, button")] as HTMLElement[];
        const labelled = controls
          .filter((control) => control.matches("select, input"))
          .map((control) => {
            const label = fieldset.querySelector(`label[for="${CSS.escape(control.id)}"]`);
            const select = control instanceof HTMLSelectElement ? control : null;
            const style = getComputedStyle(control);
            context.font = style.font;
            const selected = select?.selectedOptions[0]?.textContent ?? "";
            return {
              id: control.id,
              box: box(control),
              label: label ? box(label) : null,
              selected,
              // The text a select shows, against the width it has for it: the arrow and the padding are not the text's.
              selectedWidth: select ? context.measureText(selected).width : 0,
              selectRoom: select ? select.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 24 : 0,
            };
          });
        return {
          row: box(fieldset),
          controls: controls.map((control) => box(control)),
          labelled,
          sentences: [...fieldset.querySelectorAll("p.text-destructive")].map((sentence) => ({
            box: box(sentence),
            textRight: textRight(sentence),
          })),
        };
      });
    // Every line of text in the dialog, by its own rectangles, against the dialog it is read in.
    // The text only a screen reader reads (the dialog's X) is clipped to a pixel on purpose, and is no text that is cut.
    const seen = (element: Element) => !element.closest(".sr-only") && !element.querySelector(":scope > .sr-only");
    const texts = [...root.querySelectorAll("p, label, legend, h2, button, li")].filter(seen).map((element) => ({
      what: (element.textContent ?? "").trim().slice(0, 40),
      left: textLeft(element),
      right: textRight(element),
    }));
    return {
      dialog: box(root),
      rows,
      texts,
      // A block that cannot be placed has no button that adds a lesson.
      add: [...root.querySelectorAll("button")].find((button) => button.textContent?.includes("Lägg till lektion"))
        ? box([...root.querySelectorAll("button")].find((button) => button.textContent?.includes("Lägg till lektion")))
        : null,
      scrollsSideways: root.scrollWidth > root.clientWidth,
      pageScrollsSideways: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
}

type Layout = Awaited<ReturnType<typeof layout>>;

function expectInFlow(facts: Layout, where: string, rows: number, only: { dialog?: true } = {}) {
  const inside = (box: { left: number; right: number }, outer: { left: number; right: number }) =>
    box.left >= outer.left - EPS && box.right <= outer.right + EPS;
  const apart = (a: { top: number; bottom: number; left: number; right: number }, b: typeof a) =>
    a.right <= b.left + EPS || b.right <= a.left + EPS || a.bottom <= b.top + EPS || b.bottom <= a.top + EPS;
  expect(facts.rows.length, `${where}: the lessons`).toBe(rows);
  facts.rows.forEach((fact, index) => {
    const at = `${where}, lesson ${index + 1}`;
    expect(inside(fact.row, facts.dialog), `${at}: the lesson is inside the dialog`).toBe(true);
    for (const control of fact.controls) expect(inside(control, fact.row), `${at}: no control past the lesson's edge`).toBe(true);
    for (const [a, first] of fact.controls.entries()) {
      for (const second of fact.controls.slice(a + 1)) expect(apart(first, second), `${at}: two controls overlap`).toBe(true);
    }
    for (const field of fact.labelled) {
      if (field.label) expect(field.label.bottom, `${at}: a label stands above its field (${field.id})`).toBeLessThanOrEqual(field.box.top + EPS);
      expect(field.selectedWidth, `${at}: the select has room for what it shows ("${field.selected}")`).toBeLessThanOrEqual(field.selectRoom);
    }
    for (const sentence of fact.sentences) {
      expect(inside(sentence.box, fact.row), `${at}: a sentence about the lesson is inside it`).toBe(true);
      expect(sentence.textRight, `${at}: the text of a sentence about the lesson ends inside it`).toBeLessThanOrEqual(fact.row.right + EPS);
      expect(sentence.box.bottom, `${at}: a sentence about the lesson is inside it, below`).toBeLessThanOrEqual(fact.row.bottom + EPS);
    }
    const below = facts.rows[index + 1]?.row ?? facts.add;
    if (below) expect(fact.row.bottom, `${at}: the lesson ends above what follows it`).toBeLessThanOrEqual(below.top + EPS);
  });
  for (const text of facts.texts) {
    expect(text.right, `${where}: "${text.what}" ends inside the dialog`).toBeLessThanOrEqual(facts.dialog.right + EPS);
    expect(text.left, `${where}: "${text.what}" starts inside the dialog`).toBeGreaterThanOrEqual(facts.dialog.left - EPS);
  }
  expect(facts.scrollsSideways, `${where}: the dialog does not scroll sideways`).toBe(false);
  // `only.dialog`: the page behind is not what is asked (it shows the same names in its own cards, which are that page's to wrap).
  if (!only.dialog) expect(facts.pageScrollsSideways, `${where}: the page does not scroll sideways`).toBe(false);
}

for (const size of VIEWPORTS) {
  for (const scheme of SCHEMES) {
    test(`Förlägg blocket at ${size.name}, ${scheme}: three posts' rooms, the engine's choice and the sentences stay inside their lesson, and axe finds nothing`, async ({
      page,
      baseURL,
    }) => {
      const { dialog, misses } = await openDialog(page, baseURL!, size, scheme);

      // One lesson is placed: the first two posts have a room of their own (franska the lab, spanska Sal 101), the third leaves it to
      // the engine.
      await expect(row(dialog, 1)).toBeVisible();
      await expect(roomOf(dialog, 1, 0).locator("option:checked")).toHaveText(ROOMS.lab.name);
      await expect(roomOf(dialog, 1, 1).locator("option:checked")).toHaveText(ROOMS.r101.name);
      await expect(roomOf(dialog, 1, 2).locator("option:checked")).toHaveText("Motorn väljer sal");
      // The empty choice comes first, before the school's rooms, for every post.
      for (const post of [0, 1, 2]) {
        const options = await roomOf(dialog, 1, post).locator("option").allInnerTexts();
        expect(options[0]).toBe("Motorn väljer sal");
        expect(options.slice(1).sort()).toEqual(Object.values(ROOMS).map((room) => room.name).sort());
      }
      // What the empty choice means is said once, and what a change counts from.
      await expect(dialog.getByText(/^Låter du en post stå på ”Motorn väljer sal”/)).toHaveCount(1);
      await expect(dialog.getByText(/^Ändringen gäller från nästa Generera/)).toBeVisible();
      await expect(dialog.getByText(/^Blockets lektioner: .*Förlagda: 1 av 2\./)).toBeVisible();

      expectInFlow(await layout(dialog), `${size.name} ${scheme}`, 1);
      const { violations } = await scan(page);
      expect(violations, format(violations)).toEqual([]);
      expect(misses, MISSES).toEqual([]);
    });
  }
}

for (const size of VIEWPORTS) {
  for (const scheme of SCHEMES) {
    test(`Förlägg blocket at ${size.name}, ${scheme}: what no longer holds is said at its lesson after the posts it is said of, together or apart`, async ({
      page,
      baseURL,
    }) => {
      const { dialog, misses } = await openDialog(page, baseURL!, size, scheme, { scenario: BLOCK_PLACEMENTS_VERDICTS_SCENARIO });

      await expect(row(dialog, 2)).toBeVisible();
      // The first two posts fail for one reason, said once with both of them; the third on its own.
      await expect(row(dialog, 2).getByText(`${POST_NAMES[0]} och ${POST_NAMES[1]}: Tiden ligger på klassens lunch.`)).toBeVisible();
      await expect(row(dialog, 2).getByText(/^Moderna språk för 7B: Läraren har redan en lektion som Generera behåller: Matematik med 7B/)).toBeVisible();
      await expect(dialog.getByText("En förläggning håller inte längre")).toBeVisible();
      await expect(row(dialog, 1).getByText(/håller inte|Läraren har redan|lunch/)).toHaveCount(0);

      expectInFlow(await layout(dialog), `${size.name} ${scheme}`, 2);
      const { violations } = await scan(page);
      expect(violations, format(violations)).toEqual([]);
      expect(misses, MISSES).toEqual([]);
    });
  }
}

test("Förlägg blocket at 320×700 in a wide font: the rooms, the verdicts and the sentences stay inside the lessons, and no text is cut", async ({
  page,
  baseURL,
}) => {
  const { dialog, misses } = await openDialog(page, baseURL!, { width: 320, height: 700 }, "light", {
    scenario: BLOCK_PLACEMENTS_VERDICTS_SCENARIO,
  });
  await page.addStyleTag({ content: WIDE_FONT });

  expectInFlow(await layout(dialog), "wide font", 2);
  expect(misses, MISSES).toEqual([]);
});

for (const size of VIEWPORTS.slice(0, 2)) {
  test(`Förlägg blocket at ${size.name} with names that are one long word: the title and the room labels break inside the word and stay inside the dialog (review of #328, LÅG-2)`, async ({
    page,
    baseURL,
  }) => {
    const { dialog, misses } = await openDialog(page, baseURL!, size, "light", {
      scenario: BLOCK_PLACEMENTS_VERDICTS_SCENARIO,
      blockName: LONG_BLOCK,
      thirdClassName: LONG_CLASS,
    });

    // The names are what the dialog is named and labelled by: the long words are there, whole, to be read and heard.
    await expect(dialog.getByRole("heading", { name: `Förlägg blocket ${LONG_BLOCK}` })).toBeVisible();
    await expect(row(dialog, 1).getByLabel(`Sal: Moderna språk för ${LONG_CLASS}`, { exact: true })).toBeVisible();
    // The sentences that name the posts (the second lesson's refusal) carry the long class too.
    await expect(row(dialog, 2).getByText(new RegExp(`Moderna språk för ${LONG_CLASS}: `))).toBeVisible();

    expectInFlow(await layout(dialog), `${size.name}, one long word`, 2, { dialog: true });
    expect(misses, MISSES).toEqual([]);
  });
}

test("Förlägg blocket: a post's room goes back to the engine's choice from the list the browser shows, which offers it (review of #328, LÅG-2)", async ({
  page,
  baseURL,
}) => {
  const { dialog, misses } = await openDialog(page, baseURL!, { width: 1280, height: 800 }, "light");

  const franska = roomOf(dialog, 1, 0);
  await expect(franska.locator("option:checked")).toHaveText(ROOMS.lab.name);
  // A browser lists what is not hidden. An empty choice with `hidden` stays in the markup and in its text, and a reader who chose a room
  // could not go back to the engine's choice but by removing the lesson: so it is asked for as a reader finds it (by role: what a browser hides is not an option of the list), not by its text.
  await expect(franska.getByRole("option", { name: "Motorn väljer sal" })).toHaveCount(1);
  await franska.selectOption({ label: "Motorn väljer sal" });
  await expect(franska.locator("option:checked")).toHaveText("Motorn väljer sal");
  await franska.selectOption({ label: ROOMS.r101.name });
  await expect(franska.locator("option:checked")).toHaveText(ROOMS.r101.name);
  expect(misses, MISSES).toEqual([]);
});

for (const size of VIEWPORTS) {
  test(`Förlägg blocket at ${size.name}: a lesson with a room for one post is sent with that room alone, beside the lesson that was placed`, async ({
    page,
    baseURL,
  }) => {
    const { dialog, misses } = await openDialog(page, baseURL!, size, "light");

    await dialog.getByRole("button", { name: "Lägg till lektion" }).click();
    // The lesson the block has left is the one of 40 minutes, and its first field has the focus.
    await expect(row(dialog, 2).getByLabel("Längd", { exact: true })).toHaveValue("40");
    await expect(row(dialog, 2).getByLabel("Dag", { exact: true })).toBeFocused();
    await row(dialog, 2).getByLabel("Dag", { exact: true }).selectOption({ label: "Onsdag" });
    await row(dialog, 2).getByLabel("Starttid", { exact: true }).fill("09:05");
    // A room for the third post only: the other two are left to the engine.
    await roomOf(dialog, 2, 2).selectOption({ label: ROOMS.art.name });
    // The block has no lesson left to place.
    await expect(dialog.getByRole("button", { name: "Lägg till lektion" })).toBeDisabled();
    await expect(dialog.getByText("Blocket har 2 lektioner i veckan, och alla är förlagda.")).toBeVisible();

    const sent = page.waitForRequest((request) => request.method() === "PUT" && request.url().includes("/placements"));
    await saveButton(dialog).click();

    const body = (await sent).postDataJSON() as {
      baseKey: string;
      placements: { dayOfWeek: number; startTime: string; minutes: number; rooms: { requirementId: string; roomId: string }[] }[];
    };
    expect(body.baseKey).toMatch(/^[0-9a-f]{32}$/);
    expect(body.placements).toEqual([
      {
        dayOfWeek: 2,
        startTime: "10:00",
        minutes: 60,
        // In the order the dialog lists the posts: franska (the lab) before spanska (Sal 101).
        rooms: [
          { requirementId: FRANSKA, roomId: ROOMS.lab.id },
          { requirementId: SPANSKA, roomId: ROOMS.r101.id },
        ],
      },
      { dayOfWeek: 3, startTime: "09:05", minutes: 40, rooms: [{ requirementId: TREDJE, roomId: ROOMS.art.id }] },
    ]);
    await expect(dialog).toBeHidden();
    expect(misses, MISSES).toEqual([]);
  });

  test(`Förlägg blocket at ${size.name}: a save the week refuses says which post clashes and why, at the lesson, and leaves the dialog open`, async ({
    page,
    baseURL,
  }) => {
    const { dialog, misses } = await openDialog(page, baseURL!, size, "light");

    await dialog.getByRole("button", { name: "Lägg till lektion" }).click();
    await row(dialog, 2).getByLabel("Dag", { exact: true }).selectOption({ label: "Måndag" });
    await row(dialog, 2).getByLabel("Starttid", { exact: true }).fill("10:00");
    await saveButton(dialog).click();

    // Where the gateway says it, by the post it says it of: the class and the subject of the lesson in the way, never a person.
    const sentence = row(dialog, 2).getByText(
      /^Moderna språk för 7B: Läraren har redan en lektion som Generera behåller: Matematik med 7B, måndag 10:00–11:00\.$/,
    );
    await expect(sentence).toBeVisible();
    await expect(row(dialog, 2).getByLabel("Dag", { exact: true })).toBeFocused();
    await expect(row(dialog, 2).getByLabel("Dag", { exact: true })).toHaveAttribute("aria-invalid", "true");
    await expect(dialog).toBeVisible();
    expectInFlow(await layout(dialog), `${size.name} after the refusal`, 2);

    // Moving the lesson takes the sentence away: it was said of the lesson as it was.
    await row(dialog, 2).getByLabel("Dag", { exact: true }).selectOption({ label: "Tisdag" });
    await expect(sentence).toHaveCount(0);
    expect(misses, MISSES).toEqual([]);
  });
}

for (const size of VIEWPORTS) {
  test(`Förlägg blocket at ${size.name}: a block that has changed since it was read says so, writes nothing, and is read again on the reader's word`, async ({
    page,
    baseURL,
  }) => {
    const { dialog, misses } = await openDialog(page, baseURL!, size, "light", { scenario: BLOCK_PLACEMENTS_STALE_SCENARIO });
    let reads = 0;
    page.on("request", (request) => {
      if (request.method() === "GET" && /\/teaching-blocks\/[^/]+\/placements$/.test(request.url())) reads += 1;
    });

    await saveButton(dialog).click();

    await expect(dialog.getByText("Blocket har ändrats", { exact: true })).toBeVisible();
    await expect(dialog.getByText(/Ingenting sparades\. Läs in blocket igen/)).toBeVisible();
    await expect(dialog).toBeVisible();
    const top = dialog.getByRole("alert");
    expect(await top.evaluate((element) => element.getBoundingClientRect().right <= (element.closest("[role=dialog]") as Element).getBoundingClientRect().right + 0.5)).toBe(true);

    await dialog.getByRole("button", { name: "Läs in igen" }).click();

    await expect.poll(() => reads).toBe(1);
    await expect(dialog.getByText("Blocket har ändrats", { exact: true })).toHaveCount(0);
    await expect(row(dialog, 1)).toBeVisible();
    expect(misses, MISSES).toEqual([]);
  });
}

for (const size of VIEWPORTS) {
  test(`Förlägg blocket at ${size.name}: a block that follows another is not placed itself, and says which block to place instead`, async ({
    page,
    baseURL,
  }) => {
    const { dialog, misses } = await openDialog(page, baseURL!, size, "light", { follows: true, scenario: "none" });

    await expect(
      dialog.getByText(
        "Blocket läggs på samma tider som Elevens val åk 7 och förläggs inte själv. Förlägg Elevens val åk 7 i stället, så följer det här med. Förläggningar som redan finns kan tas bort här.",
      ),
    ).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Lägg till lektion" })).toHaveCount(0);
    await expect(saveButton(dialog)).toBeDisabled();
    expectInFlow(await layout(dialog), `${size.name} a block that follows`, 0);
    const { violations } = await scan(page);
    expect(violations, format(violations)).toEqual([]);
    expect(misses, MISSES).toEqual([]);
  });
}

test("Förlägg blocket by keyboard: the focus starts in the dialog at the first field, stays in it, runs in reading order, and comes back on Escape", async ({
  page,
  baseURL,
}) => {
  const { dialog, misses, opener } = await openDialog(page, baseURL!, { width: 375, height: 812 }, "light");
  await expect(row(dialog, 1).getByLabel("Dag", { exact: true })).toBeFocused();

  const nameOfFocus = () =>
    page.evaluate(() => {
      const active = document.activeElement as HTMLInputElement;
      return active.getAttribute("aria-label") ?? active.labels?.[0]?.textContent ?? active.textContent ?? "";
    });
  // A time field is three stops of its own in Chrome (hours, minutes, the picker), all the field's name: said once.
  const order: string[] = [];
  for (let step = 0; step < 30 && order.at(-1) !== "Stäng"; step += 1) {
    const name = (await nameOfFocus()).trim();
    if (order.at(-1) !== name) order.push(name);
    await page.keyboard.press("Tab");
    // Never out of the dialog: it holds the focus.
    expect(await dialog.evaluate((root) => root.contains(document.activeElement))).toBe(true);
  }
  expect(order).toEqual([
    "Dag",
    "Starttid",
    "Längd",
    ...POST_NAMES.map((name) => `Sal: ${name}`),
    "Ta bort lektion 1",
    "Lägg till lektion",
    "Avbryt",
    "Spara",
    // The X in the dialog's corner is the last stop; after it the focus goes round to the first.
    "Stäng",
  ]);
  expect((await nameOfFocus()).trim()).toBe("Dag");

  // Backwards from the first goes round to the last, and stays in the dialog.
  await page.keyboard.press("Shift+Tab");
  expect((await nameOfFocus()).trim()).toBe("Stäng");
  expect(await dialog.evaluate((root) => root.contains(document.activeElement))).toBe(true);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  expect(misses, MISSES).toEqual([]);
});
