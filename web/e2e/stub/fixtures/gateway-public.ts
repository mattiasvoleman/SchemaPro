import type { PublicDay, PublicIndex, PublicWeek } from "../../../lib/public-timetable";
import { route, Reply, type GatewayRoute } from "../gateway-routes";
import { addDays, THIS_MONDAY } from "./calendar";
import { PUBLICATION_SETTINGS } from "./misc-publication";
import { byId, CALENDAR_LESSON_TEACHERS, CALENDAR_LESSONS, GROUPS, ROOMS, SCHOOL, SUBJECTS, TEACHERS } from "./world";

/**
 * Schemavisaren (app/v/[token]): one share link for the school's classes. With
 * no target it lists them; with 7A it shows 7A's week. Any other token is 404,
 * which the page turns into its not-found. The link may be framed on the
 * school's own website (/v/<token>/embed); any other token may be framed
 * nowhere.
 */

/** 43 characters of base64url, the shape TOKEN_PATTERN accepts. */
export const SHARE_TOKEN = "ExempelskolanKlasserDelasMedVardnadshavarna";

/** The website the school lets frame its classes (PublicationSettings.publicEmbedOrigins). */
export const SCHOOL_WEBSITE = PUBLICATION_SETTINGS.publicEmbedOrigins[0]!;

/** ISO week of a Monday: the week its Thursday falls in, counted from that year's first. */
const isoWeek = (monday: string) => {
  const thursday = new Date(`${addDays(monday, 3)}T00:00:00Z`);
  const dayOfYear = (thursday.getTime() - Date.UTC(thursday.getUTCFullYear(), 0, 1)) / 86_400_000 + 1;
  return `${thursday.getUTCFullYear()}-W${String(Math.floor((dayOfYear - 1) / 7) + 1).padStart(2, "0")}`;
};

const time = (instant: string) =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm", hour: "2-digit", minute: "2-digit" }).format(new Date(instant));

export function weekOf(groupId: string): PublicWeek {
  const group = byId(Object.values(GROUPS), groupId)!;
  const days: PublicDay[] = [0, 1, 2, 3, 4].map((offset) => {
    const date = addDays(THIS_MONDAY, offset);
    return {
      date,
      lessons: CALENDAR_LESSONS.filter((lesson) => lesson.studentGroupId === groupId && lesson.date === date).map((lesson) => ({
        start: time(lesson.startsAt),
        end: time(lesson.endsAt),
        subject: byId(Object.values(SUBJECTS), lesson.subjectId)?.name ?? null,
        groups: [group.name],
        room: byId(Object.values(ROOMS), lesson.roomId)?.name ?? null,
        teachers: CALENDAR_LESSON_TEACHERS.filter((row) => row.calendarLessonId === lesson.id).map((row) => {
          const teacher = byId(Object.values(TEACHERS), row.teacherId)!;
          return `${teacher.firstName} ${teacher.lastName}`;
        }),
        ...(lesson.status === "CANCELLED" ? { cancelled: true } : {}),
      })),
      meals: [{ start: "11:40", end: "12:10" }],
    };
  });
  return {
    kind: "GROUP",
    title: group.name,
    school: SCHOOL.name,
    week: { from: THIS_MONDAY, to: addDays(THIS_MONDAY, 4), isoWeek: isoWeek(THIS_MONDAY) },
    days,
  };
}

const INDEX: PublicIndex = {
  kind: "GROUP",
  school: SCHOOL.name,
  targets: [GROUPS.g7A, GROUPS.g7B, GROUPS.g8A, GROUPS.g9A].map((group) => ({ id: group.id, label: group.name })),
};

export const publicRoutes: GatewayRoute[] = [
  route("GET", "/public/v1/timetables/:token/embed", ({ params }) =>
    params.token === SHARE_TOKEN ? { frameAncestors: [SCHOOL_WEBSITE] } : new Reply(404, { message: "Not found" }),
  ),
  route("GET", "/public/v1/timetables/:token", ({ params, query }) => {
    if (params.token !== SHARE_TOKEN) return new Reply(404, { message: "Not found" });
    const target = query.get("target");
    if (!target) return INDEX;
    return INDEX.targets.some((entry) => entry.id === target) ? weekOf(target) : new Reply(404, { message: "Not found" });
  }),
];
