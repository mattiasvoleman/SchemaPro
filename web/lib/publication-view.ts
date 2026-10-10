import type {
  DraftLesson,
  DraftState,
  GateItem,
  PublicationRow,
  PublicationTimeline,
  PublishMode,
} from "@/lib/publication-types";

/*
 * Publicering's arithmetic for the screen: the window a publish is offered
 * with, which publication is valid when, and how a draft lesson is read.
 * Pure, so the dialog and the page say the same thing and a test can pin it.
 *
 * Dates are yyyy-mm-dd strings throughout and compared as strings, which is
 * their order. Weekdays are computed in UTC from the string, never from the
 * reader's clock: the school's today comes from the gateway (the timeline's
 * `today`, in the school's own zone).
 */

const DAY_MS = 86_400_000;

const asUtc = (date: string): number => Date.parse(`${date}T00:00:00Z`);
const fromUtc = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function addDays(date: string, days: number): string {
  return fromUtc(asUtc(date) + days * DAY_MS);
}

/** 1 = Monday … 7 = Sunday, the ISO weekday the grundschema counts in. */
export function isoWeekday(date: string): number {
  return new Date(asUtc(date)).getUTCDay() || 7;
}

/** The date itself on a Monday, else the Monday after. */
export function mondayOnOrAfter(date: string): string {
  const weekday = isoWeekday(date);
  return weekday === 1 ? date : addDays(date, 8 - weekday);
}

const later = (a: string, b: string) => (a > b ? a : b);
const earlier = (a: string, b: string) => (a < b ? a : b);

export interface PublishWindow {
  validFrom: string;
  validTo: string;
}

/**
 * The window the review dialog opens with.
 *
 * DIRECT: from the school's today (or the year's first day, if it has not
 * begun) to the year's last. The old dialog offered the year's first day, and
 * publishing from the past is still allowed — the gateway warns about it
 * (PUB_FROM_IN_PAST) — but it is no longer the default: it re-creates past
 * lessons a school may have removed on purpose.
 *
 * DRAFT: from the first Monday on or after today. A mid-week validFrom keeps
 * the days before it as they were and changes the days after, so a lesson
 * moved across that date is dropped or doubled for that week (PUB_WEEK_SPLIT).
 * The admin may still pick any date; the gate then says what it costs.
 */
export function defaultPublishWindow(
  mode: PublishMode,
  today: string,
  year: { startDate: string; endDate: string },
): PublishWindow {
  const start = later(today, year.startDate);
  const validFrom = earlier(mode === "DRAFT" ? mondayOnOrAfter(start) : start, year.endDate);
  return { validFrom, validTo: year.endDate };
}

/** A window the gateway would take: both dates, in order, inside the year. */
export function isWindowValid(window: PublishWindow, year: { startDate: string; endDate: string }): boolean {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  return (
    iso.test(window.validFrom) &&
    iso.test(window.validTo) &&
    window.validFrom <= window.validTo &&
    window.validFrom >= year.startDate &&
    window.validTo <= year.endDate
  );
}

export type SegmentWhen = "past" | "current" | "ahead";

export interface SegmentView {
  publicationId: string;
  from: string;
  to: string;
  when: SegmentWhen;
  publication: PublicationRow | null;
}

/** Which publication is valid when, each segment with its log row. */
export function segmentViews(timeline: PublicationTimeline): SegmentView[] {
  const byId = new Map(timeline.publications.map((row) => [row.id, row]));
  return timeline.segments.map((segment) => ({
    ...segment,
    when: segment.to < timeline.today ? "past" : segment.from > timeline.today ? "ahead" : "current",
    publication: byId.get(segment.publicationId) ?? null,
  }));
}

/** The segment valid on the school's today, if any. */
export function currentSegment(timeline: PublicationTimeline): SegmentView | null {
  return segmentViews(timeline).find((segment) => segment.when === "current") ?? null;
}

/** How many grundschema changes are waiting for a publish. */
export function pendingCount(state: DraftState): number {
  return state.added.length + state.changed.length + state.removed.length;
}

export interface GateTally {
  refuse: number;
  warn: number;
  info: number;
}

export function tallyGates(gates: readonly GateItem[]): GateTally {
  return gates.reduce<GateTally>(
    (tally, gate) => {
      if (gate.severity === "REFUSE") tally.refuse += 1;
      else if (gate.severity === "WARN") tally.warn += 1;
      else tally.info += 1;
      return tally;
    },
    { refuse: 0, warn: 0, info: 0 },
  );
}

/** What the draft lesson's line is built from: a name for every id it carries. */
export interface LessonNames {
  subject: (id: string) => string;
  group: (id: string) => string;
  teacher: (id: string) => string;
  room: (id: string) => string;
  /** 1 = Monday. */
  day: (dayOfWeek: number) => string;
}

/** "Matematik · 7A · mån 08:00–08:50 · Anna Berg · Sal 12". A parked lesson has no time. */
export function lessonLine(lesson: DraftLesson, names: LessonNames, parkedLabel: string): string {
  return [
    names.subject(lesson.subjectId),
    names.group(lesson.studentGroupId),
    lesson.isParked ? parkedLabel : `${names.day(lesson.dayOfWeek)} ${lesson.startTime}–${lesson.endTime}`,
    lesson.teacherId ? names.teacher(lesson.teacherId) : null,
    lesson.roomId ? names.room(lesson.roomId) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export type ChangedField = "time" | "teacher" | "coTeacher" | "room" | "parked";

/** What a changed lesson changed, in the order the line reads. */
export function changedFields(before: DraftLesson, after: DraftLesson): ChangedField[] {
  const fields: ChangedField[] = [];
  if (
    before.dayOfWeek !== after.dayOfWeek ||
    before.startTime !== after.startTime ||
    before.endTime !== after.endTime
  ) {
    fields.push("time");
  }
  if (before.teacherId !== after.teacherId) fields.push("teacher");
  if (before.coTeacherId !== after.coTeacherId) fields.push("coTeacher");
  if (before.roomId !== after.roomId) fields.push("room");
  if (before.isParked !== after.isParked) fields.push("parked");
  return fields;
}

/**
 * The address a share link opens. The token is shown once, when the link is
 * made; the gateway keeps only its hash, so a lost one is revoked and made
 * again rather than looked up.
 */
export function publicViewerUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, "")}/v/${token}`;
}
