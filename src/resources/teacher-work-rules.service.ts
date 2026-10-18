import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PrismaClient, TeacherWorkRule } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { Role } from '../auth/enums/role.enum';
import { profileWrites } from '../auth/admin-areas';
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
  /**
   * Lärarens dag (20261123090000): the most minutes of teaching on one day,
   * or null for no cap. Not HR: the riktmärke in minutes is every
   * administrator's, and a day's cap is a fact about the timetable.
   */
  maxTeachingMinutesPerDay: number | null;
  /** The ISO weekday the teacher would rather have free (soft), or null. */
  preferredFreeDayOfWeek: number | null;
}

/**
 * The problem `code` of a write by somebody who does not plan that would
 * change a teacher's daily cap or wished free day: the gateway's copy of the
 * refusal app.teacher_work_rules_day_is_planned gives (20261123090000).
 */
export const WORK_RULE_DAY_IS_PLANNED = 'WORK_RULE_DAY_IS_PLANNED';

/**
 * The trigger's own sentence, as a sentence: the web and a direct PostgREST
 * write are told the same thing (teacher-work-rules.service.spec.ts holds
 * the two equal).
 */
export const WORK_RULE_DAY_IS_PLANNED_MESSAGE =
  'Dagstaket och den önskade lediga dagen sätts av en administratör som planerar.';

/** Lärarens dag on the row: the two columns only an administrator who plans writes. */
const DAY_FIELDS = ['maxTeachingMinutesPerDay', 'preferredFreeDayOfWeek'] as const;

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
   *
   * BUT FOR LÄRARENS DAG (20261123090000): the daily cap and the wished free
   * day are written when sent — null clears — and kept when absent. They are
   * the administrator's, on a row the teacher writes too, so a teacher's
   * own PUT of their lunch, or a web from before them, must leave them
   * where they are.
   *
   * AND NEVER FROM A WRITER WHO DOES NOT PLAN. Every administrator who
   * reaches this write holds planering (@Area on the controller), so that is
   * the teacher writing their own row. Restating what the row holds is
   * fine — the web sends the form whole — but a body that would change
   * either is refused here with WORK_RULE_DAY_IS_PLANNED, where the trigger
   * would answer the same as AREA_NOT_YOURS. Past that check the two are
   * left out of the teacher's write altogether, create and update both, so
   * the database never sees them from a teacher: the trigger judges an
   * upsert as the update it becomes, and a write that names neither column
   * is one it has nothing to judge in.
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

    const plans = writesPlanning(user);
    const data = {
      lunchMinutes: dto.lunchMinutes ?? null,
      lunchStartTime: dto.lunchStartTime ? parseTimeString(dto.lunchStartTime) : null,
      lunchEndTime: dto.lunchEndTime ? parseTimeString(dto.lunchEndTime) : null,
      minDailyRestMinutes: dto.minDailyRestMinutes ?? null,
      ...(plans ? dayData(dto) : {}),
    };

    try {
      const row = await this.prisma.withRls(user, async (tx) => {
        await assertIsStaff(tx, userId);
        if (!plans) await assertDayIsKept(tx, userId, dto);
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
   *
   * A TEACHER'S DELETE KEEPS LÄRARENS DAG. Their own row may hold a cap or a
   * wish an administrator set (20261123090000), which the teacher may not
   * take away — the table's trigger refuses a delete of such a row from
   * them. What the teacher means by "ingen arbetstidsregel" is their lunch
   * and their rest, so that is what goes: the row is deleted where it holds
   * neither cap nor wish, and otherwise its lunch and rest are cleared and
   * the row stays. The delete names the condition rather than reading the
   * row first, so a cap an administrator sets in between is seen by the
   * delete itself (it re-reads the row it locks) and the row is kept; a row
   * that is not there at all is the update's 404, as the delete's was.
   *
   * AND SO DOES AN ADMINISTRATOR'S, UNLESS IT SAYS IT MEANS THEM
   * (`includeDay`, the query's `?includeDay=true`). The two arrived after
   * the dialog that deletes: a web from before them reads a row holding
   * only a cap as no rule, and sends this DELETE when its four fields are
   * empty — so a tab left open over the release, saving a teacher's lunch
   * away, deleted the cap or the wish a colleague had set since with the
   * new web, and nothing on either screen said so. The PUT keeps the two
   * when they are absent for the same reason (UpsertTeacherWorkRuleDto). A
   * bare DELETE is therefore the teacher's, whoever sends it; only a writer
   * who plans and asks for the two deletes the row whole, which the web of
   * this release does when its form, which holds both, is empty. A teacher
   * asking for them is not refused, only not obeyed: they never remove the
   * administrator's fields, and a 403 would turn their own "no rule" into
   * an error about two fields they did not touch.
   */
  async remove(userId: string, user: AuthenticatedUser, includeDay = false): Promise<void> {
    requireSchoolId(user);
    this.assertMayWrite(userId, user);
    try {
      await this.prisma.withRls(user, async (tx) => {
        if (includeDay && writesPlanning(user)) {
          await tx.teacherWorkRule.delete({ where: { userId } });
          return;
        }
        const deleted = await tx.teacherWorkRule.deleteMany({
          where: { userId, maxTeachingMinutesPerDay: null, preferredFreeDayOfWeek: null },
        });
        if (deleted.count > 0) return;
        await tx.teacherWorkRule.update({
          where: { userId },
          data: { lunchMinutes: null, lunchStartTime: null, lunchEndTime: null, minDailyRestMinutes: null },
        });
      });
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
    maxTeachingMinutesPerDay: row.maxTeachingMinutesPerDay,
    preferredFreeDayOfWeek: row.preferredFreeDayOfWeek,
  };
}

/**
 * Whether the writer plans: an administrator whose profile writes
 * planering, as app.current_user_may('PLANERING', true) asks it in the
 * trigger. RolesGuard has already held every administrator who reaches a
 * write here to it, so in practice this is "not the teacher"; asked of the
 * profile all the same, so the gateway's rule and the table's are one rule.
 */
function writesPlanning(user: AuthenticatedUser): boolean {
  return user.role === Role.SCHOOL_ADMIN && profileWrites(user.adminProfile, 'PLANERING');
}

/** Lärarens dag as the body states it: what is sent, null included; nothing for what is absent. */
function dayData(dto: UpsertTeacherWorkRuleDto): Partial<Record<(typeof DAY_FIELDS)[number], number | null>> {
  return Object.fromEntries(
    DAY_FIELDS.filter((field) => dto[field] !== undefined).map((field) => [field, dto[field]]),
  );
}

/**
 * A writer who does not plan may send the cap and the wish only as the row
 * holds them. Read only when the body names one, so a teacher's lunch save
 * from a web that does not send them costs no statement; a teacher with no
 * row holds neither, so a value is a change and a null is not.
 */
async function assertDayIsKept(
  tx: PrismaClient,
  userId: string,
  dto: UpsertTeacherWorkRuleDto,
): Promise<void> {
  const sent = DAY_FIELDS.filter((field) => dto[field] !== undefined);
  if (sent.length === 0) return;
  const stored = await tx.teacherWorkRule.findUnique({
    where: { userId },
    select: { maxTeachingMinutesPerDay: true, preferredFreeDayOfWeek: true },
  });
  if (sent.some((field) => dto[field] !== (stored?.[field] ?? null))) {
    throw new ForbiddenException({ message: WORK_RULE_DAY_IS_PLANNED_MESSAGE, code: WORK_RULE_DAY_IS_PLANNED });
  }
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
 *
 * WHICH IS WHY A SECOND IS REFUSED BEFORE ANY OF THAT ARITHMETIC RUNS. The DTO
 * admits HH:MM:SS on purpose — it is the shape PostgREST returns, so a row read
 * from the database round-trips through this endpoint — and `parseTimeString`
 * carries the seconds into the TIME(0) columns. `minutesOf` does not see them:
 * it splits on ':' and reads two fields. So `10:30:30` measured here is 10:30,
 * and a window of `10:30:30`-`11:00` passed as thirty minutes wide and on the
 * grid, while the table's TeacherWorkRules_lunch_window_fits_break measures the
 * same window with EXTRACT(EPOCH …) and sees 1770 seconds against the 1800 it
 * needs. A CHECK violation is none of the codes rethrowPrismaError maps, so the
 * caller met a bare 500 where every other refusal on this route is a 400 that
 * names the field — and a window that did pass the CHECK was stored thirty
 * seconds off the solver's own five-minute grid, to be read back on every run.
 * Refusing the second is the fix rather than counting it, because a schedule
 * laid in five-minute slots has nothing to do with one.
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

  for (const [label, value] of [
    ['Fönstrets starttid', lunchStartTime],
    ['Fönstrets sluttid', lunchEndTime],
  ] as const) {
    const [, , seconds = '0'] = value.split(':');
    if (Number(seconds) !== 0) {
      throw new BadRequestException(
        `${label} anges i hela minuter — schemaläggaren räknar i ${SLOT_MINUTES}-minuterssteg, och sekunder går inte att lägga på det rutnätet.`,
      );
    }
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
