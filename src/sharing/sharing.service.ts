import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, UserRole, type PrismaClient } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { rethrowPrismaError } from '../common/utils/prisma-errors';
import { requireSchoolId } from '../common/utils/request-context';
import { PrismaService } from '../database/prisma.service';

/**
 * What a school shares with the other schools of its huvudman (Delade
 * lokaler och lärare, 20261217090000): the minutes between them and the
 * teachers they share. The salslån are room-loans.service.ts.
 *
 * Every read across two schools is a function of the database's that
 * answers for the chosen school only about a school with the same huvudman
 * (app.sibling_schools, app.shared_teachers). A teacher is shared when both
 * schools have marked their own row of the teacher towards each other and
 * one login holds both rows: the school writes and reads its own marks
 * (SharedTeacherMarks), and learns from the other school only whether the
 * pair is complete, never whether the person works there before that. The
 * teachers' names are the school's own rows; the other school hands out its
 * name and nothing of its person. The read log does not record this: a
 * school's own staff in a planning view, and a school's name
 * (src/access-log/access-log.ts).
 */
export interface SiblingSchoolView {
  id: string;
  name: string;
  /** The minutes between the two schools, or null when neither has said. */
  travelMinutes: number | null;
  /** Whether this school wrote the figure last; null without one. */
  travelSetByUs: boolean | null;
}

export interface SharedTeacherView {
  /** This school's own row of the teacher. */
  teacherId: string;
  firstName: string;
  lastName: string;
  /**
   * The other schools of the huvudman the school has marked the teacher as
   * shared with, by name. `shared` once that school has marked its row of
   * the same login back; until then the pair shares nothing.
   */
  schools: Array<{ id: string; name: string; shared: boolean }>;
}

/** A member of the school's active staff, who may be marked as shared. */
export interface StaffMemberView {
  id: string;
  firstName: string;
  lastName: string;
}

export interface SharingView {
  /** The other schools of the huvudman; empty for a school without one. */
  schools: SiblingSchoolView[];
  /** The school's marked teachers. */
  teachers: SharedTeacherView[];
  /** The school's active teachers and administrators, for marking one. */
  staff: StaffMemberView[];
}

export const SCHOOL_NOT_SIBLING = 'SCHOOL_NOT_SIBLING';
export const SHARED_TEACHER_NOT_STAFF = 'SHARED_TEACHER_NOT_STAFF';

const STAFF_ROLES = [UserRole.TEACHER, UserRole.SCHOOL_ADMIN];

/** The other schools of the chosen school's huvudman, by name. */
export async function siblingSchools(tx: PrismaClient): Promise<Array<{ id: string; name: string }>> {
  const rows = await tx.$queryRaw<Array<{ school_id: string; name: string }>>(
    Prisma.sql`SELECT school_id, name FROM app.sibling_schools()`,
  );
  return rows.map((row) => ({ id: row.school_id, name: row.name }));
}

/** The pair as the table stores it: the lower id first. */
export function schoolPair(a: string, b: string): { schoolAId: string; schoolBId: string } {
  return a < b ? { schoolAId: a, schoolBId: b } : { schoolAId: b, schoolBId: a };
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'sv');
const byPerson = (a: { firstName: string; lastName: string }, b: { firstName: string; lastName: string }) =>
  a.lastName.localeCompare(b.lastName, 'sv') || a.firstName.localeCompare(b.firstName, 'sv');

@Injectable()
export class SharingService {
  constructor(private readonly prisma: PrismaService) {}

  async view(user: AuthenticatedUser): Promise<SharingView> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, (tx) => this.read(tx, schoolId));
  }

  /**
   * The minutes to another school of the huvudman, signed with this school;
   * null removes the figure. 404 for a school that is not another school of
   * the huvudman, before the arms would say so with a 403.
   */
  async putTravel(otherSchoolId: string, minutes: number | null, user: AuthenticatedUser): Promise<SharingView> {
    const schoolId = requireSchoolId(user);
    try {
      return await this.prisma.withRls(user, async (tx) => {
        const siblings = await siblingSchools(tx);
        if (!siblings.some((school) => school.id === otherSchoolId)) {
          throw new NotFoundException({ message: 'Skolan hör inte till skolans huvudman.', code: SCHOOL_NOT_SIBLING });
        }
        const pair = schoolPair(schoolId, otherSchoolId);
        if (minutes === null) {
          await tx.schoolTravelTime.deleteMany({ where: pair });
        } else {
          const existing = await tx.schoolTravelTime.findUnique({
            where: { schoolAId_schoolBId: pair },
            select: { minutes: true },
          });
          if (existing) {
            await tx.schoolTravelTime.update({
              where: { schoolAId_schoolBId: pair },
              data: { minutes, setBySchoolId: schoolId },
            });
          } else {
            await tx.schoolTravelTime.create({ data: { ...pair, minutes, setBySchoolId: schoolId } });
          }
        }
        return this.read(tx, schoolId);
      });
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  /**
   * The school's word that its own teacher is shared with another school of
   * the huvudman (shared), or its withdrawal. Either is the school's alone:
   * the teacher is shared once the other school has said the same of its
   * row of the same login, and either school's withdrawal ends it. 404 for
   * a school that is not another school of the huvudman, and for a row that
   * is not one of the school's active teachers or administrators.
   */
  async markTeacher(
    teacherId: string,
    otherSchoolId: string,
    shared: boolean,
    user: AuthenticatedUser,
  ): Promise<SharingView> {
    const schoolId = requireSchoolId(user);
    try {
      return await this.prisma.withRls(user, async (tx) => {
        const siblings = await siblingSchools(tx);
        if (!siblings.some((school) => school.id === otherSchoolId)) {
          throw new NotFoundException({ message: 'Skolan hör inte till skolans huvudman.', code: SCHOOL_NOT_SIBLING });
        }
        if (shared) {
          const teacher = await tx.user.findFirst({
            where: { id: teacherId, schoolId, isActive: true, role: { in: STAFF_ROLES } },
            select: { id: true },
          });
          if (!teacher) {
            throw new NotFoundException({
              message: 'Läraren finns inte bland skolans aktiva lärare och administratörer.',
              code: SHARED_TEACHER_NOT_STAFF,
            });
          }
          await tx.sharedTeacherMark.createMany({
            data: [{ schoolId, teacherId, withSchoolId: otherSchoolId }],
            skipDuplicates: true,
          });
        } else {
          await tx.sharedTeacherMark.deleteMany({ where: { schoolId, teacherId, withSchoolId: otherSchoolId } });
        }
        return this.read(tx, schoolId);
      });
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  private async read(tx: PrismaClient, schoolId: string): Promise<SharingView> {
    // One after another: a transaction is one connection.
    const siblings = await siblingSchools(tx);
    const travel = await tx.schoolTravelTime.findMany({
      select: { schoolAId: true, schoolBId: true, minutes: true, setBySchoolId: true },
    });
    const marks = siblings.length
      ? await tx.sharedTeacherMark.findMany({ where: { schoolId }, select: { teacherId: true, withSchoolId: true } })
      : [];
    const shared = await tx.$queryRaw<Array<{ teacher_id: string; school_id: string; school_name: string }>>(
      Prisma.sql`SELECT teacher_id, school_id, school_name FROM app.shared_teachers()`,
    );
    const teacherIds = [...new Set(marks.map((row) => row.teacherId))];
    const people = teacherIds.length
      ? await tx.user.findMany({
          where: { id: { in: teacherIds }, schoolId },
          select: { id: true, firstName: true, lastName: true },
        })
      : [];
    const staff = siblings.length
      ? await tx.user.findMany({
          where: { schoolId, isActive: true, role: { in: STAFF_ROLES } },
          select: { id: true, firstName: true, lastName: true },
        })
      : [];

    const travelTo = new Map<string, { minutes: number; setBySchoolId: string }>();
    for (const row of travel) {
      const other = row.schoolAId === schoolId ? row.schoolBId : row.schoolBId === schoolId ? row.schoolAId : null;
      if (other) travelTo.set(other, { minutes: row.minutes, setBySchoolId: row.setBySchoolId });
    }
    const schools = siblings.sort(byName).map((school) => {
      const figure = travelTo.get(school.id);
      return {
        id: school.id,
        name: school.name,
        travelMinutes: figure?.minutes ?? null,
        travelSetByUs: figure ? figure.setBySchoolId === schoolId : null,
      };
    });

    // A mark towards a school that has left the huvudman shares nothing and
    // is not shown; it is the school's own row, and stays.
    const siblingName = new Map(siblings.map((school) => [school.id, school.name]));
    const pairs = new Set(shared.map((row) => `${row.teacher_id} ${row.school_id}`));
    const schoolsOf = new Map<string, Array<{ id: string; name: string; shared: boolean }>>();
    for (const mark of marks) {
      const name = siblingName.get(mark.withSchoolId);
      if (name === undefined) continue;
      const list = schoolsOf.get(mark.teacherId) ?? [];
      list.push({ id: mark.withSchoolId, name, shared: pairs.has(`${mark.teacherId} ${mark.withSchoolId}`) });
      schoolsOf.set(mark.teacherId, list);
    }
    const teachers = people
      .filter((person) => schoolsOf.has(person.id))
      .map((person) => ({
        teacherId: person.id,
        firstName: person.firstName,
        lastName: person.lastName,
        schools: (schoolsOf.get(person.id) ?? []).sort(byName),
      }))
      .sort(byPerson);
    return { schools, teachers, staff: staff.sort(byPerson) };
  }
}
