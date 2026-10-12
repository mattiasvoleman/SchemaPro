"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  BarChart3,
  CalendarClock,
  CalendarDays,
  CalendarOff,
  CalendarRange,
  CalendarSearch,
  ClipboardCheck,
  Grid3x3,
  LayoutDashboard,
  Menu,
  MapPin,
  BookOpen,
  Users,
  UserCheck,
  UserX,
  SlidersHorizontal,
  Coffee,
  UtensilsCrossed,
  Sparkles,
  GraduationCap,
  Scale,
  Target,
  X,
  type LucideIcon,
  KeyRound,
} from "lucide-react";
import { Link, usePathname } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import type { UserRole } from "@/lib/types";
import { LocaleSwitcher } from "./locale-switcher";
import { ThemeToggle } from "./theme-toggle";
import { NotificationBell } from "@/components/layout/notification-bell";
import { UserMenu } from "./user-menu";
import { Button } from "@/components/ui/button";

interface NavItem {
  labelKey: string;
  href: string;
  icon: LucideIcon;
}

interface NavSection {
  labelKey: string | null;
  items: NavItem[];
}

/*
 * The admin menu follows the manual's four phases, one group each, in the
 * order a school works through them (regrouped 2026-10-11):
 *
 *   Grunddata       Fas 1 — what everything else rests on, once per läsår
 *   Planering       Fas 2 — the timplan and every rule the engine reads
 *   Schemaläggning  Fas 3 — generate, refine, publish
 *   Drift           Fas 4 — the dated days once the year runs
 *
 * and Integrationer last and unlabelled, as the manual's chapter 7: it is set
 * up once and serves every phase. Dataskydd och gallring, set up once too,
 * stands beside it.
 *
 * Several entries share an icon with another entry on purpose. The shell is
 * on every (app) route's bill, so an icon of its own would cost every page
 * bytes for a glyph; each shared one says which entry it borrows from.
 */
const ADMIN_NAV: NavSection[] = [
  {
    labelKey: null,
    items: [{ labelKey: "dashboard", href: "/admin", icon: LayoutDashboard }],
  },
  {
    labelKey: "basics",
    items: [
      { labelKey: "setup", href: "/admin/setup", icon: GraduationCap },
      // Directly after Kom igång, which creates a school's first läsår: this
      // is where every later one comes from (Rulla vidare) and becomes the
      // current one (Aktivera). Kom igång's own icon, already in the shell.
      { labelKey: "years", href: "/admin/years", icon: GraduationCap },
      { labelKey: "subjects", href: "/admin/subjects", icon: BookOpen },
      { labelKey: "rooms", href: "/admin/rooms", icon: MapPin },
      { labelKey: "groups", href: "/admin/groups", icon: Users },
      { labelKey: "people", href: "/admin/people", icon: UserCheck },
    ],
  },
  {
    labelKey: "planning",
    items: [
      // The school's own timplan — the target, in minutes per week and
      // årskurs, held against the national hours per stadium. First, because
      // it is what the timplansposter are written to meet.
      { labelKey: "timplan", href: "/admin/timplan", icon: Target },
      // Called "Timplan" until the lokal timplan took the name (2026-10-06);
      // the route kept its path so every bookmark still lands here. The
      // one-release "Hette tidigare Timplan" line under it went with P2.
      { labelKey: "requirements", href: "/admin/requirements", icon: Grid3x3 },
      // Directly after the timplansposter, because it is the same posts read
      // from the other side: that page says what each GROUP needs, this one
      // says what each TEACHER carries of it and against which post. Every
      // leader settles this before it timetables, so it sits in Planering and
      // not under Schemaläggning.
      { labelKey: "staffing", href: "/admin/staffing", icon: Scale },
      { labelKey: "constraints", href: "/admin/constraints", icon: SlidersHorizontal },
      // Next to tillgänglighet, which is the other list of "not then": that
      // one says when a room or a teacher cannot be used, this one says when
      // the school is not teaching at all. It sits under Planering rather than
      // Drift because the timplan's hours are measured against it before a
      // single lesson exists.
      { labelKey: "breaks", href: "/admin/breaks", icon: CalendarOff },
      // The positive half of tillgänglighet's question: the hours a whole
      // stage may be taught in at all. The publishing icon's twin, already in
      // the shell.
      { labelKey: "frameTimes", href: "/admin/frame-times", icon: CalendarRange },
      { labelKey: "rasts", href: "/admin/rasts", icon: Coffee },
      // After the ramtider and the raster, because it is read with them: a
      // stage's day, its pauses and the meal in the middle of it. The lunch
      // card itself stays on tillgänglighet — the hall's size and the break's
      // length, one row for the school, where this is the flow through the day.
      { labelKey: "lunchServings", href: "/admin/lunch-servings", icon: UtensilsCrossed },
    ],
  },
  {
    labelKey: "scheduling",
    items: [
      { labelKey: "generate", href: "/admin/generate", icon: Sparkles },
      { labelKey: "timetable", href: "/admin/timetable", icon: CalendarDays },
      // Next to the grid it is used against: finslipning starts once a base
      // schedule exists, and every answer there is read off this one.
      { labelKey: "gaps", href: "/admin/gaps", icon: CalendarSearch },
      // Last in the phase, as in the manual: a schedule is published once it
      // is refined. The mode (direct or utkast), which published timetable is
      // valid when, the checks, and Schemavisaren. The ramtider's icon — a
      // validity range is a range of dates too.
      { labelKey: "publishing", href: "/admin/publishing", icon: CalendarRange },
    ],
  },
  {
    labelKey: "operations",
    items: [
      { labelKey: "dayPlanner", href: "/admin/lessons", icon: CalendarClock },
      { labelKey: "teacherAbsence", href: "/admin/teacher-absence", icon: UserX },
      // Beside the absence register whose lessons it covers. The day
      // planner's clock icon: a page about the same dated lessons.
      { labelKey: "coverBoard", href: "/admin/cover", icon: CalendarClock },
      // After the cover board: both act on the dated calendar, a lesson at a
      // time there, a day or a week of a year group here (prao, friluftsdag),
      // and a morning starts with cover, not with planning a cancellation.
      // The lov's icon — the nearest thing to it.
      { labelKey: "cancellations", href: "/admin/cancellations", icon: CalendarOff },
      { labelKey: "leaveRequests", href: "/admin/leave", icon: ClipboardCheck },
      { labelKey: "roomBookings", href: "/admin/room-bookings", icon: MapPin },
      { labelKey: "reports", href: "/admin/reports", icon: BarChart3 },
    ],
  },
  {
    labelKey: null,
    items: [
      // Dataskydd och gallring: how long each kind of data is kept. Like
      // Integrationer it is set up once and serves every phase, so it sits
      // with it, before it, and Integrationer stays last. Integrationer's key,
      // already in the shell: both pages decide who and what reaches the
      // school's data.
      { labelKey: "dataProtection", href: "/admin/dataskydd", icon: KeyRound },
      { labelKey: "integrations", href: "/admin/integrations", icon: KeyRound },
    ],
  },
];

const TEACHER_NAV: NavSection[] = [
  {
    labelKey: null,
    items: [
      { labelKey: "mySchedule", href: "/teacher", icon: CalendarDays },
      { labelKey: "attendance", href: "/teacher/attendance", icon: ClipboardCheck },
      { labelKey: "roomBooking", href: "/teacher/rooms", icon: MapPin },
      // The teacher's own tjänst, read-only. The admin's Tjänstefördelning
      // icon, already in this module: the same thing seen from the other side,
      // and a second glyph would be bytes on every route for nothing.
      { labelKey: "myStaffing", href: "/teacher/tjanst", icon: Scale },
      // Mina vikariepass and Min frånvaro: the admin's Lärarfrånvaro icon,
      // the same subject from the teacher's side.
      { labelKey: "myCover", href: "/teacher/franvaro", icon: UserX },
    ],

  },
];

const GUARDIAN_NAV: NavSection[] = [
  {
    labelKey: null,
    items: [
      { labelKey: "myChildren", href: "/guardian", icon: Users },
    ],
  },
];

const STUDENT_NAV: NavSection[] = [
  {
    labelKey: null,
    items: [
      { labelKey: "mySchedule", href: "/student", icon: CalendarDays },
      { labelKey: "myAttendance", href: "/student/attendance", icon: ClipboardCheck },
    ],
  },
];

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
  schoolName: string;
  children: React.ReactNode;
}

/** The drawer's focusable elements, for the Tab wrap. */
const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function AppShell({ role, userName, email, schoolName, children }: AppShellProps) {
  const t = useTranslations("nav");
  const tCommon = useTranslations("common");
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
