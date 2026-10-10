import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type { PrismaPromise } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { createPgAdapter } from './pool-config';

/**
 * The batch helpers' transaction options, stated rather than inherited.
 *
 * Prisma 5 gave a batch no wait limit and no timeout of its own: it queued on
 * the pool's 10 s `pool_timeout` and then ran for as long as its statements
 * took. Prisma 7 applies its interactive defaults to a batch as well — 2 s to
 * get a connection, 5 s to finish — and withVerifiedSubject is a batch on
 * every authenticated request, so a busy pool would start refusing logins
 * after two seconds. 10 s is the old wait; 15 s is withRls's own timeout.
 */
const BATCH_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 15_000 } as const;

/**
 * What one `withRls` transaction carries beside its client: the hooks that run
 * once it has committed, and state a service keeps for the length of the
 * transaction (the notification outbox). Keyed by the transaction client in a
 * module-level WeakMap, so it needs no constructor (the spec builds the
 * service with Object.create) and is gone with the client.
 */
interface CommitScope {
  hooks: Array<() => Promise<void>>;
  locals: Map<object, unknown>;
}

const COMMIT_SCOPES = new WeakMap<object, CommitScope>();
const commitLogger = new Logger('PrismaService');

/** The connecting role's RLS-relevant privileges, read from `pg_roles`. */
interface ConnectionRole {
  name: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
  unforcedOwnedTables: number;
}

/** Schedules a committed transaction's hooks, each on its own, after the current turn. */
function runAfterCommit(scope: CommitScope): void {
  for (const hook of scope.hooks) {
    setImmediate(() => {
      Promise.resolve()
        .then(hook)
        .catch((error: unknown) =>
          commitLogger.warn(`An after-commit hook failed [${error instanceof Error ? error.name : 'unknown'}]`),
        );
    });
  }
}

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
 * `withRls()` opens a transaction, sets those session variables with
 * `SET LOCAL` (scoped to the transaction, not the connection), runs the
 * caller-supplied queries, then commits. This guarantees:
 *   1. Every single application query goes through RLS, because the connection
 *      role is `app_authenticated` (a non-owner) — set via `DATABASE_URL`.
 *      `onModuleInit` verifies this against the catalog on every boot rather
 *      than trusting it, because a role that bypasses RLS turns every policy
 *      below into a silent no-op instead of an error.
 *   2. The session variables are never visible across requests even when the
 *      same pooled connection is reused (SET LOCAL is transaction-scoped).
 *   3. No PII or JWT claims are written to application logs; only the
 *      anonymous traceId / request path are logged by the exception filter.
 *
 * ## Isolation: READ COMMITTED, and on purpose
 *
 * None of the helpers below passes an isolation level to `$transaction`, so
 * they run at the server's default, which PostgreSQL ships as READ COMMITTED:
 * `SHOW transaction_isolation` inside a transaction opened the way `withRls`
 * opens one reads "read committed" on the local stack. This comment called the
 * transaction serializable from the first commit; nothing ever made it so.
 *
 * It is not made so now either. At SERIALIZABLE, PostgreSQL aborts whichever
 * transaction a concurrent commit has made stale with SQLSTATE 40001, which
 * Prisma surfaces as P2034. Nothing here retries; `rethrowPrismaError` answers
 * P2034 with a 409 WRITE_CONFLICT that says to try again (a deadlock is the
 * same code), but a service that does not route its errors through it, and
 * the exception filter, would hand a concurrent edit READ COMMITTED lets
 * through — two PATCHes to different fields of one row, say — back as a 500
 * for whichever request lost. The code
 * that does guard a race is written for READ COMMITTED too: room optimisation's
 * apply takes an advisory lock and then reads, and the availability-constraint,
 * frame-time, lunch-serving, rast, room-rule, user and academic-year PATCHes
 * read the row they merge against under a row lock. Both rely on the waiting
 * transaction seeing what the other one committed. Under SERIALIZABLE its
 * snapshot predates that commit, and the wait ends in a serialization failure
 * instead. Other PATCHes that merge against their stored row read it without a
 * lock.
 *
 * What that asks of a caller: a read inside `withRls` holds nothing still. A
 * rule checked on a read and trusted by a later write needs the row locked
 * (`SELECT ... FOR UPDATE`), an advisory lock taken before the read, or a
 * constraint that states the rule where the write lands.
 *
 * Which row lock. PostgreSQL takes FOR KEY SHARE on a row for every insert
 * whose foreign key points at it, held until that insert's transaction ends,
 * and FOR UPDATE conflicts with it. On a row other tables reference, a PATCH
 * reading it FOR UPDATE waits out any transaction writing rows that point at
 * it, and holds that transaction up in turn: a run writing a teacher's
 * lessons, or anything year-scoped. FOR NO KEY UPDATE is the lock an UPDATE
 * that changes no unique-indexed column takes anyway, so it queues a second
 * PATCH exactly as the write would and leaves those inserts alone. The user,
 * academic-year and room-rule PATCHes take it. Nothing references the four
 * tables whose PATCHes take FOR UPDATE, so there the two locks behave alike.
 *
 * A write that only needs a row to stay as it read it takes FOR SHARE. A lov,
 * a teaching requirement and a timplan upload measure their dates against the
 * academic year and read it FOR SHARE (readYearBoundsForShare): that conflicts
 * with the year PATCH's FOR NO KEY UPDATE, so one of the two waits for the
 * other, and with neither FOR SHARE nor FOR KEY SHARE, so periods saved into
 * one year do not queue behind each other or behind their own inserts.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  /**
   * Prisma 7 has no engine of its own to read DATABASE_URL: the client needs a
   * driver adapter, and this is pg's pool built from that same variable — sized,
   * timed and checked in pool-config.ts. Nothing connects here; onModuleInit's
   * $connect does, and then checks the role before anything else runs.
   */
  constructor() {
    super({ adapter: createPgAdapter(process.env.DATABASE_URL) });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    await this.assertRlsIsEnforceable();
    this.logger.log('Prisma connected.');
  }

  /**
   * Refuses to start unless PostgreSQL will actually apply the policies this
   * class depends on.
   *
   * The privileges are read from the catalog rather than parsed out of the
   * connection string, because the string only says which role was requested,
   * not what that role is allowed to do. Either `rolsuper` or `rolbypassrls`
   * makes PostgreSQL skip policy evaluation altogether, so tenancy silently
   * stops being enforced — queries keep succeeding and simply return rows
   * belonging to other schools. Failing to boot is the only honest response:
   * this is a misconfiguration, not a runtime condition to degrade through.
   */
  private async assertRlsIsEnforceable(): Promise<void> {
    const [role] = await this.$queryRaw<ConnectionRole[]>`
      SELECT current_user::text AS name,
             r.rolsuper,
             r.rolbypassrls,
             (SELECT count(*)::int
                FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = 'public'
                 AND c.relkind = 'r'
                 AND NOT c.relforcerowsecurity
                 AND c.relowner = r.oid) AS "unforcedOwnedTables"
        FROM pg_roles r
       WHERE r.rolname = current_user
    `;

    if (!role) {
      throw new Error(
        'Refusing to start: could not determine which database role the API ' +
          'connects as, so there is no way to confirm row-level security ' +
          'applies to its queries.',
      );
    }

    if (role.rolsuper || role.rolbypassrls) {
      throw new Error(
        `Refusing to start: the database role "${role.name}" ` +
          `${role.rolsuper ? 'is a superuser' : 'has the BYPASSRLS attribute'}, ` +
          'so PostgreSQL skips every row-level-security policy and the ' +
          'multi-tenant isolation this API relies on is inert. Point ' +
          'DATABASE_URL at the least-privilege "app_authenticated" role — see ' +
          'docs/DEPLOYMENT.md §3. Migrations legitimately need owner rights, ' +
          'so keep those credentials in DIRECT_URL, which is not used at runtime.',
      );
    }

    // Ownership is the other way policies stop applying: PostgreSQL exempts a
    // table's owner unless the table is FORCE ROW LEVEL SECURITY. This warns
    // instead of throwing because, unlike the attributes above, it depends on
    // per-table FORCE and the API owning tables is unusual enough that a hard
    // failure here would more likely be a false alarm than a real finding.
    if (role.unforcedOwnedTables > 0) {
      this.logger.warn(
        `The database role "${role.name}" owns ${role.unforcedOwnedTables} ` +
          'application table(s) that are not FORCE ROW LEVEL SECURITY, so ' +
          'policies do not apply to it. DATABASE_URL should use a role that ' +
          'owns nothing (see docs/DEPLOYMENT.md §3).',
      );
    }
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
   * The transaction runs at READ COMMITTED, so a read in `fn` holds nothing
   * still for a later write — see "Isolation" on the class.
   *
   * @param user   The authenticated principal from `request.user`.
   * @param fn     Async callback receiving the transaction client.
   */
  async withRls<T>(
    user: AuthenticatedUser,
    fn: (tx: PrismaClient) => Promise<T>,
    options?: { timeoutMs?: number },
  ): Promise<T> {
    const scope: CommitScope = { hooks: [], locals: new Map() };
    const result = await this.$transaction(
      async (tx) => {
        COMMIT_SCOPES.set(tx, scope);
        await this.claimsFor(tx, user.authId);
        return fn(tx as unknown as PrismaClient);
      },
      {
        timeout: options?.timeoutMs ?? 15_000,
      },
    );
    runAfterCommit(scope);
    return result;
  }

  /**
   * Runs `hook` once the `withRls` transaction `tx` belongs to has COMMITTED,
   * on a later turn of the event loop so the response is never held for it;
   * a rolled-back transaction drops its hooks unrun. A hook's failure is
   * logged by name and swallowed: nothing after a commit can undo it.
   *
   * Answers false for a client no `withRls` opened (a service principal's,
   * the public viewer's, a plain transaction): the caller decides what that
   * means, and must never run the work before a commit instead.
   */
  onCommit(tx: PrismaClient, hook: () => Promise<void>): boolean {
    const scope = COMMIT_SCOPES.get(tx);
    if (!scope) return false;
    scope.hooks.push(hook);
    return true;
  }

  /**
   * State kept for the length of one `withRls` transaction under `key`,
   * created by `init` on first use; undefined outside one. NotificationsService
   * keeps its outbox here, so every notice of one transaction is delivered by
   * one hook.
   */
  commitLocal<T>(tx: PrismaClient, key: object, init: () => T): T | undefined {
    const scope = COMMIT_SCOPES.get(tx);
    if (!scope) return undefined;
    if (!scope.locals.has(key)) scope.locals.set(key, init());
    return scope.locals.get(key) as T;
  }

  /**
   * The delivery's door (NotificationDeliveryService, PushReceiptsService): a
   * transaction with no principal — RLS answers nothing in it — and a 5 s
   * statement_timeout, in which the only things worth doing are the
   * SECURITY DEFINER delivery functions (app.delivery_opt_outs, app.push_*),
   * each of which takes its school as an argument the gateway decided.
   * Shaped like withPublicViewer.
   */
  async withDeliveryService<T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return this.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
        return fn(tx as unknown as PrismaClient);
      },
      { timeout: 10_000 },
    );
  }

  /**
   * The statement that puts a subject's claims on the current transaction.
   *
   * Both claim styles are set so every auth.uid()/auth.role() variant works:
   * Supabase's helpers read `request.jwt.claims` (JSON) while older builds and
   * the plain-PostgreSQL fallback read the individual claim settings.
   * set_config(..., true) is transaction-local — the values are never visible
   * across requests even when a pooled connection is reused.
   *
   * Returned unexecuted, so it can open an interactive transaction's callback
   * or lead a batch.
   */
  private claimsFor(
    client: Pick<PrismaClient, '$executeRaw'>,
    authId: string,
  ): PrismaPromise<number> {
    const claims = JSON.stringify({ sub: authId, role: 'authenticated' });
    return client.$executeRaw`
      SELECT
        set_config('request.jwt.claims', ${claims}, true),
        set_config('request.jwt.claim.sub', ${authId}, true),
        set_config('request.jwt.claim.role', ${'authenticated'}, true)
    `;
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
   *
   * ## A batch transaction, not an interactive one
   *
   * This runs on every authenticated request, and it is exactly two
   * statements: the claims, then one lookup. An interactive transaction — the
   * callback form `withRls` uses — takes each statement through the client
   * runtime on its own, plus a step to open the transaction and one to commit
   * it, with an open-transaction entry and a timeout timer held for the
   * duration and a proxied transaction client built in JS. A batch hands the
   * client both statements at once, and @prisma/adapter-pg runs BEGIN, the
   * claims, the lookup and COMMIT on one pooled pg connection, in that order.
   * How long it may wait for that connection is BATCH_TRANSACTION_OPTIONS.
   *
   * Postgres receives the same statements in the same transaction: the claims
   * still end at COMMIT, and the lookup still reads the database on every
   * request, so a deactivated account is still refused on the next one. That
   * is also why `query` returns a PrismaPromise instead of being awaited in a
   * callback — the lookup has to reach the client unexecuted, behind the
   * claims. scripts/test/prisma-adapter-probe.ts asserts both against Postgres.
   */
  async withVerifiedSubject<T>(
    authId: string,
    query: (client: PrismaClient) => PrismaPromise<T>,
  ): Promise<T> {
    return this.batchUnderClaims(authId, query);
  }

  /**
   * One statement on behalf of `user`, under their claims: the batch form of
   * `withRls` for a handler whose whole database work is a single query — a
   * list, a lookup by id.
   *
   * `withRls(user, (tx) => tx.job.findMany(...))` and
   * `queryWithRls(user, (db) => db.job.findMany(...))` put the same statements
   * in the same transaction: BEGIN, the claims, the query, COMMIT. The second
   * skips the interactive transaction's extra round trips — see
   * withVerifiedSubject. Its wait and timeout are BATCH_TRANSACTION_OPTIONS
   * rather than a caller's choice, which a single statement does not need.
   *
   * Anything that reads and then decides, writes, or awaits between statements
   * still belongs in `withRls`: a batch is fixed before the first statement runs.
   */
  async queryWithRls<T>(
    user: AuthenticatedUser,
    query: (client: PrismaClient) => PrismaPromise<T>,
  ): Promise<T> {
    return this.batchUnderClaims(user.authId, query);
  }

  /** BEGIN, the claims, `query`, COMMIT — handed to the client as one batch. */
  private async batchUnderClaims<T>(
    authId: string,
    query: (client: PrismaClient) => PrismaPromise<T>,
  ): Promise<T> {
    const [, result] = await this.$transaction(
      [this.claimsFor(this, authId), query(this)],
      BATCH_TRANSACTION_OPTIONS,
    );
    return result;
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
   * The public viewer's door (Publicering, 20261011120000): a transaction
   * with no principal at all — RLS answers nothing in it — and a 2 s
   * statement_timeout, in which the only thing worth doing is calling
   * app.public_timetable(), the SECURITY DEFINER function that decides what
   * a share link may see. The timeout bounds what an anonymous caller can
   * make the database do per request.
   */
  async withPublicViewer<T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return this.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL statement_timeout = '2s'`;
        return fn(tx as unknown as PrismaClient);
      },
      { timeout: 5_000 },
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
