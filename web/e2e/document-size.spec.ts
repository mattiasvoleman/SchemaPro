import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { expect, test } from "@playwright/test";
import { signIn } from "./signed-in";
import type { Persona } from "./stub/sessions";

/**
 * What a signed-in full page load costs in HTML besides the message catalog,
 * gzipped, held against a ceiling.
 *
 * Why it exists. The bundle gate (scripts/bench/bundle-size.mjs) counts the
 * JavaScript a route names, and the menus are no longer in it: since the menu
 * became server data (components/layout/role-nav.tsx) it is in the layout's
 * HTML and RSC payload instead, once per full page load, and the document is
 * not cached the way the bundle is. A row costs the bundle nothing from there
 * on, so without this test the next phases could add rows, and the icons they
 * bring, for as long as they like and no number would go red.
 *
 * What it measures. The raw response of /sv/notifications (the one page every
 * role has, and a quiet one: little of its own, so the figure is the shell and
 * the menu and not a dashboard's cards), fetched with the signed-in browser
 * context (its cookie, no JavaScript run) and gzipped at level 9 by node:zlib,
 * so that it is the same whatever the server's own compression settings.
 * Against the e2e stub's school, in the production build this project's
 * webServer makes. Two fetches of one build agree to the byte, and two builds
 * to within a byte or so.
 *
 * Less the message catalog. The document carries the whole catalog of the
 * active language (messages/sv.json: the (app) layout's NextIntlClientProvider
 * is given no `messages`), which is 157 KB of the ~170 KB gzipped, and it grew
 * 0.1 to 4.6 KB gzipped, 1.8 KB on average, in each of the last fourteen
 * commits that touched it. A ceiling on the whole document would be crossed by
 * the next phase's messages whatever its menu did, and would be raised each
 * time without anyone looking at the menu. So the catalog's own gzip (the same
 * JSON, gzipped by itself) is taken off, and what is held against the ceiling
 * is the rest: the shell, the menu, the page. One gzip off another is not
 * exact, since the catalog sits escaped in the payload, but it follows the
 * catalog: taking a namespace of 6 to 11 KB gzipped out of both the document
 * and the JSON changed the two by amounts under 1 % apart (five tried), tens of
 * bytes, where MARGIN is 1.5 KB. The catalog is the larger item and is not this
 * test's; the log line says how large it is.
 *
 * To re-measure after a change that is meant to move it: run this project in
 * CI mode, read `rest` in the log, and set `measured` to it. The commit says
 * what moved it.
 *
 *   CI=1 E2E_WEB_PORT=3100 E2E_STUB_PORT=54400 npx playwright test --project=document-size
 *
 * It runs in CI as a step of its own, with the list reporter (the github
 * reporter prints nothing of a passing test), after the functional smoke.
 */

/**
 * Room above the measured figure. Two fetches of one build agree to the byte,
 * and two builds to within a byte or so (measured: the teacher's figure was
 * 9 452 and 9 453). A menu row whose icon another row has costs a few tens of
 * bytes; ten admin rows with ten icons that no row had cost 1 995 B, 459 B over
 * this room (measured, 2026-11-07), and the next phase's one or two rows are
 * well inside it.
 */
const MARGIN = 1_536;

/**
 * How far under `measured` the rest may fall before the test says so. A
 * document that has lost its catalog (or most of its shell) must not pass
 * with room nobody counted: the figure falls by a hundred KB and the test
 * asks for a new measurement.
 */
const DROP = 4_096;

interface Measured {
  /** What the log calls it. */
  name: string;
  persona: Persona;
  url: string;
  /** A row of this role's menu that the document must contain, or the fetch is not the page. */
  row: string;
  /** `rest` (gzipped document less gzipped catalog, bytes) when last measured. */
  measured: number;
}

const PAGES: Measured[] = [
  { name: "admin", persona: "admin", url: "/sv/notifications", row: "/sv/admin/setup", measured: 13_184 },
  { name: "teacher", persona: "teacher", url: "/sv/notifications", row: "/sv/teacher/attendance", measured: 9_629 },
];

const catalog = JSON.stringify(JSON.parse(readFileSync(join(__dirname, "..", "messages", "sv.json"), "utf8")));
const catalogGzipped = gzipSync(catalog, { level: 9 }).length;

for (const page of PAGES) {
  test(`${page.name} ${page.url}: the document, less the catalog, stays under its ceiling`, async ({ context, baseURL }) => {
    await signIn(context, page.persona, baseURL!);
    const response = await context.request.get(page.url);
    expect(response.status(), "the page answers").toBe(200);
    expect(new URL(response.url()).pathname, "and is not a redirect to the login").toBe(page.url);
    const html = await response.body();
    // Not an error page that is small because it is empty: the role's menu is in it.
    expect(html.includes(page.row), `the document holds the menu row ${page.row}`).toBe(true);

    const gzipped = gzipSync(html, { level: 9 }).length;
    const rest = gzipped - catalogGzipped;
    const ceiling = page.measured + MARGIN;
    console.log(
      `document-size ${page.name} ${page.url}: rest ${rest} B ` +
        `(document ${gzipped} B gzipped, ${html.length} B raw, less the catalog ${catalogGzipped} B), ` +
        `measured ${page.measured} B, ceiling ${ceiling} B, room ${ceiling - rest} B`,
    );
    expect(
      rest,
      `${page.name}: the document is ${gzipped} B gzipped and ${rest} B of it is not the catalog, ` +
        `over the ceiling of ${ceiling} B (${page.measured} B measured + ${MARGIN} B). ` +
        "If the menu grew on purpose, set `measured` in e2e/document-size.spec.ts to the figure and say in the commit what raised it.",
    ).toBeLessThanOrEqual(ceiling);
    expect(
      rest,
      `${page.name}: ${rest} B is ${page.measured - rest} B under what was measured. ` +
        "If the catalog is no longer in the document, or the shell shrank, set `measured` to the figure, " +
        "so that the ceiling follows and there is no room that nobody counted.",
    ).toBeGreaterThanOrEqual(page.measured - DROP);
  });
}
