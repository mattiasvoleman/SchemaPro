import type { PrismaClient } from '@prisma/client';
import { readHomePupils, type HomeRow, type RosterBasis } from '../year-rollover/projected-rosters';

/**
 * What `MasterLessonsService.findConflicts` reads from the database, kept for
 * the rest of a FILE's rows (Schemat som tabell och i öppna format, the review
 * of PR #256, H6).
 *
 * A hand edit asks the clash rule once and the rule reads the school each time:
 * the day's lessons, the pupil buffers, the groups in play and their pupils,
 * the weekly unavailability. An import asks it once per row, five thousand
 * times, with nothing written in between, and the same reads came back nine
 * statements a row: 76 s for a preview of 5 000 rows. Passed as
 * `options.reads`, this answers each read ONCE for the whole file and each
 * later row from memory.
 *
 * NOT A NEW RULE. The rule is not touched and has one body; only where its
 * facts come from differs. Each cached read is answered by the same statement
 * the rule would have sent, or by a union of such statements, one per id, so
 * an answer built from the cache is the answer the database would have given:
 *
 *   - `once` memoises a read by the whole of its arguments (the day's lessons
 *     for a year, a day and a set of excluded ids; the pupil buffers of a year;
 *     the day's weekly constraints for a year);
 *   - groups, class halves, replacing groups and the pupils of a group are read
 *     through per id: a statement `WHERE id IN (…)` is the union of its ids, so
 *     asking for the ids not yet seen and joining them to the ones that were is
 *     the same answer. The home side of the roster is read through the year's
 *     basis (readHomePupils, as every roster reader must: next year's
 *     grundschema, laid in spring, is read on a projected basis), and what the
 *     basis leaves in each class is what is kept: the overlay moves a pupil to
 *     the class it is bound for and takes it out of the one it leaves, class
 *     by class, so the classes read one by one add up to the classes read
 *     together.
 *
 * ONE LIFETIME. An instance belongs to ONE plan, inside ONE transaction that
 * writes nothing the rule reads between its first and its last row. It must
 * never outlive that, and never be shared between requests: it holds the
 * school's lessons, pupils and groups as they were when read.
 */

/** A group as the roster read needs it. */
export interface GroupFacts {
  id: string;
  halfOfId: string | null;
  replacesSubjectId: string | null;
  academicYearId: string;
  kind: 'CLASS' | 'TEACHING_GROUP';
}

const GROUP_SELECT = { id: true, halfOfId: true, replacesSubjectId: true, academicYearId: true, kind: true } as const;

export class ConflictReads {
  private readonly memo = new Map<string, Promise<unknown>>();
  /** id -> the group, or null when the database has no such group. */
  private readonly groups = new Map<string, GroupFacts | null>();
  /** class id -> its halves, for the classes already asked about. */
  private readonly halves = new Map<string, GroupFacts[]>();
  /** `${year}|${subject}` -> the groups of that year replacing that subject. */
  private readonly replacing = new Map<string, GroupFacts[]>();
  /** group id -> the active pupils whose home class it is on the year's basis. */
  private readonly home = new Map<string, HomeRow[]>();
  /** group id -> the active pupils who are members of it. */
  private readonly members = new Map<string, Array<{ studentId: string; studentGroupId: string }>>();

  /**
   * The year's placed lessons of one weekday, less the excluded ids: the
   * `sameDay` read of the clash rule, as a method so that a reader which
   * already holds the whole year (the swap search, src/swaps) answers it from
   * memory, in the same shape and without a statement. Memoised by the whole of
   * its arguments here, as every read of a file is.
   */
  dayLessons<T>(
    academicYearId: string,
    dayOfWeek: number,
    excludeIds: readonly string[],
    load: () => Promise<T>,
  ): Promise<T> {
    return this.once(`sameDay|${academicYearId}|${dayOfWeek}|${[...excludeIds].sort().join(',')}`, load);
  }

  /** A read answered once for the arguments that make its key. */
  once<T>(key: string, load: () => Promise<T>): Promise<T> {
    let answer = this.memo.get(key) as Promise<T> | undefined;
    if (!answer) {
      answer = load();
      this.memo.set(key, answer);
      // A failed read is not kept: the transaction is dead anyway, but a retry must ask again.
      answer.catch(() => this.memo.delete(key));
    }
    return answer;
  }

  /** The groups `rosterOf`'s first statement returns: asked, halves of the asked, and the replacing groups. */
  async groupsInPlay(
    tx: PrismaClient,
    asked: readonly string[],
    replacing: { subjectIds: readonly string[]; academicYearId: string } | null,
  ): Promise<GroupFacts[]> {
    const found = new Map<string, GroupFacts>();

    const unknown = asked.filter((id) => !this.groups.has(id));
    if (unknown.length > 0) {
      const rows = await tx.studentGroup.findMany({ where: { id: { in: unknown } }, select: GROUP_SELECT });
      for (const row of rows) this.groups.set(row.id, row);
      for (const id of unknown) if (!this.groups.has(id)) this.groups.set(id, null);
    }
    for (const id of asked) {
      const group = this.groups.get(id);
      if (group) found.set(group.id, group);
    }

    for (const group of await this.halvesOfClasses(tx, asked)) found.set(group.id, group);

    if (replacing && replacing.subjectIds.length > 0) {
      const missing = replacing.subjectIds.filter((subjectId) => !this.replacing.has(`${replacing.academicYearId}|${subjectId}`));
      if (missing.length > 0) {
        const rows = await tx.studentGroup.findMany({
          where: { replacesSubjectId: { in: [...missing] }, academicYearId: replacing.academicYearId },
          select: GROUP_SELECT,
        });
        for (const subjectId of missing) {
          this.replacing.set(
            `${replacing.academicYearId}|${subjectId}`,
            rows.filter((row) => row.replacesSubjectId === subjectId),
          );
        }
        for (const row of rows) if (!this.groups.has(row.id)) this.groups.set(row.id, row);
      }
      for (const subjectId of replacing.subjectIds) {
        for (const group of this.replacing.get(`${replacing.academicYearId}|${subjectId}`) ?? []) found.set(group.id, group);
      }
    }
    return [...found.values()];
  }

  /** The halves of the given classes (the siblings statement of `rosterOf`, and its first statement's `halfOfId` arm). */
  async halvesOfClasses(tx: PrismaClient, classIds: readonly string[]): Promise<GroupFacts[]> {
    const missing = classIds.filter((id) => !this.halves.has(id));
    if (missing.length > 0) {
      const rows = await tx.studentGroup.findMany({ where: { halfOfId: { in: [...missing] } }, select: GROUP_SELECT });
      for (const id of missing) this.halves.set(id, rows.filter((row) => row.halfOfId === id));
      for (const row of rows) if (!this.groups.has(row.id)) this.groups.set(row.id, row);
    }
    return classIds.flatMap((id) => this.halves.get(id) ?? []);
  }

  /**
   * The pupils of the given groups, both sides of the roster, as `rosterOf`
   * reads them: active STUDENTs whose home class is the group (under the
   * year's basis) and active STUDENTs who are members of it.
   */
  async pupilsOf(
    tx: PrismaClient,
    basis: RosterBasis,
    ids: readonly string[],
  ): Promise<{ home: HomeRow[]; teaching: Array<{ studentId: string; studentGroupId: string }> }> {
    const missing = ids.filter((id) => !this.home.has(id));
    if (missing.length > 0) {
      const [homeRows, memberRows] = await Promise.all([
        readHomePupils(tx, basis, { role: 'STUDENT', isActive: true }, missing),
        tx.studentGroupMember.findMany({
          where: { studentGroupId: { in: [...missing] }, student: { role: 'STUDENT', isActive: true } },
          select: { studentId: true, studentGroupId: true },
        }),
      ]);
      for (const id of missing) {
        this.home.set(id, []);
        this.members.set(id, []);
      }
      for (const row of homeRows) if (row.studentGroupId) this.home.get(row.studentGroupId)?.push(row);
      for (const row of memberRows) this.members.get(row.studentGroupId)?.push(row);
    }
    return {
      home: ids.flatMap((id) => this.home.get(id) ?? []),
      teaching: ids.flatMap((id) => this.members.get(id) ?? []),
    };
  }
}
