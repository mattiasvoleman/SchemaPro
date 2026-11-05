"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { CalendarRange, Menu, X, type LucideIcon } from "lucide-react";
import { Link, usePathname } from "@/i18n/navigation";
import { GUARDIAN_NAV, STUDENT_NAV, TEACHER_NAV } from "@/components/profile-context";
import { ADMIN_NAV } from "@/components/layout/admin-nav";
import { cn } from "@/lib/utils";
import type { UserRole } from "@/lib/types";
import { LocaleSwitcher } from "./locale-switcher";
import { ThemeToggle } from "./theme-toggle";
import { NotificationBell } from "@/components/layout/notification-bell";
import { UserMenu } from "./user-menu";
import { Button } from "@/components/ui/button";

export interface NavItem {
  labelKey: string;
  href: string;
  icon: LucideIcon;
}

export interface NavSection {
  labelKey: string | null;
  items: NavItem[];
}

/*
 * The teacher's, the guardian's and the pupil's menus are in
 * profile-context.tsx, beside the profile they are for, and the admin's in
 * admin-nav.ts. Not here: every signed-in route loads one chunk with this
 * module, AppProviders and ProfileProvider, and on main this module's part of
 * it sat just under Turbopack's minChunkSize: a few bytes of code more split
 * the chunk in two, +0.7 to 0.9 KB on every route. Moving the three menus out
 * left it some 800 B under (Kalenderprenumeration, 2026-10-16); the admin's
 * followed with Frånvarobevakning (2026-11-05), whose menu item then cost
 * this module nothing. A menu item for any role goes in those files.
 */

function navForRole(role: UserRole): NavSection[] {
  switch (role) {
    case "SCHOOL_ADMIN":
      return ADMIN_NAV;
    case "TEACHER":
      return TEACHER_NAV;
    case "STUDENT":
      return STUDENT_NAV;
    case "GUARDIAN":
      return GUARDIAN_NAV;
  }
}

interface AppShellProps {
  role: UserRole;
  userName: string;
  email: string;
  /**
   * The school's name, or for a login with several schools the switcher
   * the (app) layout renders on the server (components/layout/school-switcher.tsx):
   * a node, so that nothing of it is code in this module's chunk.
   */
  schoolName: React.ReactNode;
  children: React.ReactNode;
}

/** The drawer's focusable elements, for the Tab wrap. */
const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function AppShell({ role, userName, email, schoolName, children }: AppShellProps) {
  const t = useTranslations("nav");
  const tCommon = useTranslations("common");
  const tStatement = useTranslations("accessibilityStatement");
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const sections = navForRole(role);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const drawerWasOpen = useRef(false);

  // The drawer is a modal dialog, written by hand rather than with Radix
  // Dialog: the shell ships on every (app) route, and the shared runtime has
  // a few KB of headroom. Focus moves into it on open and back to the
  // hamburger on close, however it closed.
  useEffect(() => {
    if (mobileOpen) {
      drawerWasOpen.current = true;
      closeButtonRef.current?.focus();
    } else if (drawerWasOpen.current) {
      drawerWasOpen.current = false;
      menuButtonRef.current?.focus();
    }
  }, [mobileOpen]);

  const onDrawerKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      setMobileOpen(false);
      return;
    }
    if (event.key !== "Tab" || !drawerRef.current) return;
    // aria-modal tells assistive tech the page behind is inert; this keeps
    // the keyboard inside too, wrapping at both ends.
    const focusables = Array.from(drawerRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (focusables.length === 0) return;
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  // Rendered twice (the desktop sidebar and the drawer), so ids take a prefix.
  const sidebar = (idPrefix: string) => (
    <div className="flex h-full flex-col">
      <div className="flex h-16 items-center gap-2.5 border-b border-sidebar-border px-5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <CalendarRange className="size-4" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-foreground">
            {tCommon("appName")}
          </div>
          <div className="truncate text-xs text-muted-foreground">{schoolName}</div>
        </div>
      </div>

      <nav aria-label={t("label")} className="flex-1 space-y-6 overflow-y-auto px-3 py-4">
        {sections.map((section, index) => {
          const labelId = section.labelKey ? `${idPrefix}-${section.labelKey}` : undefined;
          return (
            <div key={index}>
              {section.labelKey ? (
                // Full muted-foreground: at /70 the label measured 2.68:1 on
                // the light sidebar, under AA for text this small.
                <div
                  id={labelId}
                  className="mb-1.5 px-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                >
                  {t(section.labelKey)}
                </div>
              ) : null}
              <ul className="space-y-0.5" aria-labelledby={labelId}>
                {section.items.map((item) => {
                  const active =
                    pathname === item.href ||
                    (item.href.split("/").length > 2 && pathname.startsWith(`${item.href}/`));
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        onClick={() => setMobileOpen(false)}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors",
                          active
                            ? "bg-sidebar-accent text-sidebar-accent-foreground"
                            : "text-sidebar-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground",
                        )}
                      >
                        <item.icon className="size-4 shrink-0" aria-hidden="true" />
                        {t(item.labelKey)}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>

      {/* The tillgänglighetsredogörelse, from every page, as Digg asks. */}
      <div className="border-t border-sidebar-border px-5 py-3">
        <Link
          href="/tillganglighet"
          onClick={() => setMobileOpen(false)}
          className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
        >
          {tStatement("link")}
        </Link>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen">
      {/* The first stop for the keyboard: past the menu, straight to the page. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:shadow focus:outline-none focus:ring-2 focus:ring-ring print:hidden"
      >
        {tCommon("skipToContent")}
      </a>

      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-sidebar-border bg-sidebar lg:block print:hidden">
        {sidebar("nav")}
      </aside>

      {/* Mobile sidebar: a modal dialog (Escape, focus in and back, Tab kept inside) */}
      {mobileOpen ? (
        <div
          ref={drawerRef}
          id="mobile-nav"
          role="dialog"
          aria-modal="true"
          aria-label={t("label")}
          className="fixed inset-0 z-40 lg:hidden"
          onKeyDown={onDrawerKeyDown}
        >
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setMobileOpen(false)}
          />
          <aside className="absolute inset-y-0 left-0 w-72 border-r border-sidebar-border bg-sidebar shadow-xl">
            <button
              ref={closeButtonRef}
              type="button"
              className="absolute right-3 top-5 rounded-md p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => setMobileOpen(false)}
              aria-label={tCommon("close")}
            >
              <X className="size-5" aria-hidden="true" />
            </button>
            {sidebar("drawer")}
          </aside>
        </div>
      ) : null}

      {/*
        min-w-0 is load-bearing.

        This column is a flex item, and a flex item defaults to
        `min-width: auto` — it refuses to shrink below its content's
        min-content width. One wide page (the timplan matrix with two dozen
        subjects) therefore stretched the whole column past the viewport, and
        everything anchored to its right edge — the academic-year picker, the
        header's user menu — sat off-screen until you scrolled sideways. With
        min-w-0 the column keeps the viewport's width and the wide content
        scrolls inside its own container instead.
      */}
      {/* print: the navigation and the header are the screen's, never the
          paper's (the uppdragsbeskrivning prints from inside main). */}
      <div className="flex min-h-screen min-w-0 flex-1 flex-col lg:pl-64 print:min-h-0 print:pl-0">
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b bg-background/80 px-4 backdrop-blur sm:px-6 print:hidden">
          <Button
            ref={menuButtonRef}
            variant="ghost"
            size="icon"
            className="lg:hidden"
            onClick={() => setMobileOpen(true)}
            aria-label={tCommon("openMenu")}
            aria-expanded={mobileOpen}
            aria-controls={mobileOpen ? "mobile-nav" : undefined}
          >
            <Menu className="size-5" aria-hidden="true" />
          </Button>
          <div className="flex-1" />
          <LocaleSwitcher />
          <ThemeToggle />
          <NotificationBell />
          <UserMenu userName={userName} email={email} role={role} />
        </header>

        {/* tabIndex -1: the skip link's target takes focus, so the next Tab
            continues inside the page rather than back at the menu. */}
        <main id="main" tabIndex={-1} className="flex-1 px-4 py-6 focus:outline-none sm:px-6 lg:px-8 print:p-0">
          {children}
        </main>
      </div>
    </div>
  );
}
