import { createHash, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { requireSchoolId } from '../common/utils/request-context';
import { PrismaService } from '../database/prisma.service';
import { readLoadInput, type LoadRead } from '../staffing/load-input';
import { lastYearKey, readLastYearTeachers } from '../staffing/last-year-teachers';
import { readActiveStaffIds } from '../staffing/staff-candidates';
import {
  SAME_TEACHER_TWICE,
  enforceRequirementBatch,
  lockEmploymentsOf,
  readCheckPolicy,
  type BatchWarning,
  type EnforcedPolicy,
} from '../staffing/staffing-enforcement';
import { subjectFamiliarTeachers, type LastYearTeachers } from '../staffing/suggest-teachers';
import {
  DEFAULT_LOAD_POLICY,
  chargedMinutes,
  countedMinutesByTeacher,
  loadStatus,
  percentOfTarget,
  qualificationCovers,
  strongestCoveringQualification,
  targetMinutesPerWeek,
  type LoadInput,
  type LoadModel,
  type LoadQualification,
  type LoadRequirement,
  type LoadStatus,
} from '../staffing/teacher-load';
import type { ApplyStaffingDto, StaffingProposalDto } from './dto/staffing-proposal.dto';
import {
  STAFF_UNSTAFFED_REASONS,
  type AnonymousStaffRequirement,
  type AnonymousStaffTeacher,
  type StaffEligibilitySet,
  type StaffRequest,
  type StaffResponse,
  type StaffSolveStatus,
  type StaffTerms,
  type StaffUnstaffedReason,
  type StaffWeights,
} from './interfaces/staffing.interface';
import { OptimizationProxyService, requirementName, type AnonMaps } from './optimization-proxy.service';

/** The engine's route; see optimization-engine/app/api/v1/staffing.py. */
export const STAFF_PATH = '/api/v1/staff';
/** A stale apply: the page recomputes rather than guesses. */
export const STAFF_PROPOSAL_STALE = 'STAFF_PROPOSAL_STALE';
/** An engine that has no /staff yet (an older deploy): not the year's 404. */
export const STAFF_ENGINE_UNAVAILABLE = 'STAFF_ENGINE_UNAVAILABLE';
/** The engine's own refusal of a model it will not build, said here before the call too. */
export const STAFF_MODEL_TOO_LARGE = 'STAFF_MODEL_TOO_LARGE';

/**
 * Under the engine's 8 MiB body limit (app/main.py MAX_REQUEST_BODY_BYTES),
 * with room for the headers: past it the engine answers 413, which reaches a
 * school as a generic error. Checked on the serialised payload before the call.
 */
export const MAX_STAFF_BODY_BYTES = 7.5 * 1024 * 1024;
/** The engine's own model-size guard: Σ|E_r| + #y + #teachers. */
const MODEL_VARIABLE_LIMIT = 1_000_000;
/** The engine's list caps (StaffRequest); a school past them is refused, not truncated. */
const MAX_TEACHERS = 1000;
const MAX_REQUIREMENTS = 5000;
const MAX_LAST_YEAR = 20;
/** The engine's field bounds (AnonymousStaffTeacher / AnonymousStaffRequirement). */
const MAX_FIXED_TENTHS = 200_000;
const MAX_CHARGE_TENTHS = 200_000;
const MAX_LESSON_MINUTES = 20_000;
const MAX_GRADE = 12;

/** Every map in AnonMaps, empty: nothing an engine sentence names can be realised by the proxy. */
const emptyAnonMaps = (): AnonMaps => ({
  requirementAnonMap: new Map(),
  roomAnonMap: new Map(),
  groupAnonMap: new Map(),
  roomTypeAnonMap: new Map(),
  constraintAnonMap: new Map(),
  workRuleAnonMap: new Map(),
  nameById: new Map(),
});

// ---------------------------------------------------------------------------
// The answer

export interface TeacherLoadPoint {
  /** Whole minutes, as the matrix prints them. */
  countedMinutesPerWeek: number;
  /** Two decimals: the figure the dialog re-judges a selection from. */
  countedExact: number;
  percentOfTarget: number | null;
  status: LoadStatus;
}

export interface ProposalTeacher {
  userId: string;
  targetMinutesPerWeek: number | null;
  /** floor(target × (1 + tolerance/100)): the most the proposal gives anybody. */
  limitMinutesPerWeek: number | null;
  /**
   * No target, a target of 0, or already over the limit: keeps or gives up
   * only their own rows, and gets nothing new.
   */
  keepOrShed: boolean;
  before: TeacherLoadPoint;
  after: TeacherLoadPoint;
}

export interface ProposalAssignment {
  requirementId: string;
  subjectId: string;
  studentGroupId: string;
  /** The lead the row has now; null for a row nobody teaches. */
  fromTeacherId: string | null;
  toTeacherId: string;
  /** What the row charges its lead, exact to two decimals. */
  chargeMinutesPerWeek: number;
  reasons: {
    /** The strongest covering behörighet; null when none or none recorded. */
    qualificationKind: LoadQualification['kind'] | null;
    /** Leads or co-teaches another row of the subject, or taught it last year. */
    familiarWithSubject: boolean;
    taughtLastYear: boolean;
    /** Leads or co-teaches another row for the same group, as the proposal leaves it. */
    teachesGroupAlready: boolean;
  };
}

export interface ProposalUnstaffed {
  requirementId: string;
  subjectId: string;
  studentGroupId: string;
  chargeMinutesPerWeek: number;
  reason: StaffUnstaffedReason;
  /** NO_QUALIFIED_TEACHER where the row's own co-teacher is the only one qualified. */
  onlyCoTeacherQualified: boolean;
}

export interface ProposalConflict {
  code: string;
  params: Record<string, string | number>;
  message: string;
  requirementIds: string[];
  /** "Matematik för 7B", in requirementIds' order. */
  requirementNames: string[];
  subjectIds: string[];
  /** Real user ids, in their own field only; the page names them from its staff list. */
  teacherIds: string[];
}

export interface StaffingProposal {
  status: StaffSolveStatus;
  /** No answer staffs more rows (by the first stage's weight): it was proven. */
  unstaffedProven: boolean;
  /** What the proposal was computed from; apply refuses any other state. */
  basisSha256: string;
  options: {
    onlyUnstaffed: boolean;
    /** Effective: on when asked or forced by REFUSE, never without records. */
    respectQualifications: boolean;
    respectForcedByPolicy: boolean;
    qualificationsRecorded: boolean;
    pinnedRequirementIds: string[];
  };
  loadModel: LoadModel;
  counts: {
    freeRequirements: number;
    openRequirements: number;
    keptRequirements: number;
    fixedRequirements: number;
    /** Free rows whose lead is no longer active staff. */
    vacated: number;
    /** Rows naming one person as lead and co-teacher: kept as they are. */
    inconsistent: number;
    teachersSent: number;
    teachersWithTarget: number;
    teachersWithZeroTarget: number;
    teachersWithoutTarget: number;
  };
  /** Lead CHANGES only, by requirement id. */
  assignments: ProposalAssignment[];
  teachers: ProposalTeacher[];
  unstaffed: ProposalUnstaffed[];
  conflicts: ProposalConflict[];
  /** The engine's objective terms; null when the engine was not asked. */
  terms: { before: StaffTerms; after: StaffTerms } | null;
}

export interface StaffingApplyResult {
  updated: number;
  /** The basis AFTER the apply — what an undo must send. */
  basisSha256: string;
  warnings: BatchWarning[];
  /** The ScheduleChangeLogs row the apply wrote. */
  logId: string;
}

// ---------------------------------------------------------------------------
// What a proposal reads, and what it decides before the engine is asked

/** Everything a proposal reads, and so everything its basis covers. */
interface StaffingState {
  schoolId: string;
  read: LoadRead;
  policy: EnforcedPolicy;
  /** Active TEACHER and SCHOOL_ADMIN ids, sorted. */
  staffIds: string[];
  /** Last year's teachers (Fas 5's fold) per requirement id, for rows whose group has a predecessor. */
  lastYear: Map<string, LastYearTeachers>;
}

type RowKind = 'FIXED' | 'KEPT' | 'OPEN';

interface RowPlan {
  row: LoadRequirement;
  kind: RowKind;
  inconsistent: boolean;
  vacated: boolean;
  /** The lead as sent: active staff, never the co-teacher; null otherwise. */
  current: string | null;
  /** The co-teacher as sent: active staff; null otherwise. */
  co: string | null;
  chargeExact: number;
  chargeTenths: number;
  lessonMinutes: number;
  /** Free rows only: who may take it (behörighet, or "teaches the subject" without records), sorted. */
  eligible: string[];
  /** Free rows only: last year's teachers among the staff, sorted. */
  lastYear: string[];
}

interface TeacherPlan {
  userId: string;
  target: number | null;
  targetTenths: number | null;
  limitTenths: number | null;
  floorTenths: number | null;
  fixedTenths: number;
  /** fixedTenths + the kept rows they lead today. */
  currentTenths: number;
  keepOrShed: boolean;
}

interface Plan {
  recorded: boolean;
  respect: boolean;
  respectForcedByPolicy: boolean;
  tolerance: number;
  staff: Set<string>;
  teachers: TeacherPlan[];
  teacherById: Map<string, TeacherPlan>;
  rows: RowPlan[];
  rowById: Map<string, RowPlan>;
  pinned: string[];
}

/**
 * Tjänstefördelningens bemanningsförslag (Fas 4): who should lead every
 * timplanspost, solved — the question Skola24 leaves to the admin and Untis
 * answers heuristically.
 *
 * NOTHING BUT OPAQUE IDS AND MINUTES CROSS. Every active member of staff is
 * sent — not only those already on a row, or a new teacher could never be
 * proposed — as a fresh uuid minted for this request, with integer tenths of
 * a minute: the target, the two edges of loadStatus's band, and what the
 * proposal may not move. Who may teach what is decided HERE, by the one rule
 * that decides it (qualificationCovers), and sent as deduplicated lists of
 * those uuids. The maps are locals of propose() and die with the response; the
 * proxy is handed empty ones, so not even a buggy engine sentence can be
 * turned back into anything (C5). Conflicts are realised below, to subject
 * names and row names only; a teacher returns as a real id in a field of its
 * own, and the page names them from the staff list it already has.
 *
 * THE ARITHMETIC IS FAS 1–3'S. Charges are chargedMinutes (lektionslängder,
 * recurrence, dates, lov, the FACTOR weight), loads countedMinutesByTeacher,
 * targets targetMinutesPerWeek, statuses loadStatus — so the before → after
 * the dialog shows is the matrix's own figure, and an answer that would put
 * a growing teacher OVER is refused here (502) before anybody sees it.
 *
 * APPLY IS ONE TRANSACTION AGAINST ITS BASIS, judged as one write by the
 * staffing policy (enforceRequirementBatch), and leaves one ScheduleChangeLogs
 * row; undo is the same route with the changes swapped and the returned basis.
 */
@Injectable()
export class StaffingProposalService {
  private readonly logger = new Logger(StaffingProposalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly proxy: OptimizationProxyService,
  ) {}

  /**
   * A proposal, and nothing written. The engine is called OUTSIDE the
   * transaction, as the room optimisation's is: a transaction held open across
   * a ten-second solve would pin a pooled connection. Apply trusts nothing from
   * here — it re-reads under its locks and compares the basis.
   */
  async propose(dto: StaffingProposalDto, user: AuthenticatedUser): Promise<StaffingProposal> {
    const requestId = randomUUID();
    const state = await this.prisma.withRls(user, (tx) => this.readState(tx, user, dto.academicYearId));
    const basisSha256 = basisOf(state);
    const plan = planOf(state, dto);

    const free = plan.rows.filter((row) => row.kind !== 'FIXED');
    const open = free.filter((row) => row.kind === 'OPEN');
    const kept = free.filter((row) => row.kind === 'KEPT');

    const answer = (
      status: StaffSolveStatus,
      unstaffedProven: boolean,
      leads: Map<string, string>,
      unstaffed: Map<string, StaffUnstaffedReason>,
      conflicts: ProposalConflict[],
      terms: StaffingProposal['terms'],
    ): StaffingProposal => ({
      status,
      unstaffedProven,
      basisSha256,
      options: {
        onlyUnstaffed: dto.onlyUnstaffed,
        respectQualifications: plan.respect,
        respectForcedByPolicy: plan.respectForcedByPolicy,
        qualificationsRecorded: plan.recorded,
        pinnedRequirementIds: plan.pinned,
      },
      loadModel: state.read.loadModel,
      counts: {
        freeRequirements: free.length,
        openRequirements: open.length,
        keptRequirements: kept.length,
        fixedRequirements: plan.rows.length - free.length,
        vacated: plan.rows.filter((row) => row.vacated).length,
        inconsistent: plan.rows.filter((row) => row.inconsistent).length,
        teachersSent: plan.teachers.length,
        teachersWithTarget: plan.teachers.filter((t) => t.target !== null).length,
        teachersWithZeroTarget: plan.teachers.filter((t) => t.target === 0).length,
        teachersWithoutTarget: plan.teachers.filter((t) => t.target === null).length,
      },
      ...this.compose(state, plan, leads, unstaffed),
      conflicts,
      terms,
    });

    // Nothing to decide: every row is fixed (staffed, pinned or inconsistent).
    if (free.length === 0) {
      return answer('OPTIMAL', true, new Map(), new Map(), [], null);
    }
    // Nobody could take a new row: no staff, or nobody with a target above 0
    // and no row anybody keeps. Every open row stays open, provably; asking the
    // engine would only say so in ten more seconds (C9).
    const anyTarget = plan.teachers.some((teacher) => (teacher.target ?? 0) > 0);
    if (plan.teachers.length === 0 || (!anyTarget && kept.length === 0)) {
      const reasons = new Map<string, StaffUnstaffedReason>();
      for (const row of open) {
        reasons.set(
          row.row.id,
          plan.teachers.length === 0
            ? 'NO_CAPACITY_LEFT'
            : plan.respect && row.eligible.every((id) => id === row.co)
              ? 'NO_QUALIFIED_TEACHER'
              : 'NO_TEACHER_WITH_TARGET',
        );
      }
      return answer('OPTIMAL', true, new Map(), reasons, [], null);
    }

    const variables = free.reduce((sum, row) => sum + row.eligible.length, 0);
    const tooLarge = (): BadRequestException =>
      new BadRequestException({
        // The catalogue's sentence (engineMessages.STAFF_MODEL_TOO_LARGE), with its numbers.
        message:
          `Det finns för många möjliga lärartilldelningar att väga på en gång: omkring ${variables} modellvariabler ` +
          `mot gränsen ${MODEL_VARIABLE_LIMIT}. Behåll de poster som är klara som de är, eller registrera behörigheter ` +
          'så att färre lärare är kandidater för varje post, och försök igen.',
        code: STAFF_MODEL_TOO_LARGE,
        params: { variables, limit: MODEL_VARIABLE_LIMIT },
      });
    if (plan.teachers.length > MAX_TEACHERS || plan.rows.length > MAX_REQUIREMENTS) throw tooLarge();

    const { payload, maps } = anonymise(requestId, plan, dto.weights);
    if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_STAFF_BODY_BYTES) throw tooLarge();

    let response: StaffResponse;
    try {
      response = await this.proxy.callAiEngine<StaffResponse>(STAFF_PATH, payload, emptyAnonMaps());
    } catch (error) {
      // An engine without the route — an older deploy — answers 404 (or 405)
      // with "Not Found", which forwarded as it is reads exactly like the
      // year's own 404. Named, so the page can say "not yet" instead (C4).
      if (error instanceof HttpException && [404, 405].includes(error.getStatus())) {
        throw new ServiceUnavailableException({
          message: 'Motorn kan ännu inte föreslå bemanning. Försök igen om en stund.',
          code: STAFF_ENGINE_UNAVAILABLE,
        });
      }
      throw error;
    }

    const realised = this.realise(response, state, plan, maps);
    this.logger.log(
      `Staffing proposal [requestId=${requestId}, status=${response.status}, teachers=${plan.teachers.length}, ` +
        `rows=${plan.rows.length}, free=${free.length}, staffed=${realised.leads.size}, unstaffed=${realised.unstaffed.size}, ` +
        `conflicts=${realised.conflicts.length}]`,
    );
    return answer(
      response.status,
      response.unstaffedProven === true,
      realised.leads,
      realised.unstaffed,
      realised.conflicts,
      response.terms ? { before: terms(response.terms.before), after: terms(response.terms.after) } : null,
    );
  }

  /**
   * Apply a proposal (or a selection of it) — or, with its changes swapped,
   * `undo: true` and the basis the apply returned, undo one. One RLS
   * transaction, all or nothing.
   *
   * THE LOCK ORDER (C6): the year's advisory lock (one apply at a time), the
   * posts of every teacher the changes name (as a PATCH locks them), the
   * changed timplansposter themselves, and only then the read the basis is
   * computed from. A PATCH takes the posts, then its row — the same order, so
   * the two queue rather than deadlock — and one that committed before the row
   * lock is in the read, so its change refuses the apply as stale instead of
   * being judged for a subject the row no longer has.
   */
  async apply(dto: ApplyStaffingDto, user: AuthenticatedUser): Promise<StaffingApplyResult> {
    const seen = new Set<string>();
    for (const change of dto.changes) {
      if (seen.has(change.requirementId)) {
        throw new BadRequestException(`Requirement ${change.requirementId} is changed more than once.`);
      }
      seen.add(change.requirementId);
      // A proposal never leaves a staffed row with nobody; only reversing one
      // puts back the "nobody" an open row had.
      if (change.toTeacherId === null && dto.undo !== true) {
        throw new BadRequestException(
          `Requirement ${change.requirementId}: toTeacherId may be null only when undoing an apply.`,
        );
      }
      if (change.toTeacherId === change.fromTeacherId) {
        throw new BadRequestException(`Requirement ${change.requirementId} is changed to the teacher it has.`);
      }
    }

    const result = await this.prisma.withRls(user, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('staffing-proposal'), hashtext(${dto.academicYearId}))`;
      const people = [
        ...new Set(
          dto.changes.flatMap((change) => [change.fromTeacherId, change.toTeacherId]).filter((id): id is string => id !== null),
        ),
      ];
      const postsLocked = await lockEmploymentsOf(tx, dto.academicYearId, people);
      const rowIds = [...seen].sort();
      await tx.$queryRaw`
        SELECT "id"
        FROM "TeachingRequirements"
        WHERE "id" = ANY(${rowIds}::uuid[])
        ORDER BY "id"
        FOR NO KEY UPDATE
      `;

      const state = await this.readState(tx, user, dto.academicYearId);
      if (basisOf(state) !== dto.basisSha256) throw stale();

      const rows = new Map(state.read.input.requirements.map((row) => [row.id, row]));
      const staff = new Set(state.staffIds);
      const restoring: string[] = [];
      for (const change of dto.changes) {
        const row = rows.get(change.requirementId);
        if (!row) throw new BadRequestException(`Requirement ${change.requirementId} is not in this academic year.`);
        if (change.toTeacherId !== null && !staff.has(change.toTeacherId)) {
          // An undo may put back a lead who has left since: that is the state
          // the apply found. Anybody else must be active staff.
          if (dto.undo === true) restoring.push(change.toTeacherId);
          else throw new BadRequestException(`Teacher ${change.toTeacherId} is not active staff of this school.`);
        }
        if (change.toTeacherId !== null && change.toTeacherId === row.coTeacherId) {
          throw new BadRequestException(SAME_TEACHER_TWICE);
        }
        if (row.teacherId !== change.fromTeacherId) throw stale();
      }
      if (restoring.length > 0) {
        const wanted = [...new Set(restoring)];
        const found = await tx.user.findMany({
          where: { id: { in: wanted }, role: { in: ['TEACHER', 'SCHOOL_ADMIN'] } },
          select: { id: true },
        });
        if (found.length !== wanted.length) {
          throw new BadRequestException('An undo may only put back a teacher of this school.');
        }
      }

      const warnings = enforceRequirementBatch({
        input: state.read.input,
        policy: state.policy,
        postsLocked,
        changes: dto.changes.map((change) => ({ requirementId: change.requirementId, teacherId: change.toTeacherId })),
        rowName: (requirementId) => {
          const row = rows.get(requirementId)!;
          return requirementName(row.subjectName, row.groupName);
        },
        restoring: dto.undo === true ? await this.appliedBefore(tx, dto) : undefined,
      });

      // One statement per (from, to) pair, each still carrying the from-lead:
      // the basis says every row has it, and this makes the write itself
      // refuse otherwise rather than trusting the read.
      const byPair = new Map<string, { from: string | null; to: string | null; ids: string[] }>();
      for (const change of dto.changes) {
        const key = `${change.fromTeacherId ?? ''}>${change.toTeacherId ?? ''}`;
        const pair = byPair.get(key);
        if (pair) pair.ids.push(change.requirementId);
        else byPair.set(key, { from: change.fromTeacherId, to: change.toTeacherId, ids: [change.requirementId] });
      }
      for (const pair of byPair.values()) {
        const { count } = await tx.teachingRequirement.updateMany({
          where: { id: { in: pair.ids }, academicYearId: dto.academicYearId, teacherId: pair.from },
          data: { teacherId: pair.to },
        });
        if (count !== pair.ids.length) throw stale();
      }

      // The basis of what is now stored: what was read with the changes laid
      // over it. Only teacherId was written and the year's lock keeps every
      // other apply out, so a fresh read hashes to exactly this.
      const toById = new Map(dto.changes.map((change) => [change.requirementId, change.toTeacherId]));
      const after: StaffingState = {
        ...state,
        read: {
          ...state.read,
          input: {
            ...state.read.input,
            requirements: state.read.input.requirements.map((row) =>
              toById.has(row.id) ? { ...row, teacherId: toById.get(row.id)! } : row,
            ),
          },
        },
      };
      const basisAfter = basisOf(after);

      // One row of the audit trail for the whole apply: ids only — no load, no
      // target, no name — as the timetable's other writes keep it.
      const ordered = [...dto.changes].sort((a, b) => compareIds(a.requirementId, b.requirementId));
      const log = await tx.scheduleChangeLog.create({
        data: {
          schoolId: state.schoolId,
          academicYearId: dto.academicYearId,
          masterLessonId: null,
          actorId: user.userId ?? null,
          action: 'UPDATE',
          before: {
            kind: 'STAFFING_PROPOSAL',
            changes: ordered.map((change) => ({ requirementId: change.requirementId, teacherId: change.fromTeacherId })),
          },
          after: {
            kind: 'STAFFING_PROPOSAL',
            undo: dto.undo === true,
            basisBefore: dto.basisSha256,
            basisAfter,
            changes: ordered.map((change) => ({ requirementId: change.requirementId, teacherId: change.toTeacherId })),
          },
        },
        select: { id: true },
      });

      return { updated: dto.changes.length, basisSha256: basisAfter, warnings, logId: log.id };
    });

    this.logger.log(
      `Staffing applied [academicYearId=${dto.academicYearId}, updated=${result.updated}, undo=${dto.undo === true}, ` +
        `warnings=${result.warnings.length}, log=${result.logId}]`,
    );
    return result;
  }

  // ---------------------------------------------------------------------------

  /**
   * For an undo: the leads the apply it reverses found, row by row — or
   * undefined when it reverses none, and is then judged as any write.
   *
   * The apply is the latest STAFFING_PROPOSAL log row of the year that is not
   * itself an undo, whose basisAfter is the basis this undo was checked
   * against (so nothing has changed since it), and of whose changes every
   * change here is the exact reversal (from its `to`, back to its `from`). A
   * partial undo — a selection of the apply's rows — qualifies; a change the
   * apply did not make does not, and turns the whole batch back into an
   * ordinary one. Read under the year's lock, through RLS (admin only).
   */
  private async appliedBefore(
    tx: PrismaClient,
    dto: ApplyStaffingDto,
  ): Promise<ReadonlyMap<string, string | null> | undefined> {
    const logs = await tx.scheduleChangeLog.findMany({
      where: {
        academicYearId: dto.academicYearId,
        masterLessonId: null,
        action: 'UPDATE',
        after: { path: ['basisAfter'], equals: dto.basisSha256 },
      },
      orderBy: { createdAt: 'desc' },
      select: { before: true, after: true },
    });
    for (const log of logs) {
      const after = log.after as { kind?: unknown; undo?: unknown; basisAfter?: unknown; changes?: unknown } | null;
      const before = log.before as { kind?: unknown; changes?: unknown } | null;
      if (after?.kind !== 'STAFFING_PROPOSAL' || after.undo !== false || after.basisAfter !== dto.basisSha256) continue;
      if (before?.kind !== 'STAFFING_PROPOSAL') continue;
      const leads = (changes: unknown): Map<string, string | null> =>
        new Map(
          (Array.isArray(changes) ? changes : []).map((change: { requirementId: string; teacherId: string | null }) => [
            change.requirementId,
            change.teacherId,
          ]),
        );
      const was = leads(before.changes);
      const became = leads(after.changes);
      const reverses = dto.changes.every(
        (change) =>
          became.has(change.requirementId) &&
          became.get(change.requirementId) === change.fromTeacherId &&
          was.has(change.requirementId) &&
          was.get(change.requirementId) === change.toTeacherId,
      );
      if (reverses) return was;
    }
    return undefined;
  }

  /** One read, in the caller's transaction, of everything the proposal and its basis depend on. */
  private async readState(tx: PrismaClient, user: AuthenticatedUser, academicYearId: string): Promise<StaffingState> {
    const schoolId = requireSchoolId(user);
    const read = await readLoadInput(tx, user, academicYearId, schoolId);
    if (!read) throw new NotFoundException('Academic year not found.');
    const policy = await readCheckPolicy(tx, schoolId);
    const staffIds = await readActiveStaffIds(tx);
    const groups = await tx.studentGroup.findMany({
      where: { academicYearId, predecessorId: { not: null } },
      select: { id: true, predecessorId: true },
    });
    const predecessorOf = new Map(
      groups.filter((group) => group.predecessorId !== null).map((group) => [group.id, group.predecessorId!]),
    );
    const keyed = read.input.requirements.flatMap((row) => {
      const predecessorId = predecessorOf.get(row.studentGroupId);
      return predecessorId ? [{ id: row.id, predecessorId, subjectId: row.subjectId }] : [];
    });
    const folded = await readLastYearTeachers(tx, keyed);
    const lastYear = new Map<string, LastYearTeachers>();
    for (const row of keyed) {
      const teachers = folded.get(lastYearKey(row.predecessorId, row.subjectId));
      if (teachers) lastYear.set(row.id, teachers);
    }
    return { schoolId, read, policy, staffIds, lastYear };
  }

  /**
   * The engine's answer in real ids — refused whole (502) when it is not an
   * answer to the question asked. Every rule the engine was given is checked
   * again here, where the write will be made: a proposal that broke one would
   * have the admin confirm a change that enforcement then refuses, or worse,
   * one that unstaffs a row taught today.
   */
  private realise(
    response: StaffResponse,
    state: StaffingState,
    plan: Plan,
    maps: StaffAnonMaps,
  ): { leads: Map<string, string>; unstaffed: Map<string, StaffUnstaffedReason>; conflicts: ProposalConflict[] } {
    const bad = (what: string): HttpException => {
      this.logger.error(`Rejected a staffing proposal: ${what}`);
      return new HttpException(
        'The AI engine returned a staffing proposal that does not match the request.',
        HttpStatus.BAD_GATEWAY,
      );
    };
    const realRequirement = reverse(maps.requirements);
    const realTeacher = reverse(maps.teachers);
    const realSubject = reverse(maps.subjects);
    if (response.status !== 'OPTIMAL' && response.status !== 'FEASIBLE') throw bad(`status ${String(response.status)}`);

    const leads = new Map<string, string>();
    for (const assignment of response.assignments) {
      const requirementId = realRequirement.get(assignment.requirementId);
      const teacherId = realTeacher.get(assignment.teacherId);
      if (!requirementId || !teacherId) throw bad('an unknown id');
      const row = plan.rowById.get(requirementId)!;
      if (row.kind === 'FIXED') throw bad(`fixed row ${assignment.requirementId} assigned`);
      if (leads.has(requirementId)) throw bad(`row ${assignment.requirementId} assigned twice`);
      if (teacherId === row.co) throw bad(`row ${assignment.requirementId} given its co-teacher`);
      const teacher = plan.teacherById.get(teacherId)!;
      const keeps = teacherId === row.current;
      if (!keeps && teacher.keepOrShed) throw bad(`a keep-or-shed teacher given row ${assignment.requirementId}`);
      if (!keeps && plan.respect && !row.eligible.includes(teacherId)) {
        throw bad(`row ${assignment.requirementId} given an unqualified teacher`);
      }
      leads.set(requirementId, teacherId);
    }

    const unstaffed = new Map<string, StaffUnstaffedReason>();
    for (const entry of response.unstaffed) {
      const requirementId = realRequirement.get(entry.requirementId);
      if (!requirementId) throw bad('an unknown id');
      const row = plan.rowById.get(requirementId)!;
      if (row.kind !== 'OPEN') throw bad(`${row.kind.toLowerCase()} row ${entry.requirementId} unstaffed`);
      if (leads.has(requirementId) || unstaffed.has(requirementId)) {
        throw bad(`row ${entry.requirementId} both staffed and unstaffed, or unstaffed twice`);
      }
      if (!STAFF_UNSTAFFED_REASONS.includes(entry.reason)) throw bad(`reason ${String(entry.reason)}`);
      unstaffed.set(requirementId, entry.reason);
    }
    for (const row of plan.rows) {
      if (row.kind === 'FIXED') continue;
      if (!leads.has(row.row.id) && !unstaffed.has(row.row.id)) {
        throw bad(`${row.kind.toLowerCase()} row ${maps.requirements.get(row.row.id)} neither staffed nor unstaffed`);
      }
    }

    // The recount the write will be judged by: nobody whose minutes grow may
    // end OVER (enforcement's question, with its rounding).
    const input = state.read.input;
    const before = countedMinutesByTeacher(input);
    const after = countedMinutesByTeacher(overlay(input, plan, leads));
    for (const teacher of plan.teachers) {
      const was = before.get(teacher.userId) ?? 0;
      const is = after.get(teacher.userId) ?? 0;
      if (is > was + 1e-9 && loadStatus(is, teacher.target, plan.tolerance) === 'OVER') {
        throw bad(`teacher ${maps.teachers.get(teacher.userId)} grows past the limit`);
      }
    }

    // Conflicts, realised by this service from its own maps — subjects to
    // their names, rows to "Matematik för 7B", teachers to real ids in their
    // own field only — and never by the proxy, which holds no teacher map.
    const subjectName = new Map(input.requirements.map((row) => [row.subjectId, row.subjectName]));
    const real = (map: Map<string, string>, ids: readonly string[]): string[] =>
      ids.map((id) => {
        const found = map.get(id);
        if (!found) throw bad('an unknown id in a conflict');
        return found;
      });
    const conflicts = response.conflicts.map((conflict): ProposalConflict => {
      const params: Record<string, string | number> = {};
      for (const [key, value] of Object.entries(conflict.params ?? {})) {
        if (key === 'subject' && typeof value === 'string') {
          const subjectId = realSubject.get(value);
          if (!subjectId) throw bad('an unknown subject in a conflict');
          params[key] = subjectName.get(subjectId) ?? '';
        } else {
          params[key] = value;
        }
      }
      const requirementIds = real(realRequirement, conflict.requirementIds ?? []);
      return {
        code: conflict.code,
        params,
        // Only whole uuids, and only subjects: the one id an engine sentence names.
        message: String(conflict.message ?? '').replace(UUID, (found) => {
          const subjectId = realSubject.get(found);
          return subjectId ? (subjectName.get(subjectId) ?? found) : found;
        }),
        requirementIds,
        requirementNames: requirementIds.map((id) => {
          const row = plan.rowById.get(id)!.row;
          return requirementName(row.subjectName, row.groupName);
        }),
        subjectIds: real(realSubject, conflict.subjectIds ?? []),
        teacherIds: real(realTeacher, conflict.teacherIds ?? []),
      };
    });

    return { leads, unstaffed, conflicts };
  }

  /** Per-teacher before → after, the changed rows with their reasons, and the unstaffed rest. */
  private compose(
    state: StaffingState,
    plan: Plan,
    leads: Map<string, string>,
    unstaffed: Map<string, StaffUnstaffedReason>,
  ): Pick<StaffingProposal, 'assignments' | 'teachers' | 'unstaffed'> {
    const input = state.read.input;
    const afterInput = overlay(input, plan, leads);
    const before = countedMinutesByTeacher(input);
    const after = countedMinutesByTeacher(afterInput);
    const point = (minutes: number, teacher: TeacherPlan): TeacherLoadPoint => ({
      countedMinutesPerWeek: Math.round(minutes),
      countedExact: round2(minutes),
      percentOfTarget: percentOfTarget(minutes, teacher.target),
      status: loadStatus(minutes, teacher.target, plan.tolerance),
    });

    const teachers = plan.teachers.map(
      (teacher): ProposalTeacher => ({
        userId: teacher.userId,
        targetMinutesPerWeek: teacher.target,
        limitMinutesPerWeek: teacher.target === null ? null : limitMinutes(teacher.target, plan.tolerance),
        keepOrShed: teacher.keepOrShed,
        before: point(before.get(teacher.userId) ?? 0, teacher),
        after: point(after.get(teacher.userId) ?? 0, teacher),
      }),
    );

    const assignments: ProposalAssignment[] = [];
    for (const plannedRow of plan.rows) {
      const to = leads.get(plannedRow.row.id);
      if (to === undefined || to === plannedRow.row.teacherId) continue;
      const row = plannedRow.row;
      const lastYear = state.lastYear.get(row.id) ?? null;
      assignments.push({
        requirementId: row.id,
        subjectId: row.subjectId,
        studentGroupId: row.studentGroupId,
        fromTeacherId: row.teacherId,
        toTeacherId: to,
        chargeMinutesPerWeek: round2(plannedRow.chargeExact),
        reasons: {
          qualificationKind: plan.recorded
            ? strongestCoveringQualification(input.qualifications, to, row, input.year)
            : null,
          familiarWithSubject: subjectFamiliarTeachers(input, row.id, lastYear).has(to),
          taughtLastYear: (lastYear?.teacherIds ?? []).includes(to),
          teachesGroupAlready: afterInput.requirements.some(
            (other) =>
              other.id !== row.id &&
              other.studentGroupId === row.studentGroupId &&
              (other.teacherId === to || other.coTeacherId === to),
          ),
        },
      });
    }

    const unstaffedRows = plan.rows.flatMap((plannedRow): ProposalUnstaffed[] => {
      const reason = unstaffed.get(plannedRow.row.id);
      if (reason === undefined) return [];
      return [
        {
          requirementId: plannedRow.row.id,
          subjectId: plannedRow.row.subjectId,
          studentGroupId: plannedRow.row.studentGroupId,
          chargeMinutesPerWeek: round2(plannedRow.chargeExact),
          reason,
          onlyCoTeacherQualified:
            reason === 'NO_QUALIFIED_TEACHER' && plannedRow.co !== null && plannedRow.eligible.includes(plannedRow.co),
        },
      ];
    });

    return { assignments, teachers, unstaffed: unstaffedRows };
  }
}

// ---------------------------------------------------------------------------
// Pure helpers, exported for the specs

/** floor(target × (1 + tolerance/100)): overTargetFinding's limit, the same expression. */
export function limitMinutes(target: number, tolerance: number): number {
  return Math.floor(target + (target * tolerance) / 100);
}

/**
 * The model's ceiling in tenths: any load at or under it is a load loadStatus
 * calls OK (C3). Σ ≤ 10L + 4 ⇒ exact ≤ L + 0.4 ⇒ Math.round ≤ L ⇒ not OVER,
 * and the charges and fixed load it is compared with are rounded UP.
 */
export function limitTenthsOf(target: number, tolerance: number): number {
  return 10 * limitMinutes(target, tolerance) + 4;
}

/**
 * The band's lower edge in tenths: any load at or over it rounds to a minute
 * loadStatus does not call UNDER. Not UNDER ⟺ round(x) ≥ target − band ⟺
 * x ≥ ceil(target − band) − 0.5, with loadStatus's own float expression.
 */
export function floorTenthsOf(target: number, tolerance: number): number {
  return Math.max(0, 10 * Math.ceil(target - (target * tolerance) / 100) - 5);
}

/** Minutes to whole tenths, rounded UP so the model never undercharges (C3). */
export function toTenthsUp(minutes: number): number {
  return Math.max(0, Math.ceil(10 * minutes - 1e-6));
}

/**
 * Who leads what, before anything is sent: free or fixed, kept or open, the
 * charges in tenths, the eligibility, and each teacher's target, limit and
 * fixed load. Pure; the order is canonical (rows and teachers by real id).
 */
export function planOf(
  state: Pick<StaffingState, 'read' | 'policy' | 'staffIds' | 'lastYear'>,
  dto: Pick<StaffingProposalDto, 'onlyUnstaffed' | 'respectQualifications' | 'pinnedRequirementIds'>,
): Plan {
  const input = state.read.input;
  const loadPolicy = input.policy ?? DEFAULT_LOAD_POLICY;
  const tolerance = loadPolicy.overAllocationTolerancePercent;
  const staffIds = [...new Set(state.staffIds)].sort(compareIds);
  const staff = new Set(staffIds);
  const recorded = input.qualifications.length > 0;
  const respect = recorded && (dto.respectQualifications || state.policy.qualificationMode === 'REFUSE');
  const respectForcedByPolicy = recorded && !dto.respectQualifications && state.policy.qualificationMode === 'REFUSE';
  const yearRows = new Set(input.requirements.map((row) => row.id));
  const pinnedAsked = new Set(dto.pinnedRequirementIds ?? []);
  const pinned = [...pinnedAsked].filter((id) => yearRows.has(id)).sort(compareIds);

  // Behörigheter by subject, so a row reads only its subject's.
  const qualificationsBySubject = new Map<string, LoadQualification[]>();
  for (const qualification of input.qualifications) {
    const list = qualificationsBySubject.get(qualification.subjectId);
    if (list) list.push(qualification);
    else qualificationsBySubject.set(qualification.subjectId, [qualification]);
  }

  const rows = [...input.requirements].sort((a, b) => compareIds(a.id, b.id)).map((row): RowPlan => {
    const inconsistent = row.teacherId !== null && row.teacherId === row.coTeacherId;
    const free =
      !inconsistent &&
      !pinnedAsked.has(row.id) &&
      (!dto.onlyUnstaffed || row.teacherId === null || !staff.has(row.teacherId));
    const current = !inconsistent && row.teacherId !== null && staff.has(row.teacherId) ? row.teacherId : null;
    const co = !inconsistent && row.coTeacherId !== null && staff.has(row.coTeacherId) ? row.coTeacherId : null;
    const charged = chargedMinutes(row, input.year, input.closures);
    let eligible: string[] = [];
    let lastYear: string[] = [];
    if (free) {
      const holders = recorded
        ? new Set(
            (qualificationsBySubject.get(row.subjectId) ?? [])
              .filter((qualification) => qualificationCovers(qualification, row, input.year))
              .map((qualification) => qualification.userId),
          )
        : subjectFamiliarTeachers(input, row.id, state.lastYear.get(row.id) ?? null);
      eligible = staffIds.filter((id) => holders.has(id));
      const taught = new Set(state.lastYear.get(row.id)?.teacherIds ?? []);
      lastYear = staffIds.filter((id) => taught.has(id)).slice(0, MAX_LAST_YEAR);
    }
    return {
      row,
      kind: !free ? 'FIXED' : current !== null ? 'KEPT' : 'OPEN',
      inconsistent,
      vacated: free && row.teacherId !== null && !staff.has(row.teacherId),
      current,
      co,
      chargeExact: charged.teacher,
      chargeTenths: Math.min(MAX_CHARGE_TENTHS, toTenthsUp(charged.teacher)),
      lessonMinutes: Math.min(MAX_LESSON_MINUTES, Math.max(0, Math.round(charged.lesson))),
      eligible,
      lastYear,
    };
  });

  // What nobody may move: every row with its free rows' leads taken off.
  const freeIds = new Set(rows.filter((row) => row.kind !== 'FIXED').map((row) => row.row.id));
  const fixed = countedMinutesByTeacher({
    ...input,
    requirements: input.requirements.map((row) => (freeIds.has(row.id) ? { ...row, teacherId: null } : row)),
  });
  const keptTenths = new Map<string, number>();
  for (const row of rows) {
    if (row.kind === 'KEPT') keptTenths.set(row.current!, (keptTenths.get(row.current!) ?? 0) + row.chargeTenths);
  }
  const employmentByUser = new Map(input.employments.map((row) => [row.userId, row]));
  const teachers = staffIds.map((userId): TeacherPlan => {
    const target = targetMinutesPerWeek(employmentByUser.get(userId) ?? null, loadPolicy);
    const fixedTenths = Math.min(MAX_FIXED_TENTHS, toTenthsUp(fixed.get(userId) ?? 0));
    const currentTenths = fixedTenths + (keptTenths.get(userId) ?? 0);
    const limitTenths = target === null ? null : limitTenthsOf(target, tolerance);
    return {
      userId,
      target,
      targetTenths: target === null ? null : 10 * target,
      limitTenths,
      floorTenths: target === null ? null : floorTenthsOf(target, tolerance),
      fixedTenths,
      currentTenths,
      // C1: a teacher is a candidate for new rows only with a target above 0
      // and today's load inside the limit. Everybody else keeps or sheds.
      keepOrShed: target === null || target <= 0 || currentTenths > limitTenths!,
    };
  });

  return {
    recorded,
    respect,
    respectForcedByPolicy,
    tolerance,
    staff,
    teachers,
    teacherById: new Map(teachers.map((teacher) => [teacher.userId, teacher])),
    rows,
    rowById: new Map(rows.map((row) => [row.row.id, row])),
    pinned,
  };
}

/** realId -> anonymous id, one map per id space, minted per request. */
interface StaffAnonMaps {
  teachers: Map<string, string>;
  requirements: Map<string, string>;
  groups: Map<string, string>;
  subjects: Map<string, string>;
}

/**
 * The payload, in canonical order — rows and teachers by real id, eligibility
 * sets in the order their first row names them — with fresh uuids. Accepted
 * and documented (C16): the order makes a teacher's POSITION the same across
 * two requests; the engine stores nothing, and the minutes link anyway.
 */
export function anonymise(
  requestId: string,
  plan: Plan,
  weights: StaffWeights | undefined,
): { payload: StaffRequest; maps: StaffAnonMaps } {
  const maps: StaffAnonMaps = { teachers: new Map(), requirements: new Map(), groups: new Map(), subjects: new Map() };
  const anon = (map: Map<string, string>, realId: string): string => {
    const existing = map.get(realId);
    if (existing) return existing;
    const id = randomUUID();
    map.set(realId, id);
    return id;
  };
  const teacher = (realId: string): string => {
    // Every id a row names was filtered through the staff set, and every staff
    // member is minted below first, so a miss is a programming error.
    const id = maps.teachers.get(realId);
    if (!id) throw new Error('staffing proposal: a row names a teacher who is not sent');
    return id;
  };

  const teachers: AnonymousStaffTeacher[] = plan.teachers.map((row) => ({
    id: anon(maps.teachers, row.userId),
    targetTenths: row.targetTenths,
    limitTenths: row.limitTenths,
    floorTenths: row.floorTenths,
    fixedTenths: row.fixedTenths,
  }));

  const sets = new Map<string, StaffEligibilitySet>();
  const requirements: AnonymousStaffRequirement[] = plan.rows.map((planned) => {
    const free = planned.kind !== 'FIXED';
    let eligibilitySetId: string | null = null;
    if (free && planned.eligible.length > 0) {
      const key = planned.eligible.join(',');
      let set = sets.get(key);
      if (!set) {
        set = { id: randomUUID(), teacherIds: planned.eligible.map(teacher) };
        sets.set(key, set);
      }
      eligibilitySetId = set.id;
    }
    const span = planned.row.gradeSpan;
    const sane = span !== null && span.min >= 0 && span.max <= MAX_GRADE && span.min <= span.max;
    return {
      id: anon(maps.requirements, planned.row.id),
      subjectId: anon(maps.subjects, planned.row.subjectId),
      studentGroupId: anon(maps.groups, planned.row.studentGroupId),
      chargeTenths: planned.chargeTenths,
      lessonMinutes: planned.lessonMinutes,
      minGradeLevel: sane ? span.min : null,
      maxGradeLevel: sane ? span.max : null,
      fixed: !free,
      currentTeacherId: planned.current === null ? null : teacher(planned.current),
      coTeacherId: planned.co === null ? null : teacher(planned.co),
      eligibilitySetId,
      lastYearTeacherIds: free ? planned.lastYear.map(teacher) : [],
    };
  });

  return {
    payload: {
      requestId,
      respectQualifications: plan.respect,
      qualificationsRecorded: plan.recorded,
      weights: weightsOf(weights),
      teachers,
      requirements,
      eligibilitySets: [...sets.values()],
    },
    maps,
  };
}

/** The weights the caller set, and nothing else: an absent one is the engine's default. */
function weightsOf(weights: StaffWeights | undefined): StaffWeights {
  const out: StaffWeights = {};
  for (const key of ['balance', 'classTeachers', 'continuity', 'keepCurrent', 'unqualified'] as const) {
    const value = weights?.[key];
    if (typeof value === 'number') out[key] = value;
  }
  return out;
}

/** The year with the proposal's leads laid over its free rows. */
function overlay(input: LoadInput, plan: Plan, leads: Map<string, string>): LoadInput {
  return {
    ...input,
    requirements: input.requirements.map((row) => {
      const planned = plan.rowById.get(row.id)!;
      if (planned.kind === 'FIXED') return row;
      return { ...row, teacherId: leads.get(row.id) ?? null };
    }),
  };
}

/**
 * The digest of everything a proposal read (§3.2): sorted by id, fields in a
 * fixed order, as arrays — a basis that moved with the query plan would refuse
 * every apply. The options are not in it: they are the question, not the
 * state. Names are not in it: a renamed group asks nothing new.
 */
export function basisOf(state: Pick<StaffingState, 'read' | 'policy' | 'staffIds' | 'lastYear'>): string {
  const input = state.read.input;
  const loadPolicy = input.policy ?? DEFAULT_LOAD_POLICY;
  const counted = new Map<string, number>();
  for (const duty of input.duties) {
    if (duty.countsAsTeaching) counted.set(duty.userId, (counted.get(duty.userId) ?? 0) + duty.minutesPerWeek);
  }
  const byFirst = (a: unknown[], b: unknown[]) => compareIds(JSON.stringify(a), JSON.stringify(b));
  const canonical = {
    year: [input.year.startDate, input.year.endDate],
    policy: [
      state.policy.fullTimeTeachingMinutesPerWeek,
      state.policy.overAllocationTolerancePercent,
      loadPolicy.loadModel ?? 'MINUTES',
      state.policy.qualificationMode,
      state.policy.overAllocationMode,
    ],
    requirements: [...input.requirements]
      .sort((a, b) => compareIds(a.id, b.id))
      .map((row) => [
        row.id,
        row.subjectId,
        row.studentGroupId,
        row.teacherId,
        row.coTeacherId,
        row.lessonsPerWeek,
        row.minutesPerLesson,
        [...(row.lessonLengths ?? [])],
        row.teacherLoadPercent,
        row.coTeacherLoadPercent,
        row.recurrence ?? 'ALL_WEEKS',
        row.startDate ?? null,
        row.endDate ?? null,
        row.gradeSpan ? [row.gradeSpan.min, row.gradeSpan.max] : null,
        row.loadWeight ?? 1,
        state.lastYear.get(row.id)?.teacherIds ?? null,
      ]),
    employments: input.employments
      .map((row) => [row.userId, row.employmentPercent, row.reductionPercent, row.teachingTargetMinutesPerWeek])
      .sort(byFirst),
    countedDuties: [...counted.entries()].sort((a, b) => compareIds(a[0], b[0])),
    qualifications: input.qualifications
      .map((row) => [row.userId, row.subjectId, row.minGradeLevel, row.maxGradeLevel, row.kind, row.validFrom, row.validTo])
      .sort(byFirst),
    closures: input.closures
      .map((row) => [row.startDate, row.endDate, row.minGradeLevel ?? null, row.maxGradeLevel ?? null])
      .sort(byFirst),
    staff: [...state.staffIds].sort(compareIds),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function stale(): ConflictException {
  return new ConflictException({
    message: 'Tjänstefördelningen har ändrats sedan förslaget beräknades. Beräkna ett nytt förslag.',
    code: STAFF_PROPOSAL_STALE,
  });
}

/** The engine's terms, copied field by field so an added field cannot ride through unannounced. */
function terms(value: StaffTerms): StaffTerms {
  return {
    unstaffedRows: value.unstaffedRows,
    unstaffedMinutes: value.unstaffedMinutes,
    deviationTenths: value.deviationTenths,
    underBandTenths: value.underBandTenths,
    newClassTeachers: value.newClassTeachers,
    continuityChanges: value.continuityChanges,
    currentChanges: value.currentChanges,
    unqualifiedAssignments: value.unqualifiedAssignments,
  };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function reverse(map: Map<string, string>): Map<string, string> {
  return new Map([...map].map(([realId, anonId]) => [anonId, realId]));
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
