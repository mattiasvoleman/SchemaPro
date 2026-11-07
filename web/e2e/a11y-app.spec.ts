import { expect, test } from "@playwright/test";
import { gateOfPath } from "../lib/admin-areas";
import { APP_ROUTES, PAGES, STALE_QUERIES } from "./app-routes";
import { DESKTOP, PHONE, scanBothSchemes, setScheme, type Violation } from "./axe";
import { freezeClock, settle, signIn, signInAs, watchStubMisses } from "./signed-in";
import { SCHOOL_COOKIE } from "../lib/school-choice";
import { SCHOOL } from "./stub/fixtures/world";
import { HUVUDMAN_MEMBER, MULTI_GUARDIAN, READER, STUB_ORIGIN } from "./stub/sessions";

/**
 * Violations the suite lets through, each with the reason it is not fixed
 * here. Keep it short and keep every entry in the tillgänglighetsredogörelse
 * (app/[locale]/tillganglighet/statement.ts) too: an entry here is a known
 * shortcoming, not a waiver. `page` is the route as on disk; `target` a
 * substring of the failing node's selector.
 */
const ALLOWED: Array<{ rule: string; page: string; target: string; reason: string }> = [];

/** The violations left once the allowed nodes are taken out. */
function unexplained(violations: Violation[], page: string): Violation[] {
  return violations
    .map((violation) => ({
      ...violation,
      nodes: violation.nodes.filter(
        (node) =>
          !ALLOWED.some(
            (entry) =>
              entry.rule === violation.id && entry.page === page && node.target.join(" ").includes(entry.target),
          ),
      ),
    }))
    .filter((violation) => violation.nodes.length > 0);
}

test("every signed-in page is covered", () => {
  const uncovered = PAGES.flatMap((entry) => entry.lacks.map((line) => `${entry.page}: ${line}`));
  expect(uncovered, "pages axe never opens, or opens empty; each line says what to add, and in which file").toEqual([]);
  expect(STALE_QUERIES, "queries no page reads any more").toEqual([]);
});

for (const route of APP_ROUTES) {
  for (const persona of route.personas) {
    test(`${persona} ${route.page}`, async ({ page, context, baseURL }) => {
      // Two loads and four scans of a full page: about five seconds alone,
      // but a loaded runner has taken one past the default minute.
      test.slow();
      await signIn(context, persona, baseURL!);
      await freezeClock(page);
      const misses = watchStubMisses(page);

      await page.setViewportSize(DESKTOP);
      await setScheme(page, "light", false);
      await page.goto(`/sv${route.url}`);
      await settle(page);
      expect(page.url(), "the page sent this person somewhere else").toContain(route.url);
      // Soft, so one run names both what the stub lacks and what axe found.
      expect.soft(misses, "the backend stub could not answer these reads; each says which file to add it to or fix").toEqual([]);

      const keep = (violations: Violation[]) => unexplained(violations, route.page);
      const results = await scanBothSchemes(page, "desktop", true, keep);
      await page.setViewportSize(PHONE);
      await page.reload();
      await settle(page);
      results.push(...(await scanBothSchemes(page, "mobile", true, keep)));
      expect(results.join("\n"), "WCAG 2.1 AA violations").toBe("");
    });
  }
}

/*
 * Läsbehörighet: every admin page as the läsare, a profile that writes
 * nothing. A page of an area opens read-only, with the notice that names the
 * area above it; a decision page (dataskydd, with the läslogg) stays closed.
 * And no control a write would start is offered: a visible button, switch or
 * menu item whose name starts with one of the verbs below is a control
 * somebody forgot to mark (data-writes, components/admin/area-refusal.tsx
 * readOnlyStyle). The verbs are the admin pages' own, in Swedish; a reading
 * control that happens to start with one goes in READ_CONTROLS with why.
 * The row menus are opened, since "Fler åtgärder" folds items away. And
 * data-writes-inert takes only the pointer, so each inert control the
 * keyboard reaches is pressed: nothing but reads may reach the stub.
 */
const WRITE_VERBS =
  /^(lägg (till|upp|in)|ny|nytt|nya|skapa|spara|ta bort|radera|redigera|ändra|byt|importera|publicera|generera|tilldela|kopiera|rulla|lås|avboka|boka|bjud in|arkivera|godkänn|avslå|bevilja|koppla|ladda upp|tillämpa|ställ in|registrera|fördela|tillsätt|återkalla|synka|aktivera|avsluta|behåll|beräkna förslag|placera|parkera|dela|flytta|återställ|avbryt publicering|ersätt|gör)\b/i;

/** Reading controls whose names begin with a write verb: `page` as on disk, `name` the control's. */
const READ_CONTROLS: Array<{ page: string; name: RegExp; reason: string }> = [];

/** Reads the gateway takes as a POST: the activation plan /admin/years shows every administrator. */
const READ_POSTS = [/\/activation\/preview$/];

/*
 * Huvudman (20261212090000): every /admin page as the huvudman's reader too,
 * a kommunadministratör with no row at the school, the school chosen with
 * the switcher's cookie. The page is the läsare's: the same notices, no
 * control that starts a write, nothing but reads sent. Axe runs once, for
 * the school's läsare, whose markup the reader's is.
 */
const READ_ONLY_AS = [
  { label: "läsare", session: READER, school: null, axe: true },
  { label: "huvudmannens läsare", session: HUVUDMAN_MEMBER, school: SCHOOL.id, axe: false },
] as const;

for (const as of READ_ONLY_AS)
for (const route of APP_ROUTES.filter((entry) => entry.page.startsWith("/admin") && entry.personas.includes("admin"))) {
  test(`${as.label} ${route.page}`, async ({ page, context, baseURL }) => {
    test.slow();
    await signInAs(context, as.session, baseURL!);
    if (as.school) await context.addCookies([{ name: SCHOOL_COOKIE, value: as.school, url: baseURL! }]);
    await freezeClock(page);
    const misses = watchStubMisses(page);
    await page.setViewportSize(DESKTOP);
    await setScheme(page, "light", false);
    await page.goto(`/sv${route.url}`);
    await settle(page);
    expect.soft(misses, "the backend stub could not answer these reads").toEqual([]);

    const gate = gateOfPath(route.url.split("?")[0]!);
    // Every area's notice is in the page, hidden; the open page's alone shows.
    const notice = page.getByText("Du kan läsa men inte ändra", { exact: true }).filter({ visible: true });
    if (gate === "DECIDES") {
      await expect(page.getByRole("heading", { level: 1, name: "Sidan hör till ett annat område" })).toBeVisible();
      return;
    }
    if (gate === null && !route.page.startsWith("/admin/people")) {
      await expect(notice).toHaveCount(0);
    } else {
      await expect(notice).toBeVisible();
      await expect(notice).toHaveCount(1);
    }

    const offered = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("main button, main [role=button], main [role=switch], main [role=menuitem]")]
        .filter((element) => element.checkVisibility())
        .map((element) => (element.getAttribute("aria-label") ?? element.textContent ?? "").trim().replace(/\s+/g, " ")),
    );
    // What a row's menu folds away is offered as well (its items are in a portal, outside main).
    const menus = page.locator("main").getByRole("button", { name: /^Fler åtgärder/ }).filter({ visible: true });
    for (let index = 0; index < Math.min(await menus.count(), 3); index++) {
      await menus.nth(index).click();
      offered.push(
        ...(await page
          .getByRole("menuitem")
          .filter({ visible: true })
          .evaluateAll((items) =>
            items.map((item) => (item.getAttribute("aria-label") ?? item.textContent ?? "").trim().replace(/\s+/g, " ")),
          )),
      );
      await page.keyboard.press("Escape");
    }
    const writes = offered.filter(
      (name) => WRITE_VERBS.test(name) && !READ_CONTROLS.some((entry) => entry.page === route.page && entry.name.test(name)),
    );
    expect(writes, "controls a läsare is offered that start a write; mark them data-writes").toEqual([]);

    // The keyboard, which inert does not stop: Enter and Space on each inert
    // control it reaches, a dialog closed behind each. Only reads may follow.
    const sent: string[] = [];
    page.on("request", (request) => {
      const method = request.method();
      const path = new URL(request.url()).pathname;
      if (!request.url().startsWith(STUB_ORIGIN) || ["GET", "HEAD", "OPTIONS"].includes(method)) return;
      if (!READ_POSTS.some((read) => read.test(path))) sent.push(`${method} ${path}`);
    });
    const controls = "button, input, select, textarea, [role=switch], [role=combobox], [tabindex='0']";
    const inert = page
      .locator(`main [data-writes-inert] :is(${controls}), main :is(${controls})[data-writes-inert]`)
      .filter({ visible: true });
    for (let index = 0; index < Math.min(await inert.count(), 12); index++) {
      const control = inert.nth(index);
      if (await control.isDisabled()) continue;
      await control.focus();
      for (const key of ["Enter", "Space"]) {
        await page.keyboard.press(key);
        await page.keyboard.press("Escape");
      }
    }
    await settle(page);
    expect(sent, "what a läsare's keyboard sent beyond reads").toEqual([]);

    // The notice in both schemes, at desktop width.
    if (as.axe) {
      expect((await scanBothSchemes(page, "desktop", true, (violations) => unexplained(violations, route.page))).join("\n")).toBe("");
    } else {
      // The huvudman's reader, named so in the switcher.
      await expect(page.locator('meta[name="rastra-school"]')).toHaveAttribute("content", as.school!);
    }
  });
}

/*
 * Flera skolor per inloggning: a guardian with children at two schools. The
 * sidebar's school name is the switcher, a <details> with a form; /guardian
 * names the children at the other school with a button that switches there.
 * Axe runs with the switcher open, and the switch itself is a full page load
 * that leaves the browser's choice in its cookie.
 */
test("a guardian at two schools: the switcher and the other school's children", async ({ page, context, baseURL }) => {
  test.slow();
  await signInAs(context, MULTI_GUARDIAN, baseURL!);
  await freezeClock(page);
  const misses = watchStubMisses(page);
  await page.setViewportSize(DESKTOP);
  await setScheme(page, "light", false);
  await page.goto("/sv/guardian");
  await settle(page);
  expect.soft(misses, "the backend stub could not answer these reads").toEqual([]);

  const card = page.getByRole("region", { name: "Barn på andra skolor" });
  await expect(card.getByText("Olle Granlund")).toBeVisible();
  await expect(card.getByRole("button", { name: "Byt till Granskolan" })).toBeVisible();
  // The page names its school to the browser's clients.
  await expect(page.locator('meta[name="rastra-school"]')).toHaveAttribute("content", /^[0-9a-f-]{36}$/);

  const sidebar = page.locator("aside").first();
  await sidebar.locator("summary").click();
  await expect(sidebar.getByRole("button", { name: /Granskolan/ })).toBeEnabled();
  await expect(sidebar.getByRole("button", { name: /Exempelskolan/ })).toBeDisabled();
  const results = await scanBothSchemes(page, "desktop", true, (violations) => unexplained(violations, "/guardian"));
  expect(results.join("\n"), "WCAG 2.1 AA violations").toBe("");

  await sidebar.getByRole("button", { name: /Granskolan/ }).click();
  await page.waitForURL(/\/sv\/guardian$/);
  const cookie = (await context.cookies()).find((one) => one.name === "rastra_school");
  expect(cookie?.value, "the switch is remembered in the browser").toMatch(/^[0-9a-f-]{36}$/);
});

/*
 * Huvudman (20261212090000): a kommunadministratör with no row at any school
 * starts on the huvudman's own pages, and opens the school the huvudman owns
 * as its läsare: the admin pages read-only, every write control hidden, as a
 * läsare's (READER above).
 */
test("a huvudman's kommunadministratör: the huvudman's pages, and the school read as its läsare", async ({ page, context, baseURL }) => {
  test.slow();
  await signInAs(context, HUVUDMAN_MEMBER, baseURL!);
  await freezeClock(page);
  const misses = watchStubMisses(page);
  await page.setViewportSize(DESKTOP);
  await setScheme(page, "light", false);

  // No school chosen: the start page sends her to the huvudman's.
  await page.goto("/sv");
  await page.waitForURL(/\/sv\/huvudman$/);
  await settle(page);
  await expect(page.getByRole("heading", { level: 1, name: "Exempelkommun" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Öppna Exempelskolan" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Dra tillbaka förfrågan till Granskolan" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "SS12000-nycklar" })).toBeVisible();
  let results = await scanBothSchemes(page, "desktop", true, (violations) => unexplained(violations, "/huvudman"));
  expect(results.join("\n"), "WCAG 2.1 AA violations").toBe("");

  // Letting a school go is asked about first, through the act route, with
  // the question where the browser lands; nothing is sent until "Ja".
  await page.getByRole("button", { name: "Släpp Exempelskolan" }).click();
  await page.waitForURL(/\/sv\/huvudman\?.*confirm=release/);
  await settle(page);
  const question = page.getByRole("region", { name: "Är du säker?" });
  await expect(question).toBeVisible();
  await expect(question.getByRole("button", { name: "Ja, gör det" })).toBeVisible();
  results = await scanBothSchemes(page, "desktop", true, (violations) => unexplained(violations, "/huvudman"));
  expect(results.join("\n"), "WCAG 2.1 AA violations").toBe("");
  await question.getByRole("link", { name: "Avbryt" }).click();
  await page.waitForURL(/\/sv\/huvudman\?h=/);

  await page.getByRole("button", { name: "Öppna Exempelskolan" }).click();
  await page.waitForURL(/\/sv\/admin$/);
  await settle(page);
  expect.soft(misses, "the backend stub could not answer these reads").toEqual([]);
  // The school's own, read-only: the page names the school, and no write is offered.
  await expect(page.locator('meta[name="rastra-school"]')).toHaveAttribute("content", /^[0-9a-f-]{36}$/);
  // The läsare's profile: the page's style hides every area's write controls
  // and the decider's (lib/admin-areas.ts, as for a school's own läsare).
  const hidden = await page.locator("style").evaluateAll((styles) => styles.map((style) => style.textContent ?? "").join("\n"));
  for (const gate of ["PERSONAL", "PLANERING", "DECIDES"]) expect(hidden).toContain(`[data-writes~="${gate}"]`);
  results = await scanBothSchemes(page, "desktop", true, (violations) => unexplained(violations, "/admin"));
  expect(results.join("\n"), "WCAG 2.1 AA violations").toBe("");
});
