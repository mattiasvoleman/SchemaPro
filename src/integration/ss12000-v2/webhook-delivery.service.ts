import { randomUUID } from 'node:crypto';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { Ss12000Config } from '../../config/configuration';
import { PrismaService } from '../../database/prisma.service';
import { sourceErrorCode } from '../ss12000-sync/errors';
import { SecretBoxError } from '../ss12000-sync/secret-box';
import { sendOutbound } from '../ss12000-sync/outbound';
import { Ss12000Outbound, Ss12000Secrets } from '../ss12000-sync/ss12000-sync.providers';
import { signatureHeader, webhookSecretAad } from './signing';
import { vetTarget } from './subscriptions.service';

/** The tick: at most one notice per subscription a minute, as S1 permits ("kan välja att skicka en notis för multipla förändringar"). */
export const WEBHOOK_INTERVAL_MS = 60_000;
/** The purge of old tombstones and delivery rows, and the release of stale claims. */
export const HOUSEKEEPING_INTERVAL_MS = 60 * 60_000;
/** Subscriptions claimed per tick, and how many are posted at once. */
export const WEBHOOKS_PER_TICK = 50;
export const WEBHOOK_CONCURRENCY = 5;
/** Per attempt: a receiver gets ten seconds, and the first 64 KB of its answer are read and dropped. */
export const WEBHOOK_TIMEOUT_MS = 10_000;
export const WEBHOOK_MAX_BYTES = 64 * 1024;
/** After the n-th consecutive failure the next attempt waits this long (±20 %); then every 6 h, suspended after 72 h. */
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000];

export function retryDelay(attempts: number, random: () => number = Math.random): number {
  const base = RETRY_DELAYS_MS[Math.min(attempts, RETRY_DELAYS_MS.length - 1)]!;
  return Math.round(base * (0.8 + 0.4 * random()));
}

interface Due {
  subscription_id: string;
  school_id: string;
  key_id: string;
  target: string;
  modified: string[];
  deleted: boolean;
  watermark_to: string;
  attempts: number;
  failing_since: Date | null;
}

interface SealedRow {
  school_id: string;
  ciphertext: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  enc_key_id: string;
  previous_ciphertext: Buffer | null;
  previous_iv: Buffer | null;
  previous_auth_tag: Buffer | null;
  previous_enc_key_id: string | null;
}

/**
 * Subscriptions' notices (S1's callback subscriptionEvent): POST to the
 * subscription's target, exactly S1's body
 *
 *   {"modifiedEntites": [<EndPointsEnum>...], "deletedEntities": <bool>}
 *
 * (S1's spelling, kept), signed in headers (signing.ts). The notice carries
 * no data and no id: the consumer reads with meta.modified.after and
 * /deletedEntities, as S1 intends. A DRAFT edit never makes a version
 * (20261014130000), so it never makes a notice.
 *
 * On the scheduler's pattern: an unref'd one-minute interval off when
 * SS12000_BACKGROUND=off, a tick that never overlaps itself, and SECURITY
 * DEFINER functions in a transaction with no principal:
 *   1. hourly, app.ss12000_provider_housekeeping(): tombstones after 400
 *      days, delivery rows after 30, stale claims released;
 *   2. app.ss12000_due_notifications(50): live, unexpired, unsuspended
 *      subscriptions of live keys with versions or tombstones in their
 *      resource types below the xid horizon (FOR UPDATE SKIP LOCKED);
 *   3. per subscription, at most five at once: the key's signing secret
 *      (app.ss12000_webhook_secrets, the delivery context only), the target
 *      vetted again and the connection pinned (outbound.ts: no redirects, ten
 *      seconds, 64 KB of the answer read), any 2xx accepted (S1 names 200);
 *   4. app.ss12000_notification_settled(): success moves the watermark to the
 *      horizon; a failure retries after 1 min, 5 min, 30 min, 2 h, then every
 *      6 h (±20 % jitter), and 72 h of failure suspends the subscription.
 *
 * Inert until a consumer registers one: with no subscription a tick is the
 * housekeeping and one indexed query. A revoked key's subscriptions are
 * never claimed. Logs carry ids and codes, never a target's query, a body or
 * a header.
 */
@Injectable()
export class Ss12000WebhookDeliveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(Ss12000WebhookDeliveryService.name);
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private lastHousekeeping = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbound: Ss12000Outbound,
    private readonly secrets: Ss12000Secrets,
    @Optional() private readonly config?: ConfigService,
  ) {}

  onModuleInit(): void {
    if (this.config?.get<Ss12000Config>('ss12000')?.background !== true) return;
    this.timer = setInterval(() => void this.tick(), WEBHOOK_INTERVAL_MS);
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
  async tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.pass()
      .catch((error: unknown) => this.logger.warn(`SS12000 webhook tick failed [${error instanceof Error ? error.name : 'unknown'}]`))
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private async pass(): Promise<void> {
    // Hourly, not every minute: the purge reads the tombstones by age across
    // schools, and an hour more or less of a 400-day retention is nothing.
    if (Date.now() - this.lastHousekeeping >= HOUSEKEEPING_INTERVAL_MS) {
      await this.prisma.withDeliveryService((tx) =>
        tx.$queryRaw(Prisma.sql`SELECT tombstones, deliveries, released FROM app.ss12000_provider_housekeeping()`),
      );
      this.lastHousekeeping = Date.now();
    }
    const due = await this.prisma.withDeliveryService((tx) =>
      tx.$queryRaw<Due[]>(
        Prisma.sql`SELECT subscription_id, school_id, key_id, target, modified, deleted, watermark_to, attempts, failing_since
                     FROM app.ss12000_due_notifications(${WEBHOOKS_PER_TICK}::integer)`,
      ),
    );
    const queue = [...(due ?? [])];
    const workers = Array.from({ length: Math.min(WEBHOOK_CONCURRENCY, queue.length) }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) await this.deliver(next);
    });
    await Promise.all(workers);
  }

  private async secretsFor(due: Due): Promise<string[] | null> {
    const [row] = await this.prisma.withDeliveryService((tx) =>
      tx.$queryRaw<SealedRow[]>(Prisma.sql`SELECT * FROM app.ss12000_webhook_secrets(${due.key_id}::uuid)`),
    );
    if (!row || row.school_id !== due.school_id) return null;
    const aad = webhookSecretAad(due.school_id, due.key_id);
    const out = [this.secrets.box.openWith({ ciphertext: row.ciphertext, iv: row.iv, authTag: row.auth_tag, keyId: row.enc_key_id }, aad)];
    if (row.previous_ciphertext && row.previous_iv && row.previous_auth_tag && row.previous_enc_key_id) {
      try {
        out.push(
          this.secrets.box.openWith(
            { ciphertext: row.previous_ciphertext, iv: row.previous_iv, authTag: row.previous_auth_tag, keyId: row.previous_enc_key_id },
            aad,
          ),
        );
      } catch {
        // A previous secret that no longer opens is simply not sent.
      }
    }
    return out;
  }

  /** One notice. Settles every outcome; never throws. */
  async deliver(due: Due): Promise<string> {
    const started = Date.now();
    let ok = false;
    let status: number | null = null;
    let outcome = 'DELIVERED';
    try {
      const secrets = await this.secretsFor(due);
      const url = vetTarget(due.target);
      if (!secrets) {
        outcome = 'WEBHOOK_SECRET_MISSING';
      } else if (!url) {
        outcome = 'TARGET_REFUSED';
      } else {
        const body = JSON.stringify({ modifiedEntites: due.modified, deletedEntities: due.deleted });
        const timestamp = Math.floor(Date.now() / 1000);
        const options = this.outbound.clientOptions();
        const send = options.send ?? sendOutbound;
        const response = await send(
          {
            method: 'POST',
            url,
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': String(Buffer.byteLength(body)),
              'User-Agent': 'SchemaPro-SS12000-Webhook/2.1',
              'X-SchemaPro-Delivery': randomUUID(),
              'X-SchemaPro-Timestamp': String(timestamp),
              'X-SchemaPro-Signature': signatureHeader(secrets, timestamp, body),
            },
            body,
            timeoutMs: WEBHOOK_TIMEOUT_MS,
            maxBytes: WEBHOOK_MAX_BYTES,
            overflow: 'discard',
          },
          options.policy,
        );
        status = response.status;
        ok = status >= 200 && status < 300;
        outcome = ok ? 'DELIVERED' : `HTTP_${status}`;
      }
    } catch (error) {
      outcome = error instanceof SecretBoxError ? 'WEBHOOK_SECRET_UNREADABLE' : sourceErrorCode(error).replace(/^SS12000_/, 'WEBHOOK_');
    }
    const next = new Date(Date.now() + retryDelay(due.attempts));
    try {
      const [settled] = await this.prisma.withDeliveryService((tx) =>
        tx.$queryRaw<{ verdict: string }[]>(
          Prisma.sql`SELECT app.ss12000_notification_settled(${due.subscription_id}::uuid, ${ok}, ${status}::integer, ${outcome},
                                                            ${due.watermark_to}, ${Date.now() - started}::integer, ${next}::timestamptz) AS verdict`,
        ),
      );
      const verdict = settled?.verdict ?? 'UNKNOWN';
      if (!ok) this.logger.warn(`SS12000 webhook [subscription=${due.subscription_id}, outcome=${outcome}, verdict=${verdict}]`);
      return verdict;
    } catch (error) {
      this.logger.warn(`SS12000 webhook settle failed [subscription=${due.subscription_id}, ${error instanceof Error ? error.name : 'unknown'}]`);
      return 'UNSETTLED';
    }
  }
}
