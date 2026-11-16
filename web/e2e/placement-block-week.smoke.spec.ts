import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { scanBothSchemes, setScheme } from "./axe";
import { askForScenario, freezeClock, settle, signIn, signInAs, watchStubMisses } from "./signed-in";
import {
  BLOCK,
  BLOCK_POST_IDS,
  BLOCK_WEEK_FOLLOWER_SCENARIO,
  BLOCK_WEEK_REFUSE_SCENARIO,
  BLOCK_WEEK_RED_SCENARIO,
  BLOCK_WEEK_SCENARIO,
  BLOCK_WEEK_STALE_SCENARIO,
} from "./stub/fixtures/timplan-block-placements";
import { EXPEDITION, READER, STUB_ORIGIN } from "./stub/sessions";

/**
 * Förlägg i veckan, a PARALLEL BLOCK's lessons, in a browser (C2).
 *
 * What the page makes of an answer, key by key, and what each gesture writes, is page.blocks.test.tsx's, in jsdom. jsdom has no layout, no
 * pointer and no focus that moves, so what is asked here is what only a browser can say:
 *
 *   - a block's brick pulled with the mouse lands where it is let go, for every post of the block; a brick chosen and a time pressed (a phone
 *     cannot drag, at 320 px and 375 px); and a lesson laid, moved and taken away with the keyboard alone (Tab, Enter, the arrow keys), with a
 *     room chosen for one post and "Motorn väljer sal" for the other (the choice is made from the list, and the empty value is sent as no room);
 *   - the keyboard is left on the card that was laid, and the sentence for what was done is said in a live region;
 *   - undo and redo as writes on the key OUR last write left; a drop the mirror refuses and the gateway refuses, each said with the POST that clashes
 *     and the brick left where it was; a block somebody else has written (409 BLOCK_PLACEMENTS_STALE: read again, and the same drop then made on the
 *     new key); a lesson that stopped holding, ringed, named in the red box and after every save, and a new lesson beside it refused with the word that the
 *     red one has to be moved or taken away first; a block that cannot be placed says why, and has no brick;
 *   - at 320 px, 375 px and 1280 px, in both themes, with a block name of one long word and a wide font: no line of the bricks, the row, the message
 *     or the dialog reaches past its box (the rectangle of the text, not the element's box), and the page does not scroll sideways; axe for the
 *     administrator, the läsare and the expedition (who see the cards and are offered no brick);
 *   - the address that names a block's lesson marks its card and moves the keyboard to it, and says in words when the lesson is not there.
 *
 * The stub remembers what it is written, per scenario name (stub/fixtures/timplan-block-placements.ts BLOCK_WEEK_SCENARIO): every test names its
 * own, since the suites run side by side against one stub.
 */

const PAGE = "/sv/admin/placements";
const MISSES = "the backend stub could not answer these reads; each says which file to add it to or fix";

const VIEWPORTS = [
  { name: "320×700", width: 320, height: 700 },
  { name: "375×812", width: 375, height: 812 },
  { name: "1280×800", width: 1280, height: 800 },
];
const SCHEMES = ["light", "dark"] as const;

const LONG_BLOCK_NAME = "Språkvalsblocketförårskurssjuochåttamedettmycketlångtnamnutanmellanslag";
const WIDE_FONT = "body, button, input, select { font-family: 'DejaVu Sans Mono', monospace !important }";

/** The block's two posts, as the page names them: Spanska (Cecilia) and Franska (Eva). */
const SPANSKA = BLOCK_POST_IDS[0]!;
const SPANSKA_NAME = "Moderna språk Moderna språk spanska 7–9";
const FRANSKA_NAME = "Moderna språk Moderna språk franska 7";

const BRICK_60 = `[data-brick='block:${BLOCK.id}|60#1']`;
const BRICK_40 = `[data-brick='block:${BLOCK.id}|40#1']`;

const scenarioName = (kind: string) => `${kind}:${randomUUID()}`;

interface Opened {
  misses: string[];
  puts: Array<{ url: string; body: { placements: Array<Record<string, unknown>>; baseKey?: string } }>;
}

async function open(
  page: Page,
  baseURL: string,
  options: { size?: { width: number; height: number }; scheme?: (typeof SCHEMES)[number]; scenario?: string; persona?: "admin" | "reader" | "expedition"; address?: string } = {},
): Promise<Opened> {
  const persona = options.persona ?? "admin";
  if (persona === "admin") await signIn(page.context(), "admin", baseURL);
  else await signInAs(page.context(), persona === "reader" ? READER : EXPEDITION, baseURL);
  await freezeClock(page);
  await askForScenario(page, options.scenario ?? scenarioName(BLOCK_WEEK_SCENARIO));
  const misses = watchStubMisses(page);
  const puts: Opened["puts"] = [];
  page.on("request", (request) => {
    if (request.method() === "PUT" && request.url().startsWith(STUB_ORIGIN) && request.url().endsWith("/placements")) {
      puts.push({ url: request.url(), body: JSON.parse(request.postData() ?? "{}") });
    }
  });
  // Tall: the list of bricks and the whole week are in view at once, so that a pointer can go from one to the other without scrolling.
  await page.setViewportSize(options.size ?? { width: 1280, height: 1600 });
  await page.goto(options.address ?? PAGE);
  await settle(page);
  await setScheme(page, options.scheme ?? "light", true);
  await expect(page.getByRole("heading", { level: 1, name: "Förlägg i veckan" })).toBeVisible();
  return { misses, puts };
}

/** The five day columns of the editable week, in order. */
const columns = (page: Page) => page.locator("[data-writes-inert='SCHEMALAGGNING DRIFT']");

/** A time in the week: a day (1–5) and a clock time. */
type When = { day: number; hour: number; minute?: number };

/**
 * The middle of a day column at a time. The column is the school day, 08:00 to 18:00, and its height is whatever the grid made it: a block's card
 * has four lines of text and the grid grows the hour to fit them, so the pixels a minute are measured from the column and not assumed.
 */
async function spot(page: Page, when: When) {
  const box = (await columns(page).nth(when.day - 1).boundingBox())!;
  const perMinute = box.height / (18 * 60 - 8 * 60);
  // Half a minute in: the grid snaps a drop to five minutes, and a little more would land on the next.
  return { x: box.x + box.width / 2, y: box.y + (when.hour * 60 + (when.minute ?? 0) - 480 + 0.5) * perMinute };
}

/**
 * A brick pulled to a time. The block's bricks stand after every post's in a list that scrolls, so the brick is brought into view FIRST and the
 * time is measured after: scrolling the list moves nothing else, but a target measured before it would be the one thing that went stale.
 */
async function pull(page: Page, brick: Locator, when: When) {
  await brick.scrollIntoViewIfNeeded();
  const from = (await brick.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2 + 12, { steps: 3 });
  // Measured again with the drag begun: a notice that grows or goes while the pointer is down moves the week, and a target measured before it would be stale.
  await page.mouse.move((await spot(page, when)).x, (await spot(page, when)).y - 40, { steps: 5 });
  const to = await spot(page, when);
  await page.mouse.move(to.x, to.y, { steps: 3 });
  // The grid draws its ghost (and decides whether the drop is valid) in an animation frame: let go only when it has drawn the one under the pointer, as a hand would.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.mouse.up();
}

/** The card of a lesson of the block: named by the lesson (block, length, day, start, weeks), never by a row's id. */
const cardAt = (page: Page, minutes: number, day: number, start: string) => page.locator(`[data-lesson-id='blockplacement:${BLOCK.id}|${minutes}|${day}|${start}|ALL_WEEKS']`);

/** Text for a reader that cannot be seen is not measured; every other line of text must lie inside the box it stands in. */
function measure(page: Page, selector: string) {
  return page.evaluate((boxSelector) => {
    const EPS = 0.5;
    const problems: string[] = [];
    for (const box of document.querySelectorAll(boxSelector)) {
      const outer = box.getBoundingClientRect();
      const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node as Text;
        if (!text.data.trim() || text.parentElement?.closest(".sr-only")) continue;
        const range = document.createRange();
        range.selectNodeContents(text);
        for (const rect of range.getClientRects()) {
          if (rect.width > 0 && (rect.left < outer.left - EPS || rect.right > outer.right + EPS)) {
            problems.push(`text past its box sideways: "${text.data.trim().slice(0, 40)}" ${Math.round(rect.left)}–${Math.round(rect.right)} in ${Math.round(outer.left)}–${Math.round(outer.right)}`);
          }
        }
      }
      if (box.scrollWidth > box.clientWidth + 1) problems.push(`a box scrolls sideways: ${(box.textContent ?? "").trim().slice(0, 40)}`);
    }
    return { problems, pageScrollsSideways: document.documentElement.scrollWidth > window.innerWidth };
  }, selector);
}

const BOXES = "#placement-to-lay, [data-testid='lay-row'], [data-testid='placement-message'], [data-testid='placement-status'], [role='dialog']";

const KEY_ONE = "00000000000000000000000000000001";

test.describe("Att lägga", () => {
  test("is one brick for each lesson the block has, under the block, and the posts of the block have none", async ({ page, baseURL }) => {
    const { misses } = await open(page, baseURL!);
    await expect(page.locator(BRICK_60)).toBeVisible();
    await expect(page.locator(BRICK_40)).toBeVisible();
    await expect(page.getByTestId("brick-block")).toContainText("Språkval åk 7");
    // The two posts of the block have no brick of their own: only the block's two.
    await expect(page.locator("[data-brick^='block:']")).toHaveCount(2);
    for (const post of BLOCK_POST_IDS.slice(0, 2)) await expect(page.locator(`[data-brick^='${post}|']`)).toHaveCount(0);
    // A brick says the block, its length and how many posts sit it, for a screen reader that lands on the brick.
    await expect(page.locator(BRICK_60)).toHaveAccessibleName("Språkval åk 7, 60 min, 2 poster");
    expect(misses, MISSES).toEqual([]);
  });

  test("is no brick at all for a block that takes another block's times, which says so by that block's name", async ({ page, baseURL }) => {
    const { misses } = await open(page, baseURL!, { scenario: scenarioName(BLOCK_WEEK_FOLLOWER_SCENARIO) });
    await expect(page.locator("[data-brick^='block:']")).toHaveCount(0);
    await expect(page.getByTestId("placement-block").first()).toContainText("Ledarblocket");
    expect(misses, MISSES).toEqual([]);
  });
});

test.describe("laying a lesson of the block", () => {
  test("a brick pulled into the week lays the lesson for both posts where it is let go, on top of the key that was read", async ({ page, baseURL }) => {
    const { puts, misses } = await open(page, baseURL!);
    await pull(page, page.locator(BRICK_60), { day: 4, hour: 9 });
    await expect.poll(() => puts.length).toBe(1);
    expect(puts[0]!.url).toContain(`/teaching-blocks/${BLOCK.id}/placements`);
    expect(puts[0]!.body.baseKey).toBe(KEY_ONE);
    expect(puts[0]!.body.placements).toEqual([{ dayOfWeek: 4, startTime: "09:00", minutes: 60, rooms: [] }]);
    await expect(cardAt(page, 60, 4, "09:00")).toBeVisible();
    await expect(page.getByTestId("placement-status")).toContainText("Gäller från nästa Generera.");
    // The brick is gone (the block's 60 minutes are laid), the 40 is still to lay.
    await expect(page.locator(BRICK_60)).toHaveCount(0);
    await expect(page.locator(BRICK_40)).toBeVisible();
    expect(misses, MISSES).toEqual([]);
  });

  for (const size of VIEWPORTS.slice(0, 2)) {
    test(`at ${size.name}: a brick chosen and a time pressed lays the lesson (a phone cannot drag)`, async ({ page, baseURL }) => {
      const { puts, misses } = await open(page, baseURL!, { size });
      await page.locator(BRICK_40).click();
      await expect(page.locator(BRICK_40)).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByTestId("lay-row")).toBeVisible();
      const column = columns(page).nth(4);
      await column.scrollIntoViewIfNeeded();
      const perMinute = (await column.boundingBox())!.height / 600;
      await column.click({ position: { x: 20, y: (13 * 60 - 480 + 2) * perMinute } });
      await expect.poll(() => puts.length).toBe(1);
      expect(puts[0]!.body.placements.at(-1)).toMatchObject({ dayOfWeek: 5, startTime: "13:00", minutes: 40 });
      await expect(cardAt(page, 40, 5, "13:00")).toHaveCount(1);
      expect(misses, MISSES).toEqual([]);
    });
  }

  test("with the keyboard alone: choose the brick, give a time and a room for one post, lay it, move it, and take it away", async ({ page, baseURL }) => {
    const { puts, misses } = await open(page, baseURL!);
    await page.locator(BRICK_60).focus();
    await page.keyboard.press("Enter");
    const row = page.getByTestId("lay-row");
    await expect(row).toBeVisible();
    // The first field has the keyboard, and says in words that the time is free.
    await expect(row.getByLabel("Dag")).toBeFocused();
    await expect(row.getByTestId("place-verdict")).toContainText("Ledigt");
    await page.keyboard.press("ArrowDown"); // the day
    await page.keyboard.press("Tab");
    await expect(row.getByLabel("Starttid")).toBeFocused();
    // The hours, and the minutes after them: a time is typed digit by digit.
    await page.keyboard.type("1315");
    // A room for the first post; the second stays on "Motorn väljer sal", which is the first choice of its list.
    const spanska = row.getByLabel(/^Sal: .*spanska/);
    const franska = row.getByLabel(/^Sal: .*franska/);
    await expect(franska).toHaveValue("");
    await spanska.selectOption({ label: "NO-salen" });
    await expect(spanska).not.toHaveValue("");
    // The empty choice is one a reader can make from the list: choose a room, then the engine's choice again, and it is the empty value (a hidden option would not be).
    await franska.selectOption({ label: "Sal 101" });
    await franska.selectOption({ label: "Motorn väljer sal" });
    await expect(franska).toHaveValue("");
    await row.getByRole("button", { name: "Lägg", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => puts.length).toBe(1);
    const sent = puts[0]!.body.placements.at(-1)!;
    expect(sent).toMatchObject({ startTime: "13:15", minutes: 60 });
    // Only the post that chose a room is sent with one: the other has the engine's choice.
    expect(sent["rooms"]).toEqual([{ requirementId: SPANSKA, roomId: expect.stringMatching(/^[0-9a-f-]{36}$/) }]);
    const day = sent["dayOfWeek"] as number;

    // The keyboard is left on the card that was laid; an arrow key moves it a quarter of an hour, and its room goes with it.
    const card = cardAt(page, 60, day, "13:15");
    await expect(card).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect.poll(() => puts.length).toBe(2);
    expect(puts[1]!.body.placements.at(-1)).toMatchObject({ dayOfWeek: day, startTime: "13:30", rooms: sent["rooms"] });
    await expect(cardAt(page, 60, day, "13:30")).toBeFocused();

    // Enter opens it: change or take it away, with no question (a block has no pairs). The brick it was is back in Att lägga.
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Dag")).toBeFocused();
    await dialog.getByRole("button", { name: "Ta bort" }).focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => puts.length).toBe(3);
    expect(puts[2]!.body.placements).toEqual([]);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator(BRICK_60)).toBeVisible();
    expect(misses, MISSES).toEqual([]);
  });

  test("a card pulled to another time moves, with the rooms its posts chose", async ({ page, baseURL }) => {
    const { puts } = await open(page, baseURL!, { scenario: scenarioName(BLOCK_WEEK_RED_SCENARIO) });
    // The red scenario has two lessons; its Tuesday 10:00 lesson has a room for each post.
    const card = cardAt(page, 60, 2, "10:00");
    await expect(card).toBeVisible();
    const from = (await card.boundingBox())!;
    const to = await spot(page, { day: 4, hour: 9 });
    await page.mouse.move(from.x + from.width / 2, from.y + 4);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 + 12, from.y + 14, { steps: 3 });
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.mouse.up();
    await expect.poll(() => puts.length).toBe(1);
    expect(puts[0]!.body.placements).toHaveLength(2);
    const moved = puts[0]!.body.placements.find((lesson) => lesson["minutes"] === 60)!;
    // The grid snaps to five minutes from where the card was held: not its old time, on Thursday morning.
    expect(moved).toMatchObject({ dayOfWeek: 4 });
    expect(moved["startTime"]).not.toBe("10:00");
    // Both posts chose a room for this lesson (the stub's Tuesday lesson), and both go with it.
    expect(moved["rooms"]).toEqual(BLOCK_POST_IDS.slice(0, 2).map((requirementId) => ({ requirementId, roomId: expect.stringMatching(/^[0-9a-f-]{36}$/) })));
  });
});

test.describe("undo and redo", () => {
  test("write the block's list as it was, on top of the key the last write left; Ctrl+Z does the same", async ({ page, baseURL }) => {
    const { puts, misses } = await open(page, baseURL!);
    await pull(page, page.locator(BRICK_60), { day: 4, hour: 9 });
    await expect.poll(() => puts.length).toBe(1);
    await expect(cardAt(page, 60, 4, "09:00")).toBeVisible();
    await page.getByRole("button", { name: "Ångra" }).click();
    await expect.poll(() => puts.length).toBe(2);
    expect(puts[1]!.body.placements).toEqual([]);
    expect(puts[1]!.body.baseKey).not.toBe(KEY_ONE);
    await expect(cardAt(page, 60, 4, "09:00")).toHaveCount(0);
    await page.getByRole("button", { name: "Gör om" }).click();
    await expect.poll(() => puts.length).toBe(3);
    await expect(cardAt(page, 60, 4, "09:00")).toBeVisible();
    await page.keyboard.press("Control+z");
    await expect.poll(() => puts.length).toBe(4);
    await expect(cardAt(page, 60, 4, "09:00")).toHaveCount(0);
    expect(misses, MISSES).toEqual([]);
  });
});

test.describe("what the mirror and the gateway say", () => {
  test("a brick pulled onto a time a post's teacher is busy is refused in words that name the POST, and nothing is written", async ({ page, baseURL }) => {
    // Cecilia teaches the Spanish post's group on Wednesday at 10:00 (a lesson Generera keeps).
    const { puts } = await open(page, baseURL!);
    await pull(page, page.locator(BRICK_60), { day: 3, hour: 10, minute: 15 });
    const message = page.getByTestId("placement-message");
    await expect(message).toContainText(SPANSKA_NAME);
    await expect(message).toContainText("Läraren har redan");
    expect(puts).toHaveLength(0);
    await expect(page.locator(BRICK_60)).toBeVisible();
  });

  test("a drop the gateway refuses says which post and why, leaves the brick where it was, and the sentence stays under the fields", async ({ page, baseURL }) => {
    const { puts } = await open(page, baseURL!, { scenario: scenarioName(BLOCK_WEEK_REFUSE_SCENARIO) });
    await pull(page, page.locator(BRICK_60), { day: 4, hour: 9 });
    await expect(page.getByTestId("placement-message")).toContainText(FRANSKA_NAME);
    await expect(page.getByTestId("placement-message")).toContainText("Läraren har redan");
    expect(puts).toHaveLength(1);
    await expect(page.locator(BRICK_60)).toBeVisible();
    await expect(cardAt(page, 60, 4, "09:00")).toHaveCount(0);
  });

  test("a block somebody else has written is refused with its own message, read again, and the same drop is then made on top of the new key", async ({ page, baseURL }) => {
    const { puts } = await open(page, baseURL!, { scenario: scenarioName(BLOCK_WEEK_STALE_SCENARIO) });
    const board = page.waitForResponse((response) => response.url().includes("/placements/board") && response.status() === 200, { timeout: 15_000 });
    await pull(page, page.locator(BRICK_60), { day: 4, hour: 9 });
    await expect(page.getByTestId("placement-message")).toContainText("Någon annan har ändrat blockets");
    await board;
    expect(puts).toHaveLength(1);
    await expect(cardAt(page, 60, 4, "09:00")).toHaveCount(0);
    await pull(page, page.locator(BRICK_60), { day: 4, hour: 9 });
    await expect.poll(() => puts.length).toBe(2);
    expect(puts[1]!.body.baseKey).not.toBe(puts[0]!.body.baseKey);
    await expect(cardAt(page, 60, 4, "09:00")).toBeVisible();
  });
});

test.describe("a lesson that stopped holding", () => {
  test("is ringed, named once in the red box with its post, said again after a change beside it, and a new lesson beside it is refused until it is moved or taken away", async ({ page, baseURL }) => {
    const { puts, misses } = await open(page, baseURL!, { scenario: scenarioName(BLOCK_WEEK_RED_SCENARIO) });
    // Thursday 13:15 does not hold for the second post: a ring on the card, and one line in the red box, the post named.
    await expect(cardAt(page, 40, 4, "13:15")).toHaveClass(/ring-destructive/);
    await expect(cardAt(page, 60, 2, "10:00")).not.toHaveClass(/ring-destructive/);
    await expect(page.getByText("1 förläggning håller inte längre")).toBeVisible();
    const lines = page.getByTestId("failing-row");
    await expect(lines).toHaveCount(1);
    await expect(lines.first()).toContainText("Språkval åk 7");
    await expect(lines.first()).toContainText(FRANSKA_NAME);

    // A change of the other lesson is made, and the message says that the red one is still red, by lesson and post.
    await cardAt(page, 60, 2, "10:00").focus();
    await page.keyboard.press("ArrowDown");
    await expect.poll(() => puts.length).toBe(1);
    await expect(page.getByTestId("placement-message")).toContainText("håller fortfarande inte");
    await expect(page.getByTestId("placement-message")).toContainText(FRANSKA_NAME);
    await expect(page.getByTestId("placement-message")).toContainText("Gäller från nästa Generera.");

    // Take the 60-minute lesson away: its brick is back. Laid onto the red lesson it is refused, and the message says why: move or remove the red one first.
    await cardAt(page, 60, 2, "10:15").focus();
    await page.keyboard.press("Enter");
    await page.getByRole("dialog").getByRole("button", { name: "Ta bort" }).click();
    // The lesson is a brick again, and the keyboard is on it: the page is still before the pointer goes down.
    await expect(page.locator(BRICK_60)).toBeFocused();
    await pull(page, page.locator(BRICK_60), { day: 4, hour: 13, minute: 30 });
    await expect(page.getByTestId("placement-message")).toContainText("En ny lektion intill den nekas tills den har flyttats eller tagits bort");
    expect(puts).toHaveLength(2);
    expect(misses, MISSES).toEqual([]);
  });

  test("taken away, it is a brick again, and the red box is gone", async ({ page, baseURL }) => {
    const { puts } = await open(page, baseURL!, { scenario: scenarioName(BLOCK_WEEK_RED_SCENARIO) });
    await cardAt(page, 40, 4, "13:15").focus();
    await page.keyboard.press("Enter");
    await page.getByRole("dialog").getByRole("button", { name: "Ta bort" }).click();
    await expect.poll(() => puts.length).toBe(1);
    await expect(page.locator(BRICK_40)).toBeVisible();
    await expect(page.getByTestId("failing-row")).toHaveCount(0);
    await expect(page.getByTestId("placement-status")).toContainText("Tog bort Språkval åk 7");
  });
});

test.describe("the lists", () => {
  test("the block has its own list with the lessons and their verdicts, and its posts say which block they are laid with", async ({ page, baseURL }) => {
    const { misses } = await open(page, baseURL!, { scenario: scenarioName(BLOCK_WEEK_RED_SCENARIO) });
    const entry = page.getByTestId("placement-block").first();
    await expect(entry).toContainText("Språkval åk 7");
    await expect(entry.getByTestId("placement-block-row")).toHaveCount(2);
    await expect(entry.getByTestId("placement-block-row").last()).toContainText(FRANSKA_NAME);
    const post = page.getByTestId("placement-post").filter({ hasText: FRANSKA_NAME });
    await expect(post).toContainText("Språkval åk 7");
    expect(misses, MISSES).toEqual([]);
  });
});

test.describe("the address that names a lesson of the block", () => {
  test("marks its card and moves the keyboard to it, and opens nothing", async ({ page, baseURL }) => {
    const { misses } = await open(page, baseURL!, { scenario: scenarioName(BLOCK_WEEK_RED_SCENARIO), address: `${PAGE}?post=${SPANSKA}&day=2&start=10:00&block=${BLOCK.id}` });
    const card = cardAt(page, 60, 2, "10:00");
    await expect(card).toBeFocused();
    await expect(card).toHaveClass(/outline-2/);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByTestId("placement-link-gone")).toHaveCount(0);
    expect(misses, MISSES).toEqual([]);
  });

  test("says in words that the lesson is not there any more, and marks nothing", async ({ page, baseURL }) => {
    await open(page, baseURL!, { scenario: scenarioName(BLOCK_WEEK_RED_SCENARIO), address: `${PAGE}?post=${SPANSKA}&day=5&start=08:00&block=${BLOCK.id}` });
    await expect(page.getByTestId("placement-link-gone")).toBeVisible();
    await expect(page.getByTestId("placement-link-gone")).toHaveAttribute("role", "status");
    await expect(page.locator("[data-lesson-id^='blockplacement:'].outline-2")).toHaveCount(0);
  });
});

for (const size of VIEWPORTS) {
  for (const scheme of SCHEMES) {
    test(`at ${size.name}, ${scheme}: the list of bricks, the row, the message and the dialog stay inside their boxes, and the page does not scroll sideways`, async ({ page, baseURL }) => {
      const { misses } = await open(page, baseURL!, { size, scheme, scenario: scenarioName(BLOCK_WEEK_RED_SCENARIO) });
      // The red scenario has both lessons laid: take the 40 away to have a brick to choose.
      await cardAt(page, 40, 4, "13:15").click();
      await expect(page.getByRole("dialog")).toBeVisible();
      let facts = await measure(page, BOXES);
      expect(facts.problems, "the dialog's text, measured by its own rectangles").toEqual([]);
      expect(facts.pageScrollsSideways, "the page scrolls sideways").toBe(false);
      await page.getByRole("dialog").getByRole("button", { name: "Ta bort" }).click();
      await expect(page.locator(BRICK_40)).toBeVisible();
      await page.locator(BRICK_40).click();
      await expect(page.getByTestId("lay-row")).toBeVisible();
      await expect(page.getByTestId("lay-row").getByLabel("Dag")).toBeVisible();
      facts = await measure(page, BOXES);
      expect(facts.problems, "text measured by its own rectangles").toEqual([]);
      expect(facts.pageScrollsSideways, "the page scrolls sideways").toBe(false);
      // A time a post's teacher is busy is said in words, with the post.
      await page.getByTestId("lay-row").getByLabel("Dag").selectOption("3");
      await page.getByTestId("lay-row").getByLabel("Starttid").fill("10:15");
      await expect(page.getByTestId("place-verdict")).toContainText("Läraren har redan");
      facts = await measure(page, BOXES);
      expect(facts.problems).toEqual([]);
      expect(misses, MISSES).toEqual([]);
    });

    test(`at ${size.name}, ${scheme}: a block name of one long word and a wide font stay inside the bricks, the row and the dialog`, async ({ page, baseURL }) => {
      // The block's name is what the board says: rewritten on its way to the page.
      await page.route(`${STUB_ORIGIN}/api/v1/teaching-requirements/placements/board*`, async (route) => {
        const response = await route.fetch();
        const board = (await response.json()) as { blocks: Array<{ id: string; name: string }> };
        await route.fulfill({ response, body: JSON.stringify({ ...board, blocks: board.blocks.map((block) => ({ ...block, name: LONG_BLOCK_NAME })) }) });
      });
      const { misses } = await open(page, baseURL!, { size, scheme, scenario: scenarioName(BLOCK_WEEK_RED_SCENARIO) });
      await page.addStyleTag({ content: WIDE_FONT });
      await cardAt(page, 60, 2, "10:00").click();
      await expect(page.getByRole("dialog")).toContainText(LONG_BLOCK_NAME);
      let facts = await measure(page, BOXES);
      expect(facts.problems, "the dialog's text").toEqual([]);
      await page.getByRole("dialog").getByRole("button", { name: "Ta bort" }).click();
      await expect(page.locator(BRICK_60)).toBeVisible();
      await page.locator(BRICK_60).click();
      await expect(page.getByTestId("lay-row")).toContainText(LONG_BLOCK_NAME);
      facts = await measure(page, BOXES);
      expect(facts.problems, "text measured by its own rectangles").toEqual([]);
      expect(facts.pageScrollsSideways).toBe(false);
      expect(misses, MISSES).toEqual([]);
    });
  }
}

test.describe("who may write", () => {
  test("the läsare sees the block's cards, opens one, and is offered nothing that writes", async ({ page, baseURL }) => {
    const { puts, misses } = await open(page, baseURL!, { persona: "reader", scenario: scenarioName(BLOCK_WEEK_RED_SCENARIO), size: { width: 1280, height: 900 } });
    await expect(page.locator("[data-brick]")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Ångra" })).toBeHidden();
    await expect(columns(page)).toHaveCount(0);
    await expect(cardAt(page, 60, 2, "10:00")).toBeVisible();
    await cardAt(page, 60, 2, "10:00").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Spara" })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Ta bort" })).toHaveCount(0);
    await expect(dialog.getByLabel(/^Sal: /)).toHaveCount(0);
    expect(puts).toHaveLength(0);
    expect(misses, MISSES).toEqual([]);
  });

  test("the expedition reads the week and the block's cards and is offered nothing that writes Planering", async ({ page, baseURL }) => {
    const { puts, misses } = await open(page, baseURL!, { persona: "expedition", scenario: scenarioName(BLOCK_WEEK_RED_SCENARIO) });
    await expect(page.getByRole("heading", { level: 1, name: "Förlägg i veckan" })).toBeVisible();
    await expect(page.locator("[data-brick]")).toHaveCount(0);
    await expect(columns(page)).toHaveCount(0);
    await expect(cardAt(page, 60, 2, "10:00")).toBeVisible();
    expect(puts).toHaveLength(0);
    expect(misses, MISSES).toEqual([]);
  });
});

test.describe("axe", () => {
  test("the administrator with a block brick chosen and a block's card opened: no violation in either theme, at a phone's width", async ({ page, baseURL }) => {
    const { misses } = await open(page, baseURL!, { size: { width: 375, height: 812 } });
    await page.locator(BRICK_60).click();
    await expect(page.getByTestId("lay-row").getByLabel("Dag")).toBeVisible();
    let reports = await scanBothSchemes(page, "placements-block-lay", true);
    expect(reports, reports.join("\n")).toEqual([]);
    await page.getByRole("button", { name: "Välj bort" }).click();
    await pull(page, page.locator(BRICK_60), { day: 4, hour: 9 }).catch(() => undefined);
    expect(misses, MISSES).toEqual([]);
  });

  test("the administrator with a lesson that stopped holding, its dialog open: no violation in either theme, at a phone's width", async ({ page, baseURL }) => {
    const { misses } = await open(page, baseURL!, { size: { width: 375, height: 812 }, scenario: scenarioName(BLOCK_WEEK_RED_SCENARIO) });
    await cardAt(page, 40, 4, "13:15").click();
    await expect(page.getByRole("dialog")).toBeVisible();
    const reports = await scanBothSchemes(page, "placements-block-card", true);
    expect(reports, reports.join("\n")).toEqual([]);
    expect(misses, MISSES).toEqual([]);
  });

  for (const persona of ["reader", "expedition"] as const) {
    test(`the ${persona} with the block's cards: no violation in either theme, at a phone's width`, async ({ page, baseURL }) => {
      const { misses } = await open(page, baseURL!, { persona, size: { width: 375, height: 812 }, scenario: scenarioName(BLOCK_WEEK_RED_SCENARIO) });
      const reports = await scanBothSchemes(page, `placements-block-${persona}`, true);
      expect(reports, reports.join("\n")).toEqual([]);
      expect(misses, MISSES).toEqual([]);
    });
  }
});
