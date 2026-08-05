import { expect, test, type Page } from "@playwright/test";

/**
 * Visual regression gate (§2: ≤0.1% pixel variance).
 *
 * Baselines live in `e2e/visual.spec.ts-snapshots/` and are committed. The
 * ratio is enforced by `expect.toHaveScreenshot.maxDiffPixelRatio` in
 * playwright.config.ts, so individual assertions stay declarative.
 *
 * Regenerate deliberately, never casually:
 *   npx playwright test --project=visual --update-snapshots
 * and review the resulting image diff in the PR like any other change.
 */

const ROUTES = [
  { path: "/sv/login", name: "login-sv" },
  { path: "/en/login", name: "login-en" },
  { path: "/sv/forgot-password", name: "forgot-password-sv" },
  { path: "/sv/update-password", name: "update-password-sv" },
  { path: "/sv/no-profile", name: "no-profile-sv" },
];

/**
 * Removes the two sources of non-determinism that otherwise blow past a 0.1%
 * budget on every run: in-flight transitions and blinking carets. Fonts are
 * awaited rather than faked so real typography is what gets compared.
 */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({
    content: `*, *::before, *::after {
      animation-duration: 0s !important;
      animation-delay: 0s !important;
      transition-duration: 0s !important;
      transition-delay: 0s !important;
      caret-color: transparent !important;
    }`,
  });
}

for (const route of ROUTES) {
  test(`${route.name} matches its baseline`, async ({ page }) => {
    await page.goto(route.path);
    await settle(page);

    await expect(page).toHaveScreenshot(`${route.name}.png`, {
      fullPage: true,
    });
  });
}

test.describe("dark theme", () => {
  test.use({ colorScheme: "dark" });

  test("login-sv matches its dark baseline", async ({ page }) => {
    await page.goto("/sv/login");
    await settle(page);

    await expect(page).toHaveScreenshot("login-sv-dark.png", {
      fullPage: true,
    });
  });
});

test.describe("component states", () => {
  test("login form in its error state matches baseline", async ({ page }) => {
    await page.goto("/en/login");
    await settle(page);

    // Bad credentials against the placeholder Supabase project fail closed,
    // which is exactly the error surface worth pinning.
    await page.getByLabel(/email/i).fill("nobody@example.com");
    await page.getByLabel(/password/i).fill("wrong-password");
    await page.getByRole("button", { name: /sign in/i }).click();

    // Wait for the request to settle rather than the specific copy, so the
    // baseline — not the assertion — owns what the error looks like.
    await page.waitForLoadState("networkidle");
    await settle(page);

    await expect(page).toHaveScreenshot("login-en-error.png", {
      fullPage: true,
    });
  });

  test("primary button focus ring matches baseline", async ({ page }) => {
    await page.goto("/en/login");
    await settle(page);

    const submit = page.getByRole("button", { name: /sign in/i });
    await submit.focus();

    await expect(submit).toHaveScreenshot("button-primary-focus.png");
  });
});
