import {
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma, type PrismaClient, type Ss12000SyncChange, type Ss12000SyncRun } from '@prisma/client';
import type { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { requireSchoolId } from '../../common/utils/request-context';
import { PrismaService } from '../../database/prisma.service';
import { applyChanges, type StoredChange } from './apply';
import { Ss12000Client, type ClientStats } from './client';
import { connectionOf, localDate, openSecrets, readSealed } from './connection';
import { brakeTripped, computeDiff, type ChangeEntity, type ChangeOp } from './diff';
import type { ApplyRunDto, ListChangesQueryDto, ListRunsQueryDto } from './dto';
import { sourceErrorCode, sqlStateOf } from './errors';
import { fetchRoster, type FetchedRoster } from './fetch-plan';
import { basisHash, readLocalSlice } from './local-slice';
import { Ss12000Outbound, Ss12000Secrets } from './ss12000-sync.providers';

/** The cursors trail the provider's clock by this much: writes in flight there, and clock skew. */
export const CURSOR_OVERLAP_MS = 10 * 60 * 1000;
/** The admin's apply refuses more deactivations than max(5, 10 %) of the linked active people unless confirmed. */
export const ADMIN_BRAKE = { floor: 5, percent: 10 };
/** A scheduled auto-apply stops at max(5, 2 %). */
export const AUTO_BRAKE = { floor: 5, percent: 2 };
/** A manual DIFF_READY younger than this keeps the nightly run from superseding it. */
export const REVIEW_WINDOW_MS = 24 * 60 * 60 * 1000;
/** The apply's transaction: a first sync of a few thousand rows, batched, with room to spare. */
const APPLY_TIMEOUT_MS = 120_000;

const NOTES: ReadonlySet<ChangeOp> = new Set(['CONFLICT', 'INFO']);

export type RunView = Ss12000SyncRun;

/**
 * The sync: one run reads the school's SS12000 source, compares it with the
 * school and writes a diff; an admin applies the selected changes in one
 * transaction (or, when the admin enabled it, the nightly run applies the
 * safe ones). Design: the SS-0 spec as amended by its review; migrations
 * 20261014090000–20261014110000.
 *
 * NO DATABASE TRANSACTION IS HELD WHILE THE SOURCE IS CALLED. A run is
 *   T1 (sync principal): the run, the source, its sealed credentials, the
 *      linked ids, the school's timezone;
 *   the fetch, over the network, with nothing open;
 *   T2 (sync principal): the local slice, the diff, the changes, the run's
 *      status — and, for a run with nothing to change, the cursors.
 * A fetch that does not complete, or a FULL fetch that comes back empty
 * while linked people exist (SS12000_SOURCE_EMPTY: a changed client scope at
 * the provider answers 200 with nothing), produces no diff, so a half-read
 * roster never turns into deactivations.
 *
 * NOTHING CHANGES UNTIL AN APPLY. The apply locks the source (lock_timeout
 * 10 s, 409 SS12000_BUSY), requires the newest DIFF_READY run, recomputes
 * the basis hash over the rows it locks (409 SS12000_DIFF_STALE when the
 * school or the cursors moved), brakes on mass deactivation, writes in
 * dependency order (apply.ts) and moves the cursors in the same
 * transaction. A run is the log: trigger, mode, status, counts, error codes,
 * who applied it. No name, email, URL query or header reaches a log line.
 */
@Injectable()
export class Ss12000SyncService {
  private readonly logger = new Logger(Ss12000SyncService.name);
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: Ss12000Secrets,
    private readonly outbound: Ss12000Outbound,
  ) {}

  /** Resolves once every run started in the background has finished (tests, shutdown). */
  async whenIdle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  private background(work: () => Promise<void>): void {
    const promise = new Promise<void>((resolve) => setImmediate(resolve)).then(work).catch((error: unknown) => {
      this.logger.warn(`SS12000 sync failed in the background [${error instanceof Error ? error.name : 'unknown'}]`);
    });
    this.inFlight.add(promise);
    void promise.finally(() => this.inFlight.delete(promise));
  }

  // -------------------------------------------------------------------------
  // Starting a run
  // -------------------------------------------------------------------------

  /** "Synka nu": 202 {runId}; the fetch and the diff run after the answer. */
  async startManualRun(user: AuthenticatedUser, requested: 'FULL' | 'INCREMENTAL'): Promise<{ runId: string; mode: 'FULL' | 'INCREMENTAL' }> {
    const schoolId = requireSchoolId(user);
    if (!this.secrets.box.configured) {
      throw new ServiceUnavailableException({
        message: 'Synken kan inte läsa källsystemets hemligheter: INTEGRATION_SECRETS_KEY är inte konfigurerad.',
        code: 'SS12000_SECRETS_NOT_CONFIGURED',
      });
    }
    let created: { runId: string; mode: 'FULL' | 'INCREMENTAL' };
    try {
      created = await this.prisma.withRls(user, async (tx) => {
        const source = await tx.ss12000Source.findFirst({ where: { schoolId } });
        if (!source) throw new NotFoundException({ message: 'Skolan har inget källsystem.', code: 'SS12000_SOURCE_NOT_FOUND' });
        if (!source.enabled) throw new ConflictException({ message: 'Källsystemet är avstängt.', code: 'SS12000_SOURCE_DISABLED' });
        if (source.organisationIds.length === 0) {
          throw new ConflictException({ message: 'Välj skolenhet efter att ha testat anslutningen.', code: 'SS12000_SOURCE_NO_ORGANISATION' });
        }
        const running = await tx.ss12000SyncRun.findFirst({ where: { sourceId: source.id, status: 'RUNNING' }, select: { id: true } });
        if (running) throw this.runInProgress();
        const mode = requested === 'INCREMENTAL' && this.canRunIncrementally(source) ? 'INCREMENTAL' : 'FULL';
        const run = await tx.ss12000SyncRun.create({
          data: { schoolId, sourceId: source.id, trigger: 'MANUAL', mode, requestedById: user.userId ?? null },
          select: { id: true },
        });
        return { runId: run.id, mode };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw this.runInProgress();
      throw error;
    }
    this.background(() => this.execute(created.runId, schoolId, { autoApply: false }));
    return created;
  }

  private runInProgress(): ConflictException {
    return new ConflictException({ message: 'En synk pågår redan.', code: 'SS12000_RUN_IN_PROGRESS' });
  }

  private canRunIncrementally(source: { modifiedCursor: Date | null; deletedCursor: Date | null; incrementalUnsupported: boolean }) {
    return source.modifiedCursor !== null && source.deletedCursor !== null && !source.incrementalUnsupported;
  }

  /**
   * The nightly run of a claimed source (Ss12000SchedulerService). A manual
   * diff younger than 24 h waiting for its admin is not superseded: the
   * night records a SKIPPED run (REVIEW_PENDING) instead.
   */
  async startScheduledRun(sourceId: string, schoolId: string, fullDue: boolean): Promise<string | null> {
    let started: { runId: string; autoApply: boolean } | null;
    try {
      started = await this.prisma.withSyncPrincipal(schoolId, async (tx) => {
        const source = await tx.ss12000Source.findFirst({ where: { id: sourceId, schoolId } });
        if (!source || !source.enabled || !source.scheduleEnabled || source.organisationIds.length === 0) return null;
        const mode = !fullDue && this.canRunIncrementally(source) ? 'INCREMENTAL' : 'FULL';
        const pending = await tx.ss12000SyncRun.findFirst({
          where: { sourceId, status: 'DIFF_READY', trigger: 'MANUAL', startedAt: { gte: new Date(Date.now() - REVIEW_WINDOW_MS) } },
          select: { id: true },
        });
        if (pending) {
          await tx.ss12000SyncRun.create({
            data: { schoolId, sourceId, trigger: 'SCHEDULED', mode, status: 'SKIPPED', statusCode: 'REVIEW_PENDING', finishedAt: new Date() },
          });
          return null;
        }
        if (await tx.ss12000SyncRun.findFirst({ where: { sourceId, status: 'RUNNING' }, select: { id: true } })) return null;
        const run = await tx.ss12000SyncRun.create({ data: { schoolId, sourceId, trigger: 'SCHEDULED', mode }, select: { id: true } });
        return { runId: run.id, autoApply: source.scheduleAutoApply };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return null;
      throw error;
    }
    if (!started) return null;
    await this.execute(started.runId, schoolId, { autoApply: started.autoApply });
    return started.runId;
  }

  // -------------------------------------------------------------------------
  // Fetch and diff
  // -------------------------------------------------------------------------

  /** Fetch, diff and record one RUNNING run. Never throws: a failure is the run's status. */
  async execute(runId: string, schoolId: string, options: { autoApply: boolean }): Promise<void> {
    let stats: ClientStats = { requests: 0, retries: 0, pages: 0 };
    try {
      const context = await this.prisma.withSyncPrincipal(schoolId, async (tx) => {
        const run = await tx.ss12000SyncRun.findFirst({ where: { id: runId, schoolId } });
        if (!run || run.status !== 'RUNNING') return null;
        const source = await tx.ss12000Source.findFirst({ where: { id: run.sourceId, schoolId } });
        if (!source) return null;
        const rows = await readSealed(tx, source.id);
        const linked = await tx.user.findMany({ where: { schoolId, ss12000Id: { not: null } }, select: { ss12000Id: true } });
        const school = await tx.school.findFirst({ where: { id: schoolId }, select: { timezone: true } });
        return { run, source, rows, linked: new Set(linked.map((user) => user.ss12000Id as string)), timezone: school?.timezone ?? 'Europe/Stockholm' };
      });
      if (!context) return;
      const { run, source } = context;
      if (!source.enabled) return await this.fail(runId, schoolId, 'SS12000_SOURCE_DISABLED', stats);
      if (source.organisationIds.length === 0) return await this.fail(runId, schoolId, 'SS12000_SOURCE_NO_ORGANISATION', stats);

      const today = localDate(context.timezone);
      let roster: FetchedRoster;
      let client: Ss12000Client | null = null;
      try {
        client = new Ss12000Client(connectionOf(source, openSecrets(this.secrets.box, source, context.rows)), this.outbound.clientOptions());
        stats = client.stats;
        roster = await fetchRoster(client, {
          organisationIds: source.organisationIds,
          today,
          mode: run.mode,
          modifiedCursor: source.modifiedCursor,
          deletedCursor: source.deletedCursor,
          linkedPersonIds: context.linked,
          pageSize: source.pageSize,
        });
      } catch (error) {
        return await this.fail(runId, schoolId, sourceErrorCode(error), stats);
      }
      const providerClock = client.providerClock ?? new Date();
      const cursorTo = new Date(providerClock.getTime() - CURSOR_OVERLAP_MS);

      const status = await this.prisma.withSyncPrincipal(
        schoolId,
        async (tx) => {
          const fresh = await tx.ss12000Source.findFirst({ where: { id: source.id, schoolId } });
          if (!fresh) return 'GONE' as const;
          const slice = await readLocalSlice(tx, schoolId, { lock: false });
          slice.lastAppliedAt = fresh.lastAppliedAt;
          const diff = computeDiff({ roster, local: slice, today, organisationIds: fresh.organisationIds });
          const counts = { ...diff.counts, fetch: { ...stats, invalid: roster.invalid.length } };
          const errors = roster.invalid.slice(0, 200).map((record) => ({ code: 'INVALID_RECORD', entity: record.entity, externalId: record.externalId }));
          const codes = roster.organisations.map((organisation) => organisation.schoolUnitCode).filter((code): code is string => code !== null);
          await tx.ss12000Source.update({
            where: { id: fresh.id },
            data: {
              ...(roster.incrementalUnsupported ? { incrementalUnsupported: true } : {}),
              ...(codes.join(',') !== fresh.schoolUnitCodes.join(',') ? { schoolUnitCodes: codes.slice(0, 5) } : {}),
            },
          });
          const common = {
            mode: roster.mode,
            fetchedAt: new Date(),
            providerClock,
            cursorFromModified: roster.mode === 'INCREMENTAL' ? fresh.modifiedCursor : null,
            cursorFromDeleted: roster.mode === 'INCREMENTAL' ? fresh.deletedCursor : null,
            cursorTo,
            counts: counts as Prisma.InputJsonValue,
            errors: errors as Prisma.InputJsonValue,
          };
          if (diff.sourceEmpty) {
            await tx.ss12000SyncRun.update({
              where: { id: runId },
              data: { ...common, status: 'FETCH_FAILED', statusCode: 'SS12000_SOURCE_EMPTY', finishedAt: new Date() },
            });
            return 'FETCH_FAILED' as const;
          }
          const rows = diff.changes.map((change, seq) => ({
            runId,
            schoolId,
            seq,
            entity: change.entity,
            op: change.op,
            externalId: change.externalId,
            localId: change.localId,
            before: change.before === null ? Prisma.DbNull : (change.before as Prisma.InputJsonValue),
            after: change.after === null ? Prisma.DbNull : (change.after as Prisma.InputJsonValue),
            conflictCode: change.conflictCode,
            selected: change.selected,
            autoApplicable: change.autoApplicable,
            protectedIdentity: change.protectedIdentity,
          }));
          for (let at = 0; at < rows.length; at += 1000) {
            await tx.ss12000SyncChange.createMany({ data: rows.slice(at, at + 1000) });
          }
          // Nothing to apply and nothing to resolve — at most notes (a pupil
          // enrolled from next month, a group spanning two läsår): the run is
          // NO_CHANGES and the cursors move, or a standing note would keep
          // every night's run waiting for an admin. The notes stay, with
          // their codes and ids; the status minimises their payloads.
          if (diff.changes.every((change) => change.op === 'INFO')) {
            await tx.ss12000SyncRun.update({ where: { id: runId }, data: { ...common, status: 'NO_CHANGES', finishedAt: new Date() } });
            await tx.ss12000Source.update({
              where: { id: fresh.id },
              data: { modifiedCursor: cursorTo, deletedCursor: cursorTo, ...(roster.mode === 'FULL' ? { lastFullAt: run.startedAt } : {}) },
            });
            return 'NO_CHANGES' as const;
          }
          // Only the newest diff can be applied.
          await tx.ss12000SyncRun.updateMany({
            where: { sourceId: fresh.id, schoolId, status: 'DIFF_READY', id: { not: runId } },
            data: { status: 'SUPERSEDED', finishedAt: new Date() },
          });
          await tx.ss12000SyncRun.update({
            where: { id: runId },
            data: { ...common, status: 'DIFF_READY', basisHash: basisHash(slice, fresh) },
          });
          return 'DIFF_READY' as const;
        },
        { timeoutMs: APPLY_TIMEOUT_MS },
      );
      this.logger.log(
        `SS12000 sync [school=${schoolId}, run=${runId}, mode=${roster.mode}, status=${status}, requests=${stats.requests}, pages=${stats.pages}, retries=${stats.retries}]`,
      );
      if (status === 'DIFF_READY' && options.autoApply) await this.autoApply(runId, schoolId);
    } catch (error) {
      await this.fail(runId, schoolId, sqlStateOf(error) ? 'SS12000_DATABASE' : 'SS12000_UNEXPECTED', stats).catch(() => undefined);
    }
  }

  private async fail(runId: string, schoolId: string, code: string, stats: ClientStats): Promise<void> {
    await this.prisma.withSyncPrincipal(schoolId, (tx) =>
      tx.ss12000SyncRun.updateMany({
        where: { id: runId, schoolId, status: 'RUNNING' },
        data: {
          status: 'FETCH_FAILED',
          statusCode: code,
          finishedAt: new Date(),
          counts: { fetch: { ...stats } } as Prisma.InputJsonValue,
        },
      }),
    );
    this.logger.warn(`SS12000 sync failed [school=${schoolId}, run=${runId}, code=${code}, requests=${stats.requests}]`);
  }

  // -------------------------------------------------------------------------
  // Applying
  // -------------------------------------------------------------------------

  /**
   * The nightly auto-apply, under the sync principal: only the changes the
   * diff marked autoApplicable (names, a class move, a teaching-group add, a
   * guardian link between linked unprotected people, a duty link, a pupil's
   * or guardian's deactivation), only if the run's basis still holds, and
   * not at all when the deactivations exceed max(5, 2 %) of the linked
   * active people. What is left waits for the admin; the cursors move only
   * when nothing selected is left.
   */
  async autoApply(runId: string, schoolId: string): Promise<void> {
    const result = await this.prisma.withSyncPrincipal(
      schoolId,
      async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '10s'`;
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Ss12000Sources" WHERE "schoolId" = ${schoolId}::uuid FOR UPDATE`);
        const run = await tx.ss12000SyncRun.findFirst({ where: { id: runId, schoolId } });
        if (!run || run.status !== 'DIFF_READY') return 'NOT_APPLICABLE';
        const source = await tx.ss12000Source.findFirst({ where: { id: run.sourceId, schoolId } });
        if (!source) return 'NOT_APPLICABLE';
        const slice = await readLocalSlice(tx, schoolId, { lock: true });
        if (basisHash(slice, source) !== run.basisHash) return 'STALE';
        const changes = await tx.ss12000SyncChange.findMany({ where: { runId, schoolId }, orderBy: { seq: 'asc' } });
        const auto = changes.filter((change) => !change.applied && change.selected && change.autoApplicable && !NOTES.has(change.op));
        const linkedActive = slice.users.filter((user) => user.ss12000Id && user.isActive).length;
        if (brakeTripped(auto, linkedActive, AUTO_BRAKE.floor, AUTO_BRAKE.percent)) {
          await tx.ss12000SyncRun.update({ where: { id: runId }, data: { autoApplyBlockedReason: 'MASS_DEACTIVATION' } });
          return 'BLOCKED';
        }
        if (auto.length === 0) return 'NOTHING';
        const stamp = new Date();
        const outcome = await applyChanges(tx, schoolId, auto.map(storedOf), stamp);
        await this.markApplied(tx, schoolId, outcome.applied);
        const applied = new Set(outcome.applied);
        const remaining = changes.some((change) => change.selected && !change.applied && !NOTES.has(change.op) && !applied.has(change.id));
        const errors = [...asArray(run.errors), ...outcome.skipped.map(({ code, entity, externalId }) => ({ code, entity, externalId }))].slice(0, 200);
        if (!remaining) {
          await tx.ss12000SyncRun.update({
            where: { id: runId },
            data: {
              status: 'APPLIED',
              autoApplied: true,
              appliedAt: stamp,
              finishedAt: stamp,
              errors: errors as Prisma.InputJsonValue,
              counts: { ...asObject(run.counts), applied: { auto: outcome.applied.length, skipped: outcome.skipped.length } } as Prisma.InputJsonValue,
            },
          });
          await tx.ss12000Source.update({
            where: { id: source.id },
            data: {
              lastAppliedAt: stamp,
              modifiedCursor: run.cursorTo,
              deletedCursor: run.cursorTo,
              ...(run.mode === 'FULL' ? { lastFullAt: run.startedAt } : {}),
            },
          });
          return 'APPLIED';
        }
        // The rest waits for the admin, against the school as it is now.
        await tx.ss12000Source.update({ where: { id: source.id }, data: { lastAppliedAt: stamp } });
        const after = await readLocalSlice(tx, schoolId, { lock: false });
        await tx.ss12000SyncRun.update({
          where: { id: runId },
          data: {
            autoApplied: true,
            basisHash: basisHash(after, source),
            errors: errors as Prisma.InputJsonValue,
            counts: { ...asObject(run.counts), applied: { auto: outcome.applied.length, skipped: outcome.skipped.length } } as Prisma.InputJsonValue,
          },
        });
        return 'PARTIAL';
      },
      { timeoutMs: APPLY_TIMEOUT_MS },
    );
    this.logger.log(`SS12000 auto-apply [school=${schoolId}, run=${runId}, outcome=${result}]`);
  }

  private async markApplied(tx: PrismaClient, schoolId: string, ids: string[]): Promise<void> {
    for (let at = 0; at < ids.length; at += 1000) {
      await tx.ss12000SyncChange.updateMany({ where: { id: { in: ids.slice(at, at + 1000) }, schoolId }, data: { applied: true } });
    }
  }

  /** The admin's apply of a DIFF_READY run, in one transaction. */
  async apply(user: AuthenticatedUser, runId: string, dto: ApplyRunDto): Promise<RunView> {
    const schoolId = requireSchoolId(user);
    try {
      return await this.prisma.withRls(
        user,
        async (tx) => {
          await tx.$executeRaw`SET LOCAL lock_timeout = '10s'`;
          const locked = await tx.$queryRaw<Array<{ id: string }>>(
            Prisma.sql`SELECT "id" FROM "Ss12000Sources" WHERE "schoolId" = ${schoolId}::uuid FOR UPDATE`,
          );
          if (!locked?.length) throw new NotFoundException({ message: 'Skolan har inget källsystem.', code: 'SS12000_SOURCE_NOT_FOUND' });
          const run = await tx.ss12000SyncRun.findFirst({ where: { id: runId, schoolId } });
          if (!run) throw new NotFoundException({ message: 'Ingen sådan synk.', code: 'SS12000_RUN_NOT_FOUND' });
          if (run.status !== 'DIFF_READY') {
            throw new ConflictException({ message: 'Synken kan inte tillämpas i sitt läge.', code: 'SS12000_RUN_NOT_APPLICABLE', params: { status: run.status } });
          }
          const stale = () =>
            new ConflictException({
              message: 'Registret eller SchemaPro har ändrats sedan hämtningen – hämta igen.',
              code: 'SS12000_DIFF_STALE',
            });
          if (dto.basisHash !== run.basisHash) throw stale();
          const source = await tx.ss12000Source.findFirst({ where: { id: run.sourceId, schoolId } });
          if (!source) throw new NotFoundException({ message: 'Skolan har inget källsystem.', code: 'SS12000_SOURCE_NOT_FOUND' });
          const slice = await readLocalSlice(tx, schoolId, { lock: true });
          if (basisHash(slice, source) !== run.basisHash) throw stale();

          const changes = await tx.ss12000SyncChange.findMany({ where: { runId, schoolId }, orderBy: { seq: 'asc' } });
          const select = new Set(dto.select ?? []);
          const deselect = new Set(dto.deselect ?? []);
          const open = changes.filter((change) => !change.applied && !NOTES.has(change.op));
          const chosen = open.filter((change) => select.has(change.id) || (change.selected && !deselect.has(change.id)));
          const linkedActive = slice.users.filter((u) => u.ss12000Id && u.isActive).length;
          if (!dto.confirmMassDeactivation && brakeTripped(chosen, linkedActive, ADMIN_BRAKE.floor, ADMIN_BRAKE.percent)) {
            throw new ConflictException({
              message: 'Ovanligt många avaktiveringar. Bekräfta att de ska göras.',
              code: 'SS12000_MASS_DEACTIVATION',
              params: {
                deactivations: chosen.filter((change) => change.op === 'DEACTIVATE').length,
                limit: Math.max(ADMIN_BRAKE.floor, Math.floor((linkedActive * ADMIN_BRAKE.percent) / 100)),
              },
            });
          }

          const stamp = new Date();
          const outcome = await applyChanges(tx, schoolId, chosen.map(storedOf), stamp);
          // The admin's choice, recorded as made.
          const chosenIds = new Set(chosen.map((change) => change.id));
          const nowSelected = open.filter((change) => !change.selected && chosenIds.has(change.id)).map((change) => change.id);
          const nowDeselected = open.filter((change) => change.selected && !chosenIds.has(change.id)).map((change) => change.id);
          for (const [ids, selected] of [[nowSelected, true], [nowDeselected, false]] as const) {
            for (let at = 0; at < ids.length; at += 1000) {
              await tx.ss12000SyncChange.updateMany({ where: { id: { in: ids.slice(at, at + 1000) }, schoolId }, data: { selected } });
            }
          }
          await this.markApplied(tx, schoolId, outcome.applied);
          const errors = [...asArray(run.errors), ...outcome.skipped.map(({ code, entity, externalId }) => ({ code, entity, externalId }))].slice(0, 200);
          const updated = await tx.ss12000SyncRun.update({
            where: { id: runId },
            data: {
              status: 'APPLIED',
              appliedAt: stamp,
              appliedById: user.userId ?? null,
              finishedAt: stamp,
              errors: errors as Prisma.InputJsonValue,
              counts: {
                ...asObject(run.counts),
                applied: { admin: outcome.applied.length, skipped: outcome.skipped.length, deselected: open.length - chosen.length },
              } as Prisma.InputJsonValue,
            },
          });
          await tx.ss12000Source.update({
            where: { id: source.id },
            data: {
              lastAppliedAt: stamp,
              modifiedCursor: run.cursorTo,
              deletedCursor: run.cursorTo,
              ...(run.mode === 'FULL' ? { lastFullAt: run.startedAt } : {}),
            },
          });
          this.logger.log(
            `SS12000 apply [school=${schoolId}, run=${runId}, applied=${outcome.applied.length}, skipped=${outcome.skipped.length}]`,
          );
          return updated;
        },
        { timeoutMs: APPLY_TIMEOUT_MS },
      );
    } catch (error) {
      if (error instanceof HttpException) throw error;
      const state = sqlStateOf(error);
      if (state === '55P03') {
        throw new ConflictException({ message: 'En annan synk tillämpas just nu. Försök igen strax.', code: 'SS12000_BUSY' });
      }
      // A row the database refused: the transaction rolled back whole, and
      // the run is recorded as failed so the admin runs it again.
      const code = state ? `SS12000_APPLY_${state}` : 'SS12000_APPLY_FAILED';
      await this.prisma
        .withRls(user, (tx) =>
          tx.ss12000SyncRun.updateMany({
            where: { id: runId, schoolId, status: 'DIFF_READY' },
            data: { status: 'APPLY_FAILED', statusCode: code.slice(0, 64), finishedAt: new Date() },
          }),
        )
        .catch(() => undefined);
      this.logger.warn(`SS12000 apply failed [school=${schoolId}, run=${runId}, code=${code}]`);
      throw new ConflictException({ message: 'Ändringarna kunde inte tillämpas; inget sparades. Hämta igen.', code: 'SS12000_APPLY_FAILED' });
    }
  }

  async discard(user: AuthenticatedUser, runId: string): Promise<RunView> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const run = await tx.ss12000SyncRun.findFirst({ where: { id: runId, schoolId } });
      if (!run) throw new NotFoundException({ message: 'Ingen sådan synk.', code: 'SS12000_RUN_NOT_FOUND' });
      if (run.status !== 'DIFF_READY') {
        throw new ConflictException({ message: 'Synken kan inte kastas i sitt läge.', code: 'SS12000_RUN_NOT_APPLICABLE', params: { status: run.status } });
      }
      return tx.ss12000SyncRun.update({ where: { id: runId }, data: { status: 'DISCARDED', finishedAt: new Date() } });
    });
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async listRuns(user: AuthenticatedUser, query: ListRunsQueryDto): Promise<RunView[]> {
    const schoolId = requireSchoolId(user);
    const limit = query.limit ? Number(query.limit) : 20;
    return this.prisma.queryWithRls(user, (db) =>
      db.ss12000SyncRun.findMany({
        where: { schoolId, ...(query.before ? { startedAt: { lt: new Date(query.before) } } : {}) },
        orderBy: { startedAt: 'desc' },
        take: limit,
      }),
    );
  }

  async getRun(user: AuthenticatedUser, runId: string): Promise<RunView> {
    const schoolId = requireSchoolId(user);
    const run = await this.prisma.queryWithRls(user, (db) => db.ss12000SyncRun.findFirst({ where: { id: runId, schoolId } }));
    if (!run) throw new NotFoundException({ message: 'Ingen sådan synk.', code: 'SS12000_RUN_NOT_FOUND' });
    return run;
  }

  async listChanges(
    user: AuthenticatedUser,
    runId: string,
    query: ListChangesQueryDto,
  ): Promise<{ data: Ss12000SyncChange[]; nextCursor: number | null }> {
    const schoolId = requireSchoolId(user);
    const limit = query.limit ? Number(query.limit) : 200;
    const rows = await this.prisma.queryWithRls(user, (db) =>
      db.ss12000SyncChange.findMany({
        where: {
          runId,
          schoolId,
          ...(query.entity ? { entity: query.entity } : {}),
          ...(query.op ? { op: query.op } : {}),
          ...(query.conflicts === 'true' ? { conflictCode: { not: null } } : {}),
          ...(query.cursor ? { seq: { gt: Number(query.cursor) } } : {}),
        },
        orderBy: { seq: 'asc' },
        take: limit + 1,
      }),
    );
    const data = rows.slice(0, limit);
    return { data, nextCursor: rows.length > limit ? (data[data.length - 1]?.seq ?? null) : null };
  }

  /**
   * "Nya personer": linked, active people never invited. An invitation is
   * still the existing explicit act (POST /api/v1/users/invitations, at most
   * 500 ids a call); nothing here creates an identity or sends mail.
   */
  async provisioning(user: AuthenticatedUser) {
    const schoolId = requireSchoolId(user);
    return this.prisma.queryWithRls(user, (db) =>
      db.user.findMany({
        where: { schoolId, ss12000Id: { not: null }, isActive: true, invitedAt: null },
        select: { id: true, role: true, firstName: true, lastName: true, email: true, studentGroup: { select: { id: true, name: true } } },
        orderBy: [{ role: 'asc' }, { lastName: 'asc' }, { firstName: 'asc' }],
        take: 5000,
      }),
    );
  }
}

function storedOf(change: Ss12000SyncChange): StoredChange {
  return {
    id: change.id,
    seq: change.seq,
    entity: change.entity as ChangeEntity,
    op: change.op as ChangeOp,
    externalId: change.externalId,
    localId: change.localId,
    after: asObject(change.after),
  };
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
