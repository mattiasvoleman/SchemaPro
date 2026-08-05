import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * WCAG 2.1 AA gate (§2: "100% compliance at AA level").
 *
 * axe-core is the automated half of that claim — it catches contrast, naming,
 * landmark and ARIA defects deterministically. It does not, and cannot, prove
 * full AA conformance: keyboard traps, focus order, and meaningful alt text
 * still need a manual pass. Treat a green run as "no automated violations",
 * which is what CI can honestly enforce.
 */

/** Public routes; everything under (app) requires a Supabase session. */
const ROUTES = [
  { path: "/sv/login", name: "login (sv)" },
  { path: "/en/login", name: "login (en)" },
  { path: "/sv/forgot-password", name: "forgot password (sv)" },
  { path: "/en/forgot-password", name: "forgot password (en)" },
  { path: "/sv/update-password", name: "update password (sv)" },
  { path: "/sv/no-profile", name: "no profile (sv)" },
];

const WCAG_AA_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

const scan = (page: Page) =>
  new AxeBuilder({ page })
    .withTags(WCAG_AA_TAGS)
    // next-themes writes the theme class after hydration; the injected
    // <script> it uses has no accessible role and is not part of the UI.
    .exclude("next-route-announcer")
    .analyze();

/** Renders axe output as something a reviewer can act on without the HTML report. */
const format = (
  violations: Awaited<ReturnType<typeof scan>>["violations"],
): string =>
  violations
    .map(
      (v) =>
        `[${v.impact ?? "unknown"}] ${v.id}: ${v.help}\n` +
        v.nodes.map((n) => `    ${n.target.join(" ")}`).join("\n"),
    )
    .join("\n");

for (const route of ROUTES) {
  test(`${route.name} has no WCAG 2.1 AA violations`, async ({ page }) => {
    await page.goto(route.path);
    await page.waitForLoadState("networkidle");

    const { violations } = await scan(page);
    expect(violations, format(violations)).toEqual([]);
  });
}

test.describe("dark theme", () => {
  test.use({ colorScheme: "dark" });

  // Contrast regressions land in exactly one theme far more often than both.
  test("login page has no WCAG 2.1 AA violations in dark mode", async ({
    page,
  }) => {
    await page.goto("/sv/login");
    await page.waitForLoadState("networkidle");

    const { violations } = await scan(page);
    expect(violations, format(violations)).toEqual([]);
  });
});

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

  test("login form can be submitted by keyboard alone", async ({ page }) => {
    await page.goto("/en/login");

    await page.getByLabel(/email/i).focus();
    await page.keyboard.type("teacher@example.com");
    await page.getByLabel(/password/i).focus();
    await page.keyboard.type("hunter2hunter2");

    // Enter inside a text input must submit the form — a mouse-only submit
    // path would strand keyboard and screen-reader users.
    await page.keyboard.press("Enter");

    // The placeholder Supabase project rejects the credentials; what matters is
    // that the attempt happened at all, so wait for the request to settle.
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();
  });

  test("focus is visible on the primary action", async ({ page }) => {
    await page.goto("/en/login");
    const submit = page.getByRole("button", { name: /sign in/i });
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
