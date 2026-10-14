import { expect, test, type Page } from "@playwright/test";
import { DESKTOP, PHONE, scanBothSchemes, setScheme } from "./axe";
import { signInAs } from "./signed-in";
import { SHARE_TOKEN } from "./stub/fixtures/gateway-public";
import { GROUPS } from "./stub/fixtures/world";
import { ORPHAN } from "./stub/sessions";

/**
 * WCAG 2.1 AA gate (§2: "100% compliance at AA level"), for the pages a
 * visitor sees without a school's session. Everything under (app) is in
 * a11y-app.spec.ts, signed in as each role.
 *
 * Every page is scanned the way the tillgänglighetsredogörelse says: at
 * desktop and phone width, in the light and the dark theme. Schemavisaren has
 * one look of its own (no theme), so its two scans see the same page.
 * Schemavisaren reads its week from the backend stub
 * (e2e/stub/fixtures/gateway-public.ts).
 */
const ROUTES = [
  { path: "/sv/login", name: "login (sv)" },
  { path: "/en/login", name: "login (en)" },
  { path: "/sv/forgot-password", name: "forgot password (sv)" },
  { path: "/en/forgot-password", name: "forgot password (en)" },
  { path: "/sv/update-password", name: "update password (sv)" },
  // A school-account sign-in that came back refused (/auth/callback): the
  // reason sits above the form.
  { path: "/sv/login?sso=no-account", name: "login with a school-account refusal (sv)" },
  { path: "/en/login?sso=other-organisation", name: "login with a school-account refusal (en)" },
  { path: "/sv/tillganglighet", name: "tillgänglighetsredogörelse (sv)" },
  { path: "/en/tillganglighet", name: "tillgänglighetsredogörelse (en)" },
  { path: `/v/${SHARE_TOKEN}`, name: "Schemavisaren, the list of classes", themed: false },
  { path: `/v/${SHARE_TOKEN}?target=${GROUPS.g7A.id}`, name: "Schemavisaren, a class's week", themed: false },
  { path: `/v/${SHARE_TOKEN}?target=${GROUPS.g7A.id}&lang=en`, name: "Schemavisaren, a class's week (en)", themed: false },
  { path: `/v/${"x".repeat(43)}`, name: "Schemavisaren, a link that does not resolve", themed: false },
];

/** Both widths, both schemes; a reload at phone width, so the page lays itself out there. */
async function scanEveryWay(page: Page, path: string, themed: boolean): Promise<string> {
  await page.setViewportSize(DESKTOP);
  await setScheme(page, "light", false);
  await page.goto(path);
  await page.waitForLoadState("networkidle");
  const reports = await scanBothSchemes(page, "desktop", themed);
  await page.setViewportSize(PHONE);
  await page.reload();
  await page.waitForLoadState("networkidle");
  reports.push(...(await scanBothSchemes(page, "mobile", themed)));
  return reports.join("\n");
}

for (const route of ROUTES) {
  test(`${route.name} has no WCAG 2.1 AA violations`, async ({ page }) => {
    expect(await scanEveryWay(page, route.path, route.themed ?? true), "WCAG 2.1 AA violations").toBe("");
  });
}

// Reached only signed in without a school: the (app) layout sends such a
// session here, and the proxy sends anyone without a session to /login.
for (const locale of ["sv", "en"]) {
  test(`/${locale}/no-profile has no WCAG 2.1 AA violations`, async ({ page, context, baseURL }) => {
    await signInAs(context, ORPHAN, baseURL!);
    await page.goto(`/${locale}/admin`);
    await expect(page).toHaveURL(new RegExp(`/${locale}/no-profile$`));
    expect(await scanEveryWay(page, `/${locale}/no-profile`, true), "WCAG 2.1 AA violations").toBe("");
  });
}

test.describe("keyboard access", () => {
  test("login form controls are reachable by Tab, in source order", async ({
    page,
  }) => {
    await page.goto("/en/login");

    /**
     * Walks the forward tab sequence and records what each stop is. Bounded so
     * a focus trap fails the test instead of hanging it, and stops early once
     * focus leaves the document (Tab reaching browser chrome).
     */
    const sequence: string[] = [];
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press("Tab");
      const stop = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        return [
          el.tagName.toLowerCase(),
          el.getAttribute("type") ?? "",
          el.getAttribute("id") ?? "",
          (el.textContent ?? "").trim().slice(0, 20),
        ].join("|");
      });
      if (stop === null) break;
      sequence.push(stop);
    }

    const indexOf = (predicate: (s: string) => boolean) =>
      sequence.findIndex(predicate);

    const email = indexOf((s) => s.includes("|email"));
    const password = indexOf((s) => s.includes("|password"));
    const submit = indexOf((s) => s.startsWith("button|submit"));

    const trace = `tab order was:\n  ${sequence.join("\n  ")}`;

    // Assert reachability and relative order, not adjacency: the
    // "forgot password?" link legitimately sits between the password label and
    // its input, so the submit button is not the next stop after the password.
    expect(email, `email input never focused. ${trace}`).toBeGreaterThanOrEqual(
      0,
    );
    expect(
      password,
      `password input never focused. ${trace}`,
    ).toBeGreaterThanOrEqual(0);
    expect(
      submit,
      `submit button never focused. ${trace}`,
    ).toBeGreaterThanOrEqual(0);

    expect(email, `email must precede password. ${trace}`).toBeLessThan(
      password,
    );
    expect(password, `password must precede submit. ${trace}`).toBeLessThan(
      submit,
    );
  });

  test("the school-account button follows the password's, and asks for the address by keyboard alone", async ({
    page,
  }) => {
    await page.goto("/sv/login");
    const submit = page.getByRole("button", { name: "Logga in", exact: true });
    const schoolAccount = page.getByRole("button", { name: "Logga in med skolkonto" });
    await submit.focus();
    await page.keyboard.press("Tab");
    await expect(schoolAccount).toBeFocused();

    // No address yet: it says so and puts the cursor in the address field,
    // without asking anyone anything.
    await page.keyboard.press("Enter");
    // Next's route announcer is an alert too; this one is the form's.
    await expect(page.getByRole("alert").filter({ hasText: "Skriv din e-postadress först" })).toBeVisible();
    await expect(page.getByLabel(/e-post/i)).toBeFocused();
  });

  test("login form can be submitted by keyboard alone", async ({ page }) => {
    await page.goto("/en/login");

    await page.getByLabel(/email/i).focus();
    await page.keyboard.type("teacher@example.com");
    await page.getByLabel(/password/i).focus();
    await page.keyboard.type("hunter2hunter2");

    // Enter inside a text input must submit the form — a mouse-only submit
    // path would strand keyboard and screen-reader users.
    await page.keyboard.press("Enter");

    // The backend stub (e2e/stub) rejects every password; what matters is
    // that the attempt happened at all, so wait for the request to settle.
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  });

  test("focus is visible on the primary action", async ({ page }) => {
    await page.goto("/en/login");
    const submit = page.getByRole("button", { name: "Sign in", exact: true });
    await submit.focus();

    const outline = await submit.evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        outlineWidth: s.outlineWidth,
        outlineStyle: s.outlineStyle,
        boxShadow: s.boxShadow,
      };
    });

    const hasRing =
      (outline.outlineStyle !== "none" &&
        parseFloat(outline.outlineWidth) > 0) ||
      (outline.boxShadow !== "none" && outline.boxShadow !== "");
    expect(hasRing, `no visible focus indicator: ${JSON.stringify(outline)}`).toBe(
      true,
    );
  });
});
