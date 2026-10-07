import { Prisma, type PrismaClient } from '@prisma/client';
import type { PrismaMock } from './prisma-mock';

/**
 * A small school as rows, behind a transaction that answers the rollover's
 * and the activation's reads from them and RECORDS every call.
 *
 * The prisma mock auto-vivifies a jest.fn for any call, which is right for a
 * spec that stubs one answer. The rollover reads some twenty tables in a row
 * and computes its plan from all of them, so stubbing them one by one would
 * test the stubs. This answers each read from the rows, with a `where`
 * matcher just wide enough for the shapes the readers use (equality, `in`,
 * `not`, the comparisons, null, AND/OR/NOT, and the relations the roster
 * readers filter through: a pupil's `studentGroup`, a membership's `student`,
 * a year-scoped read's `school`, a row's own to-many list), and keeps every
 * call — which is what year-rollover.service.spec.ts's write audit inspects.
 * Any other relation filter passes the row, or throws in a strict world.
 *
 * Writes are recorded, and the creates are also applied, so a second read
 * sees them (an activation after a rollover).
 */

export type Row = Record<string, unknown>;

export interface RecordedCall {
  model: string;
  method: string;
  args: unknown;
  /** For $queryRaw: the statement's text with its parameters as `?`. */
  sql?: string;
  values?: unknown[];
}

const day = (value: string): Date => new Date(`${value}T00:00:00.000Z`);
const clock = (value: string): Date => new Date(`1970-01-01T${value}:00.000Z`);

export const IDS = {
  school: '33333333-3333-4333-8333-333333333333',
  yearA: 'a0000000-0000-4000-8000-00000000000a',
  g7a: 'b0000000-0000-4000-8000-000000000007',
  g8a: 'b0000000-0000-4000-8000-000000000008',
  g9a: 'b0000000-0000-4000-8000-000000000009',
  gMa7: 'b0000000-0000-4000-8000-0000000000a7',
  p7a1: 'c0000000-0000-4000-8000-000000000071',
  p7a2: 'c0000000-0000-4000-8000-000000000072',
  p8a1: 'c0000000-0000-4000-8000-000000000081',
  p9a1: 'c0000000-0000-4000-8000-000000000091',
  pGone: 'c0000000-0000-4000-8000-0000000000ff',
  anna: 'd0000000-0000-4000-8000-00000000000a',
  bo: 'd0000000-0000-4000-8000-00000000000b',
  ma: 'e0000000-0000-4000-8000-0000000000aa',
  sv: 'e0000000-0000-4000-8000-0000000000bb',
  tk: 'e0000000-0000-4000-8000-0000000000cc',
  hostlov: 'f0000000-0000-4000-8000-000000000001',
  jullov: 'f0000000-0000-4000-8000-000000000002',
  pasklov: 'f0000000-0000-4000-8000-000000000003',
  vecka53: 'f0000000-0000-4000-8000-000000000004',
  rule7a: 'f1000000-0000-4000-8000-000000000001',
  draftPlan: 'f2000000-0000-4000-8000-000000000001',
  cecilia: 'd0000000-0000-4000-8000-00000000000c',
  guardian: 'd0000000-0000-4000-8000-0000000000ee',
  empAnna: 'f3000000-0000-4000-8000-00000000000a',
  empBo: 'f3000000-0000-4000-8000-00000000000b',
  empCecilia: 'f3000000-0000-4000-8000-00000000000c',
  dutyRast: 'f4000000-0000-4000-8000-000000000001',
  dutyMentor7a: 'f4000000-0000-4000-8000-000000000002',
  dutyMentor9a: 'f4000000-0000-4000-8000-000000000003',
  dutyStudie9a: 'f4000000-0000-4000-8000-000000000004',
  dutyAmne: 'f4000000-0000-4000-8000-000000000005',
  dutyBo: 'f4000000-0000-4000-8000-000000000006',
  dutyApt: 'f4000000-0000-4000-8000-000000000007',
  dutyGuardian: 'f4000000-0000-4000-8000-000000000008',
  slotRast: 'f5000000-0000-4000-8000-000000000001',
  slotMentor: 'f5000000-0000-4000-8000-000000000002',
  slotApt: 'f5000000-0000-4000-8000-000000000003',
} as const;

/** The national grundskola version P2's plans hang on: stadier 1–3, 4–6, 7–9. */
export const GRUNDSKOLA_2024 = { schoolForm: 'GRUNDSKOLA', appliesFromCohortTerm: 'HT2024' } as const;

/**
 * 2026/27, active: 7A, 8A and 9A with pupils, a teaching group Ma7 with a 7A,
 * an 8A and a 9A pupil, timplansposter (one taught by Anna, one by Bo who has
 * left, one with Anna twice, a vårtermin teknik that ends the day the year
 * ends), four lov and a weekly class rule. Its åk 7–9 follow a DRAFT local
 * timplan (no entries, no decided plan in the school), so the rollover
 * carries two timplan rows with the 7A and 8A cohorts, åk 7 keeps its own,
 * and the G default still comes from the classes.
 */
export function defaultRolloverRows(): Record<string, Row[]> {
  const subject = (id: string, name: string) => ({ id, name });
  return {
    academicYear: [
      {
        id: IDS.yearA,
        schoolId: IDS.school,
        name: '2026/27',
        startDate: day('2026-08-17'),
        endDate: day('2027-06-11'),
        isActive: true,
        predecessorId: null,
        graduatingGradeLevel: null,
      },
    ],
    studentGroup: [
      { id: IDS.g7a, academicYearId: IDS.yearA, name: '7A', kind: 'CLASS', gradeLevel: 7, predecessorId: null },
      { id: IDS.g8a, academicYearId: IDS.yearA, name: '8A', kind: 'CLASS', gradeLevel: 8, predecessorId: null },
      { id: IDS.g9a, academicYearId: IDS.yearA, name: '9A', kind: 'CLASS', gradeLevel: 9, predecessorId: null },
      { id: IDS.gMa7, academicYearId: IDS.yearA, name: 'Ma7 grupp 1', kind: 'TEACHING_GROUP', gradeLevel: 7, predecessorId: null },
    ],
    user: [
      { id: IDS.p7a1, role: 'STUDENT', isActive: true, studentGroupId: IDS.g7a },
      { id: IDS.p7a2, role: 'STUDENT', isActive: true, studentGroupId: IDS.g7a },
      { id: IDS.p8a1, role: 'STUDENT', isActive: true, studentGroupId: IDS.g8a },
      { id: IDS.p9a1, role: 'STUDENT', isActive: true, studentGroupId: IDS.g9a },
      { id: IDS.pGone, role: 'STUDENT', isActive: false, studentGroupId: IDS.g7a },
      { id: IDS.anna, role: 'TEACHER', isActive: true, studentGroupId: null },
      { id: IDS.bo, role: 'TEACHER', isActive: false, studentGroupId: null },
    ],
    studentGroupMember: [
      { studentGroupId: IDS.gMa7, studentId: IDS.p7a1, student: { studentGroupId: IDS.g7a } },
      { studentGroupId: IDS.gMa7, studentId: IDS.p8a1, student: { studentGroupId: IDS.g8a } },
      { studentGroupId: IDS.gMa7, studentId: IDS.p9a1, student: { studentGroupId: IDS.g9a } },
    ],
    teachingRequirement: [
      requirement('r1', IDS.g7a, IDS.ma, subject(IDS.ma, 'Matematik'), { teacherId: IDS.anna }),
      requirement('r2', IDS.g7a, IDS.sv, subject(IDS.sv, 'Svenska'), { teacherId: IDS.bo }),
      requirement('r3', IDS.g8a, IDS.ma, subject(IDS.ma, 'Matematik'), { teacherId: IDS.anna, coTeacherId: IDS.anna }),
      requirement('r4', IDS.g9a, IDS.ma, subject(IDS.ma, 'Matematik'), { teacherId: IDS.anna }),
      requirement('r5', IDS.gMa7, IDS.ma, subject(IDS.ma, 'Matematik'), { teacherId: IDS.anna }),
      requirement('r6', IDS.g7a, IDS.tk, subject(IDS.tk, 'Teknik'), {
        startDate: day('2027-01-11'),
        endDate: day('2027-06-11'),
        recurrence: 'ODD_WEEKS',
      }),
    ],
    schoolBreak: [
      lov(IDS.hostlov, 'Höstlov', '2026-10-26', '2026-10-30'),
      lov(IDS.jullov, 'Jullov', '2026-12-21', '2027-01-06'),
      lov(IDS.pasklov, 'Påsklov', '2027-03-29', '2027-04-02'),
      lov(IDS.vecka53, 'Studiedagar v53', '2026-12-28', '2026-12-30'),
    ],
    availabilityConstraint: [
      {
        id: IDS.rule7a,
        resourceType: 'STUDENT_GROUP',
        studentGroupId: IDS.g7a,
        dayOfWeek: 5,
        date: null,
        startTime: clock('13:00'),
        endTime: clock('15:00'),
        type: 'UNAVAILABLE',
        reason: 'Elevens val',
        minGradeLevel: null,
        maxGradeLevel: null,
      },
      slot(IDS.slotRast, IDS.anna, 2, '10:00', '10:20'),
    ],
    frameTime: [
      { minGradeLevel: 7, maxGradeLevel: 9, dayOfWeek: null, startTime: clock('08:00'), endTime: clock('15:30') },
    ],
    localTimplan: [
      {
        id: IDS.draftPlan,
        name: 'Utkast 2027',
        schoolForm: 'GRUNDSKOLA',
        status: 'DRAFT',
        decidedAt: null,
        createdAt: new Date('2027-02-01T00:00:00Z'),
        nationalVersion: GRUNDSKOLA_2024,
        entries: [],
      },
    ],
    academicYearTimplan: [7, 8, 9].map((gradeLevel) => ({
      schoolId: IDS.school,
      academicYearId: IDS.yearA,
      gradeLevel,
      localTimplanId: IDS.draftPlan,
    })),
    subject: [subject(IDS.ma, 'Matematik'), subject(IDS.sv, 'Svenska'), subject(IDS.tk, 'Teknik')],
    staffingPolicy: [],
    teacherSubjectQualification: [],
    masterLesson: [{ academicYearId: IDS.yearA, isLocked: true }, { academicYearId: IDS.yearA, isLocked: false }],
    lunchSitting: [{ academicYearId: IDS.yearA, isGenerated: false }],
    // Anna's post and her rastvakt with its slot, as the services write them:
    // a rollover without carryStaffing only counts them (one duty, one slot,
    // no mentorskap); staffingRows() gives the school a fuller staff.
    teacherEmployment: [
      {
        id: IDS.empAnna,
        schoolId: IDS.school,
        userId: IDS.anna,
        academicYearId: IDS.yearA,
        employmentPercent: new Prisma.Decimal('100.000'),
        reductionPercent: new Prisma.Decimal('0.000'),
        contractKind: 'FERIE',
        teachingTargetMinutesPerWeek: null,
        signature: 'AN',
        note: null,
      },
    ],
    teacherDuty: [
      duty(IDS.dutyRast, IDS.anna, 'RASTVAKT', 'Rastvakt', 30, { blockedConstraintId: IDS.slotRast, note: 'rast' }),
    ],
  };

  function requirement(id: string, studentGroupId: string, subjectId: string, subjectRow: Row, extra: Row): Row {
    return {
      id: `00000000-0000-4000-8000-0000000000${id.slice(1).padStart(2, '0')}`,
      academicYearId: IDS.yearA,
      subjectId,
      studentGroupId,
      teacherId: null,
      coTeacherId: null,
      lessonsPerWeek: 3,
      minutesPerLesson: 60,
      minutesBefore: 0,
      minutesAfter: 0,
      teacherLoadPercent: 100,
      coTeacherLoadPercent: 100,
      recurrence: 'ALL_WEEKS',
      startDate: null,
      endDate: null,
      subject: { name: subjectRow['name'] },
      ...extra,
    };
  }
  function slot(id: string, userId: string, dayOfWeek: number, startTime: string, endTime: string): Row {
    return teacherSlot(id, userId, dayOfWeek, startTime, endTime);
  }
  function lov(id: string, name: string, startDate: string, endDate: string): Row {
    return {
      id,
      academicYearId: IDS.yearA,
      name,
      kind: 'HOLIDAY',
      startDate: day(startDate),
      endDate: day(endDate),
      minGradeLevel: null,
      maxGradeLevel: null,
    };
  }
}

/** An uppdrag row as TeacherDutiesService writes it. */
function duty(id: string, userId: string, kind: string, label: string, minutesPerWeek: number, extra: Row = {}): Row {
  return {
    id,
    schoolId: IDS.school,
    userId,
    academicYearId: IDS.yearA,
    kind,
    label,
    minutesPerWeek,
    countsAsTeaching: false,
    subjectId: null,
    studentGroupId: null,
    blockedConstraintId: null,
    note: null,
    ...extra,
  };
}

/** A duty's slot as the Fas 2 shape has it: weekly, UNAVAILABLE, the teacher's own, "Uppdrag". */
function teacherSlot(id: string, userId: string, dayOfWeek: number, startTime: string, endTime: string): Row {
  return {
    id,
    resourceType: 'TEACHER',
    userId,
    roomId: null,
    studentGroupId: null,
    dayOfWeek,
    date: null,
    startTime: clock(startTime),
    endTime: clock(endTime),
    type: 'UNAVAILABLE',
    reason: 'Uppdrag',
    minGradeLevel: null,
    maxGradeLevel: null,
  };
}

/**
 * The default school with a staff worth carrying (staffing Fas 5):
 *
 *  - Anna, active: a post with a 20 % nedsättning, her rastvakt (Tuesday
 *    10:00–10:20) and "Mentor 7A" for 7A with a Monday slot — which follows
 *    7A to 8A and becomes "Mentor 8A".
 *  - Cecilia, active: a post with a target override; "Mentor 9A" (9A
 *    graduates: not carried), "Studiehandledning 9A" on 9A (carried without
 *    its group), ämnesansvar in Ma, and an APT whose slot PostgREST put off
 *    the five-minute grid (15:02–16:00: carried without it).
 *  - Bo, inactive: a post and a rastvakt, neither carried.
 *  - A guardian with an uppdrag only PostgREST could have written: not staff.
 *
 * Every source row carries a value no default would give, and a note naming
 * it, so the registry audit can find each written row's source.
 */
export function staffingRows(rows: Record<string, Row[]> = defaultRolloverRows()): Record<string, Row[]> {
  rows['user']!.push(
    { id: IDS.cecilia, role: 'TEACHER', isActive: true, studentGroupId: null },
    { id: IDS.guardian, role: 'GUARDIAN', isActive: true, studentGroupId: null },
  );
  const post = (id: string, userId: string, extra: Row): Row => ({
    id,
    schoolId: IDS.school,
    userId,
    academicYearId: IDS.yearA,
    employmentPercent: new Prisma.Decimal('100.000'),
    reductionPercent: new Prisma.Decimal('0.000'),
    contractKind: 'FERIE',
    teachingTargetMinutesPerWeek: null,
    signature: null,
    note: null,
    ...extra,
  });
  rows['teacherEmployment'] = [
    post(IDS.empAnna, IDS.anna, { employmentPercent: new Prisma.Decimal('90.500'), reductionPercent: new Prisma.Decimal('20.000'), signature: 'AN', note: 'anna' }),
    post(IDS.empBo, IDS.bo, { signature: 'BO', note: 'bo' }),
    post(IDS.empCecilia, IDS.cecilia, {
      employmentPercent: new Prisma.Decimal('80.000'),
      contractKind: 'SEMESTER',
      teachingTargetMinutesPerWeek: 700,
      signature: 'CE',
      note: 'cecilia',
    }),
  ];
  rows['teacherDuty'] = [
    duty(IDS.dutyRast, IDS.anna, 'RASTVAKT', 'Rastvakt', 30, { blockedConstraintId: IDS.slotRast, note: 'rast' }),
    duty(IDS.dutyMentor7a, IDS.anna, 'MENTORSKAP', 'Mentor 7A', 60, {
      studentGroupId: IDS.g7a,
      blockedConstraintId: IDS.slotMentor,
      countsAsTeaching: true,
      note: 'mentor 7a',
    }),
    duty(IDS.dutyMentor9a, IDS.cecilia, 'MENTORSKAP', 'Mentor 9A', 60, { studentGroupId: IDS.g9a, note: 'mentor 9a' }),
    duty(IDS.dutyStudie9a, IDS.cecilia, 'ANNAT', 'Studiehandledning 9A', 30, { studentGroupId: IDS.g9a, note: 'studie' }),
    duty(IDS.dutyAmne, IDS.cecilia, 'AMNESANSVAR', 'Ämnesansvar Ma', 40, { subjectId: IDS.ma, note: 'amne' }),
    duty(IDS.dutyBo, IDS.bo, 'RASTVAKT', 'Rastvakt', 20, { note: 'bo' }),
    duty(IDS.dutyApt, IDS.cecilia, 'APT_KONFERENS', 'APT', 120, { blockedConstraintId: IDS.slotApt, note: 'apt' }),
    duty(IDS.dutyGuardian, IDS.guardian, 'ANNAT', 'Föräldraråd', 15, { note: 'guardian' }),
  ];
  rows['availabilityConstraint']!.push(
    teacherSlot(IDS.slotMentor, IDS.anna, 1, '08:00', '08:30'),
    teacherSlot(IDS.slotApt, IDS.cecilia, 2, '15:02', '16:00'),
  );
  return rows;
}

// ---- the schema's relations, from the generated client's DMMF

const MODELS = new Map(Prisma.dmmf.datamodel.models.map((model) => [model.name, model]));
const dmmfName = (delegate: string): string => delegate.charAt(0).toUpperCase() + delegate.slice(1);
const delegateOf = (model: string): string => model.charAt(0).toLowerCase() + model.slice(1);

/**
 * The delegate a relation field of `model` points at (`school.academicYears`
 * → `academicYear`), or undefined when the field is a column or unknown.
 */
export function relationTarget(model: string, field: string): string | undefined {
  const found = MODELS.get(dmmfName(model))?.fields.find((candidate) => candidate.name === field);
  return found && found.kind === 'object' ? delegateOf(found.type) : undefined;
}

/**
 * The rows a to-many relation of `row` holds: the list on the row when the
 * fixture put one there (a lesson's extraGroups), else the related table's
 * rows that name it by `${model}Id` (a year's studentGroups and masterLessons).
 */
function relatedRows(row: Row, model: string, field: string, table: (model: string) => Row[]): Row[] | undefined {
  if (Array.isArray(row[field])) return row[field] as Row[];
  if (row[field] !== undefined) return undefined;
  const target = relationTarget(model, field);
  if (!target) return undefined;
  return table(target).filter((candidate) => candidate[`${model}Id`] === row['id']);
}

/** How `matches` resolves a relation filter: the row's model and the world's tables. */
export interface MatchContext {
  model: string;
  table: (model: string) => Row[];
  /**
   * Throw on a filter that cannot be evaluated instead of letting the row
   * through. The equivalence world runs strict: a relation filter the fake
   * silently passed is a reader's filter that no test exercised.
   */
  strict: boolean;
}

const OPERATORS = new Set(['in', 'notIn', 'not', 'gt', 'gte', 'lt', 'lte', 'equals']);

const comparable = (value: unknown): unknown => (value instanceof Date ? value.getTime() : value);

function scalarMatches(value: unknown, filter: Row): boolean {
  return Object.entries(filter).every(([operator, operand]) => {
    const [x, y] = [comparable(value), comparable(operand)];
    switch (operator) {
      case 'in':
        return (operand as unknown[]).map(comparable).includes(x);
      case 'notIn':
        return !(operand as unknown[]).map(comparable).includes(x);
      case 'equals':
        return operand === null ? value === null || value === undefined : x === y;
      case 'not':
        if (operand === null) return value !== null && value !== undefined;
        if (typeof operand === 'object' && !(operand instanceof Date)) return !scalarMatches(value, operand as Row);
        return x !== y;
      case 'gt':
        return x !== null && x !== undefined && (x as number) > (y as number);
      case 'gte':
        return x !== null && x !== undefined && (x as number) >= (y as number);
      case 'lt':
        return x !== null && x !== undefined && (x as number) < (y as number);
      case 'lte':
        return x !== null && x !== undefined && (x as number) <= (y as number);
      default:
        return true;
    }
  });
}

/**
 * The one-to-one relations the roster readers filter through, joined from
 * the rows as they are now: a pupil's home class (`studentGroup`), a
 * membership's pupil (`student`), and the school of a year-scoped read
 * (`school: { academicYears: { some } }`), which in this one-school world is
 * "the year exists".
 */
function relationMatches(row: Row, key: string, wanted: unknown, context: MatchContext): boolean | undefined {
  const nested = (model: string, target: Row | undefined): boolean => {
    if (wanted === null) return target === undefined;
    if (wanted === undefined) return true;
    return target !== undefined && matches(target, wanted as Row, { ...context, model });
  };
  if (context.model === 'user' && key === 'studentGroup') {
    return nested('studentGroup', context.table('studentGroup').find((group) => group['id'] === row['studentGroupId']));
  }
  if (context.model === 'studentGroupMember' && key === 'student') {
    return nested('user', context.table('user').find((user) => user['id'] === row['studentId']));
  }
  if (key === 'school' && wanted !== null && typeof wanted === 'object') {
    const filter = wanted as Row;
    const keys = Object.keys(filter);
    if (keys.length === 1 && keys[0] === 'academicYears') {
      const some = (filter['academicYears'] as Row | undefined)?.['some'] as Row | undefined;
      if (some !== undefined && Object.keys(filter['academicYears'] as Row).length === 1) {
        return context.table('academicYear').some((year) => matches(year, some, { ...context, model: 'academicYear' }));
      }
    }
  }
  // A to-one relation by `is`/`isNot`: forward through `${key}Id`, or one of
  // the back-relations a year-scoped read filters on (a duty's blocked slot).
  if (wanted !== null && typeof wanted === 'object' && ('is' in (wanted as Row) || 'isNot' in (wanted as Row))) {
    const filter = wanted as Row;
    const back: Record<string, (subject: Row) => Row | undefined> = {
      'availabilityConstraint.teacherDuty': (subject) =>
        context.table('teacherDuty').find((duty) => duty['blockedConstraintId'] === subject['id']),
    };
    const resolve = back[`${context.model}.${key}`];
    const forward = typeof row[`${key}Id`] === 'string' || row[`${key}Id`] === null;
    if (resolve || forward) {
      const target = resolve ? resolve(row) : context.table(key).find((candidate) => candidate['id'] === row[`${key}Id`]);
      const test = (inner: unknown) =>
        inner === null ? target === undefined : target !== undefined && matches(target, inner as Row, { ...context, model: key });
      return ('is' in filter ? test(filter['is']) : true) && ('isNot' in filter ? !test(filter['isNot']) : true);
    }
  }
  // A to-many relation: held on the row itself (a lesson's extraGroups), or
  // the related table's rows that name this one (a year's studentGroups).
  if (wanted !== null && typeof wanted === 'object' && Array.isArray(row[key] ?? [])) {
    const filter = wanted as Row;
    const list = relatedRows(row, context.model, key, context.table) ?? ((row[key] ?? []) as Row[]);
    const keys = Object.keys(filter);
    if (keys.length === 1 && (keys[0] === 'some' || keys[0] === 'none' || keys[0] === 'every')) {
      const inner = filter[keys[0]] as Row;
      const hit = (item: Row) => matches(item, inner, { ...context, model: relationTarget(context.model, key) ?? key });
      if (keys[0] === 'some') return list.some(hit);
      if (keys[0] === 'none') return !list.some(hit);
      return list.every(hit);
    }
  }
  return undefined;
}

export function matches(row: Row, where: Row | undefined, context?: MatchContext): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, wanted]) => {
    if (key === 'AND') return [wanted].flat().every((part) => matches(row, part as Row, context));
    if (key === 'OR') return (wanted as Row[]).some((part) => matches(row, part, context));
    if (key === 'NOT') return ![wanted].flat().some((part) => matches(row, part as Row, context));
    // A compound unique (`academicYearId_gradeLevel: { … }`): every part must match.
    if (!(key in row) && key.includes('_') && wanted !== null && typeof wanted === 'object' && !(wanted instanceof Date)) {
      return matches(row, wanted as Row, context);
    }
    if (context) {
      const joined = relationMatches(row, key, wanted, context);
      if (joined !== undefined) return joined;
    }
    const value = row[key];
    if (wanted === null) return value === null || value === undefined;
    if (wanted instanceof Date) return value instanceof Date && value.getTime() === wanted.getTime();
    if (typeof wanted === 'object') {
      const filter = wanted as Row;
      if (Object.keys(filter).every((operator) => OPERATORS.has(operator))) return scalarMatches(value, filter);
      // A relation filter this fake does not model.
      if (context?.strict) {
        throw new Error(`rollover world: cannot evaluate ${context.model}.${key} ${JSON.stringify(filter)}`);
      }
      return true;
    }
    return value === wanted;
  });
}

let sequence = 0;
const freshId = (): string =>
  `90000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;

export interface RolloverWorld {
  rows: Record<string, Row[]>;
  calls: RecordedCall[];
  tx: PrismaClient;
  /** Answers a $queryRaw; the default returns the year's bounds for a year read and [] otherwise. */
  queryRaw: (sql: string, values: unknown[]) => unknown[];
}

export function givenRolloverWorld(
  rows: Record<string, Row[]> = defaultRolloverRows(),
  options: { strict?: boolean } = {},
): RolloverWorld {
  const calls: RecordedCall[] = [];
  const world: RolloverWorld = {
    rows,
    calls,
    tx: undefined as unknown as PrismaClient,
    queryRaw: (sql, values) => {
      if (/FROM "AcademicYears"/.test(sql)) {
        return (rows['academicYear'] ?? []).filter((year) => year['id'] === values[0]);
      }
      return [];
    },
  };
  const table = (model: string): Row[] => (rows[model] ??= []);
  const model = (name: string) =>
    new Proxy(
      {} as Record<string, unknown>,
      {
        get(target: Record<string, unknown>, method) {
          if (typeof method !== 'string') return undefined;
          // A spec may replace one method (`world.tx.academicYear.create = …`).
          if (method in target) return target[method];
          return async (args: Row = {}) => {
            calls.push({ model: name, method, args });
            const where = args['where'] as Row | undefined;
            // The two relations the readers select, joined from the rows as they are now.
            // A selected to-many relation with its own `where`/`take` (a plan's
            // grade-0 entries): filtered here, as the database would.
            const project = (row: Row, select = args['select'] as Row | undefined, model = name): Row => {
              if (!select) return row;
              const out = { ...row };
              for (const [field, spec] of Object.entries(select)) {
                // A relation count (`_count: { select: { academicYears: { where } } }`),
                // counted over the related rows as the database's join would.
                if (field === '_count' && spec !== null && typeof spec === 'object') {
                  const counted: Row = {};
                  for (const [relation, how] of Object.entries(((spec as Row)['select'] ?? {}) as Row)) {
                    const related = relatedRows(row, model, relation, table) ?? [];
                    const inner = how !== null && typeof how === 'object' ? ((how as Row)['where'] as Row | undefined) : undefined;
                    const target = relationTarget(model, relation) ?? relation;
                    counted[relation] = related.filter((item) => matches(item, inner, { model: target, table, strict: options.strict === true })).length;
                  }
                  out[field] = counted;
                  continue;
                }
                // A strict world joins a selected to-one relation the row
                // names by `${field}Id` (a lesson's or a group's academicYear).
                if (options.strict && out[field] === undefined && typeof out[`${field}Id`] === 'string' && spec !== null && typeof spec === 'object') {
                  const target = table(field).find((candidate) => candidate['id'] === out[`${field}Id`]);
                  out[field] = target ? project(target, (spec as Row)['select'] as Row | undefined, relationTarget(model, field) ?? field) : null;
                  continue;
                }
                // A selected to-one relation the fixture put on the row (a
                // lesson's school): projected further, for its own `_count`.
                if (out[field] !== null && typeof out[field] === 'object' && !Array.isArray(out[field]) && !(out[field] instanceof Date) && spec !== null && typeof spec === 'object' && (spec as Row)['select']) {
                  out[field] = project(out[field] as Row, (spec as Row)['select'] as Row, relationTarget(model, field) ?? field);
                  continue;
                }
                if (!Array.isArray(out[field]) || spec === null || typeof spec !== 'object') continue;
                const { where: inner, take } = spec as { where?: Row; take?: number };
                let list = (out[field] as Row[]).filter((item) => matches(item, inner, { model: field, table, strict: options.strict === true }));
                if (take !== undefined) list = list.slice(0, take);
                out[field] = list;
              }
              // And hands back only what was selected, as the database does: a
              // reader that uses a column it never asked for fails here.
              if (options.strict) {
                for (const key of Object.keys(out)) if (!(key in select)) delete out[key];
              }
              return out;
            };
            const joined = (row: Row): Row =>
              project(
                name === 'studentGroupMember'
                  ? { ...row, student: { studentGroupId: table('user').find((user) => user['id'] === row['studentId'])?.['studentGroupId'] ?? null } }
                  : name === 'teachingRequirement'
                    ? {
                        ...row,
                        subject: { name: table('subject').find((subject) => subject['id'] === row['subjectId'])?.['name'] },
                        // The load report's read of a row's group (load-input.ts); a
                        // strict world joins it whole by studentGroupId instead.
                        studentGroup: options.strict ? undefined : (() => {
                          const group = table('studentGroup').find((candidate) => candidate['id'] === row['studentGroupId']);
                          return group ? { name: group['name'], gradeLevel: group['gradeLevel'] } : undefined;
                        })(),
                      }
                    : name === 'academicYearTimplan'
                      ? { ...row, localTimplan: table('localTimplan').find((plan) => plan['id'] === row['localTimplanId']) }
                      : name === 'teacherDuty'
                        ? {
                            ...row,
                            blockedConstraint:
                              table('availabilityConstraint').find((constraint) => constraint['id'] === row['blockedConstraintId']) ?? null,
                          }
                        : row,
              );
            const context: MatchContext = { model: name, table, strict: options.strict === true };
            const found = table(name).filter((row) => matches(row, where, context));
            // orderBy as one object or a list of them, the first key of each.
            const orders = [args['orderBy'] ?? []].flat() as Record<string, 'asc' | 'desc'>[];
            const keys = orders.map((order) => Object.entries(order)[0]!).filter(Boolean);
            if (keys.length > 0) {
              const key = (row: Row, field: string): string | number => {
                const value = row[field];
                if (typeof value === 'number') return value;
                return value instanceof Date ? value.toISOString() : value === null || value === undefined ? '' : String(value);
              };
              found.sort((a, b) => {
                for (const [field, direction] of keys) {
                  const [x, y] = [key(a, field), key(b, field)];
                  if (x !== y) return (x < y ? -1 : 1) * (direction === 'desc' ? -1 : 1);
                }
                return 0;
              });
            }
            switch (method) {
              case 'findMany':
                return found.map(joined);
              case 'findUnique':
              case 'findFirst':
                return found[0] ? joined(found[0]) : null;
              case 'count':
                return found.length;
              case 'create': {
                const row = { id: freshId(), ...(args['data'] as Row) };
                table(name).push(row);
                return row;
              }
              case 'createMany':
              case 'createManyAndReturn': {
                const created = (args['data'] as Row[]).map((data) => ({ id: freshId(), ...data }));
                table(name).push(...created);
                return method === 'createMany' ? { count: created.length } : created;
              }
              case 'update': {
                const [row] = found;
                Object.assign(row!, args['data']);
                return row;
              }
              case 'upsert': {
                const [row] = found;
                if (row) {
                  Object.assign(row, args['update']);
                  return row;
                }
                const created = { id: freshId(), ...(args['create'] as Row) };
                table(name).push(created);
                return created;
              }
              case 'updateMany': {
                for (const row of found) Object.assign(row, args['data']);
                return { count: found.length };
              }
              case 'deleteMany': {
                rows[name] = table(name).filter((row) => !found.includes(row));
                return { count: found.length };
              }
              default:
                throw new Error(`rollover world: ${name}.${method} is not modelled`);
            }
          };
        },
      },
    );
  world.tx = new Proxy({} as Record<string, unknown>, {
    get(target, key) {
      if (typeof key !== 'string') return undefined;
      if (key === '$queryRaw') {
        return async (strings: TemplateStringsArray, ...values: unknown[]) => {
          const sql = strings.join('?').replace(/\s+/g, ' ').trim();
          calls.push({ model: '$queryRaw', method: '$queryRaw', args: null, sql, values });
          return world.queryRaw(sql, values);
        };
      }
      if (key === '$executeRaw') {
        // An advisory lock or a set_config: recorded, and nothing to answer.
        return async (strings: TemplateStringsArray, ...values: unknown[]) => {
          const sql = strings.join('?').replace(/\s+/g, ' ').trim();
          calls.push({ model: '$executeRaw', method: '$executeRaw', args: null, sql, values });
          return 0;
        };
      }
      return (target[key] ??= model(key));
    },
  }) as unknown as PrismaClient;
  return world;
}

/** A PrismaService stand-in whose every helper runs its callback on the world's tx. */
export function prismaFor(world: RolloverWorld): PrismaMock {
  const run = <T>(fn: (client: PrismaClient) => Promise<T>) => Promise.resolve(fn(world.tx));
  return {
    onModuleInit: jest.fn(),
    onModuleDestroy: jest.fn(),
    withRls: jest.fn((_user: unknown, fn: (client: PrismaClient) => Promise<unknown>) => run(fn)),
    queryWithRls: jest.fn((_user: unknown, fn: (client: PrismaClient) => Promise<unknown>) => run(fn)),
    withVerifiedSubject: jest.fn(),
    withServiceKeyLookup: jest.fn(),
    withServicePrincipal: jest.fn(),
    withSystemTransaction: jest.fn(),
  };
}

/**
 * The SQL statements a recorded call costs under Prisma 7, by name: the call
 * itself, then one more for every relation it selects or includes, nested
 * ones too (`masterLesson.findUnique › school`). Prisma 7 loads a selected
 * relation with a query of its own; a relation count (`_count`) and a
 * relation FILTER are joins inside the statement that carries them, so they
 * add nothing. One fake call is one entry in `calls` but can be several
 * round-trips to Postgres, and a statement budget pinned on `calls` alone
 * would not see a relation select added to a hot path. A write that selects
 * a relation also reads its row back first (`› row`): the UPDATE's RETURNING
 * does not carry the relations, so Prisma selects the row again for them.
 *
 * The model was checked against pg's own count on Postgres (the adapter
 * probe's case (z) pins the same paths there).
 */
export function statementsOf(calls: readonly RecordedCall[]): string[] {
  const out: string[] = [];
  const WRITES = new Set(['create', 'update', 'upsert', 'delete']);
  const nested = (model: string, shape: unknown, path: string, write = false): void => {
    if (shape === null || typeof shape !== 'object') return;
    let reread = write;
    for (const [field, spec] of Object.entries(shape as Row)) {
      if (field === '_count' || spec === false || spec === undefined) continue;
      const target = relationTarget(model, field);
      if (!target) continue;
      if (reread) {
        out.push(`${path} › row`);
        reread = false;
      }
      const here = `${path} › ${field}`;
      out.push(here);
      if (spec !== null && typeof spec === 'object') {
        nested(target, (spec as Row)['select'] ?? (spec as Row)['include'], here);
      }
    }
  };
  for (const call of calls) {
    const head = `${call.model}.${call.method}`;
    out.push(head);
    const args = (call.args ?? {}) as Row;
    nested(call.model, args['select'] ?? args['include'], head, WRITES.has(call.method));
  }
  return out;
}
