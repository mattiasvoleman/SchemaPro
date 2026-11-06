import type {
  AlarmDetail,
  AlarmSummary,
  CallView,
  FoundHereView,
  MyAlarm,
  MyCall,
  MyCrisisResponse,
  OtherPupilView,
  PriorSource,
  ProtocolMark,
  ProtocolView,
  PupilStatus,
  PupilView,
  TeacherView,
} from "@/lib/crisis-types";
import { countPupils } from "@/lib/crisis-view";

/*
 * Krisläge's answers as the tests need them: a few builders over the
 * gateway's shapes (src/crisis/crisis-views.ts), each filling in what a test
 * does not care about. Counts are always worked out from the pupils, as the
 * gateway does, so a fixture cannot disagree with itself.
 */

export const STARTED = "2027-01-12T09:14:00.000Z";
export const ENDED = "2027-01-12T09:31:00.000Z";

export function pupil(
  id: string,
  first: string,
  last: string,
  status: PupilStatus = "UNREPORTED",
  extra: Partial<PupilView> = {},
): PupilView {
  const absent: PriorSource | null = status === "ABSENT_BEFORE" ? "ATTENDANCE" : null;
  return {
    studentId: id,
    firstName: first,
    lastName: last,
    status,
    priorAbsentSource: absent,
    markedAt: status === "FOUND" || status === "MISSING" ? "2027-01-12T09:20:00.000Z" : null,
    markedBy: null,
    ...extra,
  };
}

export const teacher = (id: string | null, name: string | null, answeredAt: string | null = null): TeacherView => ({
  userId: id,
  name,
  role: "LEAD",
  answeredAt,
});

export function call(id: string, groupName: string, pupils: PupilView[], extra: Partial<CallView> = {}): CallView {
  const teachers = extra.teachers ?? [teacher("t-anna", "Anna Berg")];
  return {
    id,
    lessonId: `l-${id}`,
    basis: "LESSON",
    groupName,
    subjectName: "Matematik",
    roomName: "Sal 12",
    lessonStartsAt: "2027-01-12T09:00:00.000Z",
    lessonEndsAt: "2027-01-12T09:50:00.000Z",
    completedAt: null,
    uncovered: teachers.every((one) => one.userId === null),
    teachers,
    counts: countPupils(pupils.map((one) => one.status)),
    pupils,
    ...extra,
  };
}

/**
 * The alarm's one group of pupils on no lesson's list, as the gateway words it: Swedish stand-in names, no
 * teacher, no room, and the lesson's times both the alarm's start.
 */
export function noLessonCall(id: string, pupils: PupilView[], extra: Partial<CallView> = {}): CallView {
  return call(id, "Ej i lektion just nu", pupils, {
    lessonId: null,
    basis: "NO_LESSON",
    subjectName: "Ingen lektion pågår",
    roomName: null,
    lessonStartsAt: STARTED,
    lessonEndsAt: STARTED,
    uncovered: true,
    teachers: [],
    ...extra,
  });
}

export function summary(calls: CallView[], extra: Partial<AlarmSummary> = {}): AlarmSummary {
  const teachers = calls.flatMap((one) => one.teachers.filter((row) => row.userId !== null));
  return {
    id: "a-1",
    kind: "EVACUATION",
    mode: "LIVE",
    startedAt: STARTED,
    startedBy: "Rut Rektor",
    endedAt: null,
    endedBy: null,
    autoEnded: false,
    endNote: null,
    guardiansNotifiedAt: null,
    unlisted: calls.filter((one) => one.basis === "NO_LESSON").reduce((sum, one) => sum + one.counts.pupils, 0),
    calls: calls.length,
    callsComplete: calls.filter((one) => one.counts.unreported === 0).length,
    counts: calls.reduce(
      (sum, one) => ({
        pupils: sum.pupils + one.counts.pupils,
        found: sum.found + one.counts.found,
        missing: sum.missing + one.counts.missing,
        absentBefore: sum.absentBefore + one.counts.absentBefore,
        unreported: sum.unreported + one.counts.unreported,
      }),
      countPupils([]),
    ),
    teachers: teachers.length,
    teachersAnswered: teachers.filter((row) => row.answeredAt !== null).length,
    ...extra,
  };
}

export const detail = (calls: CallView[], extra: Partial<AlarmSummary> = {}): AlarmDetail => ({
  alarm: summary(calls, extra),
  calls,
});

export const protocolMark = (extra: Partial<ProtocolMark> & Pick<ProtocolMark, "studentId" | "groupName">): ProtocolMark => ({
  at: "2027-01-12T09:20:03.000Z",
  receivedAt: "2027-01-12T09:20:04.000Z",
  foundIn: null,
  state: "FOUND",
  by: "Anna Berg",
  onBehalf: false,
  late: false,
  ...extra,
});

export const protocol = (calls: CallView[], marks: ProtocolView["marks"] = [], extra: Partial<AlarmSummary> = {}): ProtocolView => ({
  ...detail(calls, extra),
  marks,
});

export function myCall(id: string, groupName: string, pupils: PupilView[], extra: Partial<MyCall> = {}): MyCall {
  return {
    id,
    lessonId: `l-${id}`,
    basis: "LESSON",
    groupName,
    subjectName: "Matematik",
    roomName: "Sal 12",
    lessonStartsAt: "2027-01-12T09:00:00.000Z",
    lessonEndsAt: "2027-01-12T09:50:00.000Z",
    completedAt: null,
    colleagues: [],
    counts: countPupils(pupils.map((one) => one.status)),
    pupils,
    foundHere: [],
    ...extra,
  };
}

export const foundHere = (id: string, first: string, last: string, className: string | null = null): FoundHereView => ({
  studentId: id,
  firstName: first,
  lastName: last,
  className,
  markedAt: "2027-01-12T09:21:00.000Z",
});

export const other = (id: string, first: string, last: string, className: string | null = null): OtherPupilView => ({
  studentId: id,
  firstName: first,
  lastName: last,
  className,
});

export const myAlarm = (calls: MyCall[], extra: Partial<MyAlarm> = {}): MyAlarm => ({
  id: "a-1",
  kind: "EVACUATION",
  mode: "LIVE",
  startedAt: STARTED,
  startedBy: "Rut Rektor",
  endedAt: null,
  endedBy: null,
  autoEnded: false,
  endNote: null,
  guardiansNotifiedAt: null,
  calls,
  others: [],
  ...extra,
});

export const mine = (alarms: MyAlarm[], asOf = "2027-01-12T09:20:00.000Z"): MyCrisisResponse => ({ asOf, alarms });
