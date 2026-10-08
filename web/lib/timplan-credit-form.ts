// Tillgodoräknad tid on Lov & studiedagar — the dialog's form and the page's
// pairing of credits with the lov they usually belong to.
//
// THE CHECKS MIRROR THE DTO (src/timplan/dto/timplan-credit.dto.ts), which
// mirrors the table's CHECKs: minutes a whole number 1..600, a name with
// something other than white space in it and at most 80 characters, a note
// that is either nothing or the same and at most 500, a span in order, and a
// date inside the läsår. Characters are counted in code points, as
// char_length and the DTO's MaxCodePoints count them, so "Ämnesdag 🌲" is as
// long here as there. A check here is a convenience — the save button waits
// for a sensible form — and the server's sentence is still what the dialog
// shows when it refuses (a group of another year, say, which only it knows).
//
// "Non-blank" is the JS `\S`, the class P1's CHECK spells out: a name of
// tabs or no-break spaces is blank, as the database will say.

import type { TimplanCredit, TimplanCreditInput } from "@/lib/timplan-credit-queries";

export type CreditScope = "school" | "grades" | "group";

export interface CreditForm {
  name: string;
  date: string;
  /** As typed; parsed on validation. */
  minutes: string;
  /** "" for "Inget ämne — räknas som undervisningstid". */
  subjectId: string;
  scope: CreditScope;
  minGradeLevel: number;
  maxGradeLevel: number;
  studentGroupId: string;
  note: string;
}

export const EMPTY_CREDIT_FORM: CreditForm = {
  name: "",
  date: "",
  minutes: "",
  subjectId: "",
  scope: "school",
  minGradeLevel: 7,
  maxGradeLevel: 9,
  studentGroupId: "",
  note: "",
};

const codePoints = (value: string): number => [...value].length;
const blank = (value: string): boolean => !/\S/.test(value);

/** What is wrong with the form, as message keys under breaks.credits.errors; [] when it may be sent. */
export function creditFormProblems(form: CreditForm, year: { startDate: string; endDate: string } | null): string[] {
  const problems: string[] = [];
  if (blank(form.name)) problems.push("nameBlank");
  else if (codePoints(form.name.trim()) > 80) problems.push("nameLong");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date)) problems.push("dateMissing");
  else if (year && (form.date < year.startDate || form.date > year.endDate)) problems.push("dateOutsideYear");
  const minutes = Number(form.minutes);
  if (!/^\d+$/.test(form.minutes.trim()) || !Number.isInteger(minutes) || minutes < 1 || minutes > 600) {
    problems.push("minutes");
  }
  if (form.scope === "grades" && form.minGradeLevel > form.maxGradeLevel) problems.push("span");
  if (form.scope === "group" && form.studentGroupId === "") problems.push("group");
  if (codePoints(form.note.trim()) > 500) problems.push("noteLong");
  return problems;
}

/** The body the API takes; a note blank after trimming is no note. */
export function creditBody(form: CreditForm, academicYearId: string): TimplanCreditInput {
  const note = form.note.trim();
  return {
    academicYearId,
    name: form.name.trim(),
    date: form.date,
    minutes: Number(form.minutes),
    subjectId: form.subjectId === "" ? null : form.subjectId,
    studentGroupId: form.scope === "group" ? form.studentGroupId : null,
    minGradeLevel: form.scope === "grades" ? form.minGradeLevel : null,
    maxGradeLevel: form.scope === "grades" ? form.maxGradeLevel : null,
    note: note === "" ? null : note,
  };
}

/** A stored credit back as the form edits it. */
export function creditForm(credit: TimplanCredit): CreditForm {
  return {
    name: credit.name,
    date: credit.date,
    minutes: String(credit.minutes),
    subjectId: credit.subjectId ?? "",
    scope: credit.studentGroupId !== null ? "group" : credit.minGradeLevel !== null ? "grades" : "school",
    minGradeLevel: credit.minGradeLevel ?? 7,
    maxGradeLevel: credit.maxGradeLevel ?? 9,
    studentGroupId: credit.studentGroupId ?? "",
    note: credit.note ?? "",
  };
}

interface DatedRange {
  startDate: string;
  endDate: string;
}

/** Whether a date lies inside any of the year's breaks — outside one, lessons that day count as well. */
export const insideAnyBreak = (date: string, breaks: readonly DatedRange[]): boolean =>
  breaks.some((range) => date >= range.startDate && date <= range.endDate);
