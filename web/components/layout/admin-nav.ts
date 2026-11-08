import "server-only";
import {
  BarChart3,
  BookOpen,
  CalendarClock,
  CalendarDays,
  CalendarOff,
  CalendarRange,
  CalendarSearch,
  ClipboardCheck,
  Coffee,
  GraduationCap,
  Grid3x3,
  KeyRound,
  LayoutDashboard,
  MapPin,
  Scale,
  SlidersHorizontal,
  Sparkles,
  Target,
  UserCheck,
  Users,
  UserX,
  UtensilsCrossed,
} from "lucide-react";
import type { NavGroup } from "./role-nav";

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
 * Several entries share an icon with another entry. They did so for the
 * bundle, while the menu was code in the chunk every (app) route loads and a
 * glyph of its own cost every page bytes; it is data from the server now
 * (role-nav.tsx), and a new entry may have the icon that says it best. The
 * shared ones stay as they are: a menu that changes its pictures is a change
 * for the people who know it by them.
 */
export const ADMIN_NAV: NavGroup[] = [
  {
    labelKey: null,
    items: [
      { labelKey: "dashboard", href: "/admin", icon: LayoutDashboard },
      // The admin's own feed, which every profile may make (the school's
      // switches are Kalenderprenumeration under Schemaläggning, Publicering's).
      { labelKey: "calendarFeed", href: "/calendar-feed", icon: CalendarRange },
    ],
  },
  {
    labelKey: "basics",
    items: [
      { labelKey: "setup", href: "/admin/setup", icon: GraduationCap },
      // Directly after Kom igång, which creates a school's first läsår: this
      // is where every later one comes from (Rulla vidare) and becomes the
      // current one (Aktivera). Kom igång's own icon.
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
      // stage may be taught in at all. The publishing icon's twin.
      { labelKey: "frameTimes", href: "/admin/frame-times", icon: CalendarRange },
      { labelKey: "rasts", href: "/admin/rasts", icon: Coffee },
      { labelKey: "supervision", href: "/admin/supervision", icon: Coffee },
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
      // Klasslärarens schema (G5): who is klasslärare of which class, the hours open to them and the
      // drafts that wait. Beside the grid whose lessons they change. The groups' icon (Personer).
      { labelKey: "classTeachers", href: "/admin/class-teachers", icon: Users },
      // Next to the grid it is used against: finslipning starts once a base
      // schedule exists, and every answer there is read off this one.
      { labelKey: "gaps", href: "/admin/gaps", icon: CalendarSearch },
      // Last in the phase, as in the manual: a schedule is published once it
      // is refined. The mode (direct or utkast), which published timetable is
      // valid when, and the checks. The ramtider's icon — a validity range is a
      // range of dates too.
      { labelKey: "publishing", href: "/admin/publishing", icon: CalendarRange },
      // Right after what it shows: the published timetable outside Rastra, to whom and with which
      // codes. Publicering's icon again.
      { labelKey: "schemavisaren", href: "/admin/schemavisaren", icon: CalendarRange },
      // Kalenderprenumeration, per audience: Publicering's icon.
      { labelKey: "calendarFeeds", href: "/admin/calendar-feeds", icon: CalendarRange },
      // Schema som fil: the grundschema as a table or an Untis or aSc file, and back in as locked
      // lessons. Last in the phase, after the feeds it is a sibling of; Publicering's icon.
      { labelKey: "scheduleExchange", href: "/admin/schedule-exchange", icon: CalendarRange },
    ],
  },
  {
    labelKey: "operations",
    items: [
      // Krisläge: the roll call of an utrymning or inrymning, first in the phase
      // because it is the page nobody should have to look for. The attendance
      // icon (Ledighetsansökningar): the same act of ticking pupils off, in a
      // different hour.
      { labelKey: "crisis", href: "/admin/crisis", icon: ClipboardCheck },
      // Skolans dag: the whole school's day and week as classes, teachers or
      // rooms, and who is free. Before the day planner it reads from: the
      // overview first, the single lesson after. The timetable's icon.
      { labelKey: "schoolDay", href: "/admin/school-day", icon: CalendarDays },
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
      // After the avbokning it builds on: an activity cancels the same lessons
      // and puts one in their place that carries the attendance.
      { labelKey: "activities", href: "/admin/activities", icon: CalendarRange },
      { labelKey: "leaveRequests", href: "/admin/leave", icon: ClipboardCheck },
      { labelKey: "roomBookings", href: "/admin/room-bookings", icon: MapPin },
      { labelKey: "reports", href: "/admin/reports", icon: BarChart3 },
      // Frånvarobevakning: the limits for absence and the pupils who passed
      // one, counted from the attendance Rapporter reads. The reports' icon:
      // both are figures over the same attendance.
      { labelKey: "absenceWatch", href: "/admin/absence-watch", icon: BarChart3 },
      // Rapporteringsgrad: each teacher's share of the lessons held whose
      // register is saved, beside Frånvarobevakning, which counts the same
      // registers from the pupils' side. The reports' icon again.
      { labelKey: "reportingRate", href: "/admin/reporting-rate", icon: BarChart3 },
      // Analys och planering: nyckeltal per lärare och skola, kostnad per elev and the
      // löneunderlag, counted from the same tjänstefördelning and registers. The reports'
      // icon again, already in the shell.
      { labelKey: "analysis", href: "/admin/analysis", icon: BarChart3 },
      // Kvittens: staff ask guardians to confirm a message, and see who has.
      // The attendance icon (Ledighetsansökningar): a
      // confirmation is a tick against a name, like the register's.
      { labelKey: "acknowledgements", href: "/admin/acknowledgements", icon: ClipboardCheck },
      // Måltidskollen: the portions of each lunch sitting, for the kitchen. The lunch services' icon
      // (Lunchsittningar): the same meal, counted instead of placed, and an icon the menu already
      // names, so the row costs the document its label and path and no drawing of its own.
      { labelKey: "meals", href: "/admin/meals", icon: UtensilsCrossed },
      // Checklistor: the instruction proofs and the classes' consent lists. Beside Kvittens, which
      // asks the guardians the consent lists ask. The attendance icon again: a tick against a name.
      { labelKey: "checklists", href: "/admin/checklists", icon: ClipboardCheck },
      // Lektionslogg's klassbok: a class's lessons over a period, printed. The subjects' book.
      { labelKey: "classBook", href: "/admin/klassbok", icon: BookOpen },
    ],
  },
  {
    labelKey: null,
    items: [
      // Dataskydd och gallring: how long each kind of data is kept. Like
      // Integrationer it is set up once and serves every phase, so it sits
      // with it, before it, and Integrationer stays last. Integrationer's key:
      // both pages decide who and what reaches the
      // school's data.
      { labelKey: "dataProtection", href: "/admin/dataskydd", icon: KeyRound },
      { labelKey: "integrations", href: "/admin/integrations", icon: KeyRound },
    ],
  },
];
