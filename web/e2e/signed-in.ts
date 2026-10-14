import type { BrowserContext, Page } from "@playwright/test";
import { NOW } from "./stub/fixtures/calendar";
import { AUTH_COOKIE, PEOPLE, sessionCookieValue, STUB_ORIGIN, type Persona } from "./stub/sessions";

/**
 * Stops the browser's clock at the fixture school's now (this week's
 * Wednesday, 10:00; e2e/stub/fixtures/calendar.ts), before the page loads,
 * so "today" in the browser is the day the fixtures were written for.
 * Timers keep running.
 */
export async function freezeClock(page: Page) {
  await page.clock.setFixedTime(new Date(NOW));
}

/**
 * Signs the browser in as one of the four fixture people by setting the
 * Supabase session cookie the app reads on the server and in the browser.
 */
export async function signIn(context: BrowserContext, persona: Persona, baseURL: string) {
  await context.addCookies([
    {
      name: AUTH_COOKIE,
      value: sessionCookieValue(PEOPLE[persona]),
      url: baseURL,
      sameSite: "Lax",
    },
  ]);
}

/**
 * Collects what the page asked the stub for and got no fixture: each a
 * `METHOD /path` line. A page that read nothing it lacked rendered its real
 * content, not an error state — which is what makes its axe result mean
 * something.
 */
export function watchStubMisses(page: Page): string[] {
  const misses: string[] = [];
  page.on("response", (response) => {
    if (!response.url().startsWith(STUB_ORIGIN)) return;
    if (response.headers()["x-stub"] !== "miss") return;
    const url = new URL(response.url());
    misses.push(`${response.request().method()} ${url.pathname}`);
  });
  return misses;
}

/**
 * Waits for the page to finish reading: no request in flight for 500 ms, and
 * no skeleton or spinner left (`aria-busy`, which the app's loaders set).
 */
export async function settle(page: Page) {
  await page.waitForLoadState("networkidle");
  await page.waitForFunction(() => document.querySelectorAll('[aria-busy="true"]').length === 0, undefined, {
    timeout: 10_000,
  });
}
