import "server-only";
import { CalendarDays, CalendarRange, ClipboardCheck } from "lucide-react";
import type { NavGroup } from "./role-nav";

/* The pupil's menu (see role-nav.tsx for how it reaches the shell). */
export const STUDENT_NAV: NavGroup[] = [
  {
    labelKey: null,
    items: [
      { labelKey: "mySchedule", href: "/student", icon: CalendarDays },
      { labelKey: "myAttendance", href: "/student/attendance", icon: ClipboardCheck },
      { labelKey: "calendarFeed", href: "/calendar-feed", icon: CalendarRange },
    ],
  },
];
