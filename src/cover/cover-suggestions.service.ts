import { createHash } from 'node:crypto';
import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { CoverPoolPreference, PrismaClient, TeacherQualificationKind } from '@prisma/client';
import { recordRead } from '../access-log/access-log';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { requireSchoolId } from '../common/utils/request-context';
import { isoWeekday } from '../calendar/publish-days';
import { PrismaService } from '../database/prisma.service';
import { enterGrundschemaWrite } from '../publication/publish-mode';
import { dayOf, dutyRunsOn } from '../staffing/duty-dates';
import { changesDuringYear, postOfWeek } from '../staffing/employment-periods';
import { readsHr } from '../staffing/hr-visibility';
import { attendanceSpan } from '../staffing/staffing-enforcement';
import { toNioarigSpan, type GradeNumbering } from '../common/grade-numbering';
import { gradesParam } from '../staffing/staffing-checks';
import { targetMinutesPerWeek, yearTargetMinutesPerWeek, type LoadEmployment, type LoadPolicy } from '../staffing/teacher-load';
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
import { readSiteMap, travelBreaches, type PlacedLesson, type SiteMap } from '../common/site-travel';
import { compareRanked, poolTier, rankCandidate, type RankReason } from './cover-rank';
import {
  hardFindings,
  holdsTime,
  maskFindings,
  overlaps,
  prefersFree,
  type CoverTarget,
  type PersonLesson,
  type RuleFinding,
} from './cover-rules';
import { CoverService, emptyEffects, merge, naming } from './cover.service';
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
  roomId: string | null;
}

interface YearInfo {
  id: string;
  isActive: boolean;
  predecessorId: string | null;
  startDate: string;
  endDate: string;
  gradeNumbering: GradeNumbering;
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
  /**
   * For a reader who may not see when and how a post changes (Roller i
   * skolan, readsHr): the year's target of each post that changes during the
   * year, which such a post is judged and stated by. Null for every other
   * reader, who is told the period in force that week.
   */
  yearTargets: Map<string, number | null> | null;
  /** The school's sites and the minutes between them (site-travel.ts); empty with no figure. */
  sites: SiteMap;
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
      const read = await readPersonDays(tx, {
        date: lesson.date,
        timezone,
        academicYearId: year?.id ?? null,
        withPeriods: true,
      });
      const context = await this.rankContext(tx, user, schoolId, [lesson], lesson.date, year, read.employments);
      const target = targetOf(lesson);
      const candidates: Candidate[] = [];
      const excluded: CandidatesResponse['excluded'] = [];
      // Whom the post's deltid in days leaves out: the verdict is a term of
      // their post whether its figure is shown or not (cover-rules.ts).
      const outOfDays: string[] = [];
      const showsHr = readsHr(user);
      for (const [userId, day] of [...read.days].sort(([a], [b]) => a.localeCompare(b))) {
        const findings = hardFindings(day, target);
        if (findings.length > 0) {
          excluded.push({ userId, codes: maskFindings(findings, showsHr) });
          if (findings.some((finding) => finding.code === 'WORK_DAYS')) outOfDays.push(userId);
          continue;
        }
        candidates.push(this.candidateOf(lesson, userId, read, context, []));
      }
      const ranked = (c: Candidate) => ({ ...c, tier: poolTier(c.kind, context.poolPreference), counter: { week: c.counter.weekLessons } });
      candidates.sort((a, b) => compareRanked(ranked(a), ranked(b)));
      // Each candidate's week against their tjänst and their cover counter
      // (EMPLOYMENT), and whom their post's deltid in days leaves out
      // (EMPLOYMENT too, to a reader shown the figure or not: "the post
      // stops here" is the post's), and who is left out as away
      // (STAFF_ABSENCES, the code without the reason). The other exclusions
      // are the timetable's, the work rule's (which every member of staff
      // reads, the cap among them) and the pool's, not logged
      // (src/access-log/access-log.ts).
      await recordRead(tx, 'EMPLOYMENT', [...candidates.map((candidate) => candidate.userId), ...outOfDays], user.channel);
      await recordRead(
        tx,
        'STAFF_ABSENCES',
        excluded.filter((entry) => entry.codes.some((finding) => finding.code === 'ABSENT')).map((entry) => entry.userId),
        user.channel,
      );
      return { lessonId, candidates, excluded };
    });
  }

  /** The proposal for every open lesson of a day; writes nothing but its läslogg row. */
  async proposal(
    date: string,
    excludeUserIds: readonly string[],
    user: AuthenticatedUser,
  ): Promise<DayProposal & { date: string; basis: string }> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const timezone = await schoolTimezone(tx, schoolId);
      const proposal = await this.propose(tx, user, schoolId, date, timezone, excludeUserIds);
      // Each proposed substitute's reasons carry their cover counter and their
      // week against their tjänst, as the candidates' do (EMPLOYMENT). The
      // absences are ids only: who is away is the board's, which records it.
      await recordRead(tx, 'EMPLOYMENT', proposal.items.map((item) => item.userId), user.channel);
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
        const earlier = given.get(item.userId) ?? [];
        // The rules skip the lesson's own id when they look for an overlap,
        // so one person on two pairs of one lesson is refused here.
        if (earlier.some((pick) => pick.id === target.id)) throw proposalStale(item.lessonId);
        // The cap and the deltid in days are judged here as everything else:
        // the person's week read again under their lock, the earlier items as
        // picks. A lesson put in on another day of the week since the
        // proposal moves no basis (basisOf hashes the day); it lands here.
        if (hardFindings(day, target, earlier).length > 0) throw proposalStale(item.lessonId);
        given.set(item.userId, [...earlier, pickOf(target)]);
      }

      const all = emptyEffects();
      for (const item of dto.items) {
        try {
          merge(
            all,
            await this.cover.decideInTransaction(
              tx,
              { lessonId: item.lessonId, absenceId: item.absenceId, kind: 'SUBSTITUTE', substituteId: item.userId, expected: 'OPEN' },
              user,
            ),
          );
        } catch (error) {
          throw naming(error, item.lessonId);
        }
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
    const open = coveredTogether(rows.map((row) => toBoardItem(row, now)).filter((item) => item.status === 'OPEN' && !item.passed));
    if (open.length === 0) return { items: [], unassigned: [] };
    const lessons = new Map((await this.readLessons(tx, open.map((item) => item.lessonId))).map((lesson) => [lesson.id, lesson]));
    const year = await this.yearOf(tx, [...lessons.values()][0]!.studentGroupId);
    const read = await readPersonDays(tx, { date, timezone, academicYearId: year?.id ?? null, withPeriods: true });
    const context = await this.rankContext(tx, user, schoolId, [...lessons.values()], date, year, read.employments);
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
        return {
          score: candidate.score,
          reasons: candidate.reasons,
          week: candidate.counter.weekLessons,
          tier: poolTier(candidate.kind, context.poolPreference),
        };
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
    // Judged in NIOARIG, as behörigheter are stated (grade-numbering.ts); the
    // reason still names the årskurser the lesson's year uses (`span`).
    const qualification = strongestOn(
      context.qualifications,
      userId,
      lesson.subjectId,
      toNioarigSpan(span, context.year?.gradeNumbering ?? 'NIOARIG'),
      dayDate(lesson.date),
    );
    const groups = new Set([lesson.studentGroupId, ...lesson.extraGroupIds]);
    const theirs = context.requirements.filter((row) => row.teacherId === userId || row.coTeacherId === userId);
    const lessonMinutes = Math.round((lesson.endsAt.getTime() - lesson.startsAt.getTime()) / 60_000);
    const dayLessons = [...day.lessons, ...picked].filter(
      (row) => holdsTime(row) && row.date === lesson.date && row.id !== lesson.id,
    );
    // Their own lesson then, cancelled: free and in the building — unless
    // it was cancelled for an activity, which they may be out with.
    const cancelledThen = day.lessons.filter(
      (row) => row.status === 'CANCELLED' && row.date === lesson.date && overlaps(row, target),
    );
    const released = cancelledThen.find((row) => row.cancelCause !== 'EVENT');
    const atEvent = cancelledThen.find((row) => row.cancelCause === 'EVENT');
    // The post the lesson's week is judged by: a period in force then, else
    // the post itself (postOfWeek, the load report's own week rule). For a
    // reader who may not see how a post changes, a changing post's year
    // target instead, as the load report states it: the period of the week
    // would give back when the post changes and its level then. (A post is
    // read only with its year, so every post with a period in force is in
    // yearTargets.)
    const post = read.employments.get(userId) ?? null;
    const employment = post ? postOfWeek(post, lesson.date, context.year) : null;
    const target_ = context.yearTargets?.has(userId)
      ? context.yearTargets.get(userId)!
      : targetMinutesPerWeek(employment, loadPolicyOf(context.policy));
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
      eventGroup: atEvent ? (context.groupName.get(atEvent.studentGroupId) ?? '') : null,
      counter: { week: weekLessons, term: termLessons },
      load: { weekMinutes, target: target_, tolerancePercent: context.policy.overAllocationTolerancePercent },
      poolPreference: context.poolPreference,
      prefersFree: prefersFree(day, target),
      wishesFreeDay: day.preferredFreeDay === isoWeekday(lesson.date),
      // The walks the cover leaves too little time for, between the lesson
      // and the candidate's own before and after it that day (a pick of the
      // day's proposal among them). A reason, never a filter.
      travel: travelBreaches(context.sites, placed(target), dayLessons.map(placed)).map((breach) => ({
        from: context.sites.nameOf.get(breach.walk.fromSite) ?? '',
        to: context.sites.nameOf.get(breach.walk.toSite) ?? '',
        minutes: breach.walk.minutes,
        gap: breach.gap,
      })),
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
    employments: ReadonlyMap<string, LoadEmployment>,
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
    // The class's mentor ON THE DAY: a mentorship that ends at the jullov
    // names nobody in March (duty-dates.ts).
    const mentors = year
      ? ((await tx.teacherDuty.findMany({
          where: { academicYearId: year.id, kind: 'MENTORSKAP', studentGroupId: { in: groupIds } },
          select: { userId: true, studentGroupId: true, validFrom: true, validTo: true },
        })) ?? [])
          .filter((duty) =>
            dutyRunsOn({ validFrom: dayOf(duty.validFrom ?? null), validTo: dayOf(duty.validTo ?? null) }, date),
          )
          .map((duty) => ({ userId: duty.userId, studentGroupId: duty.studentGroupId }))
      : [];
    const policy = await tx.staffingPolicy.findUnique({
      where: { schoolId },
      select: { fullTimeTeachingMinutesPerWeek: true, overAllocationTolerancePercent: true },
    });
    const shownPolicy = {
      fullTimeTeachingMinutesPerWeek: policy?.fullTimeTeachingMinutesPerWeek ?? null,
      overAllocationTolerancePercent: policy?.overAllocationTolerancePercent ?? 10,
    };
    const yearTargets = readsHr(user) ? null : await readYearTargets(tx, year, employments, loadPolicyOf(shownPolicy));
    const settings = await tx.coverSettings.findUnique({ where: { schoolId }, select: { poolPreference: true } });
    const counter = await readCounter(tx, date, year, this.cover.now());
    const weekMinutes = await readWeekMinutes(tx, date);
    const sites = await readSiteMap(tx, schoolId);
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
      policy: shownPolicy,
      poolPreference: settings?.poolPreference ?? 'NEUTRAL',
      counter,
      weekMinutes,
      subjectName: new Map((subjects ?? []).map((row) => [row.id, row.name])),
      groupName: new Map([...(groups ?? []), ...(releasedGroups ?? [])].map((row) => [row.id, row.name])),
      yearTargets,
      sites,
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
          roomId: true,
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
      roomId: row.roomId ?? null,
    }));
  }

  /** The läsår of a class, with its flags (for the roster basis) and its dates (for the term). */
  private async yearOf(tx: PrismaClient, studentGroupId: string): Promise<YearInfo | null> {
    const year = await tx.academicYear.findFirst({
      where: { studentGroups: { some: { id: studentGroupId } } },
      select: { id: true, isActive: true, predecessorId: true, startDate: true, endDate: true, gradeNumbering: true },
    });
    return year
      ? {
          id: year.id,
          isActive: year.isActive,
          predecessorId: year.predecessorId,
          startDate: asDay(year.startDate),
          endDate: asDay(year.endDate),
          gradeNumbering: year.gradeNumbering ?? 'NIOARIG',
        }
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
    roomId: lesson.roomId,
  };
}

function pickOf(target: CoverTarget): PersonLesson {
  return {
    id: target.id,
    date: target.date,
    start: target.start,
    end: target.end,
    status: 'SCHEDULED',
    studentGroupId: '',
    subjectId: '',
    roomId: target.roomId ?? null,
  };
}

/** A lesson on the day as the walk between sites reads it: whole minutes (site-travel.ts). */
const placed = (row: { id: string; start: number; end: number; roomId?: string | null }): PlacedLesson => ({
  id: row.id,
  start: Math.round(row.start / 60_000),
  end: Math.round(row.end / 60_000),
  roomId: row.roomId ?? null,
});

function proposalStale(lessonId?: string): ConflictException {
  return new ConflictException({
    message: 'Dagen har ändrats sedan förslaget gjordes. Gör ett nytt förslag.',
    code: COVER_PROPOSAL_STALE,
    ...(lessonId ? { params: { lessonId } } : {}),
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

/**
 * The open pairs a proposal covers, one decision each — less one case: a
 * substitute who is themself away (their own pair is OPEN) beside the stale
 * SUBSTITUTE decision of the absence they were covering. Covering their pair
 * replaces their row and moves that decision on to the new person
 * (recordAssignment), so the stale pair is covered by the same assignment;
 * proposing it as well would put a second vikarie on the lesson, or meet
 * COVER_STALE once the first item has covered it.
 */
export function coveredTogether<T extends { lessonId: string; absentTeacherId: string; decision: string | null; decisionStale: boolean; teachers: { teacherId: string; role: string }[] }>(
  open: readonly T[],
): T[] {
  return open.filter(
    (item) =>
      !(
        item.decisionStale &&
        item.decision === 'SUBSTITUTE' &&
        open.some(
          (other) =>
            other !== item &&
            other.lessonId === item.lessonId &&
            item.teachers.some((t) => t.teacherId === other.absentTeacherId && t.role === 'SUBSTITUTE'),
        )
      ),
  );
}

/** The load policy a candidate's target is read with: the school's two figures, the rest as the ranking has always read them. */
function loadPolicyOf(policy: RankContext['policy']): LoadPolicy {
  return {
    fullTimeTeachingMinutesPerWeek: policy.fullTimeTeachingMinutesPerWeek,
    overAllocationTolerancePercent: policy.overAllocationTolerancePercent,
    fullTimeRegulatedHoursPerYear: 1360,
    workDaysPerYear: 194,
    qualificationMode: 'WARN',
  };
}

/**
 * The year's target of each post that changes during the year, as the load
 * report states it (yearTargetMinutesPerWeek, its stretches weighted by
 * their teaching weeks over the year's breaks): what a reader without
 * HR-läs is told and judged by. No statement when no post changes.
 */
async function readYearTargets(
  tx: PrismaClient,
  year: YearInfo | null,
  employments: ReadonlyMap<string, LoadEmployment>,
  policy: LoadPolicy,
): Promise<Map<string, number | null>> {
  const targets = new Map<string, number | null>();
  if (!year) return targets;
  const bounds = { startDate: year.startDate, endDate: year.endDate };
  const changing = [...employments].filter(([, post]) => changesDuringYear(post, bounds));
  if (changing.length === 0) return targets;
  const breaks =
    (await tx.schoolBreak.findMany({
      where: { academicYearId: year.id },
      select: { startDate: true, endDate: true, minGradeLevel: true, maxGradeLevel: true },
    })) ?? [];
  const input = {
    year: bounds,
    closures: breaks.map((row) => ({
      startDate: asDay(row.startDate),
      endDate: asDay(row.endDate),
      minGradeLevel: row.minGradeLevel,
      maxGradeLevel: row.maxGradeLevel,
    })),
    requirements: [],
    duties: [],
    policy,
  };
  for (const [userId, post] of changing) targets.set(userId, yearTargetMinutesPerWeek(input, post));
  return targets;
}
