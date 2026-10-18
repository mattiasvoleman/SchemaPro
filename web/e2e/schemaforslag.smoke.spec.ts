import { expect, test, type Page } from "@playwright/test";
import { askForScenario, freezeClock, settle, signIn, watchStubMisses } from "./signed-in";
import { BATCH, SCENARIOS, type CandidatesScenario } from "./stub/fixtures/candidates";
import { YEAR } from "./stub/fixtures/world";

/**
 * Schemaförslag's writes, as the browser sends them (design §3 and §6): the
 * start with the count chosen and Generera's profile, the refresh of a batch
 * the draft has left, the apply naming the mode its dialog was opened in,
 * and the discard. The stub keeps nothing it is sent
 * (e2e/stub/fixtures/gateway-candidates.ts), so each test reads the request
 * the page made and the sentence it said about the answer — the toast that
 * names the safety version an administrator will look for under Versioner.
 */

const COMPARE = "/sv/admin/generate/candidates";
const GENERATE = "/sv/admin/generate";
const MISSES = "the backend stub could not answer these reads; each says which file to add it to or fix";

async function open(page: Page, url: string, baseURL: string, scenario?: CandidatesScenario) {
  await signIn(page.context(), "admin", baseURL);
  await freezeClock(page);
  if (scenario) await askForScenario(page, scenario);
  const misses = watchStubMisses(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(url);
  await settle(page);
  return misses;
}

/** The next request the page sends to a gateway path, by method; its JSON body once it has gone. */
const nextRequest = (page: Page, method: string, path: RegExp) =>
  page.waitForRequest((request) => request.method() === method && path.test(new URL(request.url()).pathname));

const [, second] = BATCH.candidates;

test.describe("Schemaförslag's writes", () => {
  test.slow();

  test("Ta fram förslag starts a run with the count chosen and the page's profile", async ({ page, baseURL }) => {
    const misses = await open(page, GENERATE, baseURL!);
    const section = page.locator("#candidates");
    await section.getByLabel("Antal förslag").selectOption("2");
    const start = nextRequest(page, "POST", /^\/api\/v1\/optimization\/candidates$/);
    await section.getByRole("button", { name: "Ta fram förslag", exact: true }).click();
    expect((await start).postDataJSON()).toEqual({
      academicYearId: YEAR.id,
      count: 2,
      weights: { preferredFree: 10, preferredBusy: 5, disruption: 8, spread: 3, teacherGap: 2 },
    });
    await expect(page.getByText("Förslagen tas fram. Du kan lämna sidan under tiden.")).toBeVisible();
    expect(misses, MISSES).toEqual([]);
  });

  test("applying in utkastläge names the mode the check reported, and the toast names the safety version", async ({ page, baseURL }) => {
    const misses = await open(page, COMPARE, baseURL!);
    await page.getByRole("button", { name: "Tillämpa förslag 2: Färre håltimmar för lärarna" }).click();
    const dialog = page.getByRole("dialog", { name: "Tillämpa förslag 2: Färre håltimmar för lärarna?" });
    await expect(dialog.getByText(/^Utkastets genererade lektioner ersätts med förslagets/)).toBeVisible();
    const apply = nextRequest(page, "POST", new RegExp(`/candidates/${second!.id}/apply$`));
    await dialog.getByRole("button", { name: "Tillämpa", exact: true }).click();
    expect((await apply).postDataJSON()).toEqual({ expectedMode: "DRAFT" });
    await expect(dialog).toBeHidden();
    await expect(page.getByText(`Förslag 2 är tillämpat: ${second!.lessonCount} lektioner i grundschemat`)).toBeVisible();
    await expect(page.getByText("En version sparades först: ”Före schemaförslag 2 – Färre håltimmar för lärarna”.", { exact: false })).toBeVisible();
    await expect(page.getByRole("link", { name: "Till Publicering" })).toHaveCount(0);
    expect(misses, MISSES).toEqual([]);
  });

  test("applying directly sends DIRECT, and the toast links to Publicering as well as to the schedule", async ({ page, baseURL }) => {
    const misses = await open(page, COMPARE, baseURL!, SCENARIOS.direct);
    await page.getByRole("button", { name: "Tillämpa förslag 2: Färre håltimmar för lärarna" }).click();
    const dialog = page.getByRole("dialog", { name: /i direktläge\?$/ });
    const apply = nextRequest(page, "POST", new RegExp(`/candidates/${second!.id}/apply$`));
    await dialog.getByRole("button", { name: "Tillämpa direkt" }).click();
    expect((await apply).postDataJSON()).toEqual({ expectedMode: "DIRECT" });
    await expect(page.getByText(/^Förslag 2 är tillämpat/)).toBeVisible();
    await expect(page.getByRole("link", { name: "Till Publicering" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Öppna schemat" }).first()).toBeVisible();
    expect(misses, MISSES).toEqual([]);
  });

  test("a batch the draft has left is refreshed from itself", async ({ page, baseURL }) => {
    const misses = await open(page, COMPARE, baseURL!, SCENARIOS.stale);
    const refresh = nextRequest(page, "POST", /^\/api\/v1\/optimization\/candidates$/);
    await page.getByRole("button", { name: "Uppdatera förslagen" }).click();
    expect((await refresh).postDataJSON()).toEqual({ academicYearId: YEAR.id, refreshOf: BATCH.run.id });
    await expect(page.getByText("Förslagen räknas om utifrån dagens grundschema.")).toBeVisible();
    expect(misses, MISSES).toEqual([]);
  });

  test("Ta bort förslagen asks first, then removes the year's proposals", async ({ page, baseURL }) => {
    const misses = await open(page, COMPARE, baseURL!);
    await page.getByRole("button", { name: "Ta bort förslagen" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Ta bort förslagen?" }).or(page.getByRole("dialog", { name: "Ta bort förslagen?" }));
    const discard = nextRequest(page, "DELETE", /^\/api\/v1\/optimization\/candidates$/);
    await dialog.getByRole("button", { name: "Ta bort", exact: true }).click();
    expect(new URL((await discard).url()).searchParams.get("academicYearId")).toBe(YEAR.id);
    await expect(page.getByText("Förslagen är borttagna.")).toBeVisible();
    expect(misses, MISSES).toEqual([]);
  });
});
