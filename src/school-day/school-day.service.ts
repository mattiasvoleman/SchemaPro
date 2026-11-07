import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import { recordRead } from '../access-log/access-log';
import { Role } from '../auth/enums/role.enum';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { breakCoversGroup, breakDaysOf, isoWeekday, iterateDates } from '../calendar/publish-days';
import { requireSchoolId } from '../common/utils/request-context';
import { zonedTimeToUtc } from '../common/utils/time';
import { loanBookingRefusal, type LoanRow } from '../room-bookings/loan-holds';
import { coverOn, minutesOfClock, type CoverLoan } from '../sharing/loan-coverage';
import { asDay, dayBounds, dayDate, liftWindow, readPersonDays, schoolTimezone } from '../cover/cover-context';
import type { Span } from '../cover/cover-rules';
import { PrismaService } from '../database/prisma.service';
import type { FreeQueryDto, GridQueryDto, SchoolDaySettingsDto } from './dto/school-day.dto';
import { ROOM_RULES, TEACHER_RULES, clipToDay, roomFindings, teacherFreedom, wallClockMinutes, type RoomDay } from './school-day-rules';
import type {
  BlockKind,
  BreakView,
  BusyRoom,
  BusyTeacher,
  FreeRoom,
  FreeTeacher,
  FreeView,
  GridBlock,
  GridDay,
  GridGroup,
  GridLesson,
  GridRoom,
  GridSubject,
  GridTeacher,
  SchoolDayAccess,
  SchoolDaySettingsView,
  SchoolDayView,
  TeacherView,
} from './school-day.types';

/** The longest range one answer covers: a week with its weekend. */
export const MAX_DAYS = 7;

/** Swedish collation, numeric: "7A" before "7B", "Sal 2" before "Sal 10". */
const byName = (a: string, b: string): number => a.localeCompare(b, 'sv', { numeric: true, sensitivity: 'base' });

/**
 * SKOLANS DAG I ETT SVEP: the whole school's day or week as rows and time, and
 * the search for free teachers and rooms over an interval.
 *
 * WHAT A LESSON IS ON A DAY is not decided here. The lessons are the
 * CalendarLessons of the date, as /admin/lessons reads them, with the teachers
 * they hold (a vikarie has taken the absent teacher's row; Vikarietavlan and D4
 * wrote that), the status that cancels them (an avbokning, a schemabrytande
 * aktivitet, a closure) and the replacement lessons an aktivitet wrote, which
 * are lessons like the rest. A lesson that does not hold its time
 * (cover-rules.ts holdsTime: CANCELLED, RESCHEDULED) is drawn, and frees its
 * teacher and its room. A lov is the publication's own function
 * (publish-days.ts breakDaysOf and breakCoversGroup). Who is free is
 * cover-rules.ts' occupancyFindings, the rules of the Vikarietavla that say
 * occupied (school-day-rules.ts says which apply and which do not).
 *
 * WHAT EACH ROLE READS. An administrator, of any profile (the läsare and the
 * huvudman's reader too: nothing here writes), has everything: the grids, the
 * free teachers and, for a busy teacher, which rule says so. A teacher has what
 * the school lets them (SchoolDaySettings.teacherView, NONE until the school
 * decides): ROOMS gives the free rooms and the rooms' own days, ALL the
 * classes' and teachers' lessons as well, never who is free (absence, uppdrag
 * and rastvakt are not theirs to read, so a list of free colleagues made from
 * what they can read would call an absent one free). A pupil and a guardian
 * have no route.
 *
 * WHO IS NOT NAMED. A person the school has marked as having a protected
 * identity is named for administrators only: for a teacher with ALL the person
 * is left out of the teachers, and out of the lessons' teacher rows, with no id
 * and without a count (the answer has no field that says someone is left out:
 * "one teacher is not shown" on the lessons that are hers would point at her,
 * which the omission is there to not do). The screen is the whole staff's at once,
 * which a lesson row a teacher can read one at a time is not. The omission is
 * presentation: PostgREST still lets a teacher read the rows (people-files.ts).
 * src/common/people-files.ts and web/lib/people-files.ts say the same of the
 * print, which is an administrator's and counts the marked there.
 *
 * WHAT A LESSON SAYS TO A TEACHER. The lesson as it stands, cancelled ones and
 * who holds it too, but not why or in whose place: cancelCause and a teacher's
 * role are the administrators' (TEACHER_UNAVAILABLE says a colleague is away,
 * SUBSTITUTE whose lesson it was), and absence is not a teacher's to read.
 *
 * READ LOG. The timetable layer is not recorded (access-log.ts): staff read
 * it directly. What the answer adds is who is away: a teacher named as absent
 * (the block, or the reason) is recorded as STAFF_ABSENCES, as the cover board
 * does.
 */
@Injectable()
export class SchoolDayService {
  constructor(private readonly prisma: PrismaService) {}

  async settings(user: AuthenticatedUser): Promise<SchoolDaySettingsView> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, (tx) => this.readSettings(tx, schoolId));
  }

  /** Saves the school's decision; one row per school, made by the first save. */
  async updateSettings(dto: SchoolDaySettingsDto, user: AuthenticatedUser): Promise<SchoolDaySettingsView> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      await tx.schoolDaySettings.upsert({
        where: { schoolId },
        create: { schoolId, teacherView: dto.teacherView },
        update: { teacherView: dto.teacherView },
      });
      return this.readSettings(tx, schoolId);
    });
  }

  /** The day or the week: lessons, blocks and the rows, by the range [from, to]. */
  async grid(query: GridQueryDto, user: AuthenticatedUser): Promise<SchoolDayView> {
    const schoolId = requireSchoolId(user);
    const from = query.from;
    const to = query.to ?? query.from;
    const dates = datesOf(from, to);
    return this.prisma.withRls(user, async (tx) => {
      const access = this.accessOf(user, (await this.readSettings(tx, schoolId)).teacherView);
      const timezone = await schoolTimezone(tx, schoolId);
      const clock = wallClockMinutes(timezone);
      const rangeStart = dayBounds(from, timezone).start;
      const rangeEnd = dayBounds(to, timezone).end;

      const [groups, roomRows, subjectRows, teacherRows] = await Promise.all([
        this.groupsOn(tx, from, to),
        tx.room.findMany({ select: { id: true, name: true, code: true } }),
        tx.subject.findMany({ select: { id: true, name: true } }),
        access.grids ? tx.user.findMany({ where: { role: 'TEACHER' }, select: { id: true, firstName: true, lastName: true, isActive: true } }) : Promise.resolve([]),
      ]);
      const held = access.admin ? new Set<string>() : await this.protectedStaff(tx, access);

      const lessonRows = await tx.calendarLesson.findMany({
        where: { date: { gte: dayDate(from), lte: dayDate(to) }, ...(access.grids ? {} : { roomId: { not: null } }) },
        select: {
          id: true,
          date: true,
          startsAt: true,
          endsAt: true,
          status: true,
          cancelCause: true,
          subjectId: true,
          studentGroupId: true,
          roomId: true,
          teachers: access.grids ? { select: { teacherId: true, role: true } } : false,
          extraGroups: { select: { studentGroupId: true } },
          activityLinks: { select: { activityId: true } },
        },
        orderBy: [{ date: 'asc' }, { startsAt: 'asc' }],
      });

      const lessons: GridLesson[] = lessonRows.map((row) => {
        // The select leaves the rows out for a form without teachers; the answer does too, whatever the row holds.
        const assigned = access.grids ? (row.teachers ?? []) : [];
        // A marked teacher is left out of the lesson without a trace: no id, no count, no "someone is missing".
        const named = assigned.filter((teacher) => !held.has(teacher.teacherId));
        return {
          id: row.id,
          date: asDay(row.date),
          start: clock(row.startsAt.getTime()),
          end: endMinutes(row.startsAt.getTime(), row.endsAt.getTime(), clock),
          status: row.status,
          // Why a lesson is cancelled and who stands in are administrators': TEACHER_UNAVAILABLE says a colleague is away, a SUBSTITUTE
          // row says whose lesson it was. A teacher reads that the lesson is cancelled and who holds it, not the cause or the role.
          cancelCause: access.admin ? (row.cancelCause ?? null) : null,
          subjectId: row.subjectId,
          groupId: row.studentGroupId,
          extraGroupIds: row.extraGroups.map((extra) => extra.studentGroupId),
          roomId: row.roomId ?? null,
          teachers: named.map((teacher) => ({ id: teacher.teacherId, role: access.admin ? teacher.role : null })),
          activity: row.activityLinks.length > 0,
        };
      });

      const days = await this.daysOf(tx, dates, async () => groups);
      const blocks: GridBlock[] = [];
      this.bookingBlocks(await this.bookingRows(tx, rangeStart, rangeEnd), dates, timezone, clock, access, held, blocks);
      await this.closureBlocks(tx, dates, timezone, clock, blocks);
      this.loanBlocks(await this.loanRows(tx), new Set(roomRows.map((room) => room.id)), dates, blocks);

      const absent = new Set<string>();
      let poolMembers = new Set<string>();
      if (access.admin) {
        const active = teacherRows.filter((teacher) => teacher.isActive);
        const years = await tx.academicYear.findMany({
          where: { startDate: { lte: dayDate(to) }, endDate: { gte: dayDate(from) } },
          select: { id: true, startDate: true, endDate: true, isActive: true },
        });
        for (const date of dates) {
          const read = await readPersonDays(tx, {
            date,
            timezone,
            academicYearId: yearOn(years, date),
            known: active.map((teacher) => ({ id: teacher.id, role: 'TEACHER', isActive: true })),
            occupancyOnly: true,
            skipLessons: true,
          });
          poolMembers = new Set([...poolMembers, ...read.poolMembers]);
          const day = { start: dayBounds(date, timezone).start.getTime(), end: dayBounds(date, timezone).end.getTime() };
          for (const person of read.days.values()) {
            const push = (kind: BlockKind, span: Span, label: string | null) => {
              const clipped = clipToDay(span, day, clock);
              if (clipped) blocks.push({ resource: 'TEACHER', resourceId: person.userId, date, ...clipped, kind, label });
              if (clipped && kind === 'ABSENT') absent.add(person.userId);
            };
            for (const closure of person.closures) push(closure.kind === 'DUTY' ? 'DUTY' : 'UNAVAILABLE', closure.span, closure.kind === 'DUTY' ? closure.label : null);
            for (const pass of person.supervision ?? []) push('PASS', { start: pass.start, end: pass.end }, null);
            for (const span of person.absences) push('ABSENT', span, null);
          }
        }
        // Who is away is STAFF_ABSENCES, as on the cover board.
        await recordRead(tx, 'STAFF_ABSENCES', absent, user.channel);
      }

      const active = (teacherRows as Array<{ id: string; firstName: string; lastName: string; isActive: boolean }>).filter((teacher) => !held.has(teacher.id));
      const usedTeachers = new Set<string>([...lessons.flatMap((lesson) => lesson.teachers.map((teacher) => teacher.id)), ...blocks.filter((block) => block.resource === 'TEACHER').map((block) => block.resourceId)]);
      const teachers: GridTeacher[] = active
        // A deactivated teacher stays for the lessons they still hold; a pool member without a lesson or a block is not a row.
        .filter((teacher) => (teacher.isActive && !poolMembers.has(teacher.id)) || usedTeachers.has(teacher.id))
        .map((teacher) => ({ id: teacher.id, name: `${teacher.firstName} ${teacher.lastName}` }))
        .sort((a, b) => byName(a.name, b.name));
      const rooms: GridRoom[] = roomRows.map((room) => ({ id: room.id, name: room.name, code: room.code ?? null })).sort((a, b) => byName(a.name, b.name));
      const usedSubjects = new Set(lessons.map((lesson) => lesson.subjectId));
      const subjects: GridSubject[] = subjectRows.filter((subject) => usedSubjects.has(subject.id)).map((subject) => ({ id: subject.id, name: subject.name }));

      return {
        from,
        to,
        timezone,
        access,
        days,
        groups,
        teachers,
        rooms,
        subjects,
        lessons,
        blocks,
      } satisfies SchoolDayView;
    });
  }

  /** Who and what is free over [from, to) on a date. */
  async free(query: FreeQueryDto, user: AuthenticatedUser): Promise<FreeView> {
    const schoolId = requireSchoolId(user);
    const { date } = query;
    if (query.from >= query.to) throw new BadRequestException('from: före to.');
    return this.prisma.withRls(user, async (tx) => {
      const access = this.accessOf(user, (await this.readSettings(tx, schoolId)).teacherView);
      const timezone = await schoolTimezone(tx, schoolId);
      const span: Span = {
        start: zonedTimeToUtc(date, query.from, timezone).getTime(),
        end: zonedTimeToUtc(date, query.to, timezone).getTime(),
      };
      const bounds = dayBounds(date, timezone);
      const [day] = await this.daysOf(tx, [date], () => this.groupsOn(tx, date, date));
      const breaks = day?.breaks ?? [];
      const rules = { teachers: access.freeTeachers ? [...TEACHER_RULES] : [], rooms: [...ROOM_RULES] };
      const roomRows = await tx.room.findMany({ select: { id: true, name: true, code: true } });
      const base = { date, from: query.from, to: query.to, access, breaks, rules };

      // A lov that closes the whole school leaves nobody free: nobody is in the house.
      if (breaks.some((entry) => entry.kind === 'HOLIDAY' && entry.groupIds === null)) {
        return { ...base, teachers: access.freeTeachers ? [] : null, rooms: [], busyTeachers: access.admin ? [] : null, busyRooms: access.admin ? [] : null, poolLeftOut: 0 };
      }

      const rooms = await this.roomDays(tx, date, span, bounds, timezone, roomRows.map((room) => room.id));
      // The loans between this school and another: the booking page's rule, asked of each room the loans name.
      const loans = await this.loanRows(tx);
      for (const room of roomRows) {
        const named = loans.filter((loan) => loan.roomId === room.id || loan.localRoomId === room.id);
        if (named.length > 0) rooms.get(room.id)!.loan = loanBookingRefusal(named, room.id, new Date(span.start), new Date(span.end), timezone);
      }
      const freeRooms: FreeRoom[] = [];
      const busyRooms: BusyRoom[] = [];
      for (const room of roomRows.slice().sort((a, b) => byName(a.name, b.name))) {
        const reasons = roomFindings(rooms.get(room.id)!, span);
        const view = { id: room.id, name: room.name, code: room.code ?? null };
        if (reasons.length === 0) freeRooms.push(view);
        else busyRooms.push({ ...view, reasons });
      }

      if (!access.freeTeachers) {
        return { ...base, teachers: null, rooms: freeRooms, busyTeachers: null, busyRooms: access.admin ? busyRooms : null, poolLeftOut: 0 };
      }

      const teacherRows = await tx.user.findMany({ where: { role: 'TEACHER', isActive: true }, select: { id: true, firstName: true, lastName: true } });
      const year = await tx.academicYear.findFirst({
        where: { startDate: { lte: dayDate(date) }, endDate: { gte: dayDate(date) } },
        orderBy: [{ isActive: 'desc' }, { startDate: 'desc' }],
        select: { id: true },
      });
      const read = await readPersonDays(tx, {
        date,
        timezone,
        academicYearId: year?.id ?? null,
        known: teacherRows.map((teacher) => ({ id: teacher.id, role: 'TEACHER', isActive: true })),
        occupancyOnly: true,
      });
      const freeTeachers: FreeTeacher[] = [];
      const busyTeachers: BusyTeacher[] = [];
      let poolLeftOut = 0;
      for (const teacher of teacherRows.slice().sort((a, b) => byName(`${a.firstName} ${a.lastName}`, `${b.firstName} ${b.lastName}`))) {
        const person = read.days.get(teacher.id);
        if (!person) continue;
        const { free, reasons } = teacherFreedom(person, span);
        const view = { id: teacher.id, name: `${teacher.firstName} ${teacher.lastName}` };
        if (free) freeTeachers.push(view);
        else {
          busyTeachers.push({ ...view, reasons });
          if (reasons.length === 1 && reasons[0] === 'POOL_NOT_DECLARED') poolLeftOut += 1;
        }
      }
      await recordRead(tx, 'STAFF_ABSENCES', busyTeachers.filter((teacher) => teacher.reasons.includes('ABSENT')).map((teacher) => teacher.id), user.channel);
      return { ...base, teachers: freeTeachers, rooms: freeRooms, busyTeachers, busyRooms, poolLeftOut };
    });
  }

  private async readSettings(tx: PrismaClient, schoolId: string): Promise<SchoolDaySettingsView> {
    const row = await tx.schoolDaySettings.findUnique({ where: { schoolId }, select: { teacherView: true } });
    return { teacherView: row?.teacherView ?? 'NONE' };
  }

  /** What the caller may have. A teacher whose school chose NONE has neither the grids nor the search. */
  private accessOf(user: AuthenticatedUser, view: TeacherView): SchoolDayAccess {
    if (user.role === Role.SCHOOL_ADMIN) return { admin: true, grids: true, freeTeachers: true };
    if (user.role !== Role.TEACHER || view === 'NONE') {
      throw new ForbiddenException({ code: 'SCHOOL_DAY_NOT_OPEN', message: 'Skolan har inte öppnat Skolans dag för lärare.' });
    }
    return { admin: false, grids: view === 'ALL', freeTeachers: false };
  }

  /** The marked staff of the school, for a caller who may not read the marks. Only asked when teachers are named. */
  private async protectedStaff(tx: PrismaClient, access: SchoolDayAccess): Promise<Set<string>> {
    if (!access.grids) return new Set();
    const rows = (await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT app.school_day_protected_staff() AS id`)) ?? [];
    return new Set(rows.map((row) => row.id));
  }

  /** The groups of the läsår(s) the range falls in. */
  private async groupsOn(tx: PrismaClient, from: string, to: string): Promise<GridGroup[]> {
    const rows = await tx.studentGroup.findMany({
      where: { academicYear: { startDate: { lte: dayDate(to) }, endDate: { gte: dayDate(from) } } },
      select: { id: true, name: true, kind: true, gradeLevel: true, halfOfId: true },
    });
    return rows.map((group) => ({ ...group, kind: group.kind })).sort((a, b) => byName(a.name, b.name));
  }

  /**
   * The days of the range with their lov, each told which of the groups it
   * covers. The groups are asked for only when a lov is narrowed to some
   * årskurs: a school-wide one covers them all without being told who they are.
   */
  private async daysOf(tx: PrismaClient, dates: readonly string[], groupsOf: () => Promise<readonly GridGroup[]>): Promise<GridDay[]> {
    const first = dates[0]!;
    const last = dates[dates.length - 1]!;
    const breaks = await tx.schoolBreak.findMany({
      where: { startDate: { lte: dayDate(last) }, endDate: { gte: dayDate(first) } },
      select: { name: true, kind: true, startDate: true, endDate: true, minGradeLevel: true, maxGradeLevel: true },
    });
    const byDay = breakDaysOf(breaks, first, last);
    const narrowed = breaks.some((entry) => entry.minGradeLevel !== null || entry.maxGradeLevel !== null);
    const groups = narrowed ? await groupsOf() : [];
    return dates.map((date) => ({
      date,
      weekday: isoWeekday(date),
      breaks: (byDay.get(date) ?? []).map(
        (entry): BreakView => ({
          name: entry.name,
          kind: entry.kind,
          groupIds: entry.minGradeLevel === null && entry.maxGradeLevel === null ? null : groups.filter((group) => breakCoversGroup(entry, group.gradeLevel)).map((group) => group.id),
          minGradeLevel: entry.minGradeLevel,
          maxGradeLevel: entry.maxGradeLevel,
        }),
      ),
    }));
  }

  private bookingRows(tx: PrismaClient, start: Date, end: Date) {
    return tx.roomBooking.findMany({
      where: { status: { in: ['PENDING', 'APPROVED'] }, startsAt: { lt: end }, endsAt: { gt: start } },
      select: { roomId: true, bookedById: true, title: true, startsAt: true, endsAt: true },
    });
  }

  /** A booking holds its room, and the person who made it (unless the school marks them). Cut at midnight, a day each. */
  private bookingBlocks(
    rows: Awaited<ReturnType<SchoolDayService['bookingRows']>>,
    dates: readonly string[],
    timezone: string,
    clock: (instant: number) => number,
    access: SchoolDayAccess,
    held: ReadonlySet<string>,
    out: GridBlock[],
  ): void {
    for (const date of dates) {
      const bounds = dayBounds(date, timezone);
      const day = { start: bounds.start.getTime(), end: bounds.end.getTime() };
      for (const row of rows) {
        const clipped = clipToDay({ start: row.startsAt.getTime(), end: row.endsAt.getTime() }, day, clock);
        if (!clipped) continue;
        out.push({ resource: 'ROOM', resourceId: row.roomId, date, ...clipped, kind: 'BOOKING', label: row.title });
        // A marked person is on no row, so their id is on no block either; the room still shows that it is held.
        if (access.grids && !held.has(row.bookedById)) {
          out.push({ resource: 'TEACHER', resourceId: row.bookedById, date, ...clipped, kind: 'BOOKING', label: row.title });
        }
      }
    }
  }

  /** The approved loans this school is a party to, as the booking page reads them (room-bookings.service assertLoansAllow). */
  private async loanRows(tx: PrismaClient): Promise<LoanRow[]> {
    const loans = await tx.roomLoan.findMany({
      where: { status: 'APPROVED' },
      select: { status: true, roomId: true, localRoomId: true, dayOfWeek: true, startTime: true, endTime: true, startDate: true, endDate: true },
    });
    return loans.map((loan) => ({
      status: loan.status,
      roomId: loan.roomId,
      localRoomId: loan.localRoomId,
      dayOfWeek: loan.dayOfWeek,
      startTime: loan.startTime.toISOString().slice(11, 16),
      endTime: loan.endTime.toISOString().slice(11, 16),
      startDate: loan.startDate.toISOString().slice(0, 10),
      endDate: loan.endDate.toISOString().slice(0, 10),
    }));
  }

  /**
   * What the loans do to the rooms' days. A room lent out is the other
   * school's in each approved window (LOAN, on the owner's room); the school's
   * own room for a borrowed one is the school's only inside the windows, so
   * the rest of each day is closed (CLOSED). The same rules the search asks
   * through loanBookingRefusal.
   */
  private loanBlocks(loans: readonly LoanRow[], ownRooms: ReadonlySet<string>, dates: readonly string[], out: GridBlock[]): void {
    // A loan names two rooms, the owner's and the borrower's; only this school's own are on its rows.
    const borrowed = new Set(loans.flatMap((loan) => (loan.localRoomId && ownRooms.has(loan.localRoomId) ? [loan.localRoomId] : [])));
    for (const date of dates) {
      const weekday = isoWeekday(date);
      for (const loan of loans) {
        if (!ownRooms.has(loan.roomId) || loan.dayOfWeek !== weekday || loan.startDate > date || date > loan.endDate) continue;
        out.push({ resource: 'ROOM', resourceId: loan.roomId, date, start: minutesOfClock(loan.startTime), end: minutesOfClock(loan.endTime), kind: 'LOAN', label: null });
      }
      for (const roomId of borrowed) {
        const held: CoverLoan[] = loans
          .filter((loan) => loan.localRoomId === roomId)
          .map((loan) => ({ dayOfWeek: loan.dayOfWeek, start: minutesOfClock(loan.startTime), end: minutesOfClock(loan.endTime), startDate: loan.startDate, endDate: loan.endDate }));
        let cursor = 0;
        for (const [from, to] of coverOn(held, date, weekday)) {
          if (from > cursor) out.push({ resource: 'ROOM', resourceId: roomId, date, start: cursor, end: from, kind: 'CLOSED', label: null });
          cursor = Math.max(cursor, to);
        }
        if (cursor < 1440) out.push({ resource: 'ROOM', resourceId: roomId, date, start: cursor, end: 1440, kind: 'CLOSED', label: null });
      }
    }
  }

  /** The rooms' closures of the range: a dated row, or a weekly one on its weekday. */
  private async closureBlocks(
    tx: PrismaClient,
    dates: readonly string[],
    timezone: string,
    clock: (instant: number) => number,
    out: GridBlock[],
  ): Promise<void> {
    const rows = await this.closureRows(tx, dates[0]!, dates[dates.length - 1]!);
    for (const date of dates) {
      const bounds = dayBounds(date, timezone);
      const day = { start: bounds.start.getTime(), end: bounds.end.getTime() };
      for (const row of rows) {
        if (!row.roomId || !row.startTime || !row.endTime) continue;
        if (row.date ? asDay(row.date) !== date : row.dayOfWeek !== isoWeekday(date)) continue;
        const clipped = clipToDay(liftWindow(date, row.startTime, row.endTime, timezone), day, clock);
        if (clipped) out.push({ resource: 'ROOM', resourceId: row.roomId, date, ...clipped, kind: 'CLOSED', label: null });
      }
    }
  }

  private closureRows(tx: PrismaClient, from: string, to: string) {
    return tx.availabilityConstraint.findMany({
      where: {
        resourceType: 'ROOM',
        type: 'UNAVAILABLE',
        OR: [{ date: { gte: dayDate(from), lte: dayDate(to) } }, { date: null, dayOfWeek: { not: null } }],
      },
      select: { roomId: true, date: true, dayOfWeek: true, startTime: true, endTime: true },
    });
  }

  /** Each room's day as the rules read it: the lessons that use it, the bookings and the closures, over the span's date. */
  private async roomDays(
    tx: PrismaClient,
    date: string,
    span: Span,
    bounds: { start: Date; end: Date },
    timezone: string,
    roomIds: readonly string[],
  ): Promise<Map<string, RoomDay>> {
    const days = new Map<string, RoomDay>(roomIds.map((id) => [id, { roomId: id, lessons: [], bookings: [], closures: [] }]));
    const lessons = await tx.calendarLesson.findMany({
      where: { roomId: { not: null }, startsAt: { lt: new Date(span.end) }, endsAt: { gt: new Date(span.start) } },
      select: { id: true, roomId: true, startsAt: true, endsAt: true, status: true },
    });
    for (const lesson of lessons) {
      days.get(lesson.roomId!)?.lessons.push({ id: lesson.id, start: lesson.startsAt.getTime(), end: lesson.endsAt.getTime(), status: lesson.status });
    }
    for (const booking of await this.bookingRows(tx, bounds.start, bounds.end)) {
      days.get(booking.roomId)?.bookings.push({ start: booking.startsAt.getTime(), end: booking.endsAt.getTime() });
    }
    for (const row of await this.closureRows(tx, date, date)) {
      if (!row.roomId || !row.startTime || !row.endTime) continue;
      if (row.date ? asDay(row.date) !== date : row.dayOfWeek !== isoWeekday(date)) continue;
      days.get(row.roomId)?.closures.push(liftWindow(date, row.startTime, row.endTime, timezone));
    }
    return days;
  }
}

/** The dates of [from, to], inclusive; refused when the range is backwards or longer than MAX_DAYS. */
export function datesOf(from: string, to: string): string[] {
  const dates = [...iterateDates(from, to)];
  if (dates.length === 0) throw new BadRequestException('to: samma dag som from eller senare.');
  if (dates.length > MAX_DAYS) throw new BadRequestException(`to: högst ${MAX_DAYS} dagar från from.`);
  return dates;
}

/** The läsår a date falls in: the active one when two overlap, else the later. */
function yearOn(
  years: ReadonlyArray<{ id: string; startDate: Date; endDate: Date; isActive: boolean }>,
  date: string,
): string | null {
  const holding = years.filter((year) => asDay(year.startDate) <= date && asDay(year.endDate) >= date);
  holding.sort((a, b) => Number(b.isActive) - Number(a.isActive) || asDay(b.startDate).localeCompare(asDay(a.startDate)));
  return holding[0]?.id ?? null;
}

/** The end of a lesson in minutes; one that ends at the next midnight reads 24:00 and not 00:00. */
function endMinutes(start: number, end: number, clock: (instant: number) => number): number {
  const minutes = clock(end);
  return minutes === 0 && end > start ? 1440 : minutes;
}
