import type {
  MyReportingRate,
  OpenLesson,
  ReportingPeriod,
  ReportingRateView,
  ReportingSettings,
  ReportingTeacherRow,
} from "../../../lib/reporting-rate";
import { Reply, route, type GatewayContext, type GatewayRoute } from "../gateway-routes";
import { addDays, mondayOf, TODAY, YEAR_END, YEAR_NAME, YEAR_START } from "./calendar";
import { byId, CALENDAR_LESSON_TEACHERS, CALENDAR_LESSONS, GROUP_LIST, SUBJECT_LIST, TEACHERS } from "./world";

/**
 * Rapporteringsgrad as the gateway answers it (src/reporting-rate/): the
 * administrator's figures per teacher for a week, a month or the läsår, the
 * two switches and the limit, and the teacher's own open lessons and grades.
 *
 * Figures per teacher for one week; a month is four of them and the läsår
 * thirty. Eva has saved no register at all, Bo every one, so the table shows
 * both ends and the bars between. The school's settings have the reminders on
 * and the weekly note off, so a switch is seen in both positions. The count
 * has run through yesterday.
 *
 * Anna's open lessons are the ones she taught earlier this week with a status
 * of SCHEDULED: Monday's two were held two days ago, which is the limit, and
 * Tuesday's one is not there yet. The gateway sends them newest first.
 */

const WEEK_FIGURES: Array<[(typeof TEACHERS)[keyof typeof TEACHERS], number, number]> = [
  [TEACHERS.anna, 12, 9],
  [TEACHERS.bo, 14, 14],
  [TEACHERS.cecilia, 6, 2],
  [TEACHERS.david, 3, 3],
  [TEACHERS.eva, 5, 0],
];
const WEEKS_IN: Record<ReportingPeriod, number> = { WEEK: 1, MONTH: 4, YEAR: 30 };

const SETTINGS: ReportingSettings = { teacherReminders: true, rektorDigest: false, openAfterDays: 2 };

/** The count has run through yesterday. */
const THROUGH = addDays(TODAY, -1);

const isDate = (value: string | null): value is string => value !== null && /^\d{4}-\d{2}-\d{2}$/.test(value);

function interval(period: ReportingPeriod, anchor: string): { from: string; to: string; yearName: string | null } | null {
  if (period === "WEEK") {
    const from = mondayOf(anchor);
    return { from, to: addDays(from, 6), yearName: null };
  }
  if (period === "MONTH") {
    const from = `${anchor.slice(0, 8)}01`;
    const next = new Date(Date.UTC(Number(anchor.slice(0, 4)), Number(anchor.slice(5, 7)), 1, 12));
    return { from, to: addDays(next.toISOString().slice(0, 10), -1), yearName: null };
  }
  return anchor >= YEAR_START && anchor <= YEAR_END ? { from: YEAR_START, to: YEAR_END, yearName: YEAR_NAME } : null;
}

function schoolRate(context: GatewayContext): ReportingRateView | Reply {
  if (!context.person) return new Reply(401, { message: "Not authenticated." });
  if (context.person.persona !== "admin") return new Reply(403, { message: "Forbidden." });
  const period = (context.query.get("period") ?? "WEEK") as ReportingPeriod;
  if (!(period in WEEKS_IN)) return new Reply(400, { message: "period must be one of WEEK, MONTH, YEAR" });
  const given = context.query.get("anchor");
  if (given !== null && !isDate(given)) return new Reply(400, { message: "anchor must be a date (YYYY-MM-DD)" });
  const anchor = given ?? TODAY;
  const range = interval(period, anchor);
  const teachers: ReportingTeacherRow[] = range
    ? WEEK_FIGURES.map(([teacher, held, reported]) => ({
        teacherId: teacher.id,
        firstName: teacher.firstName,
        lastName: teacher.lastName,
        held: held * WEEKS_IN[period],
        reported: reported * WEEKS_IN[period],
      })).sort((a, b) => a.reported / a.held - b.reported / b.held)
    : [];
  return {
    period,
    anchor,
    from: range?.from ?? null,
    to: range?.to ?? null,
    yearName: range?.yearName ?? null,
    previousAnchor: range ? addDays(range.from, -1) : null,
    nextAnchor: range ? addDays(range.to, 1) : null,
    through: THROUGH,
    total: {
      held: teachers.reduce((sum, row) => sum + row.held, 0),
      reported: teachers.reduce((sum, row) => sum + row.reported, 0),
    },
    teachers,
  };
}

function settings(context: GatewayContext): ReportingSettings | Reply {
  if (!context.person) return new Reply(401, { message: "Not authenticated." });
  return context.person.persona === "admin" ? SETTINGS : new Reply(403, { message: "Forbidden." });
}

function saveSettings(context: GatewayContext): ReportingSettings | Reply {
  const current = settings(context);
  if (current instanceof Reply) return current;
  const body = (context.body ?? {}) as Partial<ReportingSettings>;
  const days = body.openAfterDays;
  if (days !== undefined && !(Number.isInteger(days) && days >= 1 && days <= 30)) {
    return new Reply(400, { message: "openAfterDays: ett helt antal dagar, 1 till 30." });
  }
  // The stub keeps nothing between requests, so one suite cannot leave a switch for the next.
  return { ...current, ...body };
}

function mine(context: GatewayContext): MyReportingRate | Reply {
  if (!context.person) return new Reply(401, { message: "Not authenticated." });
  if (context.person.persona !== "teacher") return new Reply(403, { message: "Forbidden." });
  const taught = new Set(
    CALENDAR_LESSON_TEACHERS.filter((row) => row.teacherId === context.person!.userId).map((row) => row.calendarLessonId),
  );
  const open: OpenLesson[] = CALENDAR_LESSONS.filter(
    (lesson) => taught.has(lesson.id) && lesson.status === "SCHEDULED" && lesson.date < TODAY,
  )
    // Newest first, as app.reporting_open_lessons answers; the page puts the oldest first.
    .sort((a, b) => b.startsAt.localeCompare(a.startsAt))
    .map((lesson) => ({
      lessonId: lesson.id,
      date: lesson.date,
      startsAt: lesson.startsAt,
      endsAt: lesson.endsAt,
      subjectName: byId(SUBJECT_LIST, lesson.subjectId)?.name ?? "",
      groupName: byId(GROUP_LIST, lesson.studentGroupId)?.name ?? "",
      overdue: lesson.date <= addDays(TODAY, -SETTINGS.openAfterDays),
    }));
  const week = interval("WEEK", TODAY)!;
  const month = interval("MONTH", TODAY)!;
  return {
    openAfterDays: SETTINGS.openAfterDays,
    through: THROUGH,
    open,
    week: { from: week.from, to: week.to, held: 12, reported: 9 },
    month: { from: month.from, to: month.to, held: 48, reported: 41 },
    year: { name: YEAR_NAME, from: YEAR_START, to: YEAR_END, held: 360, reported: 330 },
  };
}

export const reportingRateRoutes: GatewayRoute[] = [
  route("GET", "/api/v1/reporting-rate", schoolRate),
  route("GET", "/api/v1/reporting-rate/settings", settings),
  route("PUT", "/api/v1/reporting-rate/settings", saveSettings),
  route("GET", "/api/v1/reporting-rate/mine", mine),
];
