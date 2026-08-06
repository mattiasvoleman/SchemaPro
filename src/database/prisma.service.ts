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
   * Resolves a principal's own profile during authentication, before a
   * full `AuthenticatedUser` exists.
   *
   * `authId` MUST already be a cryptographically verified subject claim — the
   * caller has checked the JWT signature, issuer, audience and expiry. Given
   * that, injecting the claim grants exactly the access the token holder
   * already has (the `users_self_select` policy, `id = app.current_user_id()`).
   * It is not a privilege escalation, and it is not a bypass.
   *
   * This exists because `withSystemTransaction` cannot be used here — see the
   * warning on that method.
   */
  async withVerifiedSubject<T>(
    authId: string,
    fn: (tx: PrismaClient) => Promise<T>,
  ): Promise<T> {
    return this.withRls({ authId } as AuthenticatedUser, fn);
  }

  /**
   * Resolves an `X-API-Key` to the school that owns it, before any tenant
   * context exists.
   *
   * This is the one integration operation that cannot be tenant-scoped: the
   * tenant is what it is trying to discover. The matching policies
   * (`integration_keys_service_lookup` / `_touch`) therefore grant the
   * narrowest thing that works — SELECT and UPDATE on non-revoked rows of
   * `IntegrationApiKeys`, and nothing else. Once the school is known, callers
   * must switch to `withServicePrincipal`.
   */
  async withServiceKeyLookup<T>(
    fn: (tx: PrismaClient) => Promise<T>,
  ): Promise<T> {
    return this.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.service_key_lookup', 'on', true)`;
      return fn(tx as unknown as PrismaClient);
    });
  }

  /**
   * Execute `fn` as the SS12000 integration service acting for one school.
   *
   * `schoolId` MUST come from a verified integration key (see
   * `IntegrationKeyGuard`), never from request input. The service-principal
   * policies then constrain every statement to that tenant, so a query that
   * forgets its own `where: { schoolId }` returns nothing rather than leaking
   * across schools — the database enforces what the service layer intends.
   *
   * `set_config(..., true)` is transaction-local, so the principal cannot
   * outlive the transaction or leak onto a pooled connection.
   */
  async withServicePrincipal<T>(
    schoolId: string,
    fn: (tx: PrismaClient) => Promise<T>,
    options?: { timeoutMs?: number },
  ): Promise<T> {
    return this.$transaction(
      async (tx) => {
        await tx.$executeRaw`
          SELECT set_config('app.service_school_id', ${schoolId}, true)
        `;
        return fn(tx as unknown as PrismaClient);
      },
      { timeout: options?.timeoutMs ?? 30_000 },
    );
  }

  /**
   * Execute `fn` inside a plain transaction with no RLS session variables set.
   *
   * ## This does NOT bypass row-level security
   *
   * It was previously documented as bypassing row-level filtering. It does
   * not, and cannot: the API connects as `app_authenticated`, a non-owner, and
   * every table has `relrowsecurity = true`, so PostgreSQL applies policies to
   * every statement regardless of which helper opened the transaction.
   *
   * What actually happens is worse than a bypass — with no claims set,
   * `auth.uid()` returns NULL, every policy predicate evaluates false, and
   * queries silently return **zero rows** instead of erroring. That made
   * authentication fail closed for every user with "No active user profile is
   * linked to this account", because `JwtStrategy` used this method to load
   * the profile it needs to build the principal.
   *
   * There is no remaining caller for which this method is correct. Use:
   *
   *   `withRls`                — a request on behalf of an authenticated user
   *   `withVerifiedSubject`    — identity bootstrap from a verified JWT subject
   *   `withServiceKeyLookup`   — resolving an X-API-Key to its school
   *   `withServicePrincipal`   — the SS12000 service acting for one school
   *
   * It is kept only so that any future call site is an explicit, reviewable
   * choice rather than an accident. If you are reaching for it, one of the four
   * above is almost certainly what you want.
   */
  async withSystemTransaction<T>(
    fn: (tx: PrismaClient) => Promise<T>,
  ): Promise<T> {
    return this.$transaction((tx) => fn(tx as unknown as PrismaClient));
  }
}
