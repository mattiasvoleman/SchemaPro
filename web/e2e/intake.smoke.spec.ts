import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { scanBothSchemes, setScheme } from "./axe";
import { askForScenario, freezeClock, settle, signIn, watchStubMisses } from "./signed-in";

/**
 * Vad kom in, in a browser. The page's own states are jsdom's (page.test.tsx) and the counts are the gateway's (src/intake,
 * scripts/test/probe-intake.ts). What only a browser can say is asked here, for the three schools the stub answers as:
 *
 *   the stub's own school (nothing stops Generera, a few lesser gaps), an empty school (every gap that stops Generera), and the
 *   gateway's real answer for the seeded demo school (gateway-intake.ts);
 *
 * and each of them:
 *   - says in words what it found: the summary, the level of each gap, the page that owns it, a link that goes there;
 *   - passes axe in both themes, at a desktop and at a phone's width, and does not scroll sideways at 320 px with a wide font;
 *   - sent the stub nothing but reads (the page writes nothing).
 *
 * INTAKE_SHOTS_DIR, when set, is where the page is saved as a screenshot for each scenario and width; a person looking at the
 * page, not a baseline: nothing compares them.
 */

const PAGE = "/sv/admin/intake";
const MISSES = "the backend stub could not answer these reads; each says which file to add it to or fix";
const WIDE_FONT = "body, button, input, select, textarea { font-family: 'DejaVu Sans Mono', monospace !important }";
const SHOTS = process.env["INTAKE_SHOTS_DIR"];

const SCHOOLS = [
  { scenario: null, name: "the stub's own school", summary: "Inget som sidan räknar stoppar Generera" },
  { scenario: "intake-empty", name: "an empty school", summary: "4 saker stoppar Generera" },
  { scenario: "intake-demo", name: "the seeded demo school", summary: "Inget som sidan räknar stoppar Generera" },
] as const;

for (const school of SCHOOLS) {
  test.describe(school.name, () => {
    async function open(page: import("@playwright/test").Page, baseURL: string, width = 1280, height = 900) {
      await signIn(page.context(), "admin", baseURL);
      await freezeClock(page);
      if (school.scenario !== null) await askForScenario(page, school.scenario);
      await page.setViewportSize({ width, height });
      const misses = watchStubMisses(page);
      const writes: string[] = [];
      page.on("request", (request) => {
        if (request.method() !== "GET" && /\/api\/v1\//.test(request.url())) writes.push(`${request.method()} ${request.url()}`);
      });
      await page.goto(PAGE);
      await settle(page);
      return { misses, writes };
    }

    test("says what it found in words, and writes nothing", async ({ page, baseURL }) => {
      const { misses, writes } = await open(page, baseURL!);
      await expect(page.getByRole("heading", { level: 1, name: "Vad kom in" })).toBeVisible();
      await expect(page.getByText(school.summary, { exact: false }).first()).toBeVisible();
      // Eleven areas, each a named region with the count of what it found.
      await expect(page.locator("main section")).toHaveCount(11);
      await expect(page.getByRole("region", { name: "Salar" })).toContainText("Det som kom in:");
      // Never "klart": the page does not say that a week can be laid.
      await expect(page.locator("main")).not.toContainText(/klart att generera|redo att generera|schemat går att lägga/i);
      expect(writes, "the page wrote something").toEqual([]);
      expect(misses, MISSES).toEqual([]);
      if (SHOTS) {
        mkdirSync(SHOTS, { recursive: true });
        await page.screenshot({ path: join(SHOTS, `${school.scenario ?? "standard"}-1280.png`), fullPage: true });
      }
    });

    test("passes axe in both themes at a desktop's width and a phone's", async ({ page, baseURL }) => {
      test.slow();
      const { misses } = await open(page, baseURL!);
      await setScheme(page, "light", false);
      const results = await scanBothSchemes(page, "desktop", true);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.reload();
      await settle(page);
      results.push(...(await scanBothSchemes(page, "mobile", true)));
      expect(results.join("\n"), "WCAG 2.1 AA violations").toBe("");
      expect(misses, MISSES).toEqual([]);
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `${school.scenario ?? "standard"}-390.png`), fullPage: true });
    });

    test("does not scroll sideways at 320 px with a wide font", async ({ page, baseURL }) => {
      await open(page, baseURL!, 320, 700);
      await page.addStyleTag({ content: WIDE_FONT });
      const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(sideways, "pixels the page is wider than the window").toBeLessThanOrEqual(0);
    });
  });
}

test("a gap's link goes to the page that owns it, by the menu's own word", async ({ page, baseURL }) => {
  await signIn(page.context(), "admin", baseURL!);
  await freezeClock(page);
  await askForScenario(page, "intake-empty");
  await page.goto(PAGE);
  await settle(page);
  const rooms = page.getByRole("region", { name: "Salar" });
  await expect(rooms).toContainText("Stoppar Generera");
  await expect(rooms).toContainText("Inga salar är inlagda");
  await rooms.getByRole("link", { name: "Öppna Salar" }).click();
  await expect(page).toHaveURL(/\/sv\/admin\/rooms$/);
});

test("a read that fails says so and shows no figure", async ({ page, baseURL, context }) => {
  await signIn(context, "admin", baseURL!);
  await freezeClock(page);
  await page.route("**/api/v1/intake", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "BOOM" }) }));
  await page.goto(PAGE);
  await expect(page.getByText("Det som kom in kunde inte hämtas")).toBeVisible();
  await expect(page.getByText("Inget saknas.")).toHaveCount(0);
  await expect(page.locator("main section")).toHaveCount(0);
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, "read-failed-1280.png"), fullPage: true });
  }
});
