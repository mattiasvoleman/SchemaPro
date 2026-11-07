import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isValidElement } from "react";
import { describe, expect, it } from "vitest";
import { PAGE_GATES } from "@/lib/admin-areas";
import type { UserRole } from "@/lib/types";
import english from "@/messages/en.json";
import swedish from "@/messages/sv.json";
import { navForRole } from "./role-nav";

const ROLES: UserRole[] = ["SCHOOL_ADMIN", "TEACHER", "STUDENT", "GUARDIAN"];
/** Where a role's pages live; the calendar feed is everyone's. */
const PREFIX: Record<UserRole, string> = {
  SCHOOL_ADMIN: "/admin",
  TEACHER: "/teacher",
  STUDENT: "/student",
  GUARDIAN: "/guardian",
};
const items = (role: UserRole) => navForRole(role).flatMap((section) => section.items);

describe("navForRole", () => {
  it("hands each role its own rows", () => {
    // No row count here: how many rows a role has is its file's to say (a
    // phase adds a row there and nothing in this test), and two branches that
    // each add one must still merge into a green main.
    for (const role of ROLES) {
      expect(items(role).length, `${role} has rows`).toBeGreaterThan(0);
      const strangers = items(role).filter((item) => !item.href.startsWith(PREFIX[role]) && item.href !== "/calendar-feed");
      expect(strangers.map((item) => item.href), `${role} rows outside ${PREFIX[role]}`).toEqual([]);
    }
  });

  it("has a name in both languages for every row and every group", () => {
    // The shell looks each key up in the nav namespace; a row whose key is
    // missing renders as the key itself, in the menu of the role that has it.
    for (const messages of [swedish, english]) {
      const nav = messages.nav as Record<string, unknown>;
      for (const role of ROLES) {
        for (const section of navForRole(role)) {
          if (section.labelKey) expect(typeof nav[section.labelKey], `${role} group ${section.labelKey}`).toBe("string");
          for (const item of section.items) expect(typeof nav[item.labelKey], `${role} row ${item.labelKey}`).toBe("string");
        }
      }
    }
  });

  it("draws every glyph as an element, one per icon within a menu", () => {
    for (const role of ROLES) expect(items(role).every((item) => isValidElement(item.icon))).toBe(true);
    // The payload names an icon once however many rows use it, so
    // CalendarRange on seven rows of the admin's menu is one element, not seven.
    for (const role of ["SCHOOL_ADMIN", "TEACHER"] as const) {
      const glyphs = items(role).map((item) => item.icon);
      expect(new Set(glyphs).size).toBeLessThan(glyphs.length);
    }
    const admin = items("SCHOOL_ADMIN");
    const feeds = admin.filter((item) => ["publishing", "calendarFeeds", "scheduleExchange"].includes(item.labelKey));
    expect(feeds).toHaveLength(3);
    expect(new Set(feeds.map((item) => item.icon)).size).toBe(1);
  });

  it("builds a menu of its own on every call", () => {
    // An element a request has rendered is not reused for the next one.
    expect(navForRole("TEACHER")[0]!.items[0]!.icon).not.toBe(navForRole("TEACHER")[0]!.items[0]!.icon);
  });
});

describe("the menus stay out of the bundle", () => {
  // `server-only` makes the build fail when a client module imports the menu
  // data, and so keeps it out of the chunk every signed-in route loads (the
  // menus were 2.9 KB gzipped of it, for all four roles on every route). It
  // only helps while it stays the file's first statement, and a menu file a
  // later phase adds (a huvudman's, say) must start with it too: so the files
  // are read from the folder, not listed here.
  const here = __dirname;
  const navFiles = readdirSync(here).filter((file) => /-nav\.tsx?$/.test(file));

  it("finds the menu files", () => {
    expect(navFiles.length).toBeGreaterThan(0);
  });

  for (const file of navFiles) {
    it(`${file} is server-only`, () => {
      expect(readFileSync(join(here, file), "utf8").startsWith('import "server-only";')).toBe(true);
    });
  }

  it("is imported by no client module", () => {
    // Every module under web/ that starts with "use client", not the two that
    // happen to hold the shell: a third (the user menu, a later widget) that
    // imported a menu would otherwise pass unseen until the build said so.
    //
    // This is a quick warning before the build, not the guard: `server-only`
    // is the guard, and the build refuses a client module that reaches a menu
    // by any road. What the scan reads is a static `import ... from` or
    // `export ... from` whose specifier ends in a menu file's name, and these
    // slip past it (the build catches each):
    //   - a dynamic `import("./admin-nav")`;
    //   - an import without names or `from`, `import "./guardian-nav"`;
    //   - an indirect one: a client module that imports a helper which
    //     re-exports a menu;
    //   - a specifier written with no space before `from` or after it.
    // And it errs the other way in one case, by name: it matches the last
    // segment of the specifier, not the file it resolves to, so a client
    // module in another folder that imports its own `./teacher-nav` is named
    // as an offender too. A type import is erased and takes nothing with it
    // (`import type`, and `import { type A }` when every name is a type), and
    // is not named.
    const menus = new Set(navFiles.map((file) => file.replace(/\.tsx?$/, "")));
    const clientModule = /^(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*["']use client["']/;
    const clientModules: string[] = [];
    const offenders: string[] = [];
    for (const file of sourceFiles(join(here, "..", ".."))) {
      const source = readFileSync(file, "utf8");
      if (!clientModule.test(source)) continue;
      clientModules.push(file);
      for (const specifier of runtimeImportsOf(source)) {
        if (menus.has(specifier.split("/").pop()!)) offenders.push(`${file} imports ${specifier}`);
      }
    }
    // The scan has to see the shell, or it proves nothing.
    expect(clientModules).toContain(join(here, "app-shell.tsx"));
    expect(clientModules).toContain(join(here, "..", "profile-context.tsx"));
    expect(offenders).toEqual([]);
  });

  it("reads the imports it claims to, and not the ones the compiler erases", () => {
    // The scan is only as good as these: a form it stopped seeing would let a
    // client module import a menu with the test green.
    const seen = (source: string) => runtimeImportsOf(source);
    expect(seen('import { ADMIN_NAV } from "./admin-nav";')).toEqual(["./admin-nav"]);
    expect(seen('import ADMIN from "./admin-nav";')).toEqual(["./admin-nav"]);
    expect(seen('import * as menus from "@/components/layout/admin-nav";')).toEqual(["@/components/layout/admin-nav"]);
    expect(seen('export { TEACHER_NAV } from "./teacher-nav";')).toEqual(["./teacher-nav"]);
    expect(seen('export * from "./teacher-nav";')).toEqual(["./teacher-nav"]);
    expect(seen('import {\n  type NavGroup,\n  navForRole,\n} from "./role-nav";')).toEqual(["./role-nav"]);
    expect(seen('import { type NavGroup, STUDENT_NAV } from "./student-nav";')).toEqual(["./student-nav"]);
    // Erased by the compiler: nothing of the menu comes with them.
    expect(seen('import type { NavGroup } from "./role-nav";')).toEqual([]);
    expect(seen('import { type NavGroup } from "./role-nav";')).toEqual([]);
    expect(seen('import { type NavGroup, type NavEntry as Entry } from "./role-nav";')).toEqual([]);
    expect(seen('export type { NavGroup } from "./role-nav";')).toEqual([]);
  });
});

/**
 * The specifiers of a module's static imports and re-exports that the compiler
 * keeps: all but `import type ...` and a clause whose every name is written
 * `type X` (the whole line is erased then). See "is imported by no client
 * module" for what it does not see.
 */
function runtimeImportsOf(source: string): string[] {
  const statement = /(?:^|\n)\s*(?:import|export)\s+(?!type\b)([^;]*?)\s+from\s+["']([^"']+)["']/g;
  const onlyTypes = /^\{(?:\s*type\s+[\w$]+(?:\s+as\s+[\w$]+)?\s*,?)+\s*\}$/;
  return [...source.matchAll(statement)].filter(([, clause]) => !onlyTypes.test(clause!.trim())).map(([, , specifier]) => specifier!);
}

/** The .ts and .tsx files under a folder of web/, without installs, builds and tests. */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".next", "coverage", "e2e", "test-results", "playwright-report"].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) found.push(path);
  }
  return found;
}

describe("every row leads somewhere", () => {
  const APP = join(__dirname, "..", "..", "app", "[locale]", "(app)");
  const rows = ROLES.flatMap((role) => items(role).map((item) => ({ role, ...item })));

  it("has a page behind every href", () => {
    // A row whose path has no page.tsx is a link to a 404, for the role that
    // has it. (Route groups, (name), add nothing to a path: a page that moves
    // into one is a path this test would name, and it is the one to adjust.)
    const missing = rows.filter((row) => !existsSync(join(APP, row.href, "page.tsx")));
    expect(missing.map((row) => `${row.role} ${row.href}`)).toEqual([]);
  });

  it("gives every admin row a gate in PAGE_GATES, or a null there on purpose", () => {
    // lib/admin-areas.ts PAGE_GATES says which administrator profile opens
    // which page, and shows a page it does not list to every administrator.
    // So an admin row added without an entry there is open to the expedition
    // and the läsare too, and only the writes are refused (by the gateway).
    // Not listed is the one thing this test refuses: a page that is meant for
    // every administrator says so with `null`, as /admin/people does. The
    // /admin root key is no entry for another page, since every admin path
    // begins with it.
    const listed = (href: string) =>
      Object.keys(PAGE_GATES).some((page) => href === page || (page !== "/admin" && href.startsWith(`${page}/`)));
    const adminRows = items("SCHOOL_ADMIN").filter((item) => item.href.startsWith("/admin"));
    expect(adminRows.length).toBeGreaterThan(0);
    expect(adminRows.filter((item) => !listed(item.href)).map((item) => item.href)).toEqual([]);
  });
});
