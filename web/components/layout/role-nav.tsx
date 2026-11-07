import "server-only";
import type { LucideIcon } from "lucide-react";
import type { NavSection } from "@/components/layout/app-shell";
import type { UserRole } from "@/lib/types";
import { ADMIN_NAV } from "./admin-nav";
import { GUARDIAN_NAV } from "./guardian-nav";
import { STUDENT_NAV } from "./student-nav";
import { TEACHER_NAV } from "./teacher-nav";

/*
 * The menu of each role, picked by the (app) layout on the server and handed to
 * AppShell as a prop. No client module imports it (server-only says so at build
 * time). The four menus used to be code in the chunk every signed-in route
 * loads: the label keys, the paths and every glyph of every role, whichever
 * role the page was for. That was 2.9 KB gzipped on each route (measured when
 * it moved out: /admin/requirements 194 566 -> 191 694 B), with
 * /admin/requirements at 45 B from its 190 KB and a menu row costing about 19 B.
 *
 * A menu is data on the wire now (the layout's RSC payload, once per full page
 * load: the admin's 2.8 KB gzipped, the others' 0.6 to 1.2 KB) and not code in
 * the bundle. A row can have an icon of its own at no cost to any route.
 */

/** A row as the role's file writes it: the glyph is the component. */
export interface NavEntry {
  labelKey: string;
  href: string;
  icon: LucideIcon;
}

export interface NavGroup {
  labelKey: string | null;
  items: NavEntry[];
}

const MENUS: Record<UserRole, NavGroup[]> = {
  SCHOOL_ADMIN: ADMIN_NAV,
  TEACHER: TEACHER_NAV,
  STUDENT: STUDENT_NAV,
  GUARDIAN: GUARDIAN_NAV,
};

/**
 * The role's menu with each glyph as the element AppShell puts in the row. One
 * element per icon, so that the payload names an icon once however many rows
 * share it (React's server renderer writes an object it has already written as
 * a reference). Built per call and never kept: an element a request has
 * rendered is not for the next one.
 */
export function navForRole(role: UserRole): NavSection[] {
  const glyphs = new Map<LucideIcon, React.ReactElement>();
  const glyph = (Icon: LucideIcon) => {
    let element = glyphs.get(Icon);
    if (!element) {
      element = <Icon className="size-4 shrink-0" aria-hidden="true" />;
      glyphs.set(Icon, element);
    }
    return element;
  };
  return MENUS[role].map((group) => ({
    labelKey: group.labelKey,
    items: group.items.map((item) => ({ labelKey: item.labelKey, href: item.href, icon: glyph(item.icon) })),
  }));
}
