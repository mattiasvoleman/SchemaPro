import { expect, test } from "@playwright/test";
import { SCHOOL_WEBSITE, SHARE_TOKEN } from "./stub/fixtures/gateway-public";
import { GROUPS } from "./stub/fixtures/world";

/**
 * Schemavisaren in a frame (Utskrift och inbäddning, 20261102090000), in a
 * real browser against the web server as CI runs it: the headers the proxy
 * sends, and what the browser then does with them. A share link's frame
 * (/v/<token>/embed) is shown inside the school's own website and refused
 * inside any other; every other viewer page is refused everywhere.
 *
 * The gateway is the suite's stub (e2e/stub/fixtures/gateway-public.ts): its
 * share link may be framed by the school's website, and any other token is
 * the viewer's 404 there as everywhere. The school's website and another
 * site are Playwright routes, so no real host is asked. SchemaPro itself is
 * reached as https://schema.exempelskolan.example, a route that hands each
 * request to the web server and its answer back, headers and all: every page
 * in the test is then https on a public name, so the browser judges the
 * frame by its frame-ancestors alone, not by mixed content or by a public
 * page reaching for localhost.
 */

const CLOSED = "C".repeat(43);
const SCHEMAPRO = "https://schema.exempelskolan.example";
const WEEK_OF_7A = `?target=${GROUPS.g7A.id}`;
const frameOn = (url: string) =>
  `<!doctype html><title>Skolan</title><iframe id="schema" title="Schema" src="${url}" width="900" height="700"></iframe>`;

test.describe.configure({ mode: "serial" });

test.describe("embedding the public viewer", () => {
  test.beforeEach(async ({ page, baseURL }) => {
    await page.route(`${SCHEMAPRO}/**`, async (route) => {
      const response = await route.fetch({ url: route.request().url().replace(SCHEMAPRO, baseURL!) });
      await route.fulfill({ response });
    });
  });

  test("a share link's frame names the school's website as its only frame ancestor", async ({ request }) => {
    const embed = await request.get(`/v/${SHARE_TOKEN}/embed${WEEK_OF_7A}`);
    expect(embed.status()).toBe(200);
    expect(embed.headers()["content-security-policy"]).toBe(`frame-ancestors ${SCHOOL_WEBSITE}`);
    expect(embed.headers()["x-frame-options"]).toBeUndefined();
    expect(embed.headers()["x-robots-tag"]).toBe("noindex, nofollow");
    expect(embed.headers()["referrer-policy"]).toBe("no-referrer");
  });

  test("a link the school does not let be embedded, and every other viewer page, may be framed nowhere", async ({ request }) => {
    const closed = await request.get(`/v/${CLOSED}/embed`);
    expect(closed.headers()["content-security-policy"]).toBe("frame-ancestors 'none'");
    expect(closed.headers()["x-frame-options"]).toBe("DENY");
    for (const path of [`/v/${SHARE_TOKEN}`, `/v/${SHARE_TOKEN}${WEEK_OF_7A}`, `/v/${CLOSED}`]) {
      const page = await request.get(path);
      expect(page.headers()["content-security-policy"]).toBe("frame-ancestors 'none'");
      expect(page.headers()["x-frame-options"]).toBe("DENY");
    }
  });

  test("the browser shows the frame inside the school's website", async ({ page }) => {
    await page.route(`${SCHOOL_WEBSITE}/**`, (route) =>
      route.fulfill({ contentType: "text/html", body: frameOn(`${SCHEMAPRO}/v/${SHARE_TOKEN}/embed${WEEK_OF_7A}`) }),
    );
    await page.goto(`${SCHOOL_WEBSITE}/schema`);
    const frame = page.frameLocator("#schema");
    await expect(frame.getByRole("heading", { level: 1, name: "7A" })).toBeVisible({ timeout: 30_000 });
    // The tab order inside the frame: the week's links, then the way out to the full viewer, in a tab of its own.
    await expect(frame.getByRole("link").last()).toHaveText("Öppna i Schemavisaren");
    await expect(frame.getByRole("link").last()).toHaveAttribute("target", "_blank");
  });

  test("the browser refuses the frame inside any other website, and every viewer page inside the school's", async ({ page }) => {
    const refusals: string[] = [];
    page.on("console", (message) => {
      if (message.text().includes("frame-ancestors")) refusals.push(message.text());
    });
    await page.route("https://elsewhere.example/**", (route) =>
      route.fulfill({ contentType: "text/html", body: frameOn(`${SCHEMAPRO}/v/${SHARE_TOKEN}/embed${WEEK_OF_7A}`) }),
    );
    await page.goto("https://elsewhere.example/");
    await expect.poll(() => refusals.length).toBeGreaterThan(0);
    await expect(page.frameLocator("#schema").getByRole("heading", { name: "7A" })).toHaveCount(0);

    refusals.length = 0;
    await page.route(`${SCHOOL_WEBSITE}/**`, (route) =>
      route.fulfill({ contentType: "text/html", body: frameOn(`${SCHEMAPRO}/v/${SHARE_TOKEN}${WEEK_OF_7A}`) }),
    );
    await page.goto(`${SCHOOL_WEBSITE}/full`);
    await expect.poll(() => refusals.length).toBeGreaterThan(0);
    await expect(page.frameLocator("#schema").getByRole("heading", { name: "7A" })).toHaveCount(0);
  });
});
