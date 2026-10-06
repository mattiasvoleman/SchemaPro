import { Injectable } from '@nestjs/common';
import type { Subject } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId } from '../common/utils/request-context';
import { rethrowPrismaError } from '../common/utils/prisma-errors';
import { assertNationalCodeIsKnown, normalizeNationalCode } from './national-codes';
import type { CreateSubjectDto, UpdateSubjectDto } from './dto/subject.dto';

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

  async create(dto: CreateSubjectDto, user: AuthenticatedUser): Promise<Subject> {
    const schoolId = requireSchoolId(user);
    const nationalCode = normalizeNationalCode(dto.nationalCode);
    try {
      return await this.prisma.withRls(user, async (tx) => {
        if (nationalCode !== null) {
          await assertNationalCodeIsKnown(tx, nationalCode);
        }
        return tx.subject.create({
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
          },
        });
      });
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  async update(
    id: string,
    dto: UpdateSubjectDto,
    user: AuthenticatedUser,
  ): Promise<Subject> {
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
        return tx.subject.update({
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
          },
        });
      });
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  async remove(id: string, user: AuthenticatedUser): Promise<void> {
    try {
      await this.prisma.withRls(user, (tx) => tx.subject.delete({ where: { id } }));
    } catch (error) {
      rethrowPrismaError(error);
    }
  }
}
