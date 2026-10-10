import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { Ss12000Config } from '../../config/configuration';
import { PrismaService } from '../../database/prisma.service';
import { Ss12000SyncService } from './ss12000-sync.service';

/** The tick. A source is claimed at most once per school-local day. */
export const SCHEDULER_INTERVAL_MS = 5 * 60 * 1000;
/** Sources claimed per tick: each runs in turn, so a tick stays well inside the next. */
export const SOURCES_PER_TICK = 5;

/**
 * The nightly sync, on the PushReceiptsService pattern: an unref'd 5-minute
 * interval (never keeps the process alive, cleared on shutdown), a tick that
 * never overlaps itself, and SECURITY DEFINER functions in a transaction with
 * no principal (PrismaService.withDeliveryService) for the work that spans
 * schools:
 *
 *   1. app.ss12000_housekeeping(): a RUNNING run older than 15 minutes is
 *      FETCH_FAILED (STALE: its process died), a DIFF_READY run older than 30
 *      days DISCARDED (EXPIRED) — both minimised by the run trigger.
 *   2. app.ss12000_due_sources(5): claims the sources whose admin enabled the
 *      schedule, whose school-local hour is AT OR PAST scheduleHourLocal and
 *      that have not run this local day (FOR UPDATE SKIP LOCKED, so two API
 *      instances never run one source). ">=": 02:00 does not exist in
 *      Europe/Stockholm on the spring-forward Sunday.
 *   3. each claimed source runs under its school's sync principal
 *      (Ss12000SyncService.startScheduledRun): FULL every fullEveryDays, else
 *      INCREMENTAL; SKIPPED when a manual diff younger than 24 h waits for
 *      its admin; auto-applied only when the admin turned that on.
 *
 * Off when SS12000_BACKGROUND=off (the test setup). With no source scheduled
 * a tick is two indexed queries.
 */
@Injectable()
export class Ss12000SchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(Ss12000SchedulerService.name);
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sync: Ss12000SyncService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  onModuleInit(): void {
    if (this.config?.get<Ss12000Config>('ss12000')?.background !== true) return;
    this.timer = setInterval(() => void this.tick(), SCHEDULER_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get scheduled(): boolean {
    return this.timer !== null;
  }

  /** One pass; a tick while the last one runs waits for it instead. Never throws. */
  async tick(now?: Date): Promise<void> {
    if (this.running) return this.running;
    this.running = this.pass(now)
      .catch((error: unknown) => this.logger.warn(`SS12000 scheduler tick failed [${error instanceof Error ? error.name : 'unknown'}]`))
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private async pass(now?: Date): Promise<void> {
    const at = now ?? new Date();
    const [housekeeping] = await this.prisma.withDeliveryService((tx) =>
      tx.$queryRaw<Array<{ stale: number; expired: number }>>(
        Prisma.sql`SELECT stale, expired FROM app.ss12000_housekeeping(${at}::timestamptz)`,
      ),
    );
    if (housekeeping && (housekeeping.stale > 0 || housekeeping.expired > 0)) {
      this.logger.log(`SS12000 housekeeping [stale=${housekeeping.stale}, expired=${housekeeping.expired}]`);
    }
    const due = await this.prisma.withDeliveryService((tx) =>
      tx.$queryRaw<Array<{ source_id: string; school_id: string; full_due: boolean }>>(
        Prisma.sql`SELECT source_id, school_id, full_due FROM app.ss12000_due_sources(${SOURCES_PER_TICK}::integer, ${at}::timestamptz)`,
      ),
    );
    for (const source of due ?? []) {
      try {
        const runId = await this.sync.startScheduledRun(source.source_id, source.school_id, source.full_due);
        this.logger.log(`SS12000 scheduled run [school=${source.school_id}, run=${runId ?? 'none'}]`);
      } catch (error) {
        this.logger.warn(`SS12000 scheduled run failed [school=${source.school_id}, ${error instanceof Error ? error.name : 'unknown'}]`);
      }
    }
  }
}
