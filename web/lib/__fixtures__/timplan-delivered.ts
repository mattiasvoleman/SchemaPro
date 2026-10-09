import type {
  DeliveredCoverageResponse,
  DeliveredGroupSummary,
  DeliveredLineDetail,
  DeliveredLineSummary,
} from "@/lib/timplan-delivered";

/**
 * GET /timplan-coverage?layer=delivered answers for the page's tests: the
 * spec's worked example (P3-0b, R22), written out by hand.
 *
 * 7A, åk 7, Matematik 3 × 60 ALL_WEEKS, as of Thu 2026-10-08 10:00: 22 past
 * published lessons (1 320 min), of which one cancelled for a teacher's
 * absence, one cancelled by the school and one without a teacher — 1 140
 * delivered; 360 in the calendar ahead (one more cancelled), 4 800 from the
 * grundschema after it; projected 6 300 against a planned year of 6 552,
 * SHORT by 252, of which 240 lost and −12 the schedule's own gap. The
 * friluftsdag is an åk 7–9 credit of 300 min Idrott och hälsa, and a
 * temadag of 120 min credited without a subject.
 *
 * Bea is in 7A and in Ma7-fördjupning, whose only lessons are 7A's
 * Wednesday matematik with it as an extra group: both group lines hold, and
 * Bea, planned for both, is listed.
 *
 * Hand-written rather than generated: the gateway's module reads calendar
 * aggregates no web fixture holds. The figures are the spec's own, so a
 * mismatch is a typo here, not a second opinion.
 */

export const DELIVERED_IDS = {
  year: "y-1",
  class7A: "g-7a",
  fordjupning: "g-ma7f",
  ma: "s-ma",
  idh: "s-idh",
  bea: "p-bea",
  ali: "p-ali",
} as const;

const { class7A, fordjupning, ma, idh, bea, ali } = DELIVERED_IDS;

const maLine: DeliveredLineSummary = {
  key: `subject:${ma}`,
  subjectId: ma,
  publishedMinutes: 1320,
  deliveredMinutes: 1140,
  lostMinutes: 180,
  creditedMinutes: 0,
  projectedMinutes: 6300,
  plannedYearMinutes: 6552,
  unrecordedMinutes: 0,
  deliveredPercent: 86,
  status: "SHORT",
  pupils: {
    delivered: { min: 1140, median: 1140, max: 1140, below: 0 },
    projectedDelta: { min: -2436, median: -252, max: -252, below: 2 },
    belowPlanned: 2,
    nothingDelivered: 0,
  },
};
const idhLine: DeliveredLineSummary = {
  key: `subject:${idh}`,
  subjectId: idh,
  publishedMinutes: 600,
  deliveredMinutes: 600,
  lostMinutes: 0,
  creditedMinutes: 300,
  projectedMinutes: 4400,
  plannedYearMinutes: 4368,
  unrecordedMinutes: 0,
  deliveredPercent: 100,
  status: "ON_TRACK",
  pupils: {
    delivered: { min: 600, median: 600, max: 600, below: 0 },
    projectedDelta: { min: 32, median: 32, max: 32, below: 0 },
    belowPlanned: 0,
    nothingDelivered: 0,
  },
};
const noneLine: DeliveredLineSummary = {
  key: "none",
  subjectId: null,
  publishedMinutes: 0,
  deliveredMinutes: 0,
  lostMinutes: 0,
  creditedMinutes: 120,
  projectedMinutes: 120,
  plannedYearMinutes: 0,
  unrecordedMinutes: 0,
  deliveredPercent: null,
  status: "NO_PLAN",
};
const fordjupningLine: DeliveredLineSummary = {
  key: `subject:${ma}`,
  subjectId: ma,
  publishedMinutes: 420,
  deliveredMinutes: 360,
  lostMinutes: 60,
  creditedMinutes: 0,
  projectedMinutes: 2220,
  plannedYearMinutes: 2196,
  unrecordedMinutes: 0,
  deliveredPercent: 86,
  status: "ON_TRACK",
  pupils: {
    delivered: { min: 360, median: 360, max: 360, below: 0 },
    projectedDelta: { min: -2436, median: -2436, max: -2436, below: 1 },
    belowPlanned: 1,
    nothingDelivered: 0,
  },
};

const group7A = (lines: (DeliveredLineSummary | DeliveredLineDetail)[]): DeliveredGroupSummary => ({
  studentGroupId: class7A,
  kind: "CLASS",
  gradeLevel: 7,
  pupilCount: 2,
  totals: { published: 1920, delivered: 1740, lost: 180, credited: 420, projected: 10820, plannedYear: 10920, unrecorded: 0 },
  lostByCause: { cancelledTeacherUnavailable: 60, cancelledManual: 60, teacherless: 60 },
  lines,
});
const groupFordjupning: DeliveredGroupSummary = {
  studentGroupId: fordjupning,
  kind: "TEACHING_GROUP",
  gradeLevel: null,
  pupilCount: 1,
  totals: { published: 420, delivered: 360, lost: 60, credited: 0, projected: 2220, plannedYear: 2196, unrecorded: 0 },
  lostByCause: { cancelledManual: 60 },
  lines: [fordjupningLine],
};

const verdicts: DeliveredCoverageResponse["verdicts"] = [
  {
    code: "TIMPLAN_CALENDAR_DRIFT",
    severity: "notice",
    params: { minutes: -60, extraMinutes: 60, missingMinutes: 0, lessons: 1 },
    message: "Kalendern framåt har 60 min som grundschemat inte har (1 lektion i grundschemat).",
  },
  {
    code: "TIMPLAN_PROJECTION_SHORT",
    severity: "warning",
    studentGroupId: class7A,
    subjectIds: [ma],
    params: { groupName: "7A", subjectName: "Matematik", projectedMinutes: 6300, plannedYearMinutes: 6552, deficitMinutes: 252, lostMinutes: 240, scheduleGapMinutes: -12 },
    message: "7A: Matematik beräknas få 105,0 h i år.",
  },
  {
    code: "TIMPLAN_PUPIL_PROJECTION_SHORT",
    severity: "warning",
    pupilId: bea,
    studentGroupId: class7A,
    subjectIds: [ma],
    params: { groupName: "7A", subjectName: "Matematik", projectedMinutes: 6300, plannedYearMinutes: 8736, deficitMinutes: 2436, groupDeficitMinutes: 252 },
    message: "En elev i 7A beräknas få 105,0 h Matematik i år.",
  },
  {
    code: "TIMPLAN_CREDIT_OVERLAPS_DELIVERED",
    severity: "notice",
    creditId: "c-tema",
    params: { creditName: "Temadag", date: "2026-10-02", minutes: 120, deliveredMinutes: 180 },
    message: "\"Temadag\" (2026-10-02) tillgodoräknas 120 min.",
  },
];

/** The overview an admin reads: totals per line, pupil statistics, no breakdowns (R20). */
export const DELIVERED_OVERVIEW: DeliveredCoverageResponse = {
  academicYearId: DELIVERED_IDS.year,
  layer: "delivered",
  asOf: "2026-10-08T08:00:00.000Z",
  asOfDate: "2026-10-08",
  published: { from: "2026-08-17", through: "2026-10-23" },
  pupilLevel: true,
  groups: [group7A([idhLine, maLine, noneLine]), groupFordjupning],
  pupils: [
    {
      pupilId: bea,
      homeGroupId: class7A,
      gradeLevel: 7,
      lines: [
        {
          ...maLine,
          plannedYearMinutes: 8736,
          status: "SHORT",
          groupDeficitMinutes: 252,
          sources: [{ studentGroupId: class7A, deliveredMinutes: 1140, sharedWith: [fordjupning] }],
        },
      ],
    },
  ],
  pupilCount: 2,
  pupilsBelowPlanned: 2,
  credits: { count: 2, minutes: 420 },
  drift: { minutes: -60, extraMinutes: 60, missingMinutes: 0, lessons: 1 },
  verdicts,
};

const maDetail: DeliveredLineDetail = {
  ...maLine,
  lost: { cancelledTeacherUnavailable: 60, cancelledManual: 60, teacherless: 60 },
  cancelledOnBreak: 0,
  projection: {
    deliveredSoFar: 1140,
    calendarAhead: 360,
    aheadTeacherless: 0,
    aheadCancelled: 60,
    masterAhead: 4800,
    creditsAhead: 0,
    projectedMinutes: 6300,
    plannedYearMinutes: 6552,
    unrecordedMinutes: 0,
    targetYearMinutes: null,
    deltaMinutes: -252,
    scheduleGapMinutes: -12,
    lostMinutes: 240,
  },
  credits: [],
  masterLessonIds: ["m-mon", "m-wed", "m-fri"],
};
const idhDetail: DeliveredLineDetail = {
  ...idhLine,
  lost: {},
  cancelledOnBreak: 0,
  projection: {
    deliveredSoFar: 900,
    calendarAhead: 240,
    aheadTeacherless: 0,
    aheadCancelled: 0,
    masterAhead: 3260,
    creditsAhead: 0,
    projectedMinutes: 4400,
    plannedYearMinutes: 4368,
    unrecordedMinutes: 0,
    targetYearMinutes: 4368,
    deltaMinutes: 32,
    scheduleGapMinutes: 32,
    lostMinutes: 0,
  },
  credits: [{ id: "c-fril", date: "2026-09-25", name: "Friluftsdag", minutes: 300 }],
  masterLessonIds: ["m-idh"],
};

const noneDetail: DeliveredLineDetail = {
  ...noneLine,
  lost: {},
  cancelledOnBreak: 0,
  projection: {
    deliveredSoFar: 120,
    calendarAhead: 0,
    aheadTeacherless: 0,
    aheadCancelled: 0,
    masterAhead: 0,
    creditsAhead: 0,
    projectedMinutes: 120,
    plannedYearMinutes: 0,
    unrecordedMinutes: 0,
    targetYearMinutes: null,
    deltaMinutes: 120,
    scheduleGapMinutes: 120,
    lostMinutes: 0,
  },
  credits: [{ id: "c-tema", date: "2026-10-02", name: "Temadag", minutes: 120 }],
  masterLessonIds: [],
};

/** The drill-down into 7A: that group alone, its breakdowns, every pupil of it. */
export const DELIVERED_DRILL_7A: DeliveredCoverageResponse = {
  ...DELIVERED_OVERVIEW,
  groups: [group7A([idhDetail, maDetail, noneDetail])],
  pupils: [
    DELIVERED_OVERVIEW.pupils![0]!,
    {
      pupilId: ali,
      homeGroupId: class7A,
      gradeLevel: 7,
      lines: [{ ...maLine, groupDeficitMinutes: 252, sources: [{ studentGroupId: class7A, deliveredMinutes: 1140, sharedWith: [] }] }],
    },
  ],
  verdicts: verdicts.filter((v) => v.studentGroupId === undefined || v.studentGroupId === class7A),
};

/** What a teacher reads: the same groups, no pupil id, figure or verdict. */
export function asTeacher(response: DeliveredCoverageResponse): DeliveredCoverageResponse {
  return {
    ...response,
    pupilLevel: false,
    pupils: null,
    pupilsBelowPlanned: null,
    groups: response.groups.map((group) => ({
      ...group,
      lines: group.lines.map(({ pupils: _pupils, ...line }) => line),
    })),
    verdicts: response.verdicts.filter((verdict) => verdict.pupilId === undefined),
  };
}

/** Nothing published yet: empty lists and the one notice. */
export const DELIVERED_UNPUBLISHED: DeliveredCoverageResponse = {
  ...DELIVERED_OVERVIEW,
  published: null,
  groups: [],
  pupils: [],
  pupilsBelowPlanned: 0,
  credits: { count: 0, minutes: 0 },
  drift: null,
  verdicts: [
    {
      code: "TIMPLAN_NOT_PUBLISHED",
      severity: "notice",
      params: {},
      message: "Inget schema är publicerat till kalendern för läsåret.",
    },
  ],
};
