import type { Absence, AbsenceInput } from "@/lib/cover-types";

/*
 * The absence form (Registrera frånvaro, Ändra, Anmäl frånvaro) and its
 * checks, which mirror the gateway's (teacher-absences.service.ts periodOf and
 * the DTO): from ≤ to, at most 186 days, part of a day as a time on the first
 * day and/or on the last, and how far back the person may date it. The
 * gateway checks all of it again; this only says so before a round trip, in
 * the reader's language.
 *
 * THERE IS NO FREE-TEXT FIELD, on purpose. An absence has a category from the
 * school's list or none ("Ange inte"), because a note would be a sick-leave
 * register nobody decided to keep.
 */

export const MAX_ABSENCE_DAYS = 186;
/** An admin may register an absence that began up to this many days ago. */
export const ADMIN_BACKDATE_DAYS = 30;

/** "" in a select means "Ange inte". */
export const NO_REASON = "";

export interface AbsenceForm {
  userId: string;
  from: string;
  to: string;
  partDay: boolean;
  /** HH:MM on the first day, or "" for its start. */
  startTime: string;
  /** HH:MM on the last day, or "" for its end. */
  endTime: string;
  reasonId: string;
}

export type AbsenceFormError = "teacher" | "range" | "tooLong" | "times" | "tooFarBack" | "fromToday";

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

function dayNumber(date: string): number {
  return Math.round(new Date(`${date}T00:00:00.000Z`).getTime() / 86_400_000);
}

export function shiftDate(date: string, days: number): string {
  const day = new Date(`${date}T00:00:00.000Z`);
  day.setUTCDate(day.getUTCDate() + days);
  return day.toISOString().slice(0, 10);
}

export function emptyAbsenceForm(today: string, userId = ""): AbsenceForm {
  return { userId, from: today, to: today, partDay: false, startTime: "", endTime: "", reasonId: NO_REASON };
}

/**
 * What is wrong with the form, or null. `today` is the reader's date; `who`
 * decides how far back: an admin 30 days, a teacher from today.
 */
export function absenceFormError(
  form: AbsenceForm,
  today: string,
  who: "ADMIN" | "TEACHER",
  checkBackdate = true,
): AbsenceFormError | null {
  if (!form.userId) return "teacher";
  if (!form.from || !form.to || form.to < form.from) return "range";
  if (dayNumber(form.to) - dayNumber(form.from) + 1 > MAX_ABSENCE_DAYS) return "tooLong";
  if (form.partDay) {
    const start = form.startTime;
    const end = form.endTime;
    if (!start && !end) return "times";
    if ((start && !CLOCK.test(start)) || (end && !CLOCK.test(end))) return "times";
    if (form.from === form.to && start && end && end <= start) return "times";
  }
  if (checkBackdate) {
    if (who === "TEACHER" && form.from < today) return "fromToday";
    if (who === "ADMIN" && form.from < shiftDate(today, -ADMIN_BACKDATE_DAYS)) return "tooFarBack";
  }
  return null;
}

/** The POST body. Whole days send no times; "Ange inte" sends no reason. */
export function absenceBody(form: AbsenceForm): AbsenceInput {
  return {
    userId: form.userId,
    from: form.from,
    to: form.to,
    ...(form.partDay && form.startTime ? { startTime: form.startTime } : {}),
    ...(form.partDay && form.endTime ? { endTime: form.endTime } : {}),
    ...(form.reasonId ? { reasonId: form.reasonId } : {}),
  };
}

/**
 * The PATCH body: the period and the reason as the form now says, nulls for
 * a time taken away (whole days again) and for "Ange inte".
 */
export function absencePatch(form: AbsenceForm): {
  from: string;
  to: string;
  startTime: string | null;
  endTime: string | null;
  reasonId: string | null;
} {
  return {
    from: form.from,
    to: form.to,
    startTime: form.partDay && form.startTime ? form.startTime : null,
    endTime: form.partDay && form.endTime ? form.endTime : null,
    reasonId: form.reasonId || null,
  };
}

const pad = (value: number) => String(value).padStart(2, "0");

/** YYYY-MM-DD and HH:MM of an instant, on the reader's clock. */
export function localParts(iso: string): { date: string; time: string } {
  const instant = new Date(iso);
  return {
    date: `${instant.getFullYear()}-${pad(instant.getMonth() + 1)}-${pad(instant.getDate())}`,
    time: `${pad(instant.getHours())}:${pad(instant.getMinutes())}`,
  };
}

/**
 * The form back from a stored absence — the gateway's fieldsOf: a period
 * ending at midnight ends on the day before, and a midnight start or end is
 * no time at all.
 */
export function absenceFormOf(absence: Absence): AbsenceForm {
  const start = localParts(absence.startsAt);
  const end = localParts(absence.endsAt);
  const startTime = start.time === "00:00" ? "" : start.time;
  const endTime = end.time === "00:00" ? "" : end.time;
  return {
    userId: absence.userId,
    from: start.date,
    to: end.time === "00:00" ? shiftDate(end.date, -1) : end.date,
    partDay: Boolean(startTime || endTime),
    startTime,
    endTime,
    reasonId: absence.reasonId ?? NO_REASON,
  };
}

/** "mån 12/10 – fre 16/10" or "mån 12/10 08:00–12:00", on the reader's clock. */
export function absencePeriodText(absence: Pick<Absence, "startsAt" | "endsAt">, locale: string): string {
  const form = absenceFormOf({ ...(absence as Absence), userId: "", reasonId: null });
  const day = (date: string) =>
    new Date(`${date}T12:00:00`).toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "numeric" });
  const first = `${day(form.from)}${form.startTime ? ` ${form.startTime}` : ""}`;
  if (form.from === form.to) {
    if (form.startTime || form.endTime) {
      return `${day(form.from)} ${form.startTime || "00:00"}–${form.endTime || "24:00"}`;
    }
    return day(form.from);
  }
  return `${first} – ${day(form.to)}${form.endTime ? ` ${form.endTime}` : ""}`;
}
