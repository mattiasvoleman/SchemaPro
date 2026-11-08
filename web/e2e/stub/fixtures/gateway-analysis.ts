import type {
  CostBasis,
  CostFigures,
  CostRate,
  KeyFigures,
  PayrollBasis,
  PayrollFile,
  SchoolPart,
  TeacherKeyFigures,
} from "../../../lib/analysis-types";
import { Reply, route, type GatewayContext, type GatewayRoute } from "../gateway-routes";
import { YEAR_END, YEAR_START } from "./calendar";
import { TEACHERS } from "./world";

/**
 * Analys och planering as the gateway answers it (src/analysis/): the
 * nyckeltal for the school and for five teachers, the cost basis per skoldel
 * and årskurs, a payroll basis for a period, and the school's skoldelar and
 * timkostnader. All of it is the administrator's; the stub keeps nothing between
 * requests, so a suite cannot leave a rate for the next.
 *
 * Anna is on a full-time post, Eva has no target (no post), and Cecilia is
 * outside every behörighet, so the table shows both ends of each column.
 * Bo's cost has no rate behind it (the vikarie's), so the cost basis shows an
 * unknown beside the known.
 */

const teacher = (id: string, over: Partial<TeacherKeyFigures>): TeacherKeyFigures => ({
  userId: id,
  teachingMinutesPerWeek: 840,
  dutyMinutesPerWeek: 0,
  countedMinutesPerWeek: 840,
  targetMinutesPerWeek: 1080,
  percentOfTarget: 78,
  status: "UNDER",
  scheduledMinutesPerWeek: null,
  teachingHoursPerYear: 560,
  employmentPercent: 100,
  groups: 4,
  pupils: 90,
  qualifiedShare: 1,
  ...over,
});

const KEY_FIGURES: KeyFigures = {
  academicYearId: "",
  year: { startDate: YEAR_START, endDate: YEAR_END },
  employmentOn: YEAR_START,
  loadModel: "MINUTES",
  school: {
    pupils: 120,
    teachers: 5,
    teachingMinutesPerWeek: 3900,
    teachingHoursPerYear: 2600,
    fullTimeTeachingMinutesPerWeek: 1080,
    teachingFte: 3.61,
    teachingFtePer100Pupils: 3.01,
    teachersPer100Pupils: 4.17,
    pupilsPerTeacher: 24,
    qualificationsRecorded: true,
    qualifiedMinutesPerWeek: 3300,
    unqualifiedMinutesPerWeek: 600,
    qualifiedShare: 0.8462,
    unstaffedMinutesPerWeek: 0,
    employmentFte: 4.3,
    employmentFtePer100Pupils: 3.58,
  },
  teachers: [
    teacher(TEACHERS.anna.id, {}),
    teacher(TEACHERS.bo.id, { teachingMinutesPerWeek: 360, percentOfTarget: 67, pupils: 40, employmentPercent: 50 }),
    teacher(TEACHERS.cecilia.id, { qualifiedShare: 0, pupils: 60, employmentPercent: 80 }),
    teacher(TEACHERS.david.id, { teachingMinutesPerWeek: 1200, percentOfTarget: 111, status: "OVER", pupils: 110 }),
    teacher(TEACHERS.eva.id, { teachingMinutesPerWeek: 660, targetMinutesPerWeek: null, percentOfTarget: null, status: "NO_TARGET", employmentPercent: null }),
  ],
  notices: [],
};

const figures = (over: Partial<CostFigures> = {}): CostFigures => ({
  pupils: 60,
  hours: { TEACHER: 1200.5, UNQUALIFIED_TEACHER: 80, SUBSTITUTE: 10.25 },
  hoursPerPupil: 21.5,
  cost: 520000,
  costPerPupil: 8667,
  ...over,
});

const PARTS: SchoolPart[] = [
  { id: "00000000-0000-4000-8000-0000000a0001", name: "Mellanstadiet", account: "4020", gradeFrom: 4, gradeTo: 6 },
  { id: "00000000-0000-4000-8000-0000000a0002", name: "Högstadiet", account: "4030", gradeFrom: 7, gradeTo: 9 },
];
const RATES: CostRate[] = [
  { category: "TEACHER", hourlyCost: 420 },
  { category: "SUBSTITUTE", hourlyCost: 310 },
];

function admin(context: GatewayContext): Reply | null {
  if (!context.person) return new Reply(401, { message: "Not authenticated." });
  return context.person.persona === "admin" ? null : new Reply(403, { message: "Forbidden." });
}

function keyFigures(context: GatewayContext): KeyFigures | Reply {
  const refused = admin(context);
  if (refused) return refused;
  // The grundschema's undervisning is made only when asked for (schedule=true): Anna's lies a little under her post's, Eva has none laid.
  const schedule = context.query.get("schedule") === "true";
  return {
    ...KEY_FIGURES,
    academicYearId: context.query.get("academicYearId") ?? "",
    teachers: KEY_FIGURES.teachers!.map((one) => ({
      ...one,
      scheduledMinutesPerWeek: schedule ? (one.userId === TEACHERS.eva.id ? 0 : Math.max(0, one.teachingMinutesPerWeek - 60)) : null,
    })),
  };
}

function costBasis(context: GatewayContext): CostBasis | Reply {
  const refused = admin(context);
  if (refused) return refused;
  return {
    academicYearId: context.query.get("academicYearId") ?? "",
    year: { startDate: YEAR_START, endDate: YEAR_END },
    gradeNumbering: "NIOARIG",
    substitutes: { from: YEAR_START, to: YEAR_END },
    rates: RATES,
    missingRates: [],
    parts: [{ schoolPartId: PARTS[1]!.id, name: "Högstadiet", account: "4030", ...figures({ pupils: 120 }) }],
    cells: [
      { schoolPartId: PARTS[1]!.id, gradeLevel: 7, ...figures() },
      { schoolPartId: PARTS[1]!.id, gradeLevel: 8, ...figures({ cost: null, costPerPupil: null }) },
    ],
    total: figures({ pupils: 120 }),
    notices: [],
  };
}

function payrollBasis(context: GatewayContext): PayrollBasis | Reply {
  const refused = admin(context);
  if (refused) return refused;
  return {
    academicYearId: context.query.get("academicYearId") ?? "",
    from: context.query.get("from") ?? YEAR_START,
    to: context.query.get("to") ?? YEAR_END,
    parts: PARTS,
    people: [{ userId: TEACHERS.anna.id, kind: "STAFF", teachingMinutes: 1200, dutyMinutes: 120, substituteMinutes: 0, employmentPercent: 100 }],
    lines: [{ userId: TEACHERS.anna.id, kind: "STAFF", schoolPartId: PARTS[1]!.id, account: "4030", teachingMinutes: 1200, dutyMinutes: 120, substituteMinutes: 0 }],
    protectedInAnswer: 0,
    notices: [],
  };
}

function payrollFile(context: GatewayContext): PayrollFile | Reply {
  const refused = admin(context);
  if (refused) return refused;
  const body = (context.body ?? {}) as { from?: string; to?: string; format?: string };
  return {
    filename: `loneunderlag-${body.from}-${body.to}.${body.format === "XLSX" ? "xlsx" : "csv"}`,
    contentType: body.format === "XLSX" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "text/csv; charset=windows-1252",
    contentBase64: "U2lnbmF0dXI=",
    notices: [],
    protectedInFile: 0,
  };
}

export const analysisRoutes: GatewayRoute[] = [
  route("GET", "/api/v1/analysis/key-figures", keyFigures),
  route("GET", "/api/v1/analysis/cost-basis", costBasis),
  route("GET", "/api/v1/analysis/payroll-basis", payrollBasis),
  route("POST", "/api/v1/analysis/payroll-basis/export", payrollFile),
  route("GET", "/api/v1/analysis/school-parts", (context) => admin(context) ?? PARTS),
  route("GET", "/api/v1/analysis/cost-rates", (context) => admin(context) ?? RATES),
];
