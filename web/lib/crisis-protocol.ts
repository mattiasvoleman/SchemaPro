import type { CallView, CrisisKind, CrisisMode, ProtocolMark, ProtocolView, PupilStatus } from "@/lib/crisis-types";
import { groupLabel } from "@/lib/crisis-view";

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
 * protocol. "inte i huset" is the administration's word for a pupil nobody has
 * seen and who is not thought to be in the building: its own status, never "finns".
 *
 * THE LAST COLUMN IS NEW (hittad_hos, "found with"): the group of the teacher
 * who found the pupil, when the pupil's latest mark was made by a teacher on
 * another group than the pupil's own. It is last so that a reader of the first
 * sixteen columns, by position or by name, reads the file as before; the
 * sentence about the pupils left out stays in `anmarkning`. The group of
 * pupils who are on no lesson (basis NO_LESSON) is a group like the others,
 * under the words of this file, with no subject, room or lesson times.
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
  "hittad_hos",
] as const;

/** The file's words for the group of pupils on no lesson: the gateway names it with Swedish stand-ins that are not relied on. */
export const NO_LESSON_WORD = "Ej i lektion just nu";
const FOUND_WITH_WORD = "Hittad hos";
/** The column the sentence about the pupils left out is in. */
const NOTE_COLUMN = PROTOCOL_HEADERS.indexOf("anmarkning");

const KIND_WORD: Record<CrisisKind, string> = { EVACUATION: "utrymning", LOCKDOWN: "inrymning" };
const MODE_WORD: Record<CrisisMode, string> = { LIVE: "skarpt larm", DRILL: "övning" };
const STATUS_WORD: Record<PupilStatus, string> = {
  FOUND: "finns",
  MISSING: "saknas",
  AWAY: "inte i huset",
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

/**
 * The pupils of the group nobody has a lesson with. A mark names its pupil's own group only by the
 * gateway's Swedish stand-in name, so a page that says that group in its own words looks the pupil up here.
 */
export function unlistedPupils(calls: readonly Pick<CallView, "basis" | "pupils">[]): Set<string> {
  return new Set(calls.filter((call) => call.basis === "NO_LESSON").flatMap((call) => call.pupils.map((pupil) => pupil.studentId)));
}

/** "Anna Berg (09:14)" / "Bo Ek (ej svarat)": who answered for the group, and when they first marked. */
function teachersCell(call: CallView, timeZone: string): string {
  if (call.uncovered) return "ingen lärare";
  return call.teachers
    .flatMap((teacher) => (teacher.name ? [`${teacher.name} (${teacher.answeredAt ? zoned(teacher.answeredAt, timeZone).time : "ej svarat"})`] : []))
    .join(" / ");
}

/** The latest mark of each pupil, by the time it was made (the later in the list when two have the same). */
function latestMarks(marks: readonly ProtocolMark[]): Map<string, ProtocolMark> {
  const latest = new Map<string, ProtocolMark>();
  for (const mark of marks) {
    const before = latest.get(mark.studentId);
    if (!before || Date.parse(mark.at) >= Date.parse(before.at)) latest.set(mark.studentId, mark);
  }
  return latest;
}

/**
 * The file's rows. `held` is the pupils to leave out (the school's protected
 * persons); a note row ends the file when any were.
 */
export function protocolRows(view: ProtocolView, held: ReadonlySet<string>, timeZone: string): string[][] {
  const { alarm } = view;
  const start = zoned(alarm.startedAt, timeZone);
  const common = [`${start.date} ${start.seconds}`, KIND_WORD[alarm.kind], MODE_WORD[alarm.mode]];
  const latest = latestMarks(view.marks);
  const rows: string[][] = [];
  for (const call of view.calls) {
    const noLesson = call.basis === "NO_LESSON";
    // A group with no lesson has no times, room or subject to say: the gateway's stand-ins for them are not repeated.
    const lesson = noLesson ? ["", ""] : [zoned(call.lessonStartsAt, timeZone).time, zoned(call.lessonEndsAt, timeZone).time];
    for (const pupil of call.pupils) {
      if (held.has(pupil.studentId)) continue;
      // Said only while the latest mark is the find: a retraction, or the pupil's own teacher saying otherwise, ends it.
      const lastMark = latest.get(pupil.studentId);
      const foundIn = lastMark?.state === "FOUND" ? lastMark.foundIn : null;
      rows.push([
        ...common,
        groupLabel(call, NO_LESSON_WORD),
        noLesson ? "" : call.subjectName,
        call.roomName ?? "",
        ...lesson,
        noLesson ? "ej i lektion" : call.basis === "NEXT_LESSON" ? "nästa lektion (rast)" : "pågående lektion",
        teachersCell(call, timeZone),
        pupil.lastName,
        pupil.firstName,
        STATUS_WORD[pupil.status],
        pupil.markedAt ? `${zoned(pupil.markedAt, timeZone).date} ${zoned(pupil.markedAt, timeZone).seconds}` : "",
        pupil.markedBy ?? "",
        "",
        foundIn ? `${FOUND_WITH_WORD} ${groupLabel(foundIn, NO_LESSON_WORD)}` : "",
      ]);
    }
  }
  const heldOut = pupilIds(view).filter((id) => held.has(id)).length;
  if (heldOut > 0) {
    const note = PROTOCOL_HEADERS.map(() => "");
    note[NOTE_COLUMN] = heldOutSentence(heldOut);
    rows.push(note);
  }
  return rows;
}
