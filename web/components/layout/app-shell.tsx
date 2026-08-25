"use client";

import { useState } from "react";
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
  Sparkles,
  GraduationCap,
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

const ADMIN_NAV: NavSection[] = [
  {
    labelKey: null,
    items: [{ labelKey: "dashboard", href: "/admin", icon: LayoutDashboard }],
  },
  {
    labelKey: "planning",
    items: [
      { labelKey: "setup", href: "/admin/setup", icon: GraduationCap },
      { labelKey: "subjects", href: "/admin/subjects", icon: BookOpen },
      { labelKey: "rooms", href: "/admin/rooms", icon: MapPin },
      { labelKey: "groups", href: "/admin/groups", icon: Users },
      { labelKey: "people", href: "/admin/people", icon: UserCheck },
      { labelKey: "requirements", href: "/admin/requirements", icon: Grid3x3 },
      { labelKey: "constraints", href: "/admin/constraints", icon: SlidersHorizontal },
      // Next to tillgänglighet, which is the other list of "not then": that one
      // says when a room or a teacher cannot be used, this one says when the
      // school is not teaching at all. It sits under Planering rather than
      // Drift because the timplan's hours are measured against it before a
      // single lesson exists.
      { labelKey: "breaks", href: "/admin/breaks", icon: CalendarOff },
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
    ],
  },
  {
    labelKey: "operations",
    items: [
      { labelKey: "dayPlanner", href: "/admin/lessons", icon: CalendarClock },
      { labelKey: "teacherAbsence", href: "/admin/teacher-absence", icon: UserX },
      { labelKey: "roomBookings", href: "/admin/room-bookings", icon: MapPin },
      { labelKey: "leaveRequests", href: "/admin/leave", icon: ClipboardCheck },
      { labelKey: "reports", href: "/admin/reports", icon: BarChart3 },
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

export function AppShell({ role, userName, email, schoolName, children }: AppShellProps) {
  const t = useTranslations("nav");
  const tCommon = useTranslations("common");
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const sections = navForRole(role);

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex h-16 items-center gap-2.5 border-b border-sidebar-border px-5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <CalendarRange className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-foreground">
            {tCommon("appName")}
          </div>
          <div className="truncate text-xs text-muted-foreground">{schoolName}</div>
        </div>
      </div>

      <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-4">
        {sections.map((section, index) => (
          <div key={index}>
            {section.labelKey ? (
              <div className="mb-1.5 px-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
                {t(section.labelKey)}
              </div>
            ) : null}
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                const active =
                  pathname === item.href ||
                  (item.href.split("/").length > 2 && pathname.startsWith(`${item.href}/`));
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={() => setMobileOpen(false)}
                      className={cn(
                        "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors",
                        active
                          ? "bg-sidebar-accent text-sidebar-accent-foreground"
                          : "text-sidebar-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground",
                      )}
                    >
                      <item.icon className="h-4 w-4 shrink-0" />
                      {t(item.labelKey)}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </div>
  );

  return (
    <div className="flex min-h-screen">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-sidebar-border bg-sidebar lg:block">
        {sidebar}
      </aside>

      {/* Mobile sidebar */}
      {mobileOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setMobileOpen(false)}
          />
          <aside className="absolute inset-y-0 left-0 w-72 border-r border-sidebar-border bg-sidebar shadow-xl">
            <button
              className="absolute right-3 top-5 rounded-md p-1 text-muted-foreground hover:text-foreground"
              onClick={() => setMobileOpen(false)}
              aria-label={tCommon("close")}
            >
              <X className="h-5 w-5" />
            </button>
            {sidebar}
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
      <div className="flex min-h-screen min-w-0 flex-1 flex-col lg:pl-64">
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b bg-background/80 px-4 backdrop-blur sm:px-6">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            onClick={() => setMobileOpen(true)}
            aria-label={tCommon("openMenu")}
          >
            <Menu className="h-5 w-5" />
          </Button>
          <div className="flex-1" />
          <LocaleSwitcher />
          <ThemeToggle />
          <NotificationBell />
          <UserMenu userName={userName} email={email} role={role} />
        </header>

        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
