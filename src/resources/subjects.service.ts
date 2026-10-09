import { ConflictException, Injectable } from '@nestjs/common';
import type { Subject } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId } from '../common/utils/request-context';
import {
  TIMPLAN_IS_DECIDED,
  decidedTimplanRefusal,
  listNames,
  rethrowPrismaError,
} from '../common/utils/prisma-errors';
import { assertNationalCodeIsKnown, normalizeNationalCode } from './national-codes';
import type { CreateSubjectDto, UpdateSubjectDto } from './dto/subject.dto';

/**
 * A subject as the client sees it: the Decimal loadFactor as a number.
 * Prisma hands NUMERIC(4,3) back as a Decimal, which JSON renders as the
 * string "0.7" — a form multiplying by it would get NaN. Converted once here,
 * like the policy's semesterHoursPerWeek.
 */
export interface SubjectResponse extends Omit<Subject, 'loadFactor'> {
  loadFactor: number;
}

export function toSubjectResponse(row: Subject): SubjectResponse {
  return { ...row, loadFactor: Number(row.loadFactor) };
}

/**
 * A school's subjects, and since the national timplan became reference data,
 * each one's place in it.
 *
 * `nationalCode` is checked against NationalSubjects INSIDE the writing
 * transaction and refused with the field named, before the row is written. The
 * FK on the column refuses it a second time, for PostgREST and psql; this
 * service exists so an admin typing a code into the form gets a sentence about
 * the code and not a 409 about "a record". The response is the stored row, so
 * both new columns come back exactly as the database holds them.
 */
@Injectable()
export class SubjectsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateSubjectDto, user: AuthenticatedUser): Promise<SubjectResponse> {
    const schoolId = requireSchoolId(user);
    const nationalCode = normalizeNationalCode(dto.nationalCode);
    try {
      return await this.prisma.withRls(user, async (tx) => {
        if (nationalCode !== null) {
          await assertNationalCodeIsKnown(tx, nationalCode);
        }
        const row = await tx.subject.create({
          data: {
            schoolId,
            name: dto.name,
            code: dto.code ?? null,
            color: dto.color ?? null,
            requiredRoomTypeId: dto.requiredRoomTypeId ?? null,
            nationalCode,
            // Explicit rather than left to the column default, so the create
            // call states the whole row and a spec can read the default here.
            countsTowardTimplan: dto.countsTowardTimplan ?? true,
            loadFactor: dto.loadFactor ?? 1,
          },
        });
        return toSubjectResponse(row);
      });
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  async update(
    id: string,
    dto: UpdateSubjectDto,
    user: AuthenticatedUser,
  ): Promise<SubjectResponse> {
    // Three states, not two: absent leaves the mapping alone, null clears it,
    // a string is looked up. normalizeNationalCode folds '' into null, so a
    // form that posts its empty option as an empty string clears too.
    const nationalCode =
      dto.nationalCode === undefined ? undefined : normalizeNationalCode(dto.nationalCode);
    try {
      return await this.prisma.withRls(user, async (tx) => {
        if (nationalCode != null) {
          await assertNationalCodeIsKnown(tx, nationalCode);
        }
        const row = await tx.subject.update({
          where: { id },
          data: {
            ...(dto.name !== undefined ? { name: dto.name } : {}),
            ...(dto.code !== undefined ? { code: dto.code } : {}),
            ...(dto.color !== undefined ? { color: dto.color } : {}),
            ...(dto.requiredRoomTypeId !== undefined
              ? { requiredRoomTypeId: dto.requiredRoomTypeId }
              : {}),
            ...(nationalCode !== undefined ? { nationalCode } : {}),
            ...(dto.countsTowardTimplan !== undefined
              ? { countsTowardTimplan: dto.countsTowardTimplan }
              : {}),
            ...(dto.loadFactor !== undefined ? { loadFactor: dto.loadFactor } : {}),
          },
        });
        return toSubjectResponse(row);
      });
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  /**
   * Delete a subject — unless a DECIDED lokal timplan contains it.
   *
   * A decided plan is a record, and a subject vanishing out of it would
   * rewrite the record by cascade. The database refuses that itself (the
   * entries trigger raises TP409 when the cascade reaches a decided plan's
   * entries); this service asks first, so the answer names EVERY such plan
   * rather than the first one the cascade happened to reach, and says what to
   * do. The trigger stays the second line: a plan decided between the question
   * and the delete still refuses the delete, and its refusal is translated to
   * the same 409 with the plan the trigger named. Subjects that only DRAFT
   * plans contain are deleted and their entries cascade, as before.
   *
   * The plans that hold the subject are locked FOR SHARE first, in id order,
   * before anything is deleted. The cascade's entries trigger takes that same
   * lock on each parent plan, but only AFTER the cascade has locked the entry
   * rows — the opposite order to a grid save (PUT /local-timplans/:id/entries
   * and the timplan import touch the plan row, then delete its entries). A
   * save and a subject delete meeting in one draft therefore deadlocked
   * (40P01, a 500), reproduced on PostgreSQL 16 with two sessions; with the
   * plan locked first, the delete waits for the save to commit and then
   * proceeds. FOR SHARE, not FOR UPDATE: two subject deletes in one plan do
   * not conflict, since their cascades lock different entry rows.
   */
  async remove(id: string, user: AuthenticatedUser): Promise<void> {
    try {
      await this.prisma.withRls(user, async (tx) => {
        await tx.$queryRaw`
          SELECT p."id" FROM "LocalTimplans" p
           WHERE p."id" IN (
             SELECT e."localTimplanId" FROM "LocalTimplanEntries" e WHERE e."subjectId" = ${id}::uuid
           )
           ORDER BY p."id"
             FOR SHARE`;
        const decided = await tx.localTimplan.findMany({
          where: { status: 'DECIDED', entries: { some: { subjectId: id } } },
          select: { name: true },
          orderBy: { name: 'asc' },
        });
        if (decided.length > 0) {
          throw subjectInDecidedTimplan(decided.map((plan) => plan.name));
        }
        await tx.subject.delete({ where: { id } });
      });
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      const refusal = decidedTimplanRefusal(error);
      if (refusal) {
        throw subjectInDecidedTimplan(refusal.planName === null ? [] : [refusal.planName]);
      }
      rethrowPrismaError(error);
    }
  }
}

/** The 409 for a subject a decided plan holds, naming the plan(s). */
export function subjectInDecidedTimplan(planNames: string[]): ConflictException {
  const where =
    planNames.length === 0
      ? 'en beslutad lokal timplan'
      : planNames.length === 1
        ? `den beslutade lokala timplanen ${listNames(planNames)}`
        : `de beslutade lokala timplanerna ${listNames(planNames)}`;
  const many = planNames.length > 1;
  return new ConflictException({
    message:
      `Ämnet ingår i ${where} och kan inte tas bort: en beslutad timplan ändras inte. ` +
      `Ta bort ${many ? 'de beslutade timplanerna' : 'den beslutade timplanen'} först om ämnet ska bort, ` +
      `eller öppna ${many ? 'dem' : 'den'} igen som utkast och besluta en ny utan ämnet.`,
    code: TIMPLAN_IS_DECIDED,
  });
}
