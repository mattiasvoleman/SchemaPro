import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId } from '../common/utils/request-context';
import { zonedTimeToUtc } from '../common/utils/time';
import type { PublishScheduleDto } from './dto/publish-schedule.dto';

export interface PublishResult {
  created: number;
  skipped: number;
  fromDate: string;
  toDate: string;
}

/**
 * Materializes the weekly `MasterLesson` template into concrete, dated
 * `CalendarLessons` — the records that schedule views, attendance and the
 * mobile app operate on.
 *
 * Idempotency: a (masterLessonId, date) pair is only materialized once, so
 * re-publishing after regenerating part of the schedule is safe and never
 * duplicates lessons or touches lessons that already carry attendance.
 *
 * Holidays: full-day `UNAVAILABLE` constraints on a student group with a
 * concrete `date` suppress materialization for that group on that day.
 */
@Injectable()
export class CalendarService {
  private readonly logger = new Logger(CalendarService.name);

  constructor(private readonly prisma: PrismaService) {}

  async publish(dto: PublishScheduleDto, user: AuthenticatedUser): Promise<PublishResult> {
    const schoolId = requireSchoolId(user);

    return this.prisma.withRls(
      user,
      async (tx) => {
        const year = await tx.academicYear.findUnique({
          where: { id: dto.academicYearId },
          select: {
            id: true,
            startDate: true,
            endDate: true,
            school: { select: { timezone: true } },
          },
        });
        if (!year) {
          throw new NotFoundException('Academic year not found.');
        }

        const timezone = year.school.timezone;
        const yearStart = toDateString(year.startDate);
        const yearEnd = toDateString(year.endDate);
        const today = toDateString(new Date());

        const fromDate = clampDate(dto.fromDate ?? maxDate(yearStart, today), yearStart, yearEnd);
        const toDate = clampDate(dto.toDate ?? yearEnd, yearStart, yearEnd);
        if (fromDate > toDate) {
          throw new BadRequestException('fromDate must not be after toDate.');
        }

        const masterLessons = await tx.masterLesson.findMany({
          where: { academicYearId: dto.academicYearId },
          select: {
            id: true,
            subjectId: true,
            studentGroupId: true,
            teacherId: true,
        coTeacherId: true,
        extraGroups: { select: { studentGroupId: true } },
        participants: { select: { studentId: true } },
            roomId: true,
            dayOfWeek: true,
            startTime: true,
            endTime: true,
          },
        });
        if (masterLessons.length === 0) {
          throw new BadRequestException(
            'No master timetable exists for this academic year. Generate a schedule first.',
          );
        }

        // Group templates by ISO weekday for fast per-date lookup.
        const byWeekday = new Map<number, typeof masterLessons>();
        for (const lesson of masterLessons) {
          const list = byWeekday.get(lesson.dayOfWeek) ?? [];
          list.push(lesson);
          byWeekday.set(lesson.dayOfWeek, list);
        }

        // Existing materializations in the window (idempotency set).
        const existing = await tx.calendarLesson.findMany({
          where: {
            masterLessonId: { in: masterLessons.map((lesson) => lesson.id) },
            date: { gte: parseUtcDate(fromDate), lte: parseUtcDate(toDate) },
          },
          select: { masterLessonId: true, date: true },
        });
        const existingKeys = new Set(
          existing.map((row) => `${row.masterLessonId}:${toDateString(row.date)}`),
        );

        // Full-day, date-specific group closures (holiday mechanism).
        const closures = await tx.availabilityConstraint.findMany({
          where: {
            resourceType: 'STUDENT_GROUP',
            type: 'UNAVAILABLE',
            date: { not: null, gte: parseUtcDate(fromDate), lte: parseUtcDate(toDate) },
          },
          select: { studentGroupId: true, date: true, startTime: true, endTime: true },
        });
        const closedKeys = new Set(
          closures
            .filter((c) => isFullDay(c.startTime, c.endTime) && c.date && c.studentGroupId)
            .map((c) => `${c.studentGroupId}:${toDateString(c.date as Date)}`),
        );

        let created = 0;
        let skipped = 0;
        const pendingCreates: Array<() => Promise<unknown>> = [];

        for (const date of iterateDates(fromDate, toDate)) {
          const weekday = isoWeekday(date);
          const templates = byWeekday.get(weekday);
          if (!templates) continue;

          for (const template of templates) {
            if (existingKeys.has(`${template.id}:${date}`)) {
              skipped++;
              continue;
            }
            if (closedKeys.has(`${template.studentGroupId}:${date}`)) {
              skipped++;
              continue;
            }

            const startsAt = zonedTimeToUtc(date, timeToString(template.startTime), timezone);
            const endsAt = zonedTimeToUtc(date, timeToString(template.endTime), timezone);

            pendingCreates.push(() =>
              tx.calendarLesson.create({
                data: {
                  schoolId,
                  masterLessonId: template.id,
                  subjectId: template.subjectId,
                  studentGroupId: template.studentGroupId,
                  roomId: template.roomId,
                  date: parseUtcDate(date),
                  startsAt,
                  endsAt,
                  status: 'SCHEDULED',
                  ...(template.extraGroups.length > 0
                    ? {
                        extraGroups: {
                          create: template.extraGroups.map((entry) => ({
                            schoolId,
                            studentGroupId: entry.studentGroupId,
                          })),
                        },
                      }
                    : {}),
                  ...(template.participants.length > 0
                    ? {
                        participants: {
                          create: template.participants.map((entry) => ({
                            schoolId,
                            studentId: entry.studentId,
                          })),
                        },
                      }
                    : {}),
                  ...(template.teacherId || template.coTeacherId
                    ? {
                        teachers: {
                          create: [
                            ...(template.teacherId
                              ? [{ schoolId, teacherId: template.teacherId, role: 'LEAD' as const }]
                              : []),
                            ...(template.coTeacherId
                              ? [
                                  {
                                    schoolId,
                                    teacherId: template.coTeacherId,
                                    role: 'ASSISTANT' as const,
                                  },
                                ]
                              : []),
                          ],
                        },
                      }
                    : {}),
                },
                select: { id: true },
              }),
            );
            created++;
          }
        }

        // Insert in modest chunks to keep transaction round-trips reasonable.
        for (let i = 0; i < pendingCreates.length; i += 50) {
          await Promise.all(pendingCreates.slice(i, i + 50).map((run) => run()));
        }

        this.logger.log(
          `Published schedule [year=${dto.academicYearId}, ${fromDate}..${toDate}, created=${created}, skipped=${skipped}]`,
        );

        return { created, skipped, fromDate, toDate };
      },
      { timeoutMs: 120_000 },
    );
  }
}

// ---------------------------------------------------------------------------
// Pure date helpers (UTC-based; dates are calendar days, not instants)
// ---------------------------------------------------------------------------

function toDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseUtcDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function maxDate(a: string, b: string): string {
  return a > b ? a : b;
}

function clampDate(value: string, min: string, max: string): string {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function* iterateDates(from: string, to: string): Generator<string> {
  const cursor = parseUtcDate(from);
  const end = parseUtcDate(to).getTime();
  while (cursor.getTime() <= end) {
    yield toDateString(cursor);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
}

/** ISO weekday for a YYYY-MM-DD string: 1 = Monday … 7 = Sunday. */
function isoWeekday(date: string): number {
  const jsDay = parseUtcDate(date).getUTCDay();
  return jsDay === 0 ? 7 : jsDay;
}

function timeToString(time: Date): string {
  const h = time.getUTCHours().toString().padStart(2, '0');
  const m = time.getUTCMinutes().toString().padStart(2, '0');
  const s = time.getUTCSeconds().toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function isFullDay(start: Date, end: Date): boolean {
  const startMinutes = start.getUTCHours() * 60 + start.getUTCMinutes();
  const endMinutes = end.getUTCHours() * 60 + end.getUTCMinutes();
  return startMinutes === 0 && (endMinutes === 0 || endMinutes >= 23 * 60 + 59);
}
