import { ApiError } from "@/lib/api";
import type { MessageLookup } from "@/lib/engine-message";
import type { AdminProfile } from "@/lib/admin-areas";
import type {
  AlarmView,
  CallBasis,
  CrisisKind,
  CrisisMode,
  MarkInput,
  MarkState,
  PupilCounts,
  PupilStatus,
} from "@/lib/crisis-types";

/*
 * What the administration's page (/admin/crisis) and the teacher's
 * (/teacher/crisis) both need: pure functions only, so both routes carry them
 * and nothing else. The administration's figures are lib/crisis-live.ts, the
 * teacher's offline queue is lib/crisis-queue.ts.
 */

/** A call to the gateway carries at most this many marks (MAX_MARKS_PER_CALL in dto/crisis.dto.ts). */
export const MAX_MARKS_PER_CALL = 400;
/** The note that ends an alarm: at most this many characters (EndAlarmDto). */
export const MAX_NOTE_LENGTH = 300;

/** The profiles a school may let start an alarm (STARTABLE_PROFILES in dto/crisis.dto.ts). */
export const STARTABLE_PROFILES = ["FULL", "REKTOR", "SCHEMALAGGARE", "EXPEDITION"] as const satisfies readonly AdminProfile[];
/** Those that decide start, end and mark whatever the school chose (app.crisis_may_start). */
export const ALWAYS_START: readonly AdminProfile[] = ["FULL", "REKTOR"];
/** The defaults of a school that has set nothing: every profile that writes Drift. */
export const DEFAULT_START_PROFILES: readonly AdminProfile[] = STARTABLE_PROFILES;

/**
 * Whether a profile may start, end and mark an alarm. A school that has not
 * said (settings not read, or failed) is not a reason to hold an alarm back:
 * the answer is then "yes", and the database says no where it is no.
 */
export function mayAct(
  profile: AdminProfile | null | undefined,
  startProfiles: readonly AdminProfile[] | undefined,
): boolean {
  // A profile built without one reads as a profile always did, full (the (app) layout says the same); null is none.
  const who = profile === undefined ? "FULL" : profile;
  if (who === null || who === "LASARE") return false;
  if (ALWAYS_START.includes(who)) return true;
  return startProfiles === undefined || startProfiles.includes(who);
}

export const isOpen = (alarm: Pick<AlarmView, "endedAt">): boolean => alarm.endedAt === null;

/**
 * A group's name as the page says it. The group of pupils on no lesson comes from the gateway with
 * Swedish stand-in names; a page shows `noLesson` (crisis.noLesson.group) in the reader's language instead.
 */
export const groupLabel = (call: { basis: CallBasis; groupName: string }, noLesson: string): string =>
  call.basis === "NO_LESSON" ? noLesson : call.groupName;

/** A random v4 uuid, which the gateway wants of a mark's id (randomUUID exists on secure pages only). */
export function uuidV4(): string {
  const crypto = globalThis.crypto;
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function countPupils(statuses: readonly PupilStatus[]): PupilCounts {
  const counts: PupilCounts = { pupils: statuses.length, found: 0, missing: 0, away: 0, absentBefore: 0, unreported: 0 };
  for (const status of statuses) {
    if (status === "FOUND") counts.found++;
    else if (status === "MISSING") counts.missing++;
    else if (status === "AWAY") counts.away++;
    else if (status === "ABSENT_BEFORE") counts.absentBefore++;
    else counts.unreported++;
  }
  return counts;
}

/**
 * The time a mark is made at: the page's clock moved by how far it was from
 * the gateway's when the list was fetched, and never before the alarm began.
 * The database holds a mark between the alarm's start and its own now, so a
 * phone with a slow or fast clock should not have its marks refused for that.
 */
export function markTime(nowMs: number, skewMs: number, alarmStartedAt: string): string {
  return new Date(Math.max(nowMs + skewMs, Date.parse(alarmStartedAt))).toISOString();
}

/** One mark, with its own id. */
export function newMark(callId: string, studentId: string, state: MarkState, at: string): MarkInput {
  return { id: uuidV4(), callId, studentId, state, at };
}

/** A mark for a teacher with no group: "found", sent by the alarm and not by a group (`alarmId` in place of `callId`). */
export function newFreeMark(alarmId: string, studentId: string, state: MarkState, at: string): MarkInput {
  return { id: uuidV4(), alarmId, studentId, state, at };
}

/** What a mark is about: its group, or the alarm for a mark made with no group. Always one of the two. */
export const targetOf = (mark: Pick<MarkInput, "callId" | "alarmId">): string => mark.callId ?? mark.alarmId ?? "";

/**
 * "Alla finns": the pupils nobody has marked yet. A pupil who was absent
 * before is not asked for, one already found needs no second mark, and one
 * marked MISSING stays so until someone says they were found: one tap for the
 * whole group must never overwrite the one explicit "saknas".
 */
export function unmarkedPupils(pupils: readonly { studentId: string; status: PupilStatus }[]): string[] {
  return pupils.filter((pupil) => pupil.status === "UNREPORTED").map((pupil) => pupil.studentId);
}

/** A status's Badge variant; the meaning of each colour is lib/status-variants.ts's, kept here for the bundle. */
export const PUPIL_STATUS_VARIANT = {
  FOUND: "success",
  MISSING: "destructive",
  // Not found and not missing: said apart, in text and an icon, and drawn in neither of their colours.
  AWAY: "secondary",
  ABSENT_BEFORE: "outline",
  UNREPORTED: "warning",
} as const satisfies Record<PupilStatus, string>;

/** "10:32" in the school's zone and the reader's language (24 hours in both). */
export function clock(instant: string | number | Date, locale: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "sv-SE", {
    hour: "2-digit",
    minute: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(instant));
}

/** "12 jan. 10:32", for a time that may be on another day than today. */
export function dayAndClock(instant: string | number | Date, locale: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "sv-SE", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(instant));
}

/** "04:12": how long an alarm has gone, as a stopwatch. */
export function stopwatch(fromMs: number, toMs: number): string {
  const seconds = Math.max(0, Math.floor((toMs - fromMs) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds % 60)}` : `${pad(minutes)}:${pad(seconds % 60)}`;
}

/** The Swedish word for an alarm's kind and mode is crisis.kind.* and crisis.mode.*; this is the key. */
export const kindKey = (kind: CrisisKind) => `kind.${kind}` as const;
export const modeKey = (mode: CrisisMode) => `mode.${mode}` as const;

/**
 * A refusal in words: crisis.errors.<CODE> for the codes the gateway gives
 * (CRISIS_ALARM_OPEN, CRISIS_ALARM_ENDED, CRISIS_NOT_YOURS, CRISIS_MARK_INVALID,
 * CRISIS_ALARM_NOT_FOUND), THROTTLED for a 429 and OFFLINE for a request that
 * never got an answer; the caller's fallback for anything else. The gateway's
 * own sentence is Swedish prose written for a log, so it is not shown.
 */
export function crisisErrorText(t: MessageLookup, error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.code && t.has(error.code)) return t(error.code);
    if (error.status === 429 && t.has("THROTTLED")) return t("THROTTLED");
    return fallback;
  }
  return t.has("OFFLINE") ? t("OFFLINE") : fallback;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The alarm that refused a start (409 CRISIS_ALARM_OPEN), by the id the
 * gateway puts in params.alarmId; null when it names none, or the id is not
 * one (it ends up in a link).
 */
export function blockingAlarmId(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.code !== "CRISIS_ALARM_OPEN") return null;
  const id = error.params?.alarmId;
  return typeof id === "string" && UUID.test(id) ? id.toLowerCase() : null;
}

export const errorCodeOf = (error: unknown): string | undefined => (error instanceof ApiError ? error.code : undefined);
