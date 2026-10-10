import { Injectable } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { Ss12000SourceError } from '../ss12000-sync/errors';
import { vetHost } from '../ss12000-sync/outbound';
import { Ss12000Outbound } from '../ss12000-sync/ss12000-sync.providers';
import { normaliseUuid } from './ids';
import { v2Errors } from './errors';
import { encodePageToken, page, parseQuery } from './query';
import { EMITTED_RESOURCES, type EmittedResource } from './scopes';
import type { V2Caller } from './ss12000-v2.service';

/** Live subscriptions a key may hold. */
export const SUBSCRIPTIONS_PER_KEY = 10;
/** How long a subscription lives; PATCH (S1: "Uppdatera expire time") renews it. */
export const SUBSCRIPTION_DAYS = 30;

export interface S1Subscription {
  id: string;
  expires: string;
  name: string;
  target: string;
  resourceTypes: Array<{ resource: EmittedResource }>;
}

const TARGET_SHAPE = /^https:\/\/[^/?#@\s]+(\/[^#\s]*)?$/;

/**
 * The target a notice is POSTed to: https, no userinfo, no fragment, at most
 * 2048 characters (the CHECK Ss12000Subscriptions_target_is_https), and an
 * address that passes the sync's SSRF rules (outbound.ts: no loopback,
 * RFC 1918, CGNAT, link-local, ULA — *.railway.internal —, multicast,
 * mapped or NAT64 forms of them). Vetted here, at creation, and again at
 * every delivery with the connection pinned to the vetted address.
 */
export function vetTarget(raw: unknown): URL | null {
  if (typeof raw !== 'string' || raw.length > 2048 || !TARGET_SHAPE.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || !url.hostname) return null;
  return url;
}

function toS1(row: { id: string; expiresAt: Date; name: string; target: string; resourceTypes: string[] }): S1Subscription {
  return {
    id: row.id,
    expires: row.expiresAt.toISOString(),
    name: row.name,
    target: row.target,
    resourceTypes: row.resourceTypes.map((resource) => ({ resource: resource as EmittedResource })),
  };
}

const SELECT = { id: true, expiresAt: true, name: true, target: true, resourceTypes: true } as const;

/**
 * S1's /subscriptions for one key, under the service principal of its
 * school AND key (the arms of 20261014130000 name app.service_key_id, so a
 * key reads, renews and ends its own subscriptions only; another key's id
 * is a 404). Needs subscriptions.write, and the read scope of every
 * resource a subscription names.
 *
 *   POST    201 Subscription. CreateSubscription is {name, target,
 *           resourceTypes: [{resource: EndPointsEnum}]}, all required; plain
 *           strings in resourceTypes (S1's own example, which also spells
 *           "Organsation") are 400 — the schema is normative, the example
 *           is not. A resource the provider does not emit is 400. 409
 *           WEBHOOK_SECRET_MISSING until the school has made the key a
 *           signing secret (no unsigned notice is ever sent), 409
 *           SUBSCRIPTION_LIMIT at ten live ones.
 *   GET     the key's live subscriptions, paged as every list.
 *   GET {id}, PATCH {id} (no body: renews expires by 30 days, and clears a
 *           suspension for failing deliveries — never the school's pause),
 *   DELETE {id} 204: ends it; the row stays as the record.
 */
@Injectable()
export class Ss12000SubscriptionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbound: Ss12000Outbound,
  ) {}

  private run<T>(caller: V2Caller, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    if (!caller.scopes.has('subscriptions.write')) throw v2Errors.scopeMissing('subscriptions.write');
    return this.prisma.withServicePrincipal(caller.schoolId, (tx) => fn(tx), { keyId: caller.keyId });
  }

  async list(caller: V2Caller, raw: Record<string, unknown>): Promise<{ data: S1Subscription[]; pageToken: string | null }> {
    const operation = 'GET /subscriptions';
    const query = parseQuery(operation, raw, caller.keyId);
    return this.run(caller, async (tx) => {
      const rows = await tx.ss12000Subscription.findMany({
        where: { schoolId: caller.schoolId, keyId: caller.keyId, endedAt: null },
        select: SELECT,
      });
      return page(rows.map(toS1), null, query, (after) => encodePageToken(caller.keyId, operation, query.params, after));
    });
  }

  async create(caller: V2Caller, body: unknown): Promise<S1Subscription> {
    const input = await this.parse(caller, body);
    return this.run(caller, async (tx) => {
      const [secret] = await tx.$queryRaw<{ exists: boolean }[]>(Prisma.sql`SELECT app.ss12000_webhook_secret_exists() AS "exists"`);
      if (secret?.exists !== true) throw v2Errors.webhookSecretMissing();
      const live = await tx.ss12000Subscription.count({ where: { schoolId: caller.schoolId, keyId: caller.keyId, endedAt: null } });
      if (live >= SUBSCRIPTIONS_PER_KEY) throw v2Errors.subscriptionLimit();
      const row = await tx.ss12000Subscription.create({
        data: {
          schoolId: caller.schoolId,
          keyId: caller.keyId,
          name: input.name,
          target: input.target,
          resourceTypes: input.resourceTypes,
          expiresAt: new Date(Date.now() + SUBSCRIPTION_DAYS * 86_400_000),
        },
        select: SELECT,
      });
      return toS1(row);
    });
  }

  async get(caller: V2Caller, id: string): Promise<S1Subscription> {
    const wanted = this.pathId(id);
    return this.run(caller, async (tx) => toS1(await this.own(tx, caller, wanted)));
  }

  async renew(caller: V2Caller, id: string): Promise<S1Subscription> {
    const wanted = this.pathId(id);
    return this.run(caller, async (tx) => {
      const row = await this.own(tx, caller, wanted);
      const failing = row.suspendedReason === 'FAILING';
      const updated = await tx.ss12000Subscription.update({
        where: { id: row.id },
        data: {
          expiresAt: new Date(Date.now() + SUBSCRIPTION_DAYS * 86_400_000),
          ...(failing ? { suspendedAt: null, suspendedReason: null, failingSince: null, attempts: 0, nextAttemptAt: new Date() } : {}),
        },
        select: SELECT,
      });
      return toS1(updated);
    });
  }

  async end(caller: V2Caller, id: string): Promise<void> {
    const wanted = this.pathId(id);
    await this.run(caller, async (tx) => {
      const row = await this.own(tx, caller, wanted);
      await tx.ss12000Subscription.update({ where: { id: row.id }, data: { endedAt: new Date() }, select: { id: true } });
    });
  }

  private async own(tx: PrismaClient, caller: V2Caller, id: string) {
    const row = await tx.ss12000Subscription.findFirst({
      where: { id, schoolId: caller.schoolId, keyId: caller.keyId, endedAt: null },
      select: { ...SELECT, suspendedReason: true },
    });
    if (!row) throw v2Errors.notFound();
    return row;
  }

  private pathId(id: string): string {
    const normal = normaliseUuid(id);
    if (!normal) throw v2Errors.invalidId();
    return normal;
  }

  private async parse(caller: V2Caller, body: unknown): Promise<{ name: string; target: string; resourceTypes: EmittedResource[] }> {
    if (!caller.scopes.has('subscriptions.write')) throw v2Errors.scopeMissing('subscriptions.write');
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw v2Errors.invalidBody();
    const { name, target, resourceTypes, ...rest } = body as Record<string, unknown>;
    if (Object.keys(rest).length > 0) throw v2Errors.invalidBody();
    if (typeof name !== 'string' || name.trim().length === 0 || name.trim().length > 200) throw v2Errors.invalidBody();
    const url = vetTarget(target);
    if (!url) throw v2Errors.invalidBody();
    if (!Array.isArray(resourceTypes) || resourceTypes.length === 0 || resourceTypes.length > 8) throw v2Errors.invalidBody();
    const resources: EmittedResource[] = [];
    for (const entry of resourceTypes) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw v2Errors.invalidBody();
      const keys = Object.keys(entry);
      const resource = (entry as { resource?: unknown }).resource;
      if (keys.length !== 1 || typeof resource !== 'string' || !(resource in EMITTED_RESOURCES)) throw v2Errors.invalidBody();
      const scope = EMITTED_RESOURCES[resource as EmittedResource];
      if (!caller.scopes.has(scope)) throw v2Errors.scopeMissing(scope);
      if (!resources.includes(resource as EmittedResource)) resources.push(resource as EmittedResource);
    }
    try {
      await vetHost(url.hostname, this.outbound.clientOptions().policy);
    } catch (error) {
      if (error instanceof Ss12000SourceError) throw v2Errors.invalidBody();
      throw error;
    }
    return { name: name.trim(), target: url.toString(), resourceTypes: resources };
  }
}
