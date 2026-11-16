import "server-only";
import type { NavEntry, NavGroup } from "./role-nav";
import { TEACHER_NAV } from "./teacher-nav";

/*
 * "Min undervisning": the group an administrator who also teaches
 * (Users.teaches) has in her menu, beside the administrator's own (see
 * role-nav.tsx for how it reaches the shell, and for why it is server data
 * and not a line of AppShell).
 *
 * It is made from the teacher's menu and not written out again, so that a row
 * of the teacher's whose path or glyph changes changes here with it, and a row
 * the teacher's menu loses is a row this group fails a test for
 * (role-nav.test.tsx lists the seven) and not one that goes missing unseen.
 *
 * The seven are the pages the teacher's own rights opened for her
 * (Administratör som lärare, part 2 to 4): her schedule, the alarm's roll call,
 * the register, her tjänst, her absence, the leave she decides as a mentor and
 * her reporting rate. Each shows her own rows: the view narrows, the rights
 * stay the administrator's. What stays out, and why:
 *   - Klasslärarens schema: the class teacher (CT400) is a teacher's post, and
 *     the database refuses an administrator it.
 *   - The mentor's other pages (Frånvarobevakning, Kvittens, Checklistor): the
 *     gateway gives an administrator the administrator's whole list and nothing
 *     in it names the mentor, so a narrow view would be a gateway change. The
 *     administrator's own pages show the same data.
 *   - Klassbok, Skolans dag, Boka lokal, Boka resurs: the administrator's menu
 *     has the same pages, or better ones.
 *   - Vikariepass (the second half of the teacher's "Vikariepass och
 *     frånvaro"): the pool and being asked to cover are a teacher's alone
 *     (SP409), so her row is named for the absence only.
 * Kalenderprenumeration is in the administrator's first group already.
 */

/** The teacher's rows this group takes, in the teacher's menu's order. */
export const TEACHING_ADMIN_ROWS = [
  "mySchedule",
  "myCrisis",
  "attendance",
  "myStaffing",
  "myCover",
  "myLeave",
  "myReporting",
] as const;

/**
 * The same page under a name that is true for her: "Vikariepass och frånvaro"
 * names the cover shifts she is never asked to take.
 */
const RENAMED: Partial<Record<(typeof TEACHING_ADMIN_ROWS)[number], string>> = {
  myCover: "myAbsence",
};

const teachersRows = TEACHER_NAV.flatMap((group) => group.items);

export const TEACHING_ADMIN_NAV: NavGroup = {
  labelKey: "myTeaching",
  items: TEACHING_ADMIN_ROWS.flatMap((key): NavEntry[] => {
    const row = teachersRows.find((candidate) => candidate.labelKey === key);
    return row ? [{ ...row, labelKey: RENAMED[key] ?? key }] : [];
  }),
};
