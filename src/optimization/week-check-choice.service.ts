import { randomUUID } from 'node:crypto';
import { HttpException, HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { fromNioarig, type GradeNumbering } from '../common/grade-numbering';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import type { LoadQualification } from '../staffing/teacher-load';
import type {
  AiEngineScheduleRequest,
  AnonymousRequirement,
} from './interfaces/ai-engine-payload.interface';
import type { AiEngineWeekCheckResponse } from './interfaces/week-check.interface';
import type {
  ChoiceCount,
  ChoiceWhatIf,
  ChoiceYear,
  WeekCheckChoiceView,
} from './interfaces/week-check-choice.interface';
import { OptimizationProxyService, type AnonMaps } from './optimization-proxy.service';
import {
  MAX_WHAT_IFS,
  MAX_YEARS,
  candidatesOf,
  countOf,
  holdersOf,
  judgedDay,
  optionsFor,
  qualifiedHolders,
  rankable,
  rankingFigure,
  releasePosts,
  shareWithSecond,
  spanOf,
  type RealisedAnswer,
} from './week-check-choice';
import { WEEK_CHECK_PATH, WEEK_CHECK_TIMEOUT_MS, engineLacksWeekCheck } from './week-check.service';
import type { PeriodStretch } from './year-periods';

/**
 * The whole analysis's wait, from the request: the baseline, the floor and up
 * to MAX_WHAT_IFS what-ifs, each a /check-week of up to the week load's four
 * seconds (WEEK_LOAD_SECONDS). Under the engine's own ceiling for one check
 * (WEEK_CHECK_TIMEOUT_MS) because no step is begun that would not be done by
 * then, and the web's wait (web/lib/week-check-choice.ts) is a little over it.
 * It is the one thing here that is not per call: a school with a heavy year
 * gets the floor and the first what-ifs, and is told how many were not asked.
 */
export const WEEK_CHECK_CHOICE_BUDGET_MS = 24_000;

/** The least time left that another check is begun in: its four seconds and the payload's own checks around them. */
export const WEEK_CHECK_CHOICE_MIN_CALL_MS = 6_000;

/** One behörighet as the reader hands it on: the dates already days. */
type Qualification = LoadQualification;

/** What the transaction reads, so that no engine call is made inside it (as Generera's is not). */
interface Read {
  ready: boolean;
  payload?: AiEngineScheduleRequest;
  anonMaps?: AnonMaps;
  stretches: PeriodStretch[][] | null;
  numbering: GradeNumbering;
  /** Anonymous post id -> the real subject's id. */
  subjectOf: Map<string, string>;
  /** Anonymous post id -> the real id of the teacher who leads it today (null: nobody). */
  leaderOf: Map<string, string | null>;
  subjectNames: Map<string, string>;
  qualifications: Qualification[];
  /** The school has recorded a behörighet at all (the proposal's "recorded"). */
  recorded: boolean;
  /** The day behörigheter are judged on. */
  day: string;
}

const isoDay = (value: Date): string => value.toISOString().slice(0, 10);

/**
 * KONTROLLERA VECKAN, MED LÄRARVAL: what the week would be if teachers could
 * be chosen, asked of the engine's own check (see week-check-choice.ts for what
 * is asked and why every figure is a lower bound).
 *
 * ITS OWN ROUTE, NOT PART OF THE CHECK. The check answers in a few seconds and
 * is waited for by the Generera button; this makes up to twelve of them one
 * after the other, so it is asked for by name, after the check has answered,
 * and has a wait of its own (WEEK_CHECK_CHOICE_BUDGET_MS). The week is built by
 * Generera's own fetch, as the check builds it, and the engine is asked
 * nothing it does not know: no field is added and no route.
 *
 * WRITES NOTHING, holds nothing across an engine call, and names no person: the
 * teachers stay anonymous in the engine, and what leaves is subjects, years,
 * figures and the dates of a period.
 */
@Injectable()
export class WeekCheckChoiceService {
  private readonly logger = new Logger(WeekCheckChoiceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly proxy: OptimizationProxyService,
  ) {}

  async choice(academicYearId: string, user: AuthenticatedUser): Promise<WeekCheckChoiceView> {
    const requestId = randomUUID();
    const started = Date.now();
    const deadline = started + WEEK_CHECK_CHOICE_BUDGET_MS;
    this.logger.log(`Week check choice requested [requestId=${requestId}, academicYearId=${academicYearId}]`);

    const read = await this.read(academicYearId, user, requestId);
    const view = (overrides: Partial<WeekCheckChoiceView>): WeekCheckChoiceView => ({
      status: 'NOT_ASKED',
      years: [],
      qualificationsRecorded: read.recorded,
      releasedPosts: 0,
      notRun: 0,
      calls: 0,
      elapsedMs: Date.now() - started,
      ...overrides,
    });
    // A refusal of the gateway's own, or every post hand-placed: the check says so itself, and has nothing to relax.
    if (!read.ready || !read.payload || read.payload.requirements.length === 0 || !read.anonMaps) return view({});

    const payload = read.payload;
    const maps = read.anonMaps;
    let calls = 0;
    const ask = async (sent: AiEngineScheduleRequest, mandatory: boolean): Promise<AiEngineWeekCheckResponse | null> => {
      const remaining = deadline - Date.now();
      if (!mandatory && remaining < WEEK_CHECK_CHOICE_MIN_CALL_MS) return null;
      calls += 1;
      try {
        return await this.proxy.callAiEngine<AiEngineWeekCheckResponse>(WEEK_CHECK_PATH, sent, maps, {
          timeoutMs: Math.min(WEEK_CHECK_TIMEOUT_MS, Math.max(remaining, WEEK_CHECK_CHOICE_MIN_CALL_MS)),
        });
      } catch (error) {
        // The baseline is the question: its failure is the check's own (an older engine, a payload refusal, a 503).
        if (mandatory) {
          if (error instanceof HttpException && error.getStatus() === HttpStatus.NOT_FOUND) {
            this.logger.warn(`AI engine predates the week check; ${WEEK_CHECK_PATH} answered 404.`);
            throw engineLacksWeekCheck();
          }
          throw error;
        }
        this.logger.warn(
          `Week check choice: one check failed and is left out [requestId=${requestId}]: ${
            error instanceof HttpException ? error.getStatus() : 'error'
          }`,
        );
        return null;
      }
    };
    const understood = (response: AiEngineWeekCheckResponse | null): AiEngineWeekCheckResponse | null =>
      response && Array.isArray(response.years) && Array.isArray(response.skipped) ? response : null;

    // 1. The week as it stands, counted again so that every figure below compares with one made in this call.
    const baseline = understood(await ask(payload, true));
    if (!baseline) throw new HttpException({ message: 'The AI engine returned an error.' }, HttpStatus.BAD_GATEWAY);
    const tight = baseline.years
      .filter((year): year is typeof year & { year: number } => year.year !== null)
      .slice(0, MAX_YEARS);
    if (tight.length === 0) return view({ status: 'NO_TIGHT_YEAR', calls });
    const years = tight.map((row) => row.year);
    const countFor = (response: AiEngineWeekCheckResponse, year: number): ChoiceCount =>
      countOf(response, year, this.answerOf(response, maps), payload.requirements, read.stretches);

    const out: ChoiceYear[] = tight.map((row) => ({
      year: fromNioarig(row.year, read.numbering) ?? row.year,
      today: countFor(baseline, row.year),
      floor: null,
      whatIf: [],
    }));

    // 2. THE FLOOR: a teacher of their own on every post that has two or more qualified.
    const qualifiedOf = (requirement: AnonymousRequirement): number => {
      const subjectId = read.subjectOf.get(requirement.id);
      return subjectId === undefined ? 0 : qualifiedHolders(read.qualifications, subjectId, spanOf(requirement), read.day);
    };
    // What a post could be led by: the qualified teachers, and its lead today (optionsFor).
    const optionsOf = (requirement: AnonymousRequirement): number => {
      const subjectId = read.subjectOf.get(requirement.id);
      if (subjectId === undefined) return 0;
      return optionsFor(
        holdersOf(read.qualifications, subjectId, spanOf(requirement), read.day),
        read.leaderOf.get(requirement.id),
      );
    };
    let releasedPosts = 0;
    if (read.recorded) {
      const floor = releasePosts(payload, optionsOf);
      releasedPosts = floor.released.length;
      if (releasedPosts > 0) {
        const response = understood(await ask(floor.payload, false));
        years.forEach((year, index) => {
          out[index]!.floor = response ? countFor(response, year) : { kind: 'UNKNOWN' };
        });
      }
    }

    // 3. THE WHAT-IFS: one teacher's posts of a subject shared with a second teacher, heaviest first.
    const candidates = candidatesOf(payload.requirements, years, read.subjectOf, MAX_WHAT_IFS);
    let notRun = 0;
    for (const candidate of candidates) {
      const response = understood(await ask(shareWithSecond(payload, candidate), false));
      if (!response) {
        notRun += 1;
        continue;
      }
      const target = out[years.indexOf(candidate.year)]!;
      const post = payload.requirements.find((requirement) => requirement.id === candidate.postIds[0]);
      const count = countFor(response, candidate.year);
      const ranked = rankable(target.today, count);
      const whatIf: ChoiceWhatIf = {
        subject: read.subjectNames.get(candidate.subjectId) ?? '',
        qualified: post ? qualifiedOf(post) : 0,
        moved: candidate.moved.length,
        of: candidate.postIds.length,
        count,
        ranked,
      };
      target.whatIf.push(whatIf);
    }
    for (const year of out) year.whatIf = rankedWhatIfs(year.whatIf);

    this.logger.log(
      `Week check choice complete [requestId=${requestId}, years=${out.length}, released=${releasedPosts}, ` +
        `calls=${calls}, notRun=${notRun}, ms=${Date.now() - started}]`,
    );
    return view({ status: 'DONE', years: out, releasedPosts, notRun, calls });
  }

  /** The answer's rows and refusal, ids still anonymous where the period is inferred from them, and the summary realised. */
  private answerOf(response: AiEngineWeekCheckResponse, maps: AnonMaps): RealisedAnswer {
    const realised = this.proxy.realiseConflicts(response.conflicts, maps);
    return {
      details: (response.conflicts?.conflicts ?? []).map((detail) => ({
        code: detail.code,
        params: detail.params ?? {},
        requirementIds: detail.requirementIds ?? [],
      })),
      summary:
        realised && realised.summaryCode
          ? { code: realised.summaryCode, params: realised.summaryParams ?? {} }
          : null,
    };
  }

  /** The week as Generera would send it, and what the analysis needs beside it, read in one transaction. */
  private async read(academicYearId: string, user: AuthenticatedUser, requestId: string): Promise<Read> {
    return this.prisma.withRls(user, async (tx) => {
      const year = await tx.academicYear.findUnique({
        where: { id: academicYearId },
        select: { id: true, startDate: true, endDate: true, gradeNumbering: true },
      });
      if (!year) throw new NotFoundException('Academic year not found.');
      const numbering: GradeNumbering = year.gradeNumbering === 'TIOARIG' ? 'TIOARIG' : 'NIOARIG';
      const empty: Read = {
        ready: false,
        stretches: null,
        numbering,
        subjectOf: new Map(),
        leaderOf: new Map(),
        subjectNames: new Map(),
        qualifications: [],
        recorded: false,
        day: isoDay(year.startDate),
      };
      const prepared = await this.proxy.prepareSchedule(tx, academicYearId, user, { requestId });
      if (!prepared.ready) return empty;

      // The real subject of each post sent, through the anonymous id it was sent under.
      const realOfAnon = new Map([...prepared.anonMaps.requirementAnonMap].map(([real, anon]) => [anon, real]));
      const rowOf = new Map(prepared.requirementRows.map((row) => [row.id, row]));
      const subjectOf = new Map<string, string>();
      const leaderOf = new Map<string, string | null>();
      for (const requirement of prepared.payload.requirements) {
        const row = rowOf.get(realOfAnon.get(requirement.id) ?? '');
        if (row === undefined) continue;
        subjectOf.set(requirement.id, row.subjectId);
        leaderOf.set(requirement.id, row.teacherId ?? null);
      }
      const subjectIds = [...new Set(subjectOf.values())];
      const day = judgedDay(isoDay(new Date()), isoDay(year.startDate), isoDay(year.endDate));

      // WHO IS QUALIFIED: the behörigheter of the subjects the week teaches, of teachers who are active.
      // The one read of the table, so that the reader Föreslå bemanning judges by can replace it here (it is
      // classified by qualification-readers.inventory.spec.ts, from "Behörighet som i ett annat ämne" on).
      const rows =
        subjectIds.length === 0
          ? []
          : await tx.teacherSubjectQualification.findMany({
              where: { subjectId: { in: subjectIds }, user: { isActive: true } },
              select: {
                userId: true,
                subjectId: true,
                minGradeLevel: true,
                maxGradeLevel: true,
                kind: true,
                validFrom: true,
                validTo: true,
              },
            });
      const recorded = rows.length > 0 || (await tx.teacherSubjectQualification.count()) > 0;
      const subjects =
        subjectIds.length === 0
          ? []
          : await tx.subject.findMany({ where: { id: { in: subjectIds } }, select: { id: true, name: true } });
      return {
        ready: true,
        // The school's saved lunch rules, as the check sends them (WeekCheckService.check).
        payload: { ...prepared.payload, ...(prepared.storedRules ? { rules: prepared.storedRules } : {}) },
        anonMaps: prepared.anonMaps,
        stretches: prepared.periodStretches,
        numbering,
        subjectOf,
        leaderOf,
        subjectNames: new Map(subjects.map((subject) => [subject.id, subject.name])),
        qualifications: rows.map((row) => ({
          userId: row.userId,
          subjectId: row.subjectId,
          minGradeLevel: row.minGradeLevel,
          maxGradeLevel: row.maxGradeLevel,
          kind: row.kind,
          validFrom: row.validFrom ? isoDay(row.validFrom) : null,
          validTo: row.validTo ? isoDay(row.validTo) : null,
        })),
        recorded,
        day,
      };
    });
  }
}

/**
 * The what-ifs of a year, the best week first. A count the seconds cut, or one
 * that has no year figure, is listed after the ranked ones and ranks nobody: a
 * lower bound at the deadline is not the value, and is never set beside one.
 * Ties go by the school's own subject name, so the order is the same each time.
 */
export function rankedWhatIfs(list: readonly ChoiceWhatIf[]): ChoiceWhatIf[] {
  const figure = (item: ChoiceWhatIf): number => rankingFigure(item.count) ?? Number.POSITIVE_INFINITY;
  return [...list].sort(
    (a, b) =>
      Number(b.ranked) - Number(a.ranked) ||
      figure(a) - figure(b) ||
      a.subject.localeCompare(b.subject, 'sv'),
  );
}
