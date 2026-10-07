import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { Prisma, type AcademicYear, type PrismaClient } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId } from '../common/utils/request-context';
import { rethrowPrismaError } from '../common/utils/prisma-errors';
import { parseDateString } from '../common/utils/time';
import { attachDefaultTimplans, type YearTimplanRow } from '../timplan/year-timplans';
import type {
  CreateAcademicYearDto,
  UpdateAcademicYearDto,
} from './dto/academic-year.dto';
import { pendingMoves, planActivation, readActivationSource } from '../year-rollover/activation-plan';
import { activationRefusal, todayInStockholm } from '../year-rollover/year-rollover.service';

/** PATCH {isActive: true} on a year whose pupils have not moved in yet. */
export const YEAR_ACTIVATION_HAS_MOVES = 'YEAR_ACTIVATION_HAS_MOVES';
/** DELETE of a year whose classes are active pupils' home classes. */
export const YEAR_HAS_HOME_PUPILS = 'YEAR_HAS_HOME_PUPILS';

/** A created year, with the årskurser it follows a timplan in from the start. */
export type CreatedAcademicYear = AcademicYear & { timplans: YearTimplanRow[] };

@Injectable()
export class AcademicYearsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * A new läsår, and its timplan per årskurs: every grade the school's newest
   * DECIDED plan can speak for follows that plan from the start (see
   * attachDefaultTimplans), in the same transaction, so a year never exists
   * half-seeded. No decided plan, no rows — a school without a timplan creates
   * years exactly as before. The dialog's "Timplan per årskurs" edits them
   * afterwards through PUT /academic-years/:id/timplans.
   */
  async create(
    dto: CreateAcademicYearDto,
    user: AuthenticatedUser,
  ): Promise<CreatedAcademicYear> {
    const schoolId = requireSchoolId(user);
    if (dto.startDate >= dto.endDate) {
      throw new BadRequestException('startDate must be before endDate.');
    }
    try {
      return await this.prisma.withRls(user, async (tx) => {
        // Only one academic year may be active per school, and the partial
        // unique index AcademicYears_one_active_per_school is what holds it.
        // This UPDATE runs at READ COMMITTED and cannot see a year another
        // transaction activates meanwhile, so two activations at once used to
        // both commit. Now the second fails on its own write with P2002, which
        // rethrowPrismaError answers with 409; nothing here catches it, so its
        // hand-over rolls back with it.
        //
        // The hand-over still comes first. The index is checked as each row is
        // written, not at commit, so writing the new year active while the old
        // one still is would be refused every time, race or not.
        if (dto.isActive) {
          await tx.academicYear.updateMany({
            where: { schoolId, isActive: true },
            data: { isActive: false },
          });
        }
        const year = await tx.academicYear.create({
          data: {
            schoolId,
            name: dto.name,
            startDate: parseDateString(dto.startDate),
            endDate: parseDateString(dto.endDate),
            isActive: dto.isActive ?? false,
          },
        });
        const timplans = await attachDefaultTimplans(tx, schoolId, year.id);
        return { ...year, timplans };
      });
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  async update(
    id: string,
    dto: UpdateAcademicYearDto,
    user: AuthenticatedUser,
  ): Promise<AcademicYear> {
    const schoolId = requireSchoolId(user);
    try {
      return await this.prisma.withRls(user, async (tx) => {
        // Moving the year is the other half of the containment rule that
        // TeachingRequirementsService.assertPeriodFitsYear enforces when a
        // period is written. Without this the invariant held only in one
        // direction: every period was measured against the year it was saved
        // into, and then the year could walk out from under all of them.
        //
        // Checked before the sibling deactivation below, not merely before the
        // update: the transaction would roll that write back anyway, but a
        // refusal that has already written something is one refactor away from
        // being a refusal that stole another year's active flag.
        if (dto.startDate !== undefined || dto.endDate !== undefined) {
          await this.assertYearStillHoldsItsPeriods(tx, id, dto);
        }

        // A year activated by its flag alone would leave its classes empty
        // and its pupils in the year before: activation moves them, so the
        // flag waits for it. See assertFlagCanBeHandedOver.
        if (dto.isActive) {
          await this.assertFlagCanBeHandedOver(tx, id);
        }

        // The same hand-over as in create(), ahead of the write for the same
        // reason: the one-active-year index checks the row as it lands.
        if (dto.isActive) {
          await tx.academicYear.updateMany({
            where: { schoolId, isActive: true, id: { not: id } },
            data: { isActive: false },
          });
        }

        return tx.academicYear.update({
          where: { id },
          data: {
            ...(dto.name !== undefined ? { name: dto.name } : {}),
            ...(dto.startDate !== undefined
              ? { startDate: parseDateString(dto.startDate) }
              : {}),
            ...(dto.endDate !== undefined
              ? { endDate: parseDateString(dto.endDate) }
              : {}),
            ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
          },
        });
      });
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  /**
   * Deletes the year, unless its classes are somebody's home class.
   *
   * WHY. A year's groups cascade with it, and Users.studentGroupId is ON
   * DELETE SET NULL, so deleting a year that holds pupils' home classes
   * leaves every one of them without a class — silently, and with nothing in
   * the app that can say which class each was in. Rollover made that a likely
   * click: "delete the new year" undoes a rollover, and after its activation
   * the new year is where the pupils are. The count names the size of it; the
   * pupils have to be moved (or the year activated away from) first.
   *
   * Read in the delete's transaction, before it. A pupil enrolled into one of
   * its classes in between is the race the SET NULL used to lose silently,
   * and now loses the same way; the window is one admin enrolling while
   * another deletes the year, which nobody does on purpose.
   */
  async remove(id: string, user: AuthenticatedUser): Promise<void> {
    try {
      await this.prisma.withRls(user, async (tx) => {
        const pupils = await tx.user.count({
          where: { role: 'STUDENT', isActive: true, studentGroup: { academicYearId: id } },
        });
        if (pupils > 0) {
          throw new ConflictException({
            message:
              `Läsåret har klasser som är hemklass för ${pupils} aktiva elever. ` +
              'Flytta eleverna, eller aktivera ett annat läsår som tar över dem, innan läsåret tas bort.',
            code: YEAR_HAS_HOME_PUPILS,
            params: { pupils },
          });
        }
        await tx.academicYear.delete({ where: { id } });
      });
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  /**
   * PATCH {isActive: true}: refused for a year whose pupils have not moved in
   * (YEAR_ACTIVATION_HAS_MOVES — the activation moves them, with a preview)
   * and for a year whose successor already holds the pupils
   * (YEAR_IS_SUPERSEDED, the activation's own refusal). A year outside every
   * rollover chain plans no moves and flips as it always has.
   *
   * `null` from the read is a year RLS hides; the update answers it 404.
   */
  private async assertFlagCanBeHandedOver(tx: PrismaClient, id: string): Promise<void> {
    const source = await readActivationSource(tx, id);
    if (!source) return;
    const plan = planActivation(source, todayInStockholm());
    const superseded = plan.problems.find((problem) => problem.code === 'YEAR_IS_SUPERSEDED');
    if (superseded) throw activationRefusal(superseded);
    const moves = pendingMoves(plan);
    if (moves > 0) {
      throw new ConflictException({
        message:
          `${moves} elever har ännu inte flyttats in i läsåret ${plan.year.name}s klasser. ` +
          'Aktivera läsåret genom aktiveringen, som visar och gör flytten, i stället för att bara byta aktivt läsår.',
        code: YEAR_ACTIVATION_HAS_MOVES,
        params: { pupils: moves },
      });
    }
  }

  /**
   * A year linked by a rollover stays after its predecessor and before its
   * successor: activation reads "today is after the old year" off these
   * dates, and a successor starting before its predecessor ends would make
   * the two run at once. Checked against the dates the PATCH leaves, not the
   * ones it sent. Read without a lock: the neighbour's own PATCH is the only
   * writer, and two admins moving both ends of a chain in the same second is
   * not a case this guards.
   */
  private async assertLinkedYearsStayInOrder(
    tx: Prisma.TransactionClient,
    id: string,
    startDate: Date,
    endDate: Date,
  ): Promise<void> {
    const linked = await tx.academicYear.findUnique({
      where: { id },
      select: {
        predecessor: { select: { name: true, endDate: true } },
        successor: { select: { name: true, startDate: true } },
      },
    });
    const asDate = (value: Date): string => value.toISOString().slice(0, 10);
    if (linked?.predecessor && startDate <= linked.predecessor.endDate) {
      throw new BadRequestException(
        `startDate: läsåret fortsätter ${linked.predecessor.name} och måste börja efter att det slutar ` +
          `(${asDate(linked.predecessor.endDate)}).`,
      );
    }
    if (linked?.successor && endDate >= linked.successor.startDate) {
      throw new BadRequestException(
        `endDate: läsåret fortsätter i ${linked.successor.name} och måste sluta innan det börjar ` +
          `(${asDate(linked.successor.startDate)}).`,
      );
    }
  }

  /**
   * Refuses to move the year's own dates past a period that already depends on
   * them, and says how many periods are in the way.
   *
   * WHY REFUSE RATHER THAN FIX. Three ways out were on the table:
   *
   *  (a) refuse, naming the count — this one;
   *  (b) clip the offending periods to the new year;
   *  (c) drop the claim that a period lies inside its year.
   *
   * (b) rewrites data nobody asked to change. "Vårterminen 11 jan - 11 jun"
   * quietly becomes "18 jan - 11 jun" because the year's start moved a week,
   * and the admin who moved the year is told nothing about the course whose
   * length they just changed. The edit that caused it is one field on another
   * page, so there is nothing for anyone to connect the wrong hours to later.
   *
   * (c) is what we had. A period stranded outside its year generates no
   * lessons at all: the timplan still lists the subject, the row still says
   * "3 lektioner/vecka", and the subject is simply never read. That surfaces
   * in November, from a parent, and there is no error anywhere to search for.
   *
   * (a) fails at the moment of the change, in the same click that caused it,
   * and names the number of rows standing in the way so the admin knows the
   * size of the job. It costs them a detour through the timplan; the other two
   * cost a term of a subject. The error is also the recoverable direction: a
   * refused year change loses nothing, while a clipped period cannot be
   * restored from anything the app still holds.
   *
   * Widening the year always passes — nothing that fit inside the old bounds
   * can fall outside a superset — so the common corrections (extend the term,
   * fix a typo in June) are unaffected. It is the narrowing and the shift that
   * are stopped, which is exactly the pair that strands periods.
   *
   * `year` is missing when the lookup found nothing, which under RLS means the
   * year is not the caller's. Silent on purpose: the update below answers that
   * with the 404 it has always answered with, and counting somebody else's
   * requirements at them would confirm the year exists.
   *
   * THE BOUNDS ARE READ UNDER A ROW LOCK, in the transaction that writes them.
   * `withRls` runs READ COMMITTED, where a plain read holds nothing still, and
   * nothing on AcademicYears orders the two dates. Against a year with no dated
   * period yet, a PATCH moving the start to 2027-06-01 and one moving the end
   * to 2026-09-01 would each pass against the row the other has not changed,
   * and together store a year that ends before it starts. With the lock the
   * second PATCH waits for the first to commit and is measured against what it
   * wrote. The periods the counts see needed no lock of their own: each of the
   * four comparisons is made against a bound one of the two PATCHes moved, so
   * a period both counts let through lies inside the year they build together,
   * and a dated period is itself what keeps that year from inverting.
   *
   * A period written at the same moment is held still from the other side.
   * SchoolBreaksService, TeachingRequirementsService and the timplan import
   * read these bounds FOR SHARE in the transaction that writes the period
   * (readYearBoundsForShare), and FOR SHARE and this lock wait on each other.
   * A period whose read came first has committed before this lock is granted,
   * so the counts, each a statement of its own, see it; a period whose read
   * comes second waits for this PATCH and is measured against what it wrote.
   *
   * FOR NO KEY UPDATE rather than FOR UPDATE: see the Isolation section of
   * PrismaService — every year-scoped insert takes FOR KEY SHARE on this row. A
   * raw `date` column comes back as the same midnight-UTC Date the model API
   * returns.
   */
  private async assertYearStillHoldsItsPeriods(
    tx: Prisma.TransactionClient,
    id: string,
    dto: UpdateAcademicYearDto,
  ): Promise<void> {
    const [year] = await tx.$queryRaw<Pick<AcademicYear, 'startDate' | 'endDate'>[]>`
      SELECT "startDate", "endDate"
      FROM "AcademicYears"
      WHERE "id" = ${id}::uuid
      FOR NO KEY UPDATE
    `;
    if (!year) return;

    // The bounds as they will END UP, not as they arrived: a PATCH carrying
    // only `startDate` still has to be measured together with the endDate
    // already on the row. Same reasoning as the one-field-at-a-time case in
    // TeachingRequirementsService.update.
    const startDate =
      dto.startDate !== undefined ? parseDateString(dto.startDate) : year.startDate;
    const endDate =
      dto.endDate !== undefined ? parseDateString(dto.endDate) : year.endDate;

    // create() rejects this before the transaction opens; update() never did,
    // so a one-sided move could invert the year. Checked here rather than
    // early because only the merged pair can be inverted, and because an
    // inverted year would otherwise be reported below as "every period is
    // outside", which is true and says nothing about the actual mistake.
    if (startDate >= endDate) {
      throw new BadRequestException('startDate must be before endDate.');
    }
    await this.assertLinkedYearsStayInOrder(tx, id, startDate, endDate);

    // Only a stated period can fall outside: null means "the year's own
    // boundary", which follows the year wherever it goes. Prisma's comparison
    // filters skip NULLs, so those rows are excluded without saying so twice.
    const stranded = await tx.teachingRequirement.count({
      where: {
        academicYearId: id,
        OR: [
          { startDate: { lt: startDate } },
          { startDate: { gt: endDate } },
          { endDate: { lt: startDate } },
          { endDate: { gt: endDate } },
        ],
      },
    });
    /*
     * Lov are dated against the same year and strand the same way, and worse.
     *
     * A stranded requirement period simply generates nothing. A stranded lov
     * stops suppressing publish — lessons reappear across a week the school is
     * shut — and it can never be edited back, because every write path measures
     * the range against the year it no longer fits inside. The only way out is
     * to delete it, which is not what an administrator moving a year by three
     * days is trying to do.
     *
     * Counted separately rather than folded into one number: "4 rader" tells
     * nobody where to look, and the two live on different pages.
     */
    const strandedBreaks = await tx.schoolBreak.count({
      where: {
        academicYearId: id,
        OR: [
          { startDate: { lt: startDate } },
          { startDate: { gt: endDate } },
          { endDate: { lt: startDate } },
          { endDate: { gt: endDate } },
        ],
      },
    });

    if (stranded === 0 && strandedBreaks === 0) return;

    const asDate = (value: Date): string => value.toISOString().slice(0, 10);
    const parts: string[] = [];
    if (stranded > 0) {
      parts.push(
        `${stranded} teaching requirement${stranded === 1 ? '' : 's'}`,
      );
    }
    if (strandedBreaks > 0) {
      parts.push(`${strandedBreaks} break${strandedBreaks === 1 ? '' : 's'}`);
    }
    throw new BadRequestException(
      `${parts.join(' and ')} would fall outside the new academic year ` +
        `(${asDate(startDate)} to ${asDate(endDate)}). ` +
        'Move or clear them first.',
    );
  }
}
