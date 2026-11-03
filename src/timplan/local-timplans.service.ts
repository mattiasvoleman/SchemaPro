import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  type LocalTimplan,
  type LocalTimplanEntry,
  type PrismaClient,
  type SchoolForm,
} from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId, requireUserId } from '../common/utils/request-context';
import {
  decidedTimplanConflict,
  rethrowPrismaError,
  timplanInUseConflict,
} from '../common/utils/prisma-errors';
import { lydelseIsTioarig } from '../common/grade-numbering';
import {
  checkLocalTimplan,
  gradeSpanOf,
  planningWeeksInTenths,
  stageGradesFor,
  type GradeSpan,
  type TimplanCheck,
  type TimplanVerdict,
} from '../common/timplan-coverage';
import { describeVerdict } from './timplan-verdict-messages';
import type {
  CopyLocalTimplanDto,
  CreateLocalTimplanDto,
  DecideLocalTimplanDto,
  ReplaceLocalTimplanEntriesDto,
  UpdateLocalTimplanDto,
} from './dto/local-timplan.dto';

/**
 * A plan as the client sees it: planningWeeks as a NUMBER.
 *
 * Prisma hands NUMERIC(4,1) back as a Decimal object, which JSON.stringify
 * renders as the string "35.6" — and a grid that multiplies minutes by it gets
 * string concatenation, or 0 from a careless Number(undefined). Converted once
 * here, through the same exact-tenths reading the coverage module uses, so the
 * figure on the wire is the figure the verdicts were computed with.
 */
export interface LocalTimplanResponse extends Omit<LocalTimplan, 'planningWeeks'> {
  planningWeeks: number;
}

export interface LocalTimplanListItem extends LocalTimplanResponse {
  entryCount: number;
}

export type LocalTimplanEntryResponse = Pick<
  LocalTimplanEntry,
  'id' | 'subjectId' | 'gradeLevel' | 'minutesPerWeek' | 'note'
>;

export interface LocalTimplanDetail extends LocalTimplanResponse {
  entries: LocalTimplanEntryResponse[];
}

/** The verdict document, each verdict with its Swedish sentence. */
export interface LocalTimplanCheckResponse extends Omit<TimplanCheck, 'verdicts'> {
  localTimplanId: string;
  verdicts: (TimplanVerdict & { message: string })[];
}

export interface ReplaceEntriesResponse {
  plan: LocalTimplanDetail;
  check: LocalTimplanCheckResponse;
}

export function toPlanResponse(row: LocalTimplan): LocalTimplanResponse {
  return { ...row, planningWeeks: planningWeeksInTenths(row.planningWeeks) / 10 };
}

/** The Swedish name of a school form, for a sentence about a mismatch. */
const SCHOOL_FORM_NAME: Record<SchoolForm, string> = {
  GRUNDSKOLA: 'grundskolan',
  ANPASSAD_GRUNDSKOLA_AMNEN: 'anpassade grundskolan (ämnen)',
  ANPASSAD_GRUNDSKOLA_AMNESOMRADEN: 'anpassade grundskolan (ämnesområden)',
  SPECIALSKOLA: 'specialskolan',
  SAMESKOLA: 'sameskolan',
};

const ENTRY_ORDER = [{ gradeLevel: 'asc' }, { subjectId: 'asc' }] as const;
const ENTRY_SELECT = {
  id: true,
  subjectId: true,
  gradeLevel: true,
  minutesPerWeek: true,
  note: true,
} as const;

/** One decimal, as text, so 35.6 reaches NUMERIC(4,1) without a binary detour. */
const weeksDecimal = (weeks: number): string => (Math.round(weeks * 10) / 10).toFixed(1);

const notFound = () => new NotFoundException('Den lokala timplanen finns inte.');

/**
 * Lokala timplaner: a school's own fördelning mellan årskurserna, in minutes
 * per week per subject, DRAFT until somebody records the huvudman's decision.
 *
 * A DECIDED PLAN IS A RECORD. Every write that would change one — PATCH, PUT
 * entries, a second decide, the timplan CSV import — is refused here first
 * with 409 TIMPLAN_IS_DECIDED, naming the plan; the triggers of migration
 * 20261006120000 refuse it a second time for PostgREST writers and for the
 * race this service cannot see (a plan decided between this service's read
 * and its write), and rethrowPrismaError turns their TP409 into the same 409.
 * Changing a decided plan means POST /:id/reopen, which copies it into a new
 * DRAFT that points back at it. DELETE is allowed for a decided plan: it is an
 * explicit act the web confirms, not an edit of the record.
 *
 * EVERY CHECK IS A WARNING. The verdicts (src/common/timplan-coverage.ts) come
 * back with the entries PUT and from GET /:id/check, and nothing here refuses
 * to save, decide or copy because of one.
 *
 * Reads are open to TEACHER as well (the staff_select arm reads every plan,
 * drafts included — a draft is discussed with the teachers). Pupils and
 * guardians read decided plans through PostgREST under their own arm; no
 * route here serves them.
 */
@Injectable()
export class LocalTimplansService {
  constructor(private readonly prisma: PrismaService) {}

  async list(user: AuthenticatedUser): Promise<LocalTimplanListItem[]> {
    requireSchoolId(user);
    const rows = await this.prisma.withRls(user, (tx) =>
      tx.localTimplan.findMany({
        orderBy: { name: 'asc' },
        include: { _count: { select: { entries: true } } },
      }),
    );
    return rows.map(({ _count, ...row }) => ({ ...toPlanResponse(row), entryCount: _count.entries }));
  }

  async get(id: string, user: AuthenticatedUser): Promise<LocalTimplanDetail> {
    requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const plan = await readDetail(tx, id);
      if (!plan) throw notFound();
      return plan;
    });
  }

  /** The verdict document for a plan as it is stored. No year needed. */
  async check(id: string, user: AuthenticatedUser): Promise<LocalTimplanCheckResponse> {
    requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const plan = await tx.localTimplan.findUnique({
        where: { id },
        include: { entries: { select: ENTRY_SELECT } },
      });
      if (!plan) throw notFound();
      return computeCheck(tx, plan, plan.entries);
    });
  }

  async create(dto: CreateLocalTimplanDto, user: AuthenticatedUser): Promise<LocalTimplanDetail> {
    const schoolId = requireSchoolId(user);
    const name = dto.name.trim();
    const span = readGradeSpan(dto) ?? null;
    try {
      return await this.prisma.withRls(user, async (tx) => {
        const version = await assertVersionFits(tx, dto.nationalTimplanVersionId, dto.schoolForm);
        if (span) assertSpanFits(span, version);
        const row = await tx.localTimplan.create({
          data: {
            schoolId,
            name,
            schoolForm: dto.schoolForm,
            nationalTimplanVersionId: dto.nationalTimplanVersionId,
            // Stated rather than left to the column default, like the
            // subjects service states countsTowardTimplan.
            planningWeeks: weeksDecimal(dto.planningWeeks ?? 35.6),
            gradeFrom: span?.gradeFrom ?? null,
            gradeTo: span?.gradeTo ?? null,
          },
        });
        return { ...toPlanResponse(row), entries: [] };
      });
    } catch (error) {
      rethrowPlanError(error, name);
    }
  }

  /**
   * Name, weeks, version and årskurs span of a DRAFT.
   *
   * A DECIDED plan admits ONE change: a span, set once, from none, and nothing
   * else in the same request. It is the record's only exception (the trigger of
   * migration 20261219090000 holds it and stamps who and when); a plan that
   * already has a span, or any other change, is 409 TIMPLAN_IS_DECIDED as ever.
   */
  async update(
    id: string,
    dto: UpdateLocalTimplanDto,
    user: AuthenticatedUser,
  ): Promise<LocalTimplanResponse> {
    requireSchoolId(user);
    const name = dto.name?.trim();
    const span = readGradeSpan(dto);
    try {
      return await this.prisma.withRls(user, async (tx) => {
        const plan = await tx.localTimplan.findUnique({ where: { id } });
        if (!plan) throw notFound();

        if (plan.status === 'DECIDED') {
          const onlyASpan =
            dto.name === undefined &&
            dto.planningWeeks === undefined &&
            dto.nationalTimplanVersionId === undefined;
          if (!span || !onlyASpan || gradeSpanOf(plan) !== null) throw decidedTimplanConflict([plan.name]);
          assertSpanFits(span, await readVersion(tx, plan.nationalTimplanVersionId));
          const row = await tx.localTimplan.update({
            where: { id },
            data: { gradeFrom: span.gradeFrom, gradeTo: span.gradeTo },
          });
          return toPlanResponse(row);
        }

        let version = undefined as VersionFacts | undefined;
        if (dto.nationalTimplanVersionId !== undefined) {
          version = await assertVersionFits(tx, dto.nationalTimplanVersionId, plan.schoolForm);
          // A span is stated in its lydelse's numbering: åk 4–9 of a nine-year
          // lydelse is not åk 4–9 of the tioårig one, and carrying it over
          // would change which årskurser the plan is for without a word.
          if (span === undefined && gradeSpanOf(plan) !== null) {
            const was = await readVersion(tx, plan.nationalTimplanVersionId);
            if (lydelseIsTioarig(was.appliesFromCohortTerm) !== lydelseIsTioarig(version.appliesFromCohortTerm)) {
              throw new BadRequestException(
                'nationalTimplanVersionId: den nya lydelsen numrerar årskurserna på ett annat sätt än planens nuvarande. ' +
                  'Ange planens årskurspann för den nya lydelsen i samma anrop (gradeFrom och gradeTo), eller null för hela skolformen.',
              );
            }
          }
        }
        const effective = span === undefined ? gradeSpanOf(plan) : span;
        if (effective && (span !== undefined || version)) {
          assertSpanFits(effective, version ?? (await readVersion(tx, plan.nationalTimplanVersionId)));
        }
        const row = await tx.localTimplan.update({
          where: { id },
          data: {
            ...(name !== undefined ? { name } : {}),
            ...(dto.planningWeeks !== undefined
              ? { planningWeeks: weeksDecimal(dto.planningWeeks) }
              : {}),
            ...(dto.nationalTimplanVersionId !== undefined
              ? { nationalTimplanVersionId: dto.nationalTimplanVersionId }
              : {}),
            ...(span !== undefined
              ? { gradeFrom: span?.gradeFrom ?? null, gradeTo: span?.gradeTo ?? null }
              : {}),
          },
        });
        return toPlanResponse(row);
      });
    } catch (error) {
      rethrowPlanError(error, name);
    }
  }

  /**
   * Delete a plan, decided or not. Its entries cascade (the entries trigger
   * finds no parent and lets them go), and any plan copied from it keeps its
   * content and loses only the pointer.
   *
   * NOT WHILE A LÄSÅR FOLLOWS IT. The years are asked first, so the 409
   * TIMPLAN_IN_USE names them ("läsåret 2026/27") and the admin knows which
   * dialog to open. The key AcademicYearTimplans_localTimplanId_schoolId_fkey
   * is ON DELETE RESTRICT and refuses it a second time — for the PostgREST
   * writer, and for a year attached between this read and the delete, which
   * the read cannot see — and rethrowPrismaError gives that refusal the same
   * code, saying "minst ett läsår" because the key does not know which.
   */
  async remove(id: string, user: AuthenticatedUser): Promise<void> {
    requireSchoolId(user);
    try {
      await this.prisma.withRls(user, async (tx) => {
        const followers = await tx.academicYearTimplan.findMany({
          where: { localTimplanId: id },
          select: { academicYear: { select: { name: true } } },
        });
        if (followers.length > 0) {
          const names = [...new Set(followers.map((row) => row.academicYear.name))].sort((a, b) =>
            a.localeCompare(b, 'sv'),
          );
          throw timplanInUseConflict(names);
        }
        await tx.localTimplan.delete({ where: { id } });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw notFound();
      }
      rethrowPrismaError(error);
    }
  }

  /**
   * Replace the plan's entries with exactly `dto.entries`, and answer with the
   * stored plan and its verdicts so the grid can paint without a second call.
   *
   * Validated against the tenant inside the SAME transaction that writes,
   * like a group's members: every subject must be one the caller can see, or
   * the request is a 400 naming the offenders — never a silently shrunken
   * save. The plan row is touched FIRST: entries have no timestamps (the
   * plan's updatedAt is theirs), and the UPDATE also takes the plan's row
   * lock, so two saves of one grid queue instead of interleaving their
   * delete-and-insert, and a decide racing this save either waits for it or
   * makes it fail on the trigger with the same 409.
   */
  async replaceEntries(
    id: string,
    dto: ReplaceLocalTimplanEntriesDto,
    user: AuthenticatedUser,
  ): Promise<ReplaceEntriesResponse> {
    const schoolId = requireSchoolId(user);
    assertOneEntryPerCell(dto);
    try {
      return await this.prisma.withRls(user, async (tx) => {
        await readDraft(tx, id);
        await tx.localTimplan.update({ where: { id }, data: { updatedAt: new Date() } });

        const subjectIds = [...new Set(dto.entries.map((entry) => entry.subjectId))];
        if (subjectIds.length > 0) {
          const known = await tx.subject.findMany({
            where: { id: { in: subjectIds } },
            select: { id: true },
          });
          const seen = new Set(known.map((subject) => subject.id));
          const unknown = subjectIds.filter((subjectId) => !seen.has(subjectId));
          if (unknown.length > 0) {
            throw new BadRequestException(
              `entries: ämnet finns inte i skolan: ${unknown.join(', ')}.`,
            );
          }
        }

        await tx.localTimplanEntry.deleteMany({ where: { localTimplanId: id } });
        if (dto.entries.length > 0) {
          await tx.localTimplanEntry.createMany({
            data: dto.entries.map((entry) => ({
              schoolId,
              localTimplanId: id,
              subjectId: entry.subjectId,
              gradeLevel: entry.gradeLevel,
              minutesPerWeek: entry.minutesPerWeek,
              note: entry.note?.trim() || null,
            })),
          });
        }

        const plan = await readDetail(tx, id);
        if (!plan) throw notFound();
        return { plan, check: await computeCheck(tx, plan, plan.entries) };
      });
    } catch (error) {
      rethrowPlanError(error);
    }
  }

  /**
   * Record the huvudman's decision: who (the caller), when (now), and the note
   * that identifies it. A DRAFT only, and atomically so: the UPDATE is
   * conditioned on status = DRAFT, so of two decides racing one wins and the
   * other is told the plan is already decided, rather than both stamping it.
   */
  async decide(
    id: string,
    dto: DecideLocalTimplanDto,
    user: AuthenticatedUser,
  ): Promise<LocalTimplanResponse> {
    requireSchoolId(user);
    const decidedByUserId = requireUserId(user);
    try {
      return await this.prisma.withRls(user, async (tx) => {
        await readDraft(tx, id);
        const { count } = await tx.localTimplan.updateMany({
          where: { id, status: 'DRAFT' },
          data: {
            status: 'DECIDED',
            decidedAt: new Date(),
            decidedByUserId,
            decisionNote: dto.decisionNote.trim(),
          },
        });
        const row = await tx.localTimplan.findUnique({ where: { id } });
        if (!row) throw notFound();
        if (count === 0) throw decidedTimplanConflict([row.name]);
        return toPlanResponse(row);
      });
    } catch (error) {
      rethrowPlanError(error);
    }
  }

  /**
   * Open a DECIDED plan again: copy it, entries and all, into a new DRAFT that
   * points back at it. The decided plan stays exactly what it was — that is
   * the point of it — and the draft is where the next decision is prepared.
   * A draft needs no reopening; that is a 409 that says so.
   */
  async reopen(
    id: string,
    dto: CopyLocalTimplanDto,
    user: AuthenticatedUser,
  ): Promise<LocalTimplanDetail> {
    return this.copyPlan(id, dto, user, 'utkast', (source) => {
      if (source.status !== 'DECIDED') {
        throw new ConflictException({
          message: `Den lokala timplanen "${source.name}" är ett utkast och kan ändras direkt. Kopiera den om du vill ha en ny.`,
          code: 'TIMPLAN_IS_DRAFT',
        });
      }
    });
  }

  /** Copy any plan into a new DRAFT. */
  async copy(
    id: string,
    dto: CopyLocalTimplanDto,
    user: AuthenticatedUser,
  ): Promise<LocalTimplanDetail> {
    return this.copyPlan(id, dto, user, 'kopia', () => undefined);
  }

  private async copyPlan(
    id: string,
    dto: CopyLocalTimplanDto,
    user: AuthenticatedUser,
    suffix: string,
    assertSource: (source: LocalTimplan) => void,
  ): Promise<LocalTimplanDetail> {
    const schoolId = requireSchoolId(user);
    const requested = dto.name?.trim();
    const asked = readGradeSpan(dto);
    try {
      return await this.prisma.withRls(user, async (tx) => {
        const source = await tx.localTimplan.findUnique({
          where: { id },
          include: { entries: { select: ENTRY_SELECT } },
        });
        if (!source) throw notFound();
        assertSource(source);
        // The draft is for what the request says, else for what its source is
        // for. The stamps of a span set after a decision are the source's own
        // record and are not copied: the draft is a new proposal.
        const span = asked === undefined ? gradeSpanOf(source) : asked;
        if (asked) assertSpanFits(asked, await readVersion(tx, source.nationalTimplanVersionId));

        const name = requested ?? (await freeName(tx, source.name, suffix));
        const created = await tx.localTimplan.create({
          data: {
            schoolId,
            name,
            schoolForm: source.schoolForm,
            nationalTimplanVersionId: source.nationalTimplanVersionId,
            planningWeeks: source.planningWeeks,
            gradeFrom: span?.gradeFrom ?? null,
            gradeTo: span?.gradeTo ?? null,
            copiedFromId: source.id,
          },
        });
        if (source.entries.length > 0) {
          await tx.localTimplanEntry.createMany({
            data: source.entries.map((entry) => ({
              schoolId,
              localTimplanId: created.id,
              subjectId: entry.subjectId,
              gradeLevel: entry.gradeLevel,
              minutesPerWeek: entry.minutesPerWeek,
              note: entry.note,
            })),
          });
        }
        const plan = await readDetail(tx, created.id);
        if (!plan) throw notFound();
        return plan;
      });
    } catch (error) {
      rethrowPlanError(error, requested);
    }
  }
}

/**
 * The plan, for a write that only a DRAFT admits: 404 when RLS hides it, 409
 * TIMPLAN_IS_DECIDED naming it when it is decided. The service's first line;
 * the trigger is the second.
 */
export async function readDraft(tx: PrismaClient, id: string): Promise<LocalTimplan> {
  const plan = await tx.localTimplan.findUnique({ where: { id } });
  if (!plan) throw notFound();
  if (plan.status === 'DECIDED') throw decidedTimplanConflict([plan.name]);
  return plan;
}

async function readDetail(tx: PrismaClient, id: string): Promise<LocalTimplanDetail | null> {
  const plan = await tx.localTimplan.findUnique({
    where: { id },
    include: { entries: { select: ENTRY_SELECT, orderBy: [...ENTRY_ORDER] } },
  });
  if (!plan) return null;
  const { entries, ...row } = plan;
  return { ...toPlanResponse(row), entries };
}

/**
 * The version must exist and be of the plan's school form. The composite
 * foreign key (nationalTimplanVersionId, schoolForm) refuses a mismatch as
 * well, but as a 409 about "a record"; this names the field and both forms.
 */
async function assertVersionFits(
  tx: PrismaClient,
  versionId: string,
  schoolForm: SchoolForm,
): Promise<VersionFacts> {
  const version = await tx.nationalTimplanVersion.findUnique({
    where: { id: versionId },
    select: { code: true, schoolForm: true, appliesFromCohortTerm: true },
  });
  if (!version) {
    throw new BadRequestException(
      `nationalTimplanVersionId: det finns ingen nationell timplan med id ${versionId}.`,
    );
  }
  if (version.schoolForm !== schoolForm) {
    throw new BadRequestException(
      `nationalTimplanVersionId: ${version.code} är timplanen för ${SCHOOL_FORM_NAME[version.schoolForm]}, ` +
        `och planen gäller ${SCHOOL_FORM_NAME[schoolForm]}.`,
    );
  }
  return version;
}

/** What a span is read against: the version's code, form and lydelse. */
type VersionFacts = { code: string; schoolForm: SchoolForm; appliesFromCohortTerm: string };

/** A plan's version, which its composite key guarantees exists. */
async function readVersion(tx: PrismaClient, versionId: string): Promise<VersionFacts> {
  const version = await tx.nationalTimplanVersion.findUnique({
    where: { id: versionId },
    select: { code: true, schoolForm: true, appliesFromCohortTerm: true },
  });
  if (!version) throw new Error(`national timplan version ${versionId} is unreadable`);
  return version;
}

/**
 * The span a request states: undefined when it says nothing, null for the
 * whole school form, else the span. Half a pair and an inverted one are 400s
 * that name the fields; the CHECKs of 20261219090000 are the second line.
 */
function readGradeSpan(dto: {
  gradeFrom?: number | null;
  gradeTo?: number | null;
}): GradeSpan | null | undefined {
  if (dto.gradeFrom === undefined && dto.gradeTo === undefined) return undefined;
  const from = dto.gradeFrom ?? null;
  const to = dto.gradeTo ?? null;
  if (from === null && to === null) return null;
  if (from === null || to === null) {
    throw new BadRequestException(
      'gradeFrom och gradeTo: årskurspannet anges med båda, eller med inget av dem för hela skolformen.',
    );
  }
  if (from > to) {
    throw new BadRequestException(
      `gradeFrom och gradeTo: första årskursen (${from}) kan inte komma efter den sista (${to}).`,
    );
  }
  return { gradeFrom: from, gradeTo: to };
}

/**
 * A span must hold at least one årskurs of the plan's lydelse, or the plan
 * would be judged against nothing and read as correct. Årskurser outside the
 * form on either side are allowed (förskoleklassen, a span written wider).
 */
function assertSpanFits(span: GradeSpan, version: VersionFacts): void {
  const stages = stageGradesFor(version);
  const grades = [...stages.LAG, ...stages.MELLAN, ...stages.HOG];
  if (grades.some((grade) => grade >= span.gradeFrom && grade <= span.gradeTo)) return;
  throw new BadRequestException(
    `gradeFrom och gradeTo: årskurs ${span.gradeFrom}–${span.gradeTo} innehåller ingen årskurs i ${version.code}, ` +
      `som gäller årskurs ${Math.min(...grades)}–${Math.max(...grades)}.`,
  );
}

/**
 * One row per (subject, årskurs). The table's unique key would refuse the
 * second as a P2002 nobody can act on; this names both rows.
 */
function assertOneEntryPerCell(dto: ReplaceLocalTimplanEntriesDto): void {
  const seen = new Map<string, number>();
  for (const [index, entry] of dto.entries.entries()) {
    const key = `${entry.subjectId}:${entry.gradeLevel}`;
    const first = seen.get(key);
    if (first !== undefined) {
      throw new BadRequestException(
        `entries: rad ${index + 1} har samma ämne och årskurs ${entry.gradeLevel} som rad ${first + 1}. ` +
          'En timplan har en rad per ämne och årskurs.',
      );
    }
    seen.set(key, index);
  }
}

/**
 * "Grundskolan 2024 (kopia)", then "(kopia 2)", … — the first name free in the
 * school, cut so the whole stays within the column's 100 characters.
 */
async function freeName(tx: PrismaClient, base: string, suffix: string): Promise<string> {
  const candidate = (n: number) => {
    const tail = n === 1 ? ` (${suffix})` : ` (${suffix} ${n})`;
    return `${base.slice(0, 100 - tail.length).trimEnd()}${tail}`;
  };
  const taken = new Set(
    (
      await tx.localTimplan.findMany({
        where: { name: { startsWith: base.slice(0, 80) } },
        select: { name: true },
      })
    ).map((plan) => plan.name),
  );
  let n = 1;
  while (taken.has(candidate(n))) n += 1;
  return candidate(n);
}

/** Version, statute and subjects read under RLS, then the pure check. */
async function computeCheck(
  tx: PrismaClient,
  // The stored Decimal or the response's number: both read to the same tenths.
  plan: Pick<LocalTimplan, 'id' | 'nationalTimplanVersionId' | 'gradeFrom' | 'gradeTo'> & {
    planningWeeks: Prisma.Decimal | number;
  },
  entries: Pick<LocalTimplanEntry, 'subjectId' | 'gradeLevel' | 'minutesPerWeek'>[],
): Promise<LocalTimplanCheckResponse> {
  const version = await tx.nationalTimplanVersion.findUnique({
    where: { id: plan.nationalTimplanVersionId },
    select: {
      code: true,
      schoolForm: true,
      totalHours: true,
      skolansValHours: true,
      reductionCapPercent: true,
      appliesFromCohortTerm: true,
      entries: {
        select: {
          subjectCode: true,
          stage: true,
          hours: true,
          minimumHoursPerChild: true,
          protectedFromReduction: true,
        },
      },
    },
  });
  // The composite foreign key makes the version exist, and its SELECT policy
  // admits every active user; a null here is a broken invariant, not a 404.
  if (!version) {
    throw new Error(`national timplan version ${plan.nationalTimplanVersionId} is unreadable`);
  }
  const nationalSubjects = await tx.nationalSubject.findMany({
    select: { code: true, name: true, parentCode: true },
  });
  const subjectIds = [...new Set(entries.map((entry) => entry.subjectId))];
  const subjects =
    subjectIds.length === 0
      ? []
      : await tx.subject.findMany({
          where: { id: { in: subjectIds } },
          select: { id: true, name: true, nationalCode: true, countsTowardTimplan: true },
        });

  const result = checkLocalTimplan({
    planningWeeksTenths: planningWeeksInTenths(plan.planningWeeks),
    version,
    nationalSubjects,
    subjects,
    entries,
    gradeSpan: gradeSpanOf(plan),
  });
  const names = new Map(nationalSubjects.map((subject) => [subject.code, subject.name]));
  return {
    localTimplanId: plan.id,
    ...result,
    verdicts: result.verdicts.map((verdict) => ({
      ...verdict,
      message: describeVerdict(verdict, names),
    })),
  };
}

/**
 * P2002 on this table is the per-school name (the other unique key is the
 * id); it is answered with the name rather than "a record with these values".
 */
function rethrowPlanError(error: unknown, name?: string): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    throw new ConflictException(
      name
        ? `Det finns redan en lokal timplan som heter "${name}". Välj ett annat namn.`
        : 'Det finns redan en lokal timplan med det namnet. Välj ett annat namn.',
    );
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
    throw notFound();
  }
  rethrowPrismaError(error);
}
