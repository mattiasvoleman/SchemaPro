import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';

/**
 * Global PrismaService with RLS-aware transaction helper.
 *
 * ## Security design
 *
 * The PostgreSQL RLS policies evaluate `auth.uid()` and `auth.role()`, which
 * read from:
 *   - `current_setting('request.jwt.claim.sub', true)`  — subject / authId
 *   - `current_setting('request.jwt.claim.role', true)` — role string
 *
 * (The migration also accepts the full JSON blob via `request.jwt.claims`,
 * but injecting individual claims is cheaper and avoids any JSON parsing
 * inside every policy evaluation.)
 *
 * `withRls()` opens a serializable-isolated transaction, sets those session
 * variables with `SET LOCAL` (scoped to the transaction, not the connection),
 * runs the caller-supplied queries, then commits. This guarantees:
 *   1. Every single application query goes through RLS, because the connection
 *      role is `app_authenticated` (a non-owner) — set via `DATABASE_URL`.
 *   2. The session variables are never visible across requests even when the
 *      same pooled connection is reused (SET LOCAL is transaction-scoped).
 *   3. No PII or JWT claims are written to application logs; only the
 *      anonymous traceId / request path are logged by the exception filter.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Prisma connected.');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('Prisma disconnected.');
  }

  /**
   * Execute `fn` inside a transaction where the PostgreSQL session variables
   * required by the RLS helper functions are set for the duration of the
   * transaction.
   *
   * Every service that accesses data on behalf of a specific user MUST use
   * this method rather than calling `this.<model>.*` directly.
   *
   * @param user   The authenticated principal from `request.user`.
   * @param fn     Async callback receiving the transaction client.
   */
  async withRls<T>(
    user: AuthenticatedUser,
    fn: (tx: PrismaClient) => Promise<T>,
    options?: { timeoutMs?: number },
  ): Promise<T> {
    // Both claim styles are set so every auth.uid()/auth.role() variant works:
    // Supabase's helpers read `request.jwt.claims` (JSON) while older builds
    // and the plain-PostgreSQL fallback read the individual claim settings.
    // set_config(..., true) is transaction-local — the values are never
    // visible across requests even when a pooled connection is reused.
    const claims = JSON.stringify({ sub: user.authId, role: 'authenticated' });

    return this.$transaction(
      async (tx) => {
        await tx.$executeRaw`
          SELECT
            set_config('request.jwt.claims', ${claims}, true),
            set_config('request.jwt.claim.sub', ${user.authId}, true),
            set_config('request.jwt.claim.role', ${'authenticated'}, true)
        `;

        return fn(tx as unknown as PrismaClient);
      },
      {
        timeout: options?.timeoutMs ?? 15_000,
      },
    );
  }

  /**
   * Execute `fn` inside a plain transaction without setting any RLS session
   * variables. Reserved for operations that intentionally bypass row-level
   * filtering (e.g. system-level migrations, admin bootstrap tasks) and
   * require an explicit, documented justification at the call-site.
   *
   * NEVER use this method for user-triggered data access.
   */
  async withSystemTransaction<T>(
    fn: (tx: PrismaClient) => Promise<T>,
  ): Promise<T> {
    return this.$transaction((tx) => fn(tx as unknown as PrismaClient));
  }
}
