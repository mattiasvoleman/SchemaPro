import { BadRequestException, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId } from '../common/utils/request-context';
import { toWallClock, zonedTimeToUtc } from '../common/utils/time';
import { addDays, datesBetween } from './external-rule';
import type { UtilisationResponse } from './local-types';
import { clockOfMinutes, minutesOfClock, wholeSchoolHolidays, type FrameLike } from './school-time';
import { utilisation, type HeldInterval, type UtilisationTarget } from './utilisation';

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_OPEN = { from: '07:00', to: '22:00' };
/** A term and a bit, as an external series: the longest a report covers. */
const MAX_DAYS = 400;

export interface UtilisationQuery {
  from: string;
  to: string;
  kind?: 'ALL' | 'ROOM' | 'RESOURCE';
  openFrom?: string;
  openTo?: string;
}

/**
 * The utilisation report (Lokal): per room and resource, the share of school time
 * and of the open hours outside it that something holds (utilisation.ts says what
 * counts). Read under the administrator's row security: every administrator
 * reads it, whatever their profile. Nothing in it names a person.
 */
@Injectable()
export class UtilisationService {
  constructor(private readonly prisma: PrismaService) {}

  async report(query: UtilisationQuery, user: AuthenticatedUser): Promise<UtilisationResponse> {
    requireSchoolId(user);
    const kind = query.kind ?? 'ALL';
    const openFrom = query.openFrom ?? DEFAULT_OPEN.from;
    const openTo = query.openTo ?? DEFAULT_OPEN.to;
    if (!DATE.test(query.from) || !DATE.test(query.to)) throw new BadRequestException('from and to must be YYYY-MM-DD.');
    if (query.to < query.from) throw new BadRequestException('to must not be before from.');
    if (datesBetween(query.from, query.to).length > MAX_DAYS) throw new BadRequestException(`A report covers at most ${MAX_DAYS} days.`);
    if (!CLOCK.test(openFrom) || !CLOCK.test(openTo) || openTo <= openFrom) {
      throw new BadRequestException('openFrom and openTo must be HH:MM with openTo after openFrom.');
    }

    return this.prisma.withRls(user, async (tx) => {
      const timeZone = (await tx.school.findFirst({ select: { timezone: true } }))?.timezone ?? 'Europe/Stockholm';
      const start = zonedTimeToUtc(query.from, '00:00', timeZone);
      const end = zonedTimeToUtc(addDays(query.to, 1), '00:00', timeZone);

      const frameRows = await tx.frameTime.findMany({
        select: { minGradeLevel: true, maxGradeLevel: true, dayOfWeek: true, startTime: true, endTime: true },
      });
      const frames: FrameLike[] = frameRows.map((frame) => ({
        minGradeLevel: frame.minGradeLevel,
        maxGradeLevel: frame.maxGradeLevel,
        dayOfWeek: frame.dayOfWeek,
        start: minutesOfClock(toWallClock(frame.startTime)),
        end: minutesOfClock(toWallClock(frame.endTime)),
      }));
      const breaks = await tx.schoolBreak.findMany({
        where: { startDate: { lte: new Date(`${query.to}T00:00:00.000Z`) }, endDate: { gte: new Date(`${query.from}T00:00:00.000Z`) } },
        select: { kind: true, startDate: true, endDate: true, minGradeLevel: true, maxGradeLevel: true },
      });
      const holidays = wholeSchoolHolidays(
        breaks.map((entry) => ({
          ...entry,
          startDate: entry.startDate.toISOString().slice(0, 10),
          endDate: entry.endDate.toISOString().slice(0, 10),
        })),
        query.from,
        query.to,
      );

      const targets: UtilisationTarget[] = [];
      if (kind !== 'RESOURCE') targets.push(...(await this.rooms(tx, start, end)));
      if (kind !== 'ROOM') targets.push(...(await this.resources(tx, start, end)));

      const open = { start: minutesOfClock(openFrom), end: minutesOfClock(openTo) };
      const { weekStarts, rows } = utilisation({ from: query.from, to: query.to, timeZone, frames, holidays, open, targets });
      return {
        from: query.from,
        to: query.to,
        timezone: timeZone,
        openFrom: clockOfMinutes(open.start),
        openTo: clockOfMinutes(open.end),
        framesMissing: frames.length === 0,
        weekStarts,
        rows,
      };
    });
  }

  /** Every room, with what holds it: lessons that hold their time, and bookings that are approved. */
  private async rooms(tx: PrismaClient, start: Date, end: Date): Promise<UtilisationTarget[]> {
    const rooms = await tx.room.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true, minGradeLevel: true, maxGradeLevel: true } });
    const held = new Map<string, HeldInterval[]>(rooms.map((room) => [room.id, []]));
    const overlap = { startsAt: { lt: end }, endsAt: { gt: start } };
    const lessons = await tx.calendarLesson.findMany({
      where: { roomId: { not: null }, status: { in: ['SCHEDULED', 'COMPLETED'] }, ...overlap },
      select: { roomId: true, startsAt: true, endsAt: true },
    });
    for (const lesson of lessons) held.get(lesson.roomId as string)?.push({ start: lesson.startsAt.getTime(), end: lesson.endsAt.getTime(), quantity: 1 });
    const bookings = await tx.roomBooking.findMany({ where: { status: 'APPROVED', ...overlap }, select: { roomId: true, startsAt: true, endsAt: true } });
    for (const booking of bookings) held.get(booking.roomId)?.push({ start: booking.startsAt.getTime(), end: booking.endsAt.getTime(), quantity: 1 });
    return rooms.map((room) => ({
      kind: 'ROOM' as const,
      id: room.id,
      name: room.name,
      capacity: 1,
      years: { min: room.minGradeLevel, max: room.maxGradeLevel },
      held: held.get(room.id) ?? [],
    }));
  }

  private async resources(tx: PrismaClient, start: Date, end: Date): Promise<UtilisationTarget[]> {
    const resources = await tx.resource.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true, quantity: true } });
    const held = new Map<string, HeldInterval[]>(resources.map((resource) => [resource.id, []]));
    const bookings = await tx.resourceBooking.findMany({
      where: { status: 'APPROVED', startsAt: { lt: end }, endsAt: { gt: start } },
      select: { resourceId: true, quantity: true, startsAt: true, endsAt: true },
    });
    for (const booking of bookings) {
      held.get(booking.resourceId)?.push({ start: booking.startsAt.getTime(), end: booking.endsAt.getTime(), quantity: booking.quantity });
    }
    return resources.map((resource) => ({
      kind: 'RESOURCE' as const,
      id: resource.id,
      name: resource.name,
      capacity: resource.quantity,
      years: { min: null, max: null },
      held: held.get(resource.id) ?? [],
    }));
  }
}
