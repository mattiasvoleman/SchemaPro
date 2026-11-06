import type { PrismaClient } from '@prisma/client';
import {
  CSV_TEMPLATES,
  TIMPLAN_CSV_TEMPLATE,
  classesToCsv,
  guardiansToCsv,
  membershipsToCsv,
  requirementsToCsv,
  roomTypesToCsv,
  roomsToCsv,
  studentsToCsv,
  subjectsToCsv,
  teacherDutiesToCsv,
  teacherQualificationsToCsv,
  teachersToCsv,
  timplanToCsv,
  type GuardianExportRow,
} from './csv-files';

/**
 * The school's importable lists: the files its pages export as CSV, in the
 * format the importers read (#260). The lists are read the way the pages hold
 * them (the order the gateway's list routes answer in, the active läsår's
 * groups, uppdrag, posts and timplansposter) and handed to the same builders
 * (csv-files.ts), so the file is the one the school's own page writes.
 *
 * Skyddad identitet (20270107090000): a marked person is taken out of the
 * list before the builders see it, as the pages do (web/lib/protected-people.ts
 * `withoutMarked`). A builder leaves out a row it cannot name a person on, so
 * every row that names a marked person goes with them: their membership,
 * their behörigheter and uppdrag, a timplan post that names them as teacher
 * (left out whole, as the page leaves it: an empty teacher cell would take
 * the teacher off the post on the way back in). The guardians file is the
 * gateway's own (FamilyReadsService.guardianExport), which holds out a link
 * whose pupil or guardian is marked.
 */

const day = (value: Date | null): string | null => (value ? value.toISOString().slice(0, 10) : null);

export interface ListedPerson {
  id: string;
  role: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  studentGroupId: string | null;
  isActive: boolean;
}

export interface SchoolLists {
  activeYearId: string | null;
  subjects: Array<{
    id: string;
    name: string;
    code: string | null;
    color: string | null;
    requiredRoomTypeId: string | null;
    nationalCode: string | null;
    countsTowardTimplan: boolean;
  }>;
  roomTypes: Array<{ id: string; name: string }>;
  rooms: Array<{
    name: string;
    code: string | null;
    capacity: number | null;
    roomTypeId: string | null;
    minGradeLevel: number | null;
    maxGradeLevel: number | null;
    building: string | null;
    floor: number | null;
  }>;
  groups: Array<{
    id: string;
    academicYearId: string;
    name: string;
    kind: string;
    gradeLevel: number | null;
    halfOfId: string | null;
    replacesSubjectId: string | null;
  }>;
  people: ListedPerson[];
  memberships: Array<{ studentGroupId: string; studentId: string }>;
  employments: Map<
    string,
    { employmentPercent: number; reductionPercent: number; contractKind: 'FERIE' | 'SEMESTER'; signature: string | null }
  >;
  qualifications: Array<{
    userId: string;
    subjectId: string;
    minGradeLevel: number;
    maxGradeLevel: number;
    kind: 'LEGITIMATION' | 'BEHORIG' | 'TILLATEN';
  }>;
  duties: Array<{
    userId: string;
    kind: Parameters<typeof teacherDutiesToCsv>[0][number]['kind'];
    label: string;
    minutesPerWeek: number;
    countsAsTeaching: boolean;
    subjectId: string | null;
    studentGroupId: string | null;
    validFrom: string | null;
    validTo: string | null;
    note: string | null;
  }>;
  requirements: Array<Parameters<typeof requirementsToCsv>[0][number]>;
  plans: Array<{
    name: string;
    entries: Array<{ subjectId: string; gradeLevel: number; minutesPerWeek: number; note: string | null }>;
  }>;
}

/** The lists, in the order the gateway's list routes answer in, as one administrator reads them. */
export async function readLists(tx: PrismaClient, schoolId: string): Promise<SchoolLists> {
  const active = await tx.academicYear.findFirst({ where: { schoolId, isActive: true }, select: { id: true } });
  const activeYearId = active?.id ?? null;
  const [subjects, roomTypes, rooms, groups, people, memberships, employments, qualifications, duties, requirements, plans] =
    await Promise.all([
      tx.subject.findMany({ where: { schoolId }, orderBy: { name: 'asc' } }),
      tx.roomType.findMany({ where: { schoolId }, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
      tx.room.findMany({ where: { schoolId }, orderBy: { name: 'asc' } }),
      tx.studentGroup.findMany({ where: { schoolId }, orderBy: { name: 'asc' } }),
      tx.user.findMany({
        where: { schoolId },
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
        select: { id: true, role: true, firstName: true, lastName: true, email: true, phone: true, studentGroupId: true, isActive: true },
      }),
      tx.studentGroupMember.findMany({
        where: { schoolId },
        orderBy: [{ studentGroupId: 'asc' }, { studentId: 'asc' }],
        select: { studentGroupId: true, studentId: true },
      }),
      activeYearId
        ? tx.teacherEmployment.findMany({ where: { schoolId, academicYearId: activeYearId }, orderBy: { userId: 'asc' } })
        : Promise.resolve([]),
      tx.teacherSubjectQualification.findMany({ where: { schoolId }, orderBy: [{ userId: 'asc' }, { subjectId: 'asc' }] }),
      activeYearId
        ? tx.teacherDuty.findMany({
            where: { schoolId, academicYearId: activeYearId },
            orderBy: [{ userId: 'asc' }, { kind: 'asc' }, { label: 'asc' }],
          })
        : Promise.resolve([]),
      activeYearId ? tx.teachingRequirement.findMany({ where: { schoolId, academicYearId: activeYearId } }) : Promise.resolve([]),
      tx.localTimplan.findMany({
        where: { schoolId },
        orderBy: { name: 'asc' },
        select: { name: true, entries: { select: { subjectId: true, gradeLevel: true, minutesPerWeek: true, note: true } } },
      }),
    ]);

  return {
    activeYearId,
    subjects: subjects.map((s) => ({
      id: s.id,
      name: s.name,
      code: s.code,
      color: s.color,
      requiredRoomTypeId: s.requiredRoomTypeId,
      nationalCode: s.nationalCode,
      countsTowardTimplan: s.countsTowardTimplan,
    })),
    roomTypes,
    rooms: rooms.map((r) => ({
      name: r.name,
      code: r.code,
      capacity: r.capacity,
      roomTypeId: r.roomTypeId,
      minGradeLevel: r.minGradeLevel,
      maxGradeLevel: r.maxGradeLevel,
      building: r.building,
      floor: r.floor,
    })),
    groups: groups.map((g) => ({
      id: g.id,
      academicYearId: g.academicYearId,
      name: g.name,
      kind: g.kind,
      gradeLevel: g.gradeLevel,
      halfOfId: g.halfOfId,
      replacesSubjectId: g.replacesSubjectId,
    })),
    people,
    memberships,
    employments: new Map(
      employments.map((e) => [
        e.userId,
        {
          employmentPercent: Number(e.employmentPercent),
          reductionPercent: Number(e.reductionPercent),
          contractKind: e.contractKind,
          signature: e.signature,
        },
      ]),
    ),
    qualifications: qualifications.map((q) => ({
      userId: q.userId,
      subjectId: q.subjectId,
      minGradeLevel: q.minGradeLevel,
      maxGradeLevel: q.maxGradeLevel,
      kind: q.kind,
    })),
    duties: duties.map((d) => ({
      userId: d.userId,
      kind: d.kind,
      label: d.label,
      minutesPerWeek: d.minutesPerWeek,
      countsAsTeaching: d.countsAsTeaching,
      subjectId: d.subjectId,
      studentGroupId: d.studentGroupId,
      validFrom: day(d.validFrom),
      validTo: day(d.validTo),
      note: d.note,
    })),
    requirements: requirements.map((r) => ({
      studentGroupId: r.studentGroupId,
      subjectId: r.subjectId,
      teacherId: r.teacherId,
      coTeacherId: r.coTeacherId,
      lessonsPerWeek: r.lessonsPerWeek,
      minutesPerLesson: r.minutesPerLesson,
      lessonLengths: r.lessonLengths,
      minutesBefore: r.minutesBefore,
      minutesAfter: r.minutesAfter,
      teacherLoadPercent: r.teacherLoadPercent,
      coTeacherLoadPercent: r.coTeacherLoadPercent,
      recurrence: r.recurrence,
      startDate: day(r.startDate),
      endDate: day(r.endDate),
    })),
    plans,
  };
}

export interface ListFile {
  /** Path in the zip. */
  path: string;
  content: string;
  /** Rows the file holds, header excluded. */
  rows: number;
}

const rowsOf = (content: string): number => Math.max(0, content.split('\r\n').length - 2);

/** A plan's name as a file name: letters and digits, the rest a dash. */
export function planFileStem(name: string, taken: Set<string>): string {
  const base =
    name
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .replace(/[^\w.-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'plan';
  let stem = base;
  for (let n = 2; taken.has(stem.toLowerCase()); n += 1) stem = `${base}-${n}`;
  taken.add(stem.toLowerCase());
  return stem;
}

/**
 * Every importable list as a file. A file with nothing in it is still written
 * (a header the importer reads as an empty list), except the guardians' and
 * the local plans', as the pages write none for an empty list.
 */
export function listFiles(
  lists: SchoolLists,
  marked: ReadonlySet<string>,
  guardianRows: readonly GuardianExportRow[],
): ListFile[] {
  const kept = lists.people.filter((person) => !marked.has(person.id));
  const yearGroups = lists.groups.filter((group) => group.academicYearId === lists.activeYearId);
  const typeNames = new Map(lists.roomTypes.map((type) => [type.id, type.name]));
  const classNames = new Map(lists.groups.map((group) => [group.id, group.name]));
  const hasYear = lists.activeYearId !== null;
  const out: Array<{ file: string; content: string }> = [];
  const add = (file: string, content: string) => out.push({ file, content });

  add(CSV_TEMPLATES.roomTypes.filename, roomTypesToCsv(lists.roomTypes));
  add(CSV_TEMPLATES.rooms.filename, roomsToCsv(lists.rooms, lists.roomTypes));
  add(CSV_TEMPLATES.subjects.filename, subjectsToCsv(lists.subjects, (id) => (id ? (typeNames.get(id) ?? '') : '')));
  add(CSV_TEMPLATES.classes.filename, classesToCsv(yearGroups, lists.subjects));
  add(
    CSV_TEMPLATES.teachers.filename,
    teachersToCsv(kept, hasYear ? (userId) => lists.employments.get(userId) : undefined),
  );
  add(CSV_TEMPLATES.teacherQualifications.filename, teacherQualificationsToCsv(lists.qualifications, kept, lists.subjects));
  if (hasYear) add(CSV_TEMPLATES.teacherDuties.filename, teacherDutiesToCsv(lists.duties, kept, lists.subjects, yearGroups));
  add(CSV_TEMPLATES.students.filename, studentsToCsv(kept, (id) => (id ? (classNames.get(id) ?? '') : '')));
  add(CSV_TEMPLATES.teachingGroups.filename, membershipsToCsv(yearGroups, kept, lists.memberships));
  if (guardianRows.length > 0) add(CSV_TEMPLATES.guardians.filename, guardiansToCsv([...guardianRows]));
  if (hasYear) add(CSV_TEMPLATES.requirements.filename, requirementsToCsv(lists.requirements, yearGroups, lists.subjects, kept));

  const files: ListFile[] = out.map(({ file, content }) => ({ path: `csv/${file}`, content, rows: rowsOf(content) }));
  const taken = new Set<string>();
  for (const plan of lists.plans) {
    const content = timplanToCsv(plan.entries, lists.subjects);
    files.push({ path: `csv/lokal_timplan/${planFileStem(plan.name, taken)}.csv`, content, rows: rowsOf(content) });
  }
  return files;
}

export { TIMPLAN_CSV_TEMPLATE };
