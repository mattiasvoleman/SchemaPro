import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type AdminProfile, type PrismaClient } from '@prisma/client';
import { Role } from '../auth/enums/role.enum';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import type { SchoolExportConfig } from '../config/configuration';
import { PrismaService } from '../database/prisma.service';
import { FamilyReadsService } from '../family/family-reads.service';
import { errorName, JobRunner, type JobCounts } from '../jobs/job-runner';
import { ScheduleExchangeService } from '../schedule-exchange/exchange.service';
import { Audit, buildArchive, type BuildContext } from './build';
import { ChunkSink } from './chunk-sink';
import { DATA_FILES } from './data-files';
import { listFiles, readLists } from './lists';
import {
  CHUNK_BYTES,
  EXPORT_KEEP_INTERVAL,
  HEARTBEAT_EVERY_MS,
  LEASE_SECONDS,
  LEDGER_INTERVAL,
  POLL_INTERVAL_MS,
  SCHOOL_EXPORT_JOB,
} from './school-export';
import { StreamingZip } from './zip-stream';

/** app.school_export_claim's one row. */
interface Claimed {
  export_id: string;
  school_id: string;
  user_id: string;
  auth_id: string;
  admin_profile: AdminProfile;
  hr_read: boolean;
  attempt: number;
}

/** The export was withdrawn, or another instance took it over: stop and write nothing more. */
export class ExportWithdrawn extends Error {
  constructor() {
    super('The export is no longer this job\'s.');
    this.name = 'ExportWithdrawn';
  }
}

/** The ordering administrator may no longer decide: nothing is read for them. */
export class RequesterNotAllowed extends Error {
  constructor() {
    super('The administrator who ordered the export may no longer decide.');
    this.name = 'RequesterNotAllowed';
  }
}

/**
 * The whole-school export's job (K5, 20270110090000), a job of the JobRunner.
 * Off when SCHOOL_EXPORT_BACKGROUND=off (the test setup). A pass:
 *
 *   1. app.school_export_expire: files past their time lose their pieces,
 *      old finished orders go;
 *   2. app.school_export_claim: the oldest QUEUED order, or a RUNNING one
 *      whose heartbeat is older than the lease; FOR UPDATE SKIP LOCKED, so two
 *      API instances never build one file twice;
 *   3. the build (below), then app.school_export_finish, which counts the
 *      stored pieces against what the build says it wrote.
 *
 * THE BUILD IS THE ORDERING ADMINISTRATOR'S. Every read is `withRls` as the
 * login and school of the person who ordered, so row-level security keeps
 * every other school's row out of the file, and a person who has been
 * demoted, deactivated or removed since the order gets nothing (the claim
 * refuses such an order, and each read is judged again as it is made). The
 * pieces are written by app.school_export_put, which takes the school from the
 * export.
 *
 * MEMORY. The zip is deflated as it is written and cut into 1 MiB pieces that
 * go to the database one at a time (StreamingZip, ChunkSink); a data file is
 * read a batch at a time (a day of attendance, five thousand rows of the
 * rest). What is held is one batch of rows, one piece and the lists (a
 * school's people and subjects, a few thousand rows): not the school.
 *
 * It logs ids, counts and an error class, never a name.
 */
@Injectable()
export class SchoolExportJob implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SchoolExportJob.name);
  private running: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly family: FamilyReadsService,
    private readonly exchange: ScheduleExchangeService,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly jobs?: JobRunner,
  ) {}

  onModuleInit(): void {
    if (this.config?.get<SchoolExportConfig>('schoolExport')?.background !== true || !this.jobs) return;
    this.jobs.register({ name: SCHOOL_EXPORT_JOB, intervalMs: POLL_INTERVAL_MS, tick: () => this.tick() });
  }

  onModuleDestroy(): void {
    this.jobs?.unregister(SCHOOL_EXPORT_JOB);
  }

  get scheduled(): boolean {
    return this.jobs?.isScheduled(SCHOOL_EXPORT_JOB) ?? false;
  }

  /** One pass; a tick while the last one runs waits for it instead. Never throws. */
  async tick(): Promise<void> {
    if (this.running) return this.running;
    const started = new Date();
    this.running = this.pass()
      .then((counts) => this.jobs?.settled(SCHOOL_EXPORT_JOB, started, { ok: true, counts }))
      .catch((error: unknown) => {
        this.logger.warn(`School export pass failed [${errorName(error)}]`);
        this.jobs?.settled(SCHOOL_EXPORT_JOB, started, { ok: false, error: errorName(error) });
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private async pass(): Promise<JobCounts> {
    const [expired] = await this.prisma.withDeliveryService((tx) =>
      tx.$queryRaw<Array<{ expired: number; purged: number }>>(
        Prisma.sql`SELECT expired, purged FROM app.school_export_expire(${LEDGER_INTERVAL}::interval)`,
      ),
    );
    const [claimed] = await this.prisma.withDeliveryService((tx) =>
      tx.$queryRaw<Claimed[]>(
        Prisma.sql`SELECT export_id, school_id, user_id, auth_id, admin_profile, hr_read, attempt
                     FROM app.school_export_claim(make_interval(secs => ${LEASE_SECONDS}))`,
      ),
    );
    const counts: JobCounts = { claimed: claimed ? 1 : 0, expired: expired?.expired ?? 0, purged: expired?.purged ?? 0, built: 0, failed: 0 };
    if (!claimed) return counts;
    try {
      await this.build(claimed);
      counts['built'] = 1;
    } catch (error) {
      counts['failed'] = 1;
      if (error instanceof ExportWithdrawn) {
        this.logger.warn(`School export left to the order's withdrawal or another instance [export=${claimed.export_id}]`);
      } else {
        this.logger.warn(`School export failed [export=${claimed.export_id}, school=${claimed.school_id}, ${errorName(error)}]`);
        await this.prisma
          .withDeliveryService((tx) =>
            tx.$executeRaw(Prisma.sql`SELECT app.school_export_fail(${claimed.export_id}::uuid, ${errorName(error)})`),
          )
          .catch((failure: unknown) => this.logger.warn(`School export could not be marked failed [${errorName(failure)}]`));
      }
    }
    return counts;
  }

  /** The ordering administrator as the gateway sees a request of theirs. */
  private userOf(claim: Claimed): AuthenticatedUser {
    return {
      authId: claim.auth_id,
      role: Role.SCHOOL_ADMIN,
      userId: claim.user_id,
      schoolId: claim.school_id,
      adminProfile: claim.admin_profile,
      hrRead: claim.hr_read,
      channel: 'OTHER',
    };
  }

  /** Builds the archive for a claimed export and finishes it. Throws; `pass` marks the failure. */
  async build(claim: Claimed): Promise<{ bytes: number; chunks: number }> {
    const started = Date.now();
    const user = this.userOf(claim);
    const id = claim.export_id;
    const read = <T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T> => this.prisma.withRls(user, fn, { timeoutMs: 120_000 });

    let beat = Date.now();
    const heartbeat = async (force = false): Promise<void> => {
      if (!force && Date.now() - beat < HEARTBEAT_EVERY_MS) return;
      beat = Date.now();
      const [row] = await this.prisma.withDeliveryService((tx) =>
        tx.$queryRaw<Array<{ alive: boolean }>>(Prisma.sql`SELECT app.school_export_heartbeat(${id}::uuid) AS alive`),
      );
      if (!row?.alive) throw new ExportWithdrawn();
    };

    // Judged as the administrator, in the school: may they still decide?
    const [standing] = await read((tx) =>
      tx.$queryRaw<Array<{ decides: boolean; name: string }>>(
        Prisma.sql`SELECT app.current_user_decides() AS decides, (SELECT "name" FROM "Schools" WHERE "id" = ${claim.school_id}::uuid) AS name`,
      ),
    );
    if (!standing?.decides || !standing.name) throw new RequesterNotAllowed();

    const marked = await read((tx) =>
      tx.$queryRaw<Array<{ id: string; first: string; last: string }>>(
        Prisma.sql`SELECT DISTINCT u."id"::text AS id, u."firstName" AS first, u."lastName" AS last
                     FROM "PersonProtections" p JOIN "Users" u ON u."id" = p."userId" AND u."schoolId" = p."schoolId"
                    WHERE p."schoolId" = ${claim.school_id}::uuid`,
      ),
    );
    const markedIds = marked.map((row) => row.id);
    const markedSet = new Set(markedIds);
    const markedNames = marked.map((row) => `${row.first} ${row.last}`.trim().toLowerCase()).filter((name) => name.includes(' '));

    let activeYearId: string | null = null;
    const ctx: BuildContext = {
      schoolId: claim.school_id,
      schoolName: standing.name,
      now: new Date(),
      kind: 'school',
      scope: { ids: null },
      marked: markedIds,
      exempt: [],
      markedNames,
      read,
      checkpoint: () => heartbeat(),
      lists: async () => {
        const lists = await read((tx) => readLists(tx, claim.school_id));
        activeYearId = lists.activeYearId;
        const guardians = await this.family.guardianExport(user);
        return { files: listFiles(lists, markedSet, guardians.rows), linksHeldOut: guardians.heldOut };
      },
      // The schedule is a part of the archive, not the archive: a school leaving the service must get the rest of its
      // data even when Schema som fil cannot write this year's table, so a failure here is said in the manifest and the
      // build goes on (and is logged, by class).
      schema: async () => {
        if (!activeYearId) return null;
        try {
          const file = await this.exchange.export(activeYearId, 'TABLE_CSV', user);
          return { path: 'schema/grundschema.csv', body: file.body };
        } catch (error) {
          if (error instanceof ExportWithdrawn) throw error;
          this.logger.warn(`School export went on without the grundschema [export=${id}, ${errorName(error)}]`);
          ctx.notes!.push(`Grundschemat (schema/grundschema.csv) skrevs inte (${errorName(error)}). Resten av filen är hel. Schemat hämtas med Schema som fil.`);
          return null;
        }
      },
      dataFiles: DATA_FILES,
      notes: [],
    };

    const sink = new ChunkSink(async (seq, bytes) => {
      await heartbeat();
      await this.prisma.withDeliveryService((tx) =>
        tx.$executeRaw(Prisma.sql`SELECT app.school_export_put(${id}::uuid, ${seq}::integer, ${bytes}::bytea)`),
      );
    }, CHUNK_BYTES);
    const zip = new StreamingZip(sink);
    const audit = new Audit();
    await heartbeat(true);
    const built = await buildArchive(zip, ctx, audit);
    const stored = await sink.close();

    await this.prisma.withDeliveryService((tx) =>
      tx.$executeRaw(
        Prisma.sql`SELECT app.school_export_finish(
                     ${id}::uuid, ${stored.bytes}::bigint, ${stored.chunks}::integer, ${stored.sha256},
                     ${JSON.stringify(built.summary)}::jsonb, ${JSON.stringify(built.heldOut)}::jsonb,
                     ${JSON.stringify(built.readAbout)}::jsonb, ${EXPORT_KEEP_INTERVAL}::interval)`,
      ),
    );
    this.logger.log(
      `School export built [export=${id}, school=${claim.school_id}, attempt=${claim.attempt}, bytes=${stored.bytes}, chunks=${stored.chunks}, ` +
        `files=${built.summary.length}, rows=${built.summary.reduce((sum, file) => sum + file.rows, 0)}, ms=${Date.now() - started}, ` +
        `rssMb=${Math.round(process.memoryUsage().rss / 1048576)}]`,
    );
    return { bytes: stored.bytes, chunks: stored.chunks };
  }
}
