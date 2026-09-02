import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { runsOn } from './lesson-recurrence';
import { requireSchoolId } from '../common/utils/request-context';
import { zonedTimeToUtc } from '../common/utils/time';
import type { PublishScheduleDto } from './dto/publish-schedule.dto';

export interface PublishResult {
  /** SCHEDULED rows written. Never includes a lesson nobody can hold. */
  created: number;
  /**
   * Rows written CANCELLED because the teacher or the room was already spoken
   * for that date. The class is still here and expecting the lesson, so a hole
   * in their schedule with no explanation would be the worse answer — and the
   * substitute workflow finds these by querying the calendar, so a lesson that
   * was never written is invisible to the very process meant to cover it.
   */
  cancelled: number;
  /**
   * Lessons deliberately not written: already materialized, or on a day the
   * class is not in school at all — a dated group closure, or a lov. They are
   * one number because they have one meaning for the caller ("nothing to do
   * here"), and no counter separates the reasons; a report that wants to know
   * how many lessons a lov cost has to ask the breaks, not this.
   */
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
 * That key is the *template* id, which is why it only holds as long as no
 * dated lesson outlives its template. The FK is ON DELETE SET NULL, so an
 * orphaned row carries `masterLessonId = null`, matches no key below, and is
 * published straight over — a regenerated week used to come back doubled for
 * exactly that reason. Whoever replaces a generated timetable therefore
 * deletes its future materializations in the same transaction; see
 * OptimizationProxyService.persistMasterLessons.
 *
 * Concurrency: the idempotency set is read once, at the start of the
 * transaction, so two administrators publishing the same window at the same
 * moment each see the other's rows as absent and both insert. Nothing in this
 * method can separate them — only a unique index on (masterLessonId, date)
 * can, and then the loser's write surfaces as 409 through the standard Prisma
 * error mapping.
 *
 * Holidays: two independent sources, and neither ever writes anything — they
 * only suppress. A full-day `UNAVAILABLE` constraint on a student group with a
 * concrete `date` closes that one group's day. A `SchoolBreak` closes the day
 * for the whole school, or for the span of years it names; it has no clock
 * part at all, because a lov takes the day. Both are decided on the school's
 * local calendar date, which is the unit this method walks in.
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
            recurrence: true,
            startDate: true,
            endDate: true,
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

        /*
         * Every dated closure in the window, not only whole-day class holidays.
         *
         * This used to ask for STUDENT_GROUP rows and then throw away anything
         * that was not a full day, so a teacher marked away on a Tuesday, or a
         * room closed for two hours, was materialised over regardless: the
         * school had said the lesson could not be held and the calendar said it
         * would be.
         *
         * PREFERRED_FREE and PREFERRED_BUSY stay out on purpose. They are
         * wishes the solver trades off, not statements that a date cannot be
         * held, and treating a wish as a closure would silently delete lessons
         * a school only nudged.
         */
        const closures = await tx.availabilityConstraint.findMany({
          where: {
            type: 'UNAVAILABLE',
            date: { not: null, gte: parseUtcDate(fromDate), lte: parseUtcDate(toDate) },
          },
          select: {
            resourceType: true,
            userId: true,
            roomId: true,
            studentGroupId: true,
            minGradeLevel: true,
            maxGradeLevel: true,
            date: true,
            startTime: true,
            endTime: true,
          },
        });
        const closuresByDate = new Map<string, typeof closures>();
        for (const closure of closures) {
          if (!closure.date) continue;
          const key = toDateString(closure.date);
          const list = closuresByDate.get(key);
          if (list) list.push(closure);
          else closuresByDate.set(key, [closure]);
        }

        /*
         * Lov och studiedagar overlapping the window.
         *
         * A break is a named range belonging to the school rather than to a
         * resource, which is exactly why it is a second query and not more
         * rows in the one above: a constraint names ONE resource on ONE date
         * and can say "åk 7 cannot be taught on the 26th", but nothing in
         * `ConstraintResource` means "everybody", and a sportlov entered that
         * way was a row per day per group.
         *
         * `kind` is not selected, and that is the point: HOLIDAY and STAFF_DAY
         * suppress identically. What separates them is what the day MEANS for
         * staff — a studiedag is a working day, a jullov is not — not whether
         * anyone is taught, and nobody is taught on either. Do not add a branch
         * on it here; the reports that count the two apart read the breaks.
         */
        const breaks = await tx.schoolBreak.findMany({
          where: {
            academicYearId: dto.academicYearId,
            // Inclusive at both ends, so overlap is start<=windowEnd and
            // end>=windowStart — not containment. A jullov that begins before
            // the window still closes the days of it that fall inside.
            startDate: { lte: parseUtcDate(toDate) },
            endDate: { gte: parseUtcDate(fromDate) },
          },
          select: {
            startDate: true,
            endDate: true,
            minGradeLevel: true,
            maxGradeLevel: true,
          },
        });

        /*
         * Expanded onto local calendar days, clipped to the window.
         *
         * The dates are the unit the loop below walks in and the unit each
         * `startsAt` is BUILT from, so a break and a lesson meet here as two
         * "YYYY-MM-DD" strings and never as a range and an instant. Testing
         * the instant against the range is the off-by-a-day this keeps out:
         * 22:15Z on the 25th is a lesson at 00:15 on the 26th in Stockholm,
         * and a lov starting the 26th has to take it. Same trap `coversTime`
         * exists for, one level up.
         *
         * Expanding rather than scanning the ranges per date because a läsår
         * holds a few dozen breaks against a couple of hundred dates, and the
         * map keeps the shape of `closuresByDate` right above it.
         */
        const breakDays = new Map<string, typeof breaks>();
        for (const entry of breaks) {
          const from = maxDate(toDateString(entry.startDate), fromDate);
          const to = minDate(toDateString(entry.endDate), toDate);
          for (const date of iterateDates(from, to)) {
            const list = breakDays.get(date);
            if (list) list.push(entry);
            else breakDays.set(date, [entry]);
          }
        }

        // The year of each class, for GRADE_LEVEL closures and for breaks that
        // narrow themselves to a span of years. Read only when something in the
        // window actually asks the question, so an ordinary publish — no grade
        // closures, a school-wide lov — still pays nothing for it.
        const gradeOfGroup = new Map<string, number | null>();
        if (
          closures.some((closure) => closure.resourceType === 'GRADE_LEVEL') ||
          breaks.some(
            (entry) => entry.minGradeLevel !== null || entry.maxGradeLevel !== null,
          )
        ) {
          const groups = await tx.studentGroup.findMany({
            where: { academicYearId: dto.academicYearId },
            select: { id: true, gradeLevel: true },
          });
          for (const group of groups) gradeOfGroup.set(group.id, group.gradeLevel);
        }

        /**
         * Does this closure cover the lesson's own hours on that date?
         *
         * The closure's times are a bare wall clock and the lesson is a real
         * instant, so the two are lifted into the same unit through the school's
         * timezone — the same conversion that built `startsAt` a few lines
         * below. Comparing the raw UTC parts is off by the offset, which in
         * Europe/Stockholm is an hour or two every day of the year.
         */
        const coversTime = (
          closure: { startTime: Date; endTime: Date },
          date: string,
          startsAt: Date,
          endsAt: Date,
        ): boolean => {
          if (isFullDay(closure.startTime, closure.endTime)) return true;
          const from = zonedTimeToUtc(date, timeToString(closure.startTime), timezone);
          const to = zonedTimeToUtc(date, timeToString(closure.endTime), timezone);
          return from.getTime() < endsAt.getTime() && startsAt.getTime() < to.getTime();
        };

        /**
         * Is this class inside the break — that is, off school that day?
         *
         * Both bounds null is the ordinary lov: the whole school, answered
         * without asking any group about its year. A span narrows it to prao
         * för åk 9 or a studiedag for the lower years, and then the group's own
         * year has to sit inside it. A group that has no year — a nivågrupp
         * drawn across several — cannot be shown to be inside, so its lesson
         * survives: the same call the GRADE_LEVEL closure makes below, for the
         * same reason, that erasing a lesson on a guess is the worse mistake.
         */
        const breakCoversGroup = (
          entry: { minGradeLevel: number | null; maxGradeLevel: number | null },
          studentGroupId: string,
        ): boolean => {
          if (entry.minGradeLevel === null && entry.maxGradeLevel === null) return true;
          const grade = gradeOfGroup.get(studentGroupId);
          if (typeof grade !== 'number') return false;
          return (
            (entry.minGradeLevel === null || grade >= entry.minGradeLevel) &&
            (entry.maxGradeLevel === null || grade <= entry.maxGradeLevel)
          );
        };

        let created = 0;
        let cancelled = 0;
        let skipped = 0;
        const pendingCreates: Array<() => Promise<unknown>> = [];

        /*
         * The meals, dated by the very same walk the lessons take.
         *
         * Deriving "which days does this school teach" a second time — in the
         * pupil portal, the guardian portal and the day planner — is how the
         * lov stops being honoured in two of the three. Here the break check
         * below is the same object, the same `breakCoversGroup`, and the same
         * date string.
         *
         * Their own table, not CalendarLessons: everything downstream of that
         * one assumes teaching. SS12000 stamps every row `activityType:
         * 'Undervisning'` and would report lunch to the kommun as a lesson, and
         * the absence notice would tell a guardian their child was away from
         * "Lunch". Both are read straight from the browser through PostgREST
         * with no server DTO to filter at.
         */
        const sittings = await tx.lunchSitting.findMany({
          where: { academicYearId: dto.academicYearId },
          select: {
            studentGroupId: true,
            dayOfWeek: true,
            startTime: true,
            endTime: true,
          },
        });
        const sittingsByWeekday = new Map<number, typeof sittings>();
        for (const sitting of sittings) {
          const list = sittingsByWeekday.get(sitting.dayOfWeek);
          if (list) list.push(sitting);
          else sittingsByWeekday.set(sitting.dayOfWeek, [sitting]);
        }
        let lunchesCreated = 0;

        for (const date of iterateDates(fromDate, toDate)) {
          const weekday = isoWeekday(date);

          for (const sitting of sittingsByWeekday.get(weekday) ?? []) {
            // The class is not in school, so there is no meal to serve — the
            // same answer, and the same call, the lessons make below.
            if (
              (breakDays.get(date) ?? []).some((entry) =>
                breakCoversGroup(entry, sitting.studentGroupId),
              )
            ) {
              continue;
            }
            /*
             * REPLACED, not skipped.
             *
             * This used to read the already-materialised meals into a set and
             * `continue` past every one of them, calling it "the same
             * idempotency the lessons get from existingKeys". It is not the
             * same, and the difference is the whole bug: a CalendarLesson may
             * carry AttendanceRecords, so rewriting one would rewrite what
             * happened and skipping is the only honest answer. A CalendarLunch
             * carries no attendance, no status and no participants — nothing
             * about it records the past — so when the sitting has moved, the
             * published meal is simply out of date, and skipping it kept last
             * month's lunch time on a pupil's phone for ever.
             *
             * Upsert rather than delete-then-create so the (group, date) unique
             * key is what makes it idempotent, rather than an ordering this
             * loop would have to maintain.
             */
            const startsAt = zonedTimeToUtc(
              date,
              timeToString(sitting.startTime),
              timezone,
            );
            const endsAt = zonedTimeToUtc(date, timeToString(sitting.endTime), timezone);
            pendingCreates.push(() =>
              tx.calendarLunch.upsert({
                where: {
                  studentGroupId_date: {
                    studentGroupId: sitting.studentGroupId,
                    date: parseUtcDate(date),
                  },
                },
                update: { startsAt, endsAt },
                create: {
                  schoolId,
                  studentGroupId: sitting.studentGroupId,
                  date: parseUtcDate(date),
                  startsAt,
                  endsAt,
                },
              }),
            );
            lunchesCreated++;
          }

          const templates = byWeekday.get(weekday);
          if (!templates) continue;

          for (const template of templates) {
            // Alternating weeks and half-term subjects are decided here, when
            // the weekly template becomes dated lessons — see
            // lesson-recurrence.ts for the rule the conflict checker shares.
            if (!runsOn(template, parseUtcDate(date))) continue;

            // First, always: an already-materialised row may carry attendance,
            // and rewriting it would rewrite what happened.
            if (existingKeys.has(`${template.id}:${date}`)) {
              skipped++;
              continue;
            }

            /*
             * Then the lov, before anything is asked about teachers or rooms.
             * The class is not in school, so there is no lesson to hold and
             * nobody to cancel one for — the same answer, and the same reason,
             * as a closed class below. It is asked here rather than down there
             * because a break has no hours to compare against.
             */
            if (
              (breakDays.get(date) ?? []).some((entry) =>
                breakCoversGroup(entry, template.studentGroupId),
              )
            ) {
              skipped++;
              continue;
            }

            const startsAt = zonedTimeToUtc(date, timeToString(template.startTime), timezone);
            const endsAt = zonedTimeToUtc(date, timeToString(template.endTime), timezone);

            /*
             * Who is unavailable decides what to write, and the split is the
             * point. If the CLASS is away — lov, studiedag, PRAO — there is no
             * lesson to hold and nothing is written. If the teacher or the room
             * is spoken for, the class is still here: the lesson is written
             * CANCELLED so the pupils' schedule says what happened and the
             * substitute workflow, which searches the calendar by teacher and
             * date, can find it.
             *
             * A class closure outranks a resource closure: if nobody is there,
             * there is nobody to cancel a lesson for.
             */
            let blocked: 'group' | 'teacher' | 'room' | null = null;
            for (const closure of closuresByDate.get(date) ?? []) {
              if (!coversTime(closure, date, startsAt, endsAt)) continue;

              if (
                closure.resourceType === 'STUDENT_GROUP' &&
                closure.studentGroupId === template.studentGroupId
              ) {
                blocked = 'group';
                break;
              }
              if (closure.resourceType === 'GRADE_LEVEL') {
                // A group with no year of its own — a nivågrupp — cannot be
                // shown to be inside a range, and erasing a lesson on a guess
                // is the worse mistake.
                const grade = gradeOfGroup.get(template.studentGroupId);
                if (
                  typeof grade === 'number' &&
                  (closure.minGradeLevel === null || grade >= closure.minGradeLevel) &&
                  (closure.maxGradeLevel === null || grade <= closure.maxGradeLevel)
                ) {
                  blocked = 'group';
                  break;
                }
              }
              if (
                closure.resourceType === 'TEACHER' &&
                closure.userId !== null &&
                (closure.userId === template.teacherId ||
                  closure.userId === template.coTeacherId)
              ) {
                blocked = blocked ?? 'teacher';
              }
              if (
                closure.resourceType === 'ROOM' &&
                closure.roomId !== null &&
                closure.roomId === template.roomId
              ) {
                blocked = blocked ?? 'room';
              }
            }

            if (blocked === 'group') {
              skipped++;
              continue;
            }

            // Never the constraint's own `reason`: that field holds "sjukskriven",
            // and `note` is read by every pupil and guardian.
            const cancelledNote =
              blocked === 'teacher'
                ? 'Inställd: läraren är inte tillgänglig detta datum.'
                : 'Inställd: salen är inte tillgänglig detta datum.';

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
                  status: blocked === null ? 'SCHEDULED' : 'CANCELLED',
                  ...(blocked === null ? {} : { note: cancelledNote }),
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
            if (blocked === null) created++;
            else cancelled++;
          }
        }

        // Insert in modest chunks to keep transaction round-trips reasonable.
        for (let i = 0; i < pendingCreates.length; i += 50) {
          await Promise.all(pendingCreates.slice(i, i + 50).map((run) => run()));
        }

        this.logger.log(
          `Published schedule [year=${dto.academicYearId}, ${fromDate}..${toDate}, created=${created}, lunches=${lunchesCreated}, skipped=${skipped}]`,
        );

        return { created, cancelled, skipped, fromDate, toDate };
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

function minDate(a: string, b: string): string {
  return a < b ? a : b;
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
