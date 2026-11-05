import type { BatchScope } from "@/lib/publication-types";
import type {
  ActivityCreditLine,
  ActivityInput,
  ActivitySelection,
  ActivityTeacher,
  ScheduleActivity,
} from "@/lib/schedule-activity-types";

/*
 * The schemabrytande aktivitet form and what it sends
 * (POST /schedule-activities[/preview], PATCH /schedule-activities/:id and
 * POST /schedule-activities/:id/preview).
 *
 * The rules are the gateway's (ScheduleActivitySelectionDto and
 * schedule-activities.service.ts), said here first so the admin reads them
 * beside the field rather than as a 400:
 *
 *   - a name, 1–80 characters: also the name of each credit it writes;
 *   - the avbokning's own range, inside the läsår, at most 31 days both ends
 *     counted, and its optional time window with both ends;
 *   - SCHOOL with nothing else, GRADES with a span, GROUPS with 1–200 groups;
 *   - a replacement subject, which must not count toward the timplan (the
 *     page offers only those, the gateway refuses the rest: ACTIVITY_SUBJECT_COUNTS);
 *   - a description of at most 300 characters;
 *   - credits: at most 12 lines, one per subject, 1–600 minutes, subjects that
 *     DO count toward the timplan, and only for whole days (no time window);
 *   - teachers: per class or group of the activity, at most 8, the first leads.
 *
 * lib/cancellation-form.ts has the avbokning's rules for the same range; the
 * few lines they share are copied rather than imported, so that the two pages
 * do not become one chunk's neighbours (the bundle gate is per route).
 */

export const ACTIVITY_NAME_MAX = 80;
export const ACTIVITY_DESCRIPTION_MAX = 300;
export const ACTIVITY_CREDITS_MAX = 12;
export const ACTIVITY_TEACHERS_PER_CLASS_MAX = 8;
export const ACTIVITY_MAX_DAYS = 31;

/** One credit line as typed: the minutes stay a string until they are sent. */
export interface CreditRow {
  /** Only a React key: a row removed from the middle must not hand its inputs to the next. */
  id: number;
  subjectId: string;
  minutes: string;
}

export interface ActivityForm {
  name: string;
  fromDate: string;
  toDate: string;
  /** "" = whole days. */
  startTime: string;
  endTime: string;
  scope: BatchScope;
  minGradeLevel: number;
  maxGradeLevel: number;
  groupIds: string[];
  /** "" = not chosen. */
  replacementSubjectId: string;
  description: string;
  /** Per class or group: the responsible teachers in order; the first leads. */
  teachers: Record<string, string[]>;
  credits: CreditRow[];
  /** Ticked in the preview. The gateway's default is true: telling the families is what an activity is for. */
  notify: boolean;
}

export const EMPTY_ACTIVITY_FORM: ActivityForm = {
  name: "",
  fromDate: "",
  toDate: "",
  startTime: "",
  endTime: "",
  scope: "GRADES",
  minGradeLevel: 9,
  maxGradeLevel: 9,
  groupIds: [],
  replacementSubjectId: "",
  description: "",
  teachers: {},
  credits: [],
  notify: true,
};

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Days from one date to another, both counted: the same day is 1. */
export function inclusiveDays(fromDate: string, toDate: string): number {
  return Math.round((Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86_400_000) + 1;
}

export type ActivityProblem =
  | "name"
  | "dates"
  | "order"
  | "outsideYear"
  | "tooLong"
  | "time"
  | "grades"
  | "groups"
  | "subject"
  | "description"
  | "creditCount"
  | "creditSubject"
  | "creditDuplicate"
  | "creditMinutes"
  | "creditPartialDay";

/** Whole minutes, 1–600: what ActivityCreditDto takes. */
export function validMinutes(value: string): boolean {
  const minutes = Number(value);
  return value.trim() !== "" && Number.isInteger(minutes) && minutes >= 1 && minutes <= 600;
}

/** What the gateway would refuse, as keys the page words; empty = sendable. */
export function activityProblems(form: ActivityForm, year: { startDate: string; endDate: string }): ActivityProblem[] {
  const problems: ActivityProblem[] = [];
  const name = form.name.trim();
  if (name.length === 0 || name.length > ACTIVITY_NAME_MAX) problems.push("name");
  if (!ISO.test(form.fromDate) || !ISO.test(form.toDate)) {
    problems.push("dates");
  } else if (form.toDate < form.fromDate) {
    problems.push("order");
  } else {
    if (form.fromDate < year.startDate || form.toDate > year.endDate) problems.push("outsideYear");
    if (inclusiveDays(form.fromDate, form.toDate) > ACTIVITY_MAX_DAYS) problems.push("tooLong");
  }
  const timed = form.startTime !== "" || form.endTime !== "";
  if (timed && (!CLOCK.test(form.startTime) || !CLOCK.test(form.endTime) || form.startTime >= form.endTime)) {
    problems.push("time");
  }
  if (form.scope === "GRADES" && form.minGradeLevel > form.maxGradeLevel) problems.push("grades");
  if (form.scope === "GROUPS" && (form.groupIds.length === 0 || form.groupIds.length > 200)) problems.push("groups");
  if (form.replacementSubjectId === "") problems.push("subject");
  if (form.description.trim().length > ACTIVITY_DESCRIPTION_MAX) problems.push("description");
  if (form.credits.length > 0) {
    if (form.credits.length > ACTIVITY_CREDITS_MAX) problems.push("creditCount");
    if (form.credits.some((row) => row.subjectId === "")) problems.push("creditSubject");
    const chosen = form.credits.map((row) => row.subjectId).filter((id) => id !== "");
    if (new Set(chosen).size !== chosen.length) problems.push("creditDuplicate");
    if (form.credits.some((row) => !validMinutes(row.minutes))) problems.push("creditMinutes");
    // A credit is a whole day's: a partly held day credited in full would count the morning twice.
    if (timed) problems.push("creditPartialDay");
  }
  return problems;
}

/** The group facts the owner rule reads: useGroups() rows have all of them. */
export interface OwnerGroup {
  id: string;
  kind: "CLASS" | "TEACHING_GROUP";
  gradeLevel: number | null;
  halfOfId?: string | null;
}

/**
 * The classes and groups that get a replacement lesson, and so may have a
 * responsible teacher: the gateway's ownersOf (src/publication/activity-plan.ts).
 * GRADES and SCHOOL name classes (a half rides on its class); GROUPS names
 * them, minus a half whose class is named too.
 *
 * The page sends a teacher only for one of these, so a scope changed after
 * teachers were picked never reaches the gateway as ACTIVITY_TEACHER.
 */
export function ownerIdsOf(
  form: Pick<ActivityForm, "scope" | "minGradeLevel" | "maxGradeLevel" | "groupIds">,
  groups: readonly OwnerGroup[],
): Set<string> {
  if (form.scope === "GROUPS") {
    const named = new Set(form.groupIds);
    return new Set(
      groups
        .filter((group) => named.has(group.id) && !(group.halfOfId && named.has(group.halfOfId)))
        .map((group) => group.id),
    );
  }
  return new Set(
    groups
      .filter(
        (group) =>
          group.kind === "CLASS" &&
          !group.halfOfId &&
          (form.scope === "SCHOOL" ||
            (group.gradeLevel !== null &&
              group.gradeLevel >= form.minGradeLevel &&
              group.gradeLevel <= form.maxGradeLevel)),
      )
      .map((group) => group.id),
  );
}

/** The teachers as the gateway takes them: per owner, the first named leads. */
export function teachersOf(form: Pick<ActivityForm, "teachers">, owners: ReadonlySet<string>): ActivityTeacher[] {
  return Object.keys(form.teachers)
    .sort()
    .filter((studentGroupId) => owners.has(studentGroupId))
    .flatMap((studentGroupId) =>
      [...new Set(form.teachers[studentGroupId])]
        .slice(0, ACTIVITY_TEACHERS_PER_CLASS_MAX)
        .map((teacherId, index) => ({
          studentGroupId,
          teacherId,
          role: index === 0 ? ("LEAD" as const) : ("ASSISTANT" as const),
        })),
    );
}

/**
 * What the preview sends, and the create and the change with a digest added:
 * only the scope's own fields, and nothing the gateway would take for absent
 * (an empty window, description or list is left out, not sent empty).
 */
export function selectionOf(
  form: ActivityForm,
  academicYearId: string,
  groups: readonly OwnerGroup[],
): ActivitySelection {
  const teachers = teachersOf(form, ownerIdsOf(form, groups));
  const credits: ActivityCreditLine[] = form.credits
    .filter((row) => row.subjectId !== "")
    .map((row) => ({ subjectId: row.subjectId, minutes: Number(row.minutes) }));
  const description = form.description.trim();
  return {
    academicYearId,
    name: form.name.trim(),
    fromDate: form.fromDate,
    toDate: form.toDate,
    ...(form.startTime && form.endTime ? { startTime: form.startTime, endTime: form.endTime } : {}),
    scope: form.scope,
    ...(form.scope === "GRADES" ? { minGradeLevel: form.minGradeLevel, maxGradeLevel: form.maxGradeLevel } : {}),
    ...(form.scope === "GROUPS" ? { groupIds: [...form.groupIds].sort() } : {}),
    replacementSubjectId: form.replacementSubjectId,
    ...(description ? { description } : {}),
    ...(teachers.length > 0 ? { teachers } : {}),
    ...(credits.length > 0 ? { credits } : {}),
  };
}

/** The create or the change: the previewed selection, its digest and whether to tell the families. */
export function inputOf(
  form: ActivityForm,
  academicYearId: string,
  groups: readonly OwnerGroup[],
  digest: string,
): ActivityInput {
  return { ...selectionOf(form, academicYearId, groups), expectedDigest: digest, notify: form.notify };
}

/**
 * How a preview stands to the form now.
 *
 *   current   the very request on screen: the digest may be sent.
 *   adjusted  only the teachers, the credits or the description differ. What
 *             the preview counted (lessons, classes, days) still holds, so it
 *             stays on screen — the teachers are picked from its classes — but
 *             the digest covers them too: ask again before creating.
 *   stale     anything else: the preview describes another selection.
 */
export type PreviewState = "current" | "adjusted" | "stale";

export function previewState(previewed: ActivitySelection | null, now: ActivitySelection): PreviewState {
  if (previewed === null) return "stale";
  if (JSON.stringify(previewed) === JSON.stringify(now)) return "current";
  const core = (selection: ActivitySelection) =>
    JSON.stringify({ ...selection, teachers: undefined, credits: undefined, description: undefined });
  return core(previewed) === core(now) ? "adjusted" : "stale";
}

/**
 * Whether a change would rewrite credits. The gateway writes a credit only for
 * a day after today and a change takes those and writes them anew from the
 * lines it is sent, so an activity that is over has none to carry and credit
 * lines sent for it are refused (CANCELLATION_CREDIT).
 */
export function hasCreditsAhead(activity: Pick<ScheduleActivity, "credits" | "toDate">, today: string): boolean {
  return activity.credits > 0 && activity.toDate > today;
}

/**
 * The form an existing activity opens on. `firstId` numbers the credit rows.
 *
 * `groups` are those the page has loaded for the activity's läsår. A class
 * deleted since the activity was made is no longer among them, so the form
 * leaves it and its teachers out rather than send a name the year does not
 * hold: a deleted class does not make the activity impossible to change, and
 * the preview says what the change then does.
 */
export function formOfActivity(
  activity: ScheduleActivity,
  credits: readonly ActivityCreditLine[],
  firstId: number,
  groups: readonly { id: string }[],
): ActivityForm {
  const known = new Set(groups.map((group) => group.id));
  const teachers: Record<string, string[]> = {};
  // The leading teacher first: the gateway makes the first named lead.
  const ordered = [...activity.teachers].sort((a, b) => Number(b.role === "LEAD") - Number(a.role === "LEAD"));
  for (const teacher of ordered) {
    if (!known.has(teacher.studentGroupId)) continue;
    teachers[teacher.studentGroupId] = [...(teachers[teacher.studentGroupId] ?? []), teacher.teacherId];
  }
  return {
    name: activity.name,
    fromDate: activity.fromDate,
    toDate: activity.toDate,
    startTime: activity.startTime ?? "",
    endTime: activity.endTime ?? "",
    scope: activity.scope,
    minGradeLevel: activity.minGradeLevel ?? EMPTY_ACTIVITY_FORM.minGradeLevel,
    maxGradeLevel: activity.maxGradeLevel ?? EMPTY_ACTIVITY_FORM.maxGradeLevel,
    groupIds: activity.scope === "GROUPS" ? activity.scopeGroupIds.filter((id) => known.has(id)) : [],
    // A subject that counts toward the timplan now is no longer a choice (the gateway
    // refuses it): the form asks for another rather than sending the old one.
    replacementSubjectId: activity.replacementSubject && !activity.doubleCounts ? activity.replacementSubject.id : "",
    description: activity.description ?? "",
    teachers,
    credits: credits.map((line, index) => ({ id: firstId + index, subjectId: line.subjectId, minutes: String(line.minutes) })),
    notify: activity.notifies,
  };
}
