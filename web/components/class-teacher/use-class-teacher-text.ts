"use client";

import { useLocale, useTranslations } from "next-intl";
import {
  isFrameReason,
  type ChangeProblem,
  type ChangeView,
  type ConflictView,
  type FieldChange,
  type FrameReason,
  type PublishOutcome,
  type Verdict,
} from "@/lib/class-teacher";

/** What the sentences about a draft need to know of the page they stand on. */
export interface TextContext {
  /** The name of a room, or null when the week holds none by that id. */
  roomName: (id: string | null) => string | null;
}

/** A verdict said for reading: how it is to be drawn, a headline, and the lines under it. */
export interface VerdictText {
  tone: "ok" | "warning" | "destructive";
  headline: string;
  lines: string[];
}

/**
 * The words of Klasslärarens schema that the teacher's page and the
 * administrators' both say: a day, a time span, a refusal's reason, a clash,
 * what changed in a lesson, a draft in a sentence, a verdict.
 *
 * A time is "HH:MM" as the gateway sends it, so it is said as it is and the
 * clock change never reaches here. A person is never named: the gateway sends
 * no teacher's name for another person's lesson, and a clash is said by what
 * clashes (the room, the class, the teacher as a role), not by who.
 */
export function useClassTeacherText() {
  const t = useTranslations("classTeacher");
  const tDays = useTranslations("days");
  const tStatus = useTranslations("lessonStatus");
  const locale = useLocale() === "en" ? "en-GB" : "sv-SE";

  const dayName = (dayOfWeek: number): string => tDays(String(dayOfWeek));
  const dayNameLower = (dayOfWeek: number): string => dayName(dayOfWeek).toLocaleLowerCase(locale);
  /** "tis 3 nov." */
  const day = (iso: string): string =>
    new Date(`${iso}T12:00:00`).toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short" });
  /** "3 nov." */
  const dateShort = (iso: string): string =>
    new Date(`${iso}T12:00:00`).toLocaleDateString(locale, { day: "numeric", month: "short" });
  const span = (start: string, end: string): string => `${start}–${end}`;

  /** A refusal's reason as a sentence; a reason this page does not know yet is said in general. */
  const reason = (value: FrameReason | string | null | undefined): string =>
    isFrameReason(value) ? t(`reason.${value}`) : t("reason.UNKNOWN");

  const conflictWhen = (other: NonNullable<ConflictView["other"]>): string => {
    const when = other.date ? day(other.date) : other.day ? dayName(other.day) : "";
    return [when, span(other.start, other.end)].filter(Boolean).join(" ");
  };

  /** "Salen är upptagen då: 6B, Matematik, tis 10 nov. 09:00–10:00". */
  const conflict = (one: ConflictView): string => {
    const kind = t(`conflict.kind.${one.kind}`);
    if (!one.other) return kind;
    return t("conflict.with", {
      kind,
      lesson: [one.other.className, one.other.subjectName].filter(Boolean).join(", "),
      when: conflictWhen(one.other),
    });
  };

  const FIELDS = [
    "dayOfWeek",
    "startTime",
    "endTime",
    "roomId",
    "teacherId",
    "coTeacherId",
    "recurrence",
    "startDate",
    "endDate",
    "isParked",
    "extraGroups",
    "students",
    "status",
    "startsAt",
    "endsAt",
    "note",
    "teachers",
  ];

  /**
   * One field that is not what it was: its name, and the values when they are
   * ones to read (a weekday, a clock, a room, a status). A person's id, a
   * group list or a timestamp in UTC is not shown: the name of the field says
   * that it changed, and the lesson on screen says to what.
   */
  const fieldChange = (change: FieldChange, ctx: TextContext): string => {
    const name = t(FIELDS.includes(change.field) ? `field.${change.field}` : "field.other");
    const value = (raw: unknown): string | null => {
      switch (change.field) {
        case "dayOfWeek":
          return typeof raw === "number" ? dayName(raw) : null;
        case "startTime":
        case "endTime":
          return typeof raw === "string" ? raw : null;
        case "roomId":
          return raw === null || raw === undefined ? t("field.noRoom") : (ctx.roomName(String(raw)) ?? t("field.otherRoom"));
        case "status":
          return typeof raw === "string" && ["SCHEDULED", "CANCELLED", "COMPLETED", "RESCHEDULED"].includes(raw) ? tStatus(raw) : null;
        default:
          return null;
      }
    };
    const was = value(change.was);
    const now = value(change.now);
    return was !== null && now !== null ? t("field.change", { name, was, now }) : name;
  };

  const fieldChanges = (changed: readonly FieldChange[], ctx: TextContext): string =>
    changed.map((one) => fieldChange(one, ctx)).join(", ");

  /** A draft in a sentence: what it asks for, of which lesson. */
  const summary = (change: ChangeView, subject: string | null, ctx: TextContext): string => {
    const lesson = change.date
      ? t("summary.lessonOn", { subject: subject ?? t("summary.lesson"), date: day(change.date) })
      : (subject ?? t("summary.lesson"));
    const room = ctx.roomName(change.targetRoomId);
    const there = (target: string): string => (room ? t("summary.withRoom", { target, room }) : target);
    const times = span(change.targetStart ?? "", change.targetEnd ?? "");
    switch (change.kind) {
      case "OCCASION_MOVE":
        return t("summary.OCCASION_MOVE", {
          lesson,
          target: there(`${change.targetDate ? day(change.targetDate) : ""} ${times}`.trim()),
        });
      case "OCCASION_CANCEL":
        return t("summary.OCCASION_CANCEL", { lesson });
      case "OCCASION_ROOM":
        return t("summary.OCCASION_ROOM", { lesson, room: room ?? t("summary.aRoom") });
      case "TEMPLATE_MOVE":
        return t("summary.TEMPLATE_MOVE", {
          lesson,
          target: there(`${change.targetDayOfWeek ? dayNameLower(change.targetDayOfWeek) : ""} ${times}`.trim()),
        });
      case "TEMPLATE_SPLIT":
        return t("summary.TEMPLATE_SPLIT", {
          lesson,
          keepEnd: change.keepEnd ?? "",
          target: there(`${change.targetDayOfWeek ? dayNameLower(change.targetDayOfWeek) : ""} ${times}`.trim()),
        });
    }
  };

  /** A verdict for reading. `ctx` names the rooms that a stale lesson's fields speak of. */
  const verdict = (value: Verdict, ctx: TextContext): VerdictText => {
    switch (value.state) {
      case "OK":
        // Publishing may take lessons out of the published calendar (and the logs on them): said before, as the swap dialog says it.
        return value.removes && value.removes.lessons > 0
          ? {
              tone: "warning",
              headline: t("verdict.OKRemoves"),
              lines: [
                t("verdict.removes", { lessons: value.removes.lessons }),
                ...(value.removes.withLog > 0 ? [t("verdict.removesLog", { withLog: value.removes.withLog })] : []),
              ],
            }
          : { tone: "ok", headline: t("verdict.OK"), lines: [] };
      case "REFUSED":
        return { tone: "destructive", headline: t("verdict.REFUSED"), lines: [reason(value.reason)] };
      case "STALE":
        return {
          tone: "warning",
          headline: t("verdict.STALE"),
          lines: [
            ...(value.changed.length > 0 ? [t("verdict.staleChanged", { fields: fieldChanges(value.changed, ctx) })] : []),
            t("verdict.staleAdvice"),
          ],
        };
      case "GONE":
        return { tone: "destructive", headline: t("verdict.GONE"), lines: [] };
      case "CONFLICT":
        return { tone: "warning", headline: t("verdict.CONFLICT"), lines: value.conflicts.map(conflict) };
      default:
        // A state this page does not know yet (a gateway newer than the web): said in general, never a crash.
        return { tone: "warning", headline: t("verdict.unknown"), lines: [] };
    }
  };

  /** What publication did with one draft. */
  const outcome = (value: PublishOutcome, ctx: TextContext): VerdictText => {
    switch (value.outcome) {
      case "PUBLISHED":
        return { tone: "ok", headline: t("outcome.PUBLISHED"), lines: [] };
      case "REFUSED":
        return { tone: "destructive", headline: t("outcome.REFUSED"), lines: [reason(value.reason)] };
      case "STALE":
        return {
          tone: "warning",
          headline: t("outcome.STALE"),
          lines: value.changed && value.changed.length > 0 ? [t("verdict.staleChanged", { fields: fieldChanges(value.changed, ctx) })] : [],
        };
      case "CONFLICT":
        return { tone: "warning", headline: t("outcome.CONFLICT"), lines: (value.conflicts ?? []).map(conflict) };
      case "GONE":
        return { tone: "destructive", headline: t("outcome.GONE"), lines: [] };
      case "FAILED":
      default:
        return { tone: "destructive", headline: t("outcome.FAILED"), lines: [] };
    }
  };

  /** A failed write as a sentence (and, for a refusal whose reason the gateway sent, the reason). */
  const problem = (value: ChangeProblem): { headline: string; detail: string | null } => {
    switch (value.kind) {
      case "frame":
        return { headline: t("problem.frame"), detail: value.reason ? reason(value.reason) : t("problem.frameSeePreview") };
      case "notAppointed":
        return { headline: t("problem.notAppointed"), detail: null };
      case "stale":
        return { headline: t("problem.stale"), detail: t("problem.staleDetail") };
      case "rev":
        return { headline: t("problem.rev"), detail: t("problem.revDetail") };
      case "exists":
        return { headline: t("problem.exists"), detail: null };
      case "conflict":
        return { headline: t("problem.conflict"), detail: null };
      case "appointerGone":
        return { headline: t("problem.appointerGone"), detail: t("problem.appointerGoneDetail") };
      case "publishOff":
        return { headline: t("problem.publishOff"), detail: null };
      case "areaNotYours":
        return { headline: t("problem.areaNotYours"), detail: value.message };
      case "gone":
        return { headline: t("problem.gone"), detail: null };
      case "invalid":
        return { headline: t("problem.invalid"), detail: null };
      case "other":
        return { headline: t("problem.other"), detail: null };
    }
  };

  return { t, locale, dayName, dayNameLower, day, dateShort, span, reason, conflict, fieldChange, fieldChanges, summary, verdict, outcome, problem };
}
