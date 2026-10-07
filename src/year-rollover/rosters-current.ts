import { ConflictException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { MAX_CHAIN_HOPS } from './activation-plan';

/** A write that reads a läsår's class rosters, asked of a rolled year that is not activated yet. */
export const ROLLOVER_NOT_ACTIVATED = 'ROLLOVER_NOT_ACTIVATED';

/**
 * Refuses a roster-reading write for a läsår whose pupils have not moved in.
 *
 * WHY. Pupil clashes, room capacity and lunch headcounts are read from the
 * classes' home pupils (Users.studentGroupId, through loadRosters and the
 * master lessons' rosterOf). A year created by a rollover has empty classes
 * until it is activated, and its teaching groups' copied members still have
 * last year's classes as their home class: Ma8's pupils are in 7A, not in 8A.
 * A schedule generated for it, a room proposal, or a lesson placed by hand
 * would therefore not see that Ma8 and 8A share pupils, and could put them at
 * the same time. Wrong, and silently so.
 *
 * THE FALLBACK. The R-0 spec's §7 has two answers: "projected rosters" (the
 * roster readers map home classes along the successor links for a year not
 * yet activated, so next year can be planned in spring) or this refusal. The
 * choice between them is the user's and still open; this is the one that
 * cannot plan anything wrong, and is undone by deleting four calls when the
 * projection lands. Requirement writes are not refused: they judge a grade
 * span from the group's own grade when its pupils are not there.
 *
 * WHICH YEARS. One that is not active and whose predecessor chain still holds
 * active pupils — exactly the pupils its activation would move. The active
 * year is never refused, not even with a straggler left in last year's class
 * (the years page offers to move them): that is one pupil's lessons, not a
 * year's classes. A year outside every rollover chain is not refused either.
 * Nothing else is read for an active year, so the hot path (a lesson dragged
 * in this year's grundschema) costs one small read.
 */
export async function refuseRostersNotActivated(tx: PrismaClient, academicYearId: string): Promise<void> {
  const years =
    (await tx.academicYear.findMany({
      select: { id: true, name: true, isActive: true, predecessorId: true },
    })) ?? [];
  const byId = new Map(years.map((year) => [year.id, year]));
  const year = byId.get(academicYearId);
  if (!year || year.isActive !== false || !year.predecessorId) return;

  const chain: string[] = [];
  let at = byId.get(year.predecessorId);
  while (at && !chain.includes(at.id) && at.id !== academicYearId && chain.length < MAX_CHAIN_HOPS) {
    chain.push(at.id);
    at = at.predecessorId ? byId.get(at.predecessorId) : undefined;
  }
  if (chain.length === 0) return;
  const pupils =
    (await tx.user.count({
      where: { role: 'STUDENT', isActive: true, studentGroup: { academicYearId: { in: chain } } },
    })) ?? 0;
  if (pupils === 0) return;
  throw new ConflictException({
    message:
      `Läsåret ${year.name} är inte aktiverat: ${pupils} elever går fortfarande i förra årets klasser. ` +
      'Elevkrockar, salarnas platser och lunchens antal räknas på klassernas elever, så läsåret kan schemaläggas ' +
      'först när det har aktiverats.',
    code: ROLLOVER_NOT_ACTIVATED,
    params: { year: year.name, pupils },
  });
}
