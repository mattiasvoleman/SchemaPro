import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId, requireUserId } from '../common/utils/request-context';
import { parseDateString, parseTimeString, toWallClock, todayInZone } from '../common/utils/time';
import { rethrowPrismaError } from '../common/utils/prisma-errors';
import { markedIds } from '../users/person-protections';
import { loanBookingRefusal, toLoanRows } from '../room-bookings/loan-holds';
import type { CreateExternalBookingDto, ExternalBookingRuleDto, UpdateExternalBookingDto } from './dto/external-booking.dto';
import { clashRows, toClashResponse } from './external-clashes';
import {
  isBlocked,
  resourceDayConflicts,
  roomDayConflicts,
  type DayToCheck,
  type HeldSpan,
  type ResourceFacts,
  type RoomFacts,
  type SchoolFacts,
} from './external-conflicts';
import { expandRule, isoWeekdayOf, type SeriesRule } from './external-rule';
import type {
  ExternalBookingDetail,
  ExternalBookingResult,
  ExternalBookingSummary,
  ExternalClashResponse,
  ExternalConflict,
  ExternalDayResponse,
  ExternalOccurrencePreview,
  ExternalPreviewResponse,
} from './local-types';
import { isQuantityExhausted } from './resource-bookings.service';
import { minutesOfClock, wholeSchoolHolidays, type FrameLike } from './school-time';

/** The title of every day of a series, in the room's calendar: the hirer is not named there. */
export const EXTERNAL_DAY_TITLE = 'Extern bokning';

/** The conflict a refused registration answers with. */
export const EXTERNAL_BOOKING_CONFLICTS = 'EXTERNAL_BOOKING_CONFLICTS';

/** The room's constraint (20260822131500), by name, for the race the preview could not see. */
const ROOM_HELD_ONCE = 'RoomBookings_room_is_held_once';

const DAY_MS = 86_400_000;

type Tx = PrismaClient;

interface Target {
  kind: 'ROOM' | 'RESOURCE';
  id: string;
  name: string;
  years: { min: number | null; max: number | null };
  quantity: number;
}

/** A plan: the days of a rule against the school as it stands, each with what stands in its way. */
interface Plan {
  target: Target;
  wanted: number;
  rule: SeriesRule;
  timeZone: string;
  days: Array<{ date: string; startsAt: Date; endsAt: Date; conflicts: ExternalConflict[] }>;
  framesMissing: boolean;
}

const SERIES_SELECT = {
  id: true,
  roomId: true,
  resourceId: true,
  resourceQuantity: true,
  organisation: true,
  contactName: true,
  contactPhone: true,
  contactEmail: true,
  purpose: true,
  note: true,
  weekdays: true,
  intervalWeeks: true,
  startDate: true,
  endDate: true,
  startTime: true,
  endTime: true,
  skippedDates: true,
  cancelledAt: true,
  registeredById: true,
  createdAt: true,
  room: { select: { name: true } },
  resource: { select: { name: true } },
} as const;

type SeriesRow = Prisma.ExternalBookingGetPayload<{ select: typeof SERIES_SELECT }>;

const day = (value: Date): string => value.toISOString().slice(0, 10);

/**
 * External bookers (Lokal): an association hires the sports hall every Tuesday 18-20
 * for a term. Staff register it, since the hirer has no login: the organisation, a
 * contact person, a telephone number and an address, and a rule. Registering is a
 * plan (the days of the rule, each against the lessons, the bookings, the ramtid, the
 * closures and the loans) and then the days, written as ordinary bookings that carry
 * the series' id (the preamble of migration 20270204091000 says why).
 *
 * A day that is refused refuses the series, unless the expedition says to skip it;
 * then the days that are free are booked and the others are named in the answer and
 * kept on the series. A day that a lesson takes later is not refused by anything (the
 * lessons are written by publication, which asks no booking) and is found by
 * external-clashes.ts instead.
 */
@Injectable()
export class ExternalBookingsService {
  private readonly logger = new Logger(ExternalBookingsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------------
  // Planning
  // ---------------------------------------------------------------------

  async preview(dto: ExternalBookingRuleDto, user: AuthenticatedUser): Promise<ExternalPreviewResponse> {
    requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const plan = await this.plan(tx, dto);
      const occurrences: ExternalOccurrencePreview[] = plan.days.map((planned) => ({
        date: planned.date,
        startsAt: planned.startsAt.toISOString(),
        endsAt: planned.endsAt.toISOString(),
        conflicts: planned.conflicts,
      }));
      const blocked = plan.days.filter((planned) => isBlocked(planned.conflicts)).length;
      const warned = plan.days.filter((planned) => planned.conflicts.length > 0 && !isBlocked(planned.conflicts)).length;
      return { occurrences, count: plan.days.length, blocked, warned, framesMissing: plan.framesMissing };
    });
  }

  private async plan(tx: Tx, dto: ExternalBookingRuleDto): Promise<Plan> {
    const rule: SeriesRule = {
      weekdays: [...dto.weekdays].sort((a, b) => a - b),
      intervalWeeks: dto.intervalWeeks ?? 1,
      startDate: dto.startDate,
      endDate: dto.endDate,
      startTime: dto.startTime,
      endTime: dto.endTime,
    };
    if (dto.endDate < dto.startDate) throw new BadRequestException('endDate must not be before startDate.');
    if (Date.parse(`${dto.endDate}T00:00:00Z`) - Date.parse(`${dto.startDate}T00:00:00Z`) > 400 * DAY_MS) {
      throw new BadRequestException('A series is at most 400 days.');
    }
    if (dto.endTime <= dto.startTime) throw new BadRequestException('endTime must be after startTime.');

    const school = await tx.school.findFirst({ select: { timezone: true } });
    const timeZone = school?.timezone ?? 'Europe/Stockholm';
    const today = todayInZone(timeZone).toISOString().slice(0, 10);
    if (dto.startDate < today) throw new BadRequestException('A series cannot start in the past.');

    const target = await this.targetOf(tx, dto);
    const wanted = dto.target === 'RESOURCE' ? (dto.resourceQuantity ?? 1) : 1;
    if (dto.target === 'RESOURCE' && wanted > target.quantity) {
      throw new BadRequestException(`Det finns bara ${target.quantity} av resursen.`);
    }
    const days = expandRule(rule, timeZone);
    if (days.length === 0) throw new BadRequestException('Regeln ger inga dagar.');

    const from = days[0].startsAt;
    const to = days[days.length - 1].endsAt;
    const framesRows = await tx.frameTime.findMany({
      select: { minGradeLevel: true, maxGradeLevel: true, dayOfWeek: true, startTime: true, endTime: true },
    });
    const frames: FrameLike[] = framesRows.map((frame) => ({
      minGradeLevel: frame.minGradeLevel,
      maxGradeLevel: frame.maxGradeLevel,
      dayOfWeek: frame.dayOfWeek,
      start: minutesOfClock(toWallClock(frame.startTime)),
      end: minutesOfClock(toWallClock(frame.endTime)),
    }));
    const breaks = await tx.schoolBreak.findMany({
      where: { startDate: { lte: parseDateString(dto.endDate) }, endDate: { gte: parseDateString(dto.startDate) } },
      select: { kind: true, startDate: true, endDate: true, minGradeLevel: true, maxGradeLevel: true },
    });
    const schoolFacts: SchoolFacts = {
      frames,
      holidays: wholeSchoolHolidays(
        breaks.map((entry) => ({ ...entry, startDate: day(entry.startDate), endDate: day(entry.endDate) })),
        dto.startDate,
        dto.endDate,
      ),
      years: target.years,
    };

    const check = target.kind === 'ROOM' ? await this.roomChecker(tx, target, from, to, timeZone, dto) : await this.resourceChecker(tx, target, from, to, wanted);
    const startMinute = minutesOfClock(dto.startTime);
    const endMinute = minutesOfClock(dto.endTime);
    return {
      target,
      wanted,
      rule,
      timeZone,
      framesMissing: frames.length === 0,
      days: days.map((planned) => {
        const toCheck: DayToCheck = {
          date: planned.date,
          weekday: isoWeekdayOf(planned.date),
          startsAt: planned.startsAt,
          endsAt: planned.endsAt,
          startMinute,
          endMinute,
        };
        return { ...planned, conflicts: check(toCheck, schoolFacts) };
      }),
    };
  }

  private async targetOf(tx: Tx, dto: ExternalBookingRuleDto): Promise<Target> {
    if (dto.target === 'ROOM') {
      if (!dto.roomId || dto.resourceId) throw new BadRequestException('A room series names a room and no resource.');
      const room = await tx.room.findUnique({ where: { id: dto.roomId }, select: { id: true, name: true, minGradeLevel: true, maxGradeLevel: true } });
      if (!room) throw new BadRequestException('Room not found.');
      return { kind: 'ROOM', id: room.id, name: room.name, years: { min: room.minGradeLevel, max: room.maxGradeLevel }, quantity: 1 };
    }
    if (!dto.resourceId || dto.roomId) throw new BadRequestException('A resource series names a resource and no room.');
    const resource = await tx.resource.findUnique({ where: { id: dto.resourceId }, select: { id: true, name: true, quantity: true } });
    if (!resource) throw new BadRequestException('Resource not found.');
    return { kind: 'RESOURCE', id: resource.id, name: resource.name, years: { min: null, max: null }, quantity: resource.quantity };
  }

  /** What holds a room over the series' whole span, read once; each day is then judged in memory. */
  private async roomChecker(
    tx: Tx,
    target: Target,
    from: Date,
    to: Date,
    timeZone: string,
    dto: ExternalBookingRuleDto,
  ): Promise<(day: DayToCheck, school: SchoolFacts) => ExternalConflict[]> {
    const overlap = { startsAt: { lt: to }, endsAt: { gt: from } };
    const lessons = await tx.calendarLesson.findMany({
      where: { roomId: target.id, status: { in: ['SCHEDULED', 'COMPLETED'] }, ...overlap },
      select: { startsAt: true, endsAt: true, subject: { select: { name: true } }, studentGroup: { select: { name: true } } },
    });
    const bookings = await tx.roomBooking.findMany({
      where: { roomId: target.id, status: { in: ['PENDING', 'APPROVED'] }, ...overlap },
      select: { startsAt: true, endsAt: true, title: true },
    });
    const closures = await tx.availabilityConstraint.findMany({
      where: {
        resourceType: 'ROOM',
        roomId: target.id,
        type: 'UNAVAILABLE',
        OR: [{ date: null }, { date: { gte: parseDateString(dto.startDate), lte: parseDateString(dto.endDate) } }],
      },
      select: { date: true, dayOfWeek: true, startTime: true, endTime: true, reason: true },
    });
    const activityLessons = await tx.calendarLesson.findMany({
      where: { status: 'SCHEDULED', activityLinks: { some: { activity: { removedAt: null } } }, ...overlap },
      select: { startsAt: true, endsAt: true, activityLinks: { select: { activity: { select: { batch: { select: { name: true } } } } }, take: 1 } },
    });
    const loans = await tx.roomLoan.findMany({
      where: { OR: [{ roomId: target.id }, { localRoomId: target.id }] },
      select: { status: true, roomId: true, localRoomId: true, dayOfWeek: true, startTime: true, endTime: true, startDate: true, endDate: true },
    });
    const loanRows = toLoanRows(loans);

    const held = (rows: Array<{ startsAt: Date; endsAt: Date }>, label: (row: never) => string): HeldSpan[] =>
      rows.map((row) => ({ start: row.startsAt.getTime(), end: row.endsAt.getTime(), label: label(row as never) }));
    const facts: RoomFacts = {
      lessons: held(lessons, (row: (typeof lessons)[number]) => `${row.subject.name} ${row.studentGroup.name}`.trim()),
      bookings: held(bookings, (row: (typeof bookings)[number]) => row.title),
      closures: closures.map((closure) => ({
        date: closure.date ? day(closure.date) : null,
        dayOfWeek: closure.dayOfWeek,
        start: minutesOfClock(toWallClock(closure.startTime)),
        end: minutesOfClock(toWallClock(closure.endTime)),
        reason: closure.reason ?? '',
      })),
      activities: held(activityLessons, (row: (typeof activityLessons)[number]) => row.activityLinks[0]?.activity.batch.name ?? ''),
      ...(loanRows.length > 0 ? { loan: (startsAt: Date, endsAt: Date) => loanBookingRefusal(loanRows, target.id, startsAt, endsAt, timeZone) } : {}),
    };
    return (toCheck, school) => roomDayConflicts(toCheck, facts, school);
  }

  private async resourceChecker(
    tx: Tx,
    target: Target,
    from: Date,
    to: Date,
    wanted: number,
  ): Promise<(day: DayToCheck, school: SchoolFacts) => ExternalConflict[]> {
    const bookings = await tx.resourceBooking.findMany({
      where: { resourceId: target.id, status: { in: ['PENDING', 'APPROVED'] }, startsAt: { lt: to }, endsAt: { gt: from } },
      select: { startsAt: true, endsAt: true, quantity: true },
    });
    const facts: ResourceFacts = {
      quantity: target.quantity,
      wanted,
      bookings: bookings.map((booking) => ({ start: booking.startsAt.getTime(), end: booking.endsAt.getTime(), quantity: booking.quantity })),
    };
    return (toCheck, school) => resourceDayConflicts(toCheck, facts, school);
  }

  // ---------------------------------------------------------------------
  // Registering
  // ---------------------------------------------------------------------

  async create(dto: CreateExternalBookingDto, user: AuthenticatedUser): Promise<ExternalBookingResult> {
    const schoolId = requireSchoolId(user);
    const registrar = requireUserId(user);
    const phone = blankAsNone(dto.contactPhone);
    const email = blankAsNone(dto.contactEmail);
    if (phone === null && email === null) {
      throw new BadRequestException('Ange telefonnummer eller e-postadress till kontaktpersonen.');
    }
    try {
      return await this.prisma.withRls(user, async (tx) => {
        const plan = await this.plan(tx, dto);
        const blocked = plan.days.filter((planned) => isBlocked(planned.conflicts));
        if (blocked.length > 0 && dto.skipConflicts !== true) {
          throw conflictsException(blocked.map((planned) => ({ date: planned.date, conflicts: planned.conflicts })), 'Några dagar går inte att boka.');
        }
        const free = plan.days.filter((planned) => !isBlocked(planned.conflicts));
        if (free.length === 0) {
          throw conflictsException(blocked.map((planned) => ({ date: planned.date, conflicts: planned.conflicts })), 'Ingen dag går att boka.');
        }

        const series = await tx.externalBooking.create({
          data: {
            schoolId,
            ...(plan.target.kind === 'ROOM' ? { roomId: plan.target.id } : { resourceId: plan.target.id, resourceQuantity: plan.wanted }),
            organisation: dto.organisation.trim(),
            contactName: dto.contactName.trim(),
            contactPhone: phone,
            contactEmail: email,
            purpose: blankAsNone(dto.purpose),
            note: blankAsNone(dto.note),
            weekdays: plan.rule.weekdays as number[],
            intervalWeeks: plan.rule.intervalWeeks,
            startDate: parseDateString(plan.rule.startDate),
            endDate: parseDateString(plan.rule.endDate),
            startTime: parseTimeString(plan.rule.startTime),
            endTime: parseTimeString(plan.rule.endTime),
            skippedDates: blocked.map((planned) => parseDateString(planned.date)),
            registeredById: registrar,
          },
          select: { id: true },
        });

        const rows = free.map((planned) => ({
          schoolId,
          bookedById: registrar,
          title: EXTERNAL_DAY_TITLE,
          startsAt: planned.startsAt,
          endsAt: planned.endsAt,
          status: 'APPROVED' as const,
          externalBookingId: series.id,
        }));
        if (plan.target.kind === 'ROOM') {
          await tx.roomBooking.createMany({ data: rows.map((row) => ({ ...row, roomId: plan.target.id })) });
        } else {
          await tx.resourceBooking.createMany({ data: rows.map((row) => ({ ...row, resourceId: plan.target.id, quantity: plan.wanted })) });
        }

        // The days are written, so what reads the room now is a room nobody else can claim until we
        // commit (the plan was read before the writes): a lesson that landed in between is found here.
        const late = await clashRows(tx, [series.id], 5);
        if (late.length > 0) {
          throw conflictsException(
            late.map((row) => ({ date: toClashResponse(row, plan.timeZone).date, conflicts: [{ kind: 'LESSON' as const, severity: 'BLOCK' as const, label: row.lesson }] })),
            'En lektion lades in medan bokningen registrerades.',
          );
        }

        this.logger.log(`External booking registered [series=${series.id}, days=${free.length}, skipped=${blocked.length}]`);
        return {
          id: series.id,
          created: free.length,
          skipped: blocked.map((planned) => ({ date: planned.date, conflicts: planned.conflicts })),
        };
      });
    } catch (error) {
      if (isRoomHeld(error) || isQuantityExhausted(error)) {
        throw conflictsException([], 'Något annat bokade samma tid medan serien registrerades. Förhandsgranska igen.');
      }
      if (error instanceof BadRequestException || error instanceof ConflictException) throw error;
      rethrowPrismaError(error);
    }
  }

  // ---------------------------------------------------------------------
  // Reading
  // ---------------------------------------------------------------------

  async list(state: 'active' | 'ended' | 'cancelled' | 'all', user: AuthenticatedUser): Promise<ExternalBookingSummary[]> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const today = parseDateString((await this.today(tx)).slice(0, 10));
      const where: Prisma.ExternalBookingWhereInput =
        state === 'active'
          ? { cancelledAt: null, endDate: { gte: today } }
          : state === 'ended'
            ? { cancelledAt: null, endDate: { lt: today } }
            : state === 'cancelled'
              ? { cancelledAt: { not: null } }
              : {};
      const rows = await tx.externalBooking.findMany({
        where,
        orderBy: [{ startDate: 'desc' }, { id: 'asc' }],
        take: 500,
        select: SERIES_SELECT,
      });
      return this.summaries(tx, schoolId, rows);
    });
  }

  async detail(id: string, user: AuthenticatedUser): Promise<ExternalBookingDetail> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const row = await tx.externalBooking.findUnique({ where: { id }, select: SERIES_SELECT });
      if (!row) throw new NotFoundException('External booking not found.');
      const [summary] = await this.summaries(tx, schoolId, [row]);
      const timeZone = (await tx.school.findFirst({ select: { timezone: true } }))?.timezone ?? 'Europe/Stockholm';
      const days = row.roomId
        ? await tx.roomBooking.findMany({ where: { externalBookingId: id }, orderBy: { startsAt: 'asc' }, select: { id: true, startsAt: true, endsAt: true, status: true } })
        : await tx.resourceBooking.findMany({ where: { externalBookingId: id }, orderBy: { startsAt: 'asc' }, select: { id: true, startsAt: true, endsAt: true, status: true } });
      const clashes = await clashRows(tx, [id]);
      const byDay = new Map<string, ExternalConflict[]>();
      for (const clash of clashes) {
        const list = byDay.get(clash.dayId) ?? [];
        list.push({ kind: 'LESSON', severity: 'BLOCK', label: clash.lesson });
        byDay.set(clash.dayId, list);
      }
      const occurrences: ExternalDayResponse[] = days.map((entry) => ({
        id: entry.id,
        date: toClashResponse({ seriesId: id, dayId: entry.id, organisation: '', targetName: '', startsAt: entry.startsAt, endsAt: entry.endsAt, lesson: '' }, timeZone).date,
        startsAt: entry.startsAt.toISOString(),
        endsAt: entry.endsAt.toISOString(),
        status: entry.status,
        conflicts: byDay.get(entry.id) ?? [],
      }));
      return { ...summary, occurrences };
    });
  }

  /** The days of the school that stand in a room with a lesson: the expedition's flag. */
  async clashes(user: AuthenticatedUser): Promise<ExternalClashResponse[]> {
    requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const timeZone = (await tx.school.findFirst({ select: { timezone: true } }))?.timezone ?? 'Europe/Stockholm';
      return (await clashRows(tx, null)).map((row) => toClashResponse(row, timeZone));
    });
  }

  private async today(tx: Tx): Promise<string> {
    const timeZone = (await tx.school.findFirst({ select: { timezone: true } }))?.timezone ?? 'Europe/Stockholm';
    return todayInZone(timeZone).toISOString();
  }

  private async summaries(tx: Tx, schoolId: string, rows: SeriesRow[]): Promise<ExternalBookingSummary[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const counts = await tx.$queryRaw<Array<{ id: string; total: number; upcoming: number; cancelled: number }>>`
      SELECT "externalBookingId" AS "id",
             count(*)::int AS "total",
             (count(*) FILTER (WHERE "status" IN ('PENDING', 'APPROVED') AND "endsAt" > now()))::int AS "upcoming",
             (count(*) FILTER (WHERE "status" = 'CANCELLED'))::int AS "cancelled"
        FROM (
          SELECT "externalBookingId", "status", "endsAt" FROM "RoomBookings" WHERE "externalBookingId" = ANY(${ids}::uuid[])
          UNION ALL
          SELECT "externalBookingId", "status", "endsAt" FROM "ResourceBookings" WHERE "externalBookingId" = ANY(${ids}::uuid[])
        ) d
       GROUP BY "externalBookingId"`;
    const countOf = new Map(counts.map((count) => [count.id, count]));
    const clashes = await clashRows(tx, ids, 5000);
    const clashesOf = new Map<string, Set<string>>();
    for (const clash of clashes) {
      const set = clashesOf.get(clash.seriesId) ?? new Set<string>();
      set.add(clash.dayId);
      clashesOf.set(clash.seriesId, set);
    }
    const people = await this.registrars(tx, schoolId, rows);
    return rows.map((row) => {
      const count = countOf.get(row.id);
      return {
        id: row.id,
        target: row.roomId
          ? { kind: 'ROOM' as const, id: row.roomId, name: row.room?.name ?? '' }
          : { kind: 'RESOURCE' as const, id: row.resourceId as string, name: row.resource?.name ?? '' },
        resourceQuantity: row.resourceQuantity,
        organisation: row.organisation,
        contactName: row.contactName,
        contactPhone: row.contactPhone,
        contactEmail: row.contactEmail,
        purpose: row.purpose,
        note: row.note,
        weekdays: [...row.weekdays],
        intervalWeeks: row.intervalWeeks,
        startDate: day(row.startDate),
        endDate: day(row.endDate),
        startTime: toWallClock(row.startTime),
        endTime: toWallClock(row.endTime),
        cancelledAt: row.cancelledAt ? row.cancelledAt.toISOString() : null,
        createdAt: row.createdAt.toISOString(),
        registeredByName: row.registeredById ? (people.get(row.registeredById) ?? null) : null,
        days: {
          total: count?.total ?? 0,
          upcoming: count?.upcoming ?? 0,
          cancelled: count?.cancelled ?? 0,
          skipped: row.skippedDates.map(day),
        },
        clashes: clashesOf.get(row.id)?.size ?? 0,
      };
    });
  }

  /** Who registered, by name; a person with a protected identity is named by nobody. */
  private async registrars(tx: Tx, schoolId: string, rows: SeriesRow[]): Promise<Map<string, string>> {
    const ids = [...new Set(rows.map((row) => row.registeredById).filter((id): id is string => id !== null))];
    const names = new Map<string, string>();
    if (ids.length === 0) return names;
    const marked = await markedIds(tx, schoolId);
    const people = await tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, firstName: true, lastName: true } });
    for (const person of people) if (!marked.has(person.id)) names.set(person.id, `${person.firstName} ${person.lastName}`);
    return names;
  }

  // ---------------------------------------------------------------------
  // Changing and cancelling
  // ---------------------------------------------------------------------

  async update(id: string, dto: UpdateExternalBookingDto, user: AuthenticatedUser): Promise<ExternalBookingSummary> {
    const schoolId = requireSchoolId(user);
    try {
      return await this.prisma.withRls(user, async (tx) => {
        const current = await tx.externalBooking.findUnique({ where: { id }, select: { contactPhone: true, contactEmail: true } });
        if (!current) throw new NotFoundException('External booking not found.');
        const phone = dto.contactPhone !== undefined ? blankAsNone(dto.contactPhone) : current.contactPhone;
        const email = dto.contactEmail !== undefined ? blankAsNone(dto.contactEmail) : current.contactEmail;
        if (phone === null && email === null) {
          throw new BadRequestException('Ange telefonnummer eller e-postadress till kontaktpersonen.');
        }
        const row = await tx.externalBooking.update({
          where: { id },
          data: {
            ...(dto.organisation !== undefined ? { organisation: dto.organisation.trim() } : {}),
            ...(dto.contactName !== undefined ? { contactName: dto.contactName.trim() } : {}),
            ...(dto.contactPhone !== undefined ? { contactPhone: phone } : {}),
            ...(dto.contactEmail !== undefined ? { contactEmail: email } : {}),
            ...(dto.purpose !== undefined ? { purpose: blankAsNone(dto.purpose) } : {}),
            ...(dto.note !== undefined ? { note: blankAsNone(dto.note) } : {}),
          },
          select: SERIES_SELECT,
        });
        return (await this.summaries(tx, schoolId, [row]))[0];
      });
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof NotFoundException) throw error;
      rethrowPrismaError(error);
    }
  }

  /** The series is cancelled, and so are its days that have not started. Days that have been held stay. */
  async cancel(id: string, user: AuthenticatedUser): Promise<ExternalBookingSummary> {
    const schoolId = requireSchoolId(user);
    try {
      return await this.prisma.withRls(user, async (tx) => {
        const current = await tx.externalBooking.findUnique({ where: { id }, select: { cancelledAt: true } });
        if (!current) throw new NotFoundException('External booking not found.');
        if (current.cancelledAt) throw new BadRequestException('Serien är redan avbokad.');
        const now = new Date();
        const row = await tx.externalBooking.update({ where: { id }, data: { cancelledAt: now }, select: SERIES_SELECT });
        const open = { externalBookingId: id, status: { in: ['PENDING', 'APPROVED'] as Array<'PENDING' | 'APPROVED'> }, startsAt: { gt: now } };
        const cancelled = (await tx.roomBooking.updateMany({ where: open, data: { status: 'CANCELLED' } })).count +
          (await tx.resourceBooking.updateMany({ where: open, data: { status: 'CANCELLED' } })).count;
        this.logger.log(`External booking cancelled [series=${id}, days=${cancelled}]`);
        return (await this.summaries(tx, schoolId, [row]))[0];
      });
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof NotFoundException) throw error;
      rethrowPrismaError(error);
    }
  }

  /**
   * Removes a series that is over or cancelled, with its days. A running one is cancelled first: it
   * would free the room without anyone having said so (the table's policy refuses it as well).
   */
  async remove(id: string, user: AuthenticatedUser): Promise<void> {
    requireSchoolId(user);
    try {
      await this.prisma.withRls(user, async (tx) => {
        const series = await tx.externalBooking.findUnique({ where: { id }, select: { cancelledAt: true, endDate: true } });
        if (!series) throw new NotFoundException('External booking not found.');
        const today = (await this.today(tx)).slice(0, 10);
        if (series.cancelledAt === null && day(series.endDate) >= today) {
          throw new ConflictException({
            message: 'Serien pågår. Avboka den först.',
            code: 'EXTERNAL_BOOKING_IS_RUNNING',
          });
        }
        await tx.externalBooking.delete({ where: { id } });
        this.logger.log(`External booking removed [series=${id}]`);
      });
    } catch (error) {
      if (error instanceof ConflictException || error instanceof NotFoundException) throw error;
      rethrowPrismaError(error);
    }
  }

  async cancelDay(id: string, dayId: string, user: AuthenticatedUser): Promise<ExternalDayResponse> {
    requireSchoolId(user);
    try {
      return await this.prisma.withRls(user, async (tx) => {
        const timeZone = (await tx.school.findFirst({ select: { timezone: true } }))?.timezone ?? 'Europe/Stockholm';
        const series = await tx.externalBooking.findUnique({ where: { id }, select: { roomId: true } });
        if (!series) throw new NotFoundException('External booking not found.');
        const model = series.roomId ? tx.roomBooking : tx.resourceBooking;
        const entry = await (model as typeof tx.roomBooking).findFirst({
          where: { id: dayId, externalBookingId: id },
          select: { id: true, startsAt: true, endsAt: true, status: true },
        });
        if (!entry) throw new NotFoundException('Day not found.');
        if (entry.status === 'CANCELLED') throw new BadRequestException('Dagen är redan avbokad.');
        await (model as typeof tx.roomBooking).update({ where: { id: dayId }, data: { status: 'CANCELLED' } });
        return {
          id: entry.id,
          date: toClashResponse({ seriesId: id, dayId, organisation: '', targetName: '', startsAt: entry.startsAt, endsAt: entry.endsAt, lesson: '' }, timeZone).date,
          startsAt: entry.startsAt.toISOString(),
          endsAt: entry.endsAt.toISOString(),
          status: 'CANCELLED' as const,
          conflicts: [],
        };
      });
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof NotFoundException) throw error;
      rethrowPrismaError(error);
    }
  }
}

function conflictsException(conflicts: Array<{ date: string; conflicts: ExternalConflict[] }>, message: string): ConflictException {
  return new ConflictException({ message, code: EXTERNAL_BOOKING_CONFLICTS, conflicts });
}

function isRoomHeld(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2039' && error.message.includes(ROOM_HELD_ONCE);
}

function blankAsNone(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
