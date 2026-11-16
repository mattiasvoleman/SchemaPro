import "server-only";
import type { LucideIcon } from "lucide-react";
import type { NavItem, NavSection } from "@/components/layout/app-shell";
import type { UserRole } from "@/lib/types";
import { ADMIN_NAV } from "./admin-nav";
import { GUARDIAN_NAV } from "./guardian-nav";
import { STUDENT_NAV } from "./student-nav";
import { TEACHER_NAV } from "./teacher-nav";
import { TEACHING_ADMIN_NAV } from "./teaching-admin-nav";

/*
 * The menu of each role, picked by the (app) layout on the server and handed to
 * AppShell as a prop. No client module imports it (server-only says so at build
 * time). The four menus used to be code in the chunk every signed-in route
 * loads: the label keys, the paths and every glyph of every role, whichever
 * role the page was for. That was 2.9 KB gzipped on each route (measured when
 * it moved out: /admin/requirements 194 566 -> 191 694 B), with
 * /admin/requirements at 45 B from its 190 KB and a menu row costing about 19 B.
 *
 * Nothing of a menu is in the JavaScript bundle now, and that is all the
 * bundle gate (scripts/bench/bundle-size.mjs) measures. It is payload in every
 * full page load instead: the layout's HTML and RSC carry the menu once, the
 * admin's about 2.9 KB gzipped and the others' 0.5 to 1.2 KB, and unlike the
 * cached bundle the document is fetched again on each full load. A row with an
 * icon of its own costs no route a byte of JS, but its label and path (and a
 * new icon's drawing, a few hundred bytes) are in that document. The gate for
 * it is e2e/document-size.spec.ts: the gzipped document of each of the four
 * roles, less the message catalog, against a ceiling 1.5 KB above what was
 * last measured, with an annotation on the run once half of that is used. A
 * row that borrows an icon costs about 40 B there for the row itself (a phase
 * that added one has paid 90 to 190 B with its text) and one that brings its
 * own 140 to 300 B, so a phase's one or two rows are inside the ceiling and
 * show as the room left in the log, not as a failure; the phase that crosses
 * it sets `measured` and says what raised it.
 *
 * Which rows a role has is decided here, by role and one mark (navForRole
 * takes the role and whether an administrator teaches). A row that depends on
 * more, the school's switches or the administrator's profile, is not a row of
 * these files: the (app) layout decides it, as it does for the pages a profile
 * may not open (closedMenuStyle hides those links with a style rule it writes
 * on the server), or navForRole takes a larger argument first. The mark was
 * the first such argument: an administrator who teaches (Users.teaches) has the
 * group "Min undervisning" (teaching-admin-nav.ts), made here as the menu's
 * second group and nowhere in the shell, whose chunk has no room for it. An
 * administrator without the mark is handed the menu byte for byte as before.
 */

/**
 * A row as the role's file writes it: AppShell's NavItem, with the glyph as
 * the component and not yet the element. Derived from NavItem so that a field
 * added there is a field of every row, and navForRole carries it to the shell.
 */
export type NavEntry = Omit<NavItem, "icon"> & { icon: LucideIcon };

export type NavGroup = Omit<NavSection, "items"> & { items: NavEntry[] };

const MENUS: Record<UserRole, NavGroup[]> = {
  SCHOOL_ADMIN: ADMIN_NAV,
  TEACHER: TEACHER_NAV,
  STUDENT: STUDENT_NAV,
  GUARDIAN: GUARDIAN_NAV,
};

/**
 * The administrator's menu with "Min undervisning" as its second group, after
 * the unlabelled one with Översikt and Kalenderprenumeration: in reach on a
 * phone without scrolling the menu, as the teacher's menu puts Larm.
 */
function withTeaching(menu: NavGroup[]): NavGroup[] {
  return [...menu.slice(0, 1), TEACHING_ADMIN_NAV, ...menu.slice(1)];
}

/**
 * The role's menu with each glyph as the element AppShell puts in the row. One
 * element per icon, so that the payload names an icon once however many rows
 * share it (React's server renderer writes an object it has already written as
 * a reference). Built per call and never kept: an element a request has
 * rendered is not for the next one.
 *
 * `teaches` is the mark on an administrator (Users.teaches, read strictly as
 * `profile.teaches === true` by the caller); it adds a group to an
 * administrator's menu and means nothing for any other role.
 */
export function navForRole(role: UserRole, teaches = false): NavSection[] {
  const glyphs = new Map<LucideIcon, React.ReactElement>();
  const glyph = (Icon: LucideIcon) => {
    let element = glyphs.get(Icon);
    if (!element) {
      element = <Icon className="size-4 shrink-0" aria-hidden="true" />;
      glyphs.set(Icon, element);
    }
    return element;
  };
  // Spread, so that a field a row has beyond the glyph goes to the shell with
  // it and is not dropped here unseen.
  const menu = role === "SCHOOL_ADMIN" && teaches ? withTeaching(MENUS[role]) : MENUS[role];
  return menu.map(({ items, ...group }) => ({
    ...group,
    items: items.map(({ icon, ...entry }) => ({ ...entry, icon: glyph(icon) })),
  }));
}
