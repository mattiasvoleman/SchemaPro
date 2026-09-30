import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PrismaClient, TeacherWorkRule } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { Role } from '../auth/enums/role.enum';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId, requireUserId } from '../common/utils/request-context';
import { rethrowPrismaError } from '../common/utils/prisma-errors';
import { parseTimeString, toWallClock } from '../common/utils/time';
import { SLOT_MINUTES, minutesOf } from '../common/solver-grid';
import type { UpsertTeacherWorkRuleDto } from './dto/teacher-work-rule.dto';

/**
 * A teacher's arbetstid as the client sees it: clock strings, not 1970
 * timestamps.
 *
 * Prisma hands a `@db.Time` column back as a `Date` anchored at 1970-01-01, and
 * `JSON.stringify` turns that into "1970-01-01T10:30:00.000Z" — a timestamp
 * where the form wants a clock, which is the bug that drew the lunch card's time
 * inputs empty on every load. Null stays null: an absent window is the rule not
 * applying, and "00:00" would be a window.
 */
export interface TeacherWorkRuleResponse {
  id: string;
  /** The teacher the rule is about. Not PII — an opaque `Users.id`. */
  userId: string;
  lunchMinutes: number | null;
  /** HH:MM, or null when this teacher has no lunch rule. */
  lunchStartTime: string | null;
  /** HH:MM, or null when this teacher has no lunch rule. */
  lunchEndTime: string | null;
  minDailyRestMinutes: number | null;
}

/**
 * Lärarnas arbetstid: one row per teacher, upserted by the teacher named in the
 * path.
 *
 * TWO WRITERS, not one. An administrator manages any teacher's row, which is how
 * a school fills the table in at all; a teacher may see and change their OWN,
 * which is the point of having per-teacher rules rather than one school-wide
 * setting — the person who knows they cannot eat before 12:15 is the person
 * teaching until then.
 *
 * The ownership check below duplicates what `teacher_work_rules_teacher_own`
 * already enforces in the database, deliberately. RLS answers a write it refuses
 * by matching no row, which Prisma reports as "record not found" — so a teacher
 * editing a colleague would be told the colleague does not exist. The check here
 * is what turns that into a sentence about what they tried to do. RLS stays the
 * thing that actually holds: it binds PostgREST and psql too, and a route whose
 * only guard is this method is one refactor from having none.
 */
@Injectable()
export class TeacherWorkRulesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The school's rules. Ordered by `userId` rather than by `createdAt`: the list
   * is read beside a roster, and the order the rows happened to be typed in
   * means nothing to anybody but the person who typed them.
   *
   * No role filter and no tenant filter. RLS confines the read to the caller's
   * school, and it is also what decides how much of it they see — a teacher and
   * an admin both read the whole school's rules here, because a refusal that
   * names a rule row is unreadable to somebody who cannot open it.
   */
  async list(user: AuthenticatedUser): Promise<TeacherWorkRuleResponse[]> {
    requireSchoolId(user);
    const rows = await this.prisma.withRls(user, (tx) =>
      tx.teacherWorkRule.findMany({ orderBy: { userId: 'asc' } }),
    );
    return rows.map(toResponse);
  }

  /**
   * Write (or rewrite) one teacher's rule.
   *
   * An upsert rather than create/update, because there is exactly one row per
   * teacher and the caller already knows which teacher: a POST that could be the
   * second row for one person is a 409 nobody can act on, and a PATCH needs an id
   * the form has no reason to hold.
   *
   * THE WHOLE ROW IS REPLACED, every time. Not a per-field merge: the trio is
   * all-or-nothing, so a PATCH that mentions only `lunchEndTime` would have to
   * decide whether it is narrowing a window or writing half a rule, and the
   * merge that answers that is where FrameTimes needed a locking read. A PUT of
   * the whole arbetstid has no such question — what is absent from the payload is
   * a rule that does not apply, which is the same sentence the column means.
   */
  async upsert(
    userId: string,
    dto: UpsertTeacherWorkRuleDto,
    user: AuthenticatedUser,
  ): Promise<TeacherWorkRuleResponse> {
    const schoolId = requireSchoolId(user);
    this.assertMayWrite(userId, user);
    assertLunchIsWhole(dto);
    assertLunchFits(dto);

    const data = {
      lunchMinutes: dto.lunchMinutes ?? null,
      lunchStartTime: dto.lunchStartTime ? parseTimeString(dto.lunchStartTime) : null,
      lunchEndTime: dto.lunchEndTime ? parseTimeString(dto.lunchEndTime) : null,
      minDailyRestMinutes: dto.minDailyRestMinutes ?? null,
    };

    try {
      const row = await this.prisma.withRls(user, async (tx) => {
        await assertIsStaff(tx, userId);
        return tx.teacherWorkRule.upsert({
          where: { userId },
          create: { schoolId, userId, ...data },
          update: data,
        });
      });
      return toResponse(row);
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  /**
   * Drop a teacher's rule, which is how a school says "this no longer applies".
   *
   * Keyed on the teacher, like the upsert. Deleting the row and writing one with
   * every field null are the same fact, and the empty row is the worse of the two
   * to leave behind: it reads as a rule somebody wrote and then emptied, and the
   * payload would carry it to the engine as an assumption about nothing.
   */
  async remove(userId: string, user: AuthenticatedUser): Promise<void> {
    requireSchoolId(user);
    this.assertMayWrite(userId, user);
    try {
      await this.prisma.withRls(user, (tx) =>
        tx.teacherWorkRule.delete({ where: { userId } }),
      );
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  /**
   * An admin writes anybody's rule; anybody else writes only their own.
   *
   * `requireUserId` rather than `user.userId` directly: a principal with no
   * `Users` row resolves to undefined, and `undefined !== userId` would have
   * refused with "you may only change your own", which is true and unhelpful.
   * The refusal names the thing that is missing instead.
   */
  private assertMayWrite(userId: string, user: AuthenticatedUser): void {
    if (user.role === Role.SCHOOL_ADMIN) return;
    if (requireUserId(user) !== userId) {
      throw new ForbiddenException(
        'En lärare kan bara ändra sin egen arbetstid. Be en administratör ändra en kollegas.',
      );
    }
  }
}

function toResponse(row: TeacherWorkRule): TeacherWorkRuleResponse {
  return {
    id: row.id,
    userId: row.userId,
    lunchMinutes: row.lunchMinutes,
    lunchStartTime: row.lunchStartTime ? toWallClock(row.lunchStartTime) : null,
    lunchEndTime: row.lunchEndTime ? toWallClock(row.lunchEndTime) : null,
    minDailyRestMinutes: row.minDailyRestMinutes,
  };
}

/**
 * All three lunch fields, or none of them.
 *
 * Half a rule cannot be read: 30 minutes with no window is a lunch the solver
 * may place at 07:00, and a window with no length is a window nothing has to
 * happen in. The database refuses it too — this is the copy that can say WHICH
 * field is missing, where the CHECK can only name itself.
 */
function assertLunchIsWhole(dto: UpsertTeacherWorkRuleDto): void {
  const present = [dto.lunchMinutes, dto.lunchStartTime, dto.lunchEndTime].filter(
    (value) => value !== undefined && value !== null,
  ).length;
  if (present !== 0 && present !== 3) {
    throw new BadRequestException(
      'Ange lunchens längd och hela fönstret, eller inget av dem — en halv lunchregel går inte att tolka.',
    );
  }
}

/**
 * The window has to hold the break, and be a window at all.
 *
 * Compared as MINUTES, not as strings, for the reason FrameTimes gives: the
 * regex admits both HH:MM and HH:MM:SS, and a lexical compare across the two
 * lengths reads "12:00" as before "12:00:30" — a thirty-second window, accepted.
 * Minutes are also the precision the solver schedules in.
 */
function assertLunchFits(dto: UpsertTeacherWorkRuleDto): void {
  const { lunchMinutes, lunchStartTime, lunchEndTime } = dto;
  if (
    lunchMinutes === undefined ||
    lunchMinutes === null ||
    !lunchStartTime ||
    !lunchEndTime
  ) {
    return;
  }

  const width = minutesOf(lunchEndTime) - minutesOf(lunchStartTime);
  if (width <= 0) {
    throw new BadRequestException(
      'Lunchfönstret måste sluta efter att det börjat.',
    );
  }
  if (width < lunchMinutes) {
    throw new BadRequestException(
      `Lunchfönstret är ${width} minuter långt och rymmer inte en lunch på ${lunchMinutes} minuter.`,
    );
  }
  // The window's own edges have to sit on the grid as well. Not because the
  // database says so — it does not — but because a window from 10:32 gives the
  // solver a domain whose first legal start is 10:35, and a school that wrote
  // exactly `lunchMinutes` of room would then have none. See solver-grid.ts.
  for (const [label, value] of [
    ['Fönstrets starttid', lunchStartTime],
    ['Fönstrets sluttid', lunchEndTime],
  ] as const) {
    if (minutesOf(value) % SLOT_MINUTES !== 0) {
      throw new BadRequestException(
        `${label} måste ligga på ett helt ${SLOT_MINUTES}-minutersintervall, till exempel 10:30 eller 10:35.`,
      );
    }
  }
}

/**
 * Whose arbetstid may exist at all.
 *
 * A rule about a pupil or a guardian is meaningless — they teach nothing, so
 * there is no last lesson for a rest to follow and no day for a lunch to sit in —
 * and the database cannot say so: `role` lives on `Users`, and a CHECK cannot
 * read another table. So it is asked here, inside the transaction that writes.
 *
 * STAFF, not TEACHER. A teaching rektor carries role SCHOOL_ADMIN in this
 * schema, and `TeachingRequirements.teacherId` will happily name them, so
 * refusing an admin their own lunch rule would refuse it to the one person most
 * likely to be scheduled without one. The two roles that are certainly wrong are
 * the two that are refused.
 *
 * A teacher of another school reads as missing under RLS, which is the same 404
 * a nonexistent id gets — and the composite (userId, schoolId) foreign key is
 * what makes that guarantee rather than this read.
 */
async function assertIsStaff(tx: PrismaClient, userId: string): Promise<void> {
  const target = await tx.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });
  if (!target) {
    throw new NotFoundException(`Teacher ${userId} not found.`);
  }
  if (target.role !== 'TEACHER' && target.role !== 'SCHOOL_ADMIN') {
    throw new BadRequestException(
      'En arbetstid hör till en lärare. Elever och vårdnadshavare undervisar inte.',
    );
  }
}
