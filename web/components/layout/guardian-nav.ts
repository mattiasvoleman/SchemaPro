import "server-only";
import { BarChart3, CalendarRange, ClipboardCheck, Users } from "lucide-react";
import type { NavGroup } from "./role-nav";

/* The guardian's menu (see role-nav.tsx for how it reaches the shell). */
export const GUARDIAN_NAV: NavGroup[] = [
  {
    labelKey: null,
    items: [
      { labelKey: "myChildren", href: "/guardian", icon: Users },
      // Frånvarobevakning: the children over a limit the school set for
      // guardians. Always in the menu; the list is empty when nothing applies.
      { labelKey: "absenceWatch", href: "/guardian/absence-watch", icon: BarChart3 },
      // Kvittens: the messages the school asks the guardian to confirm. Always in the menu;
      // the list is empty when nothing has been asked. The attendance icon.
      { labelKey: "acknowledgements", href: "/guardian/acknowledgements", icon: ClipboardCheck },
      { labelKey: "calendarFeed", href: "/calendar-feed", icon: CalendarRange },
    ],
  },
];
