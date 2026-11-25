import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { scanBothSchemes, setScheme } from "./axe";
import { askForScenario, freezeClock, settle, signIn, watchStubMisses } from "./signed-in";
import { SUGGESTIONS_SCENARIO } from "./stub/fixtures/suggestions-world";

/**
 * The card of what to change, for a week that was refused or ran out of time (G6 Åtgärdsförslag vid vägran), where its text and its boxes
 * stand, and the walk itself.
 *
 * What the card makes of the gateway's answer is the unit tests' (the proof it says, the figures, the links), in jsdom. jsdom has no
 * layout and no navigation, so what is asked here is what only a browser can say:
 *
 *   - from a refused run one press asks for the analysis, the card says it is counting, and then it shows three changes of the four the
 *     engine found, each with how well it is shown, its link, and a line that one more belongs to the list;
 *   - from a timeout the card says what is already known (what the probe measured) before the engine is asked, and after the press
 *     shows the one change the engine solved the week with, with its proof;
 *   - from a timeout where the engine finds nothing the card says that, and that it is no proof;
 *   - every link goes to the page that owns the data, with the row named by a uuid;
 *   - at 320, 375 and 1280 px, in both themes, with a long name and a wide font, no line is cut and nothing scrolls sideways (every text
 *     measured by the rectangle of its own characters, a Range, because a parent that clips hides a name that is cut);
 *   - axe finds nothing on the card in any of its states.
 *
 * The scenarios are suggestions-<case>:<unique> (e2e/stub/fixtures/suggestions-world.ts); each test names its own, since the suites run
 * against one stub and the stub remembers the press per scenario name.
 */

const GENERATE = "/sv/admin/generate";
const MISSES = "the backend stub could not answer these reads; each says which file to add it to or fix";

const VIEWPORTS = [
  { name: "320×700", width: 320, height: 700 },
  { name: "375×812", width: 375, height: 812 },
  { name: "1280×800", width: 1280, height: 800 },
];
const SCHEMES = ["light", "dark"] as const;
const WIDE_FONT = "body, button, input, select { font-family: 'DejaVu Sans Mono', monospace !important }";

const scenarioOf = (name: "refusal" | "timeout" | "nothing" | "saved") => `${SUGGESTIONS_SCENARIO}-${name}:${randomUUID()}`;

async function open(page: Page, baseURL: string, scenario: string, size: { width: number; height: number }, scheme: (typeof SCHEMES)[number]) {
  await signIn(page.context(), "admin", baseURL);
  await freezeClock(page);
  await askForScenario(page, scenario);
  const misses = watchStubMisses(page);
  await page.setViewportSize(size);
  await page.goto(GENERATE);
  await settle(page);
  await setScheme(page, scheme, true);
  await expect(page.getByRole("heading", { level: 1, name: "Generera schema" })).toBeVisible();
  return misses;
}

/**
 * Waits for the card of the last run. Generera is not pressed: the run is the year's newest in the history, and the page takes it up as it
 * would a run it had started (D9), so the card is there when the page has loaded. A press that the walk does not need would also hide a page
 * that has lost the history's run behind the press's own answer.
 */
async function lastRun(page: Page) {
  await expect(page.locator("#last-run")).toBeVisible();
}

const CARD = "section[aria-labelledby='suggestions-title']";
/** The list of changes: the numbered list, and not the list of what is known before the engine is asked. */
const CHANGES = "ol > li";

/** Every line of text in the boxes named, measured by the rectangles of the characters, and whether the page scrolls sideways. */
function measure(page: Page, selector: string) {
  return page.evaluate((boxSelector) => {
    const EPS = 0.5;
    const problems: string[] = [];
    const textNodes = (root: Element): Text[] => {
      const found: Text[] = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node as Text;
        if (!text.data.trim() || text.parentElement?.closest(".sr-only")) continue;
        found.push(text);
      }
      return found;
    };
    const boxes = [...document.querySelectorAll(boxSelector)];
    for (const box of boxes) {
      const outer = box.getBoundingClientRect();
      for (const text of textNodes(box)) {
        const range = document.createRange();
        range.selectNodeContents(text);
        for (const rect of range.getClientRects()) {
          if (rect.width === 0 || rect.height === 0) continue;
          if (rect.left < outer.left - EPS || rect.right > outer.right + EPS) {
            problems.push(`text past its box sideways: "${text.data.trim().slice(0, 40)}" ${Math.round(rect.left)}–${Math.round(rect.right)} in ${Math.round(outer.left)}–${Math.round(outer.right)}`);
          }
        }
      }
      if (box.scrollWidth > box.clientWidth + 1) problems.push(`a box scrolls sideways: ${(box.textContent ?? "").trim().slice(0, 40)}`);
    }
    const mine = boxes.flatMap((box) => [box, ...box.querySelectorAll("*")]).filter((element) => !element.closest(".sr-only") && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().right > window.innerWidth + 1);
    return { problems, boxes: boxes.length, mineBeyond: mine.length, pageScrollsSideways: document.documentElement.scrollWidth > window.innerWidth };
  }, selector);
}

for (const size of VIEWPORTS) {
  for (const scheme of SCHEMES) {
    test(`a refused run at ${size.name}, ${scheme}: the offer, the counting and the list stay inside their boxes, a wide font too`, async ({ page, baseURL }) => {
      const misses = await open(page, baseURL!, scenarioOf("refusal"), size, scheme);
      await lastRun(page);
      await page.addStyleTag({ content: WIDE_FONT });

      const card = page.locator(CARD);
      await expect(card.getByRole("heading", { name: "Vad kan jag ändra?" })).toBeVisible();
      await expect(card).toContainText("lägger inget schema och ändrar ingenting");
      await expect(card.getByRole("button", { name: "Räkna fram förslag" })).toBeVisible();

      await card.getByRole("button", { name: "Räkna fram förslag" }).click();
      // The analysis counts, then the answer: the first read after the press is RUNNING, and the page reads the run again.
      await expect(card.getByRole("status")).toContainText("Motorn räknar fram förslag");
      await expect(card.locator(CHANGES)).toHaveCount(3, { timeout: 15_000 });

      // The proof is the list's, and it is said on every change, with the engine's words.
      await expect(card).toContainText("Motorn har löst veckan med just de 4 ändringarna tillsammans");
      await expect(card.getByText("Löser veckan tillsammans (kontrollerat)")).toHaveCount(3);
      await expect(card).toContainText("Tillåt 2 lektioner per dag för Idrott och hälsa för 8A");
      await expect(card).toContainText("Låt Idrott och hälsa för 8A också få använda Gymnastiksalen");
      await expect(card).toContainText("Höj dagstaket för Anna Andersson från 300 till 360 minuter");
      await expect(card).toContainText("Ytterligare 1 ändring hör till samma lösning");
      await expect(card).toContainText("inte hur lång tid nästa Generera tar");

      // Every link goes to the page that owns the data, naming the row by a uuid, and the card changes nothing itself.
      const hrefs = await card.getByRole("link").evaluateAll((links) => links.map((link) => link.getAttribute("href")));
      expect(hrefs).toHaveLength(3);
      expect(hrefs[0]).toMatch(/^\/(sv\/)?admin\/requirements\?post=[0-9a-f-]{36}$/);
      expect(hrefs[1]).toMatch(/^\/(sv\/)?admin\/constraints\?roomRule=[0-9a-f-]{36}$/);
      expect(hrefs[2]).toMatch(/^\/(sv\/)?admin\/people\?workRule=[0-9a-f-]{36}$/);

      const facts = await measure(page, `${CARD}, ${CARD} li`);
      expect(facts.boxes).toBeGreaterThan(3);
      expect(facts.problems, "text measured by its own rectangles").toEqual([]);
      expect(facts.mineBeyond, `the card reaches past the right edge (the page scrolls sideways: ${facts.pageScrollsSideways})`).toBe(0);
      expect(misses, MISSES).toEqual([]);
    });
  }
}

test("a reload brings back the card of the year's newest refused run, and the answer saved on it (D9)", async ({ page, baseURL }) => {
  const misses = await open(page, baseURL!, scenarioOf("refusal"), { width: 1280, height: 800 }, "light");
  const card = page.locator(CARD);

  // Generera is not pressed: the run is the year's newest in the history, and the page takes it up as it would a run it had started.
  await expect(page.locator("#last-run")).toBeVisible();
  await expect(card.getByRole("button", { name: "Räkna fram förslag" })).toBeVisible();

  await card.getByRole("button", { name: "Räkna fram förslag" }).click();
  await expect(card.locator(CHANGES)).toHaveCount(3, { timeout: 15_000 });

  // A reload leaves the page with no run of its own: the answer saved on the run is read again, and the card is where it was.
  await page.reload();
  await settle(page);
  await expect(page.locator("#last-run")).toBeVisible();
  await expect(card.locator(CHANGES)).toHaveCount(3, { timeout: 15_000 });
  await expect(card).toContainText("Tillåt 2 lektioner per dag för Idrott och hälsa för 8A");
  await expect(card).toContainText("Höj dagstaket för Anna Andersson från 300 till 360 minuter");
  expect(misses, MISSES).toEqual([]);
});

test("a run that already carries its analysis shows the list on load, with nothing pressed, and axe finds nothing on it", async ({ page, baseURL }) => {
  const misses = await open(page, baseURL!, scenarioOf("saved"), { width: 1280, height: 900 }, "light");
  const card = page.locator(CARD);

  // The run holds the answer (the column the gateway keeps it in): the card is the list at once, not the offer, and it can be asked again. It is
  // a REFUSED run's card: the account of where the time went belongs to a timeout and is not on the page.
  await lastRun(page);
  await expect(card.locator(CHANGES)).toHaveCount(3, { timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "Så gick tiden" })).toHaveCount(0);
  await expect(card).toContainText("Motorn har löst veckan med just de 4 ändringarna tillsammans");
  await expect(card).toContainText("Ytterligare 1 ändring hör till samma lösning");
  await expect(card.getByRole("button", { name: "Räkna om" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Räkna fram förslag" })).toHaveCount(0);

  expect((await scanBothSchemes(page, "saved analysis", true)).join("\n")).toBe("");
  expect(misses, MISSES).toEqual([]);
});

test("a timeout says what is already known, and after the press shows the one change the engine solved the week with, with its proof", async ({ page, baseURL }) => {
  const misses = await open(page, baseURL!, scenarioOf("timeout"), { width: 1280, height: 900 }, "light");
  await lastRun(page);

  const card = page.locator(CARD);
  // Before the engine is asked: nothing is proved, and what the probe measured is said as a measurement and no figure.
  await expect(card).toContainText("ingenting är bevisat om veckan än");
  await expect(card.getByRole("heading", { name: "Det som redan är känt" })).toBeVisible();
  await expect(card.getByText("Mätt i ett prov")).toBeVisible();
  await expect(card).toContainText("visar inte att en höjning räcker");
  await expect(card).not.toContainText("Löser veckan");
  // The account of where the time went is the page's own, beside it.
  await expect(page.getByRole("heading", { name: "Så gick tiden" })).toBeVisible();

  await card.getByRole("button", { name: "Räkna fram förslag" }).click();
  await expect(card).toContainText("Motorn har löst veckan med just den här ändringen", { timeout: 15_000 });
  await expect(card.locator(CHANGES)).toHaveCount(1);
  await expect(card.getByText("Löser veckan (kontrollerat)")).toBeVisible();
  await expect(card).toContainText("Höj dagstaket för Anna Andersson från 300 till 330 minuter");
  // What was known before is not said beside a list: it was what was known BEFORE it.
  await expect(card.getByRole("heading", { name: "Det som redan är känt" })).toHaveCount(0);
  expect(misses, MISSES).toEqual([]);
});

test("a timeout where the engine finds nothing says that, with its seconds, and that it is no proof", async ({ page, baseURL }) => {
  const misses = await open(page, baseURL!, scenarioOf("nothing"), { width: 1280, height: 900 }, "light");
  await lastRun(page);

  const card = page.locator(CARD);
  await card.getByRole("button", { name: "Räkna fram förslag" }).click();
  await expect(card).toContainText("Motorn hittade inget schema inom 60 s", { timeout: 15_000 });
  // What the probe measured before the engine was asked is still true, and still said as a measurement.
  await expect(card.getByText("Mätt i ett prov")).toBeVisible();
  await expect(card).toContainText("Det är inget bevis för att veckan är omöjlig");
  await expect(card.locator("ol")).toHaveCount(0);
  // The way back: an analysis that found nothing may be asked for again.
  await expect(card.getByRole("button", { name: "Räkna om" })).toBeVisible();
  expect(misses, MISSES).toEqual([]);
});

test("axe finds nothing on the card: offered, counting, with a list, and with nothing found", async ({ page, baseURL }) => {
  const misses = await open(page, baseURL!, scenarioOf("refusal"), { width: 1280, height: 900 }, "light");
  await lastRun(page);
  const card = page.locator(CARD);
  await expect(card.getByRole("button", { name: "Räkna fram förslag" })).toBeVisible();
  const reports = await scanBothSchemes(page, "offered", true);

  await card.getByRole("button", { name: "Räkna fram förslag" }).click();
  await expect(card.locator(CHANGES)).toHaveCount(3, { timeout: 15_000 });
  reports.push(...(await scanBothSchemes(page, "with a list", true)));

  expect(reports.join("\n")).toBe("");
  expect(misses, MISSES).toEqual([]);
});
