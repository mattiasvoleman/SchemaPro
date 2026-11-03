import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type { Prisma, PrismaClient, StudentGroup } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { recordRead } from '../access-log/access-log';
import { PrismaService } from '../database/prisma.service';
import { tellNewMentors } from '../family/leave-notices';
import { NotificationsService } from '../notifications/notifications.service';
import { requireSchoolId } from '../common/utils/request-context';
import { rethrowPrismaError, studentGroupHasEnrolmentHistory } from '../common/utils/prisma-errors';
import {
  BULK_TIMEOUT_MS,
  assertSomeChange,
  notFound,
  refusalOf,
  runBulk,
  uniqueIds,
  writeAll,
  type BulkDeleteDto,
  type BulkRefusal,
  type BulkResult,
} from '../common/bulk';
import { GROUP_KEYS, countByKind, grownSince, type GroupKeyKind } from '../common/removal-inventory';
import type {
  BulkUpdateStudentGroupsDto,
  CreateStudentGroupDto,
  PlaceHalvesDto,
  SetGroupMembersDto,
  SplitClassDto,
  UpdateStudentGroupDto,
} from './dto/student-group.dto';

/** The problem codes of "Dela klassen" and of placing pupils in halves. */
export const NOT_A_CLASS = 'NOT_A_CLASS';
export const CLASS_ALREADY_SPLIT = 'CLASS_ALREADY_SPLIT';
export const GROUP_NAME_TAKEN = 'GROUP_NAME_TAKEN';
export const NOT_THE_CLASS_HALVES = 'NOT_THE_CLASS_HALVES';
export const PUPIL_IN_TWO_HALVES = 'PUPIL_IN_TWO_HALVES';
export const PUPIL_NOT_IN_CLASS = 'PUPIL_NOT_IN_CLASS';
/** The problem code of a class or a half asked to replace a subject (Ersättande grupper). */
export const REPLACING_GROUP_NOT_A_TEACHING_GROUP = 'REPLACING_GROUP_NOT_A_TEACHING_GROUP';

/**
 * Ersättande grupper (20261211090000): a group may replace a subject only as
 * a teaching group that is not a half, and only one of its school's
 * subjects. Asked before the write so the 400 can say which; the CHECK and
 * the composite foreign key refuse a race or a PostgREST writer the same way.
 */
async function assertMayReplace(
  tx: Prisma.TransactionClient,
  group: { kind: string; halfOfId: string | null },
  subjectId: string | null | undefined,
): Promise<void> {
  if (!subjectId) return;
  const refusal = replaceRefusal(group);
  if (refusal) throw refusal;
  await assertSubjectIsTheSchools(tx, subjectId);
}

/** Why `group` may not replace a subject (Ersättande grupper), or null when it may. */
function replaceRefusal(group: { kind: string; halfOfId: string | null }): BadRequestException | null {
  if (group.kind === 'TEACHING_GROUP' && group.halfOfId === null) return null;
  return new BadRequestException({
    message:
      group.kind === 'TEACHING_GROUP'
        ? 'En halvklass är en del av klassen och kan inte ersätta klassens lektioner i ett ämne.'
        : 'En klass är elevernas hemklass och kan inte ersätta sina egna lektioner i ett ämne. Gör en undervisningsgrupp för SvA.',
    code: REPLACING_GROUP_NOT_A_TEACHING_GROUP,
  });
}

async function assertSubjectIsTheSchools(tx: Prisma.TransactionClient, subjectId: string): Promise<void> {
  const subject = await tx.subject.findUnique({ where: { id: subjectId }, select: { id: true } });
  if (!subject) throw new BadRequestException('replacesSubjectId: ämnet finns inte i skolan.');
}

/**
 * What goes with a bulk delete of groups: every key to StudentGroups in the
 * catalogue, counted (GROUP_KEYS in src/common/removal-inventory.ts), plus
 * two kinds a level down that a reader needs to know go: the attendance
 * marks and the lesson logs on the groups' calendar lessons. A delete of one
 * group takes the same rows, unsaid. Counts only, none naming a pupil, so
 * the dry run is no read in the läslogg's sense: the attendance marks are a
 * figure over the groups' lessons, as the attendance summary is.
 *
 * Counted over the named groups and the halves a named class takes with it.
 */
export interface GroupRemovalConsequences extends Record<GroupKeyKind, number> {
  /** Attendance marks on the groups' calendar lessons, which go with them. */
  attendanceMarks: number;
  /** Lesson logs (klassbok entries) on those lessons, which go with them. */
  lessonLogs: number;
  /** Groups linked to the school's SS12000 source, which its next sync may add again. */
  fromSource: number;
}

async function groupRemovalConsequences(
  tx: Prisma.TransactionClient,
  groups: { id: string; ss12000Id: string | null }[],
): Promise<GroupRemovalConsequences> {
  const named = groups.map((group) => group.id);
  // A half the call names goes as itself, not with its class; a successor the
  // call deletes too loses nothing it keeps.
  const halves = await tx.studentGroup.findMany({
    where: { halfOfId: { in: named }, id: { notIn: named } },
    select: { id: true },
  });
  const all = [...named, ...halves.map((half) => half.id)];
  const byKey = await countByKind(tx as PrismaClient, GROUP_KEYS, all, ['halves', 'successors']);
  const inGroups = { studentGroupId: { in: all } };
  return {
    ...byKey,
    halves: halves.length,
    successors: await tx.studentGroup.count({ where: { predecessorId: { in: all }, id: { notIn: all } } }),
    attendanceMarks: await tx.attendanceRecord.count({ where: { calendarLesson: inGroups } }),
    lessonLogs: await tx.lessonLog.count({ where: { calendarLesson: inGroups } }),
    fromSource: groups.filter((group) => group.ss12000Id !== null).length,
  };
}

/**
 * The pupils a half of `theClass` may hold: the active pupils whose home
 * class is the class, or — a rolled läsår not yet activated — its
 * predecessor, whose pupils move into it at activation. The rule the trigger
 * app.student_group_members_in_the_class holds every writer to, read here
 * first so a refusal can say how many and of which class.
 */
async function pupilsOfTheClass(
  tx: Prisma.TransactionClient,
  theClass: { id: string; predecessorId: string | null },
): Promise<Set<string>> {
  const rows = await tx.user.findMany({
    where: {
      role: 'STUDENT',
      isActive: true,
      studentGroupId: { in: theClass.predecessorId ? [theClass.id, theClass.predecessorId] : [theClass.id] },
    },
    select: { id: true },
  });
  return new Set(rows.map((row) => row.id));
}

/**
 * The pupils' rows FOR SHARE, in id order, before a placement touches a
 * membership row. A class change takes the pupil's row first and the
 * memberships after (the Users trigger leaves the old class's halves); a
 * placement that deleted a pupil's half row and only then met the pupil's
 * row (the member trigger reads it FOR SHARE) would take them the other way
 * round, and the two could deadlock. Held first, a class change waits for
 * the placement or the placement for it, and either sees the other's commit.
 */
async function holdPupils(tx: Prisma.TransactionClient, pupils: Iterable<string>): Promise<void> {
  const ids = [...pupils].sort();
  if (ids.length === 0) return;
  await tx.$queryRaw`SELECT 1 FROM "Users" WHERE "id" = ANY(${ids}::uuid[]) ORDER BY "id" FOR SHARE`;
}

function pupilsNotInClass(count: number, className: string): BadRequestException {
  return new BadRequestException({
    message: `${count === 1 ? 'En elev' : `${count} elever`} går inte i ${className} och kan inte placeras i klassens halvor.`,
    code: PUPIL_NOT_IN_CLASS,
  });
}

/**
 * The class row FOR NO KEY UPDATE, the lock "Dela klassen" takes before it
 * asks whether the class has halves: two splits of one class at the same
 * moment would make four halves, and the second waits here and then finds
 * the halves the first made. NO KEY, so the halves' own foreign key (KEY
 * SHARE on the class) never waits on it. Also taken by "Dela terminsvis i
 * halvklass" (term-halves.service.ts), which splits the class when it has no
 * halves yet.
 */
export async function lockClassForSplit(tx: Prisma.TransactionClient, classId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM "StudentGroups" WHERE "id" = ${classId}::uuid FOR NO KEY UPDATE`;
}

/**
 * "Dela klassen" under lockClassForSplit: the class's two halves, named
 * "7A:1" and "7A:2" unless `names` gives others, with the refusals the
 * split route answers (NOT_A_CLASS, CLASS_ALREADY_SPLIT, GROUP_NAME_TAKEN).
 * The names are asked of the year case-insensitively, as the importers and
 * the rollover read a name.
 */
export async function splitLockedClass(
  tx: Prisma.TransactionClient,
  schoolId: string,
  classId: string,
  requestedNames: readonly string[] | undefined,
): Promise<StudentGroup[]> {
  const theClass = await tx.studentGroup.findUnique({
    where: { id: classId },
    select: {
      name: true,
      kind: true,
      academicYearId: true,
      gradeLevel: true,
      _count: { select: { halves: true } },
    },
  });
  if (!theClass) throw new NotFoundException('Student group not found.');
  if (theClass.kind !== 'CLASS') {
    throw new BadRequestException({ message: 'Bara en klass kan delas i halvor.', code: NOT_A_CLASS });
  }
  if (theClass._count.halves > 0) {
    throw new ConflictException({ message: `${theClass.name} är redan delad i halvor.`, code: CLASS_ALREADY_SPLIT });
  }
  const names = (requestedNames ?? [`${theClass.name}:1`, `${theClass.name}:2`]).map((name) => name.trim());
  if (names.some((name) => name.length === 0) || new Set(names.map((name) => name.toLowerCase())).size !== names.length) {
    throw new BadRequestException('names: två olika namn, ett för varje halva.');
  }
  const taken = await tx.studentGroup.findMany({
    where: {
      academicYearId: theClass.academicYearId,
      OR: names.map((name) => ({ name: { equals: name, mode: 'insensitive' as const } })),
    },
    select: { name: true },
    orderBy: { name: 'asc' },
  });
  if (taken.length > 0) {
    throw new ConflictException({
      message: `Läsåret har redan en grupp som heter ${taken.map((group) => group.name).join(' och ')}.`,
      code: GROUP_NAME_TAKEN,
    });
  }
  const created = await tx.studentGroup.createManyAndReturn({
    data: names.map((name) => ({
      schoolId,
      academicYearId: theClass.academicYearId,
      name,
      kind: 'TEACHING_GROUP' as const,
      gradeLevel: theClass.gradeLevel,
      halfOfId: classId,
    })),
  });
  // In the order the names were given, which RETURNING does not promise:
  // a caller pairing the first half with the first subject reads it so.
  return names.map((name) => created.find((half) => half.name === name)!);
}

export interface GroupMember {
  id: string;
  firstName: string;
  lastName: string;
  homeGroupId: string | null;
}

/** One teaching-group membership: ids only. */
export interface GroupMembership {
  studentId: string;
  studentGroupId: string;
}

@Injectable()
export class StudentGroupsService {
  /**
   * NotificationsService is optional for the scripts and specs that build
   * this one by hand; without it an årskurs tells no mentor of the leave
   * requests it gives them (Nest always injects it).
   */
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  async create(
    dto: CreateStudentGroupDto,
    user: AuthenticatedUser,
  ): Promise<StudentGroup> {
    const schoolId = requireSchoolId(user);
    try {
      return await this.prisma.withRls(user, async (tx) => {
        await assertMayReplace(tx, { kind: dto.kind ?? 'CLASS', halfOfId: null }, dto.replacesSubjectId);
        return tx.studentGroup.create({
          data: {
            schoolId,
            academicYearId: dto.academicYearId,
            name: dto.name,
            kind: dto.kind ?? 'CLASS',
            gradeLevel: dto.gradeLevel ?? null,
            // Named only when set, so the write of a group that replaces
            // nothing is the write it always was.
            ...(dto.replacesSubjectId ? { replacesSubjectId: dto.replacesSubjectId } : {}),
          },
        });
      });
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      rethrowPrismaError(error);
    }
  }

  /**
   * A class that has class history (StudentEnrollments, timplan P4) keeps its
   * läsår: its pupils' segments are dated inside that year, and the history's
   * key to the class is ON UPDATE NO ACTION rather than carrying them into
   * another one. Asked first, so the 409 names the year; the key refuses a
   * race the same way (rethrowPrismaError). A class created in the wrong year
   * a minute ago has no history yet — a same-day placement leaves none once
   * the pupils are moved out — so it can still be moved.
   *
   * A class's årskurs is its pupils' årskurs in their class history, and a
   * lov spanning årskurser closes their days by it (app.leave_school_days).
   * A new årskurs may so bring a pending leave request within the
   * delegation (Mentorns ledighetsbeslut), and the update then tells the
   * mentors it gives a request, once each, in its own transaction.
   */
  async update(
    id: string,
    dto: UpdateStudentGroupDto,
    user: AuthenticatedUser,
  ): Promise<StudentGroup> {
    try {
      return await this.prisma.withRls(user, async (tx) => {
        if (dto.academicYearId !== undefined) {
          const current = await tx.studentGroup.findUnique({
            where: { id },
            select: { academicYearId: true, academicYear: { select: { name: true } } },
          });
          if (current && current.academicYearId !== dto.academicYearId) {
            const history = await tx.studentEnrollment.count({ where: { studentGroupId: id } });
            if (history > 0) throw studentGroupHasEnrolmentHistory(current.academicYear.name);
          }
        }
        if (dto.replacesSubjectId) {
          const current = await tx.studentGroup.findUnique({ where: { id }, select: { kind: true, halfOfId: true } });
          if (current) await assertMayReplace(tx, { kind: dto.kind ?? current.kind, halfOfId: current.halfOfId }, dto.replacesSubjectId);
        }
        const group = await tx.studentGroup.update({
          where: { id },
          data: {
            ...(dto.academicYearId !== undefined
              ? { academicYearId: dto.academicYearId }
              : {}),
            ...(dto.name !== undefined ? { name: dto.name } : {}),
            ...(dto.kind !== undefined ? { kind: dto.kind } : {}),
            ...(dto.gradeLevel !== undefined ? { gradeLevel: dto.gradeLevel } : {}),
            ...(dto.replacesSubjectId !== undefined ? { replacesSubjectId: dto.replacesSubjectId } : {}),
          },
        });
        // A half is cut from its class (Halvklasser) and reads its class's
        // årskurs: frames, rasts, timplan and behörighet ask the half's own.
        if (dto.gradeLevel !== undefined && group.kind === 'CLASS') {
          await tx.studentGroup.updateMany({ where: { halfOfId: id }, data: { gradeLevel: dto.gradeLevel } });
        }
        if (this.notifications && dto.gradeLevel !== undefined) {
          await tellNewMentors(this.notifications, tx, group.schoolId);
        }
        return group;
      });
    } catch (error) {
      if (error instanceof ConflictException || error instanceof BadRequestException) throw error;
      rethrowPrismaError(error);
    }
  }

  async remove(id: string, user: AuthenticatedUser): Promise<void> {
    try {
      await this.prisma.withRls(user, (tx) =>
        tx.studentGroup.delete({ where: { id } }),
      );
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  /**
   * Massåtgärder: an årskurs or an "Ersätter ämne" for many groups at once,
   * all or nothing (src/common/bulk.ts), under update()'s rules for the
   * fields it takes: a subject is replaced only by a teaching group that is
   * not a half (the same refusal, row by row) and only by one of the
   * school's subjects (asked once), and a class's new årskurs is its halves'
   * and may give a mentor a leave request (told once, after every row).
   *
   * Not the name (one per year), the kind (a class's pupils are its home
   * pupils, a teaching group's its members) or the läsår (where a group's
   * timplan, lessons and class history live; moving years is the rollover's).
   *
   * A row whose fields already hold the values is judged but not written:
   * an UPDATE moves updatedAt, which the SS12000 sync reads as a local edit
   * (LOCAL_EDIT_SINCE_LAST_SYNC), and twenty classes already in åk 7 were
   * not edited by being in the selection.
   */
  async bulkUpdate(dto: BulkUpdateStudentGroupsDto, user: AuthenticatedUser): Promise<BulkResult> {
    assertSomeChange(dto.changes);
    const ids = uniqueIds(dto.ids);
    const { gradeLevel, replacesSubjectId } = dto.changes;
    const dryRun = dto.dryRun === true;
    const data = {
      ...(gradeLevel !== undefined ? { gradeLevel } : {}),
      ...(replacesSubjectId !== undefined ? { replacesSubjectId } : {}),
    };
    try {
      return await runBulk(
        (fn) => this.prisma.withRls(user, fn, { timeoutMs: BULK_TIMEOUT_MS }),
        dryRun,
        async (tx) => {
          // The rows FOR NO KEY UPDATE in id order, as the pupils' are read:
          // a kind or a half judged below is the one written, and two calls
          // over the same groups queue. NO KEY: rows written to the groups
          // meanwhile (their keys' KEY SHARE) do not wait on it.
          await tx.$queryRaw`
            SELECT 1 FROM "StudentGroups" WHERE "id" = ANY(${ids}::uuid[]) ORDER BY "id" FOR NO KEY UPDATE`;
          const found = await tx.studentGroup.findMany({
            where: { id: { in: ids } },
            select: { id: true, kind: true, halfOfId: true, gradeLevel: true, replacesSubjectId: true },
          });
          const byId = new Map(found.map((group) => [group.id, group]));
          const refused: BulkRefusal[] = [];
          const judged: typeof found = [];
          for (const id of ids) {
            const group = byId.get(id);
            const why = group && replacesSubjectId ? replaceRefusal(group) : null;
            const refusal = !group ? notFound(id) : why ? refusalOf(id, why) : null;
            if (refusal) refused.push(refusal);
            else if (group) judged.push(group);
          }
          if (replacesSubjectId && judged.length > 0) await assertSubjectIsTheSchools(tx, replacesSubjectId);
          const moving = judged.filter(
            (group) =>
              (gradeLevel !== undefined && group.gradeLevel !== gradeLevel) ||
              (replacesSubjectId !== undefined && group.replacesSubjectId !== replacesSubjectId),
          );
          const classes = new Set(judged.filter((group) => group.kind === 'CLASS').map((group) => group.id));
          refused.push(
            ...(await writeAll(
              tx,
              moving.map((group) => group.id),
              (rows) => tx.studentGroup.updateMany({ where: { id: { in: rows } }, data }),
              (id) => tx.studentGroup.update({ where: { id }, data }),
            )),
          );
          // update() carries the årskurs to a class's halves whenever it is
          // sent, also when the class already had it: a half left behind is
          // brought along. Every class judged, then, not only those moving,
          // and only the halves that do not already hold it.
          if (gradeLevel !== undefined && classes.size > 0 && refused.length === 0) {
            await tx.studentGroup.updateMany({
              where: {
                halfOfId: { in: [...classes] },
                ...(gradeLevel === null
                  ? { gradeLevel: { not: null } }
                  : { OR: [{ gradeLevel: null }, { gradeLevel: { not: gradeLevel } }] }),
              },
              data: { gradeLevel },
            });
          }
          if (this.notifications && gradeLevel !== undefined && moving.length > 0 && !dryRun && refused.length === 0) {
            await tellNewMentors(this.notifications, tx, requireSchoolId(user));
          }
          const refusedIds = new Set(refused.map((refusal) => refusal.id));
          return { done: judged.map((group) => group.id).filter((id) => !refusedIds.has(id)), refused };
        },
      );
    } catch (error) {
      if (error instanceof HttpException) throw error;
      rethrowPrismaError(error);
    }
  }

  /**
   * Massåtgärder: many groups deleted at once, all or nothing
   * (src/common/bulk.ts), as remove() deletes one: the database takes what
   * hangs on each and empties what only names it, every key told in
   * GROUP_KEYS (src/common/removal-inventory.ts). A dry run counts them
   * (GroupRemovalConsequences), so the confirmation can say them.
   *
   * THE CONFIRMATION BINDS THE COUNTS. The real call carries the dry run's
   * counts back (`expected`) and counts again in its own transaction, after
   * the rows are locked: a kind that grew meanwhile (a lesson written, a
   * pupil placed) refuses the call with the new counts (`consequencesGrew`),
   * nothing deleted, so the dialog can show them and ask again.
   *
   * THE ROWS ARE LOCKED FOR UPDATE, in id order, the named groups and the
   * halves a named class takes along: a row written to them meanwhile takes
   * its key's KEY SHARE and waits for the delete, so what was counted is what
   * goes. Halves go first when tried one by one: a class takes its halves
   * with it, and its half tried after it would not be found.
   */
  async bulkRemove(
    dto: BulkDeleteDto,
    user: AuthenticatedUser,
  ): Promise<BulkResult<GroupRemovalConsequences>> {
    const ids = uniqueIds(dto.ids);
    const dryRun = dto.dryRun === true;
    try {
      return await runBulk(
        (fn) => this.prisma.withRls(user, fn, { timeoutMs: BULK_TIMEOUT_MS }),
        dryRun,
        async (tx) => {
          await tx.$queryRaw`
            SELECT 1 FROM "StudentGroups"
             WHERE "id" = ANY(${ids}::uuid[]) OR "halfOfId" = ANY(${ids}::uuid[])
             ORDER BY "id" FOR UPDATE`;
          const found = await tx.studentGroup.findMany({
            where: { id: { in: ids } },
            select: { id: true, halfOfId: true, ss12000Id: true },
          });
          const present = new Set(found.map((group) => group.id));
          const refused = ids.filter((id) => !present.has(id)).map(notFound);
          const counts = dryRun || dto.expected ? await groupRemovalConsequences(tx, found) : undefined;
          const consequencesGrew = dryRun || !counts ? [] : grownSince(dto.expected, { ...counts });
          if (consequencesGrew.length > 0) {
            return { done: found.map((group) => group.id), refused, consequences: counts, consequencesGrew };
          }
          const order = [
            ...found.filter((group) => group.halfOfId !== null),
            ...found.filter((group) => group.halfOfId === null),
          ].map((group) => group.id);
          refused.push(
            ...(await writeAll(
              tx,
              order,
              (rows) => tx.studentGroup.deleteMany({ where: { id: { in: rows } } }),
              (id) => tx.studentGroup.delete({ where: { id } }),
            )),
          );
          const refusedIds = new Set(refused.map((refusal) => refusal.id));
          return {
            done: ids.filter((id) => !refusedIds.has(id)),
            refused,
            consequences: dryRun ? counts : undefined,
          };
        },
      );
    } catch (error) {
      if (error instanceof HttpException) throw error;
      rethrowPrismaError(error);
    }
  }

  /**
   * Teaching-group members (the M2M list — home-class members not included).
   * A ROSTER read in the läslogg, naming the members listed.
   */
  async listMembers(
    groupId: string,
    user: AuthenticatedUser,
  ): Promise<GroupMember[]> {
    const rows = await this.prisma.withRls(user, async (tx) => {
      const members = await tx.studentGroupMember.findMany({
        where: { studentGroupId: groupId },
        select: {
          student: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              studentGroupId: true,
            },
          },
        },
        orderBy: { student: { lastName: 'asc' } },
      });
      await recordRead(tx, 'ROSTER', members.map((row) => row.student.id), user.channel);
      return members;
    });
    return rows.map((row) => ({
      id: row.student.id,
      firstName: row.student.firstName,
      lastName: row.student.lastName,
      homeGroupId: row.student.studentGroupId,
    }));
  }

  /**
   * Every teaching-group membership of the school, ids only: the planning
   * pages' grid of who is in which group (the web's useGroupMemberships, read
   * from PostgREST until Läslogg). A ROSTER read naming every pupil listed.
   * Unpaged: one row per pupil per group is a few thousand rows for a large
   * school, which the web paged through 1 000 at a time before.
   */
  async memberships(user: AuthenticatedUser): Promise<GroupMembership[]> {
    requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const rows = await tx.studentGroupMember.findMany({
        select: { studentId: true, studentGroupId: true },
        orderBy: [{ studentGroupId: 'asc' }, { studentId: 'asc' }],
      });
      await recordRead(tx, 'ROSTER', rows.map((row) => row.studentId), user.channel);
      return rows;
    });
  }

  /**
   * "Dela klassen" (Halvklasser): two halves of a class, made as teaching
   * groups that name it (StudentGroup.halfOfId), in its year and årskurs.
   * Named "7A:1" and "7A:2" unless the school gives names.
   *
   * The class is held FOR NO KEY UPDATE first: two splits of one class at the
   * same moment would make four halves, and the second waits here and then
   * finds the halves the first made (409 CLASS_ALREADY_SPLIT). NO KEY, so the
   * halves' own foreign key (KEY SHARE on the class) never waits on it. The
   * names are asked of the year case-insensitively, as the importers and the
   * rollover read a name, and a name taken is a 409 naming it.
   */
  async split(classId: string, dto: SplitClassDto, user: AuthenticatedUser): Promise<StudentGroup[]> {
    const schoolId = requireSchoolId(user);
    try {
      return await this.prisma.withRls(user, async (tx) => {
        await lockClassForSplit(tx, classId);
        return splitLockedClass(tx, schoolId, classId, dto.names);
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      rethrowPrismaError(error);
    }
  }

  /**
   * Which pupil of a class is in which of its halves: every half named, each
   * with its complete list, replacing the class's placement in one
   * transaction — so moving a pupil from 7A:1 to 7A:2 never meets the one-half
   * index halfway. A pupil in no list is unplaced, which is allowed: the
   * generator plans a half for the pupils it may still get (class-halves.ts).
   *
   * What is replaced is the placement of the pupils it judges, the class's
   * active pupils (pupilsOfTheClass), and nobody else's: the halves of a past
   * läsår keep their pupils, who are now in next year's class, as that year's
   * history (the Users trigger keeps them too), and an inactive pupil keeps
   * the half they were in. A list sent from a screen that never saw them
   * cannot take them out.
   *
   * Refused, before anything is written: a half not of this class, a half
   * left out, a pupil in two lists, and a pupil not of the class (see
   * pupilsOfTheClass). Answers counts only, so it is no read of anyone in the
   * läslogg's sense.
   *
   * The class is held FOR NO KEY UPDATE first, as split holds it: two
   * placements of one class saved at the same moment would each delete what
   * it saw and both insert, leaving a placement neither sent. The second
   * waits, and then replaces the first's.
   */
  async placeHalves(
    classId: string,
    dto: PlaceHalvesDto,
    user: AuthenticatedUser,
  ): Promise<{ placed: number; unplaced: number }> {
    const schoolId = requireSchoolId(user);
    try {
      return await this.prisma.withRls(user, async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "StudentGroups" WHERE "id" = ${classId}::uuid FOR NO KEY UPDATE`;
        const theClass = await tx.studentGroup.findUnique({
          where: { id: classId },
          select: { id: true, name: true, predecessorId: true, halves: { select: { id: true } } },
        });
        if (!theClass) throw new NotFoundException('Student group not found.');
        const halves = new Set(theClass.halves.map((half) => half.id));
        const named = dto.halves.map((half) => half.groupId);
        if (
          halves.size === 0 ||
          named.length !== halves.size ||
          new Set(named).size !== named.length ||
          named.some((id) => !halves.has(id))
        ) {
          throw new BadRequestException({
            message: `halves: alla ${theClass.name}s halvor, var och en en gång.`,
            code: NOT_THE_CLASS_HALVES,
          });
        }
        const placing = dto.halves.flatMap((half) => half.studentIds);
        if (new Set(placing).size !== placing.length) {
          throw new BadRequestException({
            message: 'En elev kan bara placeras i en av klassens halvor.',
            code: PUPIL_IN_TWO_HALVES,
          });
        }
        const pupils = await pupilsOfTheClass(tx, theClass);
        const strangers = placing.filter((id) => !pupils.has(id));
        if (strangers.length > 0) throw pupilsNotInClass(strangers.length, theClass.name);

        await holdPupils(tx, pupils);
        await tx.studentGroupMember.deleteMany({
          where: { studentGroupId: { in: named }, studentId: { in: [...pupils] } },
        });
        const rows = dto.halves.flatMap((half) =>
          half.studentIds.map((studentId) => ({ schoolId, studentGroupId: half.groupId, studentId })),
        );
        if (rows.length > 0) await tx.studentGroupMember.createMany({ data: rows });
        return { placed: placing.length, unplaced: pupils.size - placing.length };
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      rethrowPrismaError(error);
    }
  }

  /**
   * Replace the group's teaching membership with exactly `studentIds`.
   *
   * Validated against the tenant inside the SAME RLS transaction that writes:
   * every id must be an ACTIVE STUDENT the caller can see. Ids that fail that
   * test are rejected as a 400 naming the offenders rather than silently
   * dropped — a silently shrunken save is how a student falls out of a
   * teaching group without anyone noticing until the schedule clashes.
   */
  async setMembers(
    groupId: string,
    dto: SetGroupMembersDto,
    user: AuthenticatedUser,
  ): Promise<{ count: number }> {
    const schoolId = requireSchoolId(user);
    const unique = [...new Set(dto.studentIds)];
    try {
      return await this.prisma.withRls(user, async (tx) => {
        const group = await tx.studentGroup.findUnique({
          where: { id: groupId },
          select: { id: true, halfOf: { select: { id: true, name: true, predecessorId: true } } },
        });
        if (!group) {
          throw new NotFoundException('Student group not found.');
        }
        // A half takes pupils of its class only (Halvklasser); a pupil
        // already in the class's other half meets the one-half index (409).
        // And it replaces only those pupils' rows, as placeHalves does.
        const classPupils = group.halfOf ? await pupilsOfTheClass(tx, group.halfOf) : null;
        if (group.halfOf && classPupils) {
          const strangers = unique.filter((id) => !classPupils.has(id));
          if (strangers.length > 0) throw pupilsNotInClass(strangers.length, group.halfOf.name);
        }

        if (unique.length > 0) {
          const students = await tx.user.findMany({
            where: { id: { in: unique }, role: 'STUDENT', isActive: true },
            select: { id: true },
          });
          const valid = new Set(students.map((s) => s.id));
          const invalid = unique.filter((id) => !valid.has(id));
          if (invalid.length > 0) {
            throw new BadRequestException(
              `Not active students in this school: ${invalid.join(', ')}`,
            );
          }
        }

        if (classPupils) await holdPupils(tx, classPupils);
        await tx.studentGroupMember.deleteMany({
          where: classPupils ? { studentGroupId: groupId, studentId: { in: [...classPupils] } } : { studentGroupId: groupId },
        });
        if (unique.length > 0) {
          await tx.studentGroupMember.createMany({
            data: unique.map((studentId) => ({
              schoolId,
              studentGroupId: groupId,
              studentId,
            })),
          });
        }
        return { count: unique.length };
      });
    } catch (error) {
      rethrowPrismaError(error);
    }
  }
}
