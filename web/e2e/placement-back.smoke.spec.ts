import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { scanBothSchemes, setScheme } from "./axe";
import { askForScenario, freezeClock, settle, signIn, signInAs, watchStubMisses } from "./signed-in";
import { PLACEMENT_BACK_SCENARIO } from "./stub/fixtures/placement-back";
import { NEXT_YEAR } from "./stub/fixtures/world";
import { EXPEDITION, READER } from "./stub/sessions";

/**
 * The way back to the week (A3), where its text and its boxes stand, and the walk itself.
 *
 * What the pages make of the gateway's answer is the unit tests' (the links, the row, the sentence, the mark), in jsdom. jsdom has
 * no layout and no navigation, so what is asked here is what only a browser can say:
 *
 *   - from a refusal on Generera one press leads to the week with the card that was named marked and the keyboard on it, and
 *     nothing opened; a lesson that has moved since says so; a block's lesson and a line stored before the ids behave as drawn;
 *   - the grundschema's empty state leads to the week as well as to Generera;
 *   - the week says "Ändrat sedan senaste schemat. Generera om." when the förläggningar are not what the grundschema was written
 *     from, and says nothing when they are, or before the first schema;
 *   - at 320, 375 and 1280 px, in both themes, with a long name and a wide font, no line is cut and nothing scrolls sideways
 *     (every text measured by the rectangle of its own characters, a Range, and not by an element's box, because a parent that
 *     clips hides a name that is cut);
 *   - axe finds nothing for the administrator and the läsare on Generera, and for all three on the week (the expedition is told Generera is
 *     another area's, which is held too).
 *
 * The scenarios are placement-write:back-<case>:<unique> (e2e/stub/fixtures/placement-back.ts): the write family, so that the
 * week has rows, with a grundschema that is as the case says. Each test names its own, since the suites run against one stub.
 */

const GENERATE = "/sv/admin/generate";
const WEEK = "/sv/admin/placements";
const MISSES = "the backend stub could not answer these reads; each says which file to add it to or fix";

const VIEWPORTS = [
  { name: "320×700", width: 320, height: 700 },
  { name: "375×812", width: 375, height: 812 },
  { name: "1280×800", width: 1280, height: 800 },
];
const SCHEMES = ["light", "dark"] as const;
const WIDE_FONT = "body, button, input, select { font-family: 'DejaVu Sans Mono', monospace !important }";

const scenarioOf = (name: "fresh" | "changed" | "noschema" | "refusal") => `${PLACEMENT_BACK_SCENARIO}-${name}:${randomUUID()}`;

type Persona = "admin" | "reader" | "expedition";

async function open(
  page: Page,
  baseURL: string,
  path: string,
  options: { scenario?: string; size?: { width: number; height: number }; scheme?: (typeof SCHEMES)[number]; persona?: Persona; heading: string },
) {
  const persona = options.persona ?? "admin";
  if (persona === "admin") await signIn(page.context(), "admin", baseURL);
  else await signInAs(page.context(), persona === "reader" ? READER : EXPEDITION, baseURL);
  await freezeClock(page);
  if (options.scenario) await askForScenario(page, options.scenario);
  const misses = watchStubMisses(page);
  await page.setViewportSize(options.size ?? { width: 1280, height: 900 });
  await page.goto(path);
  await settle(page);
  await setScheme(page, options.scheme ?? "light", true);
  await expect(page.getByRole("heading", { level: 1, name: options.heading })).toBeVisible();
  return misses;
}

const openGenerate = (page: Page, baseURL: string, options: Omit<Parameters<typeof open>[3], "heading">) => open(page, baseURL, GENERATE, { ...options, heading: "Generera schema" });
const openWeek = (page: Page, baseURL: string, options: Omit<Parameters<typeof open>[3], "heading"> & { search?: string }) =>
  open(page, baseURL, `${WEEK}${options.search ?? ""}`, { ...options, heading: "Förlägg i veckan" });

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
    // What reaches past the right edge of the window: named, so that a page that scrolls sideways says what does it.
    const beyond = [...document.querySelectorAll("body *")]
      .filter((element) => !element.closest(".sr-only") && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().right > window.innerWidth + 1)
      .slice(0, 6)
      .map((element) => `${element.tagName.toLowerCase()}.${String(element.className).slice(0, 50)} right=${Math.round(element.getBoundingClientRect().right)} "${(element.textContent ?? "").trim().slice(0, 30)}"`);
    // Of what A3 draws (the boxes asked about and everything in them): what reaches past the right edge. The page may scroll sideways for
    // another reason (the läsår choice in the header of a page with a successor year, at 320 px, is not A3's), which `beyond` names.
    const mine = boxes.flatMap((box) => [box, ...box.querySelectorAll("*")]).filter((element) => !element.closest(".sr-only") && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().right > window.innerWidth + 1);
    return { problems, boxes: boxes.length, pageScrollsSideways: document.documentElement.scrollWidth > window.innerWidth, beyond, mineBeyond: mine.length };
  }, selector);
}

/** Presses Generera, which the stub answers with the refused run the scenario holds, and waits for its card ("Senaste körning"). */
async function runGenera(page: Page) {
  await page.getByRole("button", { name: "Generera schema" }).click();
  await expect(page.locator("#last-run")).toBeVisible();
}

const REFUSAL_BOXES = "[data-testid='generate-placed'], #last-run li";
const LINK = /^Visa i veckan: /;
const markedCards = (page: Page) => page.locator("[data-lesson-id^='placement:']:focus");

for (const size of VIEWPORTS) {
  for (const scheme of SCHEMES) {
    test(`Generera at ${size.name}, ${scheme}: the row before a run and a refusal's links stay inside their boxes, long names and a wide font too`, async ({ page, baseURL }) => {
      const misses = await openGenerate(page, baseURL!, { scenario: scenarioOf("refusal"), size, scheme });
      await runGenera(page);
      await page.addStyleTag({ content: WIDE_FONT });
      await expect(page.getByTestId("generate-placed")).toContainText("2 lektioner ligger fast.");
      await expect(page.getByTestId("generate-placed-failing")).toContainText("1 förläggning håller inte längre, och Generera körs inte förrän de gör det.");
      // One link per line that has the ids (three of four) and one on the row before the run.
      await expect(page.getByRole("link", { name: LINK })).toHaveCount(3);
      const facts = await measure(page, REFUSAL_BOXES);
      expect(facts.boxes).toBeGreaterThan(3);
      expect(facts.problems, "text measured by its own rectangles").toEqual([]);
      expect(facts.mineBeyond, `what A3 draws reaches past the right edge (the page scrolls sideways: ${facts.pageScrollsSideways}; past the edge: ${facts.beyond.join(" | ")})`).toBe(0);
      expect(misses, MISSES).toEqual([]);
    });

    test(`the week at ${size.name}, ${scheme}: Ändrat sedan senaste schemat and the missing card are said inside their boxes`, async ({ page, baseURL }) => {
      const misses = await openWeek(page, baseURL!, {
        scenario: scenarioOf("changed"),
        size,
        scheme,
        // A card that is not there: Wednesday 09:00 of the first post, which no row has.
        search: "?post=00000000-0000-4050-8000-000000000001&day=3&start=09:00",
      });
      await page.addStyleTag({ content: WIDE_FONT });
      await expect(page.getByTestId("placement-since-run")).toContainText("Ändrat sedan senaste schemat. Generera om.");
      await expect(page.getByTestId("placement-link-missing")).toContainText("Förläggningen ligger inte längre där");
      const facts = await measure(page, "[data-testid='placement-since-run'], [data-testid='placement-link-missing'], [data-testid='placement-summary']");
      expect(facts.boxes).toBe(3);
      expect(facts.problems, "text measured by its own rectangles").toEqual([]);
      expect(facts.mineBeyond, `what A3 draws reaches past the right edge (the page scrolls sideways: ${facts.pageScrollsSideways}; past the edge: ${facts.beyond.join(" | ")})`).toBe(0);
      expect(misses, MISSES).toEqual([]);
    });
  }

  test(`the grundschema's empty state at ${size.name}: both actions stay inside the page`, async ({ page, baseURL }) => {
    const misses = await open(page, baseURL!, `/sv/admin/timetable?year=${NEXT_YEAR.id}`, { size, heading: "Grundschema" });
    await expect(page.getByRole("heading", { level: 2, name: "Inget grundschema för läsåret ännu" })).toBeVisible();
    // The page as it is: nothing scrolls sideways, and neither action leaves it.
    {
      const facts = await measure(page, "main [class*='mt-5']");
      expect(facts.mineBeyond, `what A3 draws reaches past the right edge (the page scrolls sideways: ${facts.pageScrollsSideways}; past the edge: ${facts.beyond.join(" | ")})`).toBe(0);
    }
    for (const name of ["Generera schema", "Lägg ut lektioner för hand"]) {
      const box = (await page.locator("main").getByRole("link", { name, exact: true }).boundingBox())!;
      expect(box.x, `${name} starts inside the page`).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, `${name} ends inside the page`).toBeLessThanOrEqual(size.width + 0.5);
    }
    // The wide font of the CI runner's kind: the two actions wrap inside their own box and every line of them is whole.
    await page.addStyleTag({ content: WIDE_FONT });
    const facts = await measure(page, "main [class*='mt-5']");
    expect(facts.boxes).toBeGreaterThan(0);
    expect(facts.problems, "text measured by its own rectangles").toEqual([]);
    for (const name of ["Generera schema", "Lägg ut lektioner för hand"]) {
      const box = (await page.locator("main").getByRole("link", { name, exact: true }).boundingBox())!;
      expect(box.x + box.width, `${name} ends inside the page in a wide font`).toBeLessThanOrEqual(size.width + 0.5);
    }
    expect(misses, MISSES).toEqual([]);
  });
}

test("a refusal on Generera leads, with one press, to the card it names: marked, the keyboard on it, and nothing opened", async ({ page, baseURL }) => {
  const misses = await openGenerate(page, baseURL!, { scenario: scenarioOf("refusal") });
  await runGenera(page);
  // The first line: Matematik 7A on Thursday 13:15, which the week holds.
  const link = page.getByRole("link", { name: LINK }).first();
  await expect(link).toHaveAttribute("href", /\/admin\/placements\?post=[^&]+&day=4&start=13%3A15$/);
  await link.click();
  await page.waitForURL(/\/admin\/placements\?/);
  await settle(page);
  await expect(markedCards(page)).toHaveCount(1);
  const card = markedCards(page).first();
  await expect(card).toContainText("Matematik");
  await expect(card).toContainText("Vald");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByTestId("placement-link-missing")).toHaveCount(0);
  expect(misses, MISSES).toEqual([]);
});

test("a lesson that has moved since the run is said not to be there, and nothing is marked", async ({ page, baseURL }) => {
  const misses = await openGenerate(page, baseURL!, { scenario: scenarioOf("refusal") });
  await runGenera(page);
  await page.getByRole("link", { name: LINK }).nth(1).click();
  await page.waitForURL(/\/admin\/placements\?/);
  await settle(page);
  await expect(page.getByTestId("placement-link-missing")).toContainText("Förläggningen ligger inte längre där: den är flyttad eller borttagen.");
  await expect(page.getByTestId("placement-link-missing")).toHaveAttribute("role", "status");
  await expect(markedCards(page)).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(misses, MISSES).toEqual([]);
});

test("a block's lesson links with the block in the address, and the week marks nothing and says nothing is missing for it", async ({ page, baseURL }) => {
  const misses = await openGenerate(page, baseURL!, { scenario: scenarioOf("refusal") });
  await runGenera(page);
  const link = page.getByRole("link", { name: LINK }).nth(2);
  await expect(link).toHaveAttribute("href", /&block=[^&]+$/);
  await link.click();
  await page.waitForURL(/\/admin\/placements\?/);
  await settle(page);
  await expect(page.getByTestId("placement-summary")).toBeVisible();
  await expect(page.getByTestId("placement-link-missing")).toHaveCount(0);
  await expect(markedCards(page)).toHaveCount(0);
  expect(misses, MISSES).toEqual([]);
});

test("a line stored before the ids has no link, and the sentence is all it is", async ({ page, baseURL }) => {
  const misses = await openGenerate(page, baseURL!, { scenario: scenarioOf("refusal") });
  await runGenera(page);
  const lines = page.locator("#last-run li");
  await expect(lines).toHaveCount(4);
  await expect(lines.nth(3).getByRole("link")).toHaveCount(0);
  await expect(lines.nth(3)).toContainText("Svenska för 7C");
  expect(misses, MISSES).toEqual([]);
});

test("the row before a run leads to the week of the läsår", async ({ page, baseURL }) => {
  const misses = await openGenerate(page, baseURL!, { scenario: scenarioOf("fresh") });
  const row = page.getByTestId("generate-placed");
  await expect(row).toContainText("2 lektioner ligger fast.");
  await row.getByRole("link", { name: "Visa i veckan" }).click();
  await page.waitForURL(/\/admin\/placements$/);
  await expect(page.getByRole("heading", { level: 1, name: "Förlägg i veckan" })).toBeVisible();
  expect(misses, MISSES).toEqual([]);
});

test("the grundschema's empty state leads to the week of the läsår it is shown for", async ({ page, baseURL }) => {
  const misses = await open(page, baseURL!, `/sv/admin/timetable?year=${NEXT_YEAR.id}`, { heading: "Grundschema" });
  const link = page.getByRole("link", { name: "Lägg ut lektioner för hand", exact: true });
  await expect(link).toHaveAttribute("href", `/sv/admin/placements?year=${NEXT_YEAR.id}`);
  await expect(link).toHaveAttribute("data-writes", "PLANERING");
  await link.click();
  await page.waitForURL(/\/admin\/placements\?year=/);
  await expect(page.getByRole("heading", { level: 1, name: "Förlägg i veckan" })).toBeVisible();
  expect(misses, MISSES).toEqual([]);
});

test.describe("Ändrat sedan senaste schemat", () => {
  test("is said, with a way to Generera, for a row laid after the run", async ({ page, baseURL }) => {
    const misses = await openWeek(page, baseURL!, { scenario: scenarioOf("changed") });
    const note = page.getByTestId("placement-since-run");
    await expect(note).toContainText("Ändrat sedan senaste schemat. Generera om.");
    const link = note.getByRole("link", { name: "Till Generera" });
    await expect(link).toHaveAttribute("href", "/sv/admin/generate");
    await expect(link).toHaveAttribute("data-writes", "SCHEMALAGGNING");
    // Above the summary, as the plan has it.
    const noteBox = (await note.boundingBox())!;
    const summaryBox = (await page.getByTestId("placement-summary").boundingBox())!;
    expect(noteBox.y).toBeLessThan(summaryBox.y);
    expect(misses, MISSES).toEqual([]);
  });

  test("is not said when the rows are what the grundschema was written from", async ({ page, baseURL }) => {
    const misses = await openWeek(page, baseURL!, { scenario: scenarioOf("fresh") });
    await expect(page.getByTestId("placement-summary")).toBeVisible();
    await expect(page.getByTestId("placement-since-run")).toHaveCount(0);
    expect(misses, MISSES).toEqual([]);
  });

  test("is not said before the first schema: no run and nothing written, and the week's own sentence stands", async ({ page, baseURL }) => {
    const misses = await openWeek(page, baseURL!, { scenario: scenarioOf("noschema") });
    await expect(page.getByTestId("placement-summary")).toBeVisible();
    await expect(page.getByTestId("placement-since-run")).toHaveCount(0);
    await expect(page.getByText(/En förläggning gäller från nästa Generera\./)).toBeVisible();
    expect(misses, MISSES).toEqual([]);
  });
});

test.describe("no automated accessibility violation, in either theme, at a phone's width", () => {
  // Generera is Schemaläggning's: the expedition is told it is another area's (and offered the way back), the läsare reads it.
  for (const persona of ["admin", "reader"] as const) {
    test(`Generera with a refusal and the row before the run, as the ${persona}`, async ({ page, baseURL }) => {
      const misses = await openGenerate(page, baseURL!, { scenario: scenarioOf("refusal"), size: { width: 375, height: 812 }, persona });
      await expect(page.getByTestId("generate-placed")).toBeVisible();
      if (persona === "admin") await runGenera(page);
      // The sticky header is scanned over whatever is behind it: from the top of the page, where the avatar's contrast is the header's own.
      await page.evaluate(() => window.scrollTo(0, 0));
      const reports = await scanBothSchemes(page, `generate-back-${persona}`, true);
      expect(reports, reports.join("\n")).toEqual([]);
      expect(misses, MISSES).toEqual([]);
    });
  }

  test("Generera is not the expedition's: it says so, and offers no way back to the week", async ({ page, baseURL }) => {
    await signInAs(page.context(), EXPEDITION, baseURL!);
    await freezeClock(page);
    await askForScenario(page, scenarioOf("refusal"));
    const misses = watchStubMisses(page);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(GENERATE);
    await settle(page);
    await expect(page.getByRole("heading", { level: 1, name: "Sidan hör till ett annat område" })).toBeVisible();
    await expect(page.getByRole("link", { name: /Visa i veckan/ })).toHaveCount(0);
    expect(misses, MISSES).toEqual([]);
  });

  for (const persona of ["admin", "reader", "expedition"] as const) {
    test(`the week with Ändrat sedan senaste schemat and a card that is not there, as the ${persona}`, async ({ page, baseURL }) => {
      const misses = await openWeek(page, baseURL!, {
        scenario: scenarioOf("changed"),
        size: { width: 375, height: 812 },
        persona,
        search: "?post=00000000-0000-4050-8000-000000000001&day=3&start=09:00",
      });
      await expect(page.getByTestId("placement-since-run")).toBeVisible();
      const reports = await scanBothSchemes(page, `placements-back-${persona}`, true);
      expect(reports, reports.join("\n")).toEqual([]);
      expect(misses, MISSES).toEqual([]);
    });
  }

  test("the grundschema's empty state with both actions", async ({ page, baseURL }) => {
    const misses = await open(page, baseURL!, `/sv/admin/timetable?year=${NEXT_YEAR.id}`, { size: { width: 375, height: 812 }, heading: "Grundschema" });
    const reports = await scanBothSchemes(page, "timetable-empty-back", true);
    expect(reports, reports.join("\n")).toEqual([]);
    expect(misses, MISSES).toEqual([]);
  });
});
