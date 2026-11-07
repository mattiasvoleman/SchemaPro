import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isValidElement } from "react";
import { describe, expect, it } from "vitest";
import type { UserRole } from "@/lib/types";
import english from "@/messages/en.json";
import swedish from "@/messages/sv.json";
import { navForRole } from "./role-nav";

const ROLES: UserRole[] = ["SCHOOL_ADMIN", "TEACHER", "STUDENT", "GUARDIAN"];
const items = (role: UserRole) => navForRole(role).flatMap((section) => section.items);

describe("navForRole", () => {
  it("hands each role its own rows", () => {
    expect(ROLES.map((role) => items(role).length)).toEqual([40, 13, 3, 4]);
    expect(items("SCHOOL_ADMIN").every((item) => item.href.startsWith("/admin") || item.href === "/calendar-feed")).toBe(true);
    expect(items("TEACHER").every((item) => item.href.startsWith("/teacher") || item.href === "/calendar-feed")).toBe(true);
    expect(items("GUARDIAN").every((item) => item.href.startsWith("/guardian") || item.href === "/calendar-feed")).toBe(true);
    expect(items("STUDENT").every((item) => item.href.startsWith("/student") || item.href === "/calendar-feed")).toBe(true);
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
  // only helps while it stays the file's first statement.
  const here = __dirname;
  for (const file of ["role-nav.tsx", "admin-nav.ts", "teacher-nav.ts", "guardian-nav.ts", "student-nav.ts"]) {
    it(`${file} is server-only`, () => {
      expect(readFileSync(join(here, file), "utf8").startsWith('import "server-only";')).toBe(true);
    });
  }

  it("is imported by no client module", () => {
    for (const file of [join(here, "app-shell.tsx"), join(here, "..", "profile-context.tsx")]) {
      const source = readFileSync(file, "utf8");
      expect(source.startsWith('"use client";')).toBe(true);
      expect(source).not.toMatch(/from "[^"]*-nav"/);
      expect(source).not.toMatch(/from "[^"]*role-nav"/);
    }
  });
});
