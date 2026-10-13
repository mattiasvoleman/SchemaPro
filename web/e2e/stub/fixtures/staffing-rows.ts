import type { HistoryChange, HistoryEntry } from "../../../lib/staffing-history-queries";
import type {
  StaffingPolicy,
  TeacherDuty,
  TeacherEmployment,
  TeacherEmploymentPeriod,
  TeacherQualification,
} from "../../../lib/types";
import { KIND, uid } from "../sessions";
import { addDays, AUTUMN_YEAR, stockholmInstant, TODAY, YEAR_END, YEAR_START } from "./calendar";
import { ADMIN, GROUPS, SUBJECTS, TEACHER_LIST, TEACHERS, YEAR } from "./world";

/**
 * Tjänstefördelningen of Exempelskolan as the gateway stores it: the policy,
 * this läsår's posts, the behörigheter and the uppdrag, and the versions the
 * log has written for them. staffing-load.ts computes the report from these
 * and world.ts's timplansposter, so the matrix, Min tjänst and the
 * uppdragsbeskrivning all print the same minutes.
 *
 * The rows are chosen for the states the pages draw: Bo is OVER (a 40 % post
 * and three Ma groups), Eva UNDER, Anna and Cecilia OK, David NO_TARGET (no
 * post yet); Eva's Historia behörighet stops at year 6, so her 8A is the
 * behörighetslucka; and Bild in 8A has no teacher and nobody left to take it
 * (its one bildlärare, Filip, is deactivated) — the short bottleneck.
 *
 * Ids are KIND.misc 5000–5999 (school-days.ts has a 4001).
 */

/** The school has chosen its riktmärke, so every post derives a target. */
export const STAFFING_POLICY: StaffingPolicy = {
  id: uid(KIND.misc, 5001),
  fullTimeTeachingMinutesPerWeek: 1080,
  fullTimeRegulatedHoursPerYear: 1360,
  fullTimeAnnualHours: 1767,
  workDaysPerYear: 194,
  semesterHoursPerWeek: 40,
  qualificationMode: "WARN",
  overAllocationMode: "WARN",
  overAllocationTolerancePercent: 10,
  loadModel: "MINUTES",
  // ALLOW, so /admin/generate is not blocked by the unstaffed Bild row.
  unstaffedGeneration: "ALLOW",
  shareEmploymentWithIntegrations: false,
};

// --- Posts -------------------------------------------------------------------

const employment = (
  n: number,
  userId: string,
  employmentPercent: number,
  contractKind: TeacherEmployment["contractKind"],
  signature: string,
  extra: Partial<TeacherEmployment> = {},
): TeacherEmployment => ({
  id: uid(KIND.misc, 5100 + n),
  userId,
  academicYearId: YEAR.id,
  employmentPercent,
  reductionPercent: 0,
  contractKind,
  teachingTargetMinutesPerWeek: null,
  signature,
  note: null,
  // The gateway lists every post with its periods (20261022120000).
  periods: [],
  ...extra,
});

/**
 * Anna's post changes from the Monday of week 2 in January: the
 * försteläraruppdrag shrinks to 70 % with a 10 % nedsättning. She teaches the
 * same 60 % of a post all year, so every stretch stays OK and the report's
 * figures are the ones they were, but the matrix steps (75 → 70), the drawer
 * lists the stretches, Min tjänst its periods and Historik the version.
 */
const ANNA_POST_ID = uid(KIND.misc, 5101);
export const ANNA_SPRING: TeacherEmploymentPeriod = {
  id: uid(KIND.misc, 5150),
  employmentId: ANNA_POST_ID,
  validFrom: addDays(YEAR_START, 21 * 7),
  validTo: null,
  employmentPercent: 70,
  reductionPercent: 10,
  teachingTargetMinutesPerWeek: null,
};

/** This läsår's posts, by userId as the gateway orders them. David has none. */
export const EMPLOYMENTS: TeacherEmployment[] = [
  employment(1, TEACHERS.anna.id, 75, "FERIE", "ALI", {
    reductionPercent: 15,
    note: "Nedsättning för försteläraruppdraget.",
    periods: [ANNA_SPRING],
  }),
  employment(2, TEACHERS.bo.id, 40, "FERIE", "BEK"),
  employment(3, TEACHERS.cecilia.id, 30, "SEMESTER", "CÅS"),
  // 80 %, as her Friday constraint in school-days.ts says.
  employment(5, TEACHERS.eva.id, 80, "FERIE", "EHO", { note: "Ledig fredagar." }),
];

// --- Behörigheter ------------------------------------------------------------

const qualification = (
  n: number,
  userId: string,
  subjectId: string,
  minGradeLevel: number,
  maxGradeLevel: number,
  kind: TeacherQualification["kind"],
  extra: Partial<TeacherQualification> = {},
): TeacherQualification => ({
  id: uid(KIND.misc, 5200 + n),
  userId,
  subjectId,
  minGradeLevel,
  maxGradeLevel,
  kind,
  validFrom: null,
  validTo: null,
  note: null,
  ...extra,
});

/** By userId, then subjectId, as the gateway orders them. */
export const QUALIFICATIONS: TeacherQualification[] = [
  qualification(1, TEACHERS.anna.id, SUBJECTS.sv.id, 7, 9, "LEGITIMATION"),
  qualification(2, TEACHERS.anna.id, SUBJECTS.en.id, 7, 9, "LEGITIMATION"),
  qualification(3, TEACHERS.bo.id, SUBJECTS.ma.id, 7, 9, "LEGITIMATION"),
  qualification(4, TEACHERS.cecilia.id, SUBJECTS.ma.id, 7, 9, "BEHORIG"),
  qualification(5, TEACHERS.cecilia.id, SUBJECTS.no.id, 7, 9, "LEGITIMATION"),
  qualification(6, TEACHERS.cecilia.id, SUBJECTS.m2.id, 7, 9, "TILLATEN", {
    validTo: YEAR_END,
    note: "Rektors beslut i väntan på legitimation.",
  }),
  qualification(7, TEACHERS.david.id, SUBJECTS.idh.id, 7, 9, "LEGITIMATION"),
  // Years 4–6 only: her Historia in 8A is the gap the matrix flags.
  qualification(8, TEACHERS.eva.id, SUBJECTS.so.id, 4, 6, "BEHORIG"),
  // Deactivated, so no capacity: Bild is the short bottleneck.
  qualification(9, TEACHERS.filip.id, SUBJECTS.bl.id, 7, 9, "LEGITIMATION"),
];

// --- Uppdrag -----------------------------------------------------------------

const duty = (
  n: number,
  userId: string,
  kind: TeacherDuty["kind"],
  label: string,
  minutesPerWeek: number,
  countsAsTeaching: boolean,
  extra: Partial<TeacherDuty> = {},
): TeacherDuty => {
  const row: TeacherDuty = {
    id: uid(KIND.misc, 5300 + n),
    userId,
    academicYearId: YEAR.id,
    kind,
    label,
    minutesPerWeek,
    countsAsTeaching,
    subjectId: null,
    studentGroupId: null,
    validFrom: null,
    validTo: null,
    slots: [],
    note: null,
    ...extra,
  };
  // blockedSlot: the previous release's field, which the gateway still serves.
  return { ...row, blockedSlot: row.slots[0] ?? null };
};

/**
 * By userId, kind (in the enum's order) and label, as the gateway orders
 * them. One undated with a time, one counted toward the target, and two with
 * a Från/Till, so every line the uppdrag list can print is printed.
 */
export const DUTIES: TeacherDuty[] = [
  duty(1, TEACHERS.anna.id, "MENTORSKAP", "Mentor 7A", 40, false, {
    studentGroupId: GROUPS.g7A.id,
    slots: [{ dayOfWeek: 2, startTime: "14:15", endTime: "14:55" }],
  }),
  duty(2, TEACHERS.anna.id, "FORSTELARARE", "Förstelärare i läsutveckling", 120, true, {
    subjectId: SUBJECTS.sv.id,
    note: "Leder ämneslagets arbete med läsförståelse i årskurs 7.",
  }),
  duty(3, TEACHERS.anna.id, "APT_KONFERENS", "APT och arbetslagsmöte", 60, false, {
    slots: [{ dayOfWeek: 3, startTime: "14:15", endTime: "15:15" }],
  }),
  duty(4, TEACHERS.bo.id, "RASTVAKT", "Rastvakt på skolgården", 30, false, {
    validTo: `${AUTUMN_YEAR}-12-18`,
    slots: [{ dayOfWeek: 1, startTime: "09:10", endTime: "09:25" }],
  }),
  duty(5, TEACHERS.cecilia.id, "VFU_HANDLEDNING", "Handledare för VFU-student", 60, false, {
    validFrom: `${AUTUMN_YEAR + 1}-01-11`,
    validTo: `${AUTUMN_YEAR + 1}-03-26`,
  }),
  duty(6, TEACHERS.eva.id, "AMNESANSVAR", "Ämnesansvar SO", 60, true, { subjectId: SUBJECTS.so.id }),
];

// --- Versions ----------------------------------------------------------------

/** A version's moment: days after the läsår began, never later than today. */
const stamp = (days: number, version: number) => {
  const date = addDays(YEAR_START, days);
  return stockholmInstant(date < TODAY ? date : TODAY, `08:${String(10 + version).padStart(2, "0")}`);
};

/** The fields a created row states, in the log's fixed order; nulls are not changes. */
const created = (fields: Array<[string, unknown]>): HistoryChange[] =>
  fields
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([field, after]) => ({ field, before: null, after }));

/**
 * A teacher's versions for this läsår, newest first: the post written a week
 * before term, each uppdrag the first days, an uppdrag's times as a version of
 * their own (the link table's trigger), and a nedsättning agreed later.
 */
export function historyOf(userId: string): HistoryEntry[] {
  const post = EMPLOYMENTS.find((row) => row.userId === userId) ?? null;
  const duties = DUTIES.filter((row) => row.userId === userId);
  const base = 5400 + 20 * TEACHER_LIST.findIndex((teacher) => teacher.id === userId);
  const entries: HistoryEntry[] = [];
  const add = (entry: Omit<HistoryEntry, "id" | "version" | "actorId" | "createdAt">, days: number) => {
    const version = entries.length + 1;
    entries.push({
      id: uid(KIND.misc, base + version),
      version,
      actorId: ADMIN.id,
      createdAt: stamp(days, version),
      ...entry,
    });
  };
  if (post) {
    add(
      {
        entity: "EMPLOYMENT",
        entityId: post.id,
        action: "CREATE",
        changes: created([
          ["employmentPercent", post.employmentPercent],
          // Every post starts without one; Anna's is a later version.
          ["reductionPercent", 0],
          ["contractKind", post.contractKind],
          ["teachingTargetMinutesPerWeek", post.teachingTargetMinutesPerWeek],
          ["signature", post.signature],
          ["noteChanged", post.note && post.reductionPercent === 0 ? true : null],
        ]),
      },
      -7,
    );
  }
  duties.forEach((row, index) => {
    add(
      {
        entity: "DUTY",
        entityId: row.id,
        action: "CREATE",
        changes: created([
          ["kind", row.kind],
          ["label", row.label],
          ["minutesPerWeek", row.minutesPerWeek],
          ["countsAsTeaching", row.countsAsTeaching],
          ["validFrom", row.validFrom],
          ["validTo", row.validTo],
          ["subjectId", row.subjectId],
          ["studentGroupId", row.studentGroupId],
          ["noteChanged", row.note ? true : null],
        ]),
      },
      index,
    );
    if (row.slots.length > 0) {
      add(
        {
          entity: "DUTY",
          entityId: row.id,
          action: "UPDATE",
          changes: [{ field: "slotCount", before: 0, after: row.slots.length }],
        },
        index,
      );
    }
  });
  if (post && (post.reductionPercent ?? 0) > 0) {
    add(
      {
        entity: "EMPLOYMENT",
        entityId: post.id,
        action: "UPDATE",
        changes: [
          { field: "reductionPercent", before: 0, after: post.reductionPercent },
          { field: "noteChanged", before: null, after: true },
        ],
      },
      21,
    );
  }
  for (const period of post?.periods ?? []) {
    add(
      {
        entity: "PERIOD",
        entityId: period.id,
        action: "CREATE",
        changes: created([
          ["validFrom", period.validFrom],
          ["validTo", period.validTo],
          ["employmentPercent", period.employmentPercent],
          ["reductionPercent", period.reductionPercent],
          ["teachingTargetMinutesPerWeek", period.teachingTargetMinutesPerWeek],
        ]),
        periodFrom: period.validFrom,
      },
      28,
    );
  }
  return entries.reverse();
}
