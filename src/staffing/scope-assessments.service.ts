import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { AssignmentScopeAssessment, AssignmentScopeException } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId } from '../common/utils/request-context';
import { rethrowPrismaError } from '../common/utils/prisma-errors';
import { SCOPE_SCHOOL_FORM } from './assignment-scope';
import { readScopeVersions } from './assignment-scope-reader';
import type { UpsertScopeAssessmentDto } from './dto/scope-assessment.dto';
import { mayReadHrOf } from './hr-visibility';
import { lockStaffRow } from './staff-lock';

/**
 * One teacher's assessment for one läsår, as the gateway answers it. `hrHidden` is true when the reader may not read the HR of THIS
 * person (hr-visibility.ts mayReadHrOf): the level, the day and the note are then null, and only the exception kind is left, which is
 * what a warning that was not a refusal has to be able to say.
 */
export interface ScopeAssessmentResponse {
  userId: string;
  academicYearId: string;
  /** The teacher's highest teaching time at full time, hours per läsår; null = none set (the ordinance's edge holds). */
  teachingLevelHours: number | null;
  exceptionKind: AssignmentScopeException | null;
  /** yyyy-mm-dd; set exactly when the exception is OWN_INITIATIVE. */
  ownInitiativeOn: string | null;
  note: string | null;
  /** Set by the database from the session, never by the caller; null when the person was removed. */
  decidedById: string | null;
  decidedAt: string | null;
  hrHidden: boolean;
}

export const SCOPE_EMPTY = 'Bedömningen säger ingenting: ange en egen nivå, ett undantag eller båda. Ta bort bedömningen i stället för att spara den tom.';
export const SCOPE_INITIATIVE_NEEDS_DAY = 'Ett undantag på lärarens eget initiativ (11 § p. 1) anges med dagen läraren tog initiativet.';
export const SCOPE_DAY_NEEDS_INITIATIVE = 'Dagen gäller bara ett undantag på lärarens eget initiativ.';
export const SCOPE_NOT_IN_FORCE = 'Förordningen (SFS 2026:1487) gäller läsår som börjar den 1 juli 2027 eller senare: det här läsåret har ingen omfattning att bedöma.';
export const SCOPE_NUMBERING_NOT_COVERED = 'Förordningen har ännu inga nivåer för det här läsårets årskursnumrering (tioårig grundskola): det finns ingen omfattning att bedöma.';
export const scopeAboveEdge = (edge: number): string =>
  `Nivån kan inte vara över förordningens högsta nivå, ${edge} timmar vid heltid (SFS 2026:1487 3 §). Rektorn väljer en nivå inom spannet eller under det.`;

const day = (value: Date): string => value.toISOString().slice(0, 10);

export function toScopeAssessmentResponse(row: AssignmentScopeAssessment): ScopeAssessmentResponse {
  return {
    userId: row.userId,
    academicYearId: row.academicYearId,
    teachingLevelHours: row.teachingLevelHours,
    exceptionKind: row.exceptionKind,
    ownInitiativeOn: row.ownInitiativeOn === null ? null : day(row.ownInitiativeOn),
    note: row.note,
    decidedById: row.decidedById,
    decidedAt: row.decidedAt.toISOString(),
    hrHidden: false,
  };
}

/** The same row for a reader who may not read this person's HR: the exception kind stays, everything that is about the person goes. */
export function hideScopeAssessment(row: ScopeAssessmentResponse): ScopeAssessmentResponse {
  return { ...row, teachingLevelHours: null, ownInitiativeOn: null, note: null, decidedById: null, decidedAt: null, hrHidden: true };
}

/**
 * Rektorns bedömning av lärarens omfattning och undantag enligt 11 § (R1, del G).
 *
 * WHO WRITES AND WHO READS are the table's arms and the controller's roles, said twice on purpose (hr-visibility.ts has the reason):
 * the administrators read, whoever decides writes, and a teacher reads their own row through Min tjänst's report and not here.
 *
 * A LEVEL IS HELD TO THE ORDINANCE'S EDGE, read from the lydelse that holds on the year's first day, so that a new lydelse (a row in
 * the reference data) moves the bound without a migration. The edge is the highest upper edge of any band of the lydelse in the year's
 * numbering: a teacher's stage decides which edge is theirs, and a teacher with no teaching yet has none, so the service cannot hold a
 * level to a stage it does not know. The report reads a level above the teacher's own edge as the edge (assignment-scope.ts).
 *
 * A YEAR THE ORDINANCE DOES NOT REACH has nothing to assess. It is refused, so that no level is written that would one day be read
 * against a lydelse it was never judged against: every läsår that begins before 2027-07-01, and the ten-year numbering until the
 * ordinance has bands for it.
 */
@Injectable()
export class ScopeAssessmentsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(academicYearId: string, user: AuthenticatedUser): Promise<ScopeAssessmentResponse[]> {
    requireSchoolId(user);
    const rows = await this.prisma.withRls(user, (tx) =>
      tx.assignmentScopeAssessment.findMany({ where: { academicYearId }, orderBy: { userId: 'asc' } }),
    );
    return rows.map((row) => {
      const response = toScopeAssessmentResponse(row);
      return mayReadHrOf(user, row.userId) ? response : hideScopeAssessment(response);
    });
  }

  /** Write (or rewrite) one teacher's assessment for one year. The whole row is replaced, every time. */
  async upsert(userId: string, academicYearId: string, dto: UpsertScopeAssessmentDto, user: AuthenticatedUser): Promise<ScopeAssessmentResponse> {
    const schoolId = requireSchoolId(user);
    const level = dto.teachingLevelHours ?? null;
    const exceptionKind = dto.exceptionKind ?? null;
    const ownInitiativeOn = dto.ownInitiativeOn ?? null;
    if (level === null && exceptionKind === null) throw new BadRequestException(SCOPE_EMPTY);
    if (exceptionKind === 'OWN_INITIATIVE' && ownInitiativeOn === null) throw new BadRequestException(SCOPE_INITIATIVE_NEEDS_DAY);
    if (exceptionKind !== 'OWN_INITIATIVE' && ownInitiativeOn !== null) throw new BadRequestException(SCOPE_DAY_NEEDS_INITIATIVE);
    const data = {
      teachingLevelHours: level,
      exceptionKind,
      ownInitiativeOn: ownInitiativeOn === null ? null : new Date(`${ownInitiativeOn}T00:00:00.000Z`),
      note: dto.note ?? null,
    };

    try {
      return await this.prisma.withRls(user, async (tx) => {
        // The person is a teacher (or a teaching administrator), read under the lock every staffing write takes, so a demotion to
        // pupil cannot interleave with this write.
        await lockStaffRow(tx, userId, 'bedömning');
        const year = await tx.academicYear.findUnique({ where: { id: academicYearId }, select: { startDate: true, gradeNumbering: true } });
        if (!year) throw new NotFoundException('Academic year not found.');
        const [version] = await readScopeVersions(tx, day(year.startDate));
        if (!version) throw new BadRequestException(SCOPE_NOT_IN_FORCE);
        const edges = version.bands
          .filter((band) => band.schoolForm === SCOPE_SCHOOL_FORM && band.gradeNumbering === year.gradeNumbering)
          .map((band) => band.teachingHoursHigh);
        if (edges.length === 0) throw new BadRequestException(SCOPE_NUMBERING_NOT_COVERED);
        const edge = Math.max(...edges);
        if (level !== null && level > edge) throw new BadRequestException(scopeAboveEdge(edge));
        const saved = await tx.assignmentScopeAssessment.upsert({
          where: { schoolId_userId_academicYearId: { schoolId, userId, academicYearId } },
          create: { schoolId, userId, academicYearId, ...data },
          update: data,
        });
        const answer = toScopeAssessmentResponse(saved);
        // Only one who decides writes, and every decider reads HR; masked all the same, so the answer can never say more than the
        // list would to the same reader.
        return mayReadHrOf(user, userId) ? answer : hideScopeAssessment(answer);
      });
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  /** Take one teacher's assessment for one year away: the ordinance's own edge holds again, and no exception is registered. */
  async remove(userId: string, academicYearId: string, user: AuthenticatedUser): Promise<void> {
    const schoolId = requireSchoolId(user);
    try {
      await this.prisma.withRls(user, (tx) =>
        tx.assignmentScopeAssessment.delete({ where: { schoolId_userId_academicYearId: { schoolId, userId, academicYearId } } }),
      );
    } catch (error) {
      rethrowPrismaError(error);
    }
  }
}
