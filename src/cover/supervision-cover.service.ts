import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { recordRead } from '../access-log/access-log';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { isoWeekday } from '../calendar/publish-days';
import { toNioarig, type GradeNumbering } from '../common/grade-numbering';
import { readSiteMap, travelBreaches, type PlacedLesson, type SiteMap } from '../common/site-travel';
import { requireSchoolId } from '../common/utils/request-context';
import { PrismaService } from '../database/prisma.service';
import { gradesParam } from '../staffing/staffing-checks';
import { readsHr } from '../staffing/hr-visibility';
import { spansMeet } from '../supervision/pass-days';
import { asDay, dayDate, isoWeekOf, readCounter, readPersonDays, schoolTimezone, termOf } from './cover-context';
import { lockTeachers, SUBSTITUTE_IS_ABSENT } from './cover-decisions';
import { compareRanked, poolTier, type RankReason } from './cover-rank';
import {
  hardFindings,
  holdsTime,
  maskFindings,
  maskWarnings,
  overlaps,
  passTargetId,
  prefersFree,
  softWarnings,
  type CoverTarget,
  type CoverWarningCode,
  type PersonDay,
  type RuleFinding,
} from './cover-rules';
import { CoverService, COVER_NO_DECISION, COVER_STALE, emptyEffects, type CoverEffects } from './cover.service';
import { rankPassCandidate } from './pass-rank';
import { lockShiftForShare, readCover, readPassOccurrence, vikarieAwayOver, type CoverRow, type PassOccurrence } from './supervision-cover-reads';
import type { PassDecisionDto } from './dto/cover.dto';

export const SUPERVISION_COVER_NOT_AFFECTED = 'SUPERVISION_COVER_NOT_AFFECTED';
export const SUPERVISION_COVER_HELD = 'SUPERVISION_COVER_HELD';
export const SUPERVISION_SUBSTITUTE_REQUIRED = 'SUPERVISION_SUBSTITUTE_REQUIRED';
export const SUPERVISION_SUBSTITUTE_NOT_TEACHER = 'SUPERVISION_SUBSTITUTE_NOT_TEACHER';
export const SUPERVISION_SUBSTITUTE_BUSY = 'SUPERVISION_SUBSTITUTE_BUSY';

export interface PassCandidate {
  userId: string;
  kind: 'STAFF' | 'POOL';
  score: number;
  reasons: RankReason[];
  /** Lessons and passes covered, this ISO week and this term. */
  counter: { weekLessons: number; termLessons: number; weekPasses: number; termPasses: number };
}

export interface PassCandidatesResponse {
  shiftId: string;
  date: string;
  candidates: PassCandidate[];
  /** Who was left out and by which hard rule; ABSENT says only that they are away. */
  excluded: { userId: string; codes: RuleFinding[] }[];
}

export interface PassWarning {
  code: CoverWarningCode;
  params: Record<string, string | number>;
}

/** One pair, read inside a write's transaction after its locks. */
interface PassState {
  occurrence: PassOccurrence;
  absence: { id: string; userId: string; startsAt: Date; endsAt: Date };
  cover: CoverRow | null;
  /** The occurrence's span: the pass's on the date, or the one its decision stored. */
  span: { startsAt: Date; endsAt: Date };
  status: 'OPEN' | 'COVERED' | 'HANDLED';
}

/**
 * THE BOARD'S RASTVAKTSPASS (Rastvakt i vardagen, 20261210090000): the
 * candidates for a pass whose teacher is away, and the decisions on it —
 * a vikarie takes it, it is left without one, ångra — one at a time, all
 * Drift's (the controller's @Area). The pairs are read with the board
 * (supervision-cover-reads.ts, CoverService.board).
 *
 * Every write:
 *   1. takes the per-teacher cover lock of the absent teacher and the
 *      vikarie (cover-decisions.ts lockTeachers, the lock every lesson
 *      decision and absence write takes): an absence edited beside it, a
 *      lesson given to the same vikarie at the same minute and a second
 *      decision on the pass all wait, and the clash checks below read what
 *      they committed;
 *   2. then the pass row FOR SHARE, which an edit of the pass takes FOR
 *      UPDATE before it asks for decisions (SupervisionService): the pass
 *      cannot move under a decision, nor a decision land beside an edit;
 *   3. reads the pair again and checks it is on the board (404), not passed
 *      (409 SUPERVISION_COVER_HELD) and still what the admin saw (409
 *      COVER_STALE);
 *   4. and AFTER the commit tells the vikarier (supervision-notices.ts) and
 *      the admins' boards (CoverService.afterCommit).
 *
 * Nothing here reads or answers a reason, and no answer names who is away
 * beyond the ids the board has already shown.
 */
@Injectable()
export class SupervisionCoverService {
  private readonly logger = new Logger(SupervisionCoverService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cover: CoverService,
  ) {}

  async candidates(shiftId: string, date: string, user: AuthenticatedUser): Promise<PassCandidatesResponse> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const timezone = await schoolTimezone(tx, schoolId);
      const occurrence = await readPassOccurrence(tx, shiftId, date, timezone);
      // A pass that no longer runs that day (a lov added since the booking,
      // its teacher deactivated) needs nobody: the board offers Ångra alone.
      if (!occurrence?.runs) throw notAffected();
      const { shift, area, year } = occurrence;
      const read = await readPersonDays(tx, { date, timezone, academicYearId: shift.academicYearId });
      const target = targetOf(occurrence, date);
      const showsHr = readsHr(user);

      const candidates: PassCandidate[] = [];
      const excluded: PassCandidatesResponse['excluded'] = [];
      const feasible: [string, PersonDay][] = [];
      const outOfDays: string[] = [];
      for (const [userId, day] of [...read.days].sort(([a], [b]) => a.localeCompare(b))) {
        const findings = hardFindings(day, target);
        if (findings.length > 0) {
          excluded.push({ userId, codes: maskFindings(findings, showsHr) });
          if (findings.some((finding) => finding.code === 'WORK_DAYS')) outOfDays.push(userId);
          continue;
        }
        feasible.push([userId, day]);
      }

      const now = this.cover.now();
      const yearBounds = { startDate: year.startDate, endDate: year.endDate };
      const counter = await readCounter(tx, date, yearBounds, now);
      const passCounter = await readPassCounter(tx, date, yearBounds);
      const settings = await tx.coverSettings.findUnique({ where: { schoolId }, select: { poolPreference: true } });
      const poolPreference = settings?.poolPreference ?? 'NEUTRAL';
      const sites = withAreaSite(await readSiteMap(tx, schoolId), shift.areaId, area.siteId);
      const ids = feasible.map(([userId]) => userId);
      const knows = await readKnowsArea(tx, shift.areaId, shift.academicYearId, ids);
      const stage = await readTeachesStage(tx, shift.academicYearId, year.gradeNumbering, area, ids);
      const groupName = await readReleasedGroups(tx, feasible.map(([, day]) => day), target);
      const passMinutes = Math.round((target.end - target.start) / 60_000);

      for (const [userId, day] of feasible) {
        const lessons = day.lessons.filter((row) => holdsTime(row) && row.date === date);
        const passes = (day.supervision ?? []).filter((pass) => pass.date === date && pass.id !== target.id);
        const cancelledThen = day.lessons.filter((row) => row.status === 'CANCELLED' && row.date === date && overlaps(row, target));
        const released = cancelledThen.find((row) => row.cancelCause !== 'EVENT');
        const atEvent = cancelledThen.find((row) => row.cancelCause === 'EVENT');
        const kind: 'STAFF' | 'POOL' = day.pool.member && !day.pool.hasEmployment ? 'POOL' : 'STAFF';
        const lessonCount = counter.get(userId);
        const passCount = passCounter.get(userId);
        const count = {
          weekLessons: lessonCount?.weekLessons ?? 0,
          termLessons: lessonCount?.termLessons ?? 0,
          weekPasses: passCount?.week ?? 0,
          termPasses: passCount?.term ?? 0,
        };
        const ranked = rankPassCandidate({
          userId,
          kind,
          pass: { start: target.start, end: target.end, minutes: passMinutes },
          dayLessons: [...lessons, ...passes],
          releasedGroup: released ? (groupName.get(released.studentGroupId) ?? '') : null,
          eventGroup: atEvent ? (groupName.get(atEvent.studentGroupId) ?? '') : null,
          counter: { week: count.weekLessons + count.weekPasses, term: count.termLessons + count.termPasses },
          poolPreference,
          prefersFree: prefersFree(day, target),
          wishesFreeDay: day.preferredFreeDay === isoWeekday(date),
          // The walks the pass leaves too little time for, between the area's
          // skolområde and the candidate's lessons before and after it.
          travel: travelBreaches(sites, placed({ id: target.id, start: target.start, end: target.end, roomId: areaRoom(shift.areaId) }), lessons.map(placed)).map(
            (breach) => ({
              from: sites.nameOf.get(breach.walk.fromSite) ?? '',
              to: sites.nameOf.get(breach.walk.toSite) ?? '',
              minutes: breach.walk.minutes,
              gap: breach.gap,
            }),
          ),
          knowsArea: knows.has(userId) ? area.name : null,
          teachesStage: stage.teachers.has(userId) ? stage.grades : null,
        });
        candidates.push({ userId, kind, score: ranked.score, reasons: ranked.reasons, counter: count });
      }
      const order = (candidate: PassCandidate) => ({
        ...candidate,
        tier: poolTier(candidate.kind, poolPreference),
        counter: { week: candidate.counter.weekLessons + candidate.counter.weekPasses },
      });
      candidates.sort((a, b) => compareRanked(order(a), order(b)));
      // As the lessons' candidates record them: each candidate's cover
      // counter and whom their post's deltid in days leaves out (EMPLOYMENT),
      // and who is left out as away (STAFF_ABSENCES, the code alone).
      await recordRead(tx, 'EMPLOYMENT', [...candidates.map((candidate) => candidate.userId), ...outOfDays], user.channel);
      await recordRead(
        tx,
        'STAFF_ABSENCES',
        excluded.filter((entry) => entry.codes.some((finding) => finding.code === 'ABSENT')).map((entry) => entry.userId),
        user.channel,
      );
      return { shiftId, date, candidates, excluded };
    });
  }

  async decide(
    shiftId: string,
    date: string,
    dto: PassDecisionDto,
    user: AuthenticatedUser,
  ): Promise<{ shiftId: string; date: string; warnings: PassWarning[] }> {
    if (dto.kind === 'SUBSTITUTE' && !dto.substituteId) {
      throw new BadRequestException({ message: 'substituteId: vem som tar passet.', code: SUPERVISION_SUBSTITUTE_REQUIRED });
    }
    if (dto.kind === 'NO_COVER' && dto.substituteId !== undefined) {
      throw new BadRequestException({ message: 'substituteId hör bara till SUBSTITUTE.', code: SUPERVISION_SUBSTITUTE_REQUIRED });
    }
    const schoolId = requireSchoolId(user);
    const warnings: PassWarning[] = [];
    const effects = await this.cover.write(user, async (tx) => {
      const timezone = await schoolTimezone(tx, schoolId);
      const state = await this.lockedPair(tx, shiftId, date, timezone, dto.absenceId, dto.substituteId ?? null);
      // A decision left on a day the pass no longer runs is undone, never
      // replaced: nobody is needed there (supervision-board.ts `runs`).
      if (!state.occurrence.runs) throw notAffected();
      const now = this.cover.now();
      if (state.span.endsAt.getTime() <= now.getTime()) throw held();
      if (state.status !== 'OPEN' || dto.expected !== 'OPEN') throw stale(state.status);
      const effects: CoverEffects = { ...emptyEffects(), dates: [date] };
      const { occurrence, absence, cover } = state;
      const snapshot = { shiftId, date, areaId: cover?.areaId ?? occurrence.shift.areaId, startsAt: state.span.startsAt, endsAt: state.span.endsAt };

      if (dto.kind === 'SUBSTITUTE') {
        const substituteId = dto.substituteId!;
        if (substituteId === occurrence.shift.userId) {
          throw new ConflictException({ message: 'Läraren är själv frånvarande då.', code: SUBSTITUTE_IS_ABSENT });
        }
        warnings.push(...(await this.checkVikarie(tx, user, occurrence, state.span, date, timezone, substituteId)));
      }
      // A stale decision's vikarie (away, or gone) is told the pass is off.
      if (cover?.decision === 'SUBSTITUTE' && cover.substituteId && cover.substituteId !== dto.substituteId) {
        effects.passNotices.push({ kind: 'WITHDRAWN', userId: cover.substituteId, ...snapshot });
      }
      const fields = {
        decision: dto.kind,
        substituteId: dto.kind === 'SUBSTITUTE' ? dto.substituteId! : null,
        decidedByUserId: user.userId ?? null,
        decidedAt: new Date(),
      };
      if (cover) {
        await tx.supervisionCover.update({ where: { id: cover.id }, data: fields });
      } else {
        await tx.supervisionCover.create({
          data: {
            schoolId,
            shiftId,
            date: dayDate(date),
            areaId: snapshot.areaId,
            startsAt: snapshot.startsAt,
            endsAt: snapshot.endsAt,
            absenceId: absence.id,
            absentTeacherId: absence.userId,
            ...fields,
          },
        });
      }
      if (dto.kind === 'SUBSTITUTE') effects.passNotices.push({ kind: 'COVER', userId: dto.substituteId!, ...snapshot });
      return effects;
    });
    await this.cover.afterCommit(user, effects);
    this.logger.log(`Pass decided [shift=${shiftId}, date=${date}, kind=${dto.kind}]`);
    return { shiftId, date, warnings };
  }

  async undo(shiftId: string, date: string, user: AuthenticatedUser): Promise<{ shiftId: string; date: string }> {
    requireSchoolId(user);
    const effects = await this.cover.write(user, async (tx) => {
      const head = await tx.supervisionShift.findUnique({ where: { id: shiftId }, select: { userId: true } });
      if (!head) throw noDecision();
      await lockTeachers(tx, [head.userId]);
      await lockShiftForShare(tx, shiftId);
      const cover = await readCover(tx, shiftId, date);
      if (!cover) throw noDecision();
      // Whatever its absence's state: a withdrawal settles its decisions in
      // its own transaction, so one still standing on a withdrawn absence was
      // left by an API from before this release (a rollback, or old and new
      // containers side by side), and the board shows it for exactly this.
      if (cover.endsAt.getTime() <= this.cover.now().getTime()) throw held();
      return undoCover(tx, cover);
    });
    await this.cover.afterCommit(user, effects);
    this.logger.log(`Pass undone [shift=${shiftId}, date=${date}]`);
    return { shiftId, date };
  }

  // ---------------------------------------------------------------------

  /**
   * The pair under its locks: the absent teacher and the vikarie (sorted),
   * then the pass FOR SHARE, then everything read again. The teacher read
   * before the locks must still be the pass's, or the locks were the wrong
   * ones: COVER_STALE.
   */
  private async lockedPair(
    tx: PrismaClient,
    shiftId: string,
    date: string,
    timezone: string,
    absenceId: string,
    substituteId: string | null,
  ): Promise<PassState> {
    const head = await tx.supervisionShift.findUnique({ where: { id: shiftId }, select: { userId: true } });
    if (!head) throw notAffected();
    await lockTeachers(tx, [head.userId, ...(substituteId ? [substituteId] : [])]);
    await lockShiftForShare(tx, shiftId);
    const occurrence = await readPassOccurrence(tx, shiftId, date, timezone);
    if (!occurrence) throw notAffected();
    if (occurrence.shift.userId !== head.userId) throw stale('OPEN');
    const absence = await tx.teacherAbsence.findUnique({
      where: { id: absenceId },
      // The period only; never the reason.
      select: { id: true, userId: true, startsAt: true, endsAt: true, status: true },
    });
    if (!absence || absence.status !== 'ACTIVE' || absence.userId !== occurrence.shift.userId) throw notAffected();
    const cover = await readCover(tx, shiftId, date);
    const live = occurrence.runs && spansMeet(occurrence.span, absence);
    if (!live && cover?.absenceId !== absence.id) throw notAffected();
    const span = live ? occurrence.span : { startsAt: cover!.startsAt, endsAt: cover!.endsAt };
    let status: PassState['status'] = 'OPEN';
    if (cover?.decision === 'NO_COVER') status = 'HANDLED';
    if (cover?.decision === 'SUBSTITUTE' && cover.substituteId && !(await vikarieAwayOver(tx, cover.substituteId, span))) {
      status = 'COVERED';
    }
    return { occurrence, absence, cover, span, status };
  }

  /**
   * A vikarie picked by hand: refused when they cannot be there — not an
   * active teacher, away, teaching, or on another pass then — and warned
   * about the rules a rektor may override, as a lesson's pick is
   * (cover-rules.ts softWarnings), with the walk between sites.
   */
  private async checkVikarie(
    tx: PrismaClient,
    user: AuthenticatedUser,
    occurrence: PassOccurrence,
    span: { startsAt: Date; endsAt: Date },
    date: string,
    timezone: string,
    substituteId: string,
  ): Promise<PassWarning[]> {
    const read = await readPersonDays(tx, {
      date,
      timezone,
      academicYearId: occurrence.shift.academicYearId,
      userIds: [substituteId],
    });
    const day = read.days.get(substituteId);
    const target = targetOf(occurrence, date, span);
    const findings = day ? hardFindings(day, target) : [{ code: 'INACTIVE' as const, params: {} }];
    const codes = new Set(findings.map((finding) => finding.code));
    if (codes.has('INACTIVE')) {
      throw new ConflictException({ message: 'Vikarien är inte en aktiv lärare.', code: SUPERVISION_SUBSTITUTE_NOT_TEACHER });
    }
    if (codes.has('ABSENT')) {
      throw new ConflictException({ message: 'Vikarien är själv frånvarande då.', code: SUBSTITUTE_IS_ABSENT });
    }
    if (codes.has('BUSY_LESSON') || codes.has('BUSY_SUPERVISION')) {
      throw new ConflictException({
        message: 'Vikarien har en lektion eller ett annat rastvaktspass då och kan inte ta passet.',
        code: SUPERVISION_SUBSTITUTE_BUSY,
      });
    }
    if (findings.some((finding) => finding.code === 'WORK_DAYS')) {
      await recordRead(tx, 'EMPLOYMENT', [substituteId], user.channel);
    }
    const warnings: PassWarning[] = maskWarnings(softWarnings(findings), readsHr(user));
    const sites = withAreaSite(await readSiteMap(tx, requireSchoolId(user)), occurrence.shift.areaId, occurrence.area.siteId);
    const lessons = day!.lessons.filter((row) => holdsTime(row) && row.date === date).map(placed);
    for (const breach of travelBreaches(sites, placed({ id: target.id, start: target.start, end: target.end, roomId: areaRoom(occurrence.shift.areaId) }), lessons)) {
      warnings.push({
        code: 'COVER_TRAVEL_TIME_SHORT',
        params: {
          from: sites.nameOf.get(breach.walk.fromSite) ?? '',
          to: sites.nameOf.get(breach.walk.toSite) ?? '',
          minutes: breach.walk.minutes,
          gap: breach.gap,
        },
      });
    }
    return warnings;
  }
}

/** A decision removed, its vikarie told the pass is off. */
export async function undoCover(tx: PrismaClient, cover: CoverRow): Promise<CoverEffects> {
  const effects: CoverEffects = { ...emptyEffects(), dates: [cover.date] };
  await tx.supervisionCover.delete({ where: { id: cover.id } });
  if (cover.decision === 'SUBSTITUTE' && cover.substituteId) {
    effects.passNotices.push({
      kind: 'WITHDRAWN',
      userId: cover.substituteId,
      shiftId: cover.shiftId,
      date: cover.date,
      areaId: cover.areaId,
      startsAt: cover.startsAt,
      endsAt: cover.endsAt,
    });
  }
  return effects;
}

/**
 * The pass on its date as a cover target: no cap (cover-rules.ts), and its
 * time the pair's (the time a standing decision stored, when the absence no
 * longer reaches the pass). Nobody is "on" a pass as a teacher is on a
 * lesson: its own teacher is left out as ABSENT, and refused by name.
 */
function targetOf(occurrence: PassOccurrence, date: string, span?: { startsAt: Date; endsAt: Date }): CoverTarget {
  const when = span ?? occurrence.span;
  return {
    id: passTargetId(occurrence.shift.id, date),
    date,
    start: when.startsAt.getTime(),
    end: when.endsAt.getTime(),
    teacherIds: [],
    kind: 'PASS',
  };
}

/** The area as a "room" of the walk between sites: a pass is held on its area's skolområde. */
const areaRoom = (areaId: string) => `area:${areaId}`;

function withAreaSite(map: SiteMap, areaId: string, siteId: string | null): SiteMap {
  if (!siteId) return map;
  return { ...map, siteOfRoom: new Map([...map.siteOfRoom, [areaRoom(areaId), siteId]]) };
}

/** A span of the day as the walk between sites reads it: whole minutes (site-travel.ts). */
const placed = (row: { id: string; start: number; end: number; roomId?: string | null }): PlacedLesson => ({
  id: row.id,
  start: Math.round(row.start / 60_000),
  end: Math.round(row.end / 60_000),
  roomId: row.roomId ?? null,
});

/** Passes each person has taken as vikarie, in the date's ISO week and term. */
async function readPassCounter(
  tx: PrismaClient,
  date: string,
  year: { startDate: string; endDate: string },
): Promise<Map<string, { week: number; term: number }>> {
  const term = termOf(date, year);
  const week = isoWeekOf(date);
  const from = week.from < term.from ? week.from : term.from;
  const to = week.to > term.to ? week.to : term.to;
  const rows =
    (await tx.supervisionCover.findMany({
      where: { decision: 'SUBSTITUTE', date: { gte: dayDate(from), lte: dayDate(to) } },
      select: { substituteId: true, date: true },
    })) ?? [];
  const counter = new Map<string, { week: number; term: number }>();
  for (const row of rows) {
    if (!row.substituteId) continue;
    const day = asDay(row.date);
    const entry = counter.get(row.substituteId) ?? { week: 0, term: 0 };
    if (day >= week.from && day <= week.to) entry.week += 1;
    if (day >= term.from && day <= term.to) entry.term += 1;
    counter.set(row.substituteId, entry);
  }
  return counter;
}

/** Of these people, those with a pass of their own in the area this läsår. */
async function readKnowsArea(tx: PrismaClient, areaId: string, academicYearId: string, userIds: readonly string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows =
    (await tx.supervisionShift.findMany({
      where: { areaId, academicYearId, userId: { in: [...userIds] } },
      select: { userId: true },
    })) ?? [];
  return new Set(rows.map((row) => row.userId));
}

/**
 * Of these people, those who teach a class in the area's årskurser this
 * läsår (its timplansposter, the class's year read in NIOARIG). Nothing for
 * an area of every stage: there the term would reward everybody.
 */
async function readTeachesStage(
  tx: PrismaClient,
  academicYearId: string,
  numbering: GradeNumbering,
  area: { minGradeLevel: number | null; maxGradeLevel: number | null },
  userIds: readonly string[],
): Promise<{ teachers: Set<string>; grades: string | null }> {
  if (userIds.length === 0 || area.minGradeLevel === null || area.maxGradeLevel === null) {
    return { teachers: new Set(), grades: null };
  }
  const rows =
    (await tx.teachingRequirement.findMany({
      where: {
        academicYearId,
        OR: [{ teacherId: { in: [...userIds] } }, { coTeacherId: { in: [...userIds] } }],
        studentGroup: { gradeLevel: { not: null } },
      },
      select: { teacherId: true, coTeacherId: true, studentGroup: { select: { gradeLevel: true } } },
    })) ?? [];
  const teachers = new Set<string>();
  for (const row of rows) {
    const grade = toNioarig(row.studentGroup?.gradeLevel ?? null, numbering);
    if (grade === null || grade < area.minGradeLevel || grade > area.maxGradeLevel) continue;
    for (const id of [row.teacherId, row.coTeacherId]) if (id && userIds.includes(id)) teachers.add(id);
  }
  return { teachers, grades: gradesParam({ min: area.minGradeLevel, max: area.maxGradeLevel }) };
}

/** The names of the classes whose lesson at the pass's time is cancelled for a candidate. */
async function readReleasedGroups(tx: PrismaClient, days: readonly PersonDay[], target: CoverTarget): Promise<Map<string, string>> {
  const ids = [
    ...new Set(
      days.flatMap((day) =>
        day.lessons.filter((row) => row.status === 'CANCELLED' && row.date === target.date && overlaps(row, target)).map((row) => row.studentGroupId),
      ),
    ),
  ];
  if (ids.length === 0) return new Map();
  const groups = (await tx.studentGroup.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })) ?? [];
  return new Map(groups.map((group) => [group.id, group.name]));
}

function notAffected(): NotFoundException {
  return new NotFoundException({ message: 'Passet berörs inte av frånvaron.', code: SUPERVISION_COVER_NOT_AFFECTED });
}

function noDecision(): NotFoundException {
  return new NotFoundException({ message: 'Det finns inget beslut att ångra för passet.', code: COVER_NO_DECISION });
}

function held(): ConflictException {
  return new ConflictException({ message: 'Passet har redan gått och ändras inte.', code: SUPERVISION_COVER_HELD });
}

function stale(current: string): ConflictException {
  return new ConflictException({
    message: 'Passet har ändrats sedan tavlan lästes. Läs om tavlan.',
    code: COVER_STALE,
    params: { current },
  });
}
