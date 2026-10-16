"use client";

import { createContext, useContext } from "react";
import { CalendarDays, CalendarRange, ClipboardCheck, MapPin, Scale, Users, UserX } from "lucide-react";
import { usePathname } from "@/i18n/navigation";
import type { NavSection } from "@/components/layout/app-shell";
import type { Profile, School } from "@/lib/types";

interface ProfileContextValue {
  profile: Profile;
  school: School | null;
}

const ProfileContext = createContext<ProfileContextValue | null>(null);

/**
 * Roller i skolan: the admin pages a profile does not use, each with the
 * page shown in its place. A style rule the layout writes
 * (components/admin/area-refusal.tsx closedMenuStyle) leaves them out of
 * the menu, and a request for one anyway (a bookmark, a link from
 * elsewhere) gets from ClosedPageGate below a page that says which area it
 * belongs to and leads back to the overview, instead of a page whose every
 * button would answer 403. Nothing is refused here; the gateway and the
 * database refuse the writes.
 *
 * Built by the (app) layout on the server (components/admin/area-refusal.tsx
 * closedPagesFor), so the client only picks one and no route carries the
 * page's code. It lives in the profile context and not in AppShell: the
 * part of the chunk every signed-in route loads that holds AppShell sits at
 * Turbopack's merge threshold (minChunkSize), and any code added there split
 * the chunk in two, at +0.7 KB on every route.
 */
export type ClosedPages = Readonly<Record<string, React.ReactNode>>;

const ClosedContext = createContext<ClosedPages>({});

export function ProfileProvider({
  profile,
  school,
  closed = {},
  children,
}: ProfileContextValue & { closed?: ClosedPages; children: React.ReactNode }) {
  return (
    <ProfileContext.Provider value={{ profile, school }}>
      <ClosedContext.Provider value={closed}>{children}</ClosedContext.Provider>
    </ProfileContext.Provider>
  );
}

export function useProfile(): ProfileContextValue {
  const value = useContext(ProfileContext);
  if (!value) {
    throw new Error("useProfile must be used inside ProfileProvider.");
  }
  return value;
}

/** The page, or in place of a closed one the page that says why. */
export function ClosedPageGate({ children }: { children: React.ReactNode }) {
  const closed = useContext(ClosedContext);
  const pathname = usePathname();
  const path = Object.keys(closed).find((page) => pathname === page || pathname.startsWith(`${page}/`));
  return path ? closed[path] : children;
}

/*
 * The menus of the roles that are not the admin, which AppShell renders. They
 * are here and not in app-shell.tsx for the bundle: that module's part of the
 * signed-in routes' shared chunk sits at Turbopack's minChunkSize, and this
 * module's part, which pages share, can grow (app-shell.tsx says more). The
 * icons are the admin menu's, already in that chunk.
 */
export const TEACHER_NAV: NavSection[] = [
  {
    labelKey: null,
    items: [
      { labelKey: "mySchedule", href: "/teacher", icon: CalendarDays },
      { labelKey: "attendance", href: "/teacher/attendance", icon: ClipboardCheck },
      { labelKey: "roomBooking", href: "/teacher/rooms", icon: MapPin },
      // The teacher's own tjänst, read-only. The admin's Tjänstefördelning
      // icon, already in the shell: the same thing seen from the other side,
      // and a second glyph would be bytes on every route for nothing.
      { labelKey: "myStaffing", href: "/teacher/tjanst", icon: Scale },
      // Mina vikariepass and Min frånvaro: the admin's Lärarfrånvaro icon,
      // the same subject from the teacher's side.
      { labelKey: "myCover", href: "/teacher/franvaro", icon: UserX },
      // Ledighet: the requests the teacher decides as a pupil's mentor
      // (20261023091000). The admin's Ledighetsansökningar icon, already in
      // the shell: the same inbox from the mentor's side.
      { labelKey: "myLeave", href: "/teacher/ledighet", icon: ClipboardCheck },
      { labelKey: "calendarFeed", href: "/calendar-feed", icon: CalendarRange },
    ],

  },
];

export const GUARDIAN_NAV: NavSection[] = [
  {
    labelKey: null,
    items: [
      { labelKey: "myChildren", href: "/guardian", icon: Users },
      { labelKey: "calendarFeed", href: "/calendar-feed", icon: CalendarRange },
    ],
  },
];

export const STUDENT_NAV: NavSection[] = [
  {
    labelKey: null,
    items: [
      { labelKey: "mySchedule", href: "/student", icon: CalendarDays },
      { labelKey: "myAttendance", href: "/student/attendance", icon: ClipboardCheck },
      { labelKey: "calendarFeed", href: "/calendar-feed", icon: CalendarRange },
    ],
  },
];
