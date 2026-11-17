import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { askForScenario, freezeClock, settle, signIn, watchStubMisses } from "./signed-in";
import { PLACEMENT_WRITE_SCENARIO } from "./stub/fixtures/timplan-board";
import { TEACHERS } from "./stub/fixtures/world";
import { KIND, STUB_ORIGIN, uid } from "./stub/sessions";

/**
 * Förlägg i veckan, the moment before the drag tools are here (lib/placement-drag-tools.ts is fetched when the page is up, not with it), and
 * a fetch that never succeeds. The jsdom tests (page.test.tsx) hold the module back with a promise; here it is the real chunk, held and
 * failed on the wire, which is the only place the page's first paint, the chunk and the board's answer meet.
 *
 * Until the tools are here the page has no mirror of the clash rule. A writer's controls then wait: no fields that would say "Ledigt."
 * for a time the teacher already holds and offer no room, no press, drop or arrow key that sends a lesson laid as a pin.
 */

const PAGE = "/sv/admin/placements";
const SVENSKA = uid(KIND.requirement, 1);
const ANNA = TEACHERS.anna.id;
const BRICK = `[data-brick='${SVENSKA}|${ANNA}|60#1']`;
const CARD = `[data-lesson-id^='placement:${SVENSKA}|'][data-lesson-id$='|60|2|10:00|ALL_WEEKS']`;

async function open(page: Page, baseURL: string, mode: "hold" | "fail") {
  await signIn(page.context(), "admin", baseURL);
  await freezeClock(page);
  await askForScenario(page, `${PLACEMENT_WRITE_SCENARIO}:${randomUUID()}`);
  const misses = watchStubMisses(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  // The one chunk whose exports name `dragOf` is the drag tools. Every other chunk goes through as it is.
  await page.route("**/_next/static/chunks/**", async (route) => {
    const response = await route.fetch();
    const body = await response.body();
    if (!route.request().url().endsWith(".js") || !body.toString("utf8").includes('"dragOf"')) return route.fulfill({ response, body });
    if (mode === "fail") return route.abort("failed");
    await gate;
    return route.fulfill({ response, body });
  });
  const puts: Array<{ placements: Array<Record<string, unknown>> }> = [];
  page.on("request", (request) => {
    if (request.method() === "PUT" && request.url().startsWith(STUB_ORIGIN) && request.url().endsWith("/placements")) puts.push(JSON.parse(request.postData() ?? "{}"));
  });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 1600 });
  await page.goto(PAGE);
  // A held chunk is a request that does not finish: the page is never "idle", so wait for what is asked instead.
  if (mode === "hold") await page.waitForLoadState("domcontentloaded");
  else await settle(page);
  await expect(page.getByRole("heading", { level: 1, name: "Förlägg i veckan" })).toBeVisible();
  await expect(page.locator(BRICK)).toBeVisible();
  return { misses, puts, release, pageErrors };
}

const columns = (page: Page) => page.locator("[data-writes-inert='SCHEMALAGGNING DRIFT']");

test.describe("the drag tools are on their way", () => {
  test("a chosen brick has no fields, a press on the week and an arrow key lay and move nothing, and say why; when the tools come the fields do, with the room offered", async ({ page, baseURL }) => {
    const { puts, release, misses } = await open(page, baseURL!, "hold");
    await page.locator(BRICK).click();
    await expect(page.locator(BRICK)).toHaveAttribute("aria-pressed", "true");
    // No fields that say "Ledigt." for a time that is taken, and no press that lays the lesson with no room.
    await expect(page.getByTestId("lay-row")).toHaveCount(0);
    const column = columns(page).nth(2);
    await column.scrollIntoViewIfNeeded();
    await column.click({ position: { x: 20, y: (13 * 60 - 480) * 1.1 + 4 } });
    await expect(page.getByTestId("placement-message")).toContainText("Sidan hämtar fortfarande sina verktyg");
    await page.locator(CARD).focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByTestId("placement-message")).toContainText("Sidan hämtar fortfarande sina verktyg");
    await page.waitForTimeout(500);
    expect(puts, "nothing is written before the tools are here").toHaveLength(0);

    release();
    const row = page.getByTestId("lay-row");
    await expect(row).toBeVisible();
    // The room the post's other lesson stands in, and the sentence for a time the teacher holds.
    await expect(row.getByLabel("Sal")).not.toHaveValue("");
    await row.getByLabel("Dag").selectOption("2");
    await row.getByLabel("Starttid").fill("10:15");
    await expect(row.getByTestId("place-verdict")).toContainText("Läraren har redan");
    expect(misses).toEqual([]);
  });

  test("a chunk that never comes is said in words, once, with the controls off and no error left on the page", async ({ page, baseURL }) => {
    const { puts, pageErrors } = await open(page, baseURL!, "fail");
    await expect(page.getByTestId("placement-message")).toContainText("Sidans verktyg kunde inte hämtas");
    await page.locator(BRICK).click();
    await expect(page.getByTestId("lay-row")).toHaveCount(0);
    expect(pageErrors, "the failed import is the page's own to say, not an uncaught error").toEqual([]);
    expect(puts).toHaveLength(0);
  });
});
