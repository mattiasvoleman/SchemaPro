/**
 * The importable lists as the school's pages write them, built here from the
 * same lists the pages hold. Every function is the web's, line for line, under
 * the same name and with the same arguments:
 *
 *   web/lib/csv-export.ts                 CSV_TEMPLATES (the files' names and
 *                                         headers), subjectsToCsv, roomTypesToCsv,
 *                                         roomsToCsv, classesToCsv, teachersToCsv,
 *                                         teacherQualificationsToCsv, studentsToCsv,
 *                                         membershipsToCsv
 *   web/lib/requirements-csv-export.ts    requirementsToCsv
 *   web/lib/duties-csv-export.ts          teacherDutiesToCsv
 *   web/lib/guardians-csv-export.ts       guardiansToCsv
 *   web/lib/timplan-csv.ts                timplanToCsv
 *
 * The gateway's image builds from src/ alone, so it cannot import them; it
 * copies them, and the copies are held to the web's by one list of cases
 * (__fixtures__/csv-files-cases.json, generated from the web's builders by
 * web/lib/csv-files-cases.test.ts and replayed by csv-files.spec.ts). A drift
 * on either side fails a test on that side. "Exports the file the school's page
 * would have written" is what makes the whole-school export's lists readable
 * by the same importer (#260), so it is a contract and not a habit.
 *
 * Left as the web has them, with the reasons the web gives: ids never appear,
 * a row whose group, subject or teacher the lists cannot name is left out
 * rather than written blank (a blank is an instruction to clear on re-import),
 * only active people are named, and a percentage is written with a decimal
 * comma.
 */

import type { LessonRecurrence, TeacherContractKind, TeacherDutyKind, TeacherQualificationKind } from '@prisma/client';
import { isMixed, lengthPartsOf, type LessonShape } from '../common/lesson-lengths';
import { serializeCsv } from './csv-writer';

interface CsvFile {
  filename: string;
  headers: string[];
}

export type ImportKind =
  | 'subjects'
  | 'students'
  | 'teachers'
  | 'classes'
  | 'teachingGroups'
  | 'roomTypes'
  | 'requirements'
  | 'teacherQualifications'
  | 'teacherDuties'
  | 'rooms'
  | 'guardians';

/** Each file's name and header, as web/lib/csv-export.ts CSV_TEMPLATES has them. */
export const CSV_TEMPLATES: Record<ImportKind, CsvFile> = {
  subjects: { filename: 'amnen.csv', headers: ['namn', 'kod', 'farg', 'salstyp', 'nationell_kod', 'undervisningstid'] },
  rooms: {
    filename: 'salar.csv',
    headers: ['namn', 'kod', 'salstyp', 'kapacitet', 'lagsta_arskurs', 'hogsta_arskurs', 'byggnad', 'vaning'],
  },
  roomTypes: { filename: 'salstyper.csv', headers: ['namn'] },
  classes: { filename: 'klasser.csv', headers: ['namn', 'arskurs', 'typ', 'halvklass_av', 'ersatter_amne'] },
  teachers: {
    filename: 'larare.csv',
    headers: ['fornamn', 'efternamn', 'epost', 'telefon', 'tjanst_procent', 'nedsattning_procent', 'avtal', 'signatur'],
  },
  teacherQualifications: {
    filename: 'behorigheter.csv',
    headers: ['larare_epost', 'amne', 'fran_arskurs', 'till_arskurs', 'behorighet'],
  },
  teacherDuties: {
    filename: 'uppdrag.csv',
    headers: [
      'larare_epost',
      'typ',
      'benamning',
      'minuter_per_vecka',
      'raknas_som_undervisning',
      'amne',
      'grupp',
      'fran',
      'till',
      'anteckning',
    ],
  },
  students: { filename: 'elever.csv', headers: ['fornamn', 'efternamn', 'epost', 'telefon', 'klass'] },
  teachingGroups: { filename: 'undervisningsgrupper.csv', headers: ['grupp', 'epost'] },
  guardians: { filename: 'vardnadshavare.csv', headers: ['fornamn', 'efternamn', 'epost', 'telefon', 'elev_epost'] },
  requirements: {
    filename: 'timplansposter.csv',
    headers: [
      'grupp',
      'amne',
      'lektioner_per_vecka',
      'minuter_per_lektion',
      'minuter_fore',
      'minuter_efter',
      'larare',
      'medlarare',
      'veckor',
      'fran',
      'till',
      'larare_procent',
      'medlarare_procent',
    ],
  },
};

export const TIMPLAN_CSV_TEMPLATE = {
  filename: 'lokal_timplan.csv',
  headers: ['amne', 'arskurs', 'minuter_per_vecka', 'notering'],
};

export const LESSON_LENGTHS_HEADER = 'lektionslangder';

export const isActivePerson = (person: { isActive?: boolean }) => person.isActive !== false;

/** Person id -> e-mail, for the active people only. */
export const activeEmails = (people: { id: string; email: string; isActive?: boolean }[]) =>
  new Map(people.filter(isActivePerson).map((person) => [person.id, person.email]));

const CONTRACT_WORD: Record<TeacherContractKind, string> = { FERIE: 'ferie', SEMESTER: 'semester' };

const KIND_WORD: Record<TeacherQualificationKind, string> = {
  LEGITIMATION: 'legitimation',
  BEHORIG: 'behörig',
  TILLATEN: 'tillåten',
};

export const RECURRENCE_WORD: Record<LessonRecurrence, string> = {
  ALL_WEEKS: 'alla',
  ODD_WEEKS: 'udda',
  EVEN_WEEKS: 'jamna',
};

const DUTY_KIND_WORD: Record<TeacherDutyKind, string> = {
  MENTORSKAP: 'mentorskap',
  AMNESANSVAR: 'ämnesansvar',
  FORSTELARARE: 'förstelärare',
  RASTVAKT: 'rastvakt',
  PEDAGOGISK_LUNCH: 'pedagogisk lunch',
  APT_KONFERENS: 'apt/konferens',
  VFU_HANDLEDNING: 'vfu-handledning',
  APL: 'apl',
  ANNAT: 'annat',
};

const decimalComma = (value: number) => String(value).replace('.', ',');

export function subjectsToCsv(
  subjects: {
    name: string;
    code: string | null;
    color: string | null;
    requiredRoomTypeId: string | null;
    nationalCode: string | null;
    countsTowardTimplan: boolean;
  }[],
  roomTypeName: (id: string | null) => string,
): string {
  return serializeCsv(
    CSV_TEMPLATES.subjects.headers,
    subjects.map((subject) => [
      subject.name,
      subject.code ?? '',
      subject.color ?? '',
      roomTypeName(subject.requiredRoomTypeId),
      subject.nationalCode ?? '',
      subject.countsTowardTimplan ? 'ja' : 'nej',
    ]),
  );
}

export function roomTypesToCsv(roomTypes: { name: string }[]): string {
  return serializeCsv(
    CSV_TEMPLATES.roomTypes.headers,
    roomTypes.map((type) => [type.name]),
  );
}

export function roomsToCsv(
  rooms: {
    name: string;
    code: string | null;
    capacity: number | null;
    roomTypeId: string | null;
    minGradeLevel: number | null;
    maxGradeLevel: number | null;
    building?: string | null;
    floor?: number | null;
  }[],
  roomTypes: { id: string; name: string }[],
): string {
  const typeName = new Map(roomTypes.map((type) => [type.id, type.name]));
  const text = (value: number | string | null | undefined) => (value === null || value === undefined ? '' : String(value));
  const rows: string[][] = [];
  for (const room of rooms) {
    const type = room.roomTypeId ? typeName.get(room.roomTypeId) : '';
    if (type === undefined) continue;
    rows.push([
      room.name,
      text(room.code),
      type,
      text(room.capacity),
      text(room.minGradeLevel),
      text(room.maxGradeLevel),
      text(room.building),
      text(room.floor),
    ]);
  }
  return serializeCsv(CSV_TEMPLATES.rooms.headers, rows);
}

export function classesToCsv(
  groups: {
    id: string;
    name: string;
    kind: string;
    gradeLevel: number | null;
    halfOfId?: string | null;
    replacesSubjectId?: string | null;
  }[],
  subjects: { id: string; name: string; code: string | null }[] = [],
): string {
  const rows: string[][] = [];
  for (const group of groups) {
    const half = group.halfOfId ? groups.find((other) => other.id === group.halfOfId)?.name : '';
    const replaced = subjects.find((subject) => subject.id === group.replacesSubjectId);
    const subject = group.replacesSubjectId ? replaced && (replaced.code?.trim() || replaced.name) : '';
    if (half === undefined || subject === undefined) continue;
    rows.push([
      group.name,
      group.gradeLevel === null ? '' : String(group.gradeLevel),
      group.kind === 'CLASS' ? 'klass' : 'undervisningsgrupp',
      half,
      subject,
    ]);
  }
  return serializeCsv(CSV_TEMPLATES.classes.headers, rows);
}

export function teachersToCsv(
  people: {
    id?: string;
    role: string;
    firstName: string;
    lastName: string;
    email: string;
    phone?: string | null;
    isActive?: boolean;
  }[],
  employmentOf?: (userId: string) =>
    | {
        employmentPercent: number | null;
        reductionPercent: number | null;
        contractKind: TeacherContractKind;
        signature: string | null;
      }
    | undefined,
): string {
  return serializeCsv(
    CSV_TEMPLATES.teachers.headers,
    people
      .filter((person) => person.role === 'TEACHER' && isActivePerson(person))
      .map((person) => {
        const found = person.id !== undefined ? employmentOf?.(person.id) : undefined;
        const post = found && found.employmentPercent !== null ? found : undefined;
        return [
          person.firstName,
          person.lastName,
          person.email,
          person.phone ?? '',
          post ? decimalComma(post.employmentPercent!) : '',
          post && (post.reductionPercent ?? 0) > 0 ? decimalComma(post.reductionPercent!) : '',
          post ? CONTRACT_WORD[post.contractKind] : '',
          post?.signature ?? '',
        ];
      }),
  );
}

export function teacherQualificationsToCsv(
  qualifications: {
    userId: string;
    subjectId: string;
    minGradeLevel: number;
    maxGradeLevel: number;
    kind: TeacherQualificationKind;
  }[],
  people: { id: string; email: string; isActive?: boolean }[],
  subjects: { id: string; name: string; code: string | null }[],
): string {
  const email = activeEmails(people);
  const subjectLabel = new Map(subjects.map((subject) => [subject.id, subject.code?.trim() || subject.name]));
  const rows: string[][] = [];
  for (const row of qualifications) {
    const address = email.get(row.userId);
    const subject = subjectLabel.get(row.subjectId);
    if (!address || !subject) continue;
    rows.push([address, subject, String(row.minGradeLevel), String(row.maxGradeLevel), KIND_WORD[row.kind]]);
  }
  return serializeCsv(CSV_TEMPLATES.teacherQualifications.headers, rows);
}

export function studentsToCsv(
  people: {
    role: string;
    firstName: string;
    lastName: string;
    email: string;
    phone?: string | null;
    studentGroupId: string | null;
    isActive?: boolean;
  }[],
  className: (groupId: string | null) => string,
): string {
  return serializeCsv(
    CSV_TEMPLATES.students.headers,
    people
      .filter((person) => person.role === 'STUDENT' && isActivePerson(person))
      .map((person) => [person.firstName, person.lastName, person.email, person.phone ?? '', className(person.studentGroupId)]),
  );
}

export function membershipsToCsv(
  groups: { id: string; name: string }[],
  people: { id: string; email: string; isActive?: boolean }[],
  memberships: { studentGroupId: string; studentId: string }[],
): string {
  const groupName = new Map(groups.map((group) => [group.id, group.name]));
  const email = activeEmails(people);
  const rows: string[][] = [];
  for (const row of memberships) {
    const name = groupName.get(row.studentGroupId);
    const address = email.get(row.studentId);
    if (name && address) rows.push([name, address]);
  }
  return serializeCsv(CSV_TEMPLATES.teachingGroups.headers, rows);
}

export function teacherDutiesToCsv(
  duties: {
    userId: string;
    kind: TeacherDutyKind;
    label: string;
    minutesPerWeek: number;
    countsAsTeaching: boolean;
    subjectId: string | null;
    studentGroupId: string | null;
    validFrom: string | null;
    validTo: string | null;
    note: string | null;
  }[],
  people: { id: string; email: string; isActive?: boolean }[],
  subjects: { id: string; name: string; code: string | null }[],
  groups: { id: string; name: string }[],
): string {
  const email = activeEmails(people);
  const subjectLabel = new Map(subjects.map((subject) => [subject.id, subject.code?.trim() || subject.name]));
  const groupName = new Map(groups.map((group) => [group.id, group.name]));
  const rows: string[][] = [];
  for (const duty of duties) {
    const teacher = email.get(duty.userId);
    const subject = duty.subjectId ? subjectLabel.get(duty.subjectId) : '';
    const group = duty.studentGroupId ? groupName.get(duty.studentGroupId) : '';
    if (!teacher || subject === undefined || group === undefined) continue;
    rows.push([
      teacher,
      DUTY_KIND_WORD[duty.kind],
      duty.label,
      String(duty.minutesPerWeek),
      duty.countsAsTeaching ? 'ja' : 'nej',
      subject,
      group,
      duty.validFrom?.slice(0, 10) ?? '',
      duty.validTo?.slice(0, 10) ?? '',
      duty.note ?? '',
    ]);
  }
  return serializeCsv(CSV_TEMPLATES.teacherDuties.headers, rows);
}

export interface GuardianExportRow {
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  studentEmail: string;
}

export function guardiansToCsv(rows: GuardianExportRow[]): string {
  return serializeCsv(
    CSV_TEMPLATES.guardians.headers,
    rows.map((row) => [row.firstName, row.lastName, row.email, row.phone ?? '', row.studentEmail]),
  );
}

/** A split post's lengths as the `lektionslangder` cell writes them: "1x80+1x40", longest first. */
export function formatLengthSpec(row: LessonShape): string {
  return lengthPartsOf(row)
    .map((part) => `${part.count}x${part.minutes}`)
    .join('+');
}

export function requirementsToCsv(
  requirements: {
    studentGroupId: string;
    subjectId: string;
    teacherId: string | null;
    coTeacherId: string | null;
    lessonsPerWeek: number;
    minutesPerLesson: number;
    lessonLengths?: number[];
    minutesBefore: number;
    minutesAfter: number;
    teacherLoadPercent: number;
    coTeacherLoadPercent: number;
    recurrence: LessonRecurrence;
    startDate: string | null;
    endDate: string | null;
  }[],
  groups: { id: string; name: string }[],
  subjects: { id: string; name: string; code: string | null }[],
  people: { id: string; email: string; isActive?: boolean }[],
): string {
  const groupName = new Map(groups.map((group) => [group.id, group.name]));
  const subjectLabel = new Map(subjects.map((subject) => [subject.id, subject.code?.trim() || subject.name]));
  const email = activeEmails(people);

  const split = requirements.some(
    (requirement) => isMixed(requirement) && groupName.has(requirement.studentGroupId) && subjectLabel.has(requirement.subjectId),
  );
  const rows: string[][] = [];
  for (const requirement of requirements) {
    const group = groupName.get(requirement.studentGroupId);
    const subject = subjectLabel.get(requirement.subjectId);
    if (!group || !subject) continue;
    const teacher = requirement.teacherId ? email.get(requirement.teacherId) : '';
    const coTeacher = requirement.coTeacherId ? email.get(requirement.coTeacherId) : '';
    if (teacher === undefined || coTeacher === undefined) continue;

    rows.push([
      group,
      subject,
      String(requirement.lessonsPerWeek),
      String(requirement.minutesPerLesson),
      String(requirement.minutesBefore),
      String(requirement.minutesAfter),
      teacher,
      coTeacher,
      RECURRENCE_WORD[requirement.recurrence],
      requirement.startDate ?? '',
      requirement.endDate ?? '',
      String(requirement.teacherLoadPercent),
      String(requirement.coTeacherLoadPercent),
      ...(split ? [isMixed(requirement) ? formatLengthSpec(requirement) : ''] : []),
    ]);
  }
  return serializeCsv(
    split ? [...CSV_TEMPLATES.requirements.headers, LESSON_LENGTHS_HEADER] : CSV_TEMPLATES.requirements.headers,
    rows,
  );
}

/** The local timplan's grade as the file writes it: F for förskoleklass, else the number (web/lib/timplan-csv.ts). */
export function formatTimplanGrade(grade: number): string {
  return grade === 0 ? 'F' : String(grade);
}

export function timplanToCsv(
  entries: { subjectId: string; gradeLevel: number; minutesPerWeek: number; note: string | null }[],
  subjects: { id: string; name: string; code: string | null }[],
): string {
  const order = new Map(subjects.map((subject, index) => [subject.id, index]));
  const byId = new Map(subjects.map((subject) => [subject.id, subject]));
  const rows = entries
    .filter((entry) => byId.has(entry.subjectId))
    .sort((a, b) => order.get(a.subjectId)! - order.get(b.subjectId)! || a.gradeLevel - b.gradeLevel)
    .map((entry) => {
      const subject = byId.get(entry.subjectId)!;
      return [
        subject.code?.trim() ? subject.code : subject.name,
        formatTimplanGrade(entry.gradeLevel),
        String(entry.minutesPerWeek),
        entry.note ?? '',
      ];
    });
  return serializeCsv(TIMPLAN_CSV_TEMPLATE.headers, rows);
}
