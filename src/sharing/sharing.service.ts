import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
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
 * (app.sibling_schools, app.shared_teachers). The teachers' names are the
 * school's own rows; the other school hands out its name and nothing of its
 * person. The read log does not record this: a school's own staff in a
 * planning view, and a school's name (src/access-log/access-log.ts).
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
  /** The other schools of the huvudman the teacher works at, by name. */
  schools: Array<{ id: string; name: string }>;
}

export interface SharingView {
  /** The other schools of the huvudman; empty for a school without one. */
  schools: SiblingSchoolView[];
  teachers: SharedTeacherView[];
}

export const SCHOOL_NOT_SIBLING = 'SCHOOL_NOT_SIBLING';

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

  private async read(tx: PrismaClient, schoolId: string): Promise<SharingView> {
    // One after another: a transaction is one connection.
    const siblings = await siblingSchools(tx);
    const travel = await tx.schoolTravelTime.findMany({
      select: { schoolAId: true, schoolBId: true, minutes: true, setBySchoolId: true },
    });
    const shared = await tx.$queryRaw<Array<{ teacher_id: string; school_id: string; school_name: string }>>(
      Prisma.sql`SELECT teacher_id, school_id, school_name FROM app.shared_teachers()`,
    );
    const teacherIds = [...new Set(shared.map((row) => row.teacher_id))];
    const people = teacherIds.length
      ? await tx.user.findMany({
          where: { id: { in: teacherIds }, schoolId },
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

    const schoolsOf = new Map<string, Array<{ id: string; name: string }>>();
    for (const row of shared) {
      const list = schoolsOf.get(row.teacher_id) ?? [];
      list.push({ id: row.school_id, name: row.school_name });
      schoolsOf.set(row.teacher_id, list);
    }
    const teachers = people
      .map((person) => ({
        teacherId: person.id,
        firstName: person.firstName,
        lastName: person.lastName,
        schools: (schoolsOf.get(person.id) ?? []).sort(byName),
      }))
      .sort((a, b) => a.lastName.localeCompare(b.lastName, 'sv') || a.firstName.localeCompare(b.firstName, 'sv'));
    return { schools, teachers };
  }
}
