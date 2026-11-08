import "server-only";
import { BarChart3, BookOpen, CalendarDays, CalendarRange, ClipboardCheck, MapPin, Scale, UserX } from "lucide-react";
import type { NavGroup } from "./role-nav";

/* The teacher's menu (see role-nav.tsx for how it reaches the shell). */
export const TEACHER_NAV: NavGroup[] = [
  {
    labelKey: null,
    items: [
      { labelKey: "mySchedule", href: "/teacher", icon: CalendarDays },
      // Klasslärarens schema (G5): the class's week and template, changed inside what the
      // schemaläggare has opened. Always in the menu, as Frånvarobevakning is: a teacher who is
      // nobody's klasslärare gets the page's own explanation. The week's icon.
      { labelKey: "classSchedule", href: "/teacher/klass-schema", icon: CalendarDays },
      // Larm (Krisläge): the pupils of the teacher's groups to tick off when
      // the school starts an alarm. Second, so that it is in reach on a phone
      // without scrolling the menu. The attendance icon.
      { labelKey: "myCrisis", href: "/teacher/crisis", icon: ClipboardCheck },
      { labelKey: "attendance", href: "/teacher/attendance", icon: ClipboardCheck },
      // Lektionslogg: a class's lessons over a period with their topic and
      // homework. The admin menu's subjects icon.
      { labelKey: "classBook", href: "/teacher/klassbok", icon: BookOpen },
      { labelKey: "roomBooking", href: "/teacher/rooms", icon: MapPin },
      // Skolans dag: the school's day and week, in the form the school has
      // decided teachers get (the page says so when it has decided none). The
      // week's icon.
      { labelKey: "schoolDay", href: "/teacher/school-day", icon: CalendarDays },
      // The teacher's own tjänst, read-only. The admin's Tjänstefördelning
      // icon: the same thing seen from the other side.
      { labelKey: "myStaffing", href: "/teacher/tjanst", icon: Scale },
      // Mina vikariepass and Min frånvaro: the admin's Lärarfrånvaro icon,
      // the same subject from the teacher's side.
      { labelKey: "myCover", href: "/teacher/franvaro", icon: UserX },
      // Ledighet: the requests the teacher decides as a pupil's mentor
      // (20261023091000). The admin's Ledighetsansökningar icon: the same
      // inbox from the mentor's side.
      { labelKey: "myLeave", href: "/teacher/ledighet", icon: ClipboardCheck },
      // Frånvarobevakning: the mentor's pupils over a limit. Always in the
      // menu: a teacher who mentors nobody gets an empty list, said kindly.
      // The admin's Rapporter icon.
      { labelKey: "absenceWatch", href: "/teacher/absence-watch", icon: BarChart3 },
      // Rapporteringsgrad: the lessons whose register is not saved, and the
      // teacher's own share. The attendance icon.
      { labelKey: "myReporting", href: "/teacher/reporting-rate", icon: ClipboardCheck },
      // Kvittens: ask the guardians of the teacher's mentees to confirm a message. Always in
      // the menu: the page says so when the school has not turned it on. The attendance icon.
      { labelKey: "acknowledgements", href: "/teacher/acknowledgements", icon: ClipboardCheck },
      { labelKey: "calendarFeed", href: "/calendar-feed", icon: CalendarRange },
    ],
  },
];
