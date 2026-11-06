import type { CallView, CrisisKind, CrisisMode, ProtocolMark, ProtocolView, PupilStatus } from "@/lib/crisis-types";

/*
 * THE PROTOCOL AS A FILE AND AS PAPER (Krisläge).
 *
 * Pure functions: the file's cells and the printed pages' data are worked out
 * here from what GET /crisis/alarms/:id/protocol answered, and the click that
 * downloads or prints is app/[locale]/(app)/admin/crisis/protocol-actions.ts.
 *
 * NO PUPIL WITH A PROTECTED IDENTITY IS NAMED IN A FILE OR ON PAPER
 * (skyddad identitet, lib/protected-people.ts; the rule is HOLDS_OUT in
 * lib/people-files.ts): the pupil's row and every mark that names them are
 * left out, and the number of such pupils is said once, as the sentence the
 * page and the file both end with. The groups' own figures (counts) are the
 * gateway's and count them: "räknade utan namn".
 *
 * The file follows the other CSV exports (lib/csv-export.ts serializeCsv: BOM,
 * semicolons, CRLF and the formula guard on every cell): ASCII-safe headers,
 * and its words are Swedish whatever language the page is in, as the words of
 * the other files are (RECURRENCE_WORD, KIND_WORD). One row per pupil in a group: who was
 * asked for, how it stands, and the latest mark with its time and who made it.
 * The timeline of every mark, with the corrections, is on the printed
 * protocol.
 */

export const PROTOCOL_HEADERS = [
  "larm_start",
  "art",
  "lage",
  "grupp",
  "amne",
  "sal",
  "lektion_start",
  "lektion_slut",
  "lektionen",
  "larare",
  "elev_efternamn",
  "elev_fornamn",
  "status",
  "markerad",
  "markerad_av",
  "anmarkning",
] as const;

const KIND_WORD: Record<CrisisKind, string> = { EVACUATION: "utrymning", LOCKDOWN: "inrymning" };
const MODE_WORD: Record<CrisisMode, string> = { LIVE: "skarpt larm", DRILL: "övning" };
const STATUS_WORD: Record<PupilStatus, string> = {
  FOUND: "finns",
  MISSING: "saknas",
  ABSENT_BEFORE: "frånvarande sedan tidigare",
  UNREPORTED: "ej rapporterad",
};

/** The sentence that says how many were left out by name; "" when none were. */
export function heldOutSentence(heldOut: number): string {
  if (heldOut === 0) return "";
  return heldOut === 1
    ? "1 elev med skyddad identitet är räknad utan namn"
    : `${heldOut} elever med skyddad identitet är räknade utan namn`;
}

interface Zoned {
  date: string;
  time: string;
  seconds: string;
}

/** An instant as the school's wall clock reads it: "2027-01-12", "09:14", "09:14:03". */
function zoned(instant: string, timeZone: string): Zoned {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const at = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  const time = `${at("hour")}:${at("minute")}`;
  return { date: `${at("year")}-${at("month")}-${at("day")}`, time, seconds: `${time}:${at("second")}` };
}

/** larmprotokoll-<yyyy-mm-dd>-<hhmm>.csv, from when the alarm began. */
export function protocolFilename(startedAt: string, timeZone: string): string {
  const { date, time } = zoned(startedAt, timeZone);
  return `larmprotokoll-${date}-${time.replace(":", "")}.csv`;
}

/** The pupils a protocol names, once each (for the marks to be read against). */
export function pupilIds(view: Pick<ProtocolView, "calls">): string[] {
  return [...new Set(view.calls.flatMap((call) => call.pupils.map((pupil) => pupil.studentId)))];
}

export interface ProtocolForPaper {
  calls: CallView[];
  marks: ProtocolMark[];
  /** The pupils left out by name, each counted once. */
  heldOut: number;
}

/**
 * The protocol without the marked pupils: their rows in every group and every
 * mark that names them. `marked` is the school's protected persons
 * (readMarks); the count is of those among the protocol's pupils.
 */
export function withoutProtected(view: ProtocolView, marked: ReadonlySet<string>): ProtocolForPaper {
  return {
    calls: view.calls.map((call) => ({ ...call, pupils: call.pupils.filter((pupil) => !marked.has(pupil.studentId)) })),
    marks: view.marks.filter((mark) => !marked.has(mark.studentId)),
    heldOut: pupilIds(view).filter((id) => marked.has(id)).length,
  };
}

/** "Anna Berg (09:14)" / "Bo Ek (ej svarat)": who answered for the group, and when they first marked. */
function teachersCell(call: CallView, timeZone: string): string {
  if (call.uncovered) return "ingen lärare";
  return call.teachers
    .flatMap((teacher) => (teacher.name ? [`${teacher.name} (${teacher.answeredAt ? zoned(teacher.answeredAt, timeZone).time : "ej svarat"})`] : []))
    .join(" / ");
}

/**
 * The file's rows. `held` is the pupils to leave out (the school's protected
 * persons); a note row ends the file when any were.
 */
export function protocolRows(view: ProtocolView, held: ReadonlySet<string>, timeZone: string): string[][] {
  const { alarm } = view;
  const start = zoned(alarm.startedAt, timeZone);
  const common = [`${start.date} ${start.seconds}`, KIND_WORD[alarm.kind], MODE_WORD[alarm.mode]];
  const rows: string[][] = [];
  for (const call of view.calls) {
    const lesson = [zoned(call.lessonStartsAt, timeZone).time, zoned(call.lessonEndsAt, timeZone).time];
    for (const pupil of call.pupils) {
      if (held.has(pupil.studentId)) continue;
      rows.push([
        ...common,
        call.groupName,
        call.subjectName,
        call.roomName ?? "",
        ...lesson,
        call.basis === "NEXT_LESSON" ? "nästa lektion (rast)" : "pågående lektion",
        teachersCell(call, timeZone),
        pupil.lastName,
        pupil.firstName,
        STATUS_WORD[pupil.status],
        pupil.markedAt ? `${zoned(pupil.markedAt, timeZone).date} ${zoned(pupil.markedAt, timeZone).seconds}` : "",
        pupil.markedBy ?? "",
        "",
      ]);
    }
  }
  const heldOut = pupilIds(view).filter((id) => held.has(id)).length;
  if (heldOut > 0) rows.push([...PROTOCOL_HEADERS.slice(0, -1).map(() => ""), heldOutSentence(heldOut)]);
  return rows;
}
