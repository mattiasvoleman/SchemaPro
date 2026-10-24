/*
 * Delade lektioner: a timplanspost's shares as the gateway reads and writes
 * them (migration 20261205090000, src/common/lesson-shares.ts).
 *
 * A WRITE STATES THE WHOLE LIST. `shares` on a POST or PATCH is every share the
 * row ends up with, [] for none; a PATCH without the key leaves the stored ones
 * alone. The list is judged against the row AS IT WILL END UP — its lead, its
 * medlärare and its lessons after the PATCH — by sharesProblem, which names the
 * rule a write broke before the trigger (TS409) has to.
 *
 * IN THIS ORDER, IN ONE TRANSACTION: the stored shares deleted, the row
 * written, the new shares inserted. The trigger judges each statement on the
 * pair as it then stands, so a PATCH taking 9A's matematik from four lessons
 * to three while Bo's share goes from two to one meets a row of four with no
 * share, then a row of three with no share, then a row of three with Bo's one —
 * never four's share on three's lessons.
 */

import { BadRequestException, ConflictException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { isMixed, type LessonShape } from '../common/lesson-lengths';
import {
  canonicalShares,
  sharesProblem,
  type LessonShare,
  type SharedRow,
  type SharesProblem,
} from '../common/lesson-shares';
import { REQUIREMENT_SHARES_DO_NOT_FIT, requirementSharesConflict } from '../common/utils/prisma-errors';

/** One share as a request states it: the length may be left out on a uniform row. */
export interface ShareInput {
  teacherId?: string | null;
  lessons: number;
  minutes?: number;
}

/** A share as GET /teaching-requirements/shares answers it. */
export interface RequirementShareResponse {
  requirementId: string;
  teacherId: string | null;
  lessons: number;
  minutes: number;
}

/** The select every reader of a row's shares uses: the three figures, in canonicalShares' order. */
export const SHARE_SELECT = {
  select: { teacherId: true, lessons: true, minutes: true },
  orderBy: [{ minutes: 'desc' as const }, { teacherId: 'asc' as const }],
};

/**
 * The shares a request states, with their lengths: a uniform row's lessons are
 * all minutesPerLesson, so a share there needs none; a row of two or three
 * lengths has to say which. Not yet merged — sharesProblem must see a teacher
 * named twice to say so.
 */
export function sharesOfRequest(row: LessonShape, input: readonly ShareInput[]): LessonShare[] {
  return input.map((share, index) => {
    if (share.minutes === undefined && isMixed(row)) {
      throw new BadRequestException(
        `shares[${index}].minutes: posten har lektioner av olika längd, så andelen anger vilken längd den tar.`,
      );
    }
    return {
      teacherId: share.teacherId ?? null,
      lessons: share.lessons,
      minutes: share.minutes ?? row.minutesPerLesson,
    };
  });
}

/** The 409 or 400 for shares that cannot be stored on the row; see sharesProblem. */
export function sharesRefusal(problem: SharesProblem): BadRequestException | ConflictException {
  switch (problem) {
    case 'NOT_INTEGER':
    case 'OUT_OF_RANGE':
      // The DTO's own bounds; a request reaching here past them is malformed.
      return new BadRequestException('shares: en lärarandel är 1–39 hela lektioner av en hel längd.');
    case 'TEACHER_TWICE':
      return new ConflictException({
        message: 'Samma lärare står två gånger med samma lektionslängd. Slå ihop lärarens rader till en.',
        code: REQUIREMENT_SHARES_DO_NOT_FIT,
        reason: problem,
        params: { reason: problem },
      });
    default:
      return requirementSharesConflict(problem);
  }
}

/**
 * The shares as they will be stored, or the refusal: judged against the row as
 * it will end up, then merged per (teacher, length) in canonicalShares' order.
 */
export function judgedShares(row: SharedRow, shares: readonly LessonShare[]): LessonShare[] {
  const problem = sharesProblem(row, shares);
  if (problem !== null) throw sharesRefusal(problem);
  return canonicalShares(shares);
}

/** One row's stored shares, in canonicalShares' order. */
export async function storedSharesOf(tx: PrismaClient, requirementId: string): Promise<LessonShare[]> {
  return tx.teachingRequirementShare.findMany({
    where: { requirementId },
    ...SHARE_SELECT,
  });
}

/**
 * Locks the row FOR NO KEY UPDATE before its shares are replaced: the UPDATE
 * that follows takes the same lock, so this moves it a statement earlier and
 * inverts no order, and a second replacing write waits for the first to
 * commit and then deletes what it wrote.
 */
export async function lockPostForShares(tx: PrismaClient, requirementId: string): Promise<void> {
  await tx.$queryRaw`
    SELECT "id" FROM "TeachingRequirements" WHERE "id" = ${requirementId}::uuid FOR NO KEY UPDATE
  `;
}

/** Deletes a row's shares: the first of a replacing write's three statements. */
export async function clearShares(tx: PrismaClient, requirementId: string): Promise<void> {
  await tx.teachingRequirementShare.deleteMany({ where: { requirementId } });
}

/** Inserts a row's shares: the last of a replacing write's three statements. */
export async function insertShares(
  tx: PrismaClient,
  schoolId: string,
  requirementId: string,
  shares: readonly LessonShare[],
): Promise<void> {
  if (shares.length === 0) return;
  await tx.teachingRequirementShare.createMany({
    data: shares.map((share) => ({
      schoolId,
      requirementId,
      teacherId: share.teacherId,
      lessons: share.lessons,
      minutes: share.minutes,
    })),
  });
}

/** Every share of a year's timplansposter, by post, then canonicalShares' order. */
export async function sharesOfYear(tx: PrismaClient, academicYearId: string): Promise<RequirementShareResponse[]> {
  return tx.teachingRequirementShare.findMany({
    where: { requirement: { academicYearId } },
    select: { requirementId: true, teacherId: true, lessons: true, minutes: true },
    orderBy: [{ requirementId: 'asc' }, { minutes: 'desc' }, { teacherId: 'asc' }],
  });
}
