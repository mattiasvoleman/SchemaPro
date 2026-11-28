import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { ApiError } from "@/lib/api";
import { apiErrorText } from "@/lib/api-error-text";
import { seenOf } from "@/lib/lesson-expected";
import type { MasterLesson } from "@/lib/types";

/*
 * SÄKERHETSNÄT (E9): what is said when a write of a lesson was refused because somebody else had changed it since the page read it.
 *
 * Loaded when the first such refusal comes, never with the page. The lesson is read again, so that the grid shows what is there; the toast says
 * what the lesson has become in the fields the gateway named, that the change was not made, and offers it once more on what is there now.
 */

type Say = (key: string, values?: Record<string, string | number>) => string;

/** The fields that say WHEN the lesson stands, told as one: the day and the clock first. */
const WHEN = ["dayOfWeek", "startTime", "endTime", "recurrence", "startDate", "endDate"];
const PUPILS = ["extraGroupIds", "studentIds"];

/** Names of rooms and people as the page's lists hold them; a list that has not come says nothing and the field is named without one. */
function nameOf(queryClient: QueryClient, key: string, id: string | null): string | null {
  if (id === null) return null;
  const rows = queryClient.getQueryData<Array<{ id: string; name?: string; firstName?: string; lastName?: string }>>([key]);
  const row = Array.isArray(rows) ? rows.find((candidate) => candidate.id === id) : undefined;
  return row ? (row.name ?? `${row.firstName ?? ""} ${row.lastName ?? ""}`.trim()) || null : null;
}

/** The lesson as it stands in the fields the gateway named, in words: "tisdag 10:00–11:00, sal A12, låst". */
export function nowSaid(queryClient: QueryClient, lesson: MasterLesson, fields: readonly string[], t: Say): string {
  const parts: string[] = [];
  if (fields.some((field) => WHEN.includes(field))) {
    const day = new Date(Date.UTC(2024, 0, lesson.dayOfWeek)).toLocaleDateString(typeof document === "undefined" ? "sv" : document.documentElement.lang || "sv", { weekday: "long", timeZone: "UTC" });
    parts.push(t("changed.when", { day, start: lesson.startTime.slice(0, 5), end: lesson.endTime.slice(0, 5) }));
  }
  if (fields.includes("roomId")) {
    const room = nameOf(queryClient, "rooms", lesson.roomId);
    parts.push(lesson.roomId === null ? t("changed.noRoom") : room ? t("changed.room", { room }) : t("changed.otherRoom"));
  }
  if (fields.includes("teacherId") || fields.includes("coTeacherId")) {
    const teacher = nameOf(queryClient, "people", lesson.teacherId);
    parts.push(lesson.teacherId === null ? t("changed.noTeacher") : teacher ? t("changed.teacher", { teacher }) : t("changed.otherTeacher"));
  }
  if (fields.includes("isLocked")) parts.push(t(lesson.isLocked ? "changed.locked" : "changed.unlocked"));
  if (fields.includes("isParked")) parts.push(t(lesson.isParked ? "changed.parked" : "changed.placed"));
  if (fields.some((field) => PUPILS.includes(field))) parts.push(t("changed.pupils"));
  if (fields.includes("exempt")) parts.push(t("changed.exempt"));
  return parts.join(", ");
}

/**
 * Reads the lesson again and says what happened. `again` makes the change once more on the lesson as it is now: the reader has seen what
 * somebody else did, and the button is theirs to press.
 */
export async function tellChanged(input: {
  queryClient: QueryClient;
  fields: string;
  lesson: MasterLesson;
  t: Say;
  again: (fresh: MasterLesson) => Promise<unknown>;
}): Promise<void> {
  const { queryClient, lesson, t } = input;
  const cache = await import("@/lib/master-lesson-cache");
  const fresh = await cache.readOne(queryClient, lesson.id);
  // The lists are read again as well: the gateway's refusal does not say what else a colleague has been doing.
  void queryClient.invalidateQueries({ queryKey: ["masterLessons"] });
  if (fresh === null) return void toast.error(t("changed.gone"), { duration: 15000 });
  const fields = input.fields.split(",").filter(Boolean);
  const text = fresh === undefined ? t("changed.unread") : t("changed.now", { now: nowSaid(queryClient, fresh, fields, t) });
  toast.error(`${t("changed.refused")} ${text}`, {
    duration: 15000,
    ...(fresh === undefined
      ? {}
      : {
          action: {
            label: t("changed.again"),
            onClick: () => void input.again(fresh).then(() => toast.success(t("changed.done")), () => toast.error(t("changed.failed"))),
          },
        }),
  });
}

/**
 * What the reader changed: the fields of the patch whose value is not the one the page saw. A save carries every field of the dialog, and the ones the
 * reader did not touch are restated, not asked for: made again on the lesson as it stands, a restated teacher would put back the one the colleague
 * had just been told to have replaced (granskaren g515). The button says "min ändring", and sends that and nothing else.
 */
export function changedBy(lesson: object, patch: Record<string, unknown>): Record<string, unknown> {
  const seen = seenOf(lesson, patch);
  const same = (a: unknown, b: unknown) => (Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((item) => b.includes(item)) : a === b);
  return Object.fromEntries(Object.entries(patch).filter(([field, value]) => !(field in seen) || !same(seen[field], value)));
}

/**
 * A write refused for somebody else's change (409 LESSON_CHANGED), said as what it is and never as a clash. A step of the history that meets it
 * is a step that cannot be taken back, in the history's own words. A write the page made is told in full when the page remembers what it asked
 * (`asked`), and by the catalogue's sentence when it does not.
 */
export async function told(input: {
  queryClient: QueryClient | undefined;
  error: ApiError;
  asked: { lesson: MasterLesson; patch: Record<string, unknown> } | undefined;
  undo: boolean;
  t: Say;
  tCommon: Say;
  again: (fresh: MasterLesson, patch: never) => Promise<unknown>;
}): Promise<void> {
  const { error, asked, t, tCommon } = input;
  const sentence = apiErrorText(error, tCommon);
  if (input.undo) return void toast.error(t("undoRefused", { why: sentence }));
  if (!asked || !input.queryClient) return void toast.error(sentence);
  await tellChanged({ queryClient: input.queryClient, fields: String(error.params?.["fields"] ?? ""), lesson: asked.lesson, t, again: (fresh) => input.again(fresh, changedBy(asked.lesson, asked.patch) as never) });
}
