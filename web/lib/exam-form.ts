import type {
  ApplyItem,
  Exam,
  ExamInput,
  ExamProposal,
  ExamSettings,
  ExamSettingsInput,
  ExamWindowKind,
  ProposedExam,
} from "@/lib/exam-types";

/*
 * Provplanering's forms and the proposal, as pure functions: what the gateway
 * would refuse (src/exams/dto/exam.dto.ts, exams.service.ts checkedExam and
 * updateSettings) said before anything is sent, and the body "Använd valda"
 * sends back. The page words the problems; this file only names them.
 */

/** 80 less the "Prov: " the activity puts before the name. */
export const EXAM_NAME_MAX = 72;
/** A window of days: at most a month. */
export const EXAM_MAX_DAYS = 31;
export const EXAM_LENGTH_MIN = 5;
export const EXAM_LENGTH_MAX = 480;
export const EXAM_WRITERS_MAX = 2000;
/** A skrivsal's seats. */
export const EXAM_SEATS_MAX = 2000;

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Whole days from the first to the last, both counted. */
function inclusiveDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

/** A whole number in a closed range, typed into a field. */
export function wholeIn(value: string, min: number, max: number): boolean {
  const number = Number(value);
  return value.trim() !== "" && Number.isInteger(number) && number >= min && number <= max;
}

// ---------------------------------------------------------------------------
// The exam form

export interface ExamForm {
  name: string;
  subjectId: string;
  groupIds: string[];
  lengthMinutes: string;
  writers: string;
  windowKind: ExamWindowKind;
  /** WEEK: the first and the last day of the window. */
  from: string;
  to: string;
  /** FIXED: the day and the start. */
  date: string;
  fixedStart: string;
  /** WEEK: no earlier start, no later end, on any day of the window; both optional. */
  earliestStart: string;
  latestEnd: string;
}

export const EMPTY_EXAM_FORM: ExamForm = {
  name: "",
  subjectId: "",
  groupIds: [],
  lengthMinutes: "",
  writers: "",
  windowKind: "WEEK",
  from: "",
  to: "",
  date: "",
  fixedStart: "",
  earliestStart: "",
  latestEnd: "",
};

export type ExamProblem =
  | "name"
  | "subject"
  | "groups"
  | "length"
  | "writers"
  | "dates"
  | "order"
  | "outsideYear"
  | "tooLong"
  | "fixedStart"
  | "limits";

/** What the gateway would refuse; empty = sendable. `groupIds` are the year's groups, so a class the year no longer holds is a problem. */
export function examProblems(
  form: ExamForm,
  year: { startDate: string; endDate: string },
  yearGroupIds: ReadonlySet<string>,
): ExamProblem[] {
  const problems: ExamProblem[] = [];
  const name = form.name.trim();
  if (name.length === 0 || name.length > EXAM_NAME_MAX) problems.push("name");
  if (form.subjectId === "") problems.push("subject");
  if (form.groupIds.length === 0 || form.groupIds.length > 60 || form.groupIds.some((id) => !yearGroupIds.has(id))) {
    problems.push("groups");
  }
  if (!wholeIn(form.lengthMinutes, EXAM_LENGTH_MIN, EXAM_LENGTH_MAX)) problems.push("length");
  if (!wholeIn(form.writers, 1, EXAM_WRITERS_MAX)) problems.push("writers");

  const from = form.windowKind === "FIXED" ? form.date : form.from;
  const to = form.windowKind === "FIXED" ? form.date : form.to;
  if (!ISO.test(from) || !ISO.test(to)) {
    problems.push("dates");
  } else if (to < from) {
    problems.push("order");
  } else {
    if (from < year.startDate || to > year.endDate) problems.push("outsideYear");
    if (inclusiveDays(from, to) > EXAM_MAX_DAYS) problems.push("tooLong");
  }

  if (form.windowKind === "FIXED") {
    if (!CLOCK.test(form.fixedStart)) problems.push("fixedStart");
  } else {
    const early = form.earliestStart;
    const late = form.latestEnd;
    const malformed = (early !== "" && !CLOCK.test(early)) || (late !== "" && !CLOCK.test(late));
    if (malformed || (early !== "" && late !== "" && early >= late)) problems.push("limits");
  }
  return problems;
}

/** The body of a create or a change; call it when examProblems is empty. */
export function examInput(form: ExamForm): ExamInput {
  const fixed = form.windowKind === "FIXED";
  return {
    subjectId: form.subjectId,
    name: form.name.trim(),
    lengthMinutes: Number(form.lengthMinutes),
    writers: Number(form.writers),
    windowKind: form.windowKind,
    windowFrom: fixed ? form.date : form.from,
    windowTo: fixed ? form.date : form.to,
    ...(fixed ? { fixedStart: form.fixedStart } : {}),
    ...(!fixed && form.earliestStart !== "" ? { earliestStart: form.earliestStart } : {}),
    ...(!fixed && form.latestEnd !== "" ? { latestEnd: form.latestEnd } : {}),
    groupIds: form.groupIds,
  };
}

/** A change opens on the exam as it stands. */
export function formOfExam(exam: Exam, yearGroupIds: ReadonlySet<string>): ExamForm {
  const fixed = exam.windowKind === "FIXED";
  return {
    name: exam.name,
    subjectId: exam.subjectId,
    groupIds: exam.groups.map((group) => group.id).filter((id) => yearGroupIds.has(id)),
    lengthMinutes: String(exam.lengthMinutes),
    writers: String(exam.writers),
    windowKind: exam.windowKind,
    from: fixed ? "" : exam.windowFrom,
    to: fixed ? "" : exam.windowTo,
    date: fixed ? exam.windowFrom : "",
    fixedStart: exam.fixedStart ?? "",
    earliestStart: exam.earliestStart ?? "",
    latestEnd: exam.latestEnd ?? "",
  };
}

// ---------------------------------------------------------------------------
// The school's settings

export interface SettingsForm {
  enabled: boolean;
  maxPerClassPerDay: string;
  maxPerClassPerWeek: string;
  writersPerInvigilator: string;
  turnoverMinutes: string;
  replacementSubjectId: string;
}

export function formOfSettings(settings: ExamSettings): SettingsForm {
  return {
    enabled: settings.enabled,
    maxPerClassPerDay: String(settings.maxPerClassPerDay),
    maxPerClassPerWeek: String(settings.maxPerClassPerWeek),
    writersPerInvigilator: String(settings.writersPerInvigilator),
    turnoverMinutes: String(settings.turnoverMinutes),
    replacementSubjectId: settings.replacementSubject?.id ?? "",
  };
}

export type SettingsProblem = "day" | "week" | "order" | "ratio" | "turnover";

export function settingsProblems(form: SettingsForm): SettingsProblem[] {
  const problems: SettingsProblem[] = [];
  const dayOk = wholeIn(form.maxPerClassPerDay, 1, 10);
  const weekOk = wholeIn(form.maxPerClassPerWeek, 1, 30);
  if (!dayOk) problems.push("day");
  if (!weekOk) problems.push("week");
  if (dayOk && weekOk && Number(form.maxPerClassPerWeek) < Number(form.maxPerClassPerDay)) problems.push("order");
  if (!wholeIn(form.writersPerInvigilator, 1, 200)) problems.push("ratio");
  if (!wholeIn(form.turnoverMinutes, 0, 120)) problems.push("turnover");
  return problems;
}

export function settingsInput(form: SettingsForm): ExamSettingsInput {
  return {
    enabled: form.enabled,
    maxPerClassPerDay: Number(form.maxPerClassPerDay),
    maxPerClassPerWeek: Number(form.maxPerClassPerWeek),
    writersPerInvigilator: Number(form.writersPerInvigilator),
    turnoverMinutes: Number(form.turnoverMinutes),
    replacementSubjectId: form.replacementSubjectId === "" ? null : form.replacementSubjectId,
  };
}

// ---------------------------------------------------------------------------
// The proposal

/** A room's seats, typed into its row: whole, 1 to 2000. */
export const validSeats = (value: string): boolean => wholeIn(value, 1, EXAM_SEATS_MAX);

/** The proposal's placed exams, a day at a time in the order the gateway gave them. */
export function placedByDay(placed: readonly ProposedExam[]): Array<{ date: string; exams: ProposedExam[] }> {
  const days: Array<{ date: string; exams: ProposedExam[] }> = [];
  for (const exam of placed) {
    const last = days[days.length - 1];
    if (last && last.date === exam.date) last.exams.push(exam);
    else days.push({ date: exam.date, exams: [exam] });
  }
  return days;
}

/**
 * The body of "Använd valda": the chosen exams exactly as the proposal gave
 * them (version, day, start, rooms with their writers and invigilators),
 * in the proposal's order, which is the order the gateway judges them in.
 */
export function applyItems(proposal: ExamProposal, chosen: ReadonlySet<string>): ApplyItem[] {
  return proposal.placed
    .filter((exam) => chosen.has(exam.examId))
    .map((exam) => ({
      examId: exam.examId,
      examVersion: exam.version,
      date: exam.date,
      start: exam.start,
      rooms: exam.rooms.map((room) => ({
        roomId: room.roomId,
        writers: room.writers,
        teacherIds: room.invigilators.map((one) => one.teacherId),
      })),
    }));
}
