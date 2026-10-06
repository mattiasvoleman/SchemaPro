import { BadRequestException, Injectable } from '@nestjs/common';
import type { TeacherSubjectQualification } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId } from '../common/utils/request-context';
import { rethrowPrismaError } from '../common/utils/prisma-errors';
import { parseDateString } from '../common/utils/time';
import { lockStaffRow } from './staff-lock';
import type {
  ReplaceTeacherQualificationsDto,
  TeacherQualificationItemDto,
} from './dto/teacher-qualification.dto';

/**
 * A behörighet as the API states it: the two DATE columns as plain yyyy-mm-dd,
 * for the reason TeachingRequirementsService gives — Prisma's midnight instant
 * is a fact nobody stored, and PostgREST renders the same column as a date.
 */
export type TeacherQualificationResponse = Omit<
  TeacherSubjectQualification,
  'validFrom' | 'validTo'
> & {
  validFrom: string | null;
  validTo: string | null;
};

const asDay = (value: Date | null): string | null =>
  value === null ? null : value.toISOString().slice(0, 10);

export function toQualificationResponse(
  row: TeacherSubjectQualification,
): TeacherQualificationResponse {
  return { ...row, validFrom: asDay(row.validFrom), validTo: asDay(row.validTo) };
}

/**
 * Lärarnas behörigheter: school-owned, not per year, because legitimation
 * belongs to the person. Readable by every member of staff — a colleague's
 * behörighet is not secret and the substitute picker needs it — written by an
 * admin, as a whole list per teacher.
 */
@Injectable()
export class TeacherQualificationsService {
  constructor(private readonly prisma: PrismaService) {}

  /** The school's rows, or one teacher's. RLS confines the read to the school. */
  async list(
    userId: string | undefined,
    user: AuthenticatedUser,
  ): Promise<TeacherQualificationResponse[]> {
    requireSchoolId(user);
    const rows = await this.prisma.withRls(user, (tx) =>
      tx.teacherSubjectQualification.findMany({
        where: userId ? { userId } : {},
        orderBy: [{ userId: 'asc' }, { subjectId: 'asc' }],
      }),
    );
    return rows.map(toQualificationResponse);
  }

  /**
   * Replace the teacher's whole list with exactly `items`.
   *
   * Validated against the tenant inside the SAME RLS transaction that writes:
   * every subject must be one the caller can see. An id that fails is a 400
   * naming the offenders rather than a P2003 from the composite foreign key,
   * and rather than a silently shrunken save — a behörighet dropped without a
   * word is a teacher the substitute picker stops suggesting, discovered the
   * morning somebody is ill.
   */
  async replace(
    userId: string,
    dto: ReplaceTeacherQualificationsDto,
    user: AuthenticatedUser,
  ): Promise<TeacherQualificationResponse[]> {
    const schoolId = requireSchoolId(user);
    const items = dto.items.map((item, index) => parseItem(item, index));
    assertOneRowPerSubject(items);

    try {
      const rows = await this.prisma.withRls(user, async (tx) => {
        await lockStaffRow(tx, userId, 'behörighet');

        if (items.length > 0) {
          const subjectIds = [...new Set(items.map((item) => item.subjectId))];
          const subjects = await tx.subject.findMany({
            where: { id: { in: subjectIds } },
            select: { id: true },
          });
          const known = new Set(subjects.map((subject) => subject.id));
          const unknown = subjectIds.filter((id) => !known.has(id));
          if (unknown.length > 0) {
            throw new BadRequestException(
              `Ämnet finns inte i skolan: ${unknown.join(', ')}.`,
            );
          }
        }

        await tx.teacherSubjectQualification.deleteMany({ where: { userId } });
        if (items.length > 0) {
          await tx.teacherSubjectQualification.createMany({
            data: items.map((item) => ({ schoolId, userId, ...item })),
          });
        }
        return tx.teacherSubjectQualification.findMany({
          where: { userId },
          orderBy: { subjectId: 'asc' },
        });
      });
      return rows.map(toQualificationResponse);
    } catch (error) {
      rethrowPrismaError(error);
    }
  }
}

interface ParsedItem {
  subjectId: string;
  minGradeLevel: number;
  maxGradeLevel: number;
  kind: TeacherQualificationItemDto['kind'];
  validFrom: Date | null;
  validTo: Date | null;
  note: string | null;
}

/**
 * The two cross-field rules the table states as CHECKs
 * (TeacherSubjectQualifications_grade_span_is_sane, _validity_is_ordered),
 * said here with the row number and both values, where a CHECK can only name
 * itself in a 500.
 */
function parseItem(item: TeacherQualificationItemDto, index: number): ParsedItem {
  const row = index + 1;
  if (item.maxGradeLevel < item.minGradeLevel) {
    throw new BadRequestException(
      `Rad ${row}: högsta årskurs (${item.maxGradeLevel}) kan inte vara lägre än lägsta (${item.minGradeLevel}). Ett spann skrivs som 7–9, inte 9–7.`,
    );
  }
  const validFrom = item.validFrom ? parseDateString(item.validFrom) : null;
  const validTo = item.validTo ? parseDateString(item.validTo) : null;
  if (validFrom && validTo && validTo < validFrom) {
    throw new BadRequestException(
      `Rad ${row}: behörigheten slutar (${item.validTo}) innan den börjar (${item.validFrom}).`,
    );
  }
  return {
    subjectId: item.subjectId,
    minGradeLevel: item.minGradeLevel,
    maxGradeLevel: item.maxGradeLevel,
    kind: item.kind,
    validFrom,
    validTo,
    note: item.note?.trim() || null,
  };
}

/**
 * One span per subject — Ma 1-6 plus Ma 7-9 is written as one row 1-9. The
 * table's unique (school, teacher, subject) would refuse the second row as a
 * P2002 the caller cannot read; this names the subject.
 */
function assertOneRowPerSubject(items: ParsedItem[]): void {
  const seen = new Map<string, number>();
  for (const [index, item] of items.entries()) {
    const first = seen.get(item.subjectId);
    if (first !== undefined) {
      throw new BadRequestException(
        `Rad ${index + 1}: ämnet ${item.subjectId} står redan på rad ${first + 1}. En lärare har ett årskursspann per ämne — skriv 1–9 i stället för två rader.`,
      );
    }
    seen.set(item.subjectId, index);
  }
}
