import { expect, test, type Page } from "@playwright/test";
import { DESKTOP, PHONE, scanBothSchemes } from "./axe";
import { askForScenario, freezeClock, settle, signIn, watchStubMisses } from "./signed-in";
import { BATCH, SCENARIOS, type CandidatesScenario } from "./stub/fixtures/candidates";

/**
 * Schemaförslag (design §6) in each state an administrator meets it in, each
 * checked by axe: a11y-app.spec.ts opens /admin/generate and its compare page
 * once, with yesterday's batch of three, and these open the states the stub
 * holds only when asked by name (e2e/stub/fixtures/candidates.ts SCENARIOS) —
 * a run still working, a batch the draft has moved away from, a run whose
 * first candidate found no timetable or ran out of time, and the apply
 * dialog of a school that publishes directly. Each first checks that the state is the one on screen,
 * so a page that fell back to its error or empty state cannot pass axe for it.
 */

const COMPARE = "/sv/admin/generate/candidates";
const GENERATE = "/sv/admin/generate";
const MISSES = "the backend stub could not answer these reads; each says which file to add it to or fix";

/** Opens a page as the administrator, in a state if one is named; the misses keep collecting. */
async function open(page: Page, url: string, baseURL: string, scenario?: CandidatesScenario) {
  await signIn(page.context(), "admin", baseURL);
  await freezeClock(page);
  if (scenario) await askForScenario(page, scenario);
  const misses = watchStubMisses(page);
  await page.setViewportSize(DESKTOP);
  await page.goto(url);
  await settle(page);
  expect.soft(misses, MISSES).toEqual([]);
  return misses;
}

/** Both schemes on the desktop, then both on a phone after a reload: what a11y-app.spec.ts does to every page. */
async function scanPage(page: Page, label: string) {
  const results = await scanBothSchemes(page, `${label} desktop`, true);
  await page.setViewportSize(PHONE);
  await page.reload();
  await settle(page);
  results.push(...(await scanBothSchemes(page, `${label} mobile`, true)));
  expect(results.join("\n"), "WCAG 2.1 AA violations").toBe("");
}

const comparison = (page: Page) => page.getByRole("table", { name: /^Förslagen jämförda med grundschemat/ });
const applyButtons = (page: Page) => page.getByRole("button", { name: /^Tillämpa förslag \d/ });

test.describe("Schemaförslag", () => {
  // Two loads and four scans each, and a page that works out håltimmar for
  // four weeks: a loaded runner has taken the like of it past a minute.
  test.slow();

  test("the batch of three is compared with the draft, its håltimmar measured, and every candidate can be applied", async ({
    page,
    baseURL,
  }) => {
    const misses = await open(page, COMPARE, baseURL!);
    const table = comparison(page);
    await expect(table.getByRole("columnheader", { name: "Nuvarande utkast" })).toBeVisible();
    for (const candidate of BATCH.candidates) {
      const metrics = candidate.metrics!;
      await expect(table.getByRole("columnheader", { name: new RegExp(`^Förslag ${candidate.ordinal}`) })).toBeVisible();
      await expect(table.getByRole("cell", { name: `${metrics.moved} av ${metrics.movedOf}`, exact: true })).toHaveCount(1);
    }
    // The browser's own figures arrived: no cell is still computing.
    await expect(table.getByText("Räknar…")).toHaveCount(0);
    await expect(table.getByRole("rowheader", { name: /^Lärarnas håltimmar/ })).toBeVisible();
    // Bo's wished Wednesday, broken by the draft and by every candidate, named in each column.
    await expect(table.getByRole("rowheader", { name: /^Önskad ledig dag som inte hålls/ })).toBeVisible();
    await expect(table.getByText("Bo Ek · onsdagar", { exact: true })).toHaveCount(4);
    await expect(applyButtons(page)).toHaveCount(3);
    for (const button of await applyButtons(page).all()) await expect(button).toBeEnabled();
    // The review: the moved list and the week of the first class.
    await expect(page.getByRole("heading", { name: "Flyttade lektioner", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: /^Veckan i Förslag 1: Behåll mest/ })).toBeVisible();
    expect(misses, MISSES).toEqual([]);
    await scanPage(page, "batch of three");
  });

  test("a run still working shows its progress, and holds the older batch's apply until it is done", async ({ page, baseURL }) => {
    await open(page, COMPARE, baseURL!, SCENARIOS.running);
    await expect(page.getByText("1 av 3 klara", { exact: true })).toBeVisible();
    await expect(page.getByRole("progressbar", { name: "Förslag klara" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Avbryt", exact: true })).toBeEnabled();
    // Yesterday's batch is still on the page, and says why it cannot be applied now.
    await expect(applyButtons(page)).toHaveCount(3);
    for (const button of await applyButtons(page).all()) {
      await expect(button).toBeDisabled();
      await expect(button).toHaveAccessibleDescription(/^Förslag tas fram för läsåret just nu\./);
    }
    await scanPage(page, "run working, compare page");
  });

  test("on Generera schema, a run still working says so in its section and beside the Generera button", async ({ page, baseURL }) => {
    await open(page, GENERATE, baseURL!, SCENARIOS.running);
    await expect(page.getByText("Tar fram förslag: 1 av 3 klara.")).toBeVisible();
    const generate = page.getByRole("button", { name: "Generera schema" });
    await expect(generate).toBeDisabled();
    await expect(generate).toHaveAccessibleDescription(/^Schemaförslag tas fram för läsåret just nu\./);
    await expect(page.getByRole("button", { name: "Ta fram förslag", exact: true })).toBeDisabled();
    await scanPage(page, "run working, generate page");
  });

  test("a batch the draft has moved away from names what changed and offers to refresh it, and cannot be applied", async ({
    page,
    baseURL,
  }) => {
    await open(page, COMPARE, baseURL!, SCENARIOS.stale);
    await expect(page.getByText("Grundschemat har ändrats sedan förslagen togs fram", { exact: true })).toBeVisible();
    await expect(page.getByText(/^Ändrat sedan dess: utkastets lektioner och salarna\./)).toBeVisible();
    await expect(page.getByRole("button", { name: "Uppdatera förslagen" })).toBeEnabled();
    for (const button of await applyButtons(page).all()) await expect(button).toBeDisabled();
    await scanPage(page, "stale batch");
  });

  test("a run whose first candidate found no timetable says why, with what stopped it, and where to start again", async ({
    page,
    baseURL,
  }) => {
    await open(page, COMPARE, baseURL!, SCENARIOS.failed);
    await expect(page.getByText(/^Det första förslaget fick inget schema/)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Det som stoppade det första förslaget" })).toBeVisible();
    // The engine's summary of the week, as Generera's page shows a job's, above the causes.
    await expect(page.getByText(/^Inget schema uppfyller alla regler\. Börja med orsakerna nedan/)).toBeVisible();
    await expect(page.getByText("Lektionerna i 6 timplansposter behöver 1560 minuter i veckan, och veckan rymmer 1500.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Ta fram förslag igen från Generera schema" })).toBeVisible();
    // No batch to compare: no table, nothing to apply.
    await expect(comparison(page)).toHaveCount(0);
    await scanPage(page, "first candidate failed");
  });

  test("a run whose first candidate ran out of time says so, and what the engine's probe found, not a list of nothing", async ({
    page,
    baseURL,
  }) => {
    await open(page, COMPARE, baseURL!, SCENARIOS.timedOut);
    await expect(page.getByText("Det första förslaget hann inte bli klart inom tiden, så de andra togs inte fram.")).toBeVisible();
    await expect(page.getByText(/^Det första förslaget fick inget schema/)).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Det som stoppade det första förslaget" })).toBeVisible();
    await expect(page.getByText(/^Inget schema hittades inom 60 s/)).toBeVisible();
    await expect(comparison(page)).toHaveCount(0);
    await scanPage(page, "first candidate timed out");
  });

  test("in a school that publishes directly, the apply dialog says what leaves the calendar, and passes axe open", async ({
    page,
    baseURL,
  }) => {
    const misses = await open(page, COMPARE, baseURL!, SCENARIOS.direct);
    await expect(comparison(page).getByRole("columnheader", { name: "Nuvarande schema" })).toBeVisible();
    await page.getByRole("button", { name: "Tillämpa förslag 2: Färre håltimmar för lärarna" }).click();
    const dialog = page.getByRole("dialog", { name: "Tillämpa förslag 2: Färre håltimmar för lärarna i direktläge?" });
    await expect(dialog).toBeVisible();
    // This week's calendar in the stub: Thursday's mentorstid and 9A's maths, and Anna covering the maths.
    await expect(dialog.getByText("2 kommande lektioner tas bort ur kalendern")).toBeVisible();
    await expect(dialog.getByText("1 vikarietilldelning på dem försvinner")).toBeVisible();
    await expect(dialog.getByRole("link", { name: "Byt till utkastläge först" })).toHaveAttribute("href", "/sv/admin/publishing");
    await expect(dialog.getByRole("button", { name: "Tillämpa direkt" })).toBeEnabled();
    expect(misses, MISSES).toEqual([]);
    expect((await scanBothSchemes(page, "direct apply dialog open", true)).join("\n"), "WCAG 2.1 AA violations").toBe("");
    await expect(dialog).toBeVisible();
  });
});
