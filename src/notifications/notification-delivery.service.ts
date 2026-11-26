import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { PushConfig } from '../config/configuration';
import { PrismaService } from '../database/prisma.service';
import { errorName, JobRunner, type JobCounts } from '../jobs/job-runner';
import { ExpoPushClient, type ExpoMessage } from './expo-push.client';
import { OUTBOUND_STORE, OutboundQueue, QueueFullError, type NewNotice, type OutboundStore, type PlannedPush, type QueuedNotice, type StoredEntry } from './notification-queue';
import { retryDelayMs, sendMailPacket } from './notification-mail';
import { RECIPIENT_CHUNK, type OutboxBatch, type OutboxSettled } from './notification-outbox';
import {
  EMAIL_BCC_CHUNK,
  PUSH_TTL_SECONDS,
  URGENT_PUSH_CHANNEL,
  URGENT_PUSH_TTL_SECONDS,
  URGENT_PUSH_TYPES,
  planNotice,
  type PlanSources,
  type PushTarget,
} from './notification-plan';
import { NEVER_PUSHED } from './notification-types';
import type { NotificationKind } from './notifications.service';

// What the plan decides stays importable from where it always was.
export { EMAIL_BCC_CHUNK, PUSH_TTL_SECONDS, URGENT_PUSH_CHANNEL, URGENT_PUSH_TTL_SECONDS };

/**
 * The ticket errors that say the channel itself did not take the request, so that a reminder is not told "taken":
 * the client's own answer for a chunk it could not get through or got no answer for (RequestFailed), and the two
 * refusals of our credentials, which are the same for every device (InvalidCredentials, MismatchSenderId: Expo does
 * not accept the project's push credentials, or the sender they name is not the one the tokens belong to). The rest
 * are one device's or one message's: DeviceNotRegistered (the device is gone, and revoked), MessageTooBig and
 * MessageRateExceeded. The channel took those requests, and a retry would not change them.
 */
const CHANNEL_ERRORS: ReadonlySet<string> = new Set(['RequestFailed', 'InvalidCredentials', 'MismatchSenderId']);

/** Resend's default rate is two requests a second: one mail at most every 500 ms. */
export const EMAIL_INTERVAL_MS = 500;
/** Expo's five requests a second (the client's own pace is the same, per process). */
export const PUSH_INTERVAL_MS = 200;

/**
 * How long a mail may wait for Resend's answer before it is given up for now (the row is handed back and the packet is
 * asked about again under the same key). Resend answers in well under a second; a mail that has had ten has no answer
 * coming, and one that never answers must not hold the lane it is in (the ordinary one carries every school's notices).
 */
export const EMAIL_TIMEOUT_MS = 10_000;

/** The job's name in the runner and in JobRuns. */
export const NOTICE_JOB = 'notice-delivery';
/**
 * How often a process looks at the queue by itself: for a row another process left (its lease ran out), a row that was
 * handed back for a retry, and what a restart found waiting. A notice this process wrote is taken at once (kick).
 */
export const NOTICE_POLL_MS = 10_000;
/** How long a claim holds a row, renewed by every step. A packet takes at most ten seconds of its own. */
export const NOTICE_LEASE_MS = 120_000;
/** How often a pass also gives up what has stuck and removes what is old (app.outbound_sweep). */
export const NOTICE_SWEEP_MS = 5 * 60 * 1000;
/** A watcher that has heard nothing in this long is let go (the row may have been finished by another process). */
const WATCH_MS = 30 * 60 * 1000;
/** A write to the queue that fails is tried again after these. */
const ENQUEUE_RETRY_MS: readonly number[] = [200, 1000];
/** How soon after the start a process looks at the queue, for what its predecessor left. */
const BOOT_LOOK_MS = 2_000;
/** A row this process cannot send (the key is not here) is left for another, and looked at again after this. */
const NOT_HERE_MS = 30_000;
/** Longest a lane waits for one slot of the provider's pace before it asks again. */
const MAX_SLOT_WAIT_MS = 30_000;

type Lane = 'ordinary' | 'urgent';

/** Tells one watcher how a batch went, once, when its last row has: true only if every row was taken by its channel. */
class Watch {
  private all = true;
  constructor(
    private remaining: number,
    private readonly tell: (delivered: boolean) => void,
  ) {}
  part(delivered: boolean): void {
    this.all = this.all && delivered;
    this.remaining -= 1;
    if (this.remaining === 0) this.tell(this.all);
  }
}

/**
 * Delivers what NotificationsService wrote, after the transaction that wrote it has committed: e-mail through Resend,
 * as before, and push through Expo when PUSH_NOTIFICATIONS=expo.
 *
 * WHY AFTER THE COMMIT. notifyUsers used to dispatch e-mail before the caller's transaction had committed, so a write
 * that was refused or rolled back after the notice could already have mailed. Now every caller's notices wait for the
 * commit: PrismaService.onCommit runs one hook per transaction, which hands this service the transaction's whole outbox.
 *
 * THE QUEUE IS THE DATABASE'S (H3, 20270309090000). What the hook hands over is written to OutboundNotices in one
 * statement per lane and school, and delivered from there. A deploy that stops the process between the commit and the
 * send used to take every waiting mail with it (the queue was an array); now the next process, or another one running
 * beside it, takes the row up where it was left:
 *
 *   - A ROW is one lane's notices of one school from one transaction, as the delivery has always grouped them (the push
 *     joins one person's notices of a kind into "3 lektioner är inställda"). It holds the notices' types and meta, the
 *     mail's subject and text and the recipients' ids; never an address or a token, which are read when the row is first
 *     taken.
 *   - A LEASE per row (app.outbound_claim): the oldest row that waits, or whose lease has run out, FOR UPDATE SKIP
 *     LOCKED, with a claim that every later step must show. Two API instances, or an old and a new one in a deploy, never
 *     hold the same row; a process that stood still past its lease is told no at its next step and lets go.
 *   - A PLAN, made once (planNotice) and frozen on the row: the mail packets (49 addresses on BCC, after opt-outs) and
 *     the push packets (100 devices, each with its text). A retry sends the same packets.
 *   - TWO COUNTERS, and what they promise. A mail packet is counted AFTER Resend took it, and every mail goes under an
 *     Idempotency-Key made of the row and the packet (notification-mail.ts): a packet that was on its way when the process
 *     died is sent again by the next one under the same key, and Resend does not send it twice (24 hours; a row gives up
 *     after 20). A push packet is counted BEFORE the call, since Expo has no such key: a packet that was on its way when
 *     the process died is not sent again. So a mail arrives once or, when the provider is down for the whole day, not
 *     at all; a push arrives at most once. (ExpoPushClient retries a request it got no answer to inside one call, and
 *     says so itself: that, and nothing a restart does, is where a push can arrive twice.)
 *   - THE PACE IS THE FLEET'S. A mail takes a slot in the database's pace (app.outbound_slot: one mail at most every
 *     EMAIL_INTERVAL_MS, one push request at most every PUSH_INTERVAL_MS), whichever instance sends it, so two instances
 *     in a deploy do not double what the providers allow. The alarm's lane and the ordinary one share it.
 *   - AN ALARM DOES NOT WAIT BEHIND A WAVE. The urgent types (URGENT_PUSH_TYPES) are rows of their own, taken by a lane of
 *     their own that runs beside the ordinary one; a request for a guardian's confirmation to a whole school is 4,000
 *     notices and a minute or so of the ordinary lane, and an alarm's push lives ten minutes.
 *   - A FAILURE THAT MAY PASS IS WAITED OUT. A 429, a 5xx, a request nobody answers (EMAIL_TIMEOUT_MS) and a key
 *     Resend refuses hand the row back for a retry, after the wait the provider names or half a minute doubling to a
 *     quarter of an hour; a packet the provider will not take however often (a bad address) is counted failed and the
 *     queue goes on. A row that has waited 20 hours or been tried 30 times gives up (app.outbound_sweep).
 *   - WHEN A ROW IS DONE it is emptied of everything about a person (a CHECK holds the database to it) and kept as a few
 *     counts for a week.
 *
 * HOW A BATCH WENT. enqueue takes a listener (OutboxSettled) that is told once, when the batch's rows have been worked
 * through by THIS process: true when every mail was taken by Resend and every push request by Expo (or there was nothing
 * outside the inbox), false when one was refused, or the queue would not take the batch. It is not told when another
 * process finishes a row, or when this one stops first: the notices go on, and no word is an answer too. Kvittens' reminder
 * uses it to say "Skickad" only when the mail went.
 *
 * Configured with `RESEND_API_KEY` + `EMAIL_FROM` (mail) and PUSH_NOTIFICATIONS=expo (push); with neither, nothing is
 * queued, and a process that has neither takes no row (a row waits for one that has). TEACHER_ABSENCE_REPORTED never
 * leaves the inbox. Counts of errors are logged by code; never an address, a token or a text.
 */
@Injectable()
export class NotificationDeliveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationDeliveryService.name);
  private readonly store: OutboundStore;
  /** This process's name in a claim. */
  private readonly consumer = `${hostname().slice(0, 40)}-${process.pid}-${randomUUID().slice(0, 8)}`;
  private readonly lanes: Record<Lane, { running: Promise<void> | null }> = { ordinary: { running: null }, urgent: { running: null } };
  private readonly writing = new Set<Promise<void>>();
  private readonly watching = new Map<string, Watch>();
  private stopping = false;
  private lastSweepAt = 0;
  private stats: Record<string, number> = {};
  /** When the last mail or push request went by this process's own clock, for when the database cannot say. */
  private readonly lastAt: Record<'EMAIL' | 'PUSH', number> = { EMAIL: 0, PUSH: 0 };
  /** The pause between two mails; a spec sets it to 0. */
  emailIntervalMs = EMAIL_INTERVAL_MS;
  /** The pause between two push requests; a spec sets it to 0. */
  pushIntervalMs = PUSH_INTERVAL_MS;
  /** How long a mail waits for Resend's answer; a spec shortens it. */
  emailTimeoutMs = EMAIL_TIMEOUT_MS;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly expo?: ExpoPushClient,
    @Optional() private readonly jobs?: JobRunner,
    @Optional() @Inject(OUTBOUND_STORE) store?: OutboundStore,
  ) {
    this.store = store ?? new OutboundQueue(prisma);
  }

  onModuleInit(): void {
    // Registered with a channel or without: a process with none takes no row (kick), but its pass still gives up and empties what a
    // key that is gone, or a push that was turned off, left behind (app.outbound_sweep). Without it those rows, with the text and the
    // recipients of the notices, would stay for good, and the table's retention (20 hours, then emptied) would hold only while a key is set.
    if (!this.jobs) return;
    this.jobs.register({ name: NOTICE_JOB, intervalMs: NOTICE_POLL_MS, tick: () => this.tick() });
    // What the process before this one left waiting is looked at now, not an interval from now.
    setTimeout(() => this.kick(), BOOT_LOOK_MS).unref();
  }

  /**
   * A stop (a deploy's SIGTERM) lets the row in hand finish its packet and hands it back for the next process, which is
   * what the lease would do after two minutes. The wait for it is bounded: a process that does not come out in time is
   * stopped by the platform, and the lease does the rest.
   */
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    this.jobs?.unregister(NOTICE_JOB);
    await Promise.race([this.idle(), new Promise<void>((resolve) => setTimeout(resolve, 8_000).unref())]);
  }

  /** Whether an entry of this shape has anywhere to go beyond the in-app inbox. */
  wants(entry: { type: NotificationKind; email?: unknown }): boolean {
    const mail = Boolean(entry.email) && this.emailConfigured();
    return NEVER_PUSHED.has(entry.type) ? mail : mail || this.pushEnabled();
  }

  /** PUSH_NOTIFICATIONS=expo, and a client to send with. */
  pushEnabled(): boolean {
    return this.config?.get<PushConfig>('push')?.enabled === true && this.expo !== undefined;
  }

  emailConfigured(): boolean {
    return Boolean(process.env.RESEND_API_KEY);
  }

  /**
   * Writes one committed transaction's notices to the queue: the alarms as rows of the urgent lane, the rest as rows of
   * the ordinary one, one per school. Never rejects. `settled`, when given, is told once how the whole batch went
   * (OutboxSettled): at once and true for a batch with nothing to deliver outside the inbox, after this process has worked
   * through the last row otherwise, and false when the queue would not take it.
   */
  enqueue(batch: OutboxBatch, settled?: OutboxSettled): Promise<void> {
    const writing = this.write(batch, settled)
      .catch((error: unknown) => {
        this.logger.warn(`Delivery enqueue failed [${errorName(error)}, notices=${batch.length}]`);
        this.tell(settled, false);
      })
      .finally(() => this.writing.delete(writing));
    this.writing.add(writing);
    return writing;
  }

  /** Resolves once nothing is being written to the queue and this process has no row in hand. */
  async idle(): Promise<void> {
    for (;;) {
      const waiting = [...this.writing, this.lanes.ordinary.running, this.lanes.urgent.running].filter((p): p is Promise<void> => p !== null);
      if (waiting.length === 0) return;
      await Promise.all(waiting);
    }
  }

  private async write(batch: OutboxBatch, settled?: OutboxSettled): Promise<void> {
    const notices = this.rowsOf(batch);
    if (notices.length === 0) {
      this.tell(settled, true);
      return;
    }
    const watch = settled ? new Watch(notices.length, (delivered) => this.tell(settled, delivered)) : undefined;
    for (const notice of notices) {
      let id: string | undefined;
      try {
        id = await this.put(notice);
      } catch (error) {
        this.logger.warn(
          error instanceof QueueFullError
            ? `Delivery queue full; ${notice.entries.length} notice(s) not mirrored [lane=${notice.urgent ? 'urgent' : 'ordinary'}]`
            : `Delivery enqueue failed [${errorName(error)}, notices=${notice.entries.length}]`,
        );
      }
      if (id === undefined) {
        watch?.part(false);
        continue;
      }
      if (watch) {
        this.watching.set(id, watch);
        setTimeout(() => this.watching.delete(id!), WATCH_MS).unref();
      }
    }
    this.kick();
  }

  /** One write, tried again after a short wait if the database was not there (a queue that is full is not asked again). */
  private async put(notice: NewNotice): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.store.enqueue(notice);
      } catch (error) {
        if (error instanceof QueueFullError || attempt >= ENQUEUE_RETRY_MS.length) throw error;
        await new Promise((resolve) => setTimeout(resolve, ENQUEUE_RETRY_MS[attempt]));
      }
    }
  }

  /**
   * A batch as its rows: the urgent entries apart from the rest, and each school apart (an entry has one school). An
   * entry is kept when it has somewhere to go outside the inbox: its mail, when it has one and Resend is set up, or the
   * push when it is on. A row holds at most what the table's CHECKs allow (2,000 entries, 20,000 recipients); a batch that
   * large is cut there.
   */
  private rowsOf(batch: OutboxBatch): NewNotice[] {
    const open = new Map<string, NewNotice>();
    const rows: NewNotice[] = [];
    const mail = this.emailConfigured();
    const push = this.pushEnabled();
    for (const entry of batch) {
      if (entry.recipients.length === 0) continue;
      const email = entry.email && mail ? { subject: entry.email.subject, body: entry.email.body } : undefined;
      // A type that is never pushed has only its mail to go by.
      if (!email && (!push || NEVER_PUSHED.has(entry.type))) continue;
      const urgent = URGENT_PUSH_TYPES.has(entry.type);
      const key = `${urgent ? 'u' : 'o'}|${entry.schoolId}`;
      let row = open.get(key);
      if (row && (row.entries.length >= 2_000 || row.recipientIds.length + entry.recipients.length > 20_000)) row = undefined;
      if (!row) {
        row = { schoolId: entry.schoolId, urgent, entries: [], recipientIds: [], notificationIds: [] };
        open.set(key, row);
        rows.push(row);
      }
      const stored: StoredEntry = { type: entry.type, meta: entry.meta, n: entry.recipients.length, ...(email ? { email } : {}) };
      row.entries.push(stored);
      for (const recipient of entry.recipients) {
        row.recipientIds.push(recipient.userId);
        row.notificationIds.push(recipient.notificationId);
      }
    }
    // An alarm is written first: it is the one that is late if the database is slow.
    return rows.sort((a, b) => Number(b.urgent) - Number(a.urgent));
  }

  /** Tells whoever asked how a batch went. A listener that throws must not stop the lane. */
  private tell(settled: OutboxSettled | undefined, delivered: boolean): void {
    try {
      settled?.(delivered);
    } catch (error) {
      this.logger.warn(`A delivery listener failed [${errorName(error)}]`);
    }
  }

  // -------------------------------------------------------------------
  // The consumer

  /** Starts a lane that is not running. A process with no channel, or on its way out, takes no row. */
  kick(): void {
    if (this.stopping || !(this.emailConfigured() || this.pushEnabled())) return;
    for (const lane of ['urgent', 'ordinary'] as const) {
      if (!this.lanes[lane].running) {
        const running = this.run(lane).finally(() => {
          this.lanes[lane].running = null;
        });
        this.lanes[lane].running = running;
      }
    }
  }

  /** One pass of the job: the lanes until the queue has nothing due, and now and then the sweep. Never throws. */
  async tick(): Promise<void> {
    const started = new Date();
    try {
      this.stats = {};
      this.kick();
      await Promise.all([this.lanes.ordinary.running, this.lanes.urgent.running]);
      await this.sweepIfDue();
      this.jobs?.settled(NOTICE_JOB, started, { ok: true, counts: this.stats as JobCounts });
    } catch (error) {
      this.logger.warn(`Notice delivery pass failed [${errorName(error)}]`);
      this.jobs?.settled(NOTICE_JOB, started, { ok: false, error: errorName(error) });
    }
  }

  private count(name: string, by = 1): void {
    this.stats[name] = (this.stats[name] ?? 0) + by;
  }

  private async sweepIfDue(): Promise<void> {
    if (Date.now() - this.lastSweepAt < NOTICE_SWEEP_MS) return;
    this.lastSweepAt = Date.now();
    const { gaveUp, deleted } = await this.store.sweep();
    this.count('gaveUp', gaveUp);
    this.count('deleted', deleted);
    if (gaveUp > 0) this.logger.warn(`Notice queue gave up rows that had waited too long [rows=${gaveUp}]`);
  }

  /** One lane: rows one after another until none is due. */
  private async run(lane: Lane): Promise<void> {
    while (!this.stopping) {
      let row: QueuedNotice | null;
      try {
        row = await this.store.claim(this.consumer, lane === 'urgent', NOTICE_LEASE_MS);
      } catch (error) {
        this.logger.warn(`Notice claim failed [${errorName(error)}, lane=${lane}]`);
        return;
      }
      if (!row) return;
      this.count('claimed');
      await this.workOn(row);
    }
  }

  /** Works one row to its end or hands it back. Never throws. */
  private async workOn(row: QueuedNotice): Promise<void> {
    try {
      const outcome = await this.send(row);
      this.count(outcome.kind);
      if (outcome.kind === 'done') {
        const watch = this.watching.get(row.id);
        this.watching.delete(row.id);
        watch?.part(outcome.delivered);
      }
    } catch (error) {
      // Nothing is sent twice by the retry: the counters say where the row is. A row whose planning keeps failing gives up
      // after thirty claims (app.outbound_sweep).
      this.logger.warn(`Notice delivery failed [${errorName(error)}, attempt=${row.attempts}]`);
      this.count('failed');
      await this.handBack(row, retryDelayMs(row.attempts));
    }
  }

  /**
   * How long a row this process cannot send waits before it is looked at again: half a minute, doubling at each claim like a
   * failure does (retryDelayMs). Every look is a claim, and the sweep gives a row up at its thirtieth: at half a minute flat
   * a row nobody with the key had come for would be given up, with its push, in a quarter of an hour.
   */
  private notHereWait(row: QueuedNotice): number {
    return Math.max(NOT_HERE_MS, retryDelayMs(row.attempts));
  }

  private async handBack(row: QueuedNotice, delayMs: number): Promise<void> {
    try {
      await this.store.release(row, delayMs);
    } catch (error) {
      // The lease runs out and the next claim takes it from there.
      this.logger.warn(`Notice could not be handed back [${errorName(error)}]`);
    }
  }

  private async send(row: QueuedNotice): Promise<{ kind: 'done'; delivered: boolean } | { kind: 'released' | 'lost' }> {
    const apiKey = process.env.RESEND_API_KEY;
    const channels = { mail: Boolean(apiKey), push: this.pushEnabled(), from: process.env.EMAIL_FROM ?? 'Rastra Schema <noreply@schemapro.app>' };
    // A row with mail in it that this process cannot send is left for one that can (a key that is set on some instances
    // only is a deploy in the middle of being made): never given up, never sent without its mail.
    if (!row.plan && !channels.mail && row.entries.some((entry) => entry.email)) {
      await this.handBack(row, this.notHereWait(row));
      return { kind: 'released' };
    }

    let plan = row.plan;
    if (!plan) {
      plan = await planNotice(row, channels, this.sources(row.schoolId));
      if (!(await this.store.plan(row, plan, NOTICE_LEASE_MS))) return { kind: 'lost' };
    }

    // The two channels do not hold each other: a mail that must be tried again later (Resend is down) does not keep the
    // same row's push from going, which for an alarm is what counts (its push lives ten minutes), and a push that was
    // refused does not keep the mail. The row is handed back at the end if a mail has to wait.
    let mailFailed = row.mailsFailed;
    let mailWait: number | null = null;
    let interrupted = false;
    for (let i = row.mailDone; i < plan.mail.length; i++) {
      if (this.stopping) {
        interrupted = true;
        break;
      }
      const packet = plan.mail[i]!;
      const email = row.entries[packet.e]?.email;
      if (!apiKey || !email) {
        // Resend was set up when this was planned and is not now (or the entry has no mail: not made by this code).
        mailWait = this.notHereWait(row);
        break;
      }
      await this.pace('EMAIL', this.emailIntervalMs);
      const result = await sendMailPacket(
        apiKey,
        { from: plan.from, bcc: packet.bcc, subject: email.subject, body: email.body, key: `notice/${row.id}/mail/${i}` },
        this.emailTimeoutMs,
      );
      if (result.kind === 'retry') {
        this.logger.warn(`Email dispatch failed [${result.why}, will be tried again]`);
        // What the provider names is the least to wait, not the whole wait: Resend's rate limit names a second or two, and a row
        // that came back every ten seconds for that would use its thirty tries up in five minutes and lose the mail (the sweep gives
        // up at thirty). A failure waits at least the queue's own backoff (half a minute doubling to a quarter of an hour).
        mailWait = result.backoff === false ? (result.delayMs ?? retryDelayMs(row.attempts)) : Math.max(result.delayMs ?? 0, retryDelayMs(row.attempts));
        break;
      }
      const taken = result.kind === 'taken';
      if (!taken) this.logger.warn(`Email dispatch failed [status=${result.status}${result.name ? `, ${result.name}` : ''}]`);
      if (!(await this.store.advance(row, { mailDone: i + 1, mailSent: taken ? packet.bcc.length : 0, mailFailed: taken ? 0 : packet.bcc.length }, NOTICE_LEASE_MS))) {
        return { kind: 'lost' };
      }
      if (!taken) mailFailed += packet.bcc.length;
    }

    let pushFailed = row.pushFailed;
    let pushWait: number | null = null;
    for (let j = row.pushDone; !interrupted && j < plan.push.length; j++) {
      if (this.stopping) {
        interrupted = true;
        break;
      }
      if (!this.expo) {
        // Expo was set up when this was planned and is not here now.
        pushWait = this.notHereWait(row);
        break;
      }
      await this.pace('PUSH', this.pushIntervalMs);
      // Counted BEFORE the request: Expo has no idempotency key, and a packet that was on its way when this process died
      // must not be sent again by the next.
      if (!(await this.store.advance(row, { pushDone: j + 1 }, NOTICE_LEASE_MS))) return { kind: 'lost' };
      const result = await this.pushPacket(row.schoolId, plan.push[j]!);
      if (!(await this.store.advance(row, { pushSent: result.sent, pushFailed: result.failed }, NOTICE_LEASE_MS))) return { kind: 'lost' };
      pushFailed += result.failed;
    }

    if (interrupted || mailWait !== null || pushWait !== null) {
      await this.handBack(row, interrupted ? 0 : Math.min(mailWait ?? Infinity, pushWait ?? Infinity));
      return { kind: 'released' };
    }
    if (!(await this.store.finish(row, 'DONE'))) return { kind: 'lost' };
    return { kind: 'done', delivered: mailFailed === 0 && pushFailed === 0 };
  }

  // -------------------------------------------------------------------
  // Pace

  /**
   * Waits for this request's place in the provider's pace. The place comes from the database, so it is the fleet's: one
   * mail at most every `intervalMs` whichever instance sends it. Where the database cannot say (it is down; a spec has no
   * queue), this process keeps the pace by its own clock, as the delivery did before the queue.
   */
  private async pace(channel: 'EMAIL' | 'PUSH', intervalMs: number): Promise<void> {
    if (intervalMs <= 0) return;
    let wait: number;
    try {
      wait = await this.store.slot(channel, intervalMs);
    } catch {
      wait = Math.max(0, this.lastAt[channel] + intervalMs - Date.now());
    }
    wait = Math.min(wait, MAX_SLOT_WAIT_MS);
    this.lastAt[channel] = Date.now() + wait;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }

  // -------------------------------------------------------------------
  // Push

  /** What planning reads from the database, for one school. */
  private sources(schoolId: string): PlanSources {
    return {
      optOuts: (_school, userIds, type) => this.optOuts(schoolId, userIds, type),
      addresses: (_school, userIds) => this.store.addresses(schoolId, userIds),
      pushTargets: (_school, userIds, type, required) => this.pushTargets(schoolId, userIds, type, required),
    };
  }

  /** Who of `userIds` said no to `type` outside the app (NotificationOptOuts). */
  private async optOuts(schoolId: string, userIds: string[], type: NotificationKind): Promise<Set<string>> {
    const found = new Set<string>();
    for (let at = 0; at < userIds.length; at += RECIPIENT_CHUNK) {
      const chunk = userIds.slice(at, at + RECIPIENT_CHUNK);
      const rows = await this.prisma.withDeliveryService((tx) =>
        tx.$queryRaw<{ user_id: string }[]>(
          Prisma.sql`SELECT u::text AS user_id FROM app.delivery_opt_outs(${schoolId}::uuid, ${chunk}::uuid[], ${type}::"NotificationType") AS u`,
        ),
      );
      for (const row of rows ?? []) found.add(row.user_id);
    }
    return found;
  }

  private async pushTargets(schoolId: string, userIds: string[], type: NotificationKind, required: boolean): Promise<PushTarget[]> {
    const rows = await this.prisma.withDeliveryService((tx) =>
      tx.$queryRaw<PushTarget[]>(
        Prisma.sql`SELECT token_id::text AS token_id, user_id::text AS user_id, token, locale, timezone
                     FROM app.push_targets(${schoolId}::uuid, ${userIds}::uuid[], ${type}::"NotificationType", ${required})`,
      ),
    );
    return rows ?? [];
  }

  private toExpo(push: PlannedPush): ExpoMessage {
    const urgent = URGENT_PUSH_TYPES.has(push.y);
    return {
      to: push.to,
      title: push.ti,
      body: push.b,
      data: { notificationId: push.n, type: push.y },
      ttl: urgent ? URGENT_PUSH_TTL_SECONDS : PUSH_TTL_SECONDS,
      channelId: urgent ? URGENT_PUSH_CHANNEL : 'default',
      sound: 'default',
      priority: urgent ? 'high' : 'default',
      ...(urgent ? { interruptionLevel: 'time-sensitive' as const } : {}),
    };
  }

  /**
   * One packet to Expo, and what comes of the tickets: the ok ones are stored for their receipts and a device Expo calls
   * gone is revoked (app.push_settle). `failed` counts the refusals that say the channel did not take the request
   * (CHANNEL_ERRORS), and one for tickets that could not be stored; a refusal for one device or one message is not the
   * channel failing.
   */
  private async pushPacket(schoolId: string, packet: readonly PlannedPush[]): Promise<{ sent: number; failed: number }> {
    const tickets = await this.expo!.send(packet.map((push) => this.toExpo(push)));
    const ok: Array<{ id: string; tokenId: string }> = [];
    const dead = new Set<string>();
    const errors = new Map<string, number>();
    let failed = 0;
    tickets.forEach((ticket, index) => {
      const tokenId = packet[index]!.t;
      if (ticket.status === 'ok') {
        ok.push({ id: ticket.id, tokenId });
        return;
      }
      const code = ticket.details?.error ?? 'Unknown';
      errors.set(code, (errors.get(code) ?? 0) + 1);
      if (code === 'DeviceNotRegistered') dead.add(tokenId);
      if (CHANNEL_ERRORS.has(code)) failed += 1;
    });
    if (errors.size > 0) {
      this.logger.warn(`Push tickets with errors [${[...errors].map(([code, n]) => `${code}=${n}`).join(', ')}, sent=${packet.length}]`);
    }
    if (ok.length > 0 || dead.size > 0) {
      try {
        await this.prisma.withDeliveryService((tx) =>
          tx.$executeRaw(Prisma.sql`SELECT app.push_settle(${schoolId}::uuid, ${[...dead]}::uuid[], ${JSON.stringify(ok)}::jsonb)`),
        );
      } catch (error) {
        this.logger.warn(`Push tickets could not be stored [${errorName(error)}]`);
        failed += 1;
      }
    }
    return { sent: ok.length, failed };
  }

  // -------------------------------------------------------------------
  // The kitchen's letter

  /**
   * A letter to one address that is no user (Måltidskollen's kitchen): no inbox row, no push and no opt-out to honour,
   * because the address is the school's and there is no person behind it to choose. It takes its place in the same pace as
   * every other mail (the fleet's, from the database), so the providers' rate holds for it too. It does not wait in the
   * queue: it is one mail, once a day, and its caller keeps its own claim and asks again inside its window. What the queue
   * gives the others, the letter has in its key: it goes under an Idempotency-Key that is the letter's own fingerprint, so
   * that asking again after an answer that never came (a timeout) does not send it twice within the day.
   *
   * Answers false when the mail was not taken: Resend is not set up here, or Resend refused it, did not answer, or asked to
   * be asked again later, so the caller can leave its claim open and try again inside its window. True otherwise. Never
   * throws.
   */
  async sendLetter(address: string, subject: string, body: string): Promise<boolean> {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) return false;
    try {
      await this.pace('EMAIL', this.emailIntervalMs);
      const from = process.env.EMAIL_FROM ?? 'Rastra Schema <noreply@schemapro.app>';
      const key = `letter/${createHash('sha256').update(`${address}\n${subject}\n${body}`).digest('hex')}`;
      const result = await sendMailPacket(apiKey, { from, bcc: [address], subject, body, key }, this.emailTimeoutMs);
      if (result.kind === 'taken') return true;
      this.logger.warn(`Email dispatch failed [${result.kind === 'retry' ? result.why : `status=${result.status}`}]`);
      return false;
    } catch (error) {
      this.logger.warn(`Letter dispatch failed [${errorName(error)}]`);
      return false;
    }
  }
}
