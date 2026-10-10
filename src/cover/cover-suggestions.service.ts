import { createHash } from 'node:crypto';
import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { CoverPoolPreference, PrismaClient, TeacherQualificationKind } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { requireSchoolId } from '../common/utils/request-context';
import { PrismaService } from '../database/prisma.service';
import { enterGrundschemaWrite } from '../publication/publish-mode';
import { attendanceSpan } from '../staffing/staffing-enforcement';
import { gradesParam } from '../staffing/staffing-checks';
import { targetMinutesPerWeek } from '../staffing/teacher-load';
import { pairsStatement, toBoardItem, type PairRow } from './cover-board';
import {
  asDay,
  dayBounds,
  dayDate,
  readCounter,
  readPersonDays,
  readWeekMinutes,
  schoolTimezone,
  strongestOn,
  type CounterRow,
  type DayRead,
  type QualificationRow,
} from './cover-context';
import { lockCoverDay, lockLessons, lockTeachers } from './cover-decisions';
import { compareRanked, rankCandidate, type RankReason } from './cover-rank';
import { hardFindings, holdsTime, overlaps, prefersFree, type CoverTarget, type PersonLesson, type RuleFinding } from './cover-rules';
import { CoverService, emptyEffects, merge } from './cover.service';
import { proposeDay, type DayProposal, type ProposalLesson } from './day-proposal';
import type { ApplyDto } from './dto/cover.dto';

export const COVER_PROPOSAL_STALE = 'COVER_PROPOSAL_STALE';

export interface Candidate {
  userId: string;
  kind: 'STAFF' | 'POOL';
  score: number;
  qualificationKind: TeacherQualificationKind | null;
  reasons: RankReason[];
  counter: { weekLessons: number; termLessons: number };
  load: { weekMinutes: number; targetMinutes: number | null };
}

export interface CandidatesResponse {
  lessonId: string;
  candidates: Candidate[];
  /** Who was left out and by which hard rule; ABSENT says only that they are away. */
  excluded: { userId: string; codes: RuleFinding[] }[];
}

interface LessonInfo {
  id: string;
  schoolId: string;
  date: string;
  startsAt: Date;
  endsAt: Date;
  subjectId: string;
  studentGroupId: string;
  extraGroupIds: string[];
  studentIds: string[];
  teacherIds: string[];
}

interface YearInfo {
  id: string;
  isActive: boolean;
  predecessorId: string | null;
  startDate: string;
  endDate: string;
}

/** Everything the ranking reads for a day's lessons, read once. */
interface RankContext {
  year: YearInfo | null;
  qualifications: QualificationRow[];
  spanOf: Map<string, { min: number; max: number } | null>;
  requirements: { teacherId: string | null; coTeacherId: string | null; studentGroupId: string; subjectId: string }[];
  mentors: { userId: string; studentGroupId: string | null }[];
  policy: { fullTimeTeachingMinutesPerWeek: number | null; overAllocationTolerancePercent: number };
  poolPreference: CoverPoolPreference;
  counter: Map<string, CounterRow>;
  weekMinutes: Map<string, number>;
  subjectName: Map<string, string>;
  groupName: Map<string, string>;
}

/**
 * SUGGESTIONS (cover-rules.ts filters, cover-rank.ts ranks) for one lesson,
 * and "Fördela dagen" (day-proposal.ts) with its apply. Admin only. Every
 * candidate is judged by the same rules; nothing here reads a reason.
 */
@Injectable()
export class CoverSuggestionsService {
  private readonly logger = new Logger(CoverSuggestionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cover: CoverService,
  ) {}

  async candidates(lessonId: string, user: AuthenticatedUser): Promise<CandidatesResponse> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const [lesson] = await this.readLessons(tx, [lessonId]);
      if (!lesson) throw new NotFoundException('Lesson not found.');
      const timezone = await schoolTimezone(tx, schoolId);
      const year = await this.yearOf(tx, lesson.studentGroupId);
      const read = await readPersonDays(tx, { date: lesson.date, timezone, academicYearId: year?.id ?? null });
      const context = await this.rankContext(tx, user, schoolId, [lesson], lesson.date, year);
      const target = targetOf(lesson);
      const candidates: Candidate[] = [];
      const excluded: CandidatesResponse['excluded'] = [];
      for (const [userId, day] of [...read.days].sort(([a], [b]) => a.localeCompare(b))) {
        const findings = hardFindings(day, target);
        if (findings.length > 0) {
          excluded.push({ userId, codes: findings });
          continue;
        }
        candidates.push(this.candidateOf(lesson, userId, read, context, []));
      }
      candidates.sort((a, b) => compareRanked({ ...a, counter: { week: a.counter.weekLessons } }, { ...b, counter: { week: b.counter.weekLessons } }));
      return { lessonId, candidates, excluded };
    });
  }

  /** The proposal for every open lesson of a day; writes nothing. */
  async proposal(
    date: string,
    excludeUserIds: readonly string[],
    user: AuthenticatedUser,
  ): Promise<DayProposal & { date: string; basis: string }> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const timezone = await schoolTimezone(tx, schoolId);
      const proposal = await this.propose(tx, user, schoolId, date, timezone, excludeUserIds);
      return { date, ...proposal, basis: await basisOf(tx, date, timezone) };
    });
  }

  /**
   * The reviewed proposal, applied in ONE transaction: the day's lock, the
   * basis recomputed (409 COVER_PROPOSAL_STALE if anything it was built on
   * moved), every item re-checked against the hard rules with the earlier
   * items applied, then each written as a board decision.
   */
  async apply(date: string, dto: ApplyDto, user: AuthenticatedUser): Promise<{ applied: number }> {
    const schoolId = requireSchoolId(user);
    const effects = await this.cover.write(user, async (tx) => {
      await enterGrundschemaWrite(tx, schoolId);
      await lockCoverDay(tx, schoolId, date);
      const timezone = await schoolTimezone(tx, schoolId);
      if ((await basisOf(tx, date, timezone)) !== dto.basis) throw proposalStale();
      const lessonIds = dto.items.map((item) => item.lessonId);
      await lockLessons(tx, lessonIds);
      await lockTeachers(tx, dto.items.map((item) => item.userId));

      const lessons = new Map((await this.readLessons(tx, lessonIds)).map((lesson) => [lesson.id, lesson]));
      const year = lessons.size > 0 ? await this.yearOf(tx, [...lessons.values()][0]!.studentGroupId) : null;
      const read = await readPersonDays(tx, {
        date,
        timezone,
        academicYearId: year?.id ?? null,
        userIds: dto.items.map((item) => item.userId),
      });
      const given = new Map<string, PersonLesson[]>();
      for (const item of dto.items) {
        const lesson = lessons.get(item.lessonId);
        const day = read.days.get(item.userId);
        if (!lesson || lesson.date !== date || !day) throw proposalStale(item.lessonId);
        const target = targetOf(lesson);
        if (hardFindings(day, target, given.get(item.userId) ?? []).length > 0) throw proposalStale(item.lessonId);
        given.set(item.userId, [...(given.get(item.userId) ?? []), pickOf(target)]);
      }

      const all = emptyEffects();
      for (const item of dto.items) {
        merge(
          all,
          await this.cover.decideInTransaction(
            tx,
            { lessonId: item.lessonId, absenceId: item.absenceId, kind: 'SUBSTITUTE', substituteId: item.userId, expected: 'OPEN' },
            user,
          ),
        );
      }
      return all;
    });
    await this.cover.afterCommit(user, effects);
    this.logger.log(`Cover day applied [date=${date}, items=${dto.items.length}]`);
    return { applied: dto.items.length };
  }

  // ---------------------------------------------------------------------

  private async propose(
    tx: PrismaClient,
    user: AuthenticatedUser,
    schoolId: string,
    date: string,
    timezone: string,
    excludeUserIds: readonly string[],
  ): Promise<DayProposal> {
    const bounds = dayBounds(date, timezone);
    const rows =
      (await tx.$queryRaw<PairRow[]>(pairsStatement({ kind: 'window', from: date, to: date, winFrom: bounds.start, winTo: bounds.end }))) ??
      [];
    const now = this.cover.now();
    const open = rows.map((row) => toBoardItem(row, now)).filter((item) => item.status === 'OPEN' && !item.passed);
    if (open.length === 0) return { items: [], unassigned: [] };
    const lessons = new Map((await this.readLessons(tx, open.map((item) => item.lessonId))).map((lesson) => [lesson.id, lesson]));
    const year = await this.yearOf(tx, [...lessons.values()][0]!.studentGroupId);
    const read = await readPersonDays(tx, { date, timezone, academicYearId: year?.id ?? null });
    const context = await this.rankContext(tx, user, schoolId, [...lessons.values()], date, year);
    const excluded = new Set(excludeUserIds);
    const candidates = [...read.days.keys()].filter((id) => !excluded.has(id)).sort();
    const proposalLessons: ProposalLesson[] = open.flatMap((item) => {
      const lesson = lessons.get(item.lessonId);
      return lesson ? [{ lessonId: lesson.id, absenceId: item.absenceId, target: targetOf(lesson), candidates }] : [];
    });
    return proposeDay(proposalLessons, {
      day: (userId) => read.days.get(userId),
      score: (entry, userId, picked) => {
        const lesson = lessons.get(entry.lessonId)!;
        const candidate = this.candidateOf(lesson, userId, read, context, picked);
        return { score: candidate.score, reasons: candidate.reasons, week: candidate.counter.weekLessons };
      },
    });
  }

  private candidateOf(
    lesson: LessonInfo,
    userId: string,
    read: DayRead,
    context: RankContext,
    picked: readonly PersonLesson[],
  ): Candidate {
    const day = read.days.get(userId)!;
    const target = targetOf(lesson);
    const span = context.spanOf.get(lesson.id) ?? null;
    const qualification = strongestOn(context.qualifications, userId, lesson.subjectId, span, dayDate(lesson.date));
    const groups = new Set([lesson.studentGroupId, ...lesson.extraGroupIds]);
    const theirs = context.requirements.filter((row) => row.teacherId === userId || row.coTeacherId === userId);
    const lessonMinutes = Math.round((lesson.endsAt.getTime() - lesson.startsAt.getTime()) / 60_000);
    const dayLessons = [...day.lessons, ...picked].filter(
      (row) => holdsTime(row) && row.date === lesson.date && row.id !== lesson.id,
    );
    const released = day.lessons.find(
      (row) => row.status === 'CANCELLED' && row.date === lesson.date && overlaps(row, target),
    );
    const employment = read.employments.get(userId) ?? null;
    const target_ = targetMinutesPerWeek(employment, {
      fullTimeTeachingMinutesPerWeek: context.policy.fullTimeTeachingMinutesPerWeek,
      overAllocationTolerancePercent: context.policy.overAllocationTolerancePercent,
      fullTimeRegulatedHoursPerYear: 1360,
      workDaysPerYear: 194,
      qualificationMode: 'WARN',
    });
    const counted = context.counter.get(userId);
    const pickedMinutes = picked.reduce((sum, row) => sum + (row.end - row.start) / 60_000, 0);
    const kind: 'STAFF' | 'POOL' = day.pool.member && !day.pool.hasEmployment ? 'POOL' : 'STAFF';
    const weekLessons = (counted?.weekLessons ?? 0) + picked.length;
    const termLessons = (counted?.termLessons ?? 0) + picked.length;
    const weekMinutes = Math.round((context.weekMinutes.get(userId) ?? 0) + pickedMinutes);
    const ranked = rankCandidate({
      userId,
      kind,
      qualification,
      teachesSubject: theirs.some((row) => row.subjectId === lesson.subjectId),
      teachesGroupSubject: theirs.some((row) => row.subjectId === lesson.subjectId && groups.has(row.studentGroupId)),
      teachesGroup: theirs.some((row) => groups.has(row.studentGroupId)),
      mentor: context.mentors.some((row) => row.userId === userId && row.studentGroupId !== null && groups.has(row.studentGroupId)),
      lesson: { start: target.start, end: target.end, minutes: lessonMinutes },
      dayLessons,
      releasedGroup: released ? (context.groupName.get(released.studentGroupId) ?? '') : null,
      counter: { week: weekLessons, term: termLessons },
      load: { weekMinutes, target: target_, tolerancePercent: context.policy.overAllocationTolerancePercent },
      poolPreference: context.poolPreference,
      prefersFree: prefersFree(day, target),
      names: {
        subject: context.subjectName.get(lesson.subjectId) ?? '',
        group: context.groupName.get(lesson.studentGroupId) ?? '',
        grades: span ? gradesParam(span) : null,
      },
    });
    return {
      userId,
      kind,
      score: ranked.score,
      qualificationKind: qualification,
      reasons: ranked.reasons,
      counter: { weekLessons, termLessons },
      load: { weekMinutes, targetMinutes: target_ },
    };
  }

  private async rankContext(
    tx: PrismaClient,
    user: AuthenticatedUser,
    schoolId: string,
    lessons: LessonInfo[],
    date: string,
    year: YearInfo | null,
  ): Promise<RankContext> {
    const subjectIds = [...new Set(lessons.map((lesson) => lesson.subjectId))];
    const groupIds = [...new Set(lessons.flatMap((lesson) => [lesson.studentGroupId, ...lesson.extraGroupIds]))];
    const qualifications = ((await tx.teacherSubjectQualification.findMany({
      where: { subjectId: { in: subjectIds } },
      select: { userId: true, subjectId: true, minGradeLevel: true, maxGradeLevel: true, kind: true, validFrom: true, validTo: true },
    })) ?? []) as QualificationRow[];
    const spanOf = new Map<string, { min: number; max: number } | null>();
    if (year && qualifications.length > 0) {
      for (const lesson of lessons) {
        spanOf.set(
          lesson.id,
          await attendanceSpan(tx, {
            academicYearId: year.id,
            groupIds: [lesson.studentGroupId, ...lesson.extraGroupIds],
            studentIds: lesson.studentIds,
            rosters: { viewer: user, known: year },
          }),
        );
      }
    }
    const requirements = year
      ? ((await tx.teachingRequirement.findMany({
          where: { academicYearId: year.id },
          select: { teacherId: true, coTeacherId: true, studentGroupId: true, subjectId: true },
        })) ?? [])
      : [];
    const mentors = year
      ? ((await tx.teacherDuty.findMany({
          where: { academicYearId: year.id, kind: 'MENTORSKAP', studentGroupId: { in: groupIds } },
          select: { userId: true, studentGroupId: true },
        })) ?? [])
      : [];
    const policy = await tx.staffingPolicy.findUnique({
      where: { schoolId },
      select: { fullTimeTeachingMinutesPerWeek: true, overAllocationTolerancePercent: true },
    });
    const settings = await tx.coverSettings.findUnique({ where: { schoolId }, select: { poolPreference: true } });
    const counter = await readCounter(tx, date, year, this.cover.now());
    const weekMinutes = await readWeekMinutes(tx, date);
    const [subjects, groups] = await Promise.all([
      tx.subject.findMany({ where: { id: { in: subjectIds } }, select: { id: true, name: true } }),
      tx.studentGroup.findMany({ where: { id: { in: groupIds } }, select: { id: true, name: true } }),
    ]);
    // A released lesson's class may be any class of the day.
    const releasedGroups = await tx.studentGroup.findMany({
      where: { calendarLessons: { some: { date: dayDate(date), status: 'CANCELLED' } }, id: { notIn: groupIds } },
      select: { id: true, name: true },
    });
    return {
      year,
      qualifications,
      spanOf,
      requirements,
      mentors,
      policy: {
        fullTimeTeachingMinutesPerWeek: policy?.fullTimeTeachingMinutesPerWeek ?? null,
        overAllocationTolerancePercent: policy?.overAllocationTolerancePercent ?? 10,
      },
      poolPreference: settings?.poolPreference ?? 'NEUTRAL',
      counter,
      weekMinutes,
      subjectName: new Map((subjects ?? []).map((row) => [row.id, row.name])),
      groupName: new Map([...(groups ?? []), ...(releasedGroups ?? [])].map((row) => [row.id, row.name])),
    };
  }

  private async readLessons(tx: PrismaClient, ids: readonly string[]): Promise<LessonInfo[]> {
    if (ids.length === 0) return [];
    const rows =
      (await tx.calendarLesson.findMany({
        where: { id: { in: [...new Set(ids)] } },
        select: {
          id: true,
          schoolId: true,
          date: true,
          startsAt: true,
          endsAt: true,
          subjectId: true,
          studentGroupId: true,
          teachers: { select: { teacherId: true } },
          extraGroups: { select: { studentGroupId: true } },
          participants: { select: { studentId: true } },
        },
      })) ?? [];
    return rows.map((row) => ({
      id: row.id,
      schoolId: row.schoolId,
      date: asDay(row.date),
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      subjectId: row.subjectId,
      studentGroupId: row.studentGroupId,
      extraGroupIds: (row.extraGroups ?? []).map((entry) => entry.studentGroupId),
      studentIds: (row.participants ?? []).map((entry) => entry.studentId),
      teacherIds: (row.teachers ?? []).map((entry) => entry.teacherId),
    }));
  }

  /** The läsår of a class, with its flags (for the roster basis) and its dates (for the term). */
  private async yearOf(tx: PrismaClient, studentGroupId: string): Promise<YearInfo | null> {
    const year = await tx.academicYear.findFirst({
      where: { studentGroups: { some: { id: studentGroupId } } },
      select: { id: true, isActive: true, predecessorId: true, startDate: true, endDate: true },
    });
    return year
      ? { id: year.id, isActive: year.isActive, predecessorId: year.predecessorId, startDate: asDay(year.startDate), endDate: asDay(year.endDate) }
      : null;
  }
}

function targetOf(lesson: LessonInfo): CoverTarget {
  return {
    id: lesson.id,
    date: lesson.date,
    start: lesson.startsAt.getTime(),
    end: lesson.endsAt.getTime(),
    teacherIds: lesson.teacherIds,
  };
}

function pickOf(target: CoverTarget): PersonLesson {
  return { id: target.id, date: target.date, start: target.start, end: target.end, status: 'SCHEDULED', studentGroupId: '', subjectId: '' };
}

function proposalStale(lessonId?: string): ConflictException {
  return new ConflictException({
    message: 'Dagen har ändrats sedan förslaget gjordes. Gör ett nytt förslag.',
    code: COVER_PROPOSAL_STALE,
    ...(lessonId ? { lessonId } : {}),
  });
}

/**
 * The proposal's basis: sha256 over the canonical JSON of what it was built
 * on — the day's lessons with their teachers, the ACTIVE absences overlapping
 * the day (periods only), the day's PENDING/APPROVED bookings and the day's
 * decisions. Apply recomputes it under the day's lock (the Fas 4 pattern).
 */
export async function basisOf(tx: PrismaClient, date: string, timezone: string): Promise<string> {
  const bounds = dayBounds(date, timezone);
  const lessons =
    (await tx.calendarLesson.findMany({
      where: { date: dayDate(date) },
      select: { id: true, startsAt: true, endsAt: true, status: true, teachers: { select: { teacherId: true, role: true } } },
      orderBy: { id: 'asc' },
    })) ?? [];
  const absences =
    (await tx.teacherAbsence.findMany({
      where: { status: 'ACTIVE', startsAt: { lt: bounds.end }, endsAt: { gt: bounds.start } },
      select: { id: true, userId: true, startsAt: true, endsAt: true },
      orderBy: { id: 'asc' },
    })) ?? [];
  const bookings =
    (await tx.roomBooking.findMany({
      where: { status: { in: ['PENDING', 'APPROVED'] }, startsAt: { lt: bounds.end }, endsAt: { gt: bounds.start } },
      select: { id: true, bookedById: true, startsAt: true, endsAt: true, status: true },
      orderBy: { id: 'asc' },
    })) ?? [];
  const decisions =
    (await tx.teacherAbsenceCover.findMany({
      where: { calendarLessonId: { in: lessons.map((lesson) => lesson.id) } },
      select: { id: true, absenceId: true, calendarLessonId: true, decision: true, substituteId: true },
      orderBy: { id: 'asc' },
    })) ?? [];
  const canonical = {
    lessons: lessons.map((lesson) => ({
      id: lesson.id,
      startsAt: lesson.startsAt.toISOString(),
      endsAt: lesson.endsAt.toISOString(),
      status: lesson.status,
      teachers: [...(lesson.teachers ?? [])]
        .map((t) => `${t.teacherId}:${t.role}`)
        .sort(),
    })),
    absences: absences.map((a) => [a.id, a.userId, a.startsAt.toISOString(), a.endsAt.toISOString()]),
    bookings: bookings.map((b) => [b.id, b.bookedById, b.startsAt.toISOString(), b.endsAt.toISOString(), b.status]),
    decisions: decisions.map((d) => [d.id, d.absenceId, d.calendarLessonId, d.decision, d.substituteId]),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
