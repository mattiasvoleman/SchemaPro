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
 * Where the drift is not small. That holds for a catalog that grows by prose,
 * which gzips about as well in the document as by itself (500 sentences of
 * Swedish, +9 636 B gzipped in the catalog: `rest` +62 B for the administrator
 * and +100 B for the teacher). It does not hold for strings that do not
 * compress, ids, hex colours, URLs: 60 random strings of 147 characters,
 * +8 081 B gzipped in the catalog, moved `rest` by -537 B and -380 B, 5 % of
 * the addition, downwards (both measured in the second review of #275). Twelve
 * phases of ordinary messages drift `rest` by +130 to +220 B, inside MARGIN, and
 * a catalog of nothing but such strings would take that much room away from
 * the ceiling instead of using it. `rest` falling is therefore not a menu that
 * shrank: DROP says when it has fallen too far to be that.
 *
 * To re-measure after a change that is meant to move it: run this project in
 * CI mode, read `rest` in the log, and set `measured` to it. The commit says
 * what moved it. CI mode is the production build; without it Playwright starts
 * `next dev`, whose document is larger by 1.6 to 1.7 KB with the same menu
 * (14 649 B and 11 025 B for the administrator's and the teacher's `rest`
 * against ceilings of 14 482 B and 10 988 B, measured 2026-11-07), so this
 * project skips itself there and says so, and does not fail a menu that did
 * not change with a text that blames the menu.
 *
 *   CI=1 E2E_WEB_PORT=3100 E2E_STUB_PORT=54400 npx playwright test --project=document-size
 *
 * It runs in CI as a step of its own, with the list reporter (the github
 * reporter prints nothing of a passing test), after the visual regression
 * step, so that a failure here does not hide that result in the same run.
 */

/**
 * The same test playwright.config.ts makes to choose between the production
 * build (`npm run build && npm run start`) and `npm run dev` for its
 * webServer, so that this project measures exactly when it is the first.
 */
const PRODUCTION_BUILD = !!process.env.CI;
const SKIPPED = "the document is measured in the production build, and this run is not in CI mode: start it with CI=1";

/**
 * Room above the measured figure. What it has to be larger than, and what it
 * is for (rows added to a copy of the menus 2026-11-07, against the e2e stub,
 * in the production build, on macOS; CI's Linux figures are 7 to 17 B lower):
 *
 *   - Noise: two fetches of one build agree to the byte, two builds of one
 *     source to 2 or 3 B, a Mac and CI's Linux to 13 to 17 B.
 *   - A catalog that grows (see above): +130 to +220 B over twelve phases was
 *     the estimate, and a phase's own messages have moved `rest` by more than
 *     that on their own: Klasslärarens schema's figures were 184 and 181 B over
 *     what its one row per menu explains (39 and 31 B), the other 145 and 150 B
 *     being its messages' effect on the gzip of the document beside the
 *     catalog's.
 *   - A row whose icon the menu already has: 36 to 45 B in the copy (teacher 4
 *     rows +146, 8 rows +287; pupil 4 rows +152), and in the phases that have
 *     added one, measured in CI 2026-11-08: Måltidskollen's, with Lunchsittningar's
 *     icon, 92 B on top of 12 946; Checklistor's, with Kvittens' icon, 145 B for
 *     the administrator and 109 B for the teacher on top of 13 457 and 9 836;
 *     Lokal's three admin rows, one teacher row and the notice text of the
 *     clash, 594 B and 687 B on top of 13 666 and 9 938.
 *   - A row with an icon no other row of the menu has: 140 to 300 B, and more
 *     per row the more rows (administrator 4 rows +953, 8 rows +2 136;
 *     guardian 2 rows +341, 4 rows +1 200; the second review of #275 had 1 row
 *     +140, 4 rows +716 and 8 rows +1 666, with other icons). Several times a
 *     borrowed icon's row, which is why the icons are what the room is spent on.
 *
 * So 1 536 B is ten to fifty rows that borrow an icon, or about seven that
 * bring one (four fitted with 598 B to spare, eight did not): more than the
 * one or two rows a phase brings, less than a wave of twelve with an icon each.
 * A phase does not see its own cost, since it is inside the room, and two
 * phases that are green on their own can cross it together on main; that is
 * what WARN is for, and why the room is not made smaller: a smaller one is
 * crossed by more phases, each of which then sets `measured` on the same two
 * lines.
 */
const MARGIN = 1_536;

/**
 * Under this much room the log line is also a GitHub annotation, so that the
 * cost of the rows added so far shows on the run and not only in a log line
 * nobody opens, a phase or two before the ceiling.
 */
const WARN = MARGIN / 2;

/**
 * How far under `measured` the rest may fall before the test says so. A
 * document that has lost its catalog (or most of its shell) must not pass
 * with room nobody counted. When the catalog leaves the document `rest` falls
 * by about its whole size, a hundred KB and more, and goes negative; what the
 * test then asks for is not a new `measured` but the end of the subtraction
 * (see floorMessage).
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

/*
 * How the figures were last set (Klasslärarens schema, which added one row to each menu): main's own
 * (admin 13 038, teacher 9 452, after Måltidskollen) plus what the row costs, 39 B in the administrator's
 * menu and 31 B in the teacher's (AppShell rendered with the real menu and the real catalog, gzipped with
 * and without the row), which is 13 077 and 9 483. The build then showed 13 261 and 9 664: 184 and 181 B
 * over, of which the rows are 39 and 31 and the rest the phase's own messages, which move the gzip of the
 * document beside the catalog's. The ceiling is not raised for that rest, so the room is 1 352 and 1 355 B
 * where it was 1 536: a phase pays the room its text uses, and the next one finds what is left.
 */
const PAGES: Measured[] = [
  { name: "admin", persona: "admin", url: "/sv/notifications", row: "/sv/admin/setup", measured: 14_260 },
  { name: "teacher", persona: "teacher", url: "/sv/notifications", row: "/sv/teacher/attendance", measured: 10_625 },
];

/**
 * The guardian's four rows and the pupil's three: the roles the phases add
 * least to, measured like the two above (the same page, the same ceiling) so
 * that a row added to one of them is not the one that nothing measures. Their
 * own array, so that the two lines above, which the phases that add rows to
 * the administrator's and the teacher's menus edit, are not also the lines of
 * these.
 *
 * Set on main 5e68a7c3 (macOS, production build): 8 952 and 8 729 B. On
 * b1c2f587, before the wave, they were 8 447 and 8 211: 505 and 518 B more with
 * no row added to either menu, which is the wave's shared code and messages
 * (the catalog grew by 35 343 B gzipped, 193 184 B now) moving the document
 * beside the catalog.
 */
const SMALL_MENUS: Measured[] = [
  { name: "guardian", persona: "guardian", url: "/sv/notifications", row: "/sv/guardian/absence-watch", measured: 8_952 },
  { name: "student", persona: "student", url: "/sv/notifications", row: "/sv/student/attendance", measured: 8_729 },
];

const catalog = JSON.stringify(JSON.parse(readFileSync(join(__dirname, "..", "messages", "sv.json"), "utf8")));
const catalogGzipped = gzipSync(catalog, { level: 9 }).length;

/**
 * What to do when `rest` has fallen more than DROP under `measured`. The case
 * this floor is for is the catalog leaving the document (the (app) layout's
 * NextIntlClientProvider given a filtered `messages`): `rest` is then the
 * document less a catalog that is not in it, which can be negative, and
 * setting `measured` to that would leave the subtraction taking the whole of
 * sv.json off a number that no longer holds it, so that each string a phase
 * adds lowered `rest` by its size and the ceiling lost that much of its force.
 */
function floorMessage(name: string, rest: number, measured: number): string {
  const under = `${name}: rest is ${rest} B, ${measured - rest} B under the ${measured} B measured (allowed: ${DROP} B). `;
  const catalogLeft =
    `The message catalog is no longer all in the document, and this test still takes ${catalogGzipped} B ` +
    "(the gzip of messages/sv.json) off it. Do NOT set `measured` to this figure. Change what is taken off in " +
    "e2e/document-size.spec.ts (drop `catalogGzipped` from `rest`, or take off what the document now holds of the " +
    "catalog), measure again in CI mode, set `measured` to that, and say in the commit that the catalog left the document.";
  if (rest < 0) {
    // A size cannot be negative: the document is smaller than the catalog it is said to hold.
    return `${under}A negative figure means the document is smaller than the catalog this test takes off it. ${catalogLeft}`;
  }
  return (
    `${under}Either the shell or the menu got smaller on purpose: then set \`measured\` to the figure, so that the ` +
    `ceiling follows and there is no room that nobody counted. Or part of the catalog left the document. ${catalogLeft}`
  );
}

// One worker for the file, so that the notice of a skipped run is printed once.
// Each test is still its own: a failure of one does not skip the rest.
test.describe.configure({ mode: "default" });

for (const page of [...PAGES, ...SMALL_MENUS]) {
  test(`${page.name} ${page.url}: the document, less the catalog, stays under its ceiling`, async ({ context, baseURL }) => {
    skipUnlessProduction();
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
    if (ceiling - rest < WARN) {
      // A workflow command: GitHub shows it as an annotation on the run. Anywhere else it is a line in the log.
      console.log(
        `::warning title=Document size::${page.name} ${page.url}: ${ceiling - rest} B of ${MARGIN} B room left under the ceiling ` +
          `(rest ${rest} B, measured ${page.measured} B). Rows added since the last measurement are what used it; ` +
          "the change that crosses it sets `measured` in e2e/document-size.spec.ts and says what raised it.",
      );
    }
    expect(
      rest,
      `${page.name}: the document is ${gzipped} B gzipped and ${rest} B of it is not the catalog, ` +
        `over the ceiling of ${ceiling} B (${page.measured} B measured + ${MARGIN} B). ` +
        "If the menu grew on purpose, set `measured` in e2e/document-size.spec.ts to the figure and say in the commit what raised it.",
    ).toBeLessThanOrEqual(ceiling);
    expect(rest, floorMessage(page.name, rest, page.measured)).toBeGreaterThanOrEqual(page.measured - DROP);
  });
}

/**
 * Skips the test, once with a line in the log, when this is not the production
 * build. test.skip's own text reaches the HTML report and not the list
 * reporter, which is the one a person running this by hand reads.
 */
let said = false;
function skipUnlessProduction() {
  if (PRODUCTION_BUILD) return;
  if (!said) {
    said = true;
    console.log(`document-size skipped: ${SKIPPED}`);
  }
  test.skip(true, SKIPPED);
}
