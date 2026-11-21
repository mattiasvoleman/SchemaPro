import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { makeXlsx } from "../lib/__fixtures__/xlsx-builder";

/**
 * Pseudonymiseraren (X1) in a real browser, against the web server as CI runs it: a production build, where the page's policy is the strict one.
 *
 * The unit tests run the whole flow with every way out replaced by a trap, and read the code for anything that sends or stores. This is the
 * third half of "the file never leaves the browser": a Chromium that is told, by the page's own response, to refuse every request, and that
 * is then asked to make one of each kind. Locally Playwright runs `next dev`, whose hot reload needs a websocket, so the policy is relaxed
 * there (lib/pseudonym-policy.ts) and the tests that need the strict one skip themselves; CI never skips them.
 */

const PATH = "/sv/pseudonymisera";

const FILE = [
  "Lärare;Ämne;Klass;Notis",
  "Anna Svensson;Svenska;7A;Anna är sjuk, ring 070-123 45 67",
  "Bo Ek;Matte;7B;Se anna.svensson@skola.se",
  "Anna Svensson;Svenska;7B;Byt sal i morgon",
  "Cia Lind;Engelska;8A;Prov på fredag",
].join("\r\n") + "\r\n";

const SAFE = [
  "Lärare;Ämne;Klass;Notis",
  'NAMN-0001;Svenska;7A;"NAMN-0002 är sjuk, ring TEL-0001"',
  "NAMN-0003;Matte;7B;Se epost-0001@exempel.invalid",
  "NAMN-0001;Svenska;7B;Byt sal i morgon",
  "NAMN-0004;Engelska;8A;Prov på fredag",
].join("\r\n") + "\r\n";

async function chooseFile(page: Page, name: string, buffer: Buffer): Promise<void> {
  await page.getByLabel("Välj en eller flera filer").setInputFiles({ name, mimeType: "application/octet-stream", buffer });
}

/** Keeps the column no header places (Notis, the fourth), runs, and says the preview has been looked through. */
async function runAndConfirm(page: Page): Promise<void> {
  await page.getByLabel("Vad ska hända med kolumn 4?").selectOption("keep");
  await page.getByRole("button", { name: "Ta bort personuppgifter" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "5. Resultat" })).toBeVisible();
  await page.getByLabel("Jag har tittat igenom förhandsvisningen").check();
}

test.describe("the page", () => {
  test("is public: no sign-in, no redirect to the login, in either language, and the bare address goes to a language, not to the login", async ({ request }) => {
    for (const path of ["/sv/pseudonymisera", "/en/pseudonymisera"]) {
      const response = await request.get(path, { maxRedirects: 0 });
      expect(response.status(), path).toBe(200);
    }
    const bare = await request.get("/pseudonymisera", { maxRedirects: 0 });
    expect(bare.status()).toBeGreaterThanOrEqual(300);
    // To the visitor's own language (the request says which), never to the login.
    expect(bare.headers()["location"] ?? "").toMatch(/\/(sv|en)\/pseudonymisera$/);
  });

  test("tells the browser to refuse every request it could make, on this page and on no other", async ({ request }) => {
    const page = await request.get(PATH);
    const policy = page.headers()["content-security-policy"] ?? "";
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("form-action 'none'");
    expect(policy).toContain("frame-src 'none'");
    expect(policy).toContain("object-src 'none'");
    expect(page.headers()["referrer-policy"]).toBe("no-referrer");
    // The production server's policy is `connect-src 'none'`; the development server opens its own websocket.
    expect(policy).toMatch(/connect-src ('none'|'self' ws: wss:)/);
    const login = await request.get("/sv/login");
    expect(login.headers()["content-security-policy"]).toBeUndefined();
  });

  test("asks not to be indexed", async ({ page }) => {
    await page.goto(PATH);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  });
});

test.describe("a run, in a real browser", () => {
  test("takes the personal data out of a file and hands back the safe text, and makes no request while it does", async ({ page, context }) => {
    await page.goto(PATH);
    await page.waitForLoadState("networkidle");

    // From here, nothing may be asked of anyone. Chunks of the page's own code that load late are the page's own and are let through; every other request is a failure.
    const requests: string[] = [];
    page.on("request", (request) => {
      const url = request.url();
      if (url.startsWith("blob:") || url.startsWith("data:") || new URL(url).pathname.startsWith("/_next/static/")) return;
      requests.push(`${request.method()} ${url}`);
    });
    const cookiesBefore = await context.cookies();

    await chooseFile(page, "lektioner.csv", Buffer.from(FILE, "utf8"));
    await runAndConfirm(page);
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Hämta säker fil 1" }).click()]);
    expect(download.suggestedFilename()).toMatch(/^exempelfil-\d+\.csv$/);
    expect(await readFile((await download.path())!, "utf8")).toBe(SAFE);

    expect(requests).toEqual([]);
    expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
    expect(await context.cookies()).toEqual(cookiesBefore);
  });

  test("writes a file saved in Windows-1252 back in Windows-1252, byte for byte where nothing was replaced", async ({ page }) => {
    await page.goto(PATH);
    // "Lärare;Klass\nÅke Öst;7A\n" with ä as E4, Å as C5 and Ö as D6.
    const original = Buffer.from([...Buffer.from("L"), 0xe4, ...Buffer.from("rare;Klass\n"), 0xc5, ...Buffer.from("ke "), 0xd6, ...Buffer.from("st;7A\n")]);
    await chooseFile(page, "latin.csv", original);
    await page.getByRole("button", { name: "Ta bort personuppgifter" }).click();
    await page.getByLabel("Jag har tittat igenom förhandsvisningen").check();
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Hämta säker fil 1" }).click()]);
    const bytes = await readFile((await download.path())!);
    expect(bytes.equals(Buffer.from([...Buffer.from("L"), 0xe4, ...Buffer.from("rare;Klass\nNAMN-0001;7A\n")]))).toBe(true);
  });

  test("reads an Excel file in the browser, with no library, and hands back its values as CSV with nothing of the document's author", async ({ page }) => {
    await page.goto(PATH);
    const book = await makeXlsx({
      sheets: [
        { name: "Lektioner", rows: [["Lärare", "Klass"], ["Anna Svensson", "7A"]] },
        { name: "Dolt", hidden: true, rows: [["hemligt namn"]] },
      ],
      author: "Fiktiv Författare",
    });
    await chooseFile(page, "schema.xlsx", Buffer.from(book));
    await expect(page.getByRole("heading", { level: 3, name: /Fil 1: schema\.xlsx, Lektioner/ })).toBeVisible();
    await expect(page.getByText("1 dolt blad lästes inte")).toBeVisible();
    await page.getByRole("button", { name: "Ta bort personuppgifter" }).click();
    await page.getByLabel("Jag har tittat igenom förhandsvisningen").check();
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Hämta säker fil 1" }).click()]);
    const text = await readFile((await download.path())!, "utf8");
    expect(text.replace(/^﻿/, "")).toBe("Lärare;Klass\r\nNAMN-0001;7A\r\n");
    expect(text).not.toMatch(/Fiktiv|hemligt/);
  });

  test("clears everything on request: the files, the result and the page's memory of them", async ({ page }) => {
    await page.goto(PATH);
    await chooseFile(page, "lektioner.csv", Buffer.from(FILE, "utf8"));
    await runAndConfirm(page);
    await page.getByRole("button", { name: "Rensa allt" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "5. Resultat" })).toHaveCount(0);
    await expect(page.getByRole("table")).toHaveCount(0);
  });
});

test.describe("what the browser itself refuses", () => {
  test("refuses a fetch, an XHR, a beacon, a websocket and a picture asked for: none reaches the network, and the browser says it was the policy", async ({ page }) => {
    const response = await page.goto(PATH);
    const policy = response!.headers()["content-security-policy"] ?? "";
    test.skip(!policy.includes("connect-src 'none'"), "the development server relaxes the policy for hot reload; CI runs a production build");

    // What the BROWSER did with each, seen from outside the page: a request that left would be answered (by a 404 at least), and one that the policy refused fails with
    // net::ERR_BLOCKED_BY_CSP. The in-page return values are not the evidence: a refused beacon still says `true` (it is queued, and refused after), and a refused
    // WebSocket is constructed and closes without ever opening.
    const probes = new Map<string, { failure: string | null; answered: boolean }>();
    page.on("request", (request) => {
      if (request.url().includes("__probe")) probes.set(request.url(), { failure: null, answered: false });
    });
    page.on("requestfailed", (request) => {
      const probe = probes.get(request.url());
      if (probe !== undefined) probe.failure = request.failure()?.errorText ?? "failed";
    });
    page.on("response", (reply) => {
      const probe = probes.get(reply.url());
      if (probe !== undefined) probe.answered = true;
    });
    const sockets: string[] = [];
    page.on("websocket", (socket) => sockets.push(socket.url()));

    const outcome = await page.evaluate(async () => {
      const violations: string[] = [];
      document.addEventListener("securitypolicyviolation", (event) => violations.push(event.violatedDirective));
      const results: Record<string, string> = {};
      try {
        await fetch(`${location.origin}/__probe-fetch`);
        results["fetch"] = "answered";
      } catch {
        results["fetch"] = "refused";
      }
      results["xhr"] = await new Promise<string>((resolve) => {
        const request = new XMLHttpRequest();
        request.onerror = () => resolve("refused");
        request.onload = () => resolve("answered");
        try {
          request.open("GET", `${location.origin}/__probe-xhr`);
          request.send();
        } catch {
          resolve("refused");
        }
      });
      navigator.sendBeacon(`${location.origin}/__probe-beacon`, "data");
      results["websocket"] = await new Promise<string>((resolve) => {
        try {
          const socket = new WebSocket(`ws://${location.host}/__probe-socket`);
          socket.onopen = () => resolve("opened");
          socket.onerror = () => resolve("refused");
          socket.onclose = () => resolve("refused");
          setTimeout(() => resolve("pending"), 3000);
        } catch {
          resolve("refused");
        }
      });
      results["image"] = await new Promise<string>((resolve) => {
        const image = new Image();
        image.onload = () => resolve("loaded");
        image.onerror = () => resolve("refused");
        image.src = `${location.origin}/__probe-image.png?x=data`;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { results, violations };
    });

    expect(outcome.results).toEqual({ fetch: "refused", xhr: "refused", websocket: "refused", image: "refused" });
    expect(outcome.violations).toEqual(expect.arrayContaining(["connect-src", "img-src"]));
    // Nothing that was asked for was answered, and no websocket was ever made.
    expect([...probes.values()].filter((probe) => probe.answered)).toEqual([]);
    // The ones Chromium issues at all (a fetch and a beacon are refused before a request exists) fail as the policy: Playwright says "csp", the protocol says net::ERR_BLOCKED_BY_CSP.
    expect([...probes.values()].every((probe) => probe.failure === null || /^csp$|BLOCKED_BY_CSP/.test(probe.failure))).toBe(true);
    expect(sockets).toEqual([]);
  });
});

test.describe("in English", () => {
  test("is the same page in English, with the way back to Swedish", async ({ page }) => {
    await page.goto("/en/pseudonymisera");
    await expect(page.getByRole("heading", { level: 1, name: "Remove personal data from a file" })).toBeVisible();
    await page.getByLabel("Choose one or more files").setInputFiles({ name: "a.csv", mimeType: "text/csv", buffer: Buffer.from("Teacher;Class\nAnna Svensson;7A\n") });
    await expect(page.getByRole("heading", { level: 3, name: "File 1: a.csv" })).toBeVisible();
    await page.getByRole("link", { name: "Svenska" }).click();
    await expect(page).toHaveURL(/\/sv\/pseudonymisera$/);
  });
});
