# Rastra — Deployment Runbook

Step-by-step guide for taking Rastra (formerly SchemaPro) from this repository to a running
production pilot. Written for the reference stack: **Supabase** (Auth +
Postgres), the **NestJS API** and **Python solver** on a container host, and
the **Next.js web app** on Vercel or any Node host.

Estimated time for a first deployment: **half a day**, most of it in
verification (step 9).

> **New to this?** [`deployment-walkthrough.md`](deployment-walkthrough.md)
> covers the same deployment in plain language, with every click spelled out
> and a "check it worked" after each step. This runbook assumes you already
> know your way around Postgres, containers and DNS.

> **The name (2026-10-17).** The product is Rastra: **Rastra Schema** in
> Swedish and **Rastra timetable** in English for the web app, the manuals,
> the e-mails and the API's messages; **Rastra** and **Rastra vårdnadshavare**
> for the mobile apps, which this repository builds as two new store apps
> (§15): Rastra (`se.rastra.app`) and Rastra vårdnadshavare
> (`se.rastra.vardnadshavare`). Neither is distributed yet, and a tester's
> earlier SchemaPro build is a different app on the phone (§15). No push or
> e-mail names an app. The repository, packages,
> database, environment variables, API paths, storage keys, the webhook's
> `X-SchemaPro-*` headers, the calendar feed's UIDs and the hosting projects
> (Railway, Supabase, Vercel) keep the old name, and so do the sending domain
> `schemapro.app` and any host name with schemapro in it, which people still
> see. What a person sees but the repository does not hold is renamed by
> hand, once:
>
> - **`EMAIL_FROM`** on the API: the display name, e.g.
>   `Rastra Schema <noreply@schemapro.app>`. The code's default says so, but
>   only when the variable is unset: `deploy/docker-compose.prod.yml` passes
>   it through as an empty string, so set it there too.
> - **Supabase Auth** (Authentication → Emails): the subjects and texts of
>   the *Invite user*, *Reset password* and *Magic link* templates, and the
>   SMTP sender name, where they name the product.
> - **Microsoft Entra ID** (§11): the app registration's display name, which
>   staff see when they consent and sign in, and **Google**'s OAuth consent
>   screen name. A kommun that has already consented may keep seeing the old
>   name in its own tenant until it consents again.
> - The PDFs of the manuals are `docs/Rastra-Schema-*.pdf`; a link to the old
>   `SchemaPro-*.pdf` names needs the new one.

---

## 0. Prerequisites

- A Supabase project (Pro tier recommended for daily backups).
- A container host for the API + solver (Fly.io, Railway, Render, a VPS with
  Docker, …). Both are single containers; `docker-compose.yml` shows the
  wiring.
- A host for the web app (Vercel is the path of least resistance).
- Node.js 20+, Docker, and the Supabase dashboard open.
- For the mobile apps only (Rastra and Rastra vårdnadshavare, §15): an Expo
  organisation, Apple Developer Program and Google Play Console memberships
  as an organisation, and a Firebase project, one of each for both apps.
  Apple and Google verify the organisation and want its D-U-N-S
  number, which takes days to weeks, so start them on day one (§15.1).
  Nothing else in this runbook waits for them, and the half day above does
  not count them.

Generate two secrets now and keep them handy:

```bash
openssl rand -hex 32   # AI_ENGINE_API_KEY (shared gateway ↔ solver secret)
```

The JWT secret is **not** generated — it comes from Supabase (step 1).

---

## 1. Configure the Supabase project

All in the Supabase dashboard:

1. **Collect credentials** (Settings → API):
   - Project URL → `SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_URL`
   - Publishable (anon) key → `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` / `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
   - Service role key → `SUPABASE_SERVICE_ROLE_KEY` (**server-only** — used
     exclusively by the API's user-invite flow. Its role writes no table, so a
     hand-written data change runs in the SQL editor as the owner, as in
     step 7)
   - JWT secret (Settings → API → JWT Settings) → `JWT_SECRET`
2. **Auth settings** (Authentication → URL Configuration):
   - Site URL: your web origin, e.g. `https://app.yourschool.example`
   - Redirect URLs: add `https://app.yourschool.example/**` (the invite and
     password-reset flows land on `/<locale>/update-password`, and "Logga in
     med skolkonto" on `/<locale>/auth/callback`), and Rastra's
     `rastra://auth/callback` (its production and preview builds, §11).
     A project that development builds sign in to also gets
     `rastra-dev://auth/callback` (§15). Rastra vårdnadshavare needs none:
     guardians sign in with a password, and that app offers no school
     account (§11.5)
3. **Email templates** (Authentication → Emails): review the *Invite user* and
   *Reset password* templates; the defaults work. For real deliverability,
   configure custom SMTP (Authentication → SMTP) — Supabase's built-in sender
   is rate-limited to a handful of emails per hour.
4. **Disable public signups** (Authentication → Providers → Email): turn off
   "Allow new users to sign up". All accounts are created by admin invitation
   through the API.

---

## 2. Apply database migrations

Migrations run as the database owner (the `postgres` user), using the
**direct** connection (port 5432), not the pooler.

That connection is `DIRECT_URL`, and the Prisma CLI reads it only from the
environment of the command that runs it (through `prisma.config.ts`). Since
Prisma 7 the CLI does not load `.env`, and it never falls back to
`DATABASE_URL`, so give it on the command line:

```bash
npm ci
DIRECT_URL="postgresql://postgres:<DB_PASSWORD>@db.<ref>.supabase.co:5432/postgres?sslmode=require&uselibpqcompat=true" npm run migrate:status   # read-only: what is pending
DIRECT_URL="postgresql://postgres:<DB_PASSWORD>@db.<ref>.supabase.co:5432/postgres?sslmode=require&uselibpqcompat=true" npm run migrate:deploy   # tables, indexes, RLS, policies
DIRECT_URL="postgresql://postgres:<DB_PASSWORD>@db.<ref>.supabase.co:5432/postgres?sslmode=require&uselibpqcompat=true" npm run migrate:status   # verify: "Database schema is up to date!"
```

`DIRECT_URL` is the owner connection and nothing else: `prisma migrate` and
`npm run db:seed` use it, and the API never reads it, so it does not belong in
the API's environment (step 5).

The `sslmode` parameters are there for the reason step 3 gives. The seed
connects through `pg`, like the API, and without them the owner's session,
and everything the seed writes, would cross the network unencrypted.

Once the access-token hook is on (§11.2), every sign-in and refresh reads
`"Users"` and `"SchoolSignInMethods"`. A migration that takes a strong lock
on either starts with `SET lock_timeout = '1s';` and is rerun if it times
out, so that it never makes every sign-in wait behind it (§11.2).

### 2.1 A migration that stopped, and the index it can leave behind

Prisma records a migration that stopped as failed, and the next
`migrate deploy` refuses (P3009) until it is told what to do about it:
`prisma migrate resolve --rolled-back <name>`, the name being in the message,
and then `migrate deploy` again, which runs the file **from its first
statement**. A file with a DO block runs as one transaction and leaves nothing
behind. A file that builds an index with `CREATE INDEX CONCURRENTLY` cannot run
in a transaction, so Prisma runs it one statement at a time, and a build that
is cancelled (a statement timeout, `pg_cancel_backend`, a dropped connection)
or that fails (a unique index over rows that are not unique) leaves its index in
the catalogue **invalid**: not used by the planner, and holding its name. Whether
writes still maintain it depends on where the build stopped. One that failed in
its second phase (`indisready = true`) is kept up to date by every write; one
that failed in the first, as a unique index over duplicates does, is not
(`indisready = false`), so it is no index to rely on in either case, and the
query in step 1 below shows both flags. The rerun then stops at the same
statement with

```
ERROR: relation "<index>" already exists   (SQLSTATE 42P07)
```

which does not say that the index is invalid, or that the way on is to drop it.
`IF NOT EXISTS` would not help: it sees the name, skips the statement, and the
migration is recorded as applied with the index still invalid (tried). So the
file does not use it, and the recovery is by hand, as the database's owner, on
the direct connection:

1. Find what a stopped build left. This reads the catalogue only:

   ```sql
   SELECT c.relname AS index, t.relname AS "table", i.indisvalid, i.indisready
     FROM pg_index i
     JOIN pg_class c ON c.oid = i.indexrelid
     JOIN pg_class t ON t.oid = i.indrelid
    WHERE NOT i.indisvalid AND c.relnamespace = 'public'::regnamespace
    ORDER BY c.relname COLLATE "C";
   ```

   Nothing is invalid when no build was interrupted. An index in the result
   that belongs to another migration than the one that stopped is somebody
   else's to look at first.
2. Drop each one the migration was building, without taking the table's writes
   with it, and outside a transaction (`psql -c` is enough):
   `DROP INDEX CONCURRENTLY "<index>";`
3. Read the migration's other statements. The ones that ran before the
   interrupted one run again, so each has to be safe to repeat (a `VALIDATE
   CONSTRAINT` of a validated key is; a `CREATE` without `IF NOT EXISTS` of
   something that exists is not and has to be undone first). A failed unique
   build means rows to settle first: the error names the key that is not
   unique.
4. `prisma migrate resolve --rolled-back <name>`, then `prisma migrate
   deploy`, then the query of step 1 again: no row.

The files that build an index concurrently are found with `grep -l
CONCURRENTLY prisma/migrations/*/migration.sql`. Each states its own recovery in
its header (20270115090100 does: `DROP INDEX CONCURRENTLY
"CalendarLessons_subjectId_schoolId_idx"` is its step 2, and its other
statements, thirty-eight `VALIDATE CONSTRAINT`, are safe to repeat).

## 3. Create the API's least-privilege database role

The API must **never** connect as `postgres` (the owner bypasses RLS). Create
a login role that is a member of `authenticated` — run once in the Supabase
SQL editor:

```sql
create role app_authenticated login password '<STRONG_GENERATED_PASSWORD>'
  in role authenticated inherit;
```

The runtime connection string for the API (step 4) uses this role through the
**pooler** (port 6543):

```
postgresql://app_authenticated.<ref>:<PASSWORD>@aws-0-<region>.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=10&sslmode=require&uselibpqcompat=true
```

> **Keep `sslmode` in the string.** Since Prisma 7 the API connects through
> `pg`, which uses TLS only when the URL asks for it. Without `sslmode` it
> connects unencrypted, where Prisma 5 tried TLS first, and nothing fails to
> say so.
> - `sslmode=require&uselibpqcompat=true` encrypts without verifying the
>   server's certificate, which is what Prisma 5 did.
> - `sslmode=require` on its own means `verify-full` to `pg`. The API then
>   cannot connect ("unable to verify the first certificate") unless Node
>   trusts the certificate authority that signed the server's certificate.
> - To verify the certificate too, put Supabase's CA certificate in the image
>   and use `sslmode=verify-full&sslrootcert=<path to it>` instead.
>
> `connection_limit` sizes the API's pool: **10**, not 1 (§3.1 says why). Do not
> add `query_timeout`: the API refuses to start with it
> (src/database/pool-config.ts).

> Sanity check: connect as `app_authenticated` and run
> `select count(*) from "Schools";` — it must return **0 rows visible** (RLS
> filters everything for a session with no JWT claims), not an error.

The API enforces this at boot: it reads its own privileges from `pg_roles` and
**refuses to start** if the role is a superuser or has `BYPASSRLS`, because
either makes PostgreSQL skip every policy and returns other schools' rows
instead of erroring. A misconfigured `DATABASE_URL` therefore fails loudly on
deploy rather than silently disabling tenancy.

### 3.1 The size of the API's pool: 10, not 1

`connection_limit` is how many connections the API's one process holds to the
pooler at the same time, and so how many database transactions it can have
open at once. It used to say 1 here. Supabase's own advice to start with 1
is for serverless functions, where thousands of short-lived instances each
open a pool of their own; the API is one long-running process, and with 1 it
is one lane: whatever holds the connection, every other request and every
background job waits behind.

**What holds it.** Kontrollera veckan and Generera both start by reading the
school's whole week (`prepareSchedule`) in one transaction: about 40
statements one after the other, each a round trip to the database, with the
connection held and the database idle in between. That is 0.1 s on one
machine and 4 s when the API and the database are 100 ms apart. On
2026-11-23 the real school ran both at once and every other request answered
500 "Unable to start a transaction in the given time" for 26 seconds, and ten
background jobs' ticks failed with it. The pool size in use that day was not
read when this was written (this guide then said 1, and the figures below are
what a pool of 1 does to that load), so read the `connection_limit` of your own
`DATABASE_URL` before taking the pool to be the cause.

**What a pool of 1, 3 and 10 does** (measured 2026-11-24 on a development
machine against Postgres 17, the round trip made 100 ms long; the school is a
högstadium of 327 posts; Kontrollera veckan and Generera's fetch at once, a
three page loads and a job tick a second beside them; the
probe `scripts/test/probe-anslutningar.ts` runs a lighter version at 50 ms in
CI, with fewer calls at a pool of 1, so no call is refused there):

| Pool | With Prisma's own 2 s wait (before) | With the API's 10 s wait (now) |
| --- | --- | --- |
| 1 | 20 of 20 calls refused, and one of the two fetches too | 19 of 36 calls refused: the queue is longer than the wait |
| 3 | 3 of 20 refused | none refused; the slowest waited 5.4 s |
| 10 | none refused | none refused; the slowest took 1.2 s, nothing waited for a fetch |

At a 10 ms round trip every size got through. At 100 ms a pool of 1 cannot
serve more than about one request a second, whatever else is going on: a
request is some ten round trips, and the one connection does them one at a
time.

**Why 10.** It is what the API needs and no more: in that measurement, two
fetches and five other calls at once used 7 connections (a school's busiest
minute can use more, which is why the pooler's Pool Size below is the other
bound). It is also pg's own
default, so a URL with no `connection_limit` gives the same pool. Supabase
names a `connection_limit` far past the default as a common cause of server strain. A
connection through the pooler in transaction mode (port 6543) is a *client*
connection to Supavisor; a *server* connection is taken only while a
transaction is open, and those are bounded by the pooler's **Pool Size**
(Database settings → Connection pooling; 15 by default on the smaller compute
sizes, per database role, so `app_authenticated` has its own 15). One API instance at 10 fits; two at once
while a deploy overlaps could ask for 20, which only happens if both have ten
transactions open together. Supabase's docs do not say how the pooler queues
the rest, so if you see "Max client connections reached" or timeouts at the
pooler, raise Pool Size (it may be up to 80% of the database's
`max_connections` if PostgREST is not used heavily, 40% if it is) before
lowering `connection_limit` below 7.

**What the API does when the pool is full anyway.** A transaction waits up to
10 seconds for a connection (`CONNECTION_WAIT_MS`, src/database/prisma.service.ts;
Prisma's own is 2), and one that still finds none is answered `503
DATABASE_BUSY`, a busy server and not a bug, with nothing written, and with a
`Retry-After` of 5 seconds. The public timetable viewer's door waits 5. Generera
writes its timetable in a transaction of its own after minutes in the engine:
a pool with no connection for that write is asked a second time before the run
is given up, so that "try again in a moment" does not send the school back to the
engine. Leave `pool_timeout` out of `DATABASE_URL`, or keep it at 10 or less:
it is how long pg itself waits for a connection (10 when it is not set, and 0
means no limit), and when that is longer than the 10 above, a call Prisma has
refused keeps its place in pg's queue and takes a connection round (BEGIN, one
row, ROLLBACK) when one comes free, which keeps the errors going after the long
transaction that caused them has ended. `src/database/prisma.service.spec.ts`
holds the two waits to each other for a URL that sets none.

**The round trip is the other lever.** Every statement is one. Run the API in
the Railway region nearest the Supabase region (check Railway's region list
against the region `<region>` in the URL above), and read the number from the
API's own shell: `psql "$DATABASE_URL" -c '\timing' -c 'select 1'` prints
the time of a round trip. 10 ms or less is fine; 100 ms means every page waits
a second on the database.

---

## 4. Deploy the AI engine (solver)

```bash
cd optimization-engine
docker build -t schemapro-solver .
```

Run it with:

| Env var | Value |
| --- | --- |
| `APP_ENV` | `production` |
| `API_KEY` | the generated `AI_ENGINE_API_KEY` |
| `ALLOWED_ORIGINS` | the API's origin, e.g. `https://api.yourschool.example` |
| `SOLVER_MAX_TIME_SECONDS` | `60`: the solve budget in seconds (raise for very large schools). A solve that times out answers after this plus `SOLVER_PROBE_SECONDS` (default `20`). The engine keeps **one clock per request** (§5.1): the search has this budget, counted from the end of its model builds (from the request's arrival for Bästa möjliga schema and for a week that keeps Restid); the probe's seconds count from where the search *ended*, and nothing after it passes the instant the answer is due, 13 s before the engine's ceiling. The ceiling, after which the engine answers 503 (`ENGINE_TIMED_OUT` on the page) instead of waiting for its solve, is the budget, the probe and 30 s for the builds; a request that asks for no probes (every Schemaförslag call after the first) has the budget and the 30 s; and a request that carries its caller's deadline has the shorter of that and the deadline less 5 s. The engine says all of this on `GET /api/v1/timing` and the API reads it from there: there is no second number to set. The old `SOLVER_TIMEOUT_SECONDS` is gone: nothing read it. |
| `SOLVER_EXPLAIN_SHARP_SECONDS` | `10` (default, must be above 0 and a finite number; the engine does not start on `0`, a negative value or `inf`): the share of the 15 s explanation cap that a LARGE refused week (50 lessons or more) gets for its first try, on the model without the objective, before the model with it is tried as the reserve. Raise it if the first try does not finish on this processor (section 23). |
| `EXAM_SOLVER_MAX_TIME_SECONDS` | `20` (default): the budget of the exam planner (`POST /api/v1/plan-exams`, Provplanering), apart from the generator's. A short budget never refuses: a greedy plan is the floor and the answer from the first instant, so less time means fewer exams placed or a clumsier plan. A request can ask for less and never for more. The API waits for the engine's ceiling for it (50 s at the default, `GET /api/v1/timing`) and never less than 90 s. |

The solver needs no database and no PII ever reaches it. Keep it on a private
network reachable only by the API if your host supports it. **On Railway this is
not only hygiene: a call through the engine's public domain is closed by the edge
after 300 s of silence, and the engine is silent while it solves (§5.3).** The
image's start line binds `--host 0.0.0.0`, which is IPv4 only, and Railway's
private network is IPv6 only in environments created before 2025-10-16; §5.3 says
what to check and what to change.

Verify: `curl https://<solver-host>/health` (or `/docs` for the OpenAPI UI).

## 5. Deploy the NestJS API

```bash
docker build -t schemapro-api .   # repo root
```

Run it with (see `.env.example` for the full annotated list):

| Env var | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `PORT` | `4000` |
| `CORS_ORIGINS` | web origin first (also used for invite links), e.g. `https://app.yourschool.example` |
| `DATABASE_URL` | the pooled `app_authenticated` string from step 3 |
| `JWT_SECRET` | Supabase JWT secret (first-party HS256 service tokens only) |
| `JWT_ISSUER` | **required** — `https://<ref>.supabase.co/auth/v1`; the API reads Supabase's ES256 public keys from `<JWT_ISSUER>/.well-known/jwks.json` |
| `JWT_AUDIENCE` | `authenticated` |
| `SUPABASE_URL` | project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | service role key |
| `AI_ENGINE_URL` | solver base URL, scheme included (`https://…`) — a bare hostname is not a URL and surfaces as "AI engine unavailable". **A public https address has a road limit of 300 s (§5.3); `http://<engine service>.railway.internal:<port>` has none.** |
| `AI_ENGINE_API_KEY` | the shared secret from step 0 |
| `AI_ENGINE_TIMEOUT_MS` | **optional, and best left unset.** Unset, the API waits as long as the engine says its route can take (`GET /api/v1/timing`) plus 10 s: 240 s at a 180 s budget and a 20 s probe, and it follows the engine when its budget is changed, so nothing is set in two places. An engine that says nothing (older, or not up yet) is waited for 120 000 ms. Set, it is the wait, and the request carries it to the engine as its deadline (`deadlineSeconds`), so the engine answers inside it; it must then be at least the engine's ceiling plus 5 s: `240000` at a 180 s budget and a 20 s probe (235 000 is the least). **A production start that finds it set and shorter is refused**, with a sentence that says which number to change, **and the API is then down**: no service in Railway has a health check (read 2026-11-18), so nothing holds the deploy before it up while the new one is refused, and a refused start is a stopped API until the variable is removed or raised, or the engine's budget is lowered and the API restarted (a change on the engine restarts only the engine). **Remove the variable, or raise it to the new ceiling plus 5 s, before raising the engine's budget** (`SOLVER_MAX_TIME_SECONDS`, `SOLVER_PROBE_SECONDS`), not after, or a deploy that follows the engine's change finds it too short; at runtime a shorter wait is answered with a shorter search, which a TIMEOUT states ("within 94 s"), and a line in the log. To get out of a refused start remove the variable. |
| `AI_ENGINE_PATH_IDLE_LIMIT_SECONDS` | **optional, and best left unset.** How long the road to the engine holds a request that sends nothing, in seconds. Unset, it is read from `AI_ENGINE_URL`: **300 for a public https address** (Railway's edge closes a request after 5 minutes with no data transferred), **none** for `*.railway.internal`, `localhost`, private addresses and a service name with no dot in it, and none for a public `http` address (a limit nobody can name is not guessed). Set, it is the limit: `0` says the road holds a silent request as long as it takes, otherwise `30` to `86400`. **The API holds every wait, and the deadline it sends the engine, to the limit less 10 s**, so that the engine answers (a TIMEOUT with its explanation and suggestions) before the road closes. A start never refuses for it: it says in the log, once, what the road does to a long run and which number to change. §5.3 |
| `CANDIDATE_MAX_SECONDS` | optional, `5`–`120`, default `30`: Schemaförslag's solve budget for each candidate, the same for all of them so the emphases are compared at one budget (docs/verification-baseline.md). Each candidate call waits this plus the engine's build headroom (30 s) plus 15 s, and for the first call's probes the engine's own probe (20 s: it is read from the engine, not written here), whatever `AI_ENGINE_TIMEOUT_MS` says. A value above the engine's `SOLVER_MAX_TIME_SECONDS` does nothing, since the engine gives every candidate the smaller, and the API says so once at its start |
| `CANDIDATE_SOLVER_WORKERS` | optional, `1`–`16`, default `4`: the solver workers a candidate solve uses, so a plain Generera beside it keeps the other cores |
| `CANDIDATE_RUNS_MAX` | optional, `1`–`10`, default `2`: candidate runs active across all schools at once; a start beyond it answers 409 `CANDIDATES_BUSY`. A run cut off by a redeploy while the engine was solving for it, or whose call timed out (cancelled or not), frees its year at once but keeps counting here until that solve could have ended (at most its call's timeout, about 1½ minutes at the defaults): the engine solves on once its caller stops waiting, whether the API restarted or only gave up on the call, and the engine's own 503 at its timeout does not stop the solve either. "Ta bort förslagen" hides such a run at once, and the sweep deletes its row after that |
| `THROTTLE_TTL_SECONDS` / `THROTTLE_LIMIT` | `60` / `120` |
| `PUBLIC_VIEWER_PROXY_KEY` | optional but **set it, on Railway (the API) and on Vercel (the web app), to the same value** of at least 32 random characters. Schemavisaren (`/v/<token>`) is fetched by the web server, so every visitor reaches the API from the web server's address: without the key they all share one rate-limit bucket (120 a minute), and the API keeps **no count of links and codes that do not exist per visitor** (it says so in the log at start-up), because one program asking for a few dozen of them would otherwise shut the viewer for every family. With the key the API trusts the visitor's address the web server forwards (an IPv6 address as its /64), and that address may ask for 60 links or codes that do not exist in a minute before it is refused for two minutes. A signed-in teacher or administrator reading the staff route is counted as a person (120 a minute, 600 a minute for one link) whether or not the key is set |
| `PUSH_NOTIFICATIONS` | `off` (the default, and what unset means) or `expo`. Off, push is inert: `GET /api/v1/push/config` answers `{enabled:false}`, the app never asks for permission, registration is refused (409 `PUSH_DISABLED`), no Expo request is made and no receipt is checked. Turn it on in production only as in §8.1; §15.6 tries it on a test stack first |
| `EXPO_ACCESS_TOKEN` | optional, at least 20 characters; sent as a Bearer to Expo only when set, which Expo requires once *enhanced push security* is on for the EAS project (§15.6) |
| `EXPO_PUSH_API_URL` | optional, `https` only; defaults to `https://exp.host/--/api/v2/push` |
| `INTEGRATION_SECRETS_KEY` | optional; base64 of exactly 32 random bytes (`openssl rand -base64 32`), kept in Railway's variables and nowhere else. The SS12000 source's credentials (client secret, static token, client key and certificate) are sealed with it (AES-256-GCM, bound to school, source, kind and the host they are sent to), and so are the integration keys' webhook signing secrets (bound to school and key, 20261014120000). Unset: an admin cannot save a credential or create a signing secret (503 `SS12000_SECRETS_NOT_CONFIGURED`), no sync runs, and no key can register a subscription. Losing it means every school re-enters its credentials and recreates its signing secrets; it never decrypts anything else |
| `INTEGRATION_SECRETS_KEY_PREVIOUS` | optional, same shape: the key before a rotation, which still decrypts and never encrypts. Rotate by moving the current key here, setting a new one, letting each school's admin save its credential again (or waiting for the next save), then clearing it |
| `SS12000_BACKGROUND` | `on` (default) or `off`: the 5-minute tick that runs scheduled syncs and marks stale and expired runs, and the 1-minute tick that delivers v2.0 subscription notices and purges old tombstones and delivery rows. A school's sync runs at night only once its admin turns the schedule on, and auto-applies only once the admin turns that on too; a notice goes out only once a consumer has registered a subscription |
| `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | recommended `15` (Railway's own default is `0`): the seconds between SIGTERM and SIGKILL when a deploy replaces the instance. On SIGTERM the API marks a Schemaförslag run that was solving as interrupted, stops taking requests, lets the ones in flight finish, and only then closes its database pool. With `0` it is killed before any of that: the run is left to its lease (about three minutes), and a request in flight is cut off as before |
| `CANDIDATES_BACKGROUND` | `on` (default) or `off`: the quarter-hourly sweep that marks abandoned candidate runs FAILED, deletes runs older than seven days, and deletes the emptied rows "Ta bort förslagen" left of runs whose engine call was still out, once that call could have ended. Every start in any school sweeps first, so off only delays those deletions. It also turns off the five-minute `generate-runs-sweep` that fails Generera runs whose lease has run out (§27.1); a Generera start sweeps first too, and the page reads an expired lease as abandoned, so that is delayed in the same way. It turns off the `staffing-search-sweep` of §32 as well |
| `STAFFING_SEARCH_BUDGET_SECONDS` | optional, `60`–`3600`, default `900`: how long a search for the choice of teachers (§32) may run. It is an anytime search, so the budget only decides how far it gets; time spent waiting for a Generera run of the year is not counted |
| `STAFFING_SEARCH_CONCURRENCY` | optional, `1`–`6`, default `1`: counts one search asks of the engine at once (each is one core for about 3–9 s). The engine is shared by every school (production has one replica) and counts ONE candidate at a time in a gate of its own that is not a setting (`optimization-engine/app/api/v1/week_bounds.py`): a count beyond it is answered 429, the search waits and asks again, and the wait is not counted in its budget (§32.4). A number above one only pays when the engine has more replicas, each with its own gate; the old `WEEK_BOUNDS_CONCURRENCY` is ignored if it is still set |
| `COVER_REQUESTS_BACKGROUND` | `on` (default) or `off`: the 5-minute tick that settles the open vikarieförfrågningar: the ones whose time is out end `EXPIRED` and the administrator who asked is told nobody said yes, the ones whose lesson or absence went away end `CLOSED` and the colleagues they waited on are told. A question past its time cannot be answered whether or not it has run; the tick settles the stored status, frees the lesson for a new question and tells who it concerns |
| `CRISIS_BACKGROUND` | `on` (default) or `off`: the quarter-hourly look at alarms left open in Krisläge. A real alarm that has stood open for 12 hours, or an exercise for 3, is ended (`autoEnded`), because only one of each kind can be open and a forgotten one would stop the next. Nobody is told; the app reads the alarm again when it is opened. With `off` an alarm is ended by an administrator or not at all |
| `GALLRING_BACKGROUND` | `on` (default) or `off`: the 5-minute tick of the nightly gallring. A school's run starts at 03:00 its local time, once a night, and only for the kinds its admin has given a period on `/admin/dataskydd`; a school that has decided nothing loses nothing |
| `SCHOOL_EXPORT_BACKGROUND` | `on` (default) or `off`: the 30-second job of the whole-school export (`/admin/dataskydd`). It takes the oldest order, if any, builds the zip as the administrator who ordered it (their login and school under row-level security) and stores it in pieces in `SchoolExportChunks`; a file is fetchable for three days and then deleted. With no order a pass is one expiry check and one claim. Needs migration `20270114090000`: run it before the API that has this job |
| `ABSENCE_WATCH_BACKGROUND` | `on` (default) or `off`: the 5-minute tick of Frånvarobevakning's nightly count. A school's night starts at 05:00 its local time, once a night, and only for a school whose administrator has turned the bevakning on (`/admin/absence-watch`; off for every school until then). The night counts the pupils over the school's limits as of yesterday and, on the first day after a whole week or month, writes the digest of each group that has a limit. Off, nothing is counted or sent and the findings already made stay |
| `REPORTING_RATE_BACKGROUND` | `on` (default) or `off`: the 5-minute tick of Rapporteringsgrad's nightly job. A school's night starts at 06:00 its local time, once a night, for every school with a lesson in the last 90 days (the count is not a switch; only the reminders and the weekly notice are, under `/admin/reporting-rate`). The night stores each teacher's held and reported lessons per day, tells the teachers of lessons that stood open past the school's limit (if the school turned that on) and, on Mondays, tells rektor and the full administrators the week's totals (likewise). **Off, this is the emergency brake:** nothing is counted, reminded or sent, the days already stored stay and the pages show them unchanged (they stop getting newer), and a teacher's list of open lessons, which reads the lessons live, still answers. A value that is neither `on` nor `off` is refused at start |
| `ABSENCE_STATS_BACKGROUND` | `on` (default) or `off`: the 5-minute tick of Frånvarostatistik's nightly job. A school's night starts at 07:00 its local time, once a night, for every school with a lesson in the last 90 days (the count is not a switch). The night stores the sums of absence per class and month, and for the whole school, without a pupil's id, for the months of the last 62 days and up to three older months a night until the three läsår are filled in. **Off, this is the emergency brake:** no month is counted, the sums already stored stay and the pages show them unchanged; the doors that count a pupil's own months from the marks (`/admin/reports?tab=absence-stats`, `/teacher/absence-stats`) still answer. A value that is neither `on` nor `off` is refused at start |
| `ACK_BACKGROUND` | `on` (default) or `off`: the quarter-hourly pass of Kvittens' reminders (`ack-reminders` in `JobRuns`). It reminds, once, each guardian who has not confirmed themself a request whose time the school chose has come, one request at a time and each in a transaction of its own; a school with kvittens off, or with no reminder time, has nothing for it to do. `off` stops every reminder in every school; the requests, the confirmations and the notices of a new request go on. The test setup turns it off. |
| `LEAVE_CONSENT_BACKGROUND` | `on` (default) or `off`: the quarter-hourly pass of Ledighetspolicyns påminnelser (`leave-consent` in `JobRuns`). It reminds, once, each guardian who has not answered a request for consent two days after it was filed, while the request waits and the leave is not over, and tells the mentors of a request that became clear because a custody ended; a school that asks for no consent has nothing for it to do. The pass calls `app.leave_consent_pass`, which answers nothing to any login (claims set, a person or not; the guard is the one Kvittens' three doors have). |
| `MEAL_LETTER_BACKGROUND` | `on` (default) or `off`: the two-minute look of Måltidskollen's daily letter to the kitchen (`meal-letter` in `JobRuns`). It asks which schools have the letter on, an address and a cut-off that has passed today by no more than three hours, with a sitting today, takes each school's day once (`JobClaims`, claimed by one instance) and sends the letter through the delivery that is already there (`sendLetter`, one mail at the mail pace, so it needs `RESEND_API_KEY` like every mail). The letter is off for every school until its administrator turns it on under Drift › Måltidskollen, so `on` does nothing for a school that has not. `off` stops every letter in every school; the page, the file and the counts go on. The test setup turns it off. |

No `DIRECT_URL` here: that is the owner connection from step 2, and the API
never reads it. Keeping owner credentials out of the API's environment is the
point.

Verify: any request without a bearer token returns `401` in the RFC-7807
shape, e.g. `curl -i https://api.yourschool.example/api/v1/subjects -X POST`.

### 5.1 Every time in the chain, and which of them is set by hand

A generation passes through several limits, and until the Generera runs of 2026-11-17 (three of them ended in "The AI engine returned an error." because the engine's ceiling fell in the middle of its own probe) they were set by hand in two services and held together by a paragraph of this file. They are now one chain with one clock per request: the engine says its times, the API reads them, and a request carries its caller's deadline. **What is still set by hand is the first block of rows below, all of it on the engine and all optional but the budget.**

| Time | At the production settings | Where it comes from | Set by hand? |
| --- | --- | --- | --- |
| The search's budget | 180 s | engine `SOLVER_MAX_TIME_SECONDS` | **yes**, on the engine |
| The timeout probe | 20 s | engine `SOLVER_PROBE_SECONDS` (0 switches it off) | yes, optional |
| The explanation's first try on a large week | 10 s of a 15 s cap | engine `SOLVER_EXPLAIN_SHARP_SECONDS`; the cap is code | yes, optional |
| The room, staffing and exam budgets | 10, 10 and 20 s | engine `ROOM_SOLVER_MAX_TIME_SECONDS`, `STAFF_SOLVER_MAX_TIME_SECONDS`, `EXAM_SOLVER_MAX_TIME_SECONDS` | yes, optional |
| A schemaförslag candidate's budget | 30 s | API `CANDIDATE_MAX_SECONDS` (the engine takes the smaller of it and its own budget) | yes, optional |
| A count of a week's exact bound (§32) | 25 s, and 40 s the API's wait | the request's `seconds` (at most 30) and the code; the engine runs one count at a time (a gate of one, in code, answering 429 beyond it) | gate no (fixed at one), the times are code, and the route is not one of `GET /api/v1/timing`'s four |
| The API's wait, as a cap | none | API `AI_ENGINE_TIMEOUT_MS` | optional, best left unset |
| **How long the road to the engine holds a request that sends nothing** | **300 s on a public https address** (Railway's edge), none on the private network | the address in API `AI_ENGINE_URL`; API `AI_ENGINE_PATH_IDLE_LIMIT_SECONDS` overrides it (§5.3) | no, unless the address says it wrongly |
| What the API holds its wait and its deadline to, on a road with a limit | **290 s** (the limit less 10 s) | code (`PATH_MARGIN_SECONDS`, `src/optimization/engine-timing.ts`) | no |
| The build headroom | 30 s | code (`optimization-engine/app/timing.py`) | no |
| The transfer margin between the API and the engine | 5 s | code | no |
| **The engine's ceiling** (it answers 503 `SOLVER_TIMEOUT` after it) | **230 s** | the budget, the probe and the headroom; for a request with a deadline at most the deadline less the transfer margin. Said on `GET /api/v1/timing` | no |
| The instant the answer is due | 217 s | the ceiling less 13 s: 3 s to build the answer and 10 s for a solve that stops past its own limit, as the search of the 809-lesson week did on 2026-11-17; every step of the solve ends before it, the probe and the explanation first | no |
| The API's wait for Generera | 240 s | the engine's ceiling and 10 s, unless `AI_ENGINE_TIMEOUT_MS` is set; **never more than the road holds** (290 s on a public https address) | no |
| A schemaförslag call's wait | 95 s (the first call, with probes), 75 s | `CANDIDATE_MAX_SECONDS`, the engine's headroom and probe, and 15 s | no |
| The page's "up to N minutes", and anything that needs to know how long a run can last | the API's wait | the API's wait (`OptimizationProxyService.waitSeconds`) | no |

When the numbers disagree, in the order of how soon it is said:

1. **At the API's start**, in production, if `AI_ENGINE_TIMEOUT_MS` is set and shorter than the engine's ceiling plus 5 s: the start is refused with "AI_ENGINE_TIMEOUT_MS=120000 is shorter than the engine can need: …" and the three ways out (raise it, remove it, lower the engine's budget), and the API is down until one is taken, the third with the API restarted (no service has a health check, so the previous deploy does not keep serving). Only if the engine answered; an engine that is down, older or not up yet is not a reason to refuse, and a deploy brings the two up together in either order.
2. **On a call**, if the engine's variables were changed after the API started (a change on the engine restarts only the engine): the request carries the API's wait as its deadline, so the engine answers inside it with a shorter search, a TIMEOUT that says how long it searched, and its probe cut to what is left (never less than 5 s of it). The API logs the sentence once and reads the engine's times again every ten minutes and after any ceiling it did not expect.
3. **Never as a 503 the API has stopped waiting for**, which is what the three runs of 2026-11-17 were.
4. **At the API's start and with the first run**, whatever is set, if the road to the engine closes a silent request sooner than the engine can need (a public https address, and an engine whose ceiling is above 285 s): a warning that says the limit, how long the API waits, how much of `SOLVER_MAX_TIME_SECONDS` fits, and the two ways to give a run its whole time (the private network, or a budget that fits). It never refuses a start: the deployment it is said about is serving. Two runs of a school on 2026-11-23 were closed at 300 s with no code, no report and no suggestions, with the engine at a 540 s budget (a ceiling of 590 s), and the engine answered after 540 s to nobody (§5.3).

A deploy brings the engine and the API up together, in either order (both deploy on every merge), and every combination of old and new is the old behaviour or better: an API older than this reads nothing and sends no deadline, and an engine older than this answers 404 on `/api/v1/timing`, after which the API waits as it always did and sends no field the engine would refuse. An engine that is rolled back after its times were read answers the first request with a 422 naming `deadlineSeconds`; the API sends it again without the field and reads the times again.

### 5.2 Where a timed-out run's time went

A run that ends without a timetable because time ran out says where the time went. The engine only **measures** it: no limit above reads it and no answer changes but by the fields below.

| What | Where | When |
| --- | --- | --- |
| `report` on the response (`TimeoutReport`): the seconds of each step (`PRECHECKS`, `BUILD`, `SITES`, `SEARCH_CLEAN`, `SEARCH_CLONE`, `PROBE`), what the search was given (`budgetSeconds`) against what the engine is set to (`configuredBudgetSeconds`), the caller's wait (`callerWaitSeconds`), what CP-SAT counted in each satisfaction search (`conflicts`, `branches`: effort, not progress, and no bound, since a satisfaction search has no objective), and `weekLoadCut` | `POST /api/v1/optimize` | on a `TIMEOUT` answer only, strict and best-effort alike; every other response is byte for byte what it was |
| The row `WEEK_LOAD_NOT_COUNTED` among a TIMEOUT's conflicts | the same answer | when the year's week load stopped at its seconds before every year was counted (four at most; fewer when the request's own clock cut the count short, and the row says the seconds it had, in tenths when they are not whole): a year with no line is then **not counted**, which is not the same as being under 85 % |
| `stage`, `stageSeconds` and `elapsedSeconds` in the 503's `details` (beside `route` and `ceilingSeconds`) | the generation route's 503 `SOLVER_TIMEOUT` | when the solve the ceiling gave up on was in a step; absent from the other three routes, and from a 503 whose solve had closed its last step |

**A step name the gateway does not know is skipped, not refused** (`timeoutReportOf`, M8). The engine deploys with every merge, ahead of the gateway, and a step it adds used to make every report `null` until the gateway followed. A step whose name is a word in capitals but is not in the gateway's list is now left out of `stages`, and the others keep their order; the steps then add up to less than `totalSeconds` by the skipped step's seconds, and the total is still the engine's. A step that is not an object, has no readable seconds or whose name is no word still makes the report malformed. So an engine may add a step name first and the gateway and the page learn it after, and `timeout-report.spec.ts` holds the gateway's list to the engine's (every name the gateway knows is one the engine still has, in its order).

All of it is additive: `app.openapi()` gains `OptimizeScheduleResponse.report` and four schemas (`TimeoutReport`, `TimeoutStage`, `TimeoutSearch`, `TimeoutSearchPhase`) and loses and changes nothing; an API older than this ignores the fields, and an engine older than this never sends them, so the page shows what a TIMEOUT has always carried. The 503's body is pinned by `optimization-engine/tests/data/solver_timeout_body.json`, which the engine's tests and the API's read.

### 5.3 The road to the engine: 300 s on the public domain, none on the private network

**What happened (2026-11-23).** A school ran Generera twice and both runs ended FAILED after 303 s with "The AI engine returned an error.", no code, no report, no suggestions. The engine's edge log has `POST /v1/schedule` 499 after 300 008 ms; the engine's own log has `TIMEOUT` with `budget=540.0s`: it searched for 540 s and answered when nobody listened. The API reached the engine through its public domain (`https://<engine>.up.railway.app`), and the engine sends nothing while it solves.

**The platform limit** (docs.railway.com, Networking › Public networking › Specs & limits, read 2026-11-24): an HTTP request through Railway's edge may run for up to **15 minutes if data keeps transferring**, and is otherwise **closed after 5 minutes with no data transferred**. The page states no limit for traffic on the private network, and no status code for a closed request. A call to the engine over its public domain therefore ends at 300 s whatever the budget, and no run that needs more can succeed on that road.

**What the API does about it** (omgång 15): it knows the road's limit and answers inside it.

| `AI_ENGINE_URL` | Limit | The API waits, and sends `deadlineSeconds` |
| --- | --- | --- |
| a public `https://…` address | 300 s | 290 s |
| `http://<service>.railway.internal:<port>`, `localhost`, a private address, a service name with no dot in it | none | what the engine's ceiling and 10 s make (600 s at a 540 s budget), unless `AI_ENGINE_TIMEOUT_MS` is set |
| a public `http://…` address | none (not guessed) | as above; set `AI_ENGINE_PATH_IDLE_LIMIT_SECONDS` if the road in front of it closes a silent request |

On a public https address the engine's own clock now cuts the search to what fits: the engine answers by the deadline less the 5 s transfer margin, so with a 290 s deadline its ceiling is 285 s, the answer is due at 272 s, and a search that does not find a timetable ends as a TIMEOUT with its probe, its explanation and the suggestions, in place of a closed connection. The budget that fits is **the limit less 10 s less the transfer margin (5 s), the probe (20 s) and the headroom (30 s): 235 s at the defaults.** At a budget of 180 s nothing changes (the wait is 240 s, under 290). At 540 s the search is cut to what the clock leaves it: the answer is due at 272 s, and the probe keeps its floor of that clock even when the search stops the 10 s late a CP-SAT solve may (the search is given the answer's due time less the floor less those 10 s). The floor is a rule's slice AND the rebuild its probe pays first, which the engine counts at half the setup: 5 s plus half the setup, up to the probe's own 20 s. So after a search that stopped the whole 10 s late the probe tries a rule with a slice of 5 s at any setup up to about 30 s (a TIMEOUT that names what stood in the way), and a search that stopped on time leaves it more. The search starts after the model builds, so it runs for 245 s if the builds take 8 s and for 204 s if they take 38 s (the two measured on the school's week), and a TIMEOUT says the number. (Until 2026-11-25 the 10 s were not in the sum, and a search that stopped 5 s or more late left the probe nothing: `g416-M-1`; and until the same day the floor was the 5 s alone, which a setup of about 10 s spent on the rebuild before a slice began: a bare TIMEOUT all the same, `g454` M-2. The price of both: the budget is held up to a setup of about 14.7 s, where 32 s held it before them and 22 s after the first.)

An engine older than `deadlineSeconds` cannot be asked to answer inside the wait: the API still holds its own wait to 290 s (so that it answers with its own sentence before the road does) and does not send the field, and the log says that this engine goes on searching for its whole budget and which number to lower.

**To give a run its whole budget, let the API reach the engine over Railway's private network.** There is no limit on that road in the documentation, and the traffic is encrypted already (Railway's WireGuard mesh), so the address is `http` and not `https`. Four steps, in this order. The API's address is changed in the third, after the engine is known to listen where the private network reaches it:

1. **The engine's private name and port.** `<engine service name>.railway.internal`, and the port the engine **listens on**: the `PORT` that Railway gives the engine service (the start line is `uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}`, and uvicorn's first log line says `Uvicorn running on http://0.0.0.0:<port>`). Do not guess it: a wrong port is a refused connection, which the page shows as the service not reaching the engine.
2. **Whether the engine listens where the private network reaches it.** `optimization-engine/Dockerfile` binds **`0.0.0.0`** (read 2026-11-24): IPv4 only. Railway's documentation (Private networking › How it works, read 2026-11-24) says the private DNS name resolves to **both IPv4 and IPv6** addresses in environments created after **2025-10-16**, and to **IPv6 only** in earlier ("legacy") environments. So: in a **newer environment** the engine is reached as it is (an IPv4 listener serves the IPv4 address, and the API runs Node 22, which tries every address the name resolves to); in a **legacy environment** it is not, and the engine must listen on IPv6, which is a **custom start command on the engine's service** in Railway (a setting of the service, not of this repository): `sh -c "exec uvicorn app.main:app --host '' --port ${PORT:-8000} --workers 1 --no-access-log"`. **The host is empty, not `::`.** With `--host ::` uvicorn gives asyncio (and uvloop) one IPv6 socket, and they set `IPV6_V6ONLY` on it, so it takes IPv6 only and refuses IPv4: measured on 2026-11-24 on the engine's own image (uvicorn 0.39.0, uvloop 0.22.1, Linux, `bindv6only` 0), `::1` answered and `127.0.0.1` was refused. The engine would then have left the public domain, or anything else that reaches it over IPv4, and the way back in step 3 (the old `AI_ENGINE_URL` is the public domain) would lead to an engine that does not answer there. An empty host makes uvicorn listen on every address of both families, one listener on `0.0.0.0` and one on `::`; the same probe answered on both. `optimization-engine/tests/test_listen_host.py` holds both facts against the command written here, and uvicorn's first log line then says `Uvicorn running on http://:<port>`. The environment's creation date is in Railway's dashboard; if it cannot be told, step 4 tells. The Dockerfile's own line is **not** changed: it is the line docker-compose, the CI image and every other host share, and nobody has tried a listener on both families on all of them.
3. **`AI_ENGINE_URL=http://<engine service name>.railway.internal:<port>` on the API**, and `AI_ENGINE_TIMEOUT_MS` left unset. The API restarts. The old value is the way back: nothing on the engine depends on which address called it.
4. **Verify from the API's start log.** The line to look for is "The engine says its generator waits up to <ceiling> s for a solve; the API waits <ceiling + 10> s (counted from that)." (590 and 600 at a 540 s budget, 290 and 300 at 240) **without** "held to what the road to the engine holds" and without the road's warning. If it says "does not state its times (…not reachable yet)" instead, the API did not reach the engine over the private name: the wrong port, an engine that was not up yet (restart the API once the engine is), or a legacy environment with an engine that listens on IPv4 only (step 2). Put the old `AI_ENGINE_URL` back; the first Generera on a private address that does not work ends with "the service could not reach the scheduling engine" (a refused connection and an unknown name are answered at once). Railway's log cap drops lines under load (it dropped 229 on 2026-11-23, among them this one), so read the first run's log too: the road's warning is said there as well.

Afterwards the engine's public domain can go, if nothing else uses it: the shared key protects it, but a door nobody needs is one more. That is a decision for whoever runs the deployment, and not a step here. The web, the API's callers and the engine's `GET /health` need no change.

A road that closes a silent request sooner or later than 300 s (another proxy in front of the engine, a different platform) is `AI_ENGINE_PATH_IDLE_LIMIT_SECONDS`: the limit in seconds, or `0` for none. The start check says nothing about an address it classifies as private, so a private address in front of a proxy that closes a call needs the variable set.

## 6. Deploy the web app

On Vercel: import the repo, set the **root directory to `web/`**, and add:

| Env var | Value |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | publishable key |
| `NEXT_PUBLIC_API_BASE_URL` | the API origin, e.g. `https://api.yourschool.example` |
| `PUBLIC_VIEWER_PROXY_KEY` | optional; the API's value (above). Read at runtime by the server, never sent to a browser |
| `PUBLIC_VIEWER_TRUSTED_HOPS` | optional, `0`–`5`, default `0`: how many proxies of your own stand in front of the platform's edge and append their address to `X-Forwarded-For` (a CDN or a WAF in front of Vercel). The viewer takes the visitor's address as the entry that many places from the right of that header; with the default it takes the rightmost, the one the platform's edge wrote. Leave it at `0` on Vercel alone. A wrong value does not open anything, it only counts the wrong address. Set higher than the header has entries, the web server sends no address at all, and with `PUBLIC_VIEWER_PROXY_KEY` set the gateway then counts every such visitor together under the web server's own address (sixty-one misses among them close the viewer for all of them for two minutes), so keep it at the real number |
| `PUBLIC_VIEWER_API_BASE_URL` | optional; the API origin as the web **server** reaches it (a private network address), when that differs from `NEXT_PUBLIC_API_BASE_URL` |
| `ACCESSIBILITY_ORGANISATION` | the huvudman that stands behind the service, as the tillgänglighetsredogörelse (`/sv/tillganglighet`) names it, e.g. the kommun's name |
| `ACCESSIBILITY_EMAIL`, `ACCESSIBILITY_PHONE` | where to ask for inaccessible content and report shortcomings. Until at least one is set, the statement says its contact details are missing, which lagen (2018:1937) does not accept for a live service |
| `ACCESSIBILITY_RESPONSE_DAYS` | optional; working days to an answer, e.g. `5` |

Verify: visiting `/` redirects to `/sv/login`; the language switcher flips to
English; `/sv/admin` redirects to login when signed out; `/v/x` answers
"Schemat finns inte" without a redirect, with `X-Robots-Tag: noindex, nofollow`
and no `Set-Cookie`.

---

## 7. Bootstrap the first school and admin

There is intentionally no public signup. One-time, in the Supabase dashboard:

1. **Create the auth user**: Authentication → Users → *Add user* → email +
   temporary password (or *Send invitation*). Copy the user's **UUID**.
2. **Create the tenant and profile** (SQL editor, as owner):

```sql
insert into "Schools" (name, slug, timezone, "updatedAt")
values ('Demo School', 'demo-school', 'Europe/Stockholm', now());

insert into "Users" ("schoolId", "authId", role, "firstName", "lastName", email, "invitedAt", "updatedAt")
values (
  (select id from "Schools" where slug = 'demo-school'),
  '<AUTH_USER_UUID>',
  'SCHOOL_ADMIN',
  'Anna', 'Andersson', '<same email as the auth user>',
  now(), now()
);
```

`"invitedAt"` says the person has a login. Without it the row reads as a
catalogue entry nobody invited: when gallring pseudonymises the person after
they have left it would leave their login behind, and the school-account
domain checks (§11) would not count them.

The two statements are two statements: between the `Schools` row and the
administrator the school has nobody in it, and `npm run db:seed` (§37) takes a
school with nobody in it for no school at all and will add the demo school
beside it. Run the two together (paste both into the SQL editor and run them
as one), and do not run a seed against this database in between.

`"updatedAt"` is mapped with Prisma's `@updatedAt`, which is maintained in the
application layer and creates **no database default** — every hand-written
`insert` against these tables must supply it, on all 12 models that carry it.
`"createdAt"` does default, so only `"updatedAt"` errors. Keep the double
quotes: unquoted, PostgreSQL folds the identifier to `updatedat`.

`"authId"` is the only link between the Supabase Auth user and this profile —
`JwtStrategy` resolves the account by it alone. A wrong UUID produces a
successful sign-in followed by *"No active user profile is linked to this
account."*

3. Sign in on the web app — you land on the admin dashboard. Every subsequent
   user is invited through **Admin → People** (the API sends the Supabase
   invite email automatically).

## 8. Mobile app

`mobile/` builds two apps: **Rastra**, for staff and pupils, and **Rastra
vårdnadshavare**, for guardians (§15). They are distributed as builds, not
deployed. Their code and settings are compiled into each build, so a build
does not change when the API or the web redeploys, and a change to the app
reaches nobody until a new build is installed (§15.9). Builds run on EAS or
with `eas build --local` on a Mac, never on GitHub Actions: CI typechecks,
tests and bundles the app and builds nothing. §15 covers the accounts, the
credentials, internal builds, push on a device and the stores' internal
tracks.

Both apps read these when they are built: a developer's `npm start` from
`mobile/.env.local`, a preview or production build from the EAS environment
of its profile (§15.2). The two apps share those environments, so they talk
to the same API and the same Supabase project.

| Variable | Value | Unset |
| --- | --- | --- |
| `EXPO_PUBLIC_API_BASE_URL` | the API origin, `https://`; plain `http://` only to localhost, in a development build | nothing loads; a preview or production build on EAS stops before it builds |
| `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | from step 1 | no sign-in; a preview or production build on EAS stops before it builds |
| `EXPO_PUBLIC_WS_BASE_URL` | the API origin, `wss://` | no live schedule updates; the schedule still loads |
| `EXPO_PUBLIC_SCHOOL_ACCOUNTS` | `on` | no *Logga in med skolkonto* in Rastra (§11.1). Rastra vårdnadshavare never offers it, whatever the value |

Push needs no value here: the EAS project's id, one for both apps, is in
`app.json` (§15.2), and an Android build's `google-services.json` comes from
EAS (§15.3).

Local development runs in each app's own development build (Rastra Dev,
Rastra vårdnadshavare Dev), not in Expo Go, which cannot run them: the app
refuses to open its database without SQLCipher, and push needs the app's
own native build.

```bash
cd mobile
npm ci                        # with npm 11, as CI; mobile/.npmrc sets legacy-peer-deps
cp .env.example .env.local    # or: eas env:pull --environment development
npm start                     # Rastra Dev: APP=rastra APP_VARIANT=development expo start --scheme exp+rastra
npm run start:vardnadshavare  # Rastra vårdnadshavare Dev
```

A development build takes its app config from the server it loads from, so
Rastra vårdnadshavare Dev is served by `npm run start:vardnadshavare` only
(§15.2 item 5). The lockfile is npm 11's, which CI pins (`npm install -g
npm@11`); an npm of another major may rewrite it or refuse it. The
development builds themselves come from `eas build --profile
rastra-development` and `--profile vardnadshavare-development` (§15.5), or
from `npm run ios` / `npm run android` and `npm run ios:vardnadshavare` /
`npm run android:vardnadshavare` on a Mac with Xcode or the Android SDK.

### 8.1 Turning push on

Push to the app is off until all of this is done, in this order. Nothing in
production changes before the last step.

1. **A data processing agreement and a basis for the transfer.** A push
   passes through Expo (650 Industries, USA), Apple (APNs) and Google (FCM).
   The school, as personuppgiftsansvarig, needs a data processing agreement
   that covers Expo as a sub-processor, and a lawful basis for the transfer
   to a third country, *before* push is turned on. The texts are minimised
   (no name, no subject, group or room, no free text; see
   `src/notifications/push-messages.ts`), but a device token and the fact
   of a notice are still personal data.
2. **One EAS project for both apps, and push credentials for each of their
   four application ids** (§15.2, §15.3): the project's id in `app.json`;
   for Android, one `google-services.json` naming all four packages as an
   EAS file variable, and the FCM V1 service-account key assigned to each
   package; for iOS, an APNs key assigned to each bundle id (a paid Apple
   Developer membership, §15.1).
3. **Builds of both apps made after step 2, tried and distributed** (§15.4
   to §15.8). The id, `google-services.json` and the iOS push entitlement go
   into the binary when it is built, so only such a build can register: one
   without the id reports push as unavailable and registers nothing, and one
   without `google-services.json` gets no token on Android. Try push end to
   end in both apps on a test stack first (§15.6), and have the builds on
   people's phones before step 4. No text the API sends names an app, so one
   server serves both.
4. **The API**: `PUSH_NOTIFICATIONS=expo` (plus `EXPO_ACCESS_TOKEN` if enhanced
   push security is on). The receipt checker starts with it: every five
   minutes, in-process, safe across instances (each ticket is claimed with
   `SKIP LOCKED`).

Turning it off again is `PUSH_NOTIFICATIONS=off`: nothing more is sent and no
receipt is checked; registered devices stay in `DevicePushTokens` until their
owners log out, another account takes the device, or push is turned on again
and the housekeeping removes the stale ones (30 days after Expo said the
device is gone, 180 days unseen).

---

## 9. Post-deployment verification (do not skip)

Walk the full product loop once, in order:

1. **Auth**: sign in as the bootstrap admin; use *Forgot password* once to
   confirm email delivery and the `/update-password` redirect.
2. **Setup wizard** (`/admin/setup`): create an academic year (mark active),
   3+ subjects, 2+ rooms, 2+ groups.
3. **People** (`/admin/people`): invite one teacher and a few students
   (assign students to a group). Confirm the teacher receives the invite
   email and can set a password.
4. **Demand** (`/admin/requirements`): add requirements (e.g. each group ×
   each subject, 2 lessons/week) and assign the teacher.
5. **Constraints** (`/admin/constraints`): add one teacher-unavailable slot.
6. **Generate** (`/admin/generate`): run optimization; watch the job reach
   *SUCCEEDED* with a FEASIBLE/OPTIMAL solver status. Then temporarily make a
   teacher unavailable all week and re-run to confirm the **conflict report**
   renders; delete that constraint and generate again.
7. **Publish** (`/admin/timetable`): review per group/teacher, publish, and
   confirm `CalendarLessons` appear for the term.
8. **Teacher flow**: sign in as the teacher (web): weekly schedule shows;
   record attendance for today's lesson. In Rastra, with an internal build
   whose EAS environment points at this deployment (§15.4, §15.5): sign in,
   open the schedule tab, take attendance in airplane mode, re-enable
   network and confirm the queue syncs (banner returns to *Connected*,
   records appear in the web view). Push stays off here until §8.1; its
   device check is §15.6.
9. **Student flow**: sign in as a student; verify they see **only** their own
   schedule and attendance.
10. **Automated suites**: `npm run test:e2e` (API), `npm run test:engine`
    (solver), and `cd web && npx playwright install chromium && npx
    playwright test` (web smoke) from any healthy machine or CI.

## 10. Operations

- **Backups**: enable Supabase PITR/daily backups. The database is the only
  stateful component — API, solver and web are stateless.
- **Gallring cannot be undone in Rastra.** A school's retention periods
  (`/admin/dataskydd`) delete attendance, absence reports, leave requests,
  notices and logs older than the period, null old absence reasons, and
  pseudonymise people who left, every night from 03:00 local time. Each
  night's run is a `GallringRuns` row of counts (no ids, no names). If a
  school recorded a wrong period, restoring rows means restoring the
  database to a point before that night's run from PITR, within its
  retention window, so keep PITR on before any school sets a period. The
  page and the database guard against a wrong click: nothing goes until a
  period is set, and a period that removes more than the one before it
  waits 24 hours. A departed person's login is deleted at Auth just before
  they are pseudonymised, if `"invitedAt"` says they had one (§7, §11.1).
- **The read log (läslogg)**: every gateway read of another person's data
  (people, rosters, attendance, absence and leave, guardian links, posts and
  load, staff absences, SS12000 reads with a key) writes a
  `PersonalDataAccess` row in the read's own transaction, through
  `app.personal_data_read` (20261026091000): reader, role, kind, channel,
  and the ids read about, never the data. The write is one statement more on
  each such read, and a read whose log cannot be written fails, so the
  migration must be in the database before an API that writes it runs. The
  school's admin answers "who read about this pupil" on `/admin/dataskydd`;
  the log's retention is the `ACCESS_LOG` kind there, "ej beslutat" until
  the school decides. The web and the app read other people's rows only
  through the gateway; PostgREST's `authenticated` keeps its own-row reads
  until the closing migration takes the rest (its comment lists what stays).
  20261026110000 adds the kinds `SCHEDULE` (a pupil's timetable: the
  family's week, and an SS12000 v2 activities or calendarEvents read filtered
  to the pupil) and `TEACHING_TIME` (timplan coverage per pupil and the
  pupil's statement), and the planning previews, the cover board, day
  proposal and reports, the uppdrag list, the sync's change review and a
  person's PATCH record under the existing kinds. It, too, must
  be in the database before the API that writes them: an unknown kind is
  22P02 and fails the read. What is deliberately not recorded (the timetable
  layer, pushes, notices, a create's echo) is listed with the reason in
  `src/access-log/access-log.ts`. 20261028090000 closes the tables those
  reads come from as the closing migration closed the six: directly,
  `authenticated` keeps a teacher's own post, uppdrag, history, absences
  and covers and a pupil's own class history and statement, and the rest
  (staff absences, posts, uppdrag, class histories, statements, the sync's
  changes) is read through the gateway. No client reads these tables
  directly, so it waits for no release, only for the closing migration.
- **Skolenheter**: 20261031090000 adds `SchoolUnits` (a school's
  skolenheter with skolenhetskod, skolformer and årskurser, set up under
  `/admin/groups`). Every SS12000 v2 request reads it under the service
  principal, and the sync's dry run and apply read and lock it, so the
  migration must be in the database before the API that reads it runs: the
  migration first, then the merge. It is additive and changes nothing for a
  school without units (none has any when it runs): the provider emits the
  school itself exactly as before, and the replaced
  `app.ss12000_organisation_moved` behaves as before. A school's first sync
  after the deploy proposes its chosen skolenheter as units (never applied
  by the night). The first unit a school
  creates moves every SS12000 object that names an organisation (one
  `Ss12000EntityVersions` row each) and lists the school's own Organisation
  id in `/deletedEntities`, so a consumer subscribed to the school sees one
  large notice. The SCB file reads the units when the export is made.
- **SCB-filen**: 20261111090000 adds the enum `TeacherEmploymentForm` and
  three nullable columns to `TeacherEmployments` (`employmentForm`,
  `firstTeacherPercent`, `lecturerPercent`, with their CHECKs). Prisma names
  every column it reads, and every read of a post (the load report, the
  staffing checks on each timplan write, the rollover) now names these, so
  the migration must be in the database before the API: the migration
  first, then the merge. It is additive and changes no row, and takes its
  one lock (ACCESS EXCLUSIVE on `TeacherEmployments`) NOWAIT in a loop, as
  20261104090000 does: no request queues behind it, and if the table is
  not free once in 30 s it stops with nothing changed —
  `prisma migrate resolve --rolled-back
  20261111090000_en_tjanst_har_anstallningsform_och_karriartjanst`, then
  deploy again. The new `GET /api/v1/staffing/scb-file` builds SCB's
  Pedagogisk personal text file on the server, for an administrator who
  reads HR data (rektor, full, or HR-läs; anyone else gets 403
  `HR_NOT_YOURS`), and writes one `EMPLOYMENT` and one `PEOPLE` läslogg
  row per download; the browser no longer builds the SCB underlag. A PUT of a post that leaves the three fields out keeps them, so
  a web from before the release, open in a tab, clears nothing. The other
  way round does not hold: the new web sends the three keys on every save
  of a post, and the API before this release refuses a key it does not know
  (400, `forbidNonWhitelisted`), and has no `/staffing/scb-file` (404). So
  the API goes out before, or with, the web: the migration, then the API,
  then the web.
- **Lärarens dag**: 20261123090000 adds two nullable columns to
  `TeacherWorkRules` (`maxTeachingMinutesPerDay`, the daily cap in minutes,
  and `preferredFreeDayOfWeek`, the free-day wish), one to
  `TeacherEmployments` (`maxTeachingDaysPerWeek`, deltid in days, HR data
  like the tjänstgöringsgrad), their CHECKs, and the trigger
  `TeacherWorkRules_day_is_planned`, which keeps the cap and the wish for an
  administrator who writes planering (a teacher still writes their own lunch
  and rest). 20261123090100 adds `OptimizationJobs."notes"` (the free-day
  wishes a finished run could not keep) and moves every `OptimizationJobs`
  policy to the API's role, because a stored refusal can now name a post's
  days, which the API rewrites for an administrator without HR-läs and
  PostgREST could not; no client reads runs directly. Prisma names every
  column it reads, and the API reads all four, so both migrations go in
  before the merge: the migrations first, then the merge. Both are additive,
  change no row, and take their locks NOWAIT and together in a loop
  (`TeacherWorkRules` and `TeacherEmployments` in the first,
  `OptimizationJobs` in the second): no request queues behind them, and if
  the tables are not free at once in 30 s each stops with nothing changed —
  `prisma migrate resolve --rolled-back <name>`, then deploy again. The API
  before the release names only the old columns, so it keeps working
  between the migration and the deploy. The engine and the API deploy from
  the same merge: the new fields reach the engine only once an administrator
  has set a cap, a wish or a number of days, which nobody can do before the
  new web is out, so the short window where the API is new and the engine
  old sends nothing the old engine refuses. A PUT of a work rule or a post
  that leaves the new fields out keeps them, and a DELETE of a work rule
  keeps the cap and the wish unless it says `?includeDay=true` (which only
  the new web sends), so a web from before the release, open in a tab,
  clears nothing; the new web sends the new keys, which the API
  before the release refuses (400, `forbidNonWhitelisted`), so the API goes
  out before, or with, the web.
- **Schemaförslag**: 20261125090000 adds `ScheduleCandidateRuns` and
  `ScheduleCandidates` (a year's private candidates, read by the school's
  administrators and written by Schemaläggning, every arm on the API's
  role), their status enum, the partial unique index that keeps one active
  run per year, and three functions: the sweep, the count of active runs
  across schools, and `app.lock_years_for_grundschema_edit`, the hand
  edit's share of the year's regeneration lock. It changes no row of a live
  table and takes its locks (SHARE ROW EXCLUSIVE on `Schools` and
  `AcademicYears`, which its keys reference) NOWAIT and together in a loop:
  if they are not free at once in 30 s it stops with nothing changed —
  `prisma migrate resolve --rolled-back
  20261125090000_ett_schemaforslag_ar_privat_tills_det_tillampas`, then
  deploy again. The API before the release reads neither table and keeps
  working beside it, and the new API calls the lock function on every hand
  edit, so the migration goes in first, then the merge. The engine and the
  API deploy from the same merge, and only a candidate run sends the
  optional `search` field: an engine from before the release refuses it,
  which the run says as `ENGINE_LACKS_CANDIDATES` ("try again in a few
  minutes"), while Generera sends nothing new. After the deploy the
  engine's `/openapi.json` names `SearchOptions`. Set
  `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` (above); the `CANDIDATE_*` defaults
  need no setting.
- **Restid i generatorn**: 20261209090000 adds one column,
  `LunchSettings."generatorKeepsTravelTime"` (boolean, NOT NULL, default
  false): the Skolregler switch that has the generator keep the walk between
  the school's skolområden. It changes no row and takes its one lock (ACCESS
  EXCLUSIVE on `LunchSettings`) NOWAIT in a loop: if the table is not free
  once in 30 s it stops with nothing changed — `prisma migrate resolve
  --rolled-back 20261209090000_generatorn_haller_restiden_nar_skolan_slar_pa_den`,
  then deploy again. The API before the release names only the old columns,
  so it keeps working between the migration and the deploy; the new API
  reads the column, so the migration goes in first, then the merge. The
  engine and the API deploy from the same merge, and the three new optional
  fields (`siteTravelTimes` and each room's `siteId` in a generation, and
  `siteId` on a room sent to Optimera salar) reach the engine only once a
  school has turned the switch on with a travel time written (Optimera
  salar: one above zero), which nobody can do before the new web is out: so the short window where
  the API is new and the engine old sends nothing the old engine refuses. A
  PUT of the Skolregler that leaves the switch out keeps it, so a web from
  before the release, open in a tab, turns nothing off; and the new web
  leaves the key out unless the API it read named it, or the admin turned
  the switch on, so a lunch save never meets the old API's 400
  (`forbidNonWhitelisted`) and the web and the API may go out in either
  order. After the deploy the engine's `/openapi.json` names
  `SiteTravelTime`.
  **Rolling it back:** the engine before this release refuses the new fields
  (its request models are `extra="forbid"`: 422), so once a school has turned
  the switch on, an engine rolled back alone — or one deployed after the API
  and the web — fails that school's Generera, schemaförslag and Optimera
  salar, and the web before the release has no switch to turn it off with.
  Roll the API back first, or with the engine: the API before the release
  sends neither field. If the API must stay, turn the switch off for every
  school before the engine goes back (`UPDATE "LunchSettings" SET
  "generatorKeepsTravelTime" = false WHERE "generatorKeepsTravelTime";`, as
  the owner), and tell the schools it was. The column itself can stay through
  a rollback: nothing before the release reads it, and the migration is not
  undone.
- **Elevernas håltimmar**: 20261216090000 adds one column,
  `LunchSettings."generatorKeepsPupilGapsDown"` (boolean, NOT NULL, default
  false): the Skolregler switch that has the generator keep the pupils' idle
  time down, counted per set of pupils booked alike as the håltimmesrapport
  counts it. It changes no row and takes its one lock (ACCESS EXCLUSIVE on
  `LunchSettings`) NOWAIT in a loop, as the travel switch's did: if the table
  is not free once in 30 s it stops with nothing changed — `prisma migrate
  resolve --rolled-back
  20261216090000_generatorn_haller_nere_elevernas_haltimmar`, then deploy
  again. Before: `SELECT count(*) FROM "LunchSettings"` and the column absent
  from `information_schema.columns`. After: the column present, boolean, NOT
  NULL, default false, and `SELECT count(*) FROM "LunchSettings" WHERE
  "generatorKeepsPupilGapsDown"` is 0. The API before the release names only
  the old columns, so it keeps working between the migration and the deploy;
  the new API reads the column, so the migration goes in first, then the
  merge. The engine and the API deploy from the same merge, and the new
  optional request field (`pupilGaps`) reaches the engine only once a school
  has turned the switch on, which nobody can do before the new web is out.
  The response's `pupilIdleMinutes` is sent only to such a request, and the
  API reads it nowhere yet. A PUT of the Skolregler that leaves the switch
  out keeps it, and the new web leaves the key out unless the API it read
  named it or the admin turned it on, so the web and the API may go out in
  either order. After the deploy the engine's `/openapi.json` names
  `PupilGaps`, `PupilGapCohort` and `FixedLessonMargin`, and
  `OptimizeScheduleResponse` gains `pupilIdleMinutes`; nothing else in it
  moves. The weight is `WEIGHT_PUPIL_GAP` (default 4 per pupil and
  five-minute slot, with the rest of the objective scaled by 25 when the rule
  is on); it needs no setting.
  **Rolling it back:** the engine before this release refuses `pupilGaps`
  (`extra="forbid"`: 422), so once a school has turned the switch on, an
  engine rolled back alone fails that school's Generera and schemaförslag.
  Roll the API back first, or with the engine: the API before the release
  never sends it. If the API must stay, turn the switch off for every school
  before the engine goes back (`UPDATE "LunchSettings" SET
  "generatorKeepsPupilGapsDown" = false WHERE "generatorKeepsPupilGapsDown";`,
  as the owner), and tell the schools it was. The column can stay through a
  rollback: nothing before the release reads it.
- **Sammanhängande undervisning**: 20261218090000 adds two nullable columns to
  `TeacherEmployments`, the post (`maxConsecutiveTeachingMinutes`, the most
  minutes of teaching in a row, 30–480, and `consecutiveBreakMinutes`, the free
  time that ends a stretch, 5–120; both multiples of five, set together or not
  at all, each range and the pair with a CHECK of its own, named
  `TeacherEmployments_…_check`), and one to `LunchSettings`
  (`generatorKeepsConsecutiveTeaching`, boolean, NOT NULL, default false): the
  Skolregler switch that has the generator *try* to keep each teacher's
  stretches within their limit. **It is off for every school until that school
  turns it on**; the migration turns nothing on and changes no row, so every
  post reads null and null and every Skolregler row reads off.
  **THE LIMIT IS HR DATA, and sits on the post beside the days**
  (`maxTeachingDaysPerWeek`, 20261123090000), not on the work rule: it may be
  an arbetsanpassning after sick leave (the user decided this 2026-11-02, after
  the first build had put it on the work rule). The work rule is read in every
  column by every teacher and administrator of the school and row security
  cannot hide a column; the post is the table whose administrator arms are the
  API role's alone (20261028090000), whose teacher reads only their own, and
  whose gateway read leaves HR columns out for an administrator without HR-läs
  (`hideHr`). So the limit is written by those who decide (rektor, a full
  administrator: `@Decides`, and a schemaläggare no longer sets it), read in
  full by anybody with HR-läs and by the teacher themself, and recorded in the
  Läslogg (EMPLOYMENT) whenever it is shown or read for the generator. Nobody
  else sees a figure or a weekday of it anywhere, but that is NOT the same as
  seeing nothing: exactly as for the days, a reader without HR-läs is told "can
  not, because of a working-time rule" without the number. The Vikarietavla
  names a teacher it cannot offer a pass (`excluded[]` carries the teacher with
  `CONSECUTIVE_TEACHING_HIDDEN`, and the candidate dialog shows the name beside
  "Skulle undervisa längre i följd än anställningen medger"), and a hand edit's
  warning carries the lesson and the role, so a named teacher's having a limit
  can show from an exclusion, a warning or a missing substitute. Both are
  recorded in the Läslogg (EMPLOYMENT). A run's note and a schemaförslag name
  nobody. That was the user's choice (parity with the days); tightening it
  (leaving the teacher out of `excluded[]` for a reader without HR-läs) is a
  behaviour change not made here. A hand edit's warning, the Vikarietavla's
  "Kan inte" and manual-pick warning and a run's note each have a `_HIDDEN` twin
  without figures
  (`TEACHER_CONSECUTIVE_TOO_LONG_HIDDEN`, `CONSECUTIVE_TEACHING_HIDDEN`,
  `COVER_EXCEEDS_CONSECUTIVE_TEACHING_HIDDEN`,
  `TEACHER_CONSECUTIVE_TEACHING_HIDDEN`), the post's history leaves out a
  version that changed only the limit, and a schemaförslag stores the one
  hidden note for every reader (so its comparison cannot say how many teachers
  it concerns). The year rollover carries the limit with the post
  (`COPY_UNLESS_DEFAULT`, and the preview names the posts that have one). The
  limit is the läsår's, like the days, and a teacher with no post that year
  cannot have one. It is not emitted by SS12000 (a change to it alone moves the
  v1 Duty's `meta.modified`, as the days do; `docs/integration-api.md`).
  The limit is the generator's wish and not its promise (it pays for a lesson
  whose stretch is not ended in time and refuses no week over it, and Generera
  names the teachers it did not manage, to those who read HR); a hand edit of
  the grundschema is warned and the Vikarietavla never proposes a cover that
  would break it, and neither of those two looks at the switch.
  **The work rule is untouched**: this migration no longer replaces the trigger
  function `app.teacher_work_rules_day_is_planned()` (it stays as
  20261123090000 made it, with its sentence about the cap and the wish), and
  the work rule's cap (20261123090000) stays staff-readable, which is a known
  difference from the limit that the user has not asked to change.
  It takes ACCESS EXCLUSIVE on `TeacherEmployments` and `LunchSettings`, NOWAIT
  and together in a loop: the generator reads both at the start of every run
  (the posts for the days and now the limits), the Skolregler card and the
  anställning card on every load, and requests take them in both orders, so a
  migration that waited for one while it held the other could close a cycle. A
  refusal gives back whatever it got and tries again 50 ms later, so it never
  waits while it holds a lock and no request queues behind it; if the two are
  not free at once in 30 s it stops with nothing changed —
  `prisma migrate resolve --rolled-back
  20261218090000_en_larares_foljd_av_lektioner_har_en_grans_som_generatorn_forsoker_halla`,
  then deploy again. Before: the three columns absent from
  `information_schema.columns`. After: the three present, and `SELECT
  count(*) FROM "TeacherEmployments" WHERE "maxConsecutiveTeachingMinutes" IS
  NOT NULL OR "consecutiveBreakMinutes" IS NOT NULL` and `SELECT count(*) FROM
  "LunchSettings" WHERE "generatorKeepsConsecutiveTeaching"` both 0, and
  `TeacherWorkRules` without them.
  The API before the release names only the old columns, so it keeps working
  between the migration and the deploy: its PUT of a post updates the columns
  it knows and leaves these (absent keeps), its INSERT leaves them null and
  null, which the pair CHECK admits, and its rollover writes next year's posts
  without them; its upsert of the Skolregler does not name the switch, so a
  save leaves it as it was. The new API names the columns in every read of a
  post and of the Skolregler, so the migration goes in first, then the merge.
  The engine and the API deploy from the same merge, and the two new optional
  fields of a teacher in the request (`maxConsecutiveTeachingMinutes`,
  `consecutiveBreakMinutes`, on the teacher's work-rule entry, the engine's
  contract unchanged) reach the engine only for a school that has turned the
  switch on and a post that sets both, which nobody can do before the new web
  is out: so the short window where the API is new and the engine old sends
  nothing the old engine refuses. A PUT of a post that leaves the two fields
  out keeps them, so a web from before the release, open in a tab, clears
  nothing. The other way round does not hold for the anställning card: the new
  web sends the two keys, which the API before the release refuses (400,
  `forbidNonWhitelisted`), so the API goes out before, or with, the web. The
  Skolregler card leaves the switch's key out unless the API it read named it
  or the admin turned the switch on, so a lunch save never meets that 400.
  After the deploy the engine's `/openapi.json` names the two fields on a
  teacher; the weight is `WEIGHT_CONSECUTIVE_TEACHING` (default 250 per
  lesson whose stretch is not ended in time, 0 or below switches it off) and
  needs no setting. 250 is far above the wished free day (40) and the
  disruption term (8 a slot) on purpose: at 40 the wish did not hold in the
  measurement (docs/verification-baseline.md). The consequence is a priority a
  school should be told: with the switch on, a regeneration moves a flagged
  teacher's lessons before it keeps last term's places or a pupil's free hour,
  and when the search has little time (the pupils' free hours and the
  teachers' free days both on, or a short budget) it may not manage the
  limit at all, which Generera then says by name.
  What the limit does not see, stated here and in the manual (4.4): a lesson
  a shared teacher gives at ANOTHER school counts as free time, in all four
  places (the generator gets it as an UNAVAILABLE reservation, and the hand-edit
  warning, the notes after a run and the Vikarietavla read this school's own
  lessons only), so 08–10 here, 10–11 there and 11–12 here is no stretch over
  180 minutes; the limit is on this school's post. Since Terminer (section
  19) the engine reads a stretch in each part of the läsår on its own, so
  an autumn post and a spring post that never meet are never one stretch.
  The engine clips a locked window to the school day, so a lock
  07:30–08:30 counts 08:00–08:30 there and 07:30–08:30 in the gateway.
  **Do not roll the API back past this release once a limit is set.** The old
  API's history lists every key of the post's logged JSON that it does not know,
  and its `hideHrChanges` masks only the keys it does know, so an administrator
  without HR-läs would be shown the limit (and that it changed) in Historik by
  the old code, and those versions cannot be removed afterwards: the history is
  append-only. It is a one-way door for the API as soon as the first limit is
  set; the API is also the door most often opened in an incident. Consider
  setting no first limit until the release has stood for a week.
  **What the allow lists of #239 change about that, and what they do not.**
  The rule stays: it is about an API from before this release (#231), which
  does not know the limit's keys and shows them. An API from #231 on masks
  them, and the floor of the rule is #231. From #239 on, what a reader without
  HR-läs is handed of a post is an allow list in both places the post leaves
  the gateway. In Historik, `hideHrChanges` shows a field of the post only if
  it has been argued in (`NOT_HR_IN_A_POST` in `src/staffing/hr-visibility.ts`),
  says that a percentage or one of SCB's three changed, and leaves out
  everything else, name and value. In the post as the list and the PUT answer
  hand it out, `hideHr` hands over the columns of `POST_READ_AS_IS` with their
  values, nulls those of `POST_READ_NULLED` beside `hrHidden`, and leaves out
  every other key of the row. So a column added AFTER #239 is hidden in
  Historik also when the API is rolled back to a release that has the allow
  list (#239 or later): that API does not know the column, and what it does
  not know it does not show. No rule like this one is needed for the next
  column, as long as the rollback stays at or after #239. Rolled back past #239
  (to #231 or earlier), the next column is shown in Historik again, values and
  all, as the limit is by an API from before #231, and the versions written
  meanwhile are append-only. The post is not exposed by a rollback: Prisma
  selects only the columns of its own model, so an API that predates a column
  never reads it into a post. There the allow list is for a column that has
  been added to the model and not yet placed: it is left out of the answer to
  a reader without HR-läs until somebody places it, and a spec
  (`hr-visibility.spec.ts`) fails on the model's column list until then.
  Two things a reader without HR-läs notices when #239 is deployed, which the
  manual (4.3) now says. A version that only wrote or changed the post's note
  (`noteChanged`) is no longer in their Historik: the post hands the note over
  as null, so that one was written is what it withholds, and it is where the
  reason for a nedsättning would be written. This changes the versions already
  written as well, since the mask is applied when the history is read. And they
  are no longer handed version numbers, which would have holes where an HR
  version was left out; an older API hands them again, and a web rolled back
  past #239 beside this API writes an empty number for that reader ("Version "
  on the card, "version  (datum)" on the printed stamp) until the API goes back
  with it.
  **Rolling it back:** the engine before this release refuses the two fields
  (its request models are `extra="forbid"`: 422), so once a school has turned
  the switch on and a post has a limit, an engine rolled back alone fails that
  school's Generera and schemaförslag. Roll the API back first, or with the
  engine: the API before the release never sends them. If the API must stay,
  turn the switch off for every school before the engine goes back (`UPDATE
  "LunchSettings" SET "generatorKeepsConsecutiveTeaching" = false WHERE
  "generatorKeepsConsecutiveTeaching";`, as the owner), and tell the schools it
  was. The columns can stay through a rollback: nothing before the release
  reads them. **But do not roll the API back once a limit is set.** The old
  API's history (from before #231; #239's is no such API, see above) lists
  every key of the post's logged JSON it does not know, and `hideHrChanges`
  masks only the keys it does know, so an administrator without HR-läs would
  be shown the limit (and that it changed) in Historik by the old code. If the
  API must go back, clear the limits first (as the owner) and
  accept that they are lost, or leave the old API unserved to anyone but those
  with HR-läs. Two things an API from before the release does with a post that
  holds a limit, which a rollback must not forget: its PUT of a post names
  neither field and so leaves them, and its rollover writes next year's posts
  without them, so a year rolled by the old API starts with no limits. List the
  limits before rolling back (`SELECT "userId", "maxConsecutiveTeachingMinutes",
  "consecutiveBreakMinutes" FROM "TeacherEmployments" WHERE
  "maxConsecutiveTeachingMinutes" IS NOT NULL;`, as the owner; the figures are
  HR data, so do not keep the output with names) and tell the schools that, until
  the release is back, a rollover carries no limit.
- **Rastvakt i vardagen**: 20261210090000 adds `SupervisionCovers` (the
  vikarietavla's decision on an absent rastvakt's pass on one date: a
  vikarie, or none), the enum `SupervisionCoverDecision`, an `(id,
  schoolId)` key on `SupervisionShifts`, two `NotificationType` values
  (`SUPERVISION_COVER`, `SUPERVISION_COVER_WITHDRAWN`), and
  `app.teacher_absences_own_writes_are_narrow` again with the pass decisions
  asked beside the lessons'. It takes `Schools`, `Users`, `TeacherAbsences`,
  `SupervisionAreas` and `SupervisionShifts` in SHARE ROW EXCLUSIVE, NOWAIT,
  all at once in a loop: reads and foreign-key checks go on, writes to the
  five wait for the file, and if the five are not free at once in 30 s it
  stops with nothing changed — `prisma migrate resolve --rolled-back
  20261210090000_en_franvarande_rastvakts_pass_hamnar_pa_vikarietavlan`,
  then deploy again. Run it outside an SS12000 sync window. The two enum
  values are added in the migration's own transaction, and nothing in it
  uses them (Postgres refuses a value before its commit). Adding them holds
  up no notice of another type, and no other session sees them before the
  commit. The API before the release names neither the table nor the
  values, so it keeps working between the migration and the deploy. The
  migration goes in first, then the merge.
  **Clients from before the release:** an app build from before it shows
  the two notices with its fallback text ("Notis"), and in Settings it
  shows their two rows by catalogue key, on and not switchable (both are
  always delivered to staff). This release's web says "Ny notis" for any
  type it has no words for, and its settings say "Andra notiser". The web
  before it draws such a notice as an empty line in the bell.
  **Rolling it back:** the migration stays. Prisma's client throws on any
  read that selects a notice's type from a row holding a value it does not
  know (`Value 'SUPERVISION_COVER' not found in enum 'NotificationType'`).
  That was tried with main's client against a database holding such rows.
  The API before the release has no such read, so a rolled-back API
  answers as before:
  - the bell and the app read `Notifications` through PostgREST;
  - the one Prisma read of the enum is the person's opt-outs
    (`NotificationOptOuts`), which never hold the two types through the
    gateway: this release refuses opting out of them (400). A row written
    past the gateway (the table's own insert arm for `authenticated` admits
    any type) would make that person's `GET /notification-preferences` a 500
    on the API before the release. Before rolling back, as the owner, count
    them; nonzero means delete those rows (both types are always delivered,
    so an opt-out of them means nothing):
    `SELECT count(*) FROM "NotificationOptOuts" WHERE "type"::text IN
    ('SUPERVISION_COVER', 'SUPERVISION_COVER_WITHDRAWN');`

  What a rollback does change:
  - The board's pass decisions stay in the database with nothing reading
    them, and a booked vikarie is not told. Before rolling back, list the
    bookings ahead, as the owner, and tell those schools:
    `SELECT "schoolId", "date", "substituteId" FROM "SupervisionCovers"
    WHERE "decision" = 'SUBSTITUTE' AND "endsAt" > now();`
  - The lessons' candidates before the release do not see a vikarie's or
    a teacher's pass, so they can propose somebody on the yard at that
    time.
  - Removing a person no longer asks about their pass bookings.
  - The teacher's week shows no passes.
  - The guard on a teacher's own absence keeps asking the pass decisions,
    which the API before the release reports as its existing
    `ABSENCE_SELF_EDIT_NARROW`.

  **Rolling forward again** (or after old and new containers ran side by
  side in a deploy): the API before the release withdraws or shortens an
  absence without its pass decisions, so a decision can stand on an absence
  that is no longer ACTIVE, or outside an ACTIVE one that was shortened, its
  vikarie still booked. This release shows both on the vikarietavla, noted
  *Frånvaron är återkallad* or *Ligger inte längre inom frånvaron*, and
  Ångra tells the vikarie. Until it is undone such a decision holds as a
  decision does (the pass cannot be moved, its teacher cannot be removed,
  its vikarie is busy then), except that a withdrawn absence's relieves the
  pass's own teacher of nothing. List them, as the owner, and have each
  school undo its own:
  `SELECT c."schoolId", c."date", c."shiftId" FROM "SupervisionCovers" c
  JOIN "TeacherAbsences" a ON a."id" = c."absenceId" WHERE c."endsAt" > now()
  AND (a."status" <> 'ACTIVE' OR NOT (c."startsAt" < a."endsAt" AND
  c."endsAt" > a."startsAt")) ORDER BY 1, 2;`
- **Frånvarobevakning**: 20261231090000 adds the `NotificationType` value
  `ABSENCE_WATCH_DIGEST` and nothing else (a value cannot be used in the
  transaction that adds it, so it is a file of its own). 20261231090100 adds
  the tables `AbsenceWatchSettings`, `AbsenceWatchLimits`,
  `AbsenceWatchFindings` and `AbsenceWatchDigests`, four enums, eleven
  `app.absence_watch_*` functions (nine SECURITY DEFINER with a pinned
  `search_path`, two that run as the caller), the triggers on the switch and the limits,
  and `app.gallring_due` and `app.gallring_purge` again with the findings
  under the ATTENDANCE kind. No existing row is touched and no existing table
  gains a column. The new keys take `Schools` and `Users` in SHARE ROW
  EXCLUSIVE, NOWAIT, together in a loop: reads and foreign-key checks go on,
  writes to the two wait for the file, and if both are not free at once in
  30 s it stops with nothing changed (`prisma migrate resolve --rolled-back
  20261231090100_franvarobevakning_med_granser_och_sammanstallningar`, then
  deploy again). The API before the release knows none of the objects and
  writes no notice of the new type, so it keeps working between the
  migration and the deploy. The migration goes in first, then the merge.
  **The bevakning is off for every school** until its administrator turns it
  on (no row in `AbsenceWatchSettings`), so deploying changes nothing a
  school sees. Nothing is sent to anyone until a school has turned it on,
  given a mottagargrupp a limit, and a week or month has ended on or after the
  day it was turned on: the first digest comes on the first Monday (or the 1st,
  for a group on months) after that and can cover a period the bevakning saw
  only the end of.
  **Before the migration**, as the owner: no `app.absence_watch_%` function and
  no `AbsenceWatch%` table exist (`SELECT count(*) FROM pg_proc WHERE proname
  LIKE 'absence_watch%'` and `SELECT count(*) FROM pg_tables WHERE tablename
  LIKE 'AbsenceWatch%'` are both 0), `prisma migrate status` lists exactly the
  two new migrations as pending, and no session sits idle in a transaction
  that holds `Users` or `Schools` (`SELECT pid, state, now() - xact_start FROM
  pg_stat_activity WHERE state = 'idle in transaction'`).
  **After it, before the merge:** the four tables have row security on and
  `app_authenticated` holds only SELECT on the findings and the ledger
  (`SELECT relname, relrowsecurity FROM pg_class WHERE relname LIKE
  'AbsenceWatch%'`; `SELECT has_table_privilege('app_authenticated',
  'public."AbsenceWatchFindings"', 'INSERT, UPDATE, DELETE')` is false); none
  of the functions is executable by `anon`, `authenticated` or PUBLIC
  (`SELECT p.oid::regprocedure FROM pg_proc p WHERE p.proname LIKE
  'absence\_watch\_%' AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR
  has_function_privilege('authenticated', p.oid, 'EXECUTE'))` returns no
  row); `SELECT count(*) FROM "AbsenceWatchSettings"` is 0. Also: there are
  11 functions (`SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid =
  p.pronamespace WHERE n.nspname = 'app' AND p.proname LIKE
  'absence\_watch\_%'`); no role of the four holds MAINTAIN on the tables
  (`SELECT count(*) FROM pg_class c, unnest(ARRAY['anon', 'authenticated',
  'service_role', 'app_authenticated']) r WHERE c.relname LIKE 'AbsenceWatch%'
  AND c.relkind = 'r' AND has_table_privilege(r, c.oid, 'MAINTAIN')` is 0);
  `app_authenticated` runs five of the functions and not
  `app.absence_watch_digest_plan`, which only `app.absence_watch_digest` asks
  for, as the owner; and both gallring functions carry the findings' branch
  (`SELECT proname, position('AbsenceWatchFindings' IN prosrc) > 0 FROM pg_proc
  WHERE pronamespace = 'app'::regnamespace AND proname IN ('gallring_due',
  'gallring_purge')` is true on both). A later migration that replaces
  `app.gallring_due` or `app.gallring_purge` has to carry that branch along
  (the owner checks, section 309o, fail when it does not); ask again after it.
  **After the merge:** `JobRuns` gets a row for `absence-watch` within five
  minutes of the new instance serving (`SELECT job, runs, failures, counts
  FROM "JobRuns" WHERE job = 'absence-watch' ORDER BY day DESC LIMIT 3`),
  its counts `{"schools": 0}` while no school has the switch on, and
  `GET /health/ready` counts the job under `jobs.scheduled`. The first
  school to turn it on is counted the next night after 05:00 local time:
  `opened` is the number of findings, `pupils` the pupils with a registered
  lesson in the last 90 days, `digests` and `notices` what was written. Count
  time on a school of 500 pupils and a year of attendance (603 000 marks,
  `scripts/bench/absence-watch.sql`) is 0.3 s, a whole night through the
  gateway 0.4–0.65 s on a host under load; the job lifts the delivery door's
  5 s statement limit to 9 s for the count. The worst night is an influenza
  wave, three pupils in ten away on every lesson for seven school days, with a
  "3 days in a row" limit for each group: the bench's last part counts it in
  0.4–1.0 s with four such limits and in 1.0–1.1 s with all twelve (a group
  and a basis each, the most the key allows), the 0.3 s plus about 0.07 s for
  each run limit. A step reads a pupil's day once for each limit, so the
  count grows in step with the pupils and the limits and a school several
  times larger still goes through. A school that fails is counted in `failed`
  and retried two hours later the same day.
  **Gallring:** the findings follow the school's decision for *Närvaro*
  (`RetentionDataType` ATTENDANCE): by the day each was last seen, in the same
  batches. A school that has decided nothing loses none. A school that purges
  attendance after a period shorter than a limit's window (a 1-month period and a
  60-day window) is counted over what is left: the count cannot see what gallring
  took, and the finding still names the window.
  **Known limit:** the e-mail and the push go to the delivery's in-memory queue
  after the commit, as every other notice does, so a process that stops between
  the commit and the send loses them for that period: the inbox notice is
  written, and the digest's ledger row keeps it from being written again.
  **Clients from before the release:** the web and the app before it draw the
  digest notice with their fallback text ("Ny notis" / "Notis") and list it in
  Settings under its catalogue key, switchable. The digest's e-mail and push
  carry counts only: no name, no class, no minutes, no reason.
  **Rolling it back:** the migration stays, and the API before the release
  never reads the new tables. Prisma's client throws on a read that selects a
  notice's type from a row holding a value it does not know, and the one such
  read is the person's opt-outs: a person who switched the digest off while
  the release was live would make `GET /notification-preferences` a 500 on the
  API before it. Before rolling back, as the owner, count them; nonzero means
  delete those rows (the person is asked again when the release returns):
  `SELECT count(*) FROM "NotificationOptOuts" WHERE "type"::text =
  'ABSENCE_WATCH_DIGEST';`. What a rollback changes: nobody is counted or sent
  a digest, the findings made stay in the table unread, and a school that has
  the bevakning on keeps its switch and limits for the day the release is
  back. The notices already written stay in people's inboxes.

- **Vikariefrågan**: 20270102090000 adds the `NotificationType` values
  `COVER_REQUESTED`, `COVER_REQUEST_ACCEPTED` and `COVER_REQUEST_CLOSED` and
  the `RetentionDataType` value `COVER_REQUESTS` and nothing else (a value
  cannot be used in the transaction that adds it, so it is a file of its own:
  never run the two files in one `psql -1`). 20270102091000 adds the tables
  `CoverRequests`, `CoverRequestLessons`, `CoverRequestRecipients` and
  `CoverConfirmations` with 15 policies, the triggers that let a request end
  once, the functions `app.cover_request_sender`, `app.cover_confirm`,
  `app.cover_my_passes`, `app.cover_requests_settle` and
  `app.cover_request_is_open` (executable by `app_authenticated` alone), and `app.gallring_due` and `app.gallring_purge`
  again with the new kind. No existing row is touched and no existing table
  gains a column. The new keys and triggers take `Schools`, `Users`,
  `TeacherAbsences`, `CalendarLessons` and `TeacherAbsenceCovers` in SHARE
  ROW EXCLUSIVE, NOWAIT, together in a loop: reads and foreign-key checks go
  on, writes to the five wait for the file (about 50 ms once the locks are
  taken), and if all five are not free at once in 30 s it stops with nothing
  changed in the second file (`prisma migrate resolve --rolled-back
  20270102091000_en_vikarieforfragan_gar_till_kollegor_och_den_forsta_som_tackar_ja_far_uppdraget`,
  then deploy again). NOWAIT never queues, so it does not make an autovacuum
  give way: a long one on any of the five tables keeps the loop spinning for
  the 30 s. Look first (below). The API before the release knows none of the
  objects and writes no notice of the new types, so it keeps working between
  the migration and the deploy. **The migration goes in first, then the
  merge**, outside an SS12000 sync window.
  **Before the migration**, as the owner: `SHOW server_version` is the 17.x
  production runs; `prisma migrate status` lists exactly the two new
  migrations as pending; `SELECT to_regclass('"CoverRequests"')` is NULL and
  `SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE
  t.typname IN ('NotificationType', 'RetentionDataType') AND e.enumlabel LIKE
  'COVER_REQ%'` returns no row; and no session sits idle in a transaction that
  holds one of the five tables, nor an autovacuum worker on them (`SELECT pid,
  backend_type, state, now() - xact_start AS age, left(query, 70) FROM
  pg_stat_activity WHERE datname = current_database() AND (backend_type =
  'autovacuum worker' OR xact_start < now() - interval '3 seconds') ORDER BY
  age DESC`). **Gallring:** `SELECT proname, md5(prosrc) FROM pg_proc WHERE
  pronamespace = 'app'::regnamespace AND proname IN ('gallring_due',
  'gallring_purge') ORDER BY 1` must show Frånvarobevakning's bodies
  (20261231090100): `gallring_due` `2e3255fc6888125eb9b19e766d6fb64c`,
  `gallring_purge` `f9a0f2398899c414ce239b5c7c018b02`. The second file
  replaces both functions whole, built on exactly those bodies, so they carry
  both branches: the findings of the absence watch under ATTENDANCE and the
  requests under COVER_REQUESTS. Other values mean a release has restated them
  since: its branch must be carried into 20270102091000's bodies, or its rows
  are no longer purged (the RLS suite, section 315, fails when a body has
  lost either branch). After the migration the values are `gallring_due`
  `07be372dadba42ef4f7f233384306515` and `gallring_purge`
  `60b2278333a2fb0816b05e022159ee67`.
  **After it, before the merge:** both migrations are applied;
  `SELECT count(*) FROM pg_policies WHERE tablename IN ('CoverRequests',
  'CoverRequestLessons', 'CoverRequestRecipients', 'CoverConfirmations')` is
  15; `app_authenticated` holds SELECT, INSERT and UPDATE on the requests and
  the recipients and SELECT and INSERT on the lines and the confirmations,
  nothing else (no MAINTAIN), and `anon` and `authenticated` nothing at all;
  the five functions answer `app_authenticated` alone (`SELECT
  has_function_privilege('anon', 'app.cover_request_sender(uuid)', 'EXECUTE'),
  has_function_privilege('authenticated', 'app.cover_requests_settle()',
  'EXECUTE'), has_function_privilege('service_role',
  'app.cover_request_is_open(uuid)', 'EXECUTE')` is false, false, false, and
  `has_function_privilege('app_authenticated', 'app.cover_requests_settle()',
  'EXECUTE')` is true). Do not call `app.cover_requests_settle()` to see: it
  ends the requests that are due, and the gateway, not the function, tells
  the people they concern.
  **After the merge:** `GET /api/v1/cover/board` answers `requests: []` and
  `confirmations: []`; `JobRuns` gets a row for `cover-requests` within five
  minutes of the new instance serving, its counts `{"expired": 0,
  "notNeeded": 0}` while no question has been asked; `/admin/dataskydd` lists
  *Vikarieförfrågningar* as *Ej beslutat*. Then, with two accounts in a test
  school: ask two teachers, let one say yes, and the other is told it is
  taken. Look in the log for `Cover notices failed` and `nobody was told`.
  **Settling:** every five minutes the job ends the open questions whose time
  is out (`EXPIRED`, and the administrator who asked is told that nobody said
  yes) and the ones whose lesson was cancelled, whose absence was taken back
  or shortened past the lesson, or whose absent teacher left the lesson
  (`CLOSED`, and the colleagues it still waited on are told it is no longer
  needed). `COVER_REQUESTS_BACKGROUND=off` stops both; a question past its
  time still cannot be answered (the database refuses the yes), and gallring
  removes one that stands open after its time ran out once it is older than the
  school's period.
  **Notices** say how many lessons and from when, and that the answer is in
  Rastra: never subject, group or room, in the push, the e-mail's subject line
  and text, the inbox row or the web's bell, and never who is away.
  **Rolling it back:** the migrations stay, and the API before the release
  never reads the new tables. Prisma's client throws on a read that selects an
  enum column from a row holding a value it does not know: a notice of the new
  types makes the person's inbox read fail, an opt-out of one makes
  `GET /notification-preferences` a 500, and a school's decision about
  *Vikarieförfrågningar* breaks the dataskydd page. Before rolling back past
  the release, as the owner, delete those rows (the colleagues lose the inbox
  notices about their questions, the school is asked to decide again when the
  release returns; the questions themselves stay in the tables). A retention
  decision is append-only, so its guard is switched off for the one statement
  and on again in the same transaction:
  `BEGIN; DELETE FROM "Notifications" WHERE "type"::text IN ('COVER_REQUESTED',
  'COVER_REQUEST_ACCEPTED', 'COVER_REQUEST_CLOSED'); DELETE FROM
  "NotificationOptOuts" WHERE "type"::text IN ('COVER_REQUESTED',
  'COVER_REQUEST_ACCEPTED', 'COVER_REQUEST_CLOSED'); ALTER TABLE
  "RetentionDecisions" DISABLE TRIGGER "RetentionDecisions_append_only"; DELETE
  FROM "RetentionDecisions" WHERE "dataType"::text = 'COVER_REQUESTS'; ALTER
  TABLE "RetentionDecisions" ENABLE TRIGGER "RetentionDecisions_append_only";
  COMMIT;`. Count them first (`SELECT count(*) FROM "Notifications" WHERE
  "type"::text LIKE 'COVER\_REQUEST%'` and the like for the other two); the
  rows written while the release is live are the ones to remove, and the
  rollback should not be done while a school is asking. What a rollback
  changes: nobody can ask or answer a question, the vikarie's tap is gone, and
  the questions and confirmations already made stay in the tables unread.
- **Skyddad identitet**: 20270107090000 adds the tables `PersonProtections`
  (a row per person and source, SS12000 or MANUAL, never which protection)
  and `PersonProtectionEvents` (who set or removed a mark and when, written by
  a trigger alone), six policies, the value `PROTECTION` of
  `Ss12000ChangeEntity`, a CHECK on `Ss12000SyncChanges` added NOT VALID, and
  `app.gallring_due`, `app.gallring_purge` and `app.gallring_pseudonymise`
  again with their new lines. Before running it, `md5(prosrc)` of the three
  must be main's (`07be372dadba42ef4f7f233384306515`,
  `60b2278333a2fb0816b05e022159ee67`, `6925e950b02270edc12d634aa8ff2f90`);
  after, `7efba42244c71937b4cb82ffc23a6ba1`,
  `de359f739e3908c9a36e41ff541cdf13`, `6f18f62fc354bde849aa2e8b01eeceda`. It
  takes `Schools`, `Users` and `Ss12000SyncChanges` NOWAIT in a loop with a
  30 s cap; if they are not free at once it stops with nothing changed, and
  `npx prisma migrate resolve --rolled-back
  20270107090000_skolan_minns_att_en_person_har_skyddad_identitet` lets it run
  again. **Right after rollout, run a full sync for every school with an
  SS12000 source** (Integrationer › SS12000 › Full synk) and apply its marks
  (they are preselected). An incremental run reads only the people changed
  since the last run, so a person the register already protected is marked
  only when a full run reads them, and the night runs one every seventh day
  (or as the school set it); until then the files still name that person. A
  mark matched on the e-mail address alone (the names differ even loosely
  compared, or several rows share it) is proposed unselected and never made
  at night, and it holds the night's run open for an administrator
  (`autoApplyBlockedReason` `PROTECTION_REVIEW`, which the sync history
  states without a name): look for `PROTECTION_ADDRESS_*` in the review. **A rollback of the API past this
  release once a sync has run**: an
  older API cannot read a run that holds a `PROTECTION` change (the enum value
  is unknown to its client), so the SS12000 history and review answer 500.
  The value cannot be dropped. Before rolling back, as the owner, delete those
  changes (`DELETE FROM "Ss12000SyncChanges" WHERE entity::text =
  'PROTECTION'`; a DIFF_READY run then lacks its marks and should be run
  again after the release returns). The marks and their history may stay: an
  older API never reads them, and the exports simply stop leaving the marked
  out.
- **Rapporteringsgrad**: 20270112090000 adds the `NotificationType` values
  `LESSON_REPORT_REMINDER` and `REPORTING_RATE_DIGEST` and nothing else (a value
  cannot be used in the transaction that adds it, so it is a file of its own).
  20270112090100 adds the tables `ReportingSettings`, `TeacherReportingDays`,
  `ReportingReminders` and `ReportingDigests`, eight `app.reporting_*` functions
  (seven SECURITY DEFINER with a pinned `search_path`, and `app.reporting_lessons`,
  the one definition of a reported lesson, which runs as its caller and is the
  owner's alone), a trigger on the switches, and `app.gallring_due` and
  `app.gallring_purge` again with the days and the reminders under the ATTENDANCE
  kind. No existing row is touched and no existing table gains a column. The new
  keys take `Schools` and `Users` in SHARE ROW EXCLUSIVE, NOWAIT, together in a
  loop: reads and foreign-key checks go on, writes to the two wait for the file,
  and if both are not free at once in 30 s it stops with nothing changed
  (`prisma migrate resolve --rolled-back
  20270112090100_rapporteringsgrad_per_larare_och_paminnelser_for_oppna_lektioner`,
  then deploy again). `CalendarLessons` is not locked: a reminder names its lesson
  by id, with no key. The API before the release knows none of the objects and
  writes no notice of the new types, so it keeps working between the migration and
  the deploy. The migration goes in first, then the merge.
  **What is on after the deploy, and what is not.** The reminders to teachers and
  the weekly notice to rektor are **off for every school** until an administrator
  turns them on (no row in `ReportingSettings`), so nobody is told anything.
  The nightly *count*, however, is not a switch: from the first night after the
  deploy the job stores each teacher's held and reported lessons per day for the
  last 90 days, for every school with a lesson in the last 90 days
  (`app.reporting_schools()`). Rektor and the other administrators read it on
  `/admin/reporting-rate`, a teacher reads their own on `/teacher/reporting-rate`,
  and a pupil and a guardian read nothing. That is new information for a school's
  staff: say so in the release note, and tell the schools that it is theirs to
  use as a basis for a conversation.
  **Decision, 2026-11-06 (the owner's, on the review's M2):** this stays as it is.
  The count is on for every school from the first night, with no switch per school,
  and *every* administrator profile (full administrator, rektor, expedition,
  schemaläggare and läsare) reads every teacher's share on `/admin/reporting-rate`;
  each such read is written to the school's läslogg (EMPLOYMENT and PEOPLE for the
  teachers listed). The first night counts the last 90 days back, so the page has
  its history from the first morning. A teacher reads their own days and open
  lessons only. The user and teacher manuals (6.14 and 4.7) say the same.
  **Release note** (in these words or others): *From the first night after this
  release Rastra counts, every night, what share of each teacher's held lessons
  have a saved register, for the last 90 days. Rektor and all of the school's
  administrators see the share per teacher; each teacher sees their own; pupils
  and guardians see nothing. Nobody is reminded or told anything until the school
  turns the reminders or the weekly notice on under Drift › Rapporteringsgrad. The
  figure is a basis for a conversation, not a verdict.* The emergency brake is
  `REPORTING_RATE_BACKGROUND=off` (the environment table above): nothing is
  counted, reminded or sent, the days already stored stay, and the pages show them
  as of the last night.
  **Before the migration**, as the owner: no `app.reporting_%` function and no
  `ReportingSettings`, `TeacherReportingDays`, `ReportingReminders` or
  `ReportingDigests` table exist (`SELECT count(*) FROM pg_proc WHERE proname LIKE
  'reporting\_%'` and `SELECT count(*) FROM pg_tables WHERE tablename IN
  ('ReportingSettings', 'TeacherReportingDays', 'ReportingReminders',
  'ReportingDigests')` are both 0), `prisma migrate status` lists exactly the two
  new migrations as pending, no session sits idle in a transaction that holds
  `Users` or `Schools` (`SELECT pid, state, now() - xact_start FROM
  pg_stat_activity WHERE state = 'idle in transaction'`), and the gallring
  functions carry `main`'s branches, with the md5 read for the record
  (`SELECT proname, md5(prosrc) FROM pg_proc WHERE pronamespace = 'app'::regnamespace
  AND proname IN ('gallring_due', 'gallring_purge')`; after Skyddad identitet these
  are `7efba422…` and `de359f73…`). The migration restates both functions from
  20270107090000 and adds two branches; a release that restated them earlier
  would be overwritten.
  **After it, before the merge:** the four tables have row security on, and
  `app_authenticated` holds SELECT and INSERT/UPDATE on the settings, SELECT alone
  on the days and the week's ledger and nothing on the reminders' ledger
  (`SELECT relname, relrowsecurity FROM pg_class WHERE relname IN (...)`;
  `SELECT has_table_privilege('app_authenticated', 'public."ReportingReminders"',
  'SELECT, INSERT, UPDATE, DELETE')` and `has_table_privilege('app_authenticated',
  'public."TeacherReportingDays"', 'INSERT, UPDATE, DELETE')` are false); none of
  the eight functions is executable by `anon`, `authenticated` or PUBLIC, and
  `app_authenticated` runs six of them, not `app.reporting_lessons` and not the
  trigger's (`SELECT p.oid::regprocedure FROM pg_proc p WHERE p.proname LIKE
  'reporting\_%' AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR
  has_function_privilege('authenticated', p.oid, 'EXECUTE'))` returns no row);
  `SELECT count(*) FROM "ReportingSettings"` is 0; no role of the four holds
  MAINTAIN on the tables; there are 8 functions (`SELECT count(*) FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app' AND
  p.proname LIKE 'reporting\_%'`); and both gallring functions carry the branches
  (`SELECT proname, position('TeacherReportingDays' IN prosrc) > 0,
  position('ReportingReminders' IN prosrc) > 0, position('AbsenceWatchFindings' IN
  prosrc) > 0, position('CoverRequests' IN prosrc) > 0, position('PersonProtectionEvents'
  IN prosrc) > 0 FROM pg_proc WHERE pronamespace = 'app'::regnamespace AND proname IN
  ('gallring_due', 'gallring_purge')` is true on every column of both rows). A later
  migration that replaces `app.gallring_due` or `app.gallring_purge` has to carry
  these branches along (the owner checks, section 349o, fail when it does not).
  **After the merge:** `JobRuns` gets a row for `reporting-rate` within five minutes
  of the new instance serving (`SELECT job, runs, failures, counts FROM "JobRuns"
  WHERE job = 'reporting-rate' ORDER BY day DESC LIMIT 3`), and `GET /health/ready`
  counts the job under `jobs.scheduled`. Every school is counted the next night after
  06:00 local time: `written` is the number of teacher-days stored (a school of 50
  teachers writes some 3 000 the first night and nothing on the nights after, until a
  register is saved late), `held` and `reported` the lessons of the last 90 days. Count
  time on a school of 25 classes and 50 teachers with a year of lessons (33 000
  lessons, 200 000 marks, `scripts/bench/reporting-rate.sql`, Postgres 17.11) is 0.2-0.3 s
  the first night and 0.1 s every night after on a quiet host (0.7 s and 0.3 s on a loaded
  one), the reminders 0.09 s the first night and 0.03-0.05 s after, the week's notice
  3-6 ms, and the rektor's view of a läsår (one grouped sum over 3 200 rows) 3 ms; the job
  lifts the delivery door's 5 s statement limit to 9 s for the count. A teacher's list of
  open lessons (every page view of *Min rapportering*) takes 10 ms for 30 days and 34 ms
  for 90 on the same school, where the first version took 26 and 94 ms: it asks for the
  school, the person and the day once and hands them to the definition as values, because
  those helpers are SECURITY DEFINER lookups and were called for every lesson of the
  school's month when left in a filter.
  The first version of the count deleted vanished days with a NOT EXISTS against the
  counted days and was planned as a nested loop (1.1–1.3 s on the nights after the
  first, quadratic in the school's days); a FULL JOIN of stored and counted days cannot
  be one, and the figures are identical. A school that fails is counted in `failed` and
  retried two hours later the same day.
  **The reminders and the weekly notice:** a school turns them on under *Drift ›
  Rapporteringsgrad*, with a limit of 1–30 calendar days (two to begin with). The first
  reminder comes on the first weekday after 06:00 for a lesson dated on or after the day
  the switch went on, and at most 30 days back; a lesson is reminded of once per
  teacher; nothing is sent on a Saturday or a Sunday. The week's notice comes on the
  first Monday after a whole week has ended on or after the day it was turned on. Both
  carry counts only (no name, subject, class, time, minutes or reason), in the inbox, the
  e-mail and the push.
  **Gallring:** the days and the reminders follow the school's decision for *Närvaro*
  (`RetentionDataType` ATTENDANCE): by the day each stands for, in the same batches. A
  school that has decided nothing loses none. A school that has ever chosen to purge
  attendance is counted only from the cutoff of the *shortest* period it has chosen, also
  after it switches to keeping (the marks of the days before may be gone, and counted
  again they would read as days nobody reported). The reminders' ledger is cleared by
  the reminding itself after 60 days.
  **The roster:** a lesson that no pupil can be marked on can never have a register
  saved, so it is neither held, open nor reported (the class's pupils, the groups joined
  to it and their members, and the pupils the lesson names: the register's own three
  sources, read in SQL), unless a register was already saved on it, which stays a register
  whatever the roster has become. The night counts the last 90 days again, so the roster
  must not move a day that was counted: a class is read both as it is (its active pupils)
  and as it was on the lesson's day (`StudentEnrollments`, the class history, the segment
  `[validFrom, validTo)` that holds the date), and a lesson is unreportable only when
  nobody sat in the class then and nobody can be marked now. The läsårsaktivering moves
  every pupil to next year's class and empties last year's, but the history keeps them in
  it to the year's end, so last year's share stands still (the adapter probe (rj)
  activates a year through the service and counts the same 90 days again; the
  owner checks plant the same in section 346o). Members of a teaching group and named
  pupils have no dates and count as recorded, active or not (what the register accepts
  for saving, `RECORDED` in `lesson-roster.ts`).
  **Known limits:** the roster does not subtract the pupils a replacing group (ersättande
  grupper) takes off a lesson, so a lesson where every pupil is taken off still counts as
  held; a year activated before the old year ends closes the class history that day, so
  the unregistered lessons of the weeks that are left drop out of the days; a teacher who
  is deactivated loses the stored days of the last 90 days at the next night while older
  days stay; a register saved more than 90 days after its lesson does not move the stored day; the e-mail and the push go to the delivery's in-memory queue after the
  commit, as every other notice does, so a process that stops between the commit and the
  send loses them for that night, and the ledger keeps the reminder from being written
  again.
  **Clients from before the release:** the web and the app before it draw the two
  notices with their fallback text ("Ny notis" / "Notis") and list them in Settings under
  their catalogue keys, switchable.
  **Rolling it back:** the migration stays, and the API before the release never reads
  the new tables. Prisma's client throws on a read that selects a notice's type from a row
  holding a value it does not know, and the one such read is the person's opt-outs: a
  person who switched a new notice off while the release was live would make
  `GET /notification-preferences` a 500 on the API before it. Before rolling back, as the
  owner, count them; nonzero means delete those rows (the person is asked again when the
  release returns): `SELECT count(*) FROM "NotificationOptOuts" WHERE "type"::text IN
  ('LESSON_REPORT_REMINDER', 'REPORTING_RATE_DIGEST');`. What a rollback changes: nobody is
  counted or told, the days already stored stay in the table unread, and a school that has
  the switches on keeps them for the day the release is back. The notices already written
  stay in people's inboxes.

- **Skyddad identitet, the register's kind**: 20270111090000 adds
  `PersonProtections.kind` (`SEKRETESSMARKERING` or `SKYDDAD_FOLKBOKFORING`,
  on the sync's row alone: CHECK `PersonProtections_a_kind_is_the_registers`),
  two UPDATE arms (`person_protections_sync_update`,
  `person_protections_admin_update`, both for source SS12000) with UPDATE on
  the column `kind` alone for `app_authenticated`, the provider's read
  `app.ss12000_security_markings()` (EXECUTE for `app_authenticated` only;
  a linked person's marks alone),
  the trigger `PersonProtections_ss12000_versions` that moves a Person's
  version when the kind it is sent with moves, and op UPDATE in
  `Ss12000SyncChanges_a_mark_names_its_person_in_after_alone` (NOT VALID). The
  gallring functions are not touched: `md5(prosrc)` stays
  `7efba42244c71937b4cb82ffc23a6ba1`, `de359f739e3908c9a36e41ff541cdf13`,
  `6f18f62fc354bde849aa2e8b01eeceda`. It takes `PersonProtections` and
  `Ss12000SyncChanges` NOWAIT in a loop with a 30 s cap; if they are not free
  at once it stops with nothing changed, and `npx prisma migrate resolve
  --rolled-back 20270111090000_skolan_skickar_registrets_sort_av_skydd_vidare`
  lets it run again. After: eight policies on the two tables, all
  `{app_authenticated}`; `kind` NULL on every row. **Right after rollout, run
  a full sync per SS12000 school** and apply it: each existing mark of the
  sync gets the register's kind (PROTECTION UPDATE, preselected; the night
  makes them too, at its next full run), and until then the provider sends no
  `securityMarking` for that person. **A rollback of the API**: an older API
  never reads the column or the function, writes its marks with no kind, and
  sends no `securityMarking`; a `DIFF_READY` run holding a PROTECTION UPDATE is
  applied without it. The column, the arms and the function may stay.
- **Krisläge**: 20270113090000 adds the `NotificationType` values
  `CRISIS_ALARM`, `CRISIS_ENDED` and `CRISIS_GUARDIAN_AFTER` and the
  `RetentionDataType` values `CRISIS_DRILLS` and `CRISIS_ALARMS` and nothing
  else (a value cannot be used in the transaction that adds it, so it is a
  file of its own: never run the two files in one `psql -1`). 20270113091000
  adds the tables `CrisisSettings`, `CrisisAlarms`, `CrisisCalls`,
  `CrisisCallTeachers`, `CrisisPupils` and `CrisisReports` with 24 policies,
  the triggers that start an alarm in its writer's name (and refuse an
  exercise beside a real alarm, KL412), let it end once and stamp and apply a
  mark, the functions `app.crisis_may_start`,
  `app.crisis_window_open`, `app.crisis_call_window_open`,
  `app.crisis_lists_are_open`, `app.crisis_answers_for`,
  `app.crisis_pupil_call`, `app.crisis_has_no_call_in` and
  `app.crisis_settle` (executable by `app_authenticated` alone), and
  `app.gallring_due` and `app.gallring_purge` again with the alarms' branch.
  No existing row is touched and no existing table gains a column. The new
  keys take `Schools`, `Users` and `CalendarLessons` in SHARE ROW EXCLUSIVE,
  NOWAIT, together in a loop: reads and foreign-key checks go on, writes to
  the three wait for the file (about 50 ms once the locks are taken), and if
  all three are not free at once in 30 s it stops with nothing changed in the
  second file (`prisma migrate resolve --rolled-back
  20270113091000_ett_larm_raknar_eleverna_utifran_schemat`, then deploy
  again). NOWAIT never queues, so it does not make an autovacuum give way:
  look first (below). The API before the release knows none of the objects
  and writes no notice of the new types, so it keeps working between the
  migration and the deploy. **The migration goes in first, then the merge**,
  outside an SS12000 sync window.
  **Before the migration**, as the owner: `SHOW server_version` is the 17.x
  production runs; `prisma migrate status` lists exactly the two new
  migrations as pending (their stamps, 20270113090000 and 20270113091000, sort
  after Skyddad identitet's 20270107090000, its register kind's 20270111090000
  and Rapporteringsgrad's 20270112090000 and 20270112090100, which are applied,
  so production and a fresh database run them in one order); the files'
  checksums (sha256, what Prisma records) are
  `19c464b8ed67850e1135939c2bcc142d9a316320332c679866fd201f11bab9d6` for
  20270113090000 and
  `4cc51e83d74111d7526c0769d0ff0341e899db6eef99fbdfa6513f2d6d8ae2f4` for
  20270113091000; `SELECT to_regclass('"CrisisAlarms"')` is NULL and
  `SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE
  t.typname IN ('NotificationType', 'RetentionDataType') AND e.enumlabel LIKE
  'CRISIS%'` returns no row; and no session sits idle in a transaction that
  holds one of the three tables, nor an autovacuum worker on them (the query
  of the Vikariefrågan entry above). **Gallring:** `SELECT proname,
  md5(prosrc) FROM pg_proc WHERE pronamespace = 'app'::regnamespace AND
  proname IN ('gallring_due', 'gallring_purge') ORDER BY 1` must show
  Rapporteringsgrad's bodies (20270112090100): `gallring_due`
  `2b009a76211cdb7f51b2e4c7c96b0acf`, `gallring_purge`
  `827d5ff597528338710ebaa0a9253d96`. The second file replaces both functions
  whole, built on exactly those bodies with one branch added to each (the
  diff against Rapporteringsgrad's bodies is additions only: 7 lines in
  `gallring_due`, 6 in `gallring_purge`, all marked `-- krisläge`), so they
  carry every branch: the absence watch's findings, the reporting rate's days
  and reminders, the cover requests, the marks' history and now the alarms.
  `app.gallring_pseudonymise` is not touched: its `md5(prosrc)` is
  `6f18f62fc354bde849aa2e8b01eeceda` before and after. After the migration the
  values are `gallring_due` `1d002a81c954ccda01acc9bf0cabdbb3` and
  `gallring_purge` `21b7b43da05c4ff63f045ee769b1ba5c`. Other values before it
  mean a release has restated them since: its branch must be carried into
  20270113091000's bodies, or its rows are no longer purged (the RLS suite,
  section 350, fails when a body has lost a branch or a table, or a branch is
  dead or only a comment).
  **After it, before the merge:** both migrations are applied;
  `SELECT count(*) FROM pg_policies WHERE tablename LIKE 'Crisis%'` is 24;
  `app_authenticated` holds SELECT, INSERT and UPDATE on `CrisisSettings` and
  `CrisisAlarms`, SELECT and INSERT on the other four and nothing else (no
  MAINTAIN, no DELETE), `anon` and `authenticated` nothing at all; the eight
  functions answer `app_authenticated` alone (`SELECT
  has_function_privilege('anon', 'app.crisis_may_start()', 'EXECUTE'),
  has_function_privilege('authenticated', 'app.crisis_settle()', 'EXECUTE'),
  has_function_privilege('service_role', 'app.crisis_lists_are_open(uuid)',
  'EXECUTE')` is false, false, false). Do not call `app.crisis_settle()` to
  see: it ends the alarms that are due.
  **After the merge:** `GET /api/v1/crisis/alarms` answers `[]` for every
  school; `JobRuns` gets a row for `crisis` within fifteen minutes of the new
  instance serving, its counts `{"ended": 0}`; `/admin/dataskydd` lists
  *Krisläge: övningar* and *Krisläge: skarpa larm* as *Ej beslutat*. Then,
  in a test school with two accounts: start an **exercise** (never a real
  alarm in production to try it), see the teacher's group on the second
  account, mark it, see the live view move, end it and open the protocol. Look
  in the log for `Alarm notices ... not sent`.
  **Who may start an alarm** is the school's choice (`/admin/crisis`,
  settings, for those who decide): by default every administrator profile that
  writes Drift (full, rektor, schemaläggare, expedition); rektor and full may
  always; a läsare, a teacher, a pupil and a guardian never. The database
  holds the same rule (`app.crisis_may_start`), so a route that forgot it
  would still be refused. **Whether the guardians are told** after a real
  alarm is the school's choice and off by default: they get only that an
  alarm happened and ended, never a word about a pupil.
  **What an alarm is built from:** the school's day as the calendar holds it
  at the moment it starts, one rule for everybody (src/crisis/crisis-calls.ts):
  a lesson that is held (not cancelled, not moved) and going on answers for
  the pupils on it (the roster reader the register and the notices use);
  between two lessons of a pupil's day, not more than two hours apart, the
  group goes with the lesson it is going to; a teacher who is away right now
  is left out, so a lesson whose teacher is away and which nobody covers has a
  call with nobody to answer for it, and the administration marks it. A
  vikarie the board or a cover request placed has taken the absent teacher's
  row already, and the replacement lesson of a schemabrytande aktivitet is a
  lesson like any other. **Nobody is left out:** every active pupil of the
  school is on the roll call. A pupil no lesson's list has (before the first
  lesson, after the last, a gap longer than a break, a cancelled lesson, the
  after-school club) stands on one more group of the alarm, *Ej i lektion just
  nu* (`CrisisCalls.basis = 'NO_LESSON'`, one to an alarm, no teacher, no
  span), which the administration answers for and marks like any group whose
  teacher is away. The live view, the end and the protocol count against every
  active pupil, so "everyone is marked" is said only when it is true. A pupil
  absent before (the register, a report, a leave) is on it too, as absent
  before. **A teacher who finds a pupil who is not on their list** says so
  ("hittad hos mig"): the mark is stored on the pupil's own group, with the
  teacher's group in `CrisisReports.foundInCallId`, so the pupil's own
  teacher and the administration see that they are found and by whom, and the
  teacher keeps the pupil in a list of their own. Only *found* can be said
  that way (a pupil of someone else's list cannot be said to be missing by a
  teacher who does not have them). The teacher finds the pupil by a search
  (`POST /api/v1/crisis/mine/pupils, body {alarmId, q}`: name or class, two characters
  at least, 25 results at most, never the teacher's own list, recorded in the
  läslogg as a read of people); the school's pupils are not sent to every phone
  and not kept on any, so the search needs a network (a teacher who has no
  network says it to the administration). **A teacher with no group right now**
  (a gap, a duty) can say it too, with the alarm alone to name (`alarmId` in
  place of `callId`): a found mark on the pupil's own group with no group to
  find them with, which the database allows a teacher who answers for no call of
  the alarm (`app.crisis_has_no_call_in`) and no one else. **Taking it back:**
  the teacher who said a pupil was found can take it back while it is still the
  pupil's latest mark (a `RETRACTED` mark, `KL413` otherwise): the pupil is
  unmarked again, and an older mark that arrives late does not bring it back.
  **"Inte i huset"** (`AWAY`) is a third mark, the administration's alone, for a
  pupil nobody has seen (a group of pupils with no lesson on a Saturday or at
  night is most of the school): it is counted for itself in the live view, the
  end dialog and the protocol and is never added to the found, and the group of
  pupils with no lesson has no "alla finns" (a button that wrote *found* for
  pupils nobody saw), only a bulk "ingen av de oprickade är i huset" behind a
  confirmation that states the number. **Known limits:** a pupil on two lessons at once is on the one that sorts first;
  teachers with no group right now answer for nothing and are only told that an
  alarm is going (they cannot mark; a teacher with no group has no call to
  find a pupil with); the 120 minutes that separate a break from a gap are
  fixed; a pupil who becomes active after the alarm began is not on it (the
  lists are the moment's). **Starting is one at a time in a school:** `start()`
  takes a transaction-scoped advisory lock for the school first (and locks the
  exercise's row `FOR UPDATE` before a real alarm ends it), so an exercise and a
  real alarm that start in the same moment leave one open, and a real alarm that
  meets the end of an exercise waits for it and goes on instead of failing.
  **Notices** say that an alarm (or an exercise) is going and nothing else:
  the push has no kind of alarm, no group, no place and no pupil, and the
  inbox row has the alarm's id, kind, mode and time (a guardian's row, after a
  real alarm, says only that it happened and ended, no kind). The alarm and its
  end are delivered whatever a person chose and have no switch; a guardian's
  notice can be switched off in their settings. There is no e-mail. **The push
  has the alarm's priority:** high priority (FCM high, APNs 10), its own
  Android channel `crisis` (importance max, sound, vibration, asks to pass
  Do-not-disturb), iOS `time-sensitive` (not `critical`, which needs Apple's
  entitlement), and a time to live of 10 minutes instead of 24 hours, so a
  phone that was off does not get "Ett larm pågår" for an alarm that ended
  hours ago. The app also asks the gateway whether the alarm is still going
  before it shows a list from a push. Neither can wake a phone the person has
  turned silent in the operating system; the live view's *lärare som inte
  svarat* is what covers that. **iOS `time-sensitive`** needs the capability
  *Time Sensitive Notifications* on the app's identifier: the teacher app's
  `app.config.ts` asks for the entitlement
  `com.apple.developer.usernotifications.time-sensitive`, which needs no new
  agreement with Apple (unlike *critical* alerts, which the app does not use).
  The first build after the change registers the capability on the App ID
  through EAS and regenerates the provisioning profile; if a build stops on a
  profile that lacks the entitlement, switch the capability on under
  Certificates, Identifiers & Profiles › Identifiers › the app › Capabilities
  and let EAS regenerate the profile (ad hoc profiles too, §15.9). Until a build
  carries it iOS treats the push as an ordinary one.
  **Offline:** the phone keeps the list it last read in its encrypted store
  and its marks in a queue of their own, sends them when the network is back
  (a mark carries its own id, so sending twice stores it once), and for an hour
  after the end the database still takes them (they say `late`); after that the
  phone is told the mark belongs to no alarm and drops it. Two phones of one
  group that send at once take the pupils in one order (call, then pupil), so
  they wait for each other; if the database still aborts one (a deadlock), the
  answer is `409 WRITE_CONFLICT`, which the phone and the web keep and send
  again. The web keeps its queue and the last list per signed-in person in the
  browser and clears them at sign-out.
  **Retention:** exercises (`CRISIS_DRILLS`) and real alarms
  (`CRISIS_ALARMS`) are two kinds on `/admin/dataskydd`, undecided in every
  school, and nothing is purged until the school records a period for each. An
  alarm goes once it has ended and its end is before the cutoff, with every
  call, teacher, pupil and mark on it; one that is still open never does.
  **Rolling it back:** the migrations stay, and the API before the release
  never reads the new tables. Prisma's client throws on a read that selects an
  enum column from a row holding a value it does not know: a notice of the new
  types makes the person's inbox read fail, an opt-out of one makes
  `GET /notification-preferences` a 500, and a school's decision about the new
  kinds breaks the dataskydd page. Before rolling back past the release, as
  the owner, count and delete those rows (the school is asked to decide again
  when the release returns; the alarms themselves stay in the tables). A
  retention decision is append-only, so its guard is switched off for the one
  statement and on again in the same transaction: `BEGIN; DELETE FROM
  "Notifications" WHERE "type"::text IN ('CRISIS_ALARM', 'CRISIS_ENDED',
  'CRISIS_GUARDIAN_AFTER'); DELETE FROM "NotificationOptOuts" WHERE
  "type"::text IN ('CRISIS_ALARM', 'CRISIS_ENDED', 'CRISIS_GUARDIAN_AFTER');
  ALTER TABLE "RetentionDecisions" DISABLE TRIGGER
  "RetentionDecisions_append_only"; DELETE FROM "RetentionDecisions" WHERE
  "dataType"::text IN ('CRISIS_DRILLS', 'CRISIS_ALARMS'); ALTER TABLE
  "RetentionDecisions" ENABLE TRIGGER "RetentionDecisions_append_only";
  COMMIT;`. Count them first (`SELECT count(*) FROM "Notifications" WHERE
  "type"::text LIKE 'CRISIS\_%'`); do not roll back while an alarm is going.
  What a rollback changes: nobody can start or answer an alarm, the phones
  show no list, and the alarms already made stay in the tables unread.
- **Skolans dag i ett svep**: 20270116090000 adds the enum
  `SchoolDayTeacherView` (`NONE`, `ROOMS`, `ALL`), the table
  `SchoolDaySettings` (one row per school; no row is `NONE`) with three policies
  (`school_day_settings_staff_select` for every administrator and every teacher
  of the school, `_admin_insert` and `_admin_update` for those who decide), and
  `app.school_day_protected_staff()`, a SECURITY DEFINER function that answers a
  teacher or an administrator of the school the ids of its staff that carry a
  mark of protected identity (never a pupil or a guardian), executable by
  `app_authenticated` alone. No existing row is touched, no existing table gains
  a column, `gallring_due`, `gallring_purge` and `gallring_pseudonymise` are not
  restated (their `md5(prosrc)` are the same before and after), and nothing
  reaches the engine. The one new key takes `Schools` in SHARE ROW EXCLUSIVE,
  NOWAIT, in a loop with a 30 s ceiling: reads and foreign-key checks go on,
  writes to `Schools` wait for the file (milliseconds), and if the lock is not
  free in 30 s it stops with nothing changed (`prisma migrate resolve
  --rolled-back 20270116090000_skolans_dag_har_ett_beslut_om_vad_lararna_ser`,
  then deploy again). The API before the release knows none of the objects, so
  it keeps working between the migration and the deploy. **The migration goes
  in first, then the merge.**
  **Before the migration**, as the owner: `SHOW server_version` is 17.x;
  `prisma migrate status` lists exactly this migration as pending; the file's
  checksum (sha256, what Prisma records) is
  `5b979fc826b3a5dc54bb72e0e7e93cd5e78f9c43e58e8792e1303f583f5a11dc`;
  `SELECT to_regclass('"SchoolDaySettings"')` is NULL; and no session sits idle
  in a transaction that holds `Schools` (the query of the Vikariefrågan entry
  above). **Gallring:** `SELECT proname, md5(prosrc) FROM pg_proc WHERE
  pronamespace = 'app'::regnamespace AND proname IN ('gallring_due',
  'gallring_purge', 'gallring_pseudonymise') ORDER BY 1` is
  `1d002a81c954ccda01acc9bf0cabdbb3`, `6f18f62fc354bde849aa2e8b01eeceda`,
  `21b7b43da05c4ff63f045ee769b1ba5c` (due, pseudonymise, purge) before and
  after: this release adds a table with no personal data and no retention type.
  **After it, before the merge:** `SELECT count(*) FROM pg_policies WHERE
  tablename = 'SchoolDaySettings'` is 3; `app_authenticated` holds SELECT,
  INSERT and UPDATE on it and nothing else (no DELETE, no MAINTAIN), `anon` and
  `authenticated` nothing; `has_function_privilege('anon',
  'app.school_day_protected_staff()', 'EXECUTE')`, the same for `authenticated`
  and for `service_role`, are false; `SELECT count(*) FROM "SchoolDaySettings"`
  is 0.
  **After the merge:** as an administrator, `/admin/school-day` shows the
  school's day and `GET /api/v1/school-day/settings` answers `NONE`; as a
  teacher, `/teacher/school-day` says that the school has not opened the page
  and `GET /api/v1/school-day?from=<today>` answers 403 `SCHOOL_DAY_NOT_OPEN`;
  as a pupil or a guardian the routes answer 403. **What a teacher has is the
  school's decision** (`/admin/school-day`, for those who decide): nothing
  until it is made. `ROOMS` gives the free rooms and the rooms' own day and
  week; `ALL` adds the classes' and the teachers' lessons. **Never who is
  free for a teacher:** absence, uppdrag and rastvakt are not a teacher's to
  read (row security), so a list of free colleagues made from what they can
  read would call an absent one free. The free teachers are the
  administrators'. **A teacher is told the lessons as they stand**, cancelled
  ones and who holds them included, **but not why or in whose place:**
  `cancelCause` and a teacher's role are administrators' only (a
  `TEACHER_UNAVAILABLE` cause or a `SUBSTITUTE` row would say a colleague is
  away). **A person the school marks as having a protected identity**
  is named for administrators only: a teacher's answer leaves a marked teacher
  out, without an id and without a count (a count on the lessons that are
  hers would point at her; the omission is presentation, since PostgREST still
  lets a teacher read the rows); the print is an administrator's and does
  not name a marked teacher either (it counts them). **Free is the
  Vikarietavla's occupied rules** (absent, in a lesson that holds its time, on
  a rastvaktspass, inside an uppdrag or a closure, holding a room booking, and
  for a pool member without a post, inside a window they declared); a room is
  free when no lesson that holds its time uses it, no booking in PENDING or
  APPROVED holds it, no closure covers it, and the loans between this school
  and another leave it to this school then (the booking page's own rule: lent
  out in an approved window, or the school's room for a borrowed one outside
  what the loans give). Lunch, rest, the daily cap, the
  stretch of teaching and the days (the Vikarietavla's other rules, which
  answer "may we ask them to cover") are not part of "free". **Known limit,
  as in the Vikarietavla:** a shared teacher's lessons at the huvudman's other
  school are not read. **Measure:** a school of 60 classes, 120 teachers and 80
  rooms reads a week in about 0.2 s in the API (`scripts/bench/school-day.ts`);
  the answer is about 0.8 MB (about 1.9 MB for 150 classes, 300 teachers and
  200 rooms), built in the API process and not compressed by the gateway.
  **The two reads are limited to 30 a minute per login and per route**
  (`grid`, `free`; `SchoolDayThrottlerGuard`, which keys on the verified
  login), with a ceiling of 1 200 a minute per address in the global guard's
  bucket for each route (`x-rate-limit` in the OpenAPI document is that
  ceiling). Not 30 per address: the web asks the API from each person's
  browser, so a school's staff arrive from one NAT address, and sixty teachers
  opening the page together would have had thirty errors, and a block of a
  minute for everyone on the address. The refusal is 429 with `Retry-After`
  and the code `SCHOOL_DAY_RATE_LIMITED`; the page says it calmly and keeps
  the figures it had when a poll is refused. A teacher's page asks again every
  five minutes (an administrator's every minute). When the first school sets
  `ALL`, count 429 per route; a 429 without the code is the address ceiling
  and means one address is flooding. Compression at the proxy is a decision
  of its own.
  **Rolling back the API** leaves a table and a function nobody reads; the
  page then answers 404. Nothing needs undoing. To remove them (only if the
  feature is abandoned): `DROP FUNCTION app.school_day_protected_staff();
  DROP TABLE "SchoolDaySettings"; DROP TYPE "SchoolDayTeacherView";` and
  `prisma migrate resolve --rolled-back
  20270116090000_skolans_dag_har_ett_beslut_om_vad_lararna_ser`.
- **Kvittens**: 20270117090000 adds the `NotificationType` values
  `ACK_REQUESTED` and `ACK_REMINDER` and nothing else (a value cannot be used
  in the transaction that adds it, so it is a file of its own, taking no lock).
  20270117091000 adds the tables `AckSettings`, `AckRequests` and
  `AckReceipts`, the enums `AckRule` and `AckReminderOutcome`, nineteen
  `app.ack_*` functions (all SECURITY DEFINER with a pinned `search_path`;
  fourteen the API role may run, five the owner's alone), three triggers (the
  two stamps and the school's daily limit), and `app.gallring_due` and
  `app.gallring_purge` again with the requests under the NOTIFICATIONS kind.
  No existing row is touched and no existing table gains a column. The new
  keys take `Schools` and `Users` in SHARE ROW EXCLUSIVE, NOWAIT, together in a
  loop: reads and foreign-key checks go on, writes to the two wait for the
  file, and if both are not free at once in 30 s it stops with nothing changed
  (`prisma migrate resolve --rolled-back
  20270117091000_en_vardnadshavare_bekraftar_ett_meddelande_om_sitt_barn`,
  then deploy again). The API before the release knows none of the objects and
  writes no notice of the new types, so it keeps working between the migration
  and the deploy. The migrations go in first, then the merge. The gallring
  functions are built on `main`'s: the md5 of the bodies is
  `1d002a81c954ccda01acc9bf0cabdbb3` (due) and `21b7b43da05c4ff63f045ee769b1ba5c`
  (purge) before, and `f884a3c77b5234c3d77ae6b77d17f0e7` and
  `21746d3990375d467cdeec6294308363` after (read on Postgres 17.11); the
  difference is the one branch marked `kvittens` in each. `gallring_pseudonymise`
  (`6f18f62fc354bde849aa2e8b01eeceda`) is not touched.
  **Kvittens is off for every school** until its administrator turns it on
  under Drift (no row in `AckSettings`), so deploying changes nothing a school
  sees. A request is a message a member of staff writes about one or more
  pupils; the guardians of those pupils are asked to confirm that they have seen
  it, one tap in the app or on the web. The sender sees who confirmed and when,
  and nothing else about the guardian: not whether they opened it. The school
  chooses after how many days (1–30, or never) a guardian who has not confirmed
  is reminded, once. **Every guardian who has not confirmed themself is
  reminded, also when the other guardian of the pupil has** (the rule ANY):
  skipping them would let the missing reminder tell a guardian that the other
  parent has answered, which a guardian who is hidden from the other must never
  learn, and the decision is that this weighs more than one reminder too many.
  The staff see how each reminder ended, not only that the pass looked at it:
  `AckRequests.reminderOutcome` is `SENT` (with `reminderSentAt`, and only
  then), `NOT_NEEDED` (nobody was left to remind), `LAPSED` (its time was more
  than 30 days before the pass came: closed without a word), `STOPPED` or `OFF`.
  The author, or an administrator under Drift, can stop the reminder of a
  request that went out wrong (`app.ack_stop_reminder`), and turning kvittens
  off stops the reminders that fall due while it is off for good (`OFF`; they
  are not sent when it is turned on again). Withdrawing a whole request is not
  built: a follow-up. **What is decided, for a conversation with the school:** a
  confirmation is the only receipt there is. An ordinary notice (a leave
  decision, an unreported absence, an alarm's afterword) keeps its `readAt`
  to the recipient: no route, view or screen of the gateway, the web or the app
  gives it to anyone else. (The database is wider than the screens: the arm
  `notifications_admin_select` of 20260713190000 lets an administrator's own
  login read every notice of the school through PostgREST, `readAt` included,
  and nothing in the web or the app asks for it. Closing it is a follow-up, see
  the pull request.)
  a member of staff's own notices have no receipt at all, so the feature cannot
  become a measure of who reads what. A request names the child in no push and
  in no e-mail (the e-mail says that a message waits; the title is behind the
  login). Staff who open a request are recorded in the läslogg (PEOPLE and
  GUARDIANS), and a guardian is never shown another guardian's confirmation.
  A request and its confirmations go with the school's choice for **Notiser**
  under Dataskydd; there is no kind of their own.
  **What one person can send, and what the queue carries.** A request to a
  whole school is some 4 000 notices and 82 mails (49 on BCC, one every 500 ms:
  about 41 s of the delivery queue) and a push to each. A person therefore
  writes at most **10 requests an hour**, a sender has a **share of the day**
  (since 20270119090000: **8 000 new receipts in 24 hours for an administrator,
  2 000 for a teacher**, counted over the receipts of the requests the person
  wrote), and a school gets at most **20 000 new receipts in 24 hours** (five
  requests to every guardian of a school of 2 000 pupils, far more than a school
  needs; under four minutes of mail a day at most: 20 000 addresses, 49 to a
  mail, one mail every half second): the 11th request, the receipts past the
  sender's share and the receipts past the day's are refused whole with 429
  (`ACK_TOO_MANY_REQUESTS`, `ACK_SENDER_DAY_LIMIT`, `ACK_TOO_MANY_RECIPIENTS`)
  by the database (triggers; the owner and the migrations are not counted, and
  the limits take an advisory lock each, the sender's first and the school's
  then, so two requests at the limit do not both pass), and `POST
  /api/v1/acknowledgements` is throttled to five a minute besides. To change a
  number is a migration (`app.ack_day_limit` holds all three). The delivery has a second, **urgent lane** for the
  crisis alarm and its end (`CRISIS_ALARM`, `CRISIS_ENDED`): a wave of mails
  never stands in front of an alarm's push (ten minutes of life); the lanes
  share the providers' pace (mails go one at a time in the order they ask,
  each at least 500 ms after the last one actually went, whichever lane sends it).
  **The reminder pass** lists the due requests (`app.ack_remind_queue`, ids
  only) and takes them one at a time (`app.ack_remind_request`), each in a
  transaction under the delivery door's five seconds, up to a minute a pass: a
  request that fails or times out is rolled back alone and stays in the queue,
  the ones after it are done, and what a pass runs out of time on is left for
  the next (`left` in `JobRuns.counts`). A pass with a failed request is
  recorded as failed. Both functions answer nothing to a login that resolves
  to a person (`app.current_user_id()` set); the job's door sets no claims.
  The guard needs no role of its own, and the routes call neither.
  **Release note** (in these words or others): *Rastra can now ask a
  guardian to confirm a message about their child. A member of staff writes the
  message, chooses the pupils (a mentor only their own) and whether one guardian
  is enough or all must confirm; the guardian confirms in the app or on the web;
  the sender sees who confirmed and when. Nothing is sent until the school has
  turned kvittens on under Drift › Kvittens.*
  **Before the migrations**, as the owner: no `app.ack_%` function and no
  `AckSettings`, `AckRequests` or `AckReceipts` table exist (`SELECT count(*)
  FROM pg_proc WHERE proname LIKE 'ack\_%'` and `SELECT count(*) FROM pg_tables
  WHERE tablename LIKE 'Ack%'` are both 0), `prisma migrate status` lists
  exactly the two new migrations as pending, no session sits idle in a
  transaction that holds `Users` or `Schools` (`SELECT pid, state, now() -
  xact_start FROM pg_stat_activity WHERE state = 'idle in transaction'`), and
  the gallring functions carry `main`'s branches with the md5 above.
  **After them, before the merge:** the three tables have row security on
  (`SELECT relname, relrowsecurity FROM pg_class WHERE relname LIKE 'Ack%'`),
  `app_authenticated` holds SELECT and INSERT on the requests and the receipts,
  SELECT, INSERT and UPDATE on the settings, and nothing else (`SELECT
  has_table_privilege('app_authenticated', 'public."AckReceipts"', 'UPDATE,
  DELETE, TRUNCATE')` is false; no MAINTAIN), `anon` and `authenticated`
  nothing at all; there are 19 `app.ack_%` functions, all definer, 14 of them
  executable by `app_authenticated` and none by `anon`, `authenticated` or
  `service_role` (`SELECT p.oid::regprocedure FROM pg_proc p WHERE p.proname
  LIKE 'ack\_%' AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR
  has_function_privilege('authenticated', p.oid, 'EXECUTE'))` returns no row);
  `SELECT count(*) FROM "AckSettings"` is 0; both gallring bodies carry
  `AckRequests` and have the md5 above; the enum has the two values
  (`SELECT enum_range(NULL::"NotificationType")`); no invalid index and no lock
  wait. Do not call `app.ack_remind_request()` to see: it reminds
  (`app.ack_remind_queue()` only lists ids). The policies on `AckRequests` and
  `AckReceipts` name `ack_my_request_ids`, `ack_mentee_request_ids` and
  `ack_authored_request_ids` as initplans (`SELECT pg_get_expr(polqual,
  polrelid) FROM pg_policy WHERE polname LIKE 'ack\_%select'`).
  **After the merge:** `JobRuns` gets a row for `ack-reminders` within fifteen
  minutes of the new instance serving, its counts `{"reminded": 0, "requests":
  0, "failed": 0, "left": 0}`; `GET /api/v1/acknowledgements` answers
  `{"items": [], "next": null}` for every school. Then, in a test school with
  two accounts: turn kvittens on, write a request about a pupil with two
  guardians, confirm as one of them, see it in the sender's view, and read the
  log for `Reminder pass failed` and `A request's reminder failed`.
  **While any school has kvittens on**, watch (read-only): the passes that
  failed or ran out of time (`SELECT day, runs, failures, counts, "lastError"
  FROM "JobRuns" WHERE job = 'ack-reminders' AND (failures > 0 OR
  (counts ->> 'left')::int > 0) ORDER BY day DESC LIMIT 5`); the oldest due
  reminder nobody has dealt with, which should be under an hour old (`SELECT
  count(*), min("remindAt") FROM "AckRequests" WHERE "remindAt" <= now() AND
  "reminderOutcome" IS NULL`); who sends much (`SELECT "schoolId", "authorId",
  count(*) FROM "AckRequests" WHERE "createdAt" > now() - interval '1 hour'
  GROUP BY 1, 2 HAVING count(*) > 5`); and how far a school is from its day's
  limit (`SELECT "schoolId", count(*) FROM "AckReceipts" WHERE "createdAt" >
  now() - interval '24 hours' GROUP BY 1 ORDER BY 2 DESC LIMIT 5`).
  **Tried (the second review):** a Prisma client generated from the schema
  *before* the release (without Kvittens) reads a `Notifications` row of the two
  new types with `count` and `updateMany`, but a model read that returns the row
  (`findMany`, `groupBy`) throws `Value 'ACK_REQUESTED' not found in enum
  'NotificationType'`. The gateway reads `Notifications` with the model
  nowhere (it writes with `createMany` and reads twice by raw SQL, which gives
  the enum as text, in `school-export/data-files.ts`; the apps read the inbox
  through PostgREST), so a revert of the code is harmless today, and an older
  app shows a row of the new types as "Notification". What would break it is a
  model read of `Notifications` that lands in `main` before a revert: check
  `git grep -nE 'notification\.(findMany|findFirst|findUnique|groupBy|aggregate)'
  src` first, and delete the notices in the same transaction as the rollback
  below if one has landed.
  **Hardening after the three reviews (20270119090000, one migration, the
  gateway and the web in one release; Kvittens is off everywhere until a school
  turns it on, so none of it is seen before then).** Four things the reviews
  found, in the order they were found:
  *(1) The delivery's mail chain survives an error.* Every mail asks for a turn
  in one chain shared by both lanes; a turn that threw closed the e-mail of the
  whole process until it was restarted. A turn that throws now costs only its own
  mail (logged `Email dispatch skipped [turn, <error name>]`).
  *(2) A request to Resend or Expo that is not answered is given up.* The
  calls had no time limit, so a mail that never got an answer held its lane for
  as long as the runtime waits (five minutes), and the ordinary lane carries every
  school's notices. A mail now waits **10 s** (`EMAIL_TIMEOUT_MS`; Resend answers in
  well under one) and is then logged (`Email dispatch failed [timeout 10000 ms]`)
  and not sent again, like any refused mail; an Expo request waits **10 s**
  (`REQUEST_TIMEOUT_MS`, the answer's body under the same limit), counts as a
  network error and is retried after 1, 2 and 4 s as before, so a chunk Expo never
  answers is given up after 47 s and its messages are answered `RequestFailed`. A
  retry after a timeout can send a push twice if the first reached Expo; a lost push
  is the worse of the two. A Resend that does not answer at all still costs every
  mail of a wave its ten seconds: check it first when mail stops (`Email dispatch
  failed [timeout` in the log).
  *(3) A reminder reads "Skickad" only when the mail went.* The pass writes the
  notices and marks the request SENT in one transaction, as before; the e-mail and
  the push go after the commit through the delivery's queue. The delivery now says,
  when it has finished the batch, whether every mail and push was taken by its
  channel (Resend answered 2xx; Expo took the request, a device it calls gone is not
  a refusal), or that there was nothing outside the inbox to send, and the gateway
  records it in `AckRequests."reminderMirroredAt"` (`app.ack_reminder_mirrored`,
  which answers nothing to a login that is a person). Until then, and for good if
  it never comes, the gateway calls the reminder `WRITTEN` and the staff's list says
  *Lagd i inkorgen* (the notices are in the inboxes, and nothing more is known)
  where it said *Skickad*; the detail page says what is and is not known. **Known
  limit:** the e-mail and the push of a reminder go to the delivery's in-memory
  queue after the commit, as every other notice does, so a process that stops
  between the commit and the send loses them: the inbox notices are written, the
  request reads *Lagd i inkorgen* for good, and nothing sends the reminder again.
  A whole-school wave is some 41 s of mail and 8 s of push, so **do not release
  while one is going** (`SELECT count(*), min("remindAt") FROM "AckRequests" WHERE
  "remindAt" <= now() AND "reminderOutcome" IS NULL` is empty, and the last
  `JobRuns` row of `ack-reminders` is a few minutes old at most, when the pass has
  just finished), and read the requests that stayed `WRITTEN` afterwards (`SELECT
  count(*) FROM "AckRequests" WHERE "reminderOutcome" = 'SENT' AND
  "reminderMirroredAt" IS NULL AND "reminderSentAt" < now() - interval '15
  minutes'`). A refused batch (Resend or Expo answering with an error) leaves the
  request `WRITTEN` the same way.
  *(4) A sender cannot use up the school's day.* The school's 20 000 rows were
  shared by all senders: two mentor accounts, each writing the ten requests an hour
  for a class of 30 (66 rows each), reach 15 840 rows a day each. Each sender now has
  a share of the day (8 000 for an administrator, 2 000 for a teacher; refused whole
  with `KV427`, `ACK_SENDER_DAY_LIMIT`, 429, before the school's own limit is
  looked at). The numbers: a whole-school request is pupils x guardians (4 000 for
  2 000 pupils with two guardians each, 5 700 for the largest school counted on, 2 600
  pupils), and an administrator's 8 000 holds one of those and a half more; a mentor
  asks about 30 to 60 pupils, 66 to 132 rows a request, and 2 000 is fifteen to thirty
  requests a day. Against the school's 20 000: no one sender, and no two
  administrators, can use the day up (3 x 8 000 can; ten teachers can). An
  administrator reads the use on the Kvittens page (`GET
  /api/v1/acknowledgements/usage`: the school's rows of the last 24 hours, their own
  share, and the five who used most), the same numbers the limits refuse by. The
  share is counted per author of the request, over the requests written in the last
  24 hours. The migration adds one nullable column and its check to the requests table (empty while no school has turned kvittens on)
  under a 5 s `lock_timeout`, three functions (`app.ack_reminder_mirrored`,
  `app.ack_day_limit`, `app.ack_usage`) and replaces `app.ack_receipts_limit`, so
  there are 22 `app.ack_%` functions after it, all definer with a pinned
  `search_path`, 16 the API role may run and six the owner's alone. It touches no
  other table, takes no lock on `Users` or `Schools`, and the gallring functions are
  not touched. **Before it:** `SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON
  n.oid = p.pronamespace WHERE n.nspname = 'app' AND p.proname LIKE 'ack\_%'` is 19,
  `SELECT count(*) FROM "AckRequests"` is the number you expect (zero while no school
  has turned kvittens on), and no session holds a lock on `AckRequests`. **After it
  and before the merge:** the count is 22; `SELECT count(*) FROM pg_attribute WHERE
  attrelid = '"AckRequests"'::regclass AND attname = 'reminderMirroredAt'` is 1;
  `app.ack_day_limit('SCHOOL')`, `('SCHOOL_ADMIN')` and `('TEACHER')` are 20000, 8000
  and 2000; `anon`, `authenticated` and `service_role` can run none of the
  `app.ack_%` functions. **The API before the release** does not know the column or the
  functions and writes the notices as before, so it keeps working between the migration
  and the deploy; the web before the release does not draw `WRITTEN` and shows the
  state's name, which is a cosmetic fault until the web is deployed (the web and the
  gateway are one release). **Rolling it back:** a revert of the code is harmless; the
  column and the functions stay unread, and `app.ack_receipts_limit` keeps the sender
  shares, which only makes the database stricter than the old gateway knew
  (it would answer `KV427` as an error and not as a 429 until the code is back).
  **Rollback of the code** is a revert; the tables stay and are unread. Rollback
  of the data, only if nothing in it is wanted: `BEGIN; DELETE FROM
  "Notifications" WHERE "type"::text IN ('ACK_REQUESTED', 'ACK_REMINDER');
  DELETE FROM "NotificationOptOuts" WHERE "type"::text IN ('ACK_REQUESTED',
  'ACK_REMINDER'); DROP TABLE "AckReceipts", "AckRequests", "AckSettings";
  DROP TYPE "AckRule", "AckReminderOutcome"; COMMIT;` and the two gallring functions restored to the bodies with the md5
  above. Count the notices first (`SELECT count(*) FROM "Notifications" WHERE
  "type"::text LIKE 'ACK\_%'`). What a rollback changes: nobody can ask or
  confirm, and the requests already made are gone.
  *(5) What the lock of 20270119090000 taught, for the next migration of a table
  with rows.* That file's `ADD COLUMN` and `ADD CONSTRAINT` came first, and a file
  is one implicit transaction: `ACCESS EXCLUSIVE` on `AckRequests` was taken at its
  start and held to its end, past the functions and the DO block. Its comment said
  "a few milliseconds"; the independent review measured 1.85 s on a loaded test host.
  With one session holding a read on the table (a pooled connection left idle in a
  transaction) the 5 s `lock_timeout` ended the run at 5.5 s and rolled it back
  whole, and an ordinary `SELECT` that arrived a second after the waiting `ALTER`
  queued 4.4 s behind it. Nothing is wrong while the table is empty (no school has
  turned kvittens on), and the file has run in production, so it is not changed.
  **The rule for the next one:** put the `ALTER` statements LAST in the file, so the
  lock is held only over them; or take the lock `NOWAIT` in a retry loop with a 30 s
  ceiling and a message that names the `prisma migrate resolve --rolled-back` the
  next try needs, as 20270117091000 does for `Schools` and `Users`. A single
  `lock_timeout` is not enough: it bounds the wait and not the hold, and the queue
  behind a waiting lock request is the harm.
  *(6) The three doors of the delivery answer no login at all (20270202090000, after
  the reviews of #277 and #289).* `app.ack_remind_queue` (the list of due request ids),
  `app.ack_remind_request` and `app.ack_reminder_mirrored` stood back for a session that
  resolves to a person, and a login with no person row (the huvudman's reader, the
  municipality's administrator) slipped past that; the list handed such a login every
  school's due request ids. They now answer nothing to a session with any claims, and
  are run only by the delivery's door, which sets none. The migration replaces the three
  bodies (the guard is the only difference, the same text in all three) and touches no
  table, so it takes no table lock. **Before it:** `md5(prosrc)` of `app.ack_remind_queue`
  is `1917f84de8c01162277654565db52463`, of `app.ack_remind_request`
  `894541402de92108263324294f19c4db` and of `app.ack_reminder_mirrored`
  `edaea80452b04494beeb73668086bcc0`; **after it** they are
  `7a4ed5aa8bf98b87a1f85dc542c56b80`, `6836f7ae29327c074a4dc7b62776837b` and
  `308fe14167295988d49d575cdf0f1856`, the count of `app.ack_%` functions is still 22,
  and `app.ack_usage` (`2534cef97c828b5999ce076aff18f9d3`) and the gallring functions
  are untouched. A session with any claims, a person or not, is handed nothing by any
  of the three. Functions outside Kvittens that guard on `app.current_user_id() IS NOT
  NULL` as "logged in" are not changed here; each wants its own pass, with a 450o-style
  test per door.
- **Ett läsårs lektioner tas bort först**: 20270120090000 adds the function
  `app.academic_year_lessons_go_first()` (SECURITY DEFINER, `search_path`
  pinned to `public, pg_temp`, EXECUTE revoked from PUBLIC and from `anon`,
  `authenticated`, `service_role` and `app_authenticated`: a trigger needs none)
  and the trigger `AcademicYears_a_lessons_go_first` (BEFORE DELETE, per row),
  which deletes the lessons of the year's classes before the year goes. No
  table, row, column, policy or grant is touched, and none of the SS12000
  flow's functions is restated. Why: removing a year cascades into its lessons
  by two routes, and which runs first is the order of the keys' triggers by
  name (`RI_ConstraintTrigger_a_<oid>`); 20270115090000 moved the classes' key
  to the end, so the master lessons' key runs first, the lessons lose their
  master lesson before they go, and `app.ss12000_v_lessons()` files an
  `AdhocActivity` tombstone for each (a year with two keyed lessons and one
  ad hoc: 3, not 1). Nothing is lost: the consumers are sent ids they never
  had. The service for removing a year did it right since #272 by deleting the
  lessons itself, which is one way in, and judged by another policy (DRIFT) than
  the year's (PLANERING): a profile with only the second would have deleted no
  lesson and no error. The trigger is every way in (the service, SQL,
  PostgREST) and every profile; the service no longer deletes the lessons
  itself. **The trigger runs as the owner, like the cascade it comes before:**
  the referential action deletes the same rows as the owner and passes row
  security, row security is not forced on the tables, and the trigger fires only
  for a year the caller's own DELETE policy let through (another school's
  administrator and a teacher reach no row, so no trigger; RLS sections
  386-387). It takes `AcademicYears` in SHARE ROW EXCLUSIVE, NOWAIT, in a loop
  with a 30 s ceiling: reads and foreign-key checks go on, writes to the table
  wait for the file (milliseconds), and if it is not free in 30 s it stops with
  nothing changed (`prisma migrate resolve --rolled-back
  20270120090000_ett_lasars_lektioner_tas_bort_forst_pa_varje_vag`, then deploy
  again). **The migration goes in first, then the merge:** the API before it
  deletes the lessons itself and the trigger then finds none; the API after it
  leaves them to the trigger, and without the trigger a removal files the extra
  tombstones until it is there. The file's checksum (sha256, what Prisma
  records) is `aee367080f074e85ebb1ed43380670de25a24f1744d1f98ce286a7c6c839d108`.
  **Before the migration**, as the owner, all of it read-only:
  `SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NULL OR
  rolled_back_at IS NOT NULL ORDER BY migration_name COLLATE "C"` returns no
  row; `SELECT max(migration_name COLLATE "C") FROM _prisma_migrations WHERE
  finished_at IS NOT NULL AND rolled_back_at IS NULL` is
  `20270119090000_en_avsandare_har_en_andel_av_dygnet_och_en_paminnelse_vet_om_brevet_gick`
  (#277's, the last one applied in production when this was written; any from
  `20270118090000` on that is not this one passes); `prisma migrate status`
  lists exactly this migration as pending; `SELECT to_regprocedure('app.academic_year_lessons_go_first()'),
  (SELECT count(*) FROM pg_trigger WHERE tgrelid = '"AcademicYears"'::regclass
  AND tgname = 'AcademicYears_a_lessons_go_first')` is NULL and 0; the BEFORE
  DELETE triggers on the table are none (`SELECT tgname FROM pg_trigger WHERE
  tgrelid = '"AcademicYears"'::regclass AND NOT tgisinternal AND tgtype & 10 =
  10 ORDER BY tgname COLLATE "C"` returns no row); no session sits idle in a
  transaction that holds `AcademicYears` (`SELECT pid, state, now() -
  xact_start AS age, left(query, 70) FROM pg_stat_activity WHERE datname =
  current_database() AND pid <> pg_backend_pid() AND xact_start < now() -
  interval '3 seconds' ORDER BY age DESC`). **Information:** which of the two
  keys the year's removal runs first in production, as the trigger names order
  them (the database compares them as bytes, hence the collation):
  `SELECT c.conrelid::regclass AS child, t.tgname FROM pg_trigger t JOIN
  pg_constraint c ON c.oid = t.tgconstraint WHERE t.tgrelid =
  '"AcademicYears"'::regclass AND t.tgisinternal AND t.tgtype & 8 = 8 AND
  c.conrelid IN ('"StudentGroups"'::regclass, '"MasterLessons"'::regclass) ORDER
  BY t.tgname COLLATE "C"`: with `"MasterLessons"` first a removal files the
  extra tombstones today.
  **After it, before the merge:** `SELECT t.tgtype, t.tgenabled, t.tgfoid::regproc
  FROM pg_trigger t WHERE t.tgrelid = '"AcademicYears"'::regclass AND t.tgname =
  'AcademicYears_a_lessons_go_first'` is `11` (BEFORE, DELETE, per row), `O`,
  `app.academic_year_lessons_go_first`; `SELECT p.prosecdef, p.proconfig,
  p.proowner = c.relowner AS owner_of_the_tables, (SELECT count(*) FROM
  aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee
  <> p.proowner) AS other_grantees, md5(p.prosrc) FROM pg_proc p, pg_class c
  WHERE p.oid = 'app.academic_year_lessons_go_first()'::regprocedure AND c.oid =
  '"AcademicYears"'::regclass` is `true`, `{"search_path=public, pg_temp"}`,
  `true`, `0`, `3dbf3391e7a8ec8649239b9a02054ebb`; `SELECT r,
  has_function_privilege(r, 'app.academic_year_lessons_go_first()', 'EXECUTE')
  FROM unnest(ARRAY['anon', 'authenticated', 'service_role',
  'app_authenticated']) r ORDER BY r COLLATE "C"` is false four times;
  `SELECT relname, relforcerowsecurity FROM pg_class WHERE oid IN
  ('"AcademicYears"'::regclass, '"CalendarLessons"'::regclass,
  '"StudentGroups"'::regclass) ORDER BY relname COLLATE "C"` is false three
  times; and the flow's own functions are what they were,
  `SELECT proname, md5(prosrc) FROM pg_proc WHERE pronamespace =
  'app'::regnamespace AND proname IN ('ss12000_bury', 'ss12000_v_lessons',
  'ss12000_year_is_emitted') ORDER BY proname COLLATE "C"` being
  `91f0808502e6f703283c02ca1fe33c2b`, `31d7cd85b4db4a00995a4f5275f45253` and
  `4fef216a7588f169db98a639de67193f` before and after (read on a database built
  by the migrations). The behaviour is not tried against production (it would
  delete): it is the adapter probe's `tk4` and RLS sections 385-387, on every
  run of the Database job.
  **Rolling back** is two steps, as the owner on the direct connection, and the
  API goes back with them: the API before this release deletes a year's lessons
  itself (it has since #272), so with the trigger gone it still files the right
  tombstones; the API of this release leaves the lessons to the trigger, and
  with the trigger gone and that API left in place a removal files the extra
  tombstones again.
  (1) Drop the two objects behind a lock guard. `DROP TRIGGER` takes ACCESS
  EXCLUSIVE on `AcademicYears`, and a drop that waits for one open reader makes
  every later read of the table, and every foreign-key check against it, queue
  behind it (measured: a plain `SELECT count(*)` waited 5.2 s behind a bare
  `DROP TRIGGER` that waited for one open reader). With the guard it gives up
  after a second with `55P03`, drops nothing, and the reader that came meanwhile
  waited 0.9 s; rerun it until it goes through (measured: 251 ms once the reader
  was gone):

  ```sql
  BEGIN;
  SET LOCAL lock_timeout = '1s';
  DROP TRIGGER "AcademicYears_a_lessons_go_first" ON "AcademicYears";
  DROP FUNCTION app.academic_year_lessons_go_first();
  COMMIT;
  ```

  (2) Decide what Prisma is told, because the migration is still recorded as
  applied after the drop, and `prisma migrate resolve --rolled-back` is not the
  command for it: it refuses an applied migration (`P3012`, "not in a failed
  state"; it is for one that stopped, as in the ceiling above and §2.1).
  - To be able to bring the trigger back with `prisma migrate deploy`, delete
    the record, deliberately, as the owner and after the drop, never before it
    (the file creates the function and the trigger without `IF NOT EXISTS` and
    stops at objects that are still there):
    `DELETE FROM _prisma_migrations WHERE migration_name =
    '20270120090000_ett_lasars_lektioner_tas_bort_forst_pa_varje_vag';` removes
    one row; `prisma migrate status` then lists the migration as pending and
    `migrate deploy` applies the file again from its first statement (tried:
    the function with `md5(prosrc)` `3dbf3391e7a8ec8649239b9a02054ebb`, the
    trigger `11`, `O`, and the checksum above come back). That is the way to
    put the API of this release back.
  - Or leave the record. Then the database stays rolled back: a later
    `migrate deploy` says there is nothing to apply and does not recreate the
    trigger (tried), so the API of this release must not be put back until the
    file has been applied by hand (`psql -f`, as the owner).

  What it changes: with the API before this release nothing; with the API of
  this release left in place, removing a year goes back to the keys' order and
  files the extra tombstones; nothing is lost either way.
  **The composite keys' ON UPDATE:** the same release adds RLS section 388,
  which fails the next composite key that holds a school and follows its parent
  when the parent is updated (`ON UPDATE CASCADE`; make it `NO ACTION`, as
  20270115090000 did for 38). 98 older ones are named in the section, and the
  list only gets shorter. No migration changes any of them: moving a parent to
  another school is not something any code path does, and the swap would take
  ACCESS EXCLUSIVE on `Users`, `StudentGroups` and the other parents together.

- **Frånvarostatistik över tid**: 20270121090000 adds the table
  `AbsenceStatsMonths` (the sums of absence per class and month, and per school
  and month, with no column that names a person and no key to `Users`) and
  fifteen `app.absence_stats_*` functions (all SECURITY DEFINER with a pinned
  `search_path` but `app.absence_stats_min_group()`, which reads nothing, and
  `app.absence_stats_lessons()`, see (9)). The
  table has row security and **no policy and no grant**: only the functions read or
  write it, so a PostgREST call and the API's own role are refused (42501); the
  functions' EXECUTE is the API role's for the ten the gateway and the job call,
  and nobody's for the rest (five: the group size, the window's first month, the
  two access checks and the lessons). No existing row is touched, no existing table gains a
  column, and `app.gallring_due` and `app.gallring_purge` are **not** rewritten
  (their md5 stay what the previous migration left them: due `f884a3c7…`, purge
  `21746d39…`, pseudonymise `6f18f62f…` in production). The new keys take `Schools`
  and `StudentGroups` in SHARE ROW EXCLUSIVE, NOWAIT, together in a loop: reads and
  foreign-key checks go on, writes to the two wait for the file, and if both are not
  free at once in 30 s it stops with nothing changed (`prisma migrate resolve
  --rolled-back 20270121090000_franvaron_over_tre_lasar_lagras_per_klass_och_manad_aldrig_per_elev`,
  then deploy again). The API before the release knows none of the objects, so it keeps
  working between the migration and the deploy. The migration goes in first, then the
  merge.
  **What is on after the deploy.** The nightly job counts for every school with a
  lesson in the last 90 days (`app.reporting_schools()`), from 07:00 its local time:
  the months of the last 62 days, and three older months a night, newest first, until
  the three latest läsår are in (about a week; a school with fewer läsår is done sooner).
  One month of a school of 2 000 pupils is a few seconds (`scripts/bench/absence-stats.sql`
  measures it), each in a transaction of its own that asks for 9 s. Nothing is switched
  on per school: the sums hold no pupil. The pages read them: the "Frånvarostatistik"
  tab of `/admin/reports` for every administrator profile, `/teacher/absence-stats` for a
  mentor, the sums of the school and the classes (never a pupil) for the huvudman's
  reader.
  **Decisions, written in the migration's header and in the PR:** (1) *What is
  stored.* Sums per class and month and per school and month, never a row per pupil. A
  pupil's own months, a class's pupils and every pattern are counted from the marks that are
  left, when asked; they go with the marks when attendance is purged. (2) *The smallest
  group is five.* A class with fewer than five pupils has no stored month; a month in which
  fewer than five pupils have a registered mark stores no minute (only the lessons and the
  reporting rate, which are the teachers'); a class of fewer than five pupils with a mark in
  the period has no pattern. The number is `app.absence_stats_min_group()`, the CHECKs
  `AbsenceStatsMonths_a_group_has_five_pupils` and `…_a_figure_has_five_pupils_behind_it`,
  and `MIN_GROUP` in `src/absence-stats/absence-stats.ts`; a jest spec holds the four to one
  number. (3) *The sums outlive the attendance.* They are not purged with it (that is
  what reaches three läsår when attendance is kept for less); the job removes the months
  before the third latest läsår, and they go with their school or class. **A school that
  has decided to purge attendance after a month still has three läsår of sums.** Say so in
  the release note. (4) *A month whose marks may be gone is not counted again:* once the
  school has ever chosen PURGE_AFTER for attendance, no month before the shortest period it
  ever chose is recounted (a later KEEP does not give the marks back), the same guard as
  Rapporteringsgrad's. (5) *Who reads what:* administrators of every profile (as the
  attendance report), a mentor their own pupils and classes by the mentor definition of
  Frånvarobevakningen as of today, the huvudman's reader the sums only. (6) *Protected
  identity:* a marked pupil is in no list and in no mentor's reach; the sums count them; the
  print is the web's and holds them out. (7) *Reads are logged:* a class's pupils and a
  pupil's card are recorded as ATTENDANCE and PEOPLE; the sums are not. (8) *No gender
  split:* the model has no such field and none is added. (9) *The lessons of a month
  are Rapporteringsgradens, but not of the teachers who work now.* `app.absence_stats_lessons`
  is `app.reporting_lessons` (20270112090100) with one line changed: D2 asks whether the
  teacher is active **now** (`Users."isActive"`), the history asks whether she had not left
  when the lesson was over (`"deactivatedAt" IS NULL OR "endsAt" <= "deactivatedAt"`;
  since 20270210090000 (section 16.5) she is asked of `UserDeactivations`, every period she
  was inactive, so a lesson that ended while she was away is not hers when she returns).
  Without it a month, once stored, lost every lesson of a teacher who has since left and
  was never counted again (the plan asks only for months without a row). The two are
  one definition in two texts, and a jest spec (`absence-stats-definition.spec.ts`) and
  the owner's section 392o fail if they differ in anything but that line, so whoever
  rewrites `app.reporting_lessons` next (Elevens lektion för dagen, 20270122, adds a
  condition about a pupil moved off a lesson) must restate `app.absence_stats_lessons` with it, in
  the same migration, after its md5 guard (the body's md5 is in the PR). (10) *A class's
  pupils are the class's own, and add up to the class:* `app.absence_stats_class_pupils` lists the
  pupils enrolled in **the class itself** some day of the period (never those who only sat in
  a predecessor and went to another class or left: their mentor is somebody else, and the
  class's mentor cannot open their card), and counts a listed pupil's marks for the days she
  was in the class or a predecessor (the segment of `StudentEnrollments` that covers the
  lesson's date, as the class's months and patterns count them), not every mark of the
  period; her own card shows all of them. For a period inside the class the pupils' sums are
  the class's month; for a period that reaches back into a predecessor they are less than
  the cohort's sum in the series, by the pupils who did not come along.
  **Release note** (in these words or others): *From the first night after this release
  Rastra counts, every night, the school's and each class's absence by month for the last
  three läsår, without recording any individual pupil, and shows it with the reporting rate
  beside it. Sums over fewer than five pupils are never kept or shown. Administrators see
  the school, the classes and every pupil's own months (counted from the registrations that
  are still stored); a mentor sees their own pupils and classes; the huvudman's reader sees
  the sums. The sums are kept for three läsår also where attendance is purged earlier.*
  **Before the migration**, as the owner: `SELECT count(*) FROM pg_proc WHERE proname LIKE
  'absence\_stats\_%'` and `SELECT count(*) FROM pg_tables WHERE tablename =
  'AbsenceStatsMonths'` are both 0; `prisma migrate status` lists exactly this migration as
  pending; no session sits idle in a transaction that holds `Schools` or `StudentGroups`
  (`SELECT pid, state, now() - xact_start FROM pg_stat_activity WHERE xact_start IS NOT NULL
  AND state <> 'active'`). **After it:** the 15 functions exist, the table has
  row security and `SELECT count(*) FROM pg_policies WHERE tablename = 'AbsenceStatsMonths'`
  is 0; `SELECT has_table_privilege('app_authenticated', '"AbsenceStatsMonths"', 'SELECT')`
  is false (and, on Postgres 17, `MAINTAIN` too); the gallring functions' `md5(prosrc)` are
  what they were before. **The morning after the first night** (07:00 local, every school):
  `SELECT count(*), min(month), max(month) FROM "AbsenceStatsMonths" WHERE "schoolId" = ...`
  has the months of the last 62 days and three more; after a week, the school's earliest
  läsår; no row has `pupils` under 5; `JobRuns` has `absence-stats` with `failed` 0.
  **Rollback of the code** is a revert; the table stays and is unread. Rollback of the
  data, only if nothing in it is wanted: `DROP TABLE "AbsenceStatsMonths"; DROP FUNCTION
  app.absence_stats_min_group(), …` (the fifteen, by name); the gallring functions were
  never touched.

- **Elevens lektion för dagen** (D7): 20270122090000 adds the
  `NotificationType` value `LESSON_PUPIL_MOVED` and nothing else (a value
  cannot be used in the transaction that adds it, so it is a file of its own,
  taking no lock). 20270122091000 adds the table `LessonPupilMoves`, the column
  `CalendarLessonStudents."moveId"` (nullable, key to the move, `ON DELETE
  CASCADE`) and `SchoolDaySettings."guardianNoticeOnMove"` (`false`), twelve
  `app.lesson_pupil_*` / `app.lesson_move_*` functions, five triggers, five
  read arms on the table and the restated bodies of seven readers and of D6's
  `absence_stats_lessons` (below). It
  takes `Schools`, `Users` and `CalendarLessons` in SHARE ROW EXCLUSIVE and
  `CalendarLessonStudents` and `SchoolDaySettings` in ACCESS EXCLUSIVE, all
  together, NOWAIT, in a retry loop of 30 s (a register save or a cancellation
  writes `Users` and `CalendarLessons` in one transaction, so no order of locks
  is safe). If the loop gives up after 30 s it has changed nothing, but Prisma
  has written an unfinished attempt to `_prisma_migrations`, and the next
  `migrate deploy` answers **P3009** until `prisma migrate resolve --rolled-back
  20270122091000_en_elev_byter_till_en_parallell_lektion_for_en_dag` has been
  run (the lock loop's own error message says so); only then run it again.
  Deploy order: **migrate first**, then merge (the old API knows none of the
  new columns and writes none of them; it does not read a move either, but there
  is none before the new API runs).
  **What a move is.** A teacher of one of the lessons, the pupil's mentor that
  day, or an administrator with Drift moves one pupil from a lesson to a lesson
  that overlaps it in time, for that date, and can take it back. The pupil's
  arrival is a named pupil on the target (a row in `CalendarLessonStudents`
  carrying `moveId`), so every reader that already reads named pupils sees the
  pupil there; the departure is read where a replacing group's "off" is read.
  The pupil's mark on the lesson they left is set to `UNKNOWN` (which the
  absence watch, the minute statistics and the SS12000 attendance leave out) and
  kept in `displacedMark`; Ångra puts it back if nobody has written one since.
  A mark on the lesson they were moved to stops Ångra and a move on (409
  `LESSON_MOVE_HAS_ATTENDANCE`). The table has no write arm: it is written only
  by `app.lesson_pupil_move` and `app.lesson_pupil_move_undo` (definer, the API
  role's), which lock the lessons in id order (`FOR NO KEY UPDATE`) before
  anything else; a register save takes the lesson's row `FOR SHARE` through
  `app.lesson_pupil_register_lock`, so a save and a move meet in one order. (The
  lock is a function of its own because a teacher has no UPDATE policy on
  `CalendarLessons` and a row lock under row security runs that policy: taken
  from the gateway it locked nothing for a teacher. The adapter probe, check
  `lm-f`, found it.) A move falls with either lesson when it is cancelled,
  replaced by an activity or moved so that they no longer overlap
  (`CalendarLessons_pupil_moves_lapse`, only when time or status changes), and
  with either pupil or lesson when one is deleted. The state codes of the
  refusals are `LM403`–`LM416`, answered as coded 403/404/409
  (`LESSON_MOVE_*`; `LM416` is `LESSON_MOVE_LESSON_OVER`, below). Nothing
  touches `MasterLessons`.
  The delivered time's audience statement (`audienceStatement`, the timplan)
  gains one column, `movedOffIds`, behind an option only it asks for; every
  other statement of P3 is byte for byte what it was (pinned in
  `timplan-delivered.sql.spec.ts`).
  **The seven readers** restated, each weighed against its previous body before
  it is replaced (the migration stops otherwise): `current_student_replaced_lesson_ids`
  (was 20261211090000, md5 `40ec1dad4dc5024dfbad454679c742e9`),
  `calendar_feed_pupil_lessons` (20270118090000, `edec662e41a36cca8086484a5de74895`),
  `timetable_pupil_days` (`16164f62372b5886f55743657fac1d46`),
  `timetable_week_days` (`d871d3d16dbd336b80ea677ac23abded`),
  `reporting_lessons` (20270112090100, `d6a074eea241802f4e7bbd980e4f29ea`),
  `gallring_due` (20270117091000, `f884a3c77b5234c3d77ae6b77d17f0e7`) and
  `gallring_purge` (`21746d3990375d467cdeec6294308363`). The gallring pair gain
  one branch, `LessonPupilMoves` under ATTENDANCE (a move goes when its source
  lesson's date is older than the school's limit); a later release that rewrites
  them must carry it. **New md5 (to check after the migration):**
  `calendar_feed_pupil_lessons` `57bc5d8b0a656a4d9f0cf3ceecd9d247`,
  `current_student_replaced_lesson_ids` `51f95a8e3c19c2a4e958c3bb5ad18fee`,
  `gallring_due` `a7b1da5813d0acf54b1474ad6f96c9c3`, `gallring_purge`
  `b23e04aec610ebbf1795b832d5054273`, `reporting_lessons`
  `a263885deea0dd2f172362d0ed374167`, `timetable_pupil_days`
  `0a4b0e9f21ce6625edc3edf6e7b7b4e1`, `timetable_week_days`
  `c05f78b5c1392ca7218d8780d85a253a`. **D6's `absence_stats_lessons`**
  (Frånvarostatistik över tid, 20270121090000, which must be run first: the
  migration weighs it and stops otherwise) is D2's `reporting_lessons` but for the
  line about the teacher, and a month D6 has stored must say what the reporting
  rate says for the same month, so it gets the same condition (a pupil moved
  off a lesson is not on its list): md5 `bece0015a55c5a41f4824c2e6550e85d`
  before, **`265b9b21353ecd7e441397f99e565643`** after; it stays `LANGUAGE sql
  STABLE`, not definer, with no `SET` and no grant (D6's tests
  `absence-stats-definition.spec.ts` and section 392o hold it to being
  `reporting_lessons` but for that line, and fail the build without the patch).
  `absence_stats_month` (`38e6f66e73a8b1463403a873a9b9ebb4`) is untouched.
  Read the readers with `SELECT p.proname, md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n
  ON n.oid = p.pronamespace WHERE n.nspname = 'app' AND p.proname IN
  ('current_student_replaced_lesson_ids', 'calendar_feed_pupil_lessons',
  'timetable_pupil_days', 'timetable_week_days', 'reporting_lessons',
  'gallring_due', 'gallring_purge') ORDER BY p.proname COLLATE "C"` (prod
  sorts en_US, so compare the md5 per name, not the order). The migrations'
  sha256: 20270122090000 `7beae1596b32c59ab6201ec7748823afb66f5240f8cab580b323bcfd1d1e8e01`,
  20270122091000 `a80b82488d3b910a32c0aea5c115371af397a8a3e72ae665658f36d095191b97`
  (the second changes if the file is edited after this was written: check
  `shasum -a 256` of the merged file). The two doors' md5 (`prosrc`) and the
  new function the reviews of #281 added before the migration was run:
  `lesson_pupil_move` `8b2bc446f5550bde8cba9123c82bba42`,
  `lesson_pupil_move_undo` `8d4a88be4e23e9f4191b969b488ed7b0` and
  `lesson_move_may_correct` `43ae32c8ef504e8f4bd35b96330a6745`.
  **What is decided, for a conversation with the school (BESLUT):** a move is for
  today or later (a past day's register is not edited this way). **A lesson
  that has ended** (409 `LESSON_MOVE_LESSON_OVER`, `LM416`): the day is not the
  hour, the register of a finished lesson is its teachers', and a move writes
  the pupil's mark on the lesson it leaves, so (1) **no new move** is made off
  a lesson that has ended, for anybody; (2) **Ångra and a move back** after the
  source's end, the same day, are for an administrator with Drift and for a
  teacher on **the source** (the one whose mark is put back, with its author
  and time), and for nobody else: the teacher of the target alone, the
  pupil's mentor, a pupil or a guardian get `LM416` or `LM403`; (3) **a move
  on** from the lesson the pupil was moved to writes nothing on the first
  source (its mark row is untouched, the displaced mark is carried to the new
  move), so the first source's end does not matter; the rule is asked of the
  lesson the pupil is taken out of: once that one has ended too, only an
  administrator with Drift and a teacher on it may move the pupil on (a lesson
  a pupil is moved into that has already ended is not refused: the target is
  the target teacher's affair, as before). Ångra never takes away a mark on
  the target: a mark of the pupil there (anything but Okänd) refuses Ångra, a
  move back and a move on (409 `LESSON_MOVE_HAS_ATTENDANCE`, `LM415`) for
  everybody, the administrator and the source teacher too, and the mark
  stands. After midnight (`LM414`) a move can no longer be undone or moved on at
  all: the register of the source lists the moved pupil as moved away and saves
  nothing for them, so a mistake found the next day is corrected in SQL by whoever
  runs the database (the rollback statement below puts the marks back); no free-text
  reason is stored (a note about a child would be a record nobody asked for);
  the teachers of both lessons are always told (the one who moved the pupil
  excepted), **the guardian only if the school says so** (Drift › Skolans dag,
  off by default; the push and the e-mail say that a pupil's lesson has changed
  and when, never who and never the pupil); Ångra and a move on are refused
  once the pupil has a mark on the lesson they were moved to; a lesson that is
  cancelled or replaced takes its moves with it and the set-aside mark is not
  put back (the pupil may have gone there); a lesson whose pupils all come from
  a class list still counts as held in the reporting rate when every pupil has
  been moved off (only a lesson of named pupils is handled). **Known limits:**
  a pupil's own direct read of a moved-in lesson does not show the teacher's
  name until the teacher's rows reach the pupil (the gateway's week does); the
  app has no screen for moving (a notice and the type, and the realtime
  broadcast keeps the register current); a lesson that is deleted (a
  republication that removes a base lesson) takes the moves on it with it, as a
  cancellation does, and a mark that was set aside on the source stays
  `UNKNOWN` (the set-aside copy goes with the move, and nobody is told: a
  deletion is not a cancellation); the register is where it is corrected; a
  move that gallring removes
  (the source's date older than the school's attendance limit) takes the
  arrival with it, so the delivered time (`movedOffIds`) and the rosters of a
  lesson older than that limit read it as if the pupil had never been moved:
  the delivered time of a year older than the attendance limit is not stable.
  **Measure** (`scripts/bench/lesson-moves.ts`: two schools of 60 classes of 25
  pupils and six lessons a day, one with 120 pupils moved to a parallel lesson;
  medians of 21 adjacent pairs on a shared Mac, so load moves both alike): the
  whole day's rosters as an administrator read them 194 ms without moves and
  124 ms with (the difference is the host's, the moved pupils are fewer on the
  lessons they left); a register opening 51 and 53 ms; a pupil's own lessons
  11.6 and 12.6 ms; the calendar feed for fifty pupils 372 and 291 ms; a
  guardian's week of a moved child 122 and 143 ms (the child's moves are one
  more indexed read, the lesson they went to has its own teachers and room).
  The statements the feature adds execute in 0.02 ms each on the database
  (`EXPLAIN ANALYZE`, best of 21). No hot table gained a policy arm.
  **Release note** (in these words or others): *A teacher, a mentor or an
  administrator can now move one pupil to a parallel lesson for a day, from the
  register, the klassbok or the lesson list, and take it back. The pupil is
  counted where they are: in the register of the lesson they went to, not as
  absent from the one they left; the pupil's and the guardian's schedule and
  calendar follow. A guardian is told only if the school chooses so under Drift
  › Skolans dag.*
  **Before the migrations**, as the owner: no `LessonPupilMoves` table and no
  `app.lesson_pupil_%` function exist, `prisma migrate status` lists exactly
  the two new migrations as pending, no session sits idle in a transaction that
  holds `Users`, `Schools` or `CalendarLessons`, the seven readers carry
  the md5 above, D6's 20270121090000 is applied and `absence_stats_lessons`
  carries `bece0015a55c5a41f4824c2e6550e85d`, and `_prisma_migrations` has no unfinished row (an earlier
  attempt that gave up leaves one: P3009). **After them, before the merge:** `LessonPupilMoves` has row
  security on with five policies, all `TO app_authenticated`, and
  `app_authenticated` holds SELECT and nothing else (`SELECT
  has_table_privilege('app_authenticated', 'public."LessonPupilMoves"', 'INSERT,
  UPDATE, DELETE, TRUNCATE')` is false; no MAINTAIN on 17); `anon`,
  `authenticated` and `service_role` hold nothing that writes; four of the
  twelve functions are executable by `app_authenticated`
  (`lesson_pupil_move`, `lesson_pupil_move_undo`, `lesson_move_is_mentor`,
  `lesson_pupil_register_lock`) and none by `anon`, `authenticated` or
  `service_role`; `SELECT count(*) FROM "LessonPupilMoves"` is 0; the enum has
  the value; no invalid index and no lock wait. **After the merge:** in a test
  school with a teacher, a mentor and two parallel lessons: move a pupil, see
  them in the target's register and in the guardian's week, save the source's
  register, take the move back, and read the log for `Pupil moved` and for a
  `LESSON_MOVE_*` that is not a 4xx.
  **Rolling back the API** leaves the table and the functions unread, but a
  move that stands makes the old code count the pupil on both lessons (the
  arrival is a named pupil it reads, the departure it does not know). Before a
  revert, put the marks back and take the moves away in one transaction:
  `BEGIN; UPDATE "AttendanceRecords" a SET "status" =
  (m."displacedMark" ->> 'status')::"AttendanceStatus", "note" =
  m."displacedMark" ->> 'note', "recordedAt" = (m."displacedMark" ->>
  'recordedAt')::timestamptz, "recordedById" = (m."displacedMark" ->>
  'recordedById')::uuid, "updatedAt" = now() FROM "LessonPupilMoves" m
  WHERE m."displacedMark" IS NOT NULL AND a."calendarLessonId" =
  m."fromLessonId" AND a."studentId" = m."studentId" AND a."status" =
  'UNKNOWN'; DELETE FROM "LessonPupilMoves"; COMMIT;` (the arrivals go with the
  moves). The schema stays; dropping it is a migration of its own, and the seven
  readers go back to the bodies named above and `absence_stats_lessons` to D6's
  (`bece0015…`, its migration's text).
- **Måltidskollen**: 20270123090000 adds one table, `KitchenSettings` (a row per
  school: the cut-off for reported absence, whether the daily letter to the
  kitchen is on, and the kitchen's address; three policies, SELECT, INSERT and
  UPDATE to `app_authenticated`, nothing else, no MAINTAIN), and five
  functions, all SECURITY DEFINER with a pinned `search_path` and `jit = off`:
  `app.meal_counts` (the count, the owner's alone), `app.meal_counts_for_me`,
  `app.meal_letter_last_for_me`, `app.meal_letter_schools` and `app.meal_letter`
  (the four doors the API role may run). No existing table is touched and no
  existing function replaced (gallring is unchanged), and no enum gains a value:
  the letter is a mail to an address, not a notice to a user. The migration locks
  `Schools` alone, `NOWAIT` in a 30-second loop (the key from the new table), and
  can be rerun after a refusal. **Off for every school**: with no row the cut-off
  is none, so no absence is taken off, and no letter goes. The counts read
  `CalendarLunches` (the published schedule), active pupils by home class,
  `AbsenceReports` that cover the whole sitting (first reported before the day's
  cut-off in the school's own time), replacement lessons of an activity over the
  sitting (shown, counted), and pedagogisk lunch duties with fixed slots; they
  carry numbers and the names of classes, never a pupil, and are not recorded in
  the read log. `GET /api/v1/meal-counts` answers at most 14 days from today and
  refuses a day before today; `/csv` is the same days in windows-1252 with `;`.
  **Release note** (in these words or others): *Rastra can now give the kitchen
  the number of portions for each lunch sitting, from the published schedule, as
  a page to print, a file for Excel and, if the school wants it, a letter every
  school day at the time the kitchen places its order. Allergies and diets are
  not stored in Rastra and are not included. Nothing is sent until the school has
  turned the letter on under Drift › Måltidskollen.*
  **Before the migration**, as the owner: no `KitchenSettings` table and no
  `app.meal_%` function exist (`SELECT count(*) FROM pg_tables WHERE tablename =
  'KitchenSettings'` and `SELECT count(*) FROM pg_proc WHERE proname LIKE
  'meal\_%'` are both 0), `prisma migrate status` lists exactly this migration as
  pending, and no session sits idle in a transaction that holds `Schools`
  (`SELECT pid, state, now() - xact_start FROM pg_stat_activity WHERE state =
  'idle in transaction'`).
  **After it, before the merge:** `KitchenSettings` has row security on and
  exactly three policies, all `TO app_authenticated`; `app_authenticated` holds
  SELECT, INSERT and UPDATE on it and nothing else (`has_table_privilege(...,
  'DELETE, TRUNCATE')` is false; no MAINTAIN), `anon` and `authenticated` nothing;
  there are five `app.meal_%` functions, all definer with `search_path=public,
  pg_temp` and `jit=off`, four executable by `app_authenticated` and none by
  `anon`, `authenticated`, `service_role` or PUBLIC, and `app.meal_counts` by none
  of them; `SELECT count(*) FROM "KitchenSettings"` is 0.
  **After the merge:** `JobRuns` gets a row for `meal-letter` within two minutes
  of the new instance serving, its counts `{"schools": 0}`; `GET
  /api/v1/meal-counts?days=7` answers for every school, `staffModelled: false` for
  one that has placed no pedagogisk lunch. In a test school: give a cut-off and
  an address under Drift › Måltidskollen, turn the letter on a few minutes
  before the cut-off, and read the log for `Meal letter [school=...` and, if it
  was not taken, `Meal letter not sent`. A letter needs `RESEND_API_KEY`; without
  it the claim stays open and is retried until three hours after the cut-off.
  **#277** changes the delivery's mail (a timeout, a turn that throws, whether a
  mail was taken). `sendLetter` calls `sendEmails` and reads a `false` answer as
  "not taken" where #277 gives one, so it needs no edit when #277 is in.
  **Rollback of the code** is a revert; the table and the functions stay and are
  unread. Rollback of the data, only if nothing in it is wanted: `DROP FUNCTION
  app.meal_letter(uuid, date), app.meal_letter_schools(timestamptz, integer),
  app.meal_letter_last_for_me(), app.meal_counts_for_me(date, date),
  app.meal_counts(uuid, date, date); DROP TABLE "KitchenSettings";` and `prisma
  migrate resolve --rolled-back 20270123090000_koket_far_portionerna_per_sittning`.
  What a rollback changes: the page answers 404, no letter goes, and the cut-offs
  and addresses the schools entered are gone.

- **Bästa möjliga schema**: 20270125090000 adds three columns and nothing else:
  `LunchSettings."generatorBestEffort"` (boolean, NOT NULL, default false: the
  Skolregler switch), `ScheduleCandidates."deviations"` (jsonb, nullable, a
  list or NULL by the CHECK `ScheduleCandidates_deviations_is_a_list`) and
  `PublicationSettings."gateDeviations"` (`PublishGateMode`, NOT NULL, default
  WARN: the policy of the new publish check `PUB_DEVIATIONS`). **It is off for
  every school until that school turns it on**; the migration turns nothing on
  and changes no row, so every Skolregler row reads off, every candidate reads
  null (it did not come from the mode) and every settings row reads WARN. With
  the switch on, an administrator who plans can ask a schemaförslag run for
  *one* candidate (`mode: 'BEST_EFFORT'`) that the engine places even when the
  school's own shaping rules cannot all hold: a teacher's cap of minutes a day,
  a part-timer's days, a subject's cap per day and its days apart, and a
  subject's locked rooms may give way, and the candidate lists which did and by
  how much. Everything else stays hard (a double booking, a lesson outside the
  frame times, the walk between sites, a teacher's lunch and rest, a teacher
  marked unavailable, a requirement's own room type, lunch, lesson lengths, a
  block's shared start, the group's daily cap): the list is the engine's
  (`optimization-engine/app/solver/relaxation.py`), not a setting. **The apply
  of a candidate with deviations needs the administrator to accept exactly that
  list** (`acceptedDeviations`, the candidate's digest): without it the apply is
  409 `SCHEDULE_CANDIDATE_DEVIATIONS_NOT_ACCEPTED` and writes nothing, and with
  the school's switch turned off again it is 409 `BEST_EFFORT_NOT_ENABLED`
  whatever the digest. **The acceptance is kept in the REGENERATE entry of
  `ScheduleChangeLogs`** (`after`: the accepted list, its digest and the moment;
  who accepted is the entry's own `actorId`), not in a table of its own, so the
  registerutdrag, the removal inventory, the school export and `people-files`
  have nothing new to classify; the accepted list in `after` carries no Users id
  and no name, because no person-removal reaches that JSON by column. The
  candidate's own copy keeps a cap's teacher as a Users id in `subjectIds`,
  server-only and named when the page reads it, as a free-day note does (and
  not at all for a person with a protected identity); **a sentence about a
  part-timer's days is stored in the hidden form for every reader** (the code
  `TEACHER_WORK_DAYS_HIDDEN`, no figure, no post, no teacher, its own English
  and not the refusal's "one of the reasons the timetable could not be made"),
  as every sentence about a post's days is: the figure is HR data and the
  candidate page has no HR path. "Uppdatera förslagen" on a batch of the mode
  keeps the mode (the request names `refreshOf` alone) and is refused 409
  `BEST_EFFORT_NOT_ENABLED` if the school has switched it off since; a refusal
  of a hard rule by the mode's one candidate ends the run
  `CANDIDATES_FIRST_FAILED`, as for any first candidate. The new publish check
  `PUB_DEVIATIONS` reminds the publisher of the accepted list until a
  publication follows the apply (WARN, or REFUSE if the school sets
  `gateDeviations`). It takes ACCESS EXCLUSIVE on `LunchSettings`,
  `PublicationSettings` and `ScheduleCandidates`, NOWAIT and together in a loop
  (the generator reads the first at the start of every run, a publish reads the
  second, the Schemaförslag page polls the third every two seconds while a run
  goes); a refusal gives back whatever it got and tries again 50 ms later, and
  if the three are not free at once in 30 s it stops with nothing changed —
  `prisma migrate resolve --rolled-back
  20270125090000_ett_schemaforslag_kan_saga_vilka_av_skolans_regler_som_gav_vika`,
  then deploy again. Before: the three columns absent from
  `information_schema.columns`. After: the three present, and `SELECT count(*)
  FROM "LunchSettings" WHERE "generatorBestEffort"`, `SELECT count(*) FROM
  "ScheduleCandidates" WHERE "deviations" IS NOT NULL` and `SELECT count(*) FROM
  "PublicationSettings" WHERE "gateDeviations" <> 'WARN'` all 0. No grant and no
  policy moves (RLS sections 410–414 hold it). The API before the release names
  only the old columns, so it keeps working between the migration and the
  deploy: its Skolregler upsert does not name the switch (a save leaves it as it
  was), a candidate it stores has null deviations, and its settings read leaves
  the policy at its default. **Deploy order and the engine:** the engine ships
  with the API from the same merge, additive (`relaxation` is optional in the
  request and `deviations` appears in the answer only when it was asked for), and
  the API sends `relaxation` only for a run the school asked the mode for, so
  nothing changes for a school that has not turned the switch on. In the few
  minutes an API can meet an engine from before the release, a run of the mode
  fails as 503 `ENGINE_LACKS_BEST_EFFORT` ("try again in a few minutes") and
  never as a refusal of the week. **Rolling it back:** the engine before this
  release refuses the field (its request models are `extra="forbid"`: 422), so
  an engine rolled back alone fails the mode's runs of any school that turned
  the switch on; roll the API back first, or with the engine (the API before
  the release never sends it). If the API must stay, turn the switch off for
  every school before the engine goes back (`UPDATE "LunchSettings" SET
  "generatorBestEffort" = false WHERE "generatorBestEffort";`, as the owner), and
  tell the schools it was. **Do not roll the API back while a candidate with
  deviations is on the page**: an API from before the release does not know the
  column and would apply it without the school accepting what gave way. The
  candidates are swept after a week; a school that has not used the mode has
  none. The columns can stay through a rollback.

- **Placeringsregler**: 20270126090000 adds the enum `PlacementRuleMode`
  (`OFF`, `SOFT`, `HARD`) and thirteen columns, all with a default and none
  with a rewrite: on `LunchSettings` (the Skolregler row) the mode and the
  weight of each of three rules (`placementEdgeMode`/`placementEdgeWeight`,
  `placementPlacesMode`/`placementPlacesWeight`,
  `placementSharedMode`/`placementSharedWeight`: OFF, 250) and the four limits
  of the second (`maxClassRoomsPerDay`, `maxTeacherRoomsPerDay`,
  `maxClassBuildingsPerDay`, `maxTeacherBuildingsPerDay`: null);
  on `Subjects` `notFirstInDay` and `notLastInDay`, and on `Rooms`
  `canBeShared` (false). Ten CHECKs, each named `LunchSettings_…_check`: a
  weight is 1 to 1000, a limit 1 to 20 or null (rule 2 is "at most N different room groups and buildings a day", 1 being a single one, not a count of changes), and rule 2 that is on
  has at least one limit (`…_placementPlaces_needs_a_limit_check`; the API
  says so first, a 400 with the code `PLACEMENT_PLACES_NEEDS_A_LIMIT`).
  **Only rule 3 (Delade salar) is offered HARD**: rules 1 and 2 are OFF or
  SOFT until a hard one is measured (a hard rule 1 cost 4.5 times the first
  timetable, a hard rule 2 2.8 to 3.6 times with eight workers, 9 with one,
  against a production limit of 60 s at the floor). The two last CHECKs say
  so (`LunchSettings_placementEdgeMode_off_or_soft_check` and
  `LunchSettings_placementPlacesMode_off_or_soft_check`), because the
  Skolregler row is also written by a school's administrator straight against
  PostgREST and a stored HARD would go to the engine and lock the card; the
  API refuses a request that names HARD for them (400, the codes
  `PLACEMENT_EDGE_HARD_NOT_OFFERED` and `PLACEMENT_PLACES_HARD_NOT_OFFERED`),
  the gateway reads a stored one as SOFT in any case, and the engine still
  builds all six. Offering a hard rule 1 or 2 later is dropping its CHECK, a
  migration of its own, with the card and the API. No new
  table, so no arm, no GRANT and nothing in the role matrix moves (RLS
  sections 415 to 419 hold it, role by role, as the API's role and as
  PostgREST's). **All three rules are OFF for every school until that school
  turns them on**: the migration turns nothing on and changes no row, and an
  OFF rule sends the engine nothing, so the payload, the model and the answer
  are the ones a school without the rules gets, byte for byte. The migration
  takes ACCESS EXCLUSIVE on `LunchSettings`, `Subjects` and `Rooms`, NOWAIT
  and together in a loop (20270125090000, Bästa möjliga schema, takes
  `LunchSettings` the same way and runs first; the two never wait for each
  other) (the generator reads all three, in no fixed order, at
  the start of every run), so it never waits while it holds one; if the three
  are not free at once in 30 s it stops with nothing changed (`prisma migrate
  resolve --rolled-back
  20270126090000_tre_placeringsregler_som_ar_avstangda_tills_skolan_slar_pa_dem`,
  then deploy again). The API before the release names none of the columns: its
  upsert of the Skolregler, its creates and updates of subjects and rooms and
  the CSV import leave them as they are or read the defaults (RLS section
  419). **The order is the migration, then the merge (API and engine from one
  merge), then the web**: a web ahead of the API sends fields the old API
  refuses (400). The engine's new fields are optional and are sent only for a
  school with a rule on, which none has until it turns one on after the
  deploy. The SS12000 providers emit nothing new (a mark moves no `meta.modified`).
  **Rolling back:** the columns can stay, nothing before the release reads
  them. The engine before the release refuses `placementRules`, a room's
  `building` or `shareable` and a lock's `studentCount` (its request models
  are `extra="forbid"`: 422), so once a school has a rule on, an engine rolled
  back alone fails that school's Generera and schemaförslag. Roll the API back
  first, or with the engine; if the API must stay, switch the rules off for
  every school before the engine goes back (`UPDATE "LunchSettings" SET
  "placementEdgeMode" = 'OFF', "placementPlacesMode" = 'OFF',
  "placementSharedMode" = 'OFF' WHERE "placementEdgeMode" <> 'OFF' OR
  "placementPlacesMode" <> 'OFF' OR "placementSharedMode" <> 'OFF';`, as the
  owner) and tell the schools it was. Which schools have a rule on: `SELECT
  "schoolId", "placementEdgeMode", "placementPlacesMode",
  "placementSharedMode" FROM "LunchSettings" WHERE "placementEdgeMode" <> 'OFF'
  OR "placementPlacesMode" <> 'OFF' OR "placementSharedMode" <> 'OFF';`.
  Before the migration the thirteen columns are absent from
  `information_schema.columns`; after it `SELECT count(*) FROM "LunchSettings"
  WHERE "placementEdgeMode" <> 'OFF' OR "placementPlacesMode" <> 'OFF' OR
  "placementSharedMode" <> 'OFF'`, `SELECT count(*) FROM "Subjects" WHERE
  "notFirstInDay" OR "notLastInDay"` and `SELECT count(*) FROM "Rooms" WHERE
  "canBeShared"` are all 0, and so is `SELECT count(*) FROM "LunchSettings"
  WHERE "placementEdgeMode" = 'HARD' OR "placementPlacesMode" = 'HARD'` (the
  two CHECKs keep it so).
- **Klasslärarens schema**: 20270128090000 adds the enums
  `ClassTeacherChangeKind` and `ClassTeacherChangeStatus`, the tables
  `ClassTeacherAppointments`, `ClassTeacherSettings`, `ClassTeacherOpenTimes`
  and `ClassTeacherChanges` (nineteen policies, all `TO app_authenticated`), and
  twenty-one `app.class_teacher_*` / `app.is_class_teacher` functions, every one
  SECURITY DEFINER with a pinned `search_path`: ten the API role may run, nine
  that take the school as an argument and that nobody may run (the entry points
  call them as the owner), and two triggers' guards nobody may call. No existing row is touched, no existing
  table gains a column, nothing reaches the engine, and `gallring_due`,
  `gallring_purge` and `gallring_pseudonymise` are not restated (their
  `md5(prosrc)` are the same before and after). The new keys take `Schools`,
  `AcademicYears`, `StudentGroups`, `Users`, `Rooms`, `MasterLessons` and
  `CalendarLessons` in SHARE ROW EXCLUSIVE, NOWAIT, all at once, in a loop with
  a 30 s ceiling: reads and foreign-key checks go on, writes to those tables
  wait for the file (milliseconds, the new tables are empty), and if the locks
  are not free in 30 s it stops with nothing changed (`prisma migrate resolve
  --rolled-back 20270128090000_en_klasslarare_utses_och_andrar_sin_klass_inom_ramen`,
  then deploy again). The API before the release knows none of the objects, so
  it keeps working between the migration and the deploy. **The migration goes
  in first, then the merge.**
  **Before the migration**, as the owner: `SHOW server_version` is 17.x;
  `prisma migrate status` lists exactly this migration as pending; the file's
  checksum (sha256, what Prisma records) is `177bc639b8de0e1bf01feb4684dd015bafe4bda1a49694ab5637821090dceefa`;
  `SELECT to_regclass('"ClassTeacherChanges"')` is NULL; no session sits idle in
  a transaction that holds one of the seven tables above (the query of the
  Vikariefrågan entry).
  **After it, before the merge:** `SELECT count(*) FROM pg_policies WHERE
  tablename LIKE 'ClassTeacher%'` is 19 and `SELECT count(*) FROM pg_proc WHERE
  pronamespace = 'app'::regnamespace AND (proname LIKE 'class\_teacher\_%' OR
  proname = 'is_class_teacher')` is 21; the four tables have row security on;
  `app_authenticated` holds SELECT, INSERT, UPDATE and DELETE on appointments,
  open times and changes, SELECT, INSERT and UPDATE on the settings, no
  MAINTAIN; `anon` and `authenticated` nothing; `has_function_privilege('anon',
  'app.class_teacher_actor(uuid)', 'EXECUTE')`, the same for `authenticated` and
  `service_role`, are false; every table is empty.
  **What it is.** A teacher is appointed klasslärare of one class by an
  administrator who writes Schemaläggning (`/admin/class-teachers`); a mentor is
  not one. The klasslärare then moves, cancels or changes the room of one
  date's lesson, moves or splits a lesson of the class's grundschema, and sees
  the clashes live, inside a **frame**: the hours the schemaläggare has opened
  (none until some are), never a lesson with another teacher, a block, a half
  class, a replacing group, a shared post, a teacher shared with another school
  or a room lent to or from one, and nothing already past (by the instant: today
  at an hour that has passed is past), covered or with a register, and nothing of
  a läsår that has ended (`YEAR_ENDED`; a date to move a lesson to must lie in
  the class's läsår). The frame is one statement in the database
  (`app.class_teacher_frame`), asked by row security on every write and by the
  gateway first, which names the reason. **What a klasslärare writes is a
  draft** in a table of its own; nothing reaches the timetable until it is
  published, by the schemaläggare (area Publicering) or, when the school has
  switched `selfPublish` on (off until someone does), by the klasslärare for
  their own class. Publication runs the editor's own services
  (`MasterLessonsService.update/create`, `CalendarLessonsService.cancel/
  changeRoom`), as the administrator who made the appointment
  (`app.class_teacher_actor`, only to the klasslärare of the class, the way
  Vikariefrågan places a yes as the sender); an appointment whose administrator
  is removed, deactivated or no longer writes Schemaläggning, Drift and
  Publicering **lapses** (409 `CLASS_TEACHER_APPOINTER_GONE`) until another
  administrator makes it again. Two people at once never overwrite each other:
  a draft carries a hash of the lesson it was written against and a revision,
  and a clash is a 409 that says what changed. **A change is held to the rules
  the editor holds a placement to and to no rules of its own**: the clash rule
  (`MasterLessonsService.findConflicts`) for the template, and for one date the
  same rule held against that date's lessons, and G1's board rules (the stage's
  ramtid, the class's meal, a closure on årskurser: `src/swaps/board-rules.ts`)
  for both. **Publishing is claimed**: of two who publish the same draft at once
  one carries it out (the other is told it is gone). **A change of the template
  in a school that publishes at once** moves the future dated lessons and removes
  the ones that would land in the past or past the template's end; the klasslärare
  is told how many (and how many carry a lesson log) before it is published, and a
  lesson that was moved, or given another room, for its date is met as a clash
  until the date has passed or it is put back, since the change would put it on
  a third day or in the template's room again. **A DRAFT school** (publishMode
  DRAFT) hides its grundschema from teachers; the klasslärare reads their own
  class's through `app.class_teacher_master_lessons`, and the check and the
  preview name a clash with the rest of the draft by its kind alone ("the room is
  taken"), never whose lesson or when. A published template change lands in the
  school's draft like any other grundschema edit, for the schemaläggare's ordinary
  publication.
  **Rollover:** appointments do not carry into the next läsår (a new läsår has
  new classes); the administrator appoints again. An appointment on a läsår that
  has ended is no longer offered (`GET /api/v1/class-teacher/mine`) and every
  change of its classes is refused by the database (`YEAR_ENDED`).
  **After the merge:** `GET /api/v1/class-teachers/settings` answers
  `{"selfPublish": false}`; as a teacher with no appointment `GET
  /api/v1/class-teacher/mine` answers `{"classes": [], "selfPublish": false}`.
  In a test school: appoint a teacher to a class, open Monday 08:00-12:00 for
  every class, and as the teacher cancel a lesson of that class for next
  Monday; it shows under Utkast for the schemaläggare, and publishing it
  cancels the lesson and tells the class. Read the log for `A class teacher
  change was carried out but could not be marked published`.
  **Rolling back the API** leaves four tables and the functions nobody reads;
  the routes answer 404. To remove them (only if the feature is abandoned):
  `DROP TABLE "ClassTeacherChanges", "ClassTeacherOpenTimes",
  "ClassTeacherSettings", "ClassTeacherAppointments"; DROP TYPE
  "ClassTeacherChangeKind", "ClassTeacherChangeStatus";` then drop the functions
  (`SELECT p.oid::regprocedure FROM pg_proc p WHERE p.proname LIKE
  'class\_teacher\_%' OR p.proname = 'is_class_teacher'`) and `prisma migrate
  resolve --rolled-back 20270128090000_en_klasslarare_utses_och_andrar_sin_klass_inom_ramen`.

- **Checklistor** (instruktionsbevis and samtyckeslistor per klass): 20270129090000 adds the
  `RetentionDataType` value `CHECKLISTS` and nothing else (a value cannot be used in the transaction that adds
  it, so it is a file of its own, taking no lock). 20270129091000 adds the tables `InstructionTemplates`,
  `InstructionProofs`, `ConsentLists`, `ConsentEntries` and `ConsentAsks`, the enums `ConsentEntryKind` and
  `ConsentEntrySource`, thirteen functions (all SECURITY DEFINER with a pinned `search_path`: seven the API role
  runs, six the owner's alone, the stamps and the bridge), five stamping triggers on the new tables, one
  statement trigger on `AckReceipts` (`AckReceipts_consent`, AFTER UPDATE with both transition tables: it does
  nothing for a request that belongs to no consent list), nineteen policies for the API role, and
  `app.gallring_due` and `app.gallring_purge` again with the new kind. No existing row is touched and no existing
  table gains a column. The new keys take `Schools`, `Users`, `StudentGroups`, `Subjects`, `AckRequests` and
  `AckReceipts` in SHARE ROW EXCLUSIVE, NOWAIT, together in a loop: reads and foreign-key checks go on, writes to
  those wait for the file, and if all six are not free at once in 30 s it stops with nothing changed (`prisma
  migrate resolve --rolled-back 20270129091000_instruktionsbevis_och_samtyckeslistor_per_klass`, then deploy
  again). The API before the release knows none of the objects and never asks for the new kind, so it keeps
  working between the migration and the deploy; the migrations go in first, then the merge. The gallring
  functions are built on the bodies Elevens lektion för dagen (D7, 20270122091000) left, which are `main`'s and
  production's before this release: the md5 of the bodies is `a7b1da5813d0acf54b1474ad6f96c9c3` (due) and
  `b23e04aec610ebbf1795b832d5054273` (purge) before, and `166943b0d5d22801fe9a1be96a722d95` and
  `2390088f88e967fda35af6d56e63d3f9` after; the difference is the one branch marked `checklistor` in each
  (three tables in `due`, three deletes in `purge`), and D7's `LessonPupilMoves` branch is carried in both. (An
  earlier version of this migration was built on 20270117091000's bodies, `f884a3c7…` and `21746d39…`, and
  would have dropped D7's branch without a git conflict, since the stamp puts this file after D7's; the review
  of #288 found it, `src/gallring/gallring-branches.spec.ts` now fails on any phase that does, and RLS 433 checks the
  branch in the database. **Check `md5(prosrc)` before this migration: it must be D7's.**) `gallring_pseudonymise`
  (`6f18f62fc354bde849aa2e8b01eeceda`) is not touched, on purpose (see the decision below).
  **Nothing changes for a school until someone uses it**: the pages are `/admin/checklists` and
  `/teacher/checklists`, and asking the guardians in the app needs Kvittens (F4) to be on for the school.
  **What is decided, for a conversation with the school:**
  - *A proof is the pupil's, not the class's.* `InstructionProofs` carries a pupil and a template, never a class
    or a group, so it follows the pupil through a change of class and the year rollover (the rollover moves
    `Users.studentGroupId` and nothing else). A tick made in error is voided with a reason and stays; the same
    pupil, template and day is one proof; no role can change or remove one.
  - *"Sparas permanent" means this retention rule* (the new kind `CHECKLISTS` on Dataskydd): proofs and consents
    are kept as long as the pupil is at the school and then as long as the school decides. Until the school
    records a period nothing is purged (the default is "ej beslutat"), and a pupil who is still at the school
    never has anything due, whatever period was chosen: only rows of a pupil who has left (`Users.deactivatedAt`)
    more than that period ago, and consent lists that are older than the period and empty, are removed. An
    instruction proof can be needed for the work-environment responsibility long after the pupil has left, which
    is why the default keeps it. **A proof names its pupil only as long as the pupil is not pseudonymised**, and
    that is the school's separate choice for *Avgångna personer*: a school that wants to be able to show *who* was
    instructed must choose at least as long a period there as for *Checklistor*. The pseudonymisation does not
    touch the proofs (a proof of a pseudonymised pupil stays, without a name), nor the free text staff wrote in
    them: `ConsentEntries.givenBy` (who gave the answer, often a guardian's name) and the two `note` columns stay
    until the rows are purged, so the *Checklistor* period also decides how long a guardian's name is kept
    (granskning #288, LÅG-4; `gallring_pseudonymise` is a third shared function and is left alone); this is
    flagged in the pull request.
  - *A consent is a guardian's.* Staff write it down from a paper, a call or a meeting (who wrote it and when are
    the database's; the date on the paper and who gave it are the writer's), or ask the guardians through Kvittens
    with the rule ALL, which is the only confirmation there is: when the last guardian a request asked has
    confirmed it, a trigger writes the pupil's answer (source `KVITTENS`). Two guardians who confirm at the same
    moment are serialised by a lock of the trigger's own, per request, so the answer is written once, by whichever
    is last. A confirmation that is only "met" because the other guardian's custody ended is *not* written as a
    consent: nobody said yes after it. Nor does the last confirmation undo what staff wrote after the request was
    made: a `WITHDRAWN` or a `DECLINED` newer than the request stays the latest answer (the trigger writes nothing
    for that pupil), and the pupil is granted again only by a request made after it, the school asking again
    (granskning #288, MEDEL-2). An answer is only ever added: a consent taken back is another answer,
    `WITHDRAWN`, and the list shows it at once; what a pupil's consent is now is the latest answer
    (`src/checklists/consent-state.ts`), or "frågad i appen" while a request made after it waits for a guardian.
    The guardians' own withdrawal in the app is not built (a follow-up): until then staff write it down.
  - *Who may do what.* An administrator under Drift manages templates and reads and writes everything of the
    school (the läsare reads and writes nothing). A teacher ticks the pupils in their own groups and lessons of
    the school's active year (`app.checklist_taught_ids`: the lessons where they are teacher or co-teacher, a
    parked lesson excluded, with the lesson's classes, teaching groups and named pupils) and reads those and their
    mentees; consents are written by the mentor (the same mentor definition as Kvittens and the frånvarobevakning).
    Guardians and pupils see nothing here; they confirm in Meddelanden.
  - *Skyddad identitet.* The screen names every pupil the staff member may read, a protected one too, as the
    register does (the staff who ticks has the pupil in their register already, and a consent that is not on the
    page is a consent nobody looked for). The **sheet for paper** (`GET …/roster/print` and `GET …/consent-lists/:id/print`)
    is built by the gateway and holds the marked out: they are not in its rows or counts, `heldOut` says how many, and
    the paper says so. It is the gateway's and not the browser's because a teacher, who prints too, cannot read the
    marks (the register of marks is the administrators'): `app.checklist_protected_ids` tells the gateway, for the
    ids it is given, which are marked (a teacher is told only about the pupils they read, an administrator about any
    pupil of the school), and the gateway passes none of them on. The list of who can have given an instruction
    leaves a colleague with a protected identity out for a teacher, as Skolans dag does for the staff on one screen. There is no export file. The tables are in
    the registerutdrag, in the removal's inventory and so in the whole-school export's person tables.
  Reads that name pupils (a roster, a list, a pupil's card) are recorded in the läslogg as PEOPLE.
- **Förlagda poster** (a day, a time and a room given to a timplanspost before Generera): 20270207090000 adds
  the table `TeachingRequirementPlacements` (keys to its school, its post `(requirementId, schoolId)` ON DELETE
  CASCADE and its room `(roomId, schoolId)` ON DELETE NO ACTION, both ON UPDATE NO ACTION; four named CHECKs:
  Monday to Friday, 15..240 minutes on the five-minute grid, the start on the grid, the lesson inside 08:00-18:00),
  the columns `MasterLessons."fromPlacement"` and `PublishedLessons."fromPlacement"` (boolean, NOT NULL DEFAULT
  false: constant defaults, so neither table is rewritten; the second is what a discarded draft writes back), the function `app.teaching_requirement_placements_fit` (SECURITY DEFINER, pinned `search_path`,
  EXECUTE to nobody) behind three row triggers (SQLSTATE FP409, `REQUIREMENT_PLACEMENTS_DO_NOT_FIT`: the rows of a
  post fit its lengths, lessons, weeks, and it is in no block and, until 20270208090000 below, shares no lessons), and four policies for the API
  role (read for administrators, write under Planering). No existing row is touched. It takes `Schools`,
  `TeachingRequirements`, `TeachingRequirementShares` and `Rooms` in SHARE ROW EXCLUSIVE and `MasterLessons` and
  `PublishedLessons` in ACCESS EXCLUSIVE (the columns; 29 ms of statements on 300 000 lessons), NOWAIT, together in a
  loop: if all six are not free at once in 30 s it stops with nothing changed, and says so: `prisma migrate resolve
  --rolled-back 20270207090000_forlagda_poster`, then deploy again. The API before the release names neither the table nor the
  column, so it keeps working between the migration and the deploy. **The order is the migration, then the merge
  (API and engine from one merge), then the web.** The engine's new key, `placements`, is sent only for a week
  with a förläggning and is read by its explanation alone; an engine older than the key answers 422 to it, and the
  API sends the same request again without it, so the week is laid and only a refusal cannot name the
  förläggningar. **Nothing changes for a school until someone places a lesson** on the Timplan page. A placed lesson
  is written into the grundschema at Generera as a locked lesson marked `fromPlacement`, which the next Generera
  writes again from the post's rows. **Rolling back:** the table and the column can stay. An API rolled back keeps
  a lesson marked `fromPlacement` as the lock it is (its preserved rule asks no flag) and sends no förläggning, so
  those lessons stay where they stand, locked, until someone unlocks them. The checks before and after are
  `forlagd-post-data/prod-fore.sql` and `prod-efter.sql` in the round's notes (one SELECT per check, `public`
  only); E20 ("the migration wrote no rows") holds only right after the migration, before anyone places a lesson.
- **Förlägg delade lektioner** (a förläggning on a timplanspost that shares its lessons between teachers, each one
  a teacher's): 20270208090000 adds `TeachingRequirementPlacements."teacherId"` (nullable; key
  `(teacherId, schoolId)` to Users ON DELETE SET NULL ("teacherId") ON UPDATE NO ACTION, indexed), rewrites
  `app.teaching_requirement_placements_fit` (SHARES gone; NO_TEACHER for a row written naming nobody on a shared
  post; it is now behind two row triggers, the shares' one dropped) and adds
  `app.teaching_requirement_placement_teachers_fit` behind three constraint triggers, DEFERRABLE INITIALLY
  DEFERRED, on the placements, the shares and the post (FP409 TEACHER, TEACHER_LENGTH, TEACHER_PAIRS,
  TEACHER_COUNT: each förläggning on a shared post is a lesson of its teacher's part). Deferred because a writer
  of shares replaces them by a delete and an insert and the förläggning follows in a third statement; the API
  asks for the check at the end of its own write (`SET CONSTRAINTS` by the three names, never ALL), any other
  writer meets it at COMMIT. The migration first refuses, with nothing changed, if any post has both
  förläggningar and shares (20270207090000 kept that invariant). It takes `TeachingRequirementPlacements` and
  `TeachingRequirementShares` in ACCESS EXCLUSIVE and `TeachingRequirements` and `Users` in SHARE ROW EXCLUSIVE,
  NOWAIT, together, with the same 30 s loop: `prisma migrate resolve --rolled-back
  20270208090000_forlagg_delade_lektioner`, then deploy again. No existing row is touched (every stored row is
  NULL on a post that shares nothing, which the new rules accept). **The order is the migration, then the
  merge.** The API before the release writes no `teacherId`; its write of shares on a post with förläggningar,
  which the dropped trigger refused at the INSERT, is refused at its COMMIT instead (an error, not its 409) until
  the new API serves. The engine is unchanged. **Rolling back:** the column and the triggers can stay; an API
  rolled back meets the deferred check at COMMIT when it writes shares on a post with förläggningar, and its own
  placement-fit still refuses to place a shared post. But it does not read the column, and its Generera takes no
  förläggning off a shared post's demand at all (its shares branch never reaches the förläggningar): it locks
  each one as the post's huvudlärare's lesson and still asks the engine for every lesson of the post, so a
  shared post gets one lesson too many for each förlagd lesson, and a share's teacher's förlagd lesson is
  written as the huvudlärare's. **Before rolling the API back, remove the förläggningar on
  shared posts** (`SELECT count(*) FROM "TeachingRequirementPlacements" p WHERE EXISTS (SELECT 1 FROM
  "TeachingRequirementShares" s WHERE s."requirementId" = p."requirementId")` says how many; the post's Förlägg
  dialog removes them), and place them again after the next release. The checks before and after are
  `forlagg-delade-data/prod-fore.sql` and `prod-efter.sql` in the round's notes.
- **Background jobs**: the SS12000 sync, the webhook notices, the push
  receipts and the gallring run on one in-process runner (`src/jobs`).
  `GET /health/ready` adds three counts, never names: how many jobs this
  instance runs, how many failed their last pass, and how many no instance
  has finished a pass of in three intervals. They never make the probe fail.
  Each job's passes are counted per UTC day in `JobRuns` (owner-only).
- **Logs**: the API logs are PII-free by design; ship container stdout to your
  log aggregator. Watch for `Optimization job failed` and Prisma connection
  errors.
- **Scaling**: one API container is fine for a school. Before running
  multiple instances, move throttling and the optimization job store to Redis
  (see improvements below).
- **Key rotation**: Supabase's ES256 signing keys rotate without any action on
  the API — it re-fetches them from the JWKS endpoint by `kid`. Rotating the
  legacy JWT secret invalidates all sessions and requires updating `JWT_SECRET`
  at the same time, but that key now only covers first-party service tokens.
  Rotate the service-role key freely (only the API uses it).
- **The app's memberships and signing** run on their own clocks: the Apple
  membership yearly, the iOS distribution certificate and ad hoc profiles
  after a year, a TestFlight build after 90 days. §15.9 lists them and what
  each stops; an expired ad hoc profile stops internal iPhone builds from
  opening.

## 11. School-account sign-in ("Logga in med skolkonto")

Staff sign in with the account they already have in their organisation's
Microsoft Entra ID or Google Workspace, on the web and in Rastra (Rastra
vårdnadshavare offers no school account, §11.5). Supabase
Auth runs the OAuth flow and links the school account to the **invited**
person by verified e-mail address. Public signups stay off (§1, step 4), so
an address nobody invited gets no account: the invitation is still the gate.

Who may sign in is decided in the database, by the access-token hook
`sign_in.custom_access_token_hook` (migration `20261020090000`). Before Auth
issues any token, at sign-in and at every refresh, the hook:

- refuses a school-account session for a person whose school has not chosen
  school accounts (`sso_not_enabled`);
- refuses a school-account session for a person carrying any school-account
  identity that is not their school's: an Entra identity from another tenant
  (read from the identity's issuer), a Google identity from another Workspace
  or with no `hd`, or a provider the school did not choose
  (`sso_identity_not_allowed`);
- refuses a password, recovery-link or invitation-link session for staff
  (SCHOOL_ADMIN, TEACHER) of a school that requires the school account
  (`sso_required`). A password session that was open when the school turned
  this on ends at its next refresh, within the JWT lifetime (1 hour by
  default);
- refuses a session that signed in some way it does not pin: SAML
  (`sso/saml`, which the Skolfederation phase will pin), a passkey, web3, an
  anonymous sign-in or a method Auth adds later
  (`sign_in_method_not_allowed`);
- refuses the refresh of a school-account session whose sign-in at the
  provider is more than **24 hours** old (`sso_reauth_required`). Auth never
  asks Entra or Google again at a refresh, so without this a person the
  kommun disables in Entra ID or Workspace would keep their Rastra session
  for as long as their app kept refreshing it. With it they are out within a
  day: the next sign-in goes through the provider, which refuses them. For an
  immediate stop, deactivate the person in Rastra as well (People).

Each school sets this up itself on **/admin/integrations → Inloggning**: the
provider, the e-mail domains `/login` offers it for, the organisation (Entra
tenant id or Google Workspace domain), and, separately and off by default,
*Kräv skolkonto för personal*. The gateway guards that switch two ways, on
every save that turns it on or keeps it on:

- it turns on, or stays on through a change of provider or organisation,
  only from a session signed in with a school account of the saved
  organisation, so the provider, the pin and the admin's own account are
  known to work together;
- it is refused (`SIGN_IN_SSO_ONLY_LEAVES_STAFF_OUT`, naming the domains and
  how many staff are on each) while any teacher or admin who can sign in has
  an address on a domain that is not on the row itself. Only the row's own
  domains count: neither the row being replaced nor another school's row,
  since another school may drop, narrow or switch its row at any time with
  nothing to check this one. A school whose staff use a kommun's shared
  domain lists that domain itself, and from then on no school can switch it
  to another provider.

"Who can sign in" is an active teacher or admin whom Rastra has invited
(`"invitedAt"` set), and the admin saving. A catalogue entry nobody invited
has no login to lose and is not counted. The check reads the address
Rastra holds for each person (`"Users".email`), not their login's own, and
runs when the row is saved. So it misses staff invited or reactivated after
the save, and anyone whose address changed in Rastra while their login
kept the old one, which is what an SS12000 e-mail change does until the
person is invited again, before the save as much as after it. Those are
cases for 11.7.

A school may add a domain only if at least one of those staff has an address
on it (`SIGN_IN_DOMAIN_UNUSED`). A domain already on the row with the same
provider is not asked again, so while `SCHOOL_ACCOUNTS` is on the switch can
always be turned off; a change of provider asks about every domain again, so
that a domain nobody uses any more is not kept for the new provider against
the schools whose staff use it with the old one. It may never list or pin a
consumer mail domain such as gmail.com or hotmail.se: the API and a CHECK
refuse them, since a personal account belongs to no school's organisation
and the hook could never let it in. And it may name a domain another school
already names only with the same provider (a kommun's schools often share
one); anything else is refused (`SIGN_IN_DOMAIN_TAKEN`, and the gateway logs
the collision for the operator), because it would leave the other school's
domain with no answer at `/login`, and an SSO-only school's staff with no
way in.

**Decision: one multi-tenant Entra app for every kommun.** Rastra has one
Entra app registration that accepts any organisation's accounts; each
kommun's Entra administrator consents to it, and the hook pins every school
to its own tenant id. The alternative, an app registration per kommun pinned
to that kommun's tenant, needs one Azure provider per tenant, and a Supabase
project has one: it would mean a Supabase project per kommun, or Supabase's
SAML SSO per kommun (a paid add-on, and the route the Skolfederation phase
will take; until that phase pins it, the hook refuses a session that signed
in by SAML).

### 11.1 Deploy order and the switches

Three switches, all off until the setup below is done. Nothing a school or a
person sees changes before the operator turns them on.

| Switch | Where | What it does |
|---|---|---|
| `SCHOOL_ACCOUNTS=on` | API | Lets a school save its row on /admin/integrations → Inloggning. Off, the tab says "Inte påslaget än" and saves nothing (409 `SIGN_IN_NOT_AVAILABLE`); removing a row always works. |
| `NEXT_PUBLIC_SCHOOL_ACCOUNTS=on` | web (build time) | Shows *Logga in med skolkonto* on /login. |
| `EXPO_PUBLIC_SCHOOL_ACCOUNTS=on` | app (build time, in the build's EAS environment, §15.2) | Shows the button in Rastra. Rastra vårdnadshavare never shows it. |

1. Run the migration (§2) **before** the code that uses it is deployed: the
   gateway's `/api/v1/sign-in-method` and `/public/v1/sign-in-methods/:domain`
   read the new table and functions. The migration is additive and changes no
   sign-in by itself. Then, as the owner in the SQL editor, give an
   `"invitedAt"` to every member of staff who has a login but was linked by
   hand rather than invited (the first admin of §7, before §7 set it):

   ```sql
   update "Users" u set "invitedAt" = u."createdAt"
    where u."invitedAt" is null and u.role in ('SCHOOL_ADMIN', 'TEACHER')
      and exists (select 1 from auth.users a where a.id = u."authId");
   ```

   The domain checks (§11) count a login by `"invitedAt"`; without it such
   an admin is counted only when they save the row themselves. Gallring
   counts a login the same way: when it pseudonymises someone who has left,
   it first deletes their login at Auth if `"invitedAt"` is set, and takes
   any other `authId` for a placeholder. So this update also makes gallring
   delete these logins when their time comes, which is what the school's
   retention period asks for: without it a hand-linked person's login, with
   their address and password, would outlive the pseudonymised row. Where a
   school's period for departed people is already in force, its next night
   deletes the logins of those it covers who are already due, as it would
   for anyone invited.
2. Deploy the API and the web with the switches off. The Inloggning tab is
   visible to every school admin from the merge on, and says the feature is
   not turned on yet. The app has nothing to deploy here: its code reaches a
   phone only inside a build (§15.9), which is step 4.
3. Turn the hook on (11.2), then set up the providers (11.3, 11.4) and the
   redirect URLs (11.5). With the providers on and the hook off, anyone
   invited could sign in with any matching school account and nothing would
   be pinned: **never enable a provider without the hook.**
4. Make a new build of Rastra with `EXPO_PUBLIC_SCHOOL_ACCOUNTS=on` in the
   EAS environment it is built from (§15.2), distribute it (§15.7, §15.8)
   and wait until staff have updated. **Only then** go on: once the next
   step lets schools save, an admin can turn on *Kräv skolkonto för
   personal*, and an older build has no school-account button and cannot
   sign staff in at all once their password is refused. The switch's help
   text says so too. The older build itself still starts, and signs in with
   a password while passwords are allowed: the app has no over-the-air
   updates (§15.9), so each build keeps the code it was built with, button
   or no button.
5. Turn `SCHOOL_ACCOUNTS` on (API) and `NEXT_PUBLIC_SCHOOL_ACCOUNTS` on
   (`web/.env.example`), and redeploy the web (the flag is read at build
   time).

Turning `SCHOOL_ACCOUNTS` off again later only stops changes; the rows that
exist keep working, and the lookup keeps answering them. It also stops a
school turning *Kräv skolkonto för personal* off: the switch is disabled on
the tab. A school that wants passwords back then removes its row (*Stäng av
skolkonton*, which puts everyone at the school back on passwords), or an
operator sets `"ssoOnlyForStaff"` to false as in 11.7 ("locked out").

### 11.2 The access-token hook (Supabase dashboard)

1. Authentication → Hooks → *Customize Access Token (JWT) Claims* → type
   *Postgres*, schema `sign_in`, function `custom_access_token_hook` →
   enable. The migration already grants `supabase_auth_admin` USAGE on
   `sign_in` (and on nothing else of Rastra's) and EXECUTE on the hook and
   the two functions it calls, and no API role may execute them; if the
   dashboard offers to apply grants, they are harmless.
2. Check it at once, as a person who has a Rastra profile (a teacher or a
   school admin, not a bootstrap login without one: for such a login the
   hook stops before the code everyone else goes through). Sign in with a
   password and get a token, then refresh once: reload a signed-in page
   after the access token has expired, or call `refreshSession()`. Watch
   Auth's logs for hook errors for a minute before going on. The check that
   the hook refuses staff passwords comes later, in 11.6, once a provider
   and a school row exist.
3. **If that sign-in fails, or Auth's logs show a hook error**, disable the
   hook immediately and turn the Azure and Google providers off in the same
   step. The hook runs before every token Auth issues, so a failing hook
   (a missing grant, a lock held past Auth's two seconds, an Auth release
   that changed the payload) answers 500 to every sign-in and every refresh
   in the project. With the hook off nothing pins school accounts to
   schools, which is why the providers go off with it. With the hook off no
   school's *Kräv skolkonto* is enforced either, so passwords work again.

**Incident: switching school accounts off.** Do these in this order:

1. In the SQL editor as the owner, `UPDATE "SchoolSignInMethods" SET
   "ssoOnlyForStaff" = false;` (every school). Without this, staff of an
   SSO-only school have no way in once the providers are off: the hook
   refuses their passwords.
2. Turn the providers off (Authentication → Sign In / Providers). Leave the
   hook on: without it, school accounts are no longer pinned to schools.

**Migrations once the hook is on.** The hook reads `"Users"` and
`"SchoolSignInMethods"` at every token issuance. A migration that takes a
strong lock on either table (an `ALTER TABLE`, a new index without
`CONCURRENTLY`) queues behind open transactions, and every sign-in and
refresh queues behind it; past Auth's two seconds they all fail. Start such
a migration with `SET lock_timeout = '1s';` and rerun it if it times out,
instead of letting it wait.

### 11.3 Microsoft Entra ID

In the Microsoft Entra admin center of the tenant that owns Rastra's app:

1. App registrations → New registration. Name: **Rastra**, the name a
   kommun's IT department and its staff see when they consent. Supported
   account types: *Accounts in any organizational directory (Any Microsoft
   Entra ID tenant — Multitenant)*, without personal Microsoft accounts.
   Redirect URI (Web): `https://<project-ref>.supabase.co/auth/v1/callback`.
2. Certificates & secrets → New client secret. Note its expiry date and put a
   reminder in the calendar: an expired secret stops every school-account
   sign-in. The secret goes into the Supabase dashboard and nowhere else (not
   into this repository or an `.env` file).
3. Manifest → `optionalClaims`: `email` and `xms_edov` in `idToken`, and
   `xms_edov` in `accessToken` (keep a copy of the manifest before editing).
   `xms_edov` tells Supabase whether the address's domain is verified in the
   user's tenant; without it Supabase may treat an address from a tenant that
   has not verified that domain as verified. The hook's tenant pin is a
   second wall, not a replacement.
4. API permissions: Microsoft Graph, delegated `openid`, `email`, `profile`
   (and the default `User.Read`). Nothing that needs admin consent by itself.
5. Publisher verification (Branding & properties) is recommended: many
   tenants do not let their users consent to an unverified multi-tenant app,
   and then only their administrator can.
6. Supabase dashboard → Authentication → Sign In / Providers → Azure: enable,
   Application (client) ID, the secret's *Value*, and Azure Tenant URL
   `https://login.microsoftonline.com/organizations` (any organisation, no
   personal accounts).

For each kommun (or school) that wants it:

1. Its Entra administrator grants admin consent to Rastra's app, for
   example by opening
   `https://login.microsoftonline.com/<their-tenant-id>/adminconsent?client_id=<Rastra's client id>`.
2. Its staff's addresses in Entra (the `mail` attribute) must be the
   addresses the school invited them with. A person whose Entra address
   differs is told at `/login` that their school account's address was never
   invited. Either the Entra administrator corrects `mail` to the invited
   address, or, for a person who should keep their Entra address, Rastra
   gets that address (from the school's SS12000 source, or from an operator
   as 11.7 describes, since a school admin cannot edit an invited person's
   address) and the school invites the person again. If their existing login
   is their own (11.7 says which logins are), the invitation moves it to the
   new address instead of creating a second one: its password and linked
   school accounts go with it, and the school account links to it at the
   next sign-in. If another login already has the new address, the person is
   given that one and their own login at the old address is deleted. That
   delete is best effort: if it fails, the gateway logs a warning that the
   login "was not deleted", naming the row and the login
   (`[user=…] [authId=…]`), and an operator deletes that login by hand
   (Authentication → Users). Only that warning names a login to delete as it
   stands. The
   others with the same pair (a login "not the row's own" that was left, one
   left with "whose it is not checked", and one "not tagged with its row")
   need the owner found first, as 11.7 describes. A login that is not their
   own is left where it is, and the invitation goes to the new address as to
   someone never invited. Where the school cannot send the invitation, 11.7
   has an operator's manual way.
   Removing the person and adding them again is only for someone with no
   schedule history, since it drops them from their lessons.
3. The school's admin saves the tenant id (Entra admin center → Overview) on
   /admin/integrations → Inloggning.

### 11.4 Google Workspace

1. Google Cloud console → Google Auth Platform → Clients → Create client →
   *Web application*. Authorized JavaScript origins: the web origin.
   Authorized redirect URI: `https://<project-ref>.supabase.co/auth/v1/callback`.
2. Branding: app name **Rastra**, which Google's consent screen shows to
   staff and Workspace administrators. Audience: *External* (several
   Workspaces sign in). Scopes: `openid`, `.../auth/userinfo.email`,
   `.../auth/userinfo.profile`; nothing sensitive, so no security
   assessment, but brand verification takes a few days.
3. Supabase dashboard → Authentication → Sign In / Providers → Google:
   enable, Client ID, Client Secret.
4. Per school: if its Workspace restricts third-party apps, the Workspace
   administrator trusts Rastra's client ID (Security → Access and data
   control → API controls). The school's admin saves the Workspace's primary
   domain (the `hd` Google sends) on Inloggning.

### 11.5 Redirect URLs

Authentication → URL Configuration → Redirect URLs must contain
`https://<web origin>/**` (or `/sv/auth/callback` and `/en/auth/callback`)
and `rastra://auth/callback` for Rastra's production and preview builds.
A project that development builds sign in to also lists
`rastra-dev://auth/callback`, Rastra Dev's own scheme (§15). A redirect
that is not listed fails at Auth, before any provider.

Rastra vårdnadshavare needs no entry. Guardians sign in with a password,
and that app never offers *Logga in med skolkonto*, whatever
`EXPO_PUBLIC_SCHOOL_ACCOUNTS` says, since the EAS environments are shared
with Rastra (§15.2). Remove `schemapro://auth/callback` and
`schemapro-dev://auth/callback` where a project still lists them: nothing
that uses them has been distributed.

### 11.6 Verify (per school)

1. Invite a test member of staff with their real school address; do not open
   the invitation e-mail.
2. On /admin/integrations → Inloggning, save the provider, the domain and the
   organisation. The status reads *På*.
3. Sign out. On /login, type the address and choose *Logga in med skolkonto*.
   The provider's sign-in opens with the address filled in, and you land on
   the role's start page. Repeat once in Rastra.
4. As an admin signed in that way, the card says so; only then can *Kräv
   skolkonto för personal* be switched on (and only once staff have the app
   build from 11.1). Confirm a teacher's password is refused afterwards with
   "Din skola kräver att personal loggar in med skolkonto", and that a
   pupil's still works. This is also the check that the hook refuses staff
   passwords, which 11.2 leaves for here.

### 11.7 Operations

- **Someone is refused with "Kontot du loggade in med hör inte till din
  skolas organisation".** The person carries a school-account identity that
  is not their school's, often a personal Google account or an old tenant's
  Entra account with the same address. The hook refuses every school-account
  session of that person until the foreign identity is removed: Authentication
  → Users → the person → remove that identity, or, as the owner in the SQL
  editor, delete that person's row of that provider in `auth.identities`.
  Their password, if they have one, still works unless the school requires
  the school account.
- **A kommun moves to a new Entra tenant.** Save the new tenant id first.
  Then every member of staff signs in once with the new tenant (a new
  identity is linked by address) and their old-tenant identity is removed as
  above; until it is, the hook refuses them.
- **A member of staff on a domain the school has not listed, while *Kräv
  skolkonto för personal* is on.** The gateway checks the domains when the
  row is saved, against the address Rastra holds for each person, not
  their login's own. So it misses:
  - someone invited after the save, for example with a kommun address;
  - someone the SS12000 sync reactivates after the save;
  - an SS12000 e-mail change the admin applied to an invited person
    (`PERSON_EMAIL_CHANGE_INVITED`), before the save or after it. Rastra
    then shows the new address, but until the school invites the person
    again the login keeps the one they were invited with, and that is the
    address they type at `/login` and the one the school account links by. The check counts the new address, so the
    switch goes on, and the person is refused from their next refresh.

  That person finds no school-account sign-in, or one that does not link,
  and has their password refused. If the domain is the organisation's, the
  school's admin adds it on Inloggning (the save is checked again). A
  personal address such as gmail.com can never be listed: the person needs
  an address in the organisation, and their login has to move to it. The
  address comes from the school's SS12000 source; a school admin cannot edit
  an invited person's address, so at a school without one an operator, as
  the owner in the SQL editor, sets the person's `email` in `"Users"`. Then
  the school's admin sends the invitation again (the envelope on the
  person's row), before requiring the school account. That moves the login
  to the address Rastra holds, with its password and linked school
  accounts: a person who never used the first invitation gets it again at
  the new address, and one who did gets no e-mail and signs in with the new
  address; the admin's receipt says so, and the admin tells them. If another
  login already has that address, the person is given that one and the login
  at the old address is deleted, best effort as in 11.3: a failed delete is
  logged as "was not deleted" with the row and the login, and the operator
  deletes that login by hand.

  The invitation moves or deletes only the person's own login: one an
  invitation created for that person, which carries the row's id in its
  `app_metadata` (`schemaproUserId`), or one without an id (created before
  invitations recorded it) that somebody has signed in with since the
  person was last invited, which is given the id then. Any other login is
  left where it is, for example one the row was given because its address
  already had a login and that nobody has signed in with since, one from an
  invitation sent before this that nobody has used, or the person's own
  older login when they last signed in before the school sent their
  invitation again (that restamps `"invitedAt"`). The invitation then goes
  to the new address as for someone never invited, and the login at the
  old address is logged as "not the row's own", with the row and the login.
  Find out whose it is before deleting it by hand, and likewise for a login
  logged with "whose it is not checked": one that could not be read again
  just before it was to be deleted. To check a login before the admin sends
  the invitation: it is the person's own if its
  `app_metadata.schemaproUserId` (Authentication → Users → the user, or
  `raw_app_meta_data` in `auth.users`) is the person's `"Users".id`, or,
  with no `schemaproUserId`, if its `last_sign_in_at` is later than the
  person's `"Users"."invitedAt"`. To keep the password and linked school
  accounts of a login that is not, move it by hand as below before the
  admin sends the invitation, which then finds it at the new address. If the id cannot be
  written when an invitation creates a login, that is logged as "not tagged
  with its row", with the row and the login, and the login counts as the
  person's only once they have signed in with it.

  Where the school's admin cannot send the invitation, for example
  because no admin can sign in, the operator moves the login by hand
  instead, after setting the address in `"Users"` as above: Auth's admin
  API, `updateUserById`, with the new e-mail confirmed. After an SS12000
  e-mail change the person can sign in with the old address only while the
  old domain is listed and they have not been invited again, and a personal
  domain is never listed. If no admin can sign in, an operator turns the
  switch off as in "locked out" below.
- **A school is told "En annan skola loggar in med en annan inloggning på
  …" (`SIGN_IN_DOMAIN_TAKEN`).** Another school names that domain with the
  other provider. If the domain is really the asking school's, the other
  school's row is wrong: that school's admin removes the domain on
  Inloggning, where the gateway refuses it while that school requires the
  school account and has staff on the domain. If the operator removes it in
  the SQL editor instead, nothing checks that: first make sure that school
  has no staff on the domain, or does not require the school account. No
  other school can depend on that row: a school that requires the school
  account lists its staff's domains itself.
- **The school's staff are locked out** (for example the provider is down
  while *Kräv skolkonto för personal* is on). Admins are staff, so none of
  them can sign in with a password either. An operator turns the switch off
  in the SQL editor as the owner, setting `"ssoOnlyForStaff"` to false on the
  school's row in `"SchoolSignInMethods"`; passwords work from the next
  sign-in. Staff who never chose a password use *Glömt lösenordet?*.
- **Invitations at a school that requires the school account.** The
  invitation e-mail still goes out (it creates the account the school account
  links to). Its set-password link is refused for staff, and
  `/update-password` says to sign in with the school account instead.
- **The Entra client secret expires.** Create the next secret before the old
  one expires, put it in the dashboard, then delete the old one.
- **Many sign in at once from one address.** `/login`'s lookup allows 600
  requests a minute per caller address, and the web and the app remember a
  domain's answer, so a school or a kommun behind one address is not
  throttled the morning it starts requiring the school account. If it ever
  is, people are told to wait a minute, not that sign-in failed.

**Accepted risk: the lookup tells which domains use school accounts.** Anyone
can ask `/public/v1/sign-in-methods/<domain>` and learn whether that domain
signs in with a school account, and with which provider, as with any
home-realm discovery. It names no school, tenant or setting, and the 600 a
minute per address is set for a school signing in at once. The alternative,
a Microsoft and a Google button and no lookup, would put both in front of
every guardian who signs in with a password.

**Accepted risk: the app's custom scheme.** Rastra comes back from the
provider on `rastra://auth/callback`, and any app on the phone can
register that scheme. A malicious app installed on a teacher's phone could
start a school-account sign-in of its own with that redirect and receive the
result, and Entra may sign in silently through the shared browser session.
The fix is a claimed https redirect (Universal Links on iOS, verified App
Links on Android) on the web origin, which needs the app's signing identity
and an `apple-app-site-association` / `assetlinks.json` served by the web.
§15.10 lists what it takes; it waits for the home domain and for the signing
identities the first store uploads create (§15.7, §15.8). Until then the
risk is accepted: it needs a malicious app already installed on a staff
member's phone, and the 24-hour limit above bounds how long a stolen session
lasts. Rastra Dev's `rastra-dev://auth/callback` carries the same risk, on
developers' phones only. Rastra vårdnadshavare has no school-account
sign-in, so it has no redirect of this kind to take.

## 12. Several schools per login ("Flera skolor per inloggning")

A person who works at two schools, or a guardian with children at two, signs
in once and switches school in the web app (the app's switcher follows the
app build). Each school keeps its own `"Users"` row for the person (role,
profile, HR-läs, details); what changed in migration `20261204090000` is that
a login may hold one row per school: the unique key is
`("authId", "schoolId")`.

**Which row a request is.** Every request names its school in the header
`X-School-Id` (the web sends it only for a session with more than one school).
The gateway reads it, and PostgREST hands it to the database as
`request.headers`; `app.current_user_id()` then picks the login's active row
at that school, or, with no school named, the login's active row that took
the login first (`"loginSince"`, which only a trigger writes: a school that
invites the person later never becomes their default). A
school the login has no active row in gives no row at all (the gateway answers
403 `SCHOOL_NOT_AVAILABLE`), never another school. A login with one row, which
is every login before this release, gets the row it always had.

**Which pages ask for the switcher.** The web's server asks the gateway for a
login's schools (`GET /api/v1/me/schools`) only when the login carries the
mark `app_metadata.rastraSeveralSchools`, which the gateway sets when an
invitation links a row to a login another school's row holds, or when the
browser has chosen a school; for at most a second, beside the profile read.
Every other page renders on what it reads from Supabase, as before this
release. A mark the gateway could not write is logged (`A login held at
several schools was not marked`): the person then sees the school their login
came from, without the switcher, until an invitation marks it again. A mark
left on a login that one school holds again costs that question and nothing
else. The route has a rate-limit bucket of its own, 6,000 a minute for the web
server's address and 120 a minute per login.

**How a second school arrives.** A school's admin adds the person with the
address they sign in with and invites them; the invitation finds the existing
login and links the row to it (no mail is sent). Only the gateway's
invitation may give a row a login another row holds: a trigger refuses every
other writer as the old unique index did (23505 on `Users_authId_key`). A
shared login is the person's: no single school's removal, re-invitation or
gallring deletes it or moves it to another address. (Each checks just before
it acts. Two schools acting on one person in the same moment, one inviting
and one removing, can leave the inviting school's row on a login the other
just deleted; inviting the person again gives the row a login.) Two writers
handing one login to rows at two schools at once, without the gateway's
invitation (the older API between the migration and the deploy), wait for each
other on a lock the trigger takes for an invited row, and the second fails as
it did on the old unique index.

**With the access-token hook on (§11.2).** The hook judges each of the
person's active rows under that row's school. If no school lets the session in
it refuses as before; if some do, the token carries
`rastra_closed_schools: {schoolId: reason}` for the others, which the database
and the switcher read, an inactive row's school too. For a person with one
school the token is unchanged. The verdicts are the token's: a row that takes
the login, or is made active, after the token was issued is judged at the
next refresh, within the token's lifetime, as a school turning on *Kräv
skolkonto för personal* already is (§11).

A school-account session is still judged on every school-account identity
the login carries (§11: the hook cannot tell which one signed in). A person
whose schools sign in with different organisations (two Entra tenants, or
Entra and Google) and who has linked both is therefore refused a
school-account sign-in at every school, as a person with an identity from
elsewhere always was (11.7): remove the identity they do not use, or let them
sign in with a password where their schools allow it. Relaxing this would let
a sign-in through one organisation into a school that requires another.

### 12.1 Deploy order

1. Run the migration before the code (§2). It locks `"Users"` with a NOWAIT
   retry for at most 30 s and changes no data. If it gives up, nothing changed:
   `prisma migrate resolve --rolled-back 20261204090000_en_inloggning_kan_ha_flera_skolor`
   and deploy again. The API before this release keeps working on the new
   schema.
2. Deploy the API and the web of the release together. The API's CORS list
   allows `X-School-Id`.
3. Check once that the Supabase API passes the header from a browser (the web
   sends it to PostgREST only for a session with more than one school, so a
   refusal here touches nobody else):

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' -X OPTIONS \
     "https://<ref>.supabase.co/rest/v1/Users" \
     -H "Origin: https://<web origin>" \
     -H "Access-Control-Request-Method: GET" \
     -H "Access-Control-Request-Headers: authorization, apikey, x-client-info, x-school-id" -D - \
     | grep -i 'access-control-allow-headers'
   ```

   The answer must name `x-school-id` (or `*`). If it does not, multi-school
   sessions would fail their direct reads: say so before any school invites a
   person who already has a login.

### 12.2 Operations

- **Which logins have more than one school** (as the owner):
  `SELECT "authId", count(*) FROM "Users" GROUP BY 1 HAVING count(*) > 1;`
- **A rollback past this release** once such logins exist: the older API
  deletes a login when one school removes or re-invites its row, which ends
  the person's access at the other schools too. List the shared logins first,
  and do not remove or re-invite those people until the release is back.
- **Somebody sees the wrong school's start page.** The browser remembers its
  school in the cookie `rastra_school`; signing out does not clear it, and a
  school the login can no longer use falls back to its first school by
  itself. Clearing the site's cookies resets it.
- **Somebody with two schools has no switcher.** Their login lacks the mark
  (the gateway's log names it). Invite the person again from either school,
  which marks the login; nothing else about the rows changes.

## 13. Replacing groups ("Ersättande grupper")

A teaching group can replace a subject for its pupils (SvA7 replaces
Svenska): its members leave the class's lessons in that subject. The
migration `20261211090000_en_ersattande_grupp_tar_sina_elever_fran_klassens_lektion`
adds the column, narrows three of the pupil's arms on CalendarLessons, adds
the guardian's arm on StudentGroups and replaces the pupil's calendar feed.
The engine takes two new optional fields, `AnonymousRequirement.pupilGroupId`
and `FixedLesson.pupilGroupIds`.

### 13.1 Deploy order

1. Run the migration before the merge (section 2). The API before this
   release works with it: it never reads the column, and no group is marked
   until the new group dialog marks one.
2. Merge. The API and the engine deploy from `main` within about two
   minutes of each other. A school that marks a group in that window may see
   one run refused, as below.
3. Verify that `https://<solver-host>/openapi.json` names `pupilGroupId`.

### 13.2 Rolling back

- **The engine alone, past this release.** Its request models forbid
  unknown fields (`extra="forbid"`), so an older engine answers 422 to every
  run whose payload carries `pupilGroupId` or `pupilGroupIds`: every run of a
  school with at least one replacing group, and only those. Generera fails
  with the engine's 422, and a schemaförslag run fails the same way. Every
  other school's payload is byte for byte what it was before the release,
  and its runs are unaffected. Redeploy the engine, or roll the API back
  with it.
- **The API, past this release, with the database still migrated.** The
  older API does not read the column. Its class lists, notices, family week,
  timplan and generator treat a replacing group's pupils as on the class's
  lessons again. The pupil's own week and the calendar feeds, which the
  database answers, still leave them off. Until the release is back, those
  schools see the two disagree. Nothing is written wrongly: attendance can
  be recorded for either list.
- **Which schools are affected** (as the owner):
  `SELECT "schoolId", count(*) FROM "StudentGroups" WHERE "replacesSubjectId" IS NOT NULL GROUP BY 1;`

## 14. A huvudman owns schools ("Huvudman")

A huvudman (a kommun, or a friskola's owner) owns schools, and its people
read each school it owns: a **kommunadministratör** keeps the huvudman's
members, its schools and its SS12000 keys, and **planerare** (central
planners) read. Both read every school the huvudman owns as that school's
*läsare* (Läsbehörighet): every area, and nothing written, nothing decided,
no HR-läs. They get no `"Users"` row at the schools: a school's register,
its SS12000 export, its notices and its gallring know nothing of them.

**How a school is read.** The request names the school (`X-School-Id`, §12).
Where the login has no active row of its own there and its huvudman owns the
school, the database answers for the huvudman's reader: three of the six
helpers (`app.current_school_id`, `current_user_role`, `current_user_may`)
have a second branch for it, and `app.current_user_id()` is NULL, as for
anybody without a row, so nothing keyed on the caller's own row is theirs.
The gateway refuses the reader every write but the huvudman's own routes
(403 `HUVUDMAN_READS_ONLY`), and a member with no school named reaches only
`/api/v1/huvudman/*` and `/api/v1/me/*` (403 `HUVUDMAN_NO_SCHOOL`). An own
active row wins: a planner who is a teacher at a school is the teacher there.
A row the school has deactivated does not: the member reads the school as
the huvudman's reader, since the school took the huvudman, and Dataskydd
shows which of the huvudman's people have a row of their own there. Each read of personal data is written in the
school's own read log, naming the member (and, for the key, the huvudman's
key); the school's deciders read it under Dataskydd as they read the others.

**Ownership takes both sides.** The kommunadministratör asks for a school by
its slug on `/huvudman`; the school's rektor or a full administrator answers
under Dataskydd. Either side ends it, at once. A school has one huvudman.

**With the access-token hook on (§11.2).** The hook judges each school a
membership reaches under that school's rules, as staff, also where the login
has a row of its own: a school that requires its school account is closed
for a planner's password session as for its own staff. The verdict is the
reader's alone (`rastra_closed_schools` names it `reader:<schoolId>`), so a
guardian who is also a planner keeps their own guardian row there.

**A member's login is held.** The invitation finds the login an address
already has, so a teacher's login can also be a member's. A school that
removes its row, and gallring, leave such a login alone, as they leave a
login another school's row holds (§12).

**The huvudman's SS12000 key** (`sh_…`, made on `/huvudman`) reads every
school the huvudman owns through `/ss12000/v2.0`, one school at a time, as
that school's service principal (`app.huvudman_key_opens_school`, which the
database refuses for a school the huvudman does not own). Read scopes only:
no attendance or absence, no subscriptions, nothing of v1; the database
holds the key to the huvudman's schools on its own and lets it write
nothing (20261212090300). A school's own keys are
unchanged; the school's deciders see the huvudman's keys under Dataskydd and
Integrationer and their reads in the read log. See docs/integration-api.md.

### 14.1 Deploy order

0. Before the series, look for autovacuum, as the owner:
   `SELECT relid::regclass, phase FROM pg_stat_progress_vacuum;`. The
   three loops below take no turn behind it: a NOWAIT lock never waits, so
   it never asks an autovacuum to give way, and one still running on a
   table a loop locks makes that migration give up after 30 s. That is
   `"Users"` and `"Schools"` for the first, `"PersonalDataAccess"` for the
   second, and the arms' 30 tables (`"Users"` and `"GuardianStudents"` the
   large ones) for the fourth. If any of them is listed, deploy when it is
   done.
1. Run the four migrations before the code (§2):
   `20261212090000_en_huvudman_ager_skolor`,
   `20261212090100_lasloggen_namner_huvudmannens_lasare`,
   `20261212090200_huvudmannens_villkor_i_lasloggen_valideras` and
   `20261212090300_tjanstearmarna_provar_huvudmannens_nyckel`. The first,
   second and fourth take their locks NOWAIT in a retry loop for at most
   30 s and change no data; if one gives up, nothing changed: `prisma
   migrate resolve --rolled-back <name>` and deploy again. The fourth makes
   `app.current_service_school_id()` check, for a huvudman's key, that the
   huvudman owns the school, rewrites the 36 service arms to call it once
   per statement, and closes the four that write to a huvudman's key: it
   holds ACCESS EXCLUSIVE on the arms' 30 tables for the catalogue changes
   only (milliseconds); run it outside the SS12000 sync's window. The third validates two foreign keys and a CHECK on the read log,
   blocking no read and no write (5 s lock_timeout: if it stops, run it
   again). The API before this release keeps working on the new schema: no
   huvudman exists until one is made.
2. Deploy the API and the web of the release together.
3. Only then make the first huvudman (14.2).

### 14.2 Bootstrap a huvudman and its kommunadministratör

As for a school (§7), there is no public signup. Create the auth user in the
Supabase dashboard (Authentication → Users → *Send invitation*), copy its
UUID, and as the owner:

```sql
insert into "Huvudmen" (name, "organisationNumber", "municipalityCode")
values ('Exempelkommun', '2120000001', '0884');

insert into "HuvudmanMembers" ("huvudmanId", "authId", email, "firstName", "lastName", role, "invitedAt")
values (
  (select id from "Huvudmen" where "organisationNumber" = '2120000001'),
  '<AUTH_USER_UUID>', '<same email as the auth user>', 'Karin', 'Kommun',
  'KOMMUNADMINISTRATOR', now()
);
```

The login needs no mark by hand. A login with no row at any school asks the
gateway for its schools, finds the huvudman's and is sent to `/huvudman`,
and the gateway marks it there (`rastraHuvudman`, `rastraSeveralSchools` in
its app metadata) from the next token on; the school switcher asks the
gateway itself as well. Members the kommunadministratör invites from
`/huvudman` are marked when invited, and again if they are invited a second
time, in case a mark was lost. Marking a login by hand (Authentication →
Users → the user → *Raw app meta data*) only saves its first page a request.

### 14.3 Operations

- **Which schools a huvudman owns** (as the owner):
  `SELECT h.name, s.name FROM "HuvudmanSchools" hs JOIN "Huvudmen" h ON h.id = hs."huvudmanId" JOIN "Schools" s ON s.id = hs."schoolId";`
- **A school must stop being read now** (a decider is not reachable): delete
  its `"HuvudmanSchools"` row as the owner; its huvudman's people and keys
  read nothing there from the next statement.
- **A rollback past this release**: delete the `"HuvudmanSchools"` rows
  first, so that no reader is left that the older code would not know.
- **A member who should no longer read**: the kommunadministratör
  deactivates them on `/huvudman`; their login stays (it may be a school's
  too). The huvudman keeps at least one active kommunadministratör.
- **Deleting a member, a key or a huvudman** (as the owner; the product
  only deactivates and revokes): the read log's rows that name them keep
  the read and lose the name (`ON DELETE SET NULL`), and the log has no
  index on `"huvudmanMemberId"` or `"huvudmanApiKeyId"`, so each deletion
  reads the whole log under the deleted row's lock. Deactivate or revoke
  instead; if a row must go, delete it outside school hours, and read the
  school's log first if the name should be kept.

---

# Future improvements

Roughly ordered by expected value for a real school.

**Product**
1. ~~**Timetable adjustments**~~ — ✅ done: lessons on the master-timetable
   review page open an edit dialog (day/time/room/teacher) backed by
   `PATCH /api/v1/master-lessons/:id` with conflict validation; future
   published lessons without attendance move along automatically. A full
   drag-and-drop interaction remains a nice-to-have on top.
2. ~~**Real-time schedule updates**~~ — ✅ done: a Socket.IO gateway in
   NestJS (`src/realtime/`) authenticates via the Supabase JWT handshake and
   emits `calendar_lesson_updated` to school/user rooms; lesson cancel /
   reinstate / substitute actions broadcast automatically.
3. ~~**Substitute management**~~ — ✅ done: the admin **Day planner** page
   cancels/reinstates lessons and assigns substitutes per lesson via
   `PATCH /api/v1/calendar-lessons/:id/{cancel,reinstate,substitute}`.
4. **Holiday calendar** — a first-class school-holidays entity instead of the
   current mechanism (full-day group `UNAVAILABLE` constraints), plus term
   date ranges when publishing.
5. **Reports & exports** — ✅ partially done: the admin **Reports** page shows
   attendance rates per class/student for a period with CSV export. Still
   open: printable timetables (PDF) and school-wide trend reports.
6. **Notifications** — email/push for schedule changes, unrecorded
   attendance, and repeated student absences (guardian notifications).
7. **Guardian role** — parents viewing their child's schedule and attendance;
   requires a guardianship relation and new RLS policies.
8. **SIS import** — CSV/Excel import for students, teachers and groups so
   onboarding doesn't require manual entry.
9. **Incremental re-optimization** — re-solve with the existing timetable as
   a warm start and "minimal changes" as an objective, instead of full
   regeneration.
10. **More locales** — the i18n plumbing supports it; each language is one
    message catalog in `web/messages/`.

**Engineering**
11. ~~**CI pipeline**~~ — ✅ done: `.github/workflows/ci.yml` runs API
    typecheck + e2e, web typecheck + build, solver pytest, and mobile
    typecheck, unit tests and a Metro bundle on every push/PR. It never
    builds the app: builds run on EAS or with `eas build --local` (§15).
12. **Durable job queue** — move optimization jobs from the in-memory map to
    Redis/BullMQ or a `OptimizationJobs` table; prerequisite for horizontal
    scaling and job history.
13. **Redis-backed throttling** — the ThrottlerModule is already wired for
    it (`REDIS_URL`), just needs the storage package enabled.
14. **Seeded staging environment** — ✅ partially done: `npm run db:seed`
    creates a demo school (subjects, rooms, classes, 8 teachers, 80 students,
    full curriculum) via `prisma/seed.ts`; run with owner credentials
    (`DIRECT_URL`). Still open: authenticated Playwright tests on top of it.
15. **Audit log** — append-only record of admin mutations (who changed what,
    when) — often a procurement requirement for schools.
16. **Observability** — OpenTelemetry traces across web → API → solver,
    plus solver run metrics (solve time, conflict counts).
17. ~~**Asymmetric JWT verification**~~ — done: Supabase access tokens are
    verified as ES256 against the project's JWKS, keyed by the token's `kid`.
    `JWT_SECRET` survives only for first-party service tokens (scripts/bench);
    retiring those would let the API hold no signing secret at all.
18. **Mobile hardening** — retire the legacy `secureTokenStore` profile cache
    in favor of the Supabase session as the single source of truth, add
    certificate pinning, and add Detox tests for the offline queue.

## 15. Building and distributing the apps (EAS)

The apps reach a phone only as builds. Builds are made by EAS Build, Expo's
build service, from `mobile/`, or on a Mac with `eas build --local`, and
never on GitHub Actions: CI typechecks, tests and bundles the app (the
mobile job in `.github/workflows/ci.yml`) and builds nothing. Nothing has
been distributed yet. This section goes from no accounts to an internal
build on a phone, push on a real device and the stores' internal tracks; the
store listings, review and a public release belong to the stores phase.

**Two apps from one code base.** Every account has one role, and each app
admits only its own:

- **Rastra**, for staff and pupils: TEACHER, SCHOOL_ADMIN (every admin
  profile) and STUDENT.
- **Rastra vårdnadshavare**, for guardians: GUARDIAN.

Any other role is admitted by neither. A sign-in in the wrong app is refused
on the login screen, with a message in Swedish (English in the English
localisation) that names the right app. A session restored at start whose
role is the other app's is ended on this device only: the same person's
session in the other app and on the web goes on, the device's push
registration is removed, and the offline attendance queue is kept. The check
reads the role cached on the device, so an offline start needs no network.
It is the app's own check, not a security boundary: the gateway cannot tell
the two apps apart, and RBAC and RLS decide what a role reads in either.

Two variables choose the build: `APP` (`rastra` or `vardnadshavare`) and
`APP_VARIANT` (`development`, `preview` or `production`). `mobile/eas.json`
has a build profile for each pair, named after both. Each sets the two in
its `env` and takes its other variables from the EAS environment of its
variant, and `mobile/app.config.ts` applies them on top of `app.json`:

| Profile | Name under the icon | Bundle id and package | Scheme | Distribution |
| --- | --- | --- | --- | --- |
| `rastra-development` | Rastra Dev | `se.rastra.app.dev` | `rastra-dev` | internal: a development client that loads its JavaScript from a developer's `npm start` |
| `rastra-preview` | Rastra Test | `se.rastra.app` | `rastra` | internal: ad hoc on an iPhone, an APK on Android |
| `rastra-production` | Rastra | `se.rastra.app` | `rastra` | store: TestFlight and Play's internal track |
| `vardnadshavare-development` | Rastra vårdnadshavare Dev | `se.rastra.vardnadshavare.dev` | `rastra-vardnadshavare-dev` | internal: a development client served by `npm run start:vardnadshavare` |
| `vardnadshavare-preview` | Rastra vårdnadshavare Test | `se.rastra.vardnadshavare` | `rastra-vardnadshavare` | internal: ad hoc on an iPhone, an APK on Android |
| `vardnadshavare-production` | Rastra vårdnadshavare | `se.rastra.vardnadshavare` | `rastra-vardnadshavare` | store: TestFlight and Play's internal track |

There is no bare `development`, `preview` or `production` build profile,
so `eas build` without `--profile` stops instead of guessing an app. `eas
submit` does not stop: without `--profile` it falls back to EAS's default
submit profile, or to the one named after the chosen build's profile. So
always pass `--profile` to `eas submit`, or submit with the build's
`--auto-submit`. Each submit profile names its app's bundle id, package and
store name itself, because a standalone `eas submit` reads the app config
without the build profile's `APP` and would otherwise see Rastra's
(`mobile/src/config/easProfiles.test.ts` keeps the two in step).

Within one app, preview and production share an identity on purpose: one
Firebase Android app, one Apple App ID, one set of push credentials and one
build-number counter. The cost is that they cannot sit side by side: a
preview build takes the production app's place on the phone (§15.4 has
Android's catch). Development has an id of its own, so that a developer's
client can sit beside either. The two apps share none of this: each has its
own ids, credentials, build counter and store records, and both can be
installed on one phone. On an iPhone's home screen "Rastra vårdnadshavare"
and its Test and Dev forms are all cut to about "Rastra vård…", so there the
name does not tell the guardian app's development build from the build
beside it.

`APP_VARIANT` unset means production and `APP` unset means `rastra`, so
`expo export`, CI and anything else that does not ask build exactly what
`app.json` describes: Rastra's production identity. An unknown value of
either stops the build, and so does an unset `APP` on the EAS builder
(§15.2 item 4).

**One EAS project for both apps**, slug `rastra`, with four application ids.
The gateway sends a school's pushes to Expo together, up to 100 tokens a
request, so a class's pupils and guardians share a request. Expo refuses a
request whose tokens belong to different projects, and the gateway does not
retry a refused request (a 4xx), so with a project per app whole chunks of a
school's pushes would fail. Within one project Expo routes each token to its
own app's credentials, and the gateway needs no change. One project also
means one set of EAS environments for both apps (§15.2) and one project id,
which `eas init` writes into `app.json`. Build numbers are kept per
application id, so each app still has its own counter (§15.9).

Build from a clean checkout of a commit that is on GitHub, and note the
commit in the build log (§15.9). EAS uploads the working tree as it is on
disk, untracked files included, minus what `.gitignore` excludes.

A tester's internal SchemaPro build (`com.schemapro.teacher`, from before
the rename) is a different app, and Rastra cannot see its session or its
offline attendance queue. Let that queue empty before uninstalling it.

### 15.1 Accounts and lead times

Start these on day one. Apple and Google verify the organisation, which
takes days to weeks, and every iPhone build waits for Apple; only the
Android APK of §15.4 can be made before.

1. **Expo.** An organisation on expo.dev owns the EAS project, the one both
   apps belong to (§15), with at least two members, so that the project
   does not hang on one person's account, and two-factor authentication for
   each. EAS Build works on the free plan, with a limited monthly allowance
   and a slower queue.
2. **Apple Developer Program, as an organisation** (99 USD a membership
   year; accredited educational institutions, nonprofits and government
   entities can ask for a fee waiver). Apple wants a legal entity (not a
   trade name), its D-U-N-S number (government entities excepted), an
   enrolling person with the authority to bind it, and a public website and
   a work e-mail address on the organisation's own domain. Enrolled as an
   individual instead, the person's legal name is shown as the seller. One
   membership holds both apps. Even an ad hoc build for one iPhone needs the
   paid membership. The home domain is undecided (PRODUCT.md), and Apple
   checks the website and the e-mail address against it, so it is decided
   before this enrolment.
3. **Google Play Console, as an organisation** (a one-time registration
   fee). An organisation account needs a D-U-N-S number too; Dun & Bradstreet
   issues one free, and Google says to allow up to 30 days. Google's rule
   that a new account runs a closed test with 12 testers for 14 days before
   production is written for personal accounts, and internal testing
   (§15.8) is not affected either way. One account holds both apps.
4. **Firebase.** One project for push on Android (FCM, to which Expo hands
   every Android push), with four Android apps: `se.rastra.app` (Rastra's
   production and preview), `se.rastra.app.dev` (Rastra Dev),
   `se.rastra.vardnadshavare` (Rastra vårdnadshavare's production and
   preview) and `se.rastra.vardnadshavare.dev` (Rastra vårdnadshavare Dev).
5. **The Expo data processing agreement**, before a push reaches a real
   user (§8.1 step 1). Internal builds against a test stack (§15.6) hold no
   pupil's or staff member's records and do not wait for it. The testers'
   own push tokens and iPhone device ids still pass through Expo and Apple
   (§15.5, §15.6), so the testers are staff or developers who have agreed to
   that.
6. **The store names.** An App Store name must be unique in the store.
   Check that "Rastra" and "Rastra vårdnadshavare" are free in the App Store
   and on Google Play before the first uploads (§15.7, §15.8), which also
   fix the ids for good.

Each account belongs to the organisation, and its sign-ins live in the
password manager, never in this repository: the repository is public.

### 15.2 The EAS project, environments and profiles

1. **The CLI is the npm package `eas-cli`.** `npx eas …` runs an unrelated
   package called `eas` and builds nothing. Install a pinned version
   globally, `npm install -g eas-cli@25.1.1` (`mobile/eas.json` asks for
   `>= 24.0.0`, and the CLI needs Node 20.18.3 or later). Not as `npx
   eas-cli@…` in `mobile/`: `mobile/.npmrc` makes npm there refuse a version
   published less than seven days ago, and a global install does not read
   it (a local build needs one more step, item 4). Then `eas login` with your own Expo account, a member of the
   organisation, and check it with `eas whoami`. Every `eas` command runs in
   `mobile/`.
2. **Link the project, once:** `eas init --account <the Expo organisation>`.
   It creates the project on expo.dev and writes its id and owner into
   `app.json` (`extra.eas.projectId`, `owner`). `app.config.ts` passes
   `app.json` through, which is what lets the CLI write the static file.
   The CLI writes the whole evaluated `extra`, so `app.json` also gains
   `extra.app` (Rastra's identity) and `extra.router`: delete those two,
   which `app.config.ts` and expo-router add on every evaluation anyway,
   and commit the rest. Both apps belong to this one project (§15), so it runs
   once, not once per app, and all six builds carry the same id. The id is
   an identifier, not a secret, and each app asks Expo for its push token
   with it: a build made without it says "Den här versionen av appen kan
   inte ta emot pushnotiser." when push is turned on. The slug, `rastra`, is
   the project's name on EAS. It is fixed once `eas init` has created the
   project (none exists yet), since the CLI refuses an app config whose
   slug is not the project's. Anyone who builds later finds the id in the
   repository and does not run `eas init` again.
3. **The environments.** EAS has three, `development`, `preview` and
   `production`, and both apps share them: each profile names the
   environment of its variant, so `rastra-preview` and
   `vardnadshavare-preview` both take the preview environment's variables.
   The two apps talk to the same API and Supabase project, so no value
   differs between them; one that ever must goes in the profiles' `env` in
   `eas.json`, which wins over the environment. Set §8's values in each
   environment, for example:

   ```bash
   eas env:set --name EXPO_PUBLIC_API_BASE_URL --value https://api.yourschool.example \
     --environment preview --visibility plaintext
   eas env:list --environment preview
   ```

   Set them as plain text or sensitive, **never secret**. They are compiled
   into the app, where anyone who has it can read them, so "secret" protects
   nothing and only hides the value from the CLI and from `eas env:pull`.

   On EAS, a preview or production build stops while it reads the app
   config, before anything is compiled, unless its environment has
   `EXPO_PUBLIC_API_BASE_URL`, `EXPO_PUBLIC_SUPABASE_URL` and
   `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, and for Android also
   `GOOGLE_SERVICES_JSON` (§15.3): without them it would install and then
   fail at the sign-in screen, or never receive a push. The error names what
   is missing. A development build is not checked. Its JavaScript comes from
   the developer's own `npm start`, which reads `mobile/.env.local`;
   `eas env:pull --environment development` writes one from the development
   environment, replacing the file that is there. `.env.local` never reaches
   EAS: it is gitignored.

   Which deployment each environment points at is the operator's choice.
   The preview environment decides it for every internal build at once:
   point it at a test stack (§15.6) while push is tried, since production
   keeps push off until §8.1 step 1.
4. **The profiles** are the table above (§15). `APP` and `APP_VARIANT` are
   set in each profile's `env` in `eas.json`, which wins over a variable of
   that name in the environment, and every command names its profile. On
   the builder (EAS's machines, and `eas build --local`) every build, of
   any variant, stops while it reads the app config:
   - when `APP` is unset or unknown. Unset means Rastra everywhere else, but
     a profile that forgot it would build Rastra whatever its name says, and
     the first store upload fixes an id for good (§15.7, §15.8);
   - when `app.json`'s base identity (`ios.bundleIdentifier`,
     `android.package`) is not exactly `se.rastra.app`. `app.config.ts`
     derives every other id from it, so another id there means something
     wrote an evaluated config back into `app.json`, and every build from it
     would be signed as the wrong app. Restore it with `git checkout
     mobile/app.json`.

   EAS installs the dependencies with a plain `npm ci`:
   `mobile/.npmrc` makes it resolve peers as CI does (`legacy-peer-deps`),
   and the `eas-build-pre-install` script in `mobile/package.json` first
   installs npm 11, which wrote the lockfile and which CI pins, whatever npm
   the build image ships. It does so only on EAS's own machines. `eas build
   --local` installs with the npm of the machine it runs on, which should be
   npm 11 as in §8. Run it as `NPM_CONFIG_MIN_RELEASE_AGE=0 eas build -p
   <platform> --profile <profile> --local`, with one of the six profiles
   (for example `--profile vardnadshavare-preview`). eas-cli fetches its
   local build plugin with `npx`, at its own exact version and in
   `mobile/`, where `mobile/.npmrc` refuses a version published less than
   seven days ago. The
   variable lifts that rule for this one command, as Expo's own build tools
   do for their `npx` calls. The plugin's `npm ci` still installs the
   lockfile exactly as it is. Versions and build numbers are §15.9.
5. **The development scripts** in `mobile/package.json` choose the app the
   same way. `npm start` serves Rastra Dev (`APP=rastra
   APP_VARIANT=development expo start --scheme exp+rastra`), and `npm run
   start:vardnadshavare` serves Rastra vårdnadshavare Dev
   (`APP=vardnadshavare`, the same variant, and `expo start --scheme
   rastra-vardnadshavare-dev`). Both name their QR code's scheme, so that a
   `mobile/ios` or `mobile/android` left over from the other app cannot
   choose it. `npm run
   ios` and `npm run android` build and run Rastra Dev locally, and `npm run
   ios:vardnadshavare` and `npm run android:vardnadshavare` the guardian
   one. A development build takes its app config from the server it loads
   from, so a guardian development client is served by
   `start:vardnadshavare` only: served by `npm start`, it believes it is
   Rastra, refuses every guardian and ends a guardian session it had
   restored (sign in again once it is served right). `npm run ios` and the
   other run scripts generate `mobile/ios` or `mobile/android` only when it
   is missing, so delete both before switching a local build to the other
   app. The two development clients cannot
   share the scheme `expo start`'s QR code opens (`exp+rastra`, from the one
   slug), so only Rastra Dev registers it, and the guardian script points
   its QR code at Rastra vårdnadshavare Dev's own scheme instead.

`mobile/ios` and `mobile/android` are generated for each build and are
gitignored (`mobile/.gitignore`). Committed, they would make EAS treat the
app as a bare native project and stop applying `app.config.ts`: the
variants, the Swedish permission texts and the icons would be gone from the
build. `npm run ios` and `npm run android` generate them locally, where they
do no harm.

### 15.3 Credentials

Signing and push credentials live in EAS (`eas credentials`, or the
project's Credentials page on expo.dev) and, where a copy is kept, in the
password manager. None goes in the repository: it is public.
`mobile/.gitignore` keeps out the usual files (`google-services.json`, the
Firebase service-account key, `credentials.json`, keystores, `.p8` and
`.p12` files and provisioning profiles); read `git status` all the same
before the first commit after a credentials session.

EAS keeps credentials per application id, and the two apps have four:
`se.rastra.app` and `se.rastra.vardnadshavare` (each app's preview and
production builds), and `se.rastra.app.dev` and
`se.rastra.vardnadshavare.dev` (the development builds). Signing and push
are set up per id, so four times; the APNs and FCM keys themselves belong to
the account, and the same key is chosen for each id.

**iOS: EAS manages it.** At the first `eas build -p ios` of a profile, sign
in with the Apple account when the CLI asks. EAS then:

- registers the profile's App ID, with the push capability, since
  `expo-notifications` puts the `aps-environment` entitlement in every
  build. That makes four App IDs in all, one per bundle id;
- creates a distribution certificate (Apple allows two per account; each
  lasts a year; one serves both apps) and a provisioning profile per bundle
  id and kind: ad hoc, listing the registered iPhones, for development and
  preview, and App Store for production, six in all;
- asks whether to set up push notifications. Answer yes: it creates an APNs
  key or reuses the account's. One key serves every bundle id of the team,
  in both of Apple's push environments, and does not expire; Apple allows
  two per account. EAS asks once per bundle id, at the first build that
  uses it: each time, choose the key already there, so that all four bundle
  ids have it. Later, `eas credentials -p ios` → *Push Notifications:
  Manage your Apple Push Notifications Key* does the same.

**Android: back the keystores up.** At the first Android build of a
package, EAS offers to generate an upload keystore: accept. There is one
per package, four in all: `se.rastra.app` and `se.rastra.vardnadshavare`
(each shared by its app's preview and production builds), and the two
`.dev` packages. Download each at once with `eas credentials -p android`
(choose a profile that builds that package, then the keystore), put the
file and its passwords in the password manager, and delete the download.
Every APK of §15.4 is signed with its package's keystore, and Android
updates an installed app only from the same key. Play App Signing (§15.8)
lets a lost upload key be reset with Google for the app from Play; an APK
signed with a lost key can never be updated, only uninstalled.

**Android push (FCM V1)** takes two files, both from the Firebase project
of §15.1:

1. **`google-services.json`.** With all four Android apps added, download
   it from Firebase (Project settings → General → Your apps); it then names
   all four packages. A file downloaded before the last app was added fails
   the Android build of the package it leaves out ("No matching client
   found for package name"), so download it again after adding an app.
   Upload it to EAS as one file variable for all three environments, which
   both apps share:

   ```bash
   eas env:set --name GOOGLE_SERVICES_JSON --type file --value ./google-services.json \
     --environment development --environment preview --environment production \
     --visibility secret
   ```

   On the builder EAS writes the file outside the project and puts its path
   in `GOOGLE_SERVICES_JSON`, and `app.config.ts` hands that path to the
   Android build (`android.googleServicesFile`). Expo's documentation says
   the file may be committed, since it holds only public Firebase
   identifiers; here it never is, because the repository is public and the
   file's API key would trip every secret scanner. Keep the local copy at
   `mobile/google-services.json`, which is gitignored. `app.config.ts` uses
   it when the variable is not set, which covers `npm run android`. `eas
   build --local` is different: it builds from a copy of the project that
   leaves gitignored files out, and EAS gives no secret variable to a local
   build. So before a local Android build, run `export
   GOOGLE_SERVICES_JSON="$PWD/google-services.json"` in `mobile/` (an
   absolute path), and build as in §15.2 item 4. With the local copy
   present, every cloud Android build prints that
   `android.googleServicesFile` "won't be uploaded to the builder". That is
   expected, because the builder takes the file variable instead. A
   preview or production Android build, on EAS or local, stops
   without one or the other (§15.2). A development build without the file
   still builds, but gets no push token: turning push on says
   "Pushnotiserna gick inte att slå på. Försök igen."
2. **The service-account key**, with which Expo sends to FCM. In Firebase,
   Project settings → Service accounts → *Generate new private key*. Then
   `eas credentials -p android`, the `rastra-production` profile, *Google
   Service Account* → *Manage your Google Service Account Key for Push
   Notifications (FCM V1)* → *Set up a Google Service Account Key for Push
   Notifications (FCM V1)*, and upload the file. Do the same with
   `rastra-development`, `vardnadshavare-production` and
   `vardnadshavare-development`, choosing the key already uploaded, so that
   all four packages have it; a preview build uses its production
   package's. A package without it gets no Android push, and only that
   app's sends fail. Then delete the downloaded file: it can send a push to
   every install of both apps, and a new one can always be generated.
   The key and `google-services.json` come from the same Firebase project,
   or every Android send fails with `MismatchSenderId`.

**Store submission keys**, for `eas submit` (§15.7, §15.8). One key of each
kind serves both apps; EAS assigns it per app, so it is chosen once under
`rastra-production` and once under `vardnadshavare-production`:

- App Store Connect: an API key, which `eas submit -p ios` offers to create
  the first time, or `eas credentials -p ios` → *App Store Connect: Manage
  your API Key*.
- Google Play: a Google Cloud service account with a JSON key, invited in
  Play Console (Users and permissions) with permission to release both
  apps to testing tracks, and uploaded with `eas credentials -p android`
  under *Google Service Account*, as the key for Play Store submissions.
  Then delete the downloaded key, as with the FCM key. Each app's first
  Play upload is by hand anyway (§15.8), so this can wait for the second.

### 15.4 The first internal Android build

1. `eas build -p android --profile rastra-preview`, and `--profile
   vardnadshavare-preview` for Rastra vårdnadshavare, once the preview
   environment has its values (§15.2) and `GOOGLE_SERVICES_JSON` (§15.3).
   Each app's first run generates its keystore (§15.3). The result is an
   APK signed by EAS, with that app's next build number.
2. On the Android phone, open the build's page (the link the CLI prints, or
   its QR code), download the APK and install it, allowing the browser to
   install apps when Android asks.
3. Check each app: its name under the icon ("Rastra Test", "Rastra
   vårdnadshavare Test"), the splash, and a sign-in with a test account of
   its role against the deployment the preview environment points at. In
   Rastra, the schedule, and attendance taken in airplane mode that syncs
   once the network is back; in Rastra vårdnadshavare, the children's
   schedules and an absence report. On every tab, the content runs down to
   the tab bar with no empty strip above it, and nothing hides under the
   status bar.
4. The wrong app: sign in with a guardian account in Rastra, and with a
   teacher account in Rastra vårdnadshavare. Each is refused on the login
   screen with a message that names the other app. Then, signed in with the
   right account, close each app and start it again in airplane mode: it
   opens signed in at once, since the check reads the role cached on the
   phone, and an offline start reads the session from the phone's storage
   without waiting for a token refresh that cannot happen.
5. The appearance, in light and in dark: the splash, then every tab,
   switching the phone's appearance in Quick Settings (Control Center on an
   iPhone) while the app is open. No screen keeps the other appearance's
   colours, the status bar stays legible, and an alert follows the phone
   (§15.12).
6. On an Android tablet with Android 16 or later, the tablet check of
   §15.12.

Every later preview build installs over the one before and keeps its data,
since the build number only rises. **Android's catch:** a preview APK and
its app's production build from Play (§15.8) have the same package but not
the same signing key, so Android refuses to install one over the other. The
tester then uninstalls first, which deletes the app's local data, the
offline attendance queue included: let the queue empty before.

### 15.5 The first internal iPhone build

1. Register each iPhone with `eas device:create`, choosing the website
   option, and the iPad of §15.12 the same way. The tester opens the link
   or QR code on that device and installs the profile it offers in
   Settings. `eas device:list` lists the registered devices, and `eas
   device:rename` gives one a name you will recognise.
2. `eas build -p ios --profile rastra-preview`, and `--profile
   vardnadshavare-preview` for Rastra vårdnadshavare, interactively the
   first time, signing in with the Apple account (§15.3). The build is
   signed ad hoc for every device registered when it is made. For a new or
   just renewed membership, Apple can take 24 to 72 hours to accept a new
   device, and a build that includes it may fail until then: wait and build
   again.

   The build asks no encryption question: `app.json` declares the answer
   (§15.11). Interactive `eas` commands can still write to `app.json`, so
   after one, `git status mobile/` shows nothing except what `eas init`
   wrote (§15.2). A changed bundle id or package is reverted at once with
   `git checkout mobile/app.json`; a build from an `app.json` whose base id
   is not `se.rastra.app` stops on the builder (§15.2 item 4).
3. On the iPhone (or iPad), open the build's page and install. iOS 16 and
   later run it only in Developer Mode: open the app once and let iOS
   refuse, then Settings → Privacy & Security → Developer Mode → on,
   restart, and confirm with *Turn On* and the passcode. This is once per
   device.
4. Check as in §15.4, steps 3 to 6, with an iPad for step 6. On the home
   screen, "Rastra vårdnadshavare Test" is cut to about "Rastra vård…"
   (§15): check that it still reads as the guardian app beside "Rastra
   Test".

**An iPhone added later** is in no build made before it was registered.
Register it, then either build again, interactively so that EAS updates the
provisioning profile (a non-interactive build reuses the old profile unless
it is given `--refresh-ad-hoc-provisioning-profile` and an App Store Connect
API key), or re-sign an existing preview build: `eas build:resign -p ios
--source-profile rastra-preview -e rastra-preview` (or the guardian app's
`vardnadshavare-preview` in both places), which asks which one (or takes
`--id`). Apple allows 100 iPhones a membership year for ad hoc builds, and
a device disabled during the year still counts.

**Development builds** work the same way with `--profile
rastra-development` or `--profile vardnadshavare-development`, on both
platforms; an iPhone is registered first. Install Rastra Dev and run `npm
start` in `mobile/`, or install Rastra vårdnadshavare Dev and run `npm run
start:vardnadshavare` (§15.2 item 5), and open the server from the app. The
phone and the computer must be on the same network, and the API the app
talks to must be https, as a phone is not localhost (§8). On an iPhone, a
development build first asks to find devices on the local network
("Utvecklingsbygget letar efter utvecklingsservern …"): allow it. Refused,
it cannot reach the server; turn it back on under Settings → Privacy &
Security → Local Network, or use `npm start -- --tunnel` (`npm run
start:vardnadshavare -- --tunnel`). Preview and production builds never
ask. A development build served by the other app's script believes it is
that app: Rastra vårdnadshavare Dev served by `npm start` refuses every
guardian. A plain `npx expo start`, without `APP` and `APP_VARIANT`,
describes Rastra's production app to the development build, and a
school-account sign-in would not come back to it.

### 15.6 Push on a real iPhone and Android phone

**Never in production before §8.1 step 1.** A push test sends real pushes
to whoever the gateway holds, so it runs against a test stack:

- a Supabase project that is not production's, set up as in §1 to §3, with
  test accounts only. `npm run db:seed`, run against that project's
  `DIRECT_URL`, gives a demo school (a later `npm run db:reset-demo -- --yes` keeps the login you link on a seeded row, and is refused once the school holds a person you invited to a mailbox of your own: §37) whose people have no login and which has
  no lessons yet. Link its admin as in §7: create the auth user, then set
  the seeded admin row's `"authId"` and `"invitedAt"`. Do the same for one
  seeded teacher, or invite a test teacher at `/admin/people` to a mailbox
  you control. Then generate and publish a timetable as in §9 steps 6 and
  7, so that the Day planner has this week's lessons. For step 5 below,
  also add a test pupil to a class with lessons this week and a test
  guardian at `/admin/people`, link the guardian to the pupil there, and
  invite both to mailboxes you control. These steps run in the test
  stack's web app, below;
- a gateway deployed against it as in §5, with `PUSH_NOTIFICATIONS=expo`
  (and `EXPO_ACCESS_TOKEN` if enhanced push security is on), reachable over
  https: a second service on the container host, or an https tunnel to a
  gateway on a laptop, since a phone's localhost is the phone. Its
  `AI_ENGINE_URL` and `AI_ENGINE_API_KEY` point at a solver as in §4,
  either a second one or production's. Production's holds no data (§4),
  but the test gateway then shares its key;
- a web app built against that project and gateway: a second deployment as
  in §6, or `npm run dev` in `web/` with its `.env.local` pointing at them.
  Production's web app cannot stand in, because its addresses are fixed
  when it is built. The test web app's origin comes first in the test
  gateway's `CORS_ORIGINS`, since invite links go there, and is in the test
  project's redirect URLs;
- internal builds of both apps pointed at both: preview builds (§15.4,
  §15.5) built with the preview environment's values, or development builds
  with `.env.local`.

On one iPhone and one Android phone, in both apps:

1. Sign in, as a test teacher in Rastra and as the test guardian in Rastra
   vårdnadshavare, open Inställningar → Pushnotiser and turn the switch on.
   The phone asks for permission here and only here, once per app: allow it.
2. Read what Settings says:
   - No switch, only "Skolan har inte slagit på pushnotiser.": the gateway
     this build talks to has push off, or did not answer
     `GET /api/v1/push/config`.
   - "Den här versionen av appen kan inte ta emot pushnotiser.": the build
     has no EAS project id (§15.2, step 2). Commit it and build again.
   - "Notiser är avstängda för … i telefonens inställningar.", naming the
     app as it is installed: the phone's permission was refused. Allow
     notifications for that app in the phone's settings and turn the switch
     on again.
   - "Pushnotiserna gick inte att slå på. Försök igen.": the phone gave no
     token, or the gateway refused the registration. On Android it is
     usually a development build without `google-services.json` (§15.3); on
     iOS, a build signed without the push capability.
   - The switch stays on, with nothing under it: the device is registered.
3. As the owner on the test database, find the devices' rows, one per app
   on each phone (each app has its own token):

   ```sql
   select platform, locale, token, "lastSeenAt" from "DevicePushTokens"
    where "revokedAt" is null order by "lastSeenAt" desc;
   ```

4. With the phone locked, book the test teacher as substitute on a lesson
   later this week in the Day planner (`/admin/lessons`). The push
   *Vikariepass* ("Du har ett vikariepass …") goes out whatever the teacher
   chose in Settings. It shows on the lock screen with no name, subject,
   group or room, and a tap opens the app's Notiser. On Android, Expo sends
   at normal priority, so a phone in deep sleep may show it some minutes
   late.
5. Both apps in one request. Keep the test guardian signed in to Rastra
   vårdnadshavare; in Rastra, log out and sign in as the test pupil, and
   turn push on as in step 1. Cancel one of the pupil's lessons later this
   week in the Day planner. Both the pupil and the guardian get *Inställd
   lektion*, unless they turned that kind off in Settings, and the
   gateway's log has no `Expo refused a request` line and no
   `RequestFailed` among `Push tickets with errors`. The gateway sends a
   school's pushes to Expo together, pupils' and guardians' tokens in one
   request, so this is the check that one EAS project carries both apps
   (§15). Reinstate the lesson afterwards.
6. To tell the Expo leg from the gateway, send to a token from step 3 by
   hand, with Expo's push notification tool (expo.dev/notifications) or:

   ```bash
   curl -H 'Content-Type: application/json' -X POST https://exp.host/--/api/v2/push/send \
     -d '{"to":"ExponentPushToken[…]","title":"Test","body":"Test"}'
   ```

   adding `-H 'Authorization: Bearer <EXPO_ACCESS_TOKEN>'` once enhanced
   push security is on. If this arrives and step 4's or step 5's did not,
   read the gateway's log; if neither arrives, look at the credentials of
   that token's app (§15.3).
7. After 15 to 20 minutes the receipt checker has asked Expo about the sends.
   Look for evidence that it did, since "no failures" alone also holds for a
   pass that had nothing to check:

   ```sql
   select runs, failures, counts from "JobRuns"
    where job = 'push-receipts' and day = (now() at time zone 'utc')::date;
   ```

   `counts` shows `"checked"` of at least 1, or the gateway's log has
   `Push receipts settled [checked=1, …]`. The log has no `Push tickets with
   errors`, `Push receipts with errors` or `Delivery failed` line, and names
   no error code (`MismatchSenderId`, `InvalidCredentials`,
   `DeviceNotRegistered`).
8. Log out of each app: the query of step 3 no longer lists that app's
   row.
9. Write the result in the build log (§15.9): the date, the phone and its OS
   version, the builds, and what arrived in each app.

**Enhanced push security** makes Expo refuse a send without the project's
access token. Turn it on (expo.dev, the account's access token settings)
only once every gateway that sends has `EXPO_ACCESS_TOKEN`; the other way
round, every send fails as unauthorised in between.

### 15.7 TestFlight internal testing

Each app has its own record in App Store Connect, so these steps run once
per app: with `rastra-production` for Rastra and `vardnadshavare-production`
for Rastra vårdnadshavare.

1. `eas build -p ios --profile rastra-production`: an App Store build with
   that app's next build number.
2. `eas submit -p ios --profile rastra-production --id <build id>` uploads
   it (the id is on the build's page and in `eas build:list`), or add
   `--auto-submit` to the build, which submits with the submit profile of
   the same name. Not `--latest`: it takes the project's newest App Store
   build for the platform, whichever app that is, and the project holds both
   apps' builds. With no `ascAppId` in the submit profile's `ios` yet, the
   first submit creates the app's record in App Store Connect, with the
   bundle id, store name and primary language (Swedish) the submit profile
   names. Check the name, which must be unique in the App Store (§15.1);
   if it is taken, eas-cli picks a variant and says so. Then put the app's Apple ID
   (App Store Connect → the app → App Information) into `mobile/eas.json`
   as `submit.rastra-production.ios.ascAppId` (for the guardian app,
   `submit.vardnadshavare-production.ios.ascAppId`, a different id) and
   commit it: it is an identifier, not a secret, and later submits skip the
   creation.

   **The bundle id is final from this upload.** Apple does not let an app's
   bundle id change once a build is uploaded; the ids are decided (§15.11).
   Nor, as is commonly documented, can a later version drop iPad support
   once a version with it is uploaded (§15.12).
3. **Export compliance is declared.** `app.json` sets
   `ios.config.usesNonExemptEncryption` to `false` (§15.11), which Expo
   writes into each build's Info.plist as `ITSAppUsesNonExemptEncryption`,
   so an uploaded build does not wait in TestFlight as *Missing
   Compliance*. One that waits all the same was built without the key:
   look at `app.json` before answering Apple's encryption questions by hand,
   and never answer them just to get a build through.
4. TestFlight → Internal Testing, in each app's record: create a group and
   add testers. Internal
   testers are App Store Connect users of the team, at most 100, and each
   accepts the invitation in the TestFlight app. Internal builds need no
   beta review, and each one can be installed for 90 days after upload. A
   school's teachers are not App Store Connect users: testing with them is
   TestFlight's external testing, which Apple reviews, and belongs to the
   stores phase.

### 15.8 Google Play internal testing

Each app is its own app in Play Console, so these steps too run once per
app, with the profiles of §15.7.

1. In Play Console, create the app by hand: its name (Rastra, or Rastra
   vårdnadshavare), default language Swedish (sv-SE), app, free, and the
   declarations Play asks for; only what internal testing needs, as the
   store listing waits for the stores phase.
2. `eas build -p android --profile rastra-production`: an app bundle (AAB)
   signed with that package's upload keystore. Download it from the build's
   page.
3. **Each app's first upload is by hand.** Testing → Internal testing →
   Create new release. Play asks to use Play App Signing: accept, so that
   Google holds the key that signs the app on phones and the EAS keystore
   is only the upload key. Upload the AAB, save, and roll the release out
   to internal testing. This upload fixes the package name for good; the
   packages are decided (§15.11). (Expo's documentation says `eas submit`
   can make this first release too; by hand, the person who accepts Play App
   Signing reads what they accept.)
4. Testers: Internal testing → Testers, an e-mail list of Google accounts
   (at most 100) and the opt-in link to send them. A tester opts in with
   that account and installs the app from Play.
5. Later builds go with `eas submit -p android --profile rastra-production
   --id <build id>`, or `--auto-submit` on the build (not `--latest`, as in
   §15.7), and the Play key of §15.3. Each app's submit profile
   (`submit.rastra-production.android`,
   `submit.vardnadshavare-production.android`) sends each build to the
   internal track as a draft, which is all Play accepts while the app
   itself is a draft; roll each one out in Play Console.
6. Note each app's signing key's SHA-256 (App integrity → App signing):
   App Links need Rastra's (§15.10), next to the upload keystore's own.

### 15.9 Versions, updates and expiry

- **Version and build number.** `version` in `app.json` (now `1.0.0`) is
  the one people see; raise it by hand when a release means something to
  them. The build number (iOS `buildNumber`, Android `versionCode`) lives on
  EAS (`cli.appVersionSource: "remote"`), and preview and production raise
  it at every build (`autoIncrement`). Never set it in `app.json`, where EAS
  would ignore it. EAS keeps the counter per application id, so each app
  has its own, which its preview and production builds share as they share
  the id, and each app's first build gets 1. `eas build:version:set -p ios
  --profile rastra-production` (or `-p android`, or the guardian app's
  profile) sets it by hand if it ever has to jump.
- **No over-the-air updates.** The app has no `expo-updates`. Every change
  to its code or its texts, however small, reaches a phone only as a new
  build that the person installs: from TestFlight or Play, or from the
  build's page for an internal build. A fix therefore takes a build, an
  upload and a rollout, and a phone runs the old code until it updates. The
  app tells the gateway nothing about its version, so the gateway keeps
  answering every build still installed: an API change an older build
  cannot read breaks that build without a word. When an older build must
  not meet a change, ship the build first and wait, as §11.1 step 4 does.
  EAS Update would allow JavaScript-only fixes; adopting it is a decision of
  its own (it needs `expo-updates`, a runtime version policy and a channel
  per profile).
- **The build log.** For every build that leaves a developer's hands: the
  date, profile (which names the app), version and build number, commit,
  the API its environment points at, and where it went (which testers,
  TestFlight, Play). Once it
  names testers, keep it with the operator's notes rather than in this
  repository.
- **What expires:**
  - a TestFlight build, 90 days after upload;
  - an ad hoc provisioning profile, after 12 months. An internal iPhone
    build made with it stops opening and needs a new build or a re-sign
    (§15.5);
  - the iOS distribution certificate, after a year. EAS offers a new one at
    the next build; the ad hoc builds signed with the old one stop opening,
    apps installed from the App Store do not;
  - the Apple Developer Program membership, every year. If it lapses, the
    app leaves the App Store and TestFlight stops;
  - on Play, the target API level: Google requires an update to target a
    recent Android version, about a year after each release, and keeping
    the Expo SDK current is what keeps the app eligible.

  The APNs key, the FCM service-account key and the four Android keystores
  do not expire.

### 15.10 Universal Links and App Links

This is the follow-up that closes §11's accepted risk of the custom scheme.
Rastra would come back from a school-account sign-in on an https address of
the web origin, which only Rastra's own signed app can claim, instead of on
`rastra://auth/callback`, which any app can register. Rastra vårdnadshavare
has no school-account sign-in and needs none of this. It takes:

- **the home domain**, which is undecided (PRODUCT.md). The claimed address
  sits on the web origin, and moving it later takes a new build;
- **on iOS**, the Associated Domains entitlement (`ios.associatedDomains`,
  `applinks:<web host>`) in the app config, and the web serving
  `/.well-known/apple-app-site-association` (JSON, over https, with no
  redirect) that names the app as `<Team ID>.se.rastra.app` and the
  callback path. The Team ID is the Apple Developer account's (§15.1);
- **on Android**, an intent filter with `autoVerify` for the same https
  path, and the web serving `/.well-known/assetlinks.json` with the package
  `se.rastra.app` and the SHA-256 of every key that signs an installed
  copy: Rastra's app signing key on Play (§15.8), and its EAS upload
  keystore for preview APKs, which `eas credentials -p android` shows
  (§15.3);
- **in the app**, a sign-in that receives the https redirect instead of a
  scheme (`mobile/src/services/auth/authService.ts`). Check how
  `expo-web-browser`'s authentication session takes an https callback on
  the iOS versions the app supports;
- **on the web**, a page at that path for a phone without the app, and **in
  Supabase**, the new redirect URL (§11.5). `rastra://auth/callback` comes
  off the list only once no installed build uses it, since every build
  keeps the redirect it was built with (§15.9). Rastra Dev,
  `se.rastra.app.dev`, keeps `rastra-dev://` unless it is named in both
  files too.

### 15.11 Decisions

The owner decided these on 2026-10-17. What each touches:

1. **Two apps, each admitting only its own roles** (§15): Rastra for staff
   and pupils, Rastra vårdnadshavare for guardians. Their ids are
   `se.rastra.app` and `se.rastra.vardnadshavare`, with `.dev` for the
   development builds. `app.json` holds Rastra's (`ios.bundleIdentifier`,
   `android.package`), and `app.config.ts` derives the rest. Each id
   becomes permanent at its app's first App Store Connect upload (§15.7)
   and first Play upload (§15.8); changed after, it is a new app in both
   stores. They replace `com.schemapro.teacher`, which no store has seen.
   Nobody using the apps sees an id.
2. **The display names, "Rastra" and "Rastra vårdnadshavare"** (preview
   builds add " Test", development builds " Dev"). They are the names under
   the icon and in the phone's settings, and each app's own texts name the
   app they mean. The store names are set apart from them: the App Store
   name must be unique in the store (§15.1, §15.7), and Play's title is set
   in Play Console (§15.8). On an iPhone's home screen the guardian app's
   name is cut to about "Rastra vård…" (§15).
3. **Tablets: on** (`ios.supportsTablet: true`, `orientation: "portrait"`
   kept). §15.12 says what that gives and how it is checked.
4. **Appearance: follows the phone** (`userInterfaceStyle: "automatic"`),
   with a light and a dark palette (§15.12).
5. **Export compliance: exempt** (`ios.config.usesNonExemptEncryption:
   false` in `app.json`, which Expo writes into Info.plist as
   `ITSAppUsesNonExemptEncryption` false). The apps' encryption is HTTPS,
   the system keychain and SQLCipher (AES) for the local database
   (`expo-sqlite`'s `useSQLCipher`). Treating that as exempt is the usual
   interpretation for standard encryption of local storage and HTTPS; it is
   **not a legal assessment**. With the key set, `eas build` asks no
   encryption question (§15.5) and TestFlight builds do not wait as
   *Missing Compliance* (§15.7). Any further encryption the apps add
   reopens the decision, and `true` would bring the export documentation
   Apple then asks for.

**Chosen with the build, and reversible until the first `eas init` and the
first store uploads:**

- **One EAS project**, slug `rastra` (§15, §15.2): one project id in
  `app.json`, one set of EAS environments for both apps, and credentials
  per application id (§15.3). Two projects would make the gateway's mixed
  push requests fail (§15).
- **No school accounts in Rastra vårdnadshavare.** Guardians sign in with
  a password, so only Rastra's schemes go into Supabase's redirect URLs
  (§1, §11.5), and §11.7's accepted risk of the custom scheme and §15.10
  concern Rastra alone. The Entra app registration and the Google consent
  screen, which IT departments see, are named Rastra (§11.3, §11.4).

**Still open:**

- **Two columns in the attendance register on wide tablets: not adopted.**
  The register is one centred column at every width. Two columns would
  order the class row by row (pupil 1 beside pupil 2), and a register is
  read down; adopting them takes the owner's yes.
- **A mark of its own for the guardian app.** Both apps have the same icon,
  so on a phone with both (a teacher who is also a parent, with an account
  for each) only the name under the icon tells them apart, and an iPhone
  cuts the guardian app's short. A mark of its own changes the icon files
  and `mobile/scripts/render-brand-assets.mjs`.
- **Whether school accounts should ever come to the guardian app.** If they
  do, it needs `rastra-vardnadshavare://auth/callback` (and the `-dev` one)
  in Supabase's redirect URLs, and §11.7's accepted risk and §15.10 extend
  to it.

### 15.12 Tablets and appearance

**Tablets.** `ios.supportsTablet` is `true`, and `orientation` stays
`"portrait"`:

- Phones run in portrait.
- On an iPad, Expo writes all four orientations and `UIRequiresFullScreen`
  false, so the app takes part in iPad multitasking: Split View, Slide Over
  and Stage Manager give it any window width and change it while it runs.
  Apple is retiring the full-screen opt-out (TN3192), so a resizable app is
  the lasting choice.
- Android 16 and later ignore the portrait lock on tablets (smallest width
  600 dp and up), since the app targets SDK 36, so the app runs there in
  any orientation and window size. Android 12L to 15 tablets keep the
  lock, and letterbox the app when held on their side.

The screens lay out from the window's width, never the screen's
(`mobile/src/layout/responsive.ts`): reading columns of at most 680 points
and forms of at most 480; from 840, the guardian's absence and leave forms
beside their lists; on wide screens, the child's week as a grid of days.
The attendance register stays one centred column (§15.11).

Check this on a device before the first store upload and after any change
to a screen's layout:

- on an iPad: portrait and landscape; Split View at its narrowest and its
  widest; a Stage Manager window resized while a screen is open; and the
  keyboard up on the login form, the guardian's absence form and the leave
  form, with the field being typed in still in view;
- on an Android tablet with Android 16 or later: both orientations, a
  resized window, and the keyboard up on the absence and leave forms with
  the field being typed in still in view (the app draws edge to edge, and
  the forms move for the keyboard through a KeyboardAvoidingView there).

An iPad gets an internal build as an iPhone does (§15.5). App Store Connect
asks for 13-inch iPad screenshots for an app that runs on iPad, and Play
for tablet screenshots; both belong to the stores phase. As is commonly
documented, iPad support cannot be withdrawn once a version with it is
uploaded (§15.7).

**Face ID only where attendance is taken.** Rastra asks for Face ID before
attendance is sent, and says why in Swedish (English in the English
localisation). Rastra vårdnadshavare takes no attendance, so its build
carries no Face ID purpose text and no biometric permission: iOS never asks,
and Android lists no fingerprint or biometric access.

**Appearance.** The apps follow the phone's light or dark appearance
(`userInterfaceStyle: "automatic"`). Every colour is a role in
`mobile/src/theme/tokens.ts`, with one palette per appearance: light is the
web's light theme, and dark is the app's navy.
`mobile/src/theme/contrast.test.ts` measures every text and control pair
against WCAG 2.1 AA in both, and a source scan refuses a colour written
anywhere else. The splash has a light and a dark ground. The native view
behind the screens is set once, at build time, so the app repaints it
whenever the phone switches. The device check is §15.4 step 5, on an iPhone
and an Android phone.

## 16. Analysis and planning ("Analys och planering")

Key figures per teacher and school, a cost basis per pupil and a payroll basis
with accounts, under `/admin/analysis` (route family `/api/v1/analysis`). The
migration `20270130090000_en_skola_har_skoldelar_och_kostnadssatser_for_analys`
adds the enum `StaffCostCategory` and two tables, `SchoolParts` (a skoldel: a
cost centre with a name, an account and the årskurser it holds, in the
nine-year numbering, never overlapping within a school) and `StaffCostRates`
(the school's cost of an hour per staff category, in SEK). Neither holds a
person: no individual salary is stored, and the category is derived when a
basis is made. Everything else is computed per request from rows that exist,
and no job, notice or setting is added.

### 16.1 Deploy order

1. Run the migration before the merge (section 2). It takes `Schools` in
   `SHARE ROW EXCLUSIVE` with `NOWAIT` in a loop for at most 30 seconds, and
   stops with nothing done if the table is never free (rerun it after
   `prisma migrate resolve --rolled-back`). The API before this release is
   unaffected: it never reads either table.
2. Merge. The API deploys from `main`; there is no engine change and no new
   environment variable.
3. Verify (as the owner): `SELECT count(*) FROM pg_policies WHERE tablename IN
   ('SchoolParts','StaffCostRates');` is 8, `app_authenticated` holds SELECT,
   INSERT, UPDATE and DELETE on both and nothing else, and no other role holds
   anything (PostgreSQL 17: not MAINTAIN either).

### 16.2 What each reader gets

- Key figures: every administrator profile, without tjänstgöringsgrad unless
  the profile reads HR data; the huvudman's reader gets the school's figures
  and no teacher's row. A teacher has none of it.
- Cost basis: rektor, a full administrator, a reader with HR-läs, and the
  huvudman's reader (as sums). Refused to the rest with
  `ANALYSIS_COST_NOT_YOURS`.
- Payroll basis and its file: rektor, a full administrator and a reader with
  HR-läs, never the huvudman's reader (`HR_NOT_YOURS` before anything is read).
  The file keeps people with a protected identity and says how many
  (`protectedInFile`); both are recorded in the read log. Such a person is in
  the file by the post's signature and `Löne-id`, with the name and e-mail
  columns empty and the rows last; the gateway does not read their names at
  all. `Löne-id` is the last column (`TeacherEmployments.payrollNumber`,
  20270206090000), filled for everyone the school has written one for and
  empty otherwise, so an import set up on the first release's columns finds
  every column where it was. A marked person with no `Löne-id` (a pool vikarie
  has no post) stands by a code instead, `SKYDDAD-<n>` from `PayrollPseudonyms`
  (20270206091000), the same in every file while the mark lasts;
  `protectedWithoutPayrollNumber` and `ANALYSIS_PROTECTED_WITHOUT_PAYROLL_NUMBER`
  say how many. A marked person with neither a `Löne-id` nor a code (the
  trigger exists to prevent it) is said on its own, `ANALYSIS_PROTECTED_WITHOUT_ID`. The JSON answer says each person's `signature`,
  `payrollNumber`, `protectedIdentity` and `pseudonym`; the page names a marked
  person the same way and resolves a code to the name in a key outside the
  table, on the screen alone.
  A person is booked for the time they were active (`UserDeactivations`,
  20270210090000, section 16.5): lessons and covers that were not over inside a
  period they were inactive (`startsAt < endsAt < period end`; one over at the
  very instant they left or came back counts, D6's rule made to cover a
  return, through statement E's `away`), the stored uppdrag and the rastvakt
  for the days outside it (from the school's date they left to the day before
  the school's date they came back), and nothing for a payroll period wholly
  inside one; `ANALYSIS_LEFT_IN_PERIOD` says how many were inactive in or before
  the period. Before 20270210090000 this read `Users.deactivatedAt` alone: a
  person made active again was booked as if they had never left, the gap
  included.
- Writes (a skoldel, a rate): those who decide, in the gateway (`@Decides`)
  and in the database's arms.

### 16.3 Löne-id and the codes (20270206090000, 20270206091000)

Two migrations, run before the merge in stamp order (section 2):

1. `20270206090000_en_tjanst_har_lonesystemets_anstallningsnummer` adds
   `TeacherEmployments."payrollNumber"` (TEXT NULL, CHECK
   `TeacherEmployments_payrollNumber_check`: 1..30 characters, trimmed, no
   control character) and restates `app.gallring_pseudonymise` so that a
   pseudonym's posts lose it with their signature and note. It takes
   `TeacherEmployments` in `ACCESS EXCLUSIVE` with `NOWAIT` in a loop for at
   most 30 seconds (no default, no rewrite). The API before this release never
   names the column, and its PUT of a post keeps it (an absent field is kept).
2. `20270206091000_en_skyddad_person_har_en_kod_i_loneunderlaget` adds
   `PayrollPseudonyms` (schoolId, userId, an identity `number`), the trigger
   `PersonProtections_payroll_pseudonym` (SECURITY DEFINER) that writes a code
   when a person is marked and removes it with the person's last mark, and a
   code for every mark that exists. The trigger locks the person's `Users`
   row (`FOR NO KEY UPDATE`) in both branches, so one transaction at a time
   changes a person's marks and code: without it the register's mark set
   while an administrator removes theirs leaves the person marked with no code.
   It also restates `app.teacher_employment_logs_append_only` (gallring may set
   a pseudonym's payroll number to null in a version, and change nothing else
   of it) and `app.gallring_pseudonymise` (the versions of a pseudonym's posts
   lose the number too). It takes `Schools`, `Users` and `PersonProtections`
   together in `SHARE ROW EXCLUSIVE`, `NOWAIT`, 30 s. The API's role holds
   `SELECT` only; nobody but the trigger writes.

After a failed attempt, `prisma migrate resolve --rolled-back <name>`, then
deploy again. Verify (as the owner, `public` only): the column and its CHECK
exist; `PayrollPseudonyms` has one policy (`payroll_pseudonyms_admin_select`)
and as many rows as there are distinct (schoolId, userId) in
`PersonProtections`; `md5(prosrc)` of `app.gallring_pseudonymise` is
`1f2b20ccf7e10b66c90664c235162a43` (after the first migration alone it is
`7fec758093038f6fb55a681781a45340`), of
`app.teacher_employment_logs_append_only` `966928393a3e3d3fe411b82166ae7e41`
and of `app.payroll_pseudonym_follows_the_mark`
`bf0034c918448976addb2ae879d918cb`. The checks the reviewer runs are
`prod-fore.sql` and `prod-efter.sql` beside the review.

The whole-school export's `larare.csv` does not carry `Löne-id` (it is
Rastra's import format); the person's own registerutdrag does, and their code.

### 16.4 Operations

- The four views are limited to 20 a minute per login and route (429,
  `ANALYSIS_RATE_LIMITED`, with `Retry-After`), not per address: a school's
  staff share one. The global per-address bucket for these routes is 600.
- The views are built in the API process. Measured on a school of 120
  teachers and 2 000 pupils: see the PR for the figures and the method.
- The payroll CSV is Windows-1252 (`text/csv; charset=windows-1252`): a
  character it cannot hold is written as the nearest letter and counted in a
  notice. A control character (a NUL or a BEL pasted into a name) is written as
  a space, which is what the code page encoder `src/common/windows-1252.ts`
  (D8's) does and the payroll's encoder asks it for, and counted in the same
  notice: a NUL in the file is what makes Excel call it corrupt. The formula
  guard reads a cell as the file will (a BEL before `=` is a space before `=`,
  which the guard calls dangerous), so such a cell is guarded too. The Excel file
  keeps every character but the control characters, which XML cannot carry: it
  drops them without saying so, and the notice says as much.
- Rolling back the API past this release leaves two unused tables. Nothing
  else reads them.

### 16.5 A person's periods of being inactive (20270210090000)

`Users."deactivatedAt"` (20261021100000) is the moment `isActive` last went
false and is cleared by a return. That is the date gallring counts from and the
wrong thing to read for a person's time: a person made active again was counted
for the weeks between the two clicks (the review of #280, LÅG-1), and the stamp
is the click, so the days between a last working day and the click were booked
(LÅG-2). One migration, `20270210090000_en_avaktiverad_person_minns_sina_perioder`
(run before the merge, in stamp order, section 2):

- **`UserDeactivations`** (schoolId, userId, `startsAt`, `endsAt`, `recordedAt`):
  one row for every period a person has been inactive. `startsAt` is the click
  (the same instant as `Users.deactivatedAt`) or the person's last working day
  when an administrator named it; `endsAt` is the moment the person was made
  active again, null while inactive. A person is inactive in exactly one open
  row and active in none. CHECKs: `endsAt` after `startsAt`; `startsAt` not later
  than `recordedAt` (a last day is not in the future); the exclusion constraint
  `UserDeactivations_one_period_at_a_time` (btree_gist) keeps one person's
  periods from overlapping. The key to the person is composite (userId,
  schoolId), `ON DELETE CASCADE ON UPDATE NO ACTION`.
- **`Users_deactivations_are_kept`**, an AFTER trigger (`INSERT OR UPDATE OF
  "isActive"`, SECURITY DEFINER, `app.users_deactivations_are_kept`): a row that
  is inserted inactive or goes inactive opens a period at its `deactivatedAt`,
  never earlier than the person's previous return (two administrators flipping
  one person at once cannot make the periods overlap); a row that goes active
  closes the open one at `clock_timestamp()`. `Users.deactivatedAt` is unchanged.
  Every writer goes through it, the release before this one included.
- **What is carried over:** every person inactive today gets an open period
  from their `deactivatedAt`. A person who was inactive and became active
  again before the migration has none, because Users forgot the date when they
  returned and no other table kept it (`TeacherEmploymentLogs` logs a post,
  `Ss12000EntityVersions` is a counter): their gap stays counted as it was, and
  no figure produced before the migration changes.
- **Row-level security:** read by the school's administrators (every profile,
  as `UserRoleChanges`), `startsAt` of an *open* row changed by those who write
  Personal (`TABLE_WRITE_GATES.UserDeactivations`: update `PERSONAL`; the gate is
  asked in WITH CHECK only, as on every table). The API role holds `SELECT` and
  `UPDATE ("startsAt")`; nobody inserts or deletes; `service_role` reads.
- **`app.absence_stats_lessons`** (D6) is replaced by its own body with one line
  exchanged: the teacher counts unless the lesson ended inside one of her
  inactive periods. The migration stops if the body is not the one
  `20270122091000` wrote (`md5(prosrc)` `265b9b21353ecd7e441397f99e565643`).
  Months D6 has already stored are not recomputed.
- **The gateway:** the löneunderlag reads the periods (statement E's `away`,
  `src/analysis/leavers.ts`), and `PATCH /api/v1/users/{id}` takes `leftOn`
  (the school's date, `ÅÅÅÅ-MM-DD`), for a person being deactivated or one who
  is inactive already: their time then counts through the end of that day.
  `leftOn: null` is no day, as leaving it out is (an integration that sends every
  field must still be able to deactivate). It is refused for a day that has not
  been (`USER_LEFT_ON_IN_THE_FUTURE`), for a person who is or becomes active
  (`USER_LEFT_ON_NEEDS_INACTIVE`), for a day before the person was added to
  Rastra (`USER_LEFT_ON_BEFORE_START`, in the school's days; a year typed wrong
  would otherwise take a year of payroll from them) and for a day before the
  person last came back (`USER_LEFT_ON_BEFORE_RETURN`). There is no field for it
  on the People page yet.
- **Not changed:** the load report, the SCB file (`inactiveSince`), the
  rastvakt's coverage and the school export still read `Users.deactivatedAt`
  (the click), so a last working day named for a person moves the payroll and
  the absence statistics and nothing else. Gallring counts from the click on
  purpose: a last working day must not shorten a retention period.

**Beside the live API.** The foreign keys take `SHARE ROW EXCLUSIVE` on `Schools`
and `Users`, and so does the trigger's `CREATE TRIGGER`: writes wait, reads do
not, for the milliseconds the file runs. Both are taken first, `NOWAIT` and
together, in a loop for at most 30 seconds (the rule of section 2); after a
refusal for that long nothing is changed. The release before this one writes
`isActive` alone and the table follows, so the order is migration first, then
merge; rolling the code back leaves the table and the trigger in place and
harmless. After a failed attempt, `prisma migrate resolve --rolled-back
20270210090000_en_avaktiverad_person_minns_sina_perioder`, then deploy again. That
the loop gives up is proved against a real database by
`scripts/test/probe-analysis.ts` (lo): the first DO block of the file, with its 30
seconds made one, stops with the message above while another connection holds
`Users` `ACCESS EXCLUSIVE`, and passes when both tables are free.

Verify (as the owner, `public` only): `UserDeactivations` exists with six
constraints (pkey, two keys, two CHECKs and the exclusion) and two policies; the
trigger `Users_deactivations_are_kept` is enabled; `md5(prosrc)` of
`app.absence_stats_lessons` is no longer `265b9b21…`; and every inactive person
has exactly one open period and nobody active has one:

```sql
SELECT count(*) FROM "Users" u
 WHERE (SELECT count(*) FROM "UserDeactivations" d WHERE d."userId" = u.id AND d."endsAt" IS NULL)
       <> CASE WHEN u."isActive" THEN 0 ELSE 1 END;   -- 0
```

Reading a person's periods (the owner or the API role as an administrator):
`SELECT "startsAt", "endsAt", "recordedAt" FROM "UserDeactivations" WHERE "userId" = '…' ORDER BY "startsAt";`
Correcting a last working day that was named wrongly is the same `PATCH` with a new
`leftOn`; a row is never edited by hand.

## 17. Lokal: resources and external bookers (K3)

Two migrations add what the school needs to lend out more than rooms and to let a
room to an association after school: `20270204090000_nya_slag_av_notiser_och_gallring_for_externa_bokningar`
(the enum values `NotificationType.EXTERNAL_BOOKING_CLASH` and
`RetentionDataType.EXTERNAL_BOOKINGS`, and nothing else) and
`20270204091000_en_forening_hyr_en_sal_och_skolan_lanar_ut_mer_an_salar` (the tables
`ResourceTypes`, `Resources`, `ResourceBookings` and `ExternalBookings`, the column
`RoomBookings.externalBookingId`, four triggers, 18 policies, and the gallring branch).
Route families: `/api/v1/resource-types`, `/api/v1/resources`, `/api/v1/resource-bookings`,
`/api/v1/external-bookings`, `/api/v1/utilisation`. Nothing is on by default and no setting
or environment variable is added: a school with no resources and no series sees an empty
page.

The days of an external series are rows of `RoomBookings` (or `ResourceBookings`) that carry
the series' id and the title "Extern bokning", so the room's exclusion constraint and every
reader of bookings (the teachers' free-room search, the cover board, Skolans dag) see the hire
without being taught it. The hirer's organisation, contact person, telephone number and
address are in `ExternalBookings` alone, read by administrators through the gateway only
(no grant for `authenticated` or `anon`), and are personal data about somebody who is not a
user: they are gallrade with the series (`EXTERNAL_BOOKINGS`), left out of every notice, and
written `(dold)` in the extract of the person who registered the series.

### 17.1 Deploy order

1. Run the migrations before the merge (section 2). The first only adds enum values and takes
   no lock. The second takes `Schools`, `Users`, `Rooms` and `Sites` in `SHARE ROW EXCLUSIVE`
   and `RoomBookings` in `ACCESS EXCLUSIVE` (it adds a nullable column), all `NOWAIT` in a loop
   for at most 30 seconds; it stops with nothing done if they are never free at once (rerun it
   after `prisma migrate resolve --rolled-back 20270204091000_en_forening_hyr_en_sal_och_skolan_lanar_ut_mer_an_salar`).
   The API before this release never reads the new tables or the column.
2. Merge. The API deploys from `main`; there is no engine change.
3. Verify as the owner:
   - `SELECT count(*) FROM pg_policies WHERE tablename IN ('ResourceTypes','Resources','ResourceBookings','ExternalBookings');` is 18,
     every one `TO app_authenticated` alone;
   - `app_authenticated` holds SELECT, INSERT, UPDATE and DELETE on the four tables and nothing else, `service_role` SELECT only,
     `authenticated` and `anon` nothing, and no role MAINTAIN (PostgreSQL 17);
   - `app.gallring_due` and `app.gallring_purge` are F5's bodies with one branch for `ExternalBookings`:
     `md5(prosrc)` before `166943b0d5d22801fe9a1be96a722d95` and `2390088f88e967fda35af6d56e63d3f9`, after
     `9581d0360a19741db05f1fa7e609207f` and `6b5601ad006da9fa3309664e108f4720`; `gallring_pseudonymise` is untouched
     (`6f18f62fc354bde849aa2e8b01eeceda`);
   - the four tables are empty and `RoomBookings.externalBookingId` is null in every row.

### 17.2 Operations

- A resource's quantity is kept by a trigger that takes the resource's advisory lock and counts the most that is held at one
  minute; the refusal is SQLSTATE `23P01` with the name `ResourceBookings_quantity_is_kept`, answered 409 `RESOURCE_QUANTITY_USED`.
  A series that two administrators register at once ends in one 409 (`EXTERNAL_BOOKING_CONFLICTS`), never a 500.
- A publication writes lessons without asking the bookings. After it commits, the administrators who write Drift get one notice
  (`EXTERNAL_BOOKING_CLASH`, a number of days and nothing else) when a day of a series now stands in a room with a lesson; the
  list is `/admin/external-bookings`. Nothing is moved by Rastra.
- A person who registered a series that still runs is not removed (`EXTERNAL_BOOKINGS_REGISTERED`, 409): the days are bookings in
  their name and go with them. A room or a resource with a series is not deleted (`ROOM_IS_LET_OUT`, `RESOURCE_IS_LET_OUT`).
  A series that is over or cancelled can be removed by Drift, with its days (`DELETE /api/v1/external-bookings/:id`).
- Gallring: the new kind starts at "ej beslutat" in every school. A series is due when its last day, or its cancellation, is older than
  the school's period; one that runs is never due.
- Reports: `GET /api/v1/utilisation` and `/utilisation/csv` read lessons and bookings for at most 400 days. The CSV is the school's dialect
  (UTF-8 with BOM, `;`).
- Rolling back the API past this release leaves four unused tables and one null column. Nothing else reads them.

## 18. Leave policy ("Ledighetspolicy", K4)

A school chooses how it receives a leave request from a family: every guardian's consent, the fewest days ahead, and a
temporary contact during the leave. **All three are off for every school** until an administrator who decides records
them under `/admin/leave` (Ledighetsansökningar; no row in `LeavePolicies` is all off), so deploying changes nothing a school sees.

### 18.1 Deploy order

- **Migrations first, then the merge.** 20270205090000 adds the `NotificationType` values `LEAVE_CONSENT_REQUESTED`,
  `LEAVE_CONSENT_REMINDER` and `LEAVE_CONSENT_REFUSED` and the `LeaveRequestStatus` value `GUARDIAN_DECLINED` and nothing
  else (a value cannot be used in the transaction that adds it; it takes no lock). 20270205091000 adds the tables
  `LeavePolicies` and `LeaveConsents`, the enums `LeaveShortNotice` and `LeaveContactMode`, five columns on `LeaveRequests`
  (`consentRequired`, `shortNotice` and the three of the contact; the defaults are constants, so adding them rewrites no row),
  three CHECKs (added `NOT VALID` and validated at once), four triggers (`LeaveRequests_policy` before an insert,
  `LeaveRequests_ask_guardians` after it, `LeaveRequests_gate` before an update, and the policy's stamp), seven functions
  the API role runs and four the owner's alone, and `CREATE OR REPLACE` of `app.leave_request_refer`,
  `app.leave_tell_mentors` and `app.leave_request_facts` (each is the body of 20261023091000 or 20261101090000 plus one
  condition: a request that needs consent and lacks it is not the mentor's) and `ALTER POLICY` of the two mentor arms. No
  existing row is touched. The file takes `Schools` and `Users` in SHARE ROW EXCLUSIVE and `LeaveRequests` in ACCESS
  EXCLUSIVE, NOWAIT, together in a loop; if the three are not free at once in 30 s it stops with nothing changed
  (`prisma migrate resolve --rolled-back 20270205091000_skolan_valjer_hur_en_ledighetsansokan_tas_emot`, then deploy
  again). The API before the release reads `LeaveRequests` with explicit columns and writes the new ones as their defaults,
  so it keeps working between the migration and the deploy.
- **`gallring_due`, `gallring_purge` and `gallring_pseudonymise` are not touched.** A request is deleted whole by gallring
  (LEAVE_REQUESTS, on its last day), and its `LeaveConsents` go with it by the key; the contact is columns of the request.
  The md5 of the bodies stays `166943b0d5d22801fe9a1be96a722d95` (due), `2390088f88e967fda35af6d56e63d3f9` (purge) and
  `6f18f62fc354bde849aa2e8b01eeceda` (pseudonymise), read on Postgres 16 and 17 alike.
- **`LEAVE_CONSENT_BACKGROUND`** (`on` by default): the quarter-hourly pass `leave-consent` in `JobRuns`, see the table of
  variables. `off` stops every reminder and the mentors' catch-up for a custody that ended; a guardian's answer, and the
  mentor's notice that answer sends, go on.
- **Rolling back the API** leaves the tables and functions unread. A request a guardian's no ended has the status
  `GUARDIAN_DECLINED`, which the previous Prisma client cannot read (a model read of the row throws `Value
  'GUARDIAN_DECLINED' not found in enum`). Before a revert, as the owner: `ALTER TABLE "LeaveRequests" DISABLE TRIGGER
  "LeaveRequests_gate"; UPDATE "LeaveRequests" SET "status" = 'REJECTED' WHERE "status" = 'GUARDIAN_DECLINED'; ALTER TABLE
  "LeaveRequests" ENABLE TRIGGER "LeaveRequests_gate";` (the CHECK allows REJECTED with no decider). A school that never
  recorded a policy has no such row.

### 18.2 What is decided (for a conversation with the school)

- *Consent is every guardian with active custody when the request was filed*, apart from whoever filed it (to apply is to
  consent). A guardian linked later is not asked. A pupil who files for themselves, and an administrator who files for a
  family that rang, ask every guardian. **Active custody is Kvittens' rule** (`app.ack_receipt_open`: a link and both
  persons active): a guardian whose custody ended holds nothing up and cannot answer (409), and a yes given before stands.
- *"Has its consent" is never stored.* `app.leave_consent_met_raw` is the one definition (nobody who can still answer
  waits, and nobody said no), so a custody that ends clears a request in that moment and two answers at once have no
  count to write wrong. Only a no is stored, as the request's end (`GUARDIAN_DECLINED`), in the transaction of the no.
- *An answer is final.* The same answer again is no news; the other answer is a 409. A no ends the request: nobody
  decides it, the mentor never hears of it, and whoever applied is told, without a name, that a guardian did not consent.
  **Rektor can reject a request that waits** (a rejection grants nothing, so the gate holds back an approval only): a
  guardian who never answers cannot keep a request waiting for ever, and switching the policy off would not have helped,
  since `consentRequired` is stamped on the request. Rejecting ends the wait: the guardians' unanswered requests are marked
  read, a late answer is a 409, and the pass stops reminding. **There is no withdrawal by the family in this release**
  (BESLUT, follow-up): it needs a status of its own and a rule for what happens to a request already granted, whose
  absence is written; until then the family asks the school to reject it.
- *The administrator sees a request that waits, with the counts (asked, consented, waiting), never who, and cannot
  approve it* (409 `LEAVE_AWAITING_CONSENT`, and the trigger `LeaveRequests_gate` on every other path). The mentor neither
  reads it nor hears of it until it has its consent: the last yes tells the mentor in its own transaction, the job's pass
  tells the mentor of a request a custody that ended cleared.
- *A guardian never sees what another answered.* No role has any privilege on `LeaveConsents`; the functions answer a
  guardian their own part only. The notice to the other guardian and the notice of a no say neither who applied nor who
  refused, since separated guardians may hide from one another; the e-mail and the push name no child, no date and no reason.
- *One reminder*, two days after the request, to each guardian who has not answered and can still answer, while the
  request waits and the leave is not over. It is not a school setting (follow-up if a school wants another time). **At
  most once:** `remindedAt` is written in the transaction that writes the notice, and the mail and the push follow the
  commit, so a process that stops between the two leaves the reminder in the inbox only; it is never sent again (Kvittens
  marks the delivery as well; here the inbox, where a waiting request is shown, is enough).
- *The minimum is counted in calendar days* from the school's own day to the first day, and holds for guardians and
  pupils; an administrator is let through and the request is flagged, as a request is when the school chose FLAG. Both
  the gateway (`GET /api/v1/leave-policy`, the form's code) and the trigger (every other path, PostgREST included) ask the
  same function.
- *The contact is a third party's data*, three columns on the request: read by whoever reads the request (the family that
  wrote it, the administrator, the mentor who decides), by no other teacher (no other teacher reads any leave request),
  never in a notice, a mail or a push. A mentor who does not decide a request (the school delegates nothing, or the leave
  is longer than the limit) does not read the request either, so does not read its contact. A school that turns the
  contact off drops one given by an older form. It goes with the request in gallring, is in `ledigheter.csv` and the
  registerutdrag on the reason's terms (emptied in an extract about somebody else and where the name is a marked person),
  and is counted with the request in the removal's dialog.
- *The guardians' answers are data about the guardians*, so they are in the school's export and in a registerutdrag as
  `data/samtycken.csv` (the request, the guardian, the pupil on the terms of the other files, the answer, when they answered,
  when the one reminder was written, when they were asked). No role reads the table, so the file asks
  `app.leave_consents_export`, which gives an administrator who decides the school's own rows, the persons the scope names, and
  not the requests about a protected pupil. A guardian's extract holds their own answers and no other guardian's, also when the persons who
  come along with an extract are asked for (a pupil's extract with the guardians holds none of the guardians' answers, a guardian's
  with the children holds their own); a teacher's and a pupil's hold none. The school's export, on the other hand, holds every
  answer, so the administrator who orders it, or who hands out a school's export, sees each guardian's individual answer and
  address: the counts-only view is the page under Ledighetsansökningar, not the archive.
- *The export format stays version 1*: five columns were appended to `ledigheter.csv` and a file was added, which a reader by
  column name does not notice.

### 18.3 Operations

- Requests that wait for a guardian more than a week: `SELECT r."schoolId", count(*) FROM "LeaveRequests" r WHERE
  r."consentRequired" AND r."status" = 'PENDING' AND r."createdAt" < now() - interval '7 days' AND NOT
  app.leave_consent_met_raw(r."id", r."schoolId") GROUP BY 1` (as the owner).
- The pass: `SELECT "day", "runs", "failures", "counts", "lastFinishedAt" FROM "JobRuns" WHERE "job" = 'leave-consent'
  ORDER BY "day" DESC LIMIT 5`; a day with nothing due counts `{notices: 0, reminded: 0}`.
- Release note (in these words or others): *A school can now choose how it receives a leave request: that every guardian
  must consent before it goes to a decision, the fewest days ahead, and a temporary contact during the leave. All three are
  off until the school's administrator turns them on under Ledighetsansökningar.*

## 19. Terms in the generator ("Terminer i motorn")

The generator plans every week the school teaches. A timplanspost that runs
until December and one that runs from January never share a week, so they may
share an hour, a teacher, a room and the pupils, and no pre-flight count adds
one term to the other. Before this, a dated post was held all year, and a
teacher with 1,370 minutes of hemkunskap in each term was refused for 2,560
against 2,250.

Two changes, in two releases. No migration in either.

1. **The engine** takes three optional fields: `periods` on
   `AnonymousRequirement` and on `FixedLesson` (a mask over the periods of the
   läsår the entry runs in) and `periodWeeks` on the request (how many real
   weeks each period is; weights for what the engine measures, never a rule).
   Absent, every entry runs every week, as before. A payload without them
   builds the model it built, byte for byte (`benchmarks/model_identity.py`),
   so this release changes nothing in production on its own.
2. **The gateway** reads the posts' and the preserved lessons' dates against
   the läsår, week by week (`src/optimization/year-periods.ts`), and sends the
   fields for a school whose dates tell two weeks of the läsår apart (see
   "Which schools are affected" under 19.2). A refusal counted in one period
   carries `period` (an index) from the engine; the gateway adds
   `periodFrom`, `periodTo` and `periodStretches`, and the web shows them
   under the refusal. A refusal every week with posts shares to the figure
   carries none, and neither does one that reads no post (a dining hall too
   small for the classes). A year whose posts all lie in one part of the
   läsår has one week to count, and a refusal its posts make says that part.

   A läsår is cut by every dated post, so a term is several periods (the
   school this was built for has six, the first of them the two days before
   the first Monday), and by nothing else: a week with no school day is no
   period (19.9). A refusal some weeks share says each of them: `period`
   is the first and `periods` all of them ("0,1,2,3"), the form a week that
   lies in several periods already had, and the gateway reads their
   stretches together, so a teacher over her hours all autumn is told the
   autumn's weeks and not its first two days. "Share" is one rule, for a
   count, a 400 and the lines of a best possible timetable alike
   (`optimization-engine/app/solver/refusals.py`): the same sentence (the
   code), the same figures, and the same posts, rooms, rules and people the
   refusal names, in any order. A 400 names what it names in its figures, so
   two terms with other posts and the same figures are one 400 and two
   counts, each naming its posts. Weeks that no words say exactly (the odd
   weeks of one term with every week of the other) leave the first of the
   weeks that give it.

   **When the weeks are refused differently, the refusal said is the one
   whose weeks are most of the year** (`periodWeeks`; every period alike
   where none is sent), and the earliest on a tie. A läsår starts on a
   Saturday, so its first two days are a period of their own, and a teacher
   with a post of her own from the first Monday is over her hours there with
   other figures than in the autumn: it is the autumn that is said. Each
   week gives its first refusal, in the order the counts are made, and it is
   among those that the most weeks is chosen: a refusal a week would also
   give, but only after an earlier count, is not weighed (a count says the
   weeks it refuses the same behind an earlier count, once it is the one
   said, and a 400 has no such weeks). The weeks are weighed by
   `periodWeeks`, where the odd and the even weeks of a period count as many
   each, so "most" is most to within a week a period, unless the gateway said
   how many of them are odd (`periodOddWeeks`, 19.8): then they are the real
   ones. Weeks with nothing to
   place are not asked. Where no week was left out, two weeks that agree name
   none; where a week was, they name none only if the year without a post of
   its own is refused the same way: a teacher's trouble is named by where it
   is and not by how the posts are cut. The gateway asks each stretch of a
   period on its own, by the ISO weeks it holds, and names only the stretches
   that hold a week of the parity the engine counted (week 53 and week 1 are
   both odd): a period that has none of that parity is left out, and so is a
   lone week of the other parity before a longer stretch. A stretch that is
   named is named whole, with the other parity's weeks inside it. Where none
   of the periods named has a stretch of the parity (the engine counted the
   even weeks of a period that is week 53 and week 1 alone), nothing is left
   out and the dates stand as they came.

   Three verdicts solve a model instead of counting (the lunch stage, a
   class's hours, the year's tightest week). They run on at most eight weeks
   and stop at the first that refuses, and no more are solved to learn which
   other weeks share the verdict: `period` there is the week it was found
   in, and the handbook (4.2) says that it may hold in more.

A third release, on top of these, reads a post's days and a teacher's own
lunch period by period: 19.5. A fourth reads them by parity too, and no longer
counts or names a cell that no real week is in: 19.8.

### 19.1 Deploy order

**The engine first.** Its request models forbid unknown fields
(`extra="forbid"`), so an engine without `periods` answers 422 to every run
that carries one. The API and the engine deploy from `main` within about two
minutes of each other and not atomically, which is why the engine's change is
its own release, merged and verified before the gateway's.

1. Merge the engine's release. Verify that
   `https://<solver-host>/openapi.json` names `periods` under
   `AnonymousRequirement` and `FixedLesson`, and `periodWeeks` under
   `OptimizeScheduleRequest`.
2. Merge the gateway's release. No migration, no setting to turn on: a school
   whose dated posts or dated preserved lessons tell two weeks apart is sent
   periods from its next Generera, and every other school sends the payload
   it always sent.
3. Verify with a school that has dated posts: Generera's refusal, if it has
   one, now says the weeks it was counted for; a school with posts by term
   that was refused for a teacher's hours is laid.

### 19.2 Rolling back

- **The gateway alone.** Safe at any time. The older gateway sends no
  periods, and the engine reads every entry every week again: the reading
  before this release, stricter and never looser. A school with posts by
  term may again be refused for hours counted across the terms. Timetables
  already written stay as they are; they keep every rule in every real week.
- **The engine alone, past its release, with the gateway's release still
  out.** Every Generera and every schemaförslag run of a school that is sent
  periods fails, and only those: every other school's payload is byte for
  byte what it was. The engine answers 422 (`extra_forbidden` at `periods`
  and `periodWeeks`), and the gateway says it as 503 `ENGINE_LACKS_PERIODS`:
  the run fails with "Schemamotorn är äldre än resten av tjänsten och kan
  inte planera poster med datum ännu. Försök igen om några minuter." (in
  English for an English reader), on Generera and among the schemaförslag.
  Redeploy the engine, or roll the gateway back with it. The gateway does
  not retry without the fields, on purpose: a timetable laid without them
  would be the old, stricter one, and a school would not be told.
- **Which schools are affected** (as the owner): a school with a dated post,
  or with a dated lesson that a regeneration keeps
  (`src/optimization/preserved-lessons.ts`: hand-made, locked and not written
  from a förläggning, opened to a second class, or given named pupils),
  `SELECT "schoolId" FROM "TeachingRequirements" WHERE "startDate" IS NOT NULL OR "endDate" IS NOT NULL UNION SELECT l."schoolId" FROM "MasterLessons" l WHERE (l."startDate" IS NOT NULL OR l."endDate" IS NOT NULL) AND (NOT l."isGenerated" OR (l."isLocked" AND NOT l."fromPlacement") OR EXISTS (SELECT 1 FROM "MasterLessonGroups" g WHERE g."masterLessonId" = l."id") OR EXISTS (SELECT 1 FROM "MasterLessonStudents" s WHERE s."masterLessonId" = l."id"));`
  The second half is that file's rule, arm for arm, and reads only. (A
  generated lesson with dates that the rule does not keep has them from its
  post, so the first half finds its school.) Every school that is sent
  periods is in the list, whichever läsår the dates are in, and a few of the
  schools it finds send no
  periods: dates that cut no week apart (a post dated to the whole läsår, or
  outside it) send none, and neither does a school whose only dated posts
  are the two terms of a block on another block's times WHEN THE TWO TERMS'
  WINDOWS MEET, week by week (the autumn until a Sunday, the spring from the
  Monday; or neighbouring weeks). The leader post holds the block's times in
  every week of its link, so such a year has no week unlike another. A link
  with a whole week between its terms that neither post covers (a jullov
  outside both windows) does tell weeks apart: the leader post lets those
  weeks go, and the school is sent periods like any other, unless the
  school's own lov closes every weekday of those weeks (19.9): they are then
  no weeks of the cut, no week with school tells the terms apart, and none
  is sent. "Dela terminsvis
  i halvklass" writes windows that meet when only the spring's first day is
  given; two periods of one's own, or dates edited by hand, can leave a gap.

### 19.3 What is still read more strictly

Never more leniently than a lesson placed by hand
(`weeksCanOverlap`, `src/calendar/lesson-recurrence.ts`), except in a week
with no school day (19.9), and in these places more strictly than the real
weeks:

- A week is Monday to Sunday. Two posts whose windows share a week without
  sharing a date (one ends on a Tuesday, the other starts on the Wednesday)
  are held apart.
- Reservations — availability rules, uppdrag with dates, another school's
  lessons, room loans — are every week's.
- A subject's distribution (`lockedDays`) carries no weeks, and is held in
  every part of the läsår.
- A post's days and a teacher's own lunch are read period by period (19.5),
  and NOT by parity: the weekdays a teacher's preserved lessons hold in odd
  weeks are held against the even weeks of the same period too, and the
  lunch is one hour for both. That is the reading before periods, unchanged.
- A leader post of two blocks on the same times is held in its follower's
  weeks too.
- A large pool of interchangeable rooms that holds lessons of every week
  beside lessons of a term gives a room to one or the other for a whole day
  (`NAMED_LIMIT`, `optimization-engine/app/solver/room_allocator.py`); a
  small pool names its rooms and is exact.
- A row over a school's lessons at once is cut into at most eight parts
  (`PART_LIMIT`, `ROW_LIMIT`, `optimization-engine/app/solver/weeks.py`). A
  teacher's or a class's own rows are always cut exactly.

**One of these refused a timetable that exists: a class's meal** (the review
of #300, 2026-11-12; the reading `main` already had), until 19.7. The meal was
one start a day all year: `lunches` in the answer had no period, and
`LunchSittings` held one row per class and weekday of a läsår. A class lock
11:00–11:30 in the autumn and one 11:30–12:00 in the spring, in a window
11:00–12:00 for 30 minutes: each term has a break, and Generera answered 400
`LUNCH_LOCKED_LESSONS_LEAVE_NO_BREAK` ("Låsta lektioner lämnar klassen …
ingen lunchlucka"). A förlagd post is a lock to the engine, so a post förlagd
in the autumn and one in the spring, in the same class's lunch window on the
same weekday, was the same case.

That is the reading of a request **without `lunchPerPeriod`** (an engine and a
gateway that predate 19.7, or a school with no periods or no lunch), and it
is still exact: the refusal names the periods whose locks take a start of the
window, in parts (`lockPeriods`, "0,1,2,3;4,5": periods whose locks take the
same starts have commas between them, the parts semicolons, and the first
two parts are two that close the window between them), and the gateway reads
each part's periods as one run of weeks and adds the days of the first two
parts (`lockFrom`, `lockTo`, `otherLockFrom`, `otherLockTo`, and
`lockWeeksElsewhere` for the stretches not written out). The way round, then,
was to move or unlock one of the locks.

With `lunchPerPeriod` (19.7) the meal is planned per part of the year, and the
refusal is a period's own: it carries `period` (and `periods`, when the weeks
counted lie in several) and never `lockPeriods`, because it is raised only
when one period's locks close the window alone.

A meal per period needs dates on `LunchSittings` and
`PublishedLunchSittings`, an exclusion constraint in place of the unique key,
and every reader of the tables (19.6), and a planner that lays one (19.7).

### 19.4 Operations

- The engine's pre-flights run once per period (and per parity inside it).
  The ones that solve something — the lunch stage, the year's load — run on
  at most eight of them, the heaviest; the others are left to the model.
- A läsår longer than 53 weeks is sent without periods (the engine reads at
  most 53), and is planned as before.
- Schemaförslag computed before the gateway's release go stale ("inaktuellt")
  once, for a school with a dated post or a dated preserved lesson: the
  candidate basis (`src/optimization/candidate-basis.ts`) now reads the
  periods and the locks' own dates, so its digest is another. Those candidates
  were computed under the stricter reading; the school runs the proposals
  again. Every other school's basis is the digest it was.

### 19.5 A post's days and a teacher's own lunch, by period

A third release on top of the two above; no migration. Until it, two of a
teacher's rules were read for the whole läsår and refused years whose every
term has a timetable (the reviews of #300):

- **The days of a post.** The weekdays a teacher's preserved lessons hold
  were held against every week the teacher has: a post of two days and a
  lock on Mondays in the autumn only left the spring one day
  (`TEACHER_WORK_DAYS_CANNOT_BE_KEPT`). The gateway now reads every week of
  the läsår and sends each set of weekdays with the periods some week holds
  it in — `lockedWeekdayPeriods` on a day limit, beside `lockedWeekdays`,
  which stays — and the engine holds a week against the sets of its own
  periods. Sent only for a teacher whose periods differ
  (`lockedWeekdaySetsByPeriod`, `src/common/teacher-day.ts`).
- **A teacher's own lunch.** One hour all year, clear of every lock and
  lesson of the year, is now one hour in each period, clear of that
  period's. Nothing new is sent: the locks and the posts already carry their
  periods. `TEACHER_LUNCH_LEAVES_NO_START` is read period by period and
  names where in the year it is — every period in which the teacher has a
  lesson to place and her lunch that weekday is refused the same (the same
  rule, day and cause, whatever locks close it; `period`, and `periods`
  where there are several, which the gateway reads as one run of weeks: a
  läsår has more periods than terms) — unless the locks of every period
  refuse it, which is the year's refusal and names none.

**Deploy order.** The engine and the gateway are one release here. The
engine's models forbid unknown fields, so in the minutes between the API's
deploy and the engine's a run that carries `lockedWeekdayPeriods` is
answered 422 by the older engine, and the gateway says it as 503
`ENGINE_LACKS_PERIODS` ("försök igen om några minuter"), as for `periods`
(19.2). Only a school with a post that limits days AND preserved lessons
whose weekdays differ between periods sends the field; production had no
post with a day limit when this was written. Afterwards
`https://<solver-host>/openapi.json` names `lockedWeekdayPeriods` under
`AnonymousTeacherDayLimit`.

**Between periods is not between terms.** A läsår that starts in the middle
of a week (2026-08-15 is a Saturday) has a first, incomplete week, and as
soon as a dated post starts on the first Monday that week is a period of
its own: one week, of one parity. A teacher whose preserved lessons run on
one weekday in the odd weeks and on another in the even ones then holds
one of the two sets in that period and both in the rest of the year, and
the field is sent though no term differs from another
(`periodWeeks: [1, 43]`, the odd weeks' set in both periods and the even
weeks' in the second). The reading is right — the first week is held to
what a week of its parity holds — and the school's schemaförslag go stale
once, as for every school that is sent the field.

**Rolling back** is 19.2's: the gateway alone is safe (the older gateway
sends no `lockedWeekdayPeriods`, and the engine holds every set in every
week again, the stricter reading); the engine alone, past this release,
fails the runs that carry the field with the same 503.

Schemaförslag of a school that is sent the field go stale once, as in 19.4:
the candidate basis reads it.

### 19.6 A class's meal holds weeks ("Klassens måltid per del av läsåret")

The first release of a class's meal per part of the läsår: the tables and
every reader of them. **Nothing writes a date yet**, so no school sees a
difference. 19.7 lets Generera lay one meal per part; a school dating a meal by
hand comes after it.

**The migration** `20270209090000_klassens_maltid_har_ett_datum`
(sha256 `14e0064464ef922dcc5037c38efbdaed81a160b88a6fca27454a456e3bd26b56`).
`LunchSittings` and `PublishedLunchSittings` get `startDate` and `endDate`
(`date`, nullable, no default, no backfill: every row there is, and every row
the API before this one writes, is NULL and NULL, the whole läsår). They are
the first and the last day the meal holds, a Monday and a Sunday (a CHECK
each, and one that they are in order), NULL for the läsår's own bound; the
names and the meaning are `MasterLessons`', and the window is whole weeks
because the generator plans in whole weeks. The unique key
`LunchSittings_group_day_key`, and the unique index on
`PublishedLunchSittings`, are replaced by `EXCLUDE USING gist` over the class,
the weekday, the läsår (the publication, for the snapshot) and
`daterange("startDate", "endDate", '[]')`: a class has at most one meal on a
date. A row with no dates meets every other row of its class and weekday,
which is what the unique key said. No policy, grant, function or trigger is
touched, and no policy names a date (section 475 asks).

**Deploy order** is 2's: migrate first, then merge. The file takes both tables
`ACCESS EXCLUSIVE` first, `NOWAIT` and together, in a loop with a 30 s
deadline (a request holds them in both orders: Generera writes
`LunchSittings`, a publication reads it and writes the snapshot). It has a
`$$` body, so Prisma runs it as one transaction; if the loop gives up nothing
is changed, and `prisma migrate resolve --rolled-back
20270209090000_klassens_maltid_har_ett_datum` then `migrate deploy` again is
all it takes (shown on a throwaway database with a session holding one table
for longer than the loop waits: the P0001 message above, no column added, the
old key still there). The tables hold a row per class and weekday (25 in
production on 2026-11-13, none placed by hand, none published), so the two
indexes build in milliseconds inside the lock. Run it in a quiet window and
read `pg_stat_progress_vacuum` first, as 2 says of every NOWAIT migration.

**The one thing the minutes between the migration and the deploy cost.** The
API before this release places a meal by hand (`POST
/api/v1/lunch-sittings`, the grid's click on an empty slot) with a Prisma
`upsert`, which Prisma 7 writes as `INSERT … ON CONFLICT ("academicYearId",
"studentGroupId", "dayOfWeek") DO UPDATE`. An exclusion constraint cannot be
the arbiter of an `ON CONFLICT` list, so with the unique key gone that
statement fails (SQLSTATE 42P10; measured on the throwaway database: "there
is no unique or exclusion constraint matching the ON CONFLICT
specification"). The administrator who places a meal in those minutes sees
the grid's error toast and the meal is not placed; placing it again once the
new API serves works. Nothing else reads the key: Generera writes with
`createMany`, `update` and `deleteMany`, and the readers select named
columns. The new API places by reading the class's meals of the weekday first
and writing after, and a write that meets the constraint at once (two
placements for one class and day, neither seeing the other) is a 409
`WRITE_CONFLICT` ("försök igen"), not a 500.

**What reads the weeks** (every reader asks `src/common/lunch-window.ts`, and
the browser `web/lib/lunch-window.ts`, which read a date alike): the calendar
(`CalendarService.materialise` lays each date's meal from the sitting that
holds the date, none in the weeks no sitting holds), the publication's
snapshot (`snapshotSittings` and `readPublishedSittings` carry the dates, so a
refill lays each week's meal), the swap board and the klasslärare's schedule
(`readBoardFacts`, `boardCodeOf`: a lesson is held to the meals of its own
weeks, a lesson with no weeks to all of them, a dated board to the meal of its
date), the schedule exchange (`ON_LUNCH_SITTING`), the admin grid (a meal's
weeks in its label, the check against every meal of the weekday) and the
kitchen's flow (a day to show, only when some meal holds weeks). The
rollover copies no meal (`LunchSitting` is skipped) and the mobile app and
Måltidskollen read `CalendarLunches`, which are dated already.

**Before and after.** `prod-fore.sql` and `prod-efter.sql` (read-only, one
`SELECT` per row: `check, got, expected, ok`; text fingerprints ordered with
`COLLATE "C"`, since production sorts `en_US`) ask: the migration pending or
run; the four columns; the six CHECKs, validated; the two exclusion
constraints and their indexes; the old key and index gone; no row with a date;
the row counts and md5 of the rows equal before and after; the policies'
names, commands and md5 equal; the privileges per role (`has_table_privilege`
per role, not as the owner); no MAINTAIN on 17; the md5 of every `app.*`
function equal (no function is touched); no session holding either table in a
transaction. Rolling back the code keeps everything but placing a meal by hand:
older code never names the columns, but its `upsert` meets the constraint
instead of the unique key and answers 500 (SQLSTATE 42P10), as in the minutes
before the deploy, until the new code serves again (moving and removing a meal
work). Rolling back the migration is not a one-liner once a row has a date:
restore the unique key only after the rows that share a weekday are reduced to
one per class, year and weekday.

**Tests.** RLS sections 475 to 479 (`rls-owner-checks.sql` 475 to 477 and 479,
`rls-policies.sql` 478): the catalogue, what the constraint tolerates and
refuses (53 weeks of one class and weekday; an update into a conflict; every
CHECK), the snapshot's, what each role reads and writes, and the cascades; the
*Meal per term probe* in CI runs the oracle over the calendar date by date,
the snapshot, the placement and its race, and the board's reader.

### 19.7 The generator plans a class's meal per part of the läsår

The second release of "Klassens måltid per del av läsåret": Generera lays one
meal for each part of the year its class's locked lessons tell apart, and
writes the answer as the dated rows 19.6 made room for. There is **no
migration**: the tables are 19.6's, and a school that never gets a second
meal in a day writes exactly the rows it wrote.

**The request.** The gateway sends `lunchPerPeriod: true` beside `periodWeeks`
when the läsår is cut into periods (a dated post or lock, 19.1) and the school
has a lunch rule; nothing otherwise, so every school without a dated post, and
every school without a lunch rule, sends the payload it always sent, byte for
byte. A hand-placed meal is still a pin on every period (no meal can be dated
by hand yet). The engine answers each meal with `periods`, a mask over the same
periods a post's mask is over, **only on a class and day whose meals differ**:
a class whose parts come to eat at one time is answered with the one meal and no
mask, as before.

**What a part is.** A group of periods in which the class's meal is held the
same way: its locked lessons (a förlagd post is one) leave it the same STARTS
on every day (the starts of the lunch window that remain, not the lessons: a
lock that runs to 12:30 and one that runs to 12:15 leave a window ending at
12:00 the same starts) and the same meals are placed in them. A pinned lesson
(§21) cuts the year as a locked one does, by the starts it takes together with
its pupils' changing minutes (21.3). **A school with a
dining hall too small for every class at once cuts all its classes by the
locks of all of them**: the hall is one resource the meals share, so a class
with no lock of its own can need one time in the autumn and another in the
spring because another class's locks leave the hall no other way to seat both
(without this the school was refused though a timetable existed). A hall that
seats the whole school at once couples nothing. A lesson that is neither locked
nor pinned cuts nothing: it is laid once and keeps clear of the meal in every week it
runs. Parts are cut per period, never per parity (the meal is one for the odd
weeks and the even weeks of a period, as a teacher's own lunch is, 19.3), and
never joined: a class whose locks are alike in every period is one part and
builds the model it built. The model has one start per part and day, the
class's and the pupils' no-overlap rows read only the weeks of the part, the
dining hall is counted in each real week, and a soft term (the weight of the
drift between days) makes the parts eat alike where the locks allow, so a meal
is split only where a lock forces it. The raster read the meal of every part
(never a rast before a meal in some week); the pupils' håltimmar are measured
after the class's first part (a known approximation: only a class with several
parts and a cohort measured after its meal sees it).

**The answer as rows** (`src/optimization/lunch-parts.ts`). A mask is written
as one row for each run of neighbouring weeks of its periods (`YearPeriods.
stretches`), the läsår's own first and last day as NULL, never as the Saturday
a läsår may start on (the CHECKs want a Monday and a Sunday). The solver's rows
(`isGenerated`) are replaced as before and a hand-placed row is kept. An answer
whose masks are not a partition of the periods (a period with no meal or two, a
mask on a lone meal, a mask in a year without periods) is not written at all:
502 `ENGINE_MEALS_INCONSISTENT`, and the transaction rolls back. A
schemaförslag keeps the mask with its meals (`lunches` in the stored candidate),
so an apply writes the same rows.

**Deploy order** is 19.1's: the engine first, then the API. An engine that
predates the field refuses `lunchPerPeriod` as an unknown one, which the
gateway reads as 503 `ENGINE_LACKS_PERIODS` ("Försök igen om några minuter"),
the same as a post's mask it does not know: never sent again without it, since
a year laid without it would be the stricter, refused one, unsaid. **Only
schools with dated posts or locks and a lunch rule are touched.**

**Schemaförslag go stale once.** The key is in the candidate basis (the rules
part) of exactly those schools, so a schemaförslag solved before the release
reads as stale after it, as in 19.5, and is solved again. Every other school's
basis hashes what it did.

**Rolling back** is 19.2's. The gateway alone is safe (the older gateway sends
no `lunchPerPeriod`, and the engine plans one meal a day all year again: the
refusal of 19.3 is back, and the rows already written stay readable, since 19.6
reads them). The engine alone, past this release, fails the runs that carry the
field with the 503 above.

**Tests.** `optimization-engine/tests/test_lunch_parts.py` (the contract, the
year the old reading refused, the identity of a class whose locks are alike, the
period's own refusal, pins by period, the hall counted per week and coupling the
classes, the validator that checks the answer's meals in every real week:
`benchmarks/validate_schedule.py`), `src/optimization/lunch-parts.spec.ts` (the
rows of a mask), `optimization-proxy.service.spec.ts` (from the periods the
fetch read, through an engine answer with masks, to the rows: in Generera and in
the apply of a schemaförslag), `schedule-candidates.service.spec.ts` (a stored
meal keeps its mask) and `ai-engine-contract.spec.ts` (the key). **No CI job
runs the real engine through Generera**: the *Meal per term probe* (19.6) reads
the calendar over rows it plants itself and calls no engine. The whole path (a
real engine, a real Postgres, Generera, the calendar read date by date) was run
by hand before the release and is not re-run by CI; the engine's own answer is
checked in every real week by `benchmarks/validate_schedule.lunch_problems`
inside `test_lunch_parts.py`, and `benchmarks/lunch_flag_identity.py` measures
that a request whose classes' starts are alike builds the model it built.

### 19.8 A teacher's lunch and days, by parity

A fourth release, on top of 19.5; no migration. The odd and even weeks of a
period were held together by a teacher's two rules, and a week of one parity
was refused a day or an hour the other parity's lessons take (the review of
#302: 20 of 1 700 small worlds, every one with locks or days that differ
between odd and even weeks).

- **The days of a post.** `lockedWeekdayPeriods` entries get an optional
  `recurrence` (`ODD_WEEKS` or `EVEN_WEEKS`; absent is both) and a week is
  held against the sets of its own parity. The gateway sends it only where
  some period's odd and even weeks hold other sets, after what a larger set
  implies is left out inside each parity
  (`lockedWeekdaySetsByPeriod`, `src/common/teacher-day.ts`); a teacher whose
  parities agree in every period is sent the list she always was. A period
  with weeks of one parity only (the läsår's first, incomplete week) is read
  as that parity's sets for both. The engine reads the field with
  `weeks_of`, so every rule that asks which sets a week is held against asks
  it of the parity too. **A läsår nothing dates is one period** (the review
  of #320, MEDEL-1): a school with A/B-weeks and no dated post sends the
  parity sets too, as entries whose `periods` is a mask of one period (the
  engine takes `min_length=1` there and reads it as the year without
  periods), and no `periodWeeks`. An older engine refuses that as it refuses
  the field, and the gateway says it as the same 503.
- **A teacher's own lunch.** One break a period for both parities, as
  before, except for a teacher whose lessons or locked lessons in her lunch
  window are told apart by parity (`weeks.needs_a_part_per_parity`): such a
  teacher has a break for each odd and even week of each period, clear of that
  week's lessons and locks, and a refusal of her lunch before the model says
  `parity` beside the periods when it is one parity's. A request in which no
  teacher is so told apart builds the model it built, byte for byte
  (`benchmarks/model_identity.py`).
- **A cell no real week is in** (`periodOddWeeks`; the review of #304,
  MEDEL-2). The engine's week is a period in a parity, so a period of one week
  (the läsår's first two days, a test week, the weeks between terms) had a
  cell for the other parity that no calendar has: a post of the odd weeks
  dated into a period that is one even week was held, counted and built
  there, and a school whose every real week fits was refused for it; and a
  refusal of the real week said "the even weeks" of a period that has no
  others. The gateway now says how many of each period's weeks are odd
  (`periodOddWeeks`, in the order of `periodWeeks`, and beside it wherever it
  is sent). A period with weeks of one parity alone is the first, incomplete
  week of a läsår that starts on a Saturday once a post is dated from the
  first Monday (its two first days are then a period of their own, one odd
  week: the production's läsår), and a test week or a week between two
  terms in which school is taught (a week the lov closes is no period, 19.9). The engine takes a post of a parity out of the
  periods that have none of it (one that would then run in no week at all is
  left as it came), asks nothing of a cell no week is in (the counts, the
  lunch read week by week, the lines of Bästa möjliga schema), says a period
  whole where its only real week is ("period 1", not "the even weeks of
  period 1"), and fills such a period in when it decides whether the words
  say exactly the weeks a refusal is given in. A request without the field
  is read as it was. Where the field is sent it is read in every dated year:
  it weighs the weeks a refusal is chosen by (below), and it changes what is
  built, counted and named only where some period has no week of a parity.
- **Which refusal is said** (the same review, LÅG-1 and LÅG-2). Where the
  field is sent the refusal is chosen by the real weeks that give it (an odd
  and an even week were as many in a period of three), and weeks that no words
  say exactly are said as their first week and no more (before, as the first
  group of cells, which could hold a period whole beside another's odd
  weeks, and so name a period too many). A set is said filled in, a period
  whose only week is the real one beside its other cell, where that is a set
  the words say; where it is not, and the weeks as they are are, they are said
  as they are (`weeks.as_said`, asked alike of a counted refusal, a teacher's
  lunch, a solved refusal and a deviation): the refusal every odd week gives,
  in a läsår whose first period is one odd week, is "the odd weeks of periods
  0 and 1" and not the first two days of the year (the review of #320, HÖG-1).

Deploy and roll back as 19.2 and 19.5: the older engine answers 422
(`extra_forbidden` at `lockedWeekdayPeriods.N.recurrence`, or at
`periodOddWeeks`) to a request that carries either, and the gateway says it
as 503 `ENGINE_LACKS_PERIODS`. **`periodOddWeeks` is sent on every run of a
school that dates a post** (beside `periodWeeks`), so the engine's release
goes first (19.1): until it is live, those schools are told to try again in a
few minutes. The days by parity are sent only where a
teacher's parities differ (in a year nothing dates too: a school with A/B-weeks
and no dated post that has such a teacher is told to try again as the others
are), and production had no post with a day limit and no
locked lesson when this was written. Schemaförslag of a school that is sent
either field go stale once, as in 19.4: the candidate basis reads them.

### 19.9 A week with no school day is no week of the cut ("Lovveckor")

A fifth release, on top of 19.8; no migration. The engine is untouched: no
field is added, and `periods`, `periodWeeks` and `periodOddWeeks` say what
they said, of fewer weeks. The gateway alone is the release, so rolling it
back is 19.2's. The jullov of 2026 (22 December to 9 January) had made the
two weeks inside it periods of their own, solved and checked as school weeks
(`_solved_weeks`): six real weeks for the school it was found at where four
have school, and a refusal a week no lesson is written in gave (for example
`DEMAND_REQUIREMENTS_EXCEED_WEEK` for 4 January to 10 January) could block the
whole year.

- **The rule.** A week is without school when every weekday of it that lies
  in the läsår (Monday to Friday) is a day no årskurs has school: a break of
  the whole school, or breaks for years that together take every group of the
  läsår. It is publish's own reading (`noSchoolDays`,
  `src/calendar/publish-days.ts`, on `breakCoversGroup`): `kind` is not read (a
  studiedag closes a day as a lov does), a class closed on a date
  (`AvailabilityConstraint`) is not, and a group with no årskurs (a
  nivågrupp) is closed only by a break of the whole school. A week with one open
  weekday is a school week, so is a week no break touches, and so is the
  läsår's first, incomplete week when it has no weekday in the läsår (it
  starts on a Saturday: still a period of its own, 19.5).
- **What is sent.** Such a week is in no period: not in `periodWeeks` or
  `periodOddWeeks`, no entry is read against it and a teacher's days are not
  read in it (`weekPeriods` has null there). The one exception is a week that
  some entry is dated in and in no week with school (a post for the days of a
  lov only): the engine cannot be told that an entry runs in no week (it
  refuses a mask that names no period), and read as every period it would take
  its hour in every week of the year, so the weeks such an entry lies in stay
  weeks of the cut, as they were. An entry dated outside the läsår is still
  every period. The `stretches` that name days (a refusal's
  `periodFrom` and `periodTo`, a meal's rows) still tile the läsår: the week
  belongs to the period of the school week before it, so a period's dates run
  to the Sunday before the next one starts. A school whose school weeks do not
  tell apart any more is sent no periods. A school that dates nothing reads no
  break, and sends the payload it always sent.
- **What it loosens, and what reads it too.** Two posts that meet in no week but
  one with no school (an autumn post to 10 January and a spring post from 4
  January, for the same class, teacher or room) were held apart there. They
  are not now, and the generator may place them at one hour. So that nothing
  else calls that a double booking, the readers of the clash rule read the
  same weeks (`src/calendar/school-weeks.ts`, `meetOnlyInClosedWeeks`; the
  board's copy is `web/lib/closed-weeks.ts`, and one fixture,
  `src/calendar/__fixtures__/school-weeks-cases.json`, holds the two together):
  the hand edit (`findConflicts`), the year's clash read behind the publish
  check PUB_CLASHES (`yearClashes`), and the board (`detectConflicts`, on
  `/admin/timetable`, including its drag check). Two lessons are a clash when
  their dates and parities let them meet (`weeksCanOverlap`) **and** some week
  they can meet in has a school day; a clash in a week with school is still
  one. A lesson on a Saturday or a Sunday (`dayOfWeek` 6 and 7, which the
  hand edit and the imports take) is never narrowed: a week is closed by its
  Monday to Friday, and the weekend is written on a day no lov need take. `findConflicts` and the publish check read the year's breaks, its days
  and its groups when two lessons share an hour (one query for a year with no
  break). The other readers of `weeksCanOverlap` — the swap board
  (`swap-units.ts`), the room optimisation, the shared-room reads, the travel
  warnings, the placement search and the Förlägg i veckan mirror — still read
  the dates alone, the stricter reading: a slot they refuse is one the hand
  edit accepts.
- **Operations.** Every school with a dated post and a lov that takes a whole
  week (höstlov, sportlov, påsklov, jullov) is sent other `periodWeeks` and
  `periodOddWeeks`, so its schemaförslag go stale once, as in 19.4: the
  candidate basis reads both.

## 20. An administrator who teaches ("Administratör som undervisar", `Users.teaches`)

A rektor or a schemaläggare often teaches too. The investigation chose a mark on the person's row, not two rows per login and
not a set of roles: one person stays one `Users.id`, and the mark adds the teacher's own arms beside the administrator's, which
stay as they are. It is built in seven parts; **this is the first, the database, and it changes no behaviour**: the column is
false for every row, no policy asks for it, and the gateway, the web and the apps do not know it yet.

### 20.1 What 20270212090000 adds

- `Users."teaches"` (boolean, NOT NULL DEFAULT false: a constant default, so the table is not rewritten) and the CHECK
  `Users_teaches_is_a_teaching_administrators`: true only on a `SCHOOL_ADMIN` of the profile FULL, REKTOR, SCHEMALAGGARE or
  EXPEDITION, never on a läsare (LASARE) and never on anybody else. The list of profiles is positive, as the HR-läs CHECK's is.
- `UserRoleChanges."fromTeaches"` (NULL where there is no earlier value: a creation, and every row written before) and
  `"toTeaches"` (NOT NULL DEFAULT false, which is true of every old row).
- `app.current_user_teaches()`, the seventh of the helpers that pick the caller's row, with the clause RLS section 10 holds equal.
- The three trigger functions of 20261110090000 are **patched from the catalogue** (`pg_get_functiondef`, named text changes with
  the number of places they must occur in): the profile trigger zeroes the mark when the row is not an administrator of a
  profile that writes (a role change, a läsare), the decision trigger counts the mark as an administrator's change (only rektor
  and a full administratör set or take away the mark, as they alone change role, profile and HR-läs), and the log writes both
  values. If a body is not as expected the migration stops with nothing changed. The two triggers that name columns name `teaches`.
- Beslut 6: a person who teaches has a post. `Users_teaching_has_a_post` refuses the mark (SQLSTATE `TE409`) for a person with no
  `TeacherEmployments` row for **any** läsår of the school, and
  `TeacherEmployments_a_teaching_administrator_keeps_a_post` refuses to remove the last such row while the mark stands (`TE410`),
  and refuses to move it to another person (an `UPDATE` that changes the post's `userId` or `schoolId` is judged as a removal
  from the person it leaves; the trigger fires on `DELETE OR UPDATE OF "userId", "schoolId"`, so an ordinary change of a post's
  percent, signature or note pays nothing).
  Any läsår, not the current one: Aktivera flips a flag and the rollover only inserts, so a rule about the active year would
  stick on every year switch. A person's deletion and a school's are not refused (the cascade asks whether they still exist);
  a läsår's deletion that would take a marked person's only post is: switch the mark off first. Both checks lock the person's
  posts `FOR SHARE`, so a mark set while the last post goes (or is moved away) cannot slip through; of two last posts removed
  together one ends with 40P01.

### 20.2 Deploy order and operations

- **The order is the migration, then the merge.** The API before this release does not name the column; it writes Users without
  it (false) and reads `UserRoleChanges` without the two new columns.
- The migration takes `Users` and `UserRoleChanges` in ACCESS EXCLUSIVE and `TeacherEmployments` in SHARE ROW EXCLUSIVE, NOWAIT,
  all three together, in a loop that retries every 50 ms for 30 s and holds nothing between tries (a reader of Users and a writer of
  a post are not queued behind it: measured 0.07 s and 0.08 s while it waited five seconds for a lock). If the three are not free at
  once in 30 s it stops with nothing changed, and says so: Prisma then marks the migration failed and refuses every later
  `migrate deploy` (P3009) until `prisma migrate resolve --rolled-back
  20270212090000_en_administrator_som_undervisar_har_en_markering_och_en_post` has been run (the error names it), then deploy again.
- No existing row is touched. The checks before and after are `teaches-pr1-data/prod-fore.sql` and `prod-efter.sql` in the round's
  notes (one SELECT per check, `public` and `app` only, `COLLATE "C"`): the three trigger functions' `md5(prosrc)` before and
  after, the md5 of every other `app` and `public` function, of every policy and of the other CHECKs on Users equal before and
  after, no person marked, no log row that names a mark.
- **Until the gateway learns the field (part 2) nobody can set the mark**, except the database's owner. A person who is set
  by the owner needs a post first; an administrator cannot be created with the mark in one statement (TE409: create, give a
  post, mark). The mark is written with an UPDATE, never as part of an upsert's create half.
- **Rolling back:** the column, the CHECK, the helper and the triggers can stay; nothing reads them. To remove them, take the
  mark off every row first (the CHECK and the post check do not mind), then drop the triggers, the three new functions and the
  columns, and put the three trigger functions back from 20261110090000.

### 20.3 Tests

RLS sections 490 to 494 in `rls-policies.sql` (the catalogue and the helper through both API roles; who sets and takes away the
mark and what zeroes it; the post in both directions; the log, and the same person marked and unmarked seeing the same rows in
every table a teacher's arm names; the guard that lists every policy and function that names TEACHER without asking for the
mark, which is parts 3 and 4's worklist) and 490o and 492o in `rls-owner-checks.sql` (the CHECK alone with the triggers off, the
owner held to the post, a school deleted in both orders its cascade can take). Section 116's matrix has a marked full
administratör as an eleventh principal, and the *Admin areas* probe (`probe-admin-areas.ts`, `ar-i`) shows the codes arrive
through the adapter as themselves.

### 20.4 Part 3, the database: the teacher's own arms (20270216090000)

The second database part, and the first that **asks for the mark**. 16 policies on ten tables get `app.current_user_teaches()` in
OR with the teacher's test; nothing changes for a person who is not marked, and **nobody is marked in production** (one
administrator, no mark), so a merge changes no answer there. Merge this part **before** part 2 (the gateway): the note to the
substitute is a slice across both, the database's arm is right without the route, and the route is safe without the arm (the
database refuses).

- **The arms** (`TO authenticated` unless said; `authenticated` is a role the API's `app_authenticated` is a member of, so these
  apply through the API and through PostgREST's door alike): `AttendanceRecords` `attendance_teacher_insert`/`_update`,
  `AvailabilityConstraints` `availability_teacher_modify`, `TeacherAbsences` `teacher_absences_own_insert`/`_select`/`_update`,
  `TeacherAbsenceCovers` `teacher_absence_covers_own_select`, `TeacherDuties` `teacher_duties_teacher_own_select`,
  `TeacherEmployments`/`TeacherEmploymentPeriods`/`TeacherEmploymentLogs` `teacher_*_teacher_own_select`, `TeacherWorkRules`
  `teacher_work_rules_teacher_own`, and, `TO app_authenticated`, the four `lesson_substitute_notes_teacher_*` arms of
  `LessonSubstituteNotes`. The form is one OR inside the arm's own teacher test, in the arm's own style (an initplan, no new
  permissive arm, so no new `BitmapOr` on a hot table); RLS section 505b holds each to "main's arm with the mark added" by md5.
- **What it adds.** Through PostgREST an administrator has no arm on a person's own post, period, log, duty, absence or cover
  decision; a marked one reads exactly their own, which is what the web pages of "Min undervisning" read. Through the API the
  answer is unchanged for every profile that writes DRIFT and PLANERING; the one that does not write PLANERING (the expedition)
  gains the teacher's right to write their own unavailability and working-time rules, which is the arm's purpose. The one place
  the teacher's arm gives **more** than the administrator's is the note to the substitute (an administrator has none, section
  232): a marked administrator who stands on a lesson (a `CalendarLessonTeachers` row that is not the substitute's, or the absent
  teacher of a cover decision on it) **and has a post for the läsår of the lesson's student group** reads, writes, changes and
  removes it; never as the lesson's substitute (beslut 4). `app.lesson_teacher_role` carries that rule, so the gateway can ask the
  same function the database asks.
- **Five teacher arms stay**, because the administrator's arm for the same table, verb and role admits every row they admit
  (`CancellationBatchCredits`, `PublicationPendingRemovals`, `PublishedLessons`, `TeacherAbsenceReasons` `staff_select`,
  `TeacherDutySlots` `teacher_duty_slots_teacher_own_select`), and so do seven more policies (lektionsloggens three, where the
  administrator's DRIFT arm admits every lesson, and `StudentEnrollments`, `SupervisionCovers` ×2 and `SupervisionShifts`, where
  the administrator's select arm admits every row) and twelve functions that name TEACHER as an enum or a code, or narrow a
  teacher's own absence (which every markable profile may already edit, so narrowing a marked one would take a right away).
  Section 494 lists each as `STAYS` with the reason beside it, and a new arm that names TEACHER without asking for the mark
  fails there.
- **Three functions change and one is new**, read from the catalogue and edited at named places (each with the number of
  occurrences it expects; if a body is not as expected the migration stops with nothing changed): `app.lesson_teacher_role`
  (which asks the new `app.my_post_covers_the_year_of_group(group)`, and only of a marked administrator: a subquery in the
  function's WHERE is initialised at every call, a teacher's too, and cost +9 % on a read of 151 notes; the call costs +1 %; the
  new function is called by that one definer function alone and has no grant at all),
  `app.availability_constraints_keep_duty_blocks` (a marked administrator who does not write PLANERING is held to the teacher's
  `TD403` on an unavailability a duty blocks) and `app.cover_policy_arm_is_narrow` (it takes the one OR that is the mark as the
  teacher's test it extends, and refuses every other, as before; the migration re-runs 20261012130000's own guard before it
  commits, and RLS sections 28g, 112, 128 and 505e hold the rule).
- **Locks.** `ALTER POLICY` takes ACCESS EXCLUSIVE on its table (measured). The ten tables are locked first, `NOWAIT` and together,
  in one fixed (alphabetical) order, in a loop that retries every 50 ms for 30 s and holds nothing between tries. If they are not
  free at once in 30 s the migration stops with nothing changed and says so: Prisma then marks it failed and refuses every later
  `migrate deploy` (P3009) until `prisma migrate resolve --rolled-back 20270216090000_en_undervisande_administrator_far_lararens_egna_armar`
  has been run, then deploy again.
- **Run again by hand.** A second run on a migrated database stops at `CREATE FUNCTION app.my_post_covers_the_year_of_group`
  (already exists) and rolls everything back; by then the 16 policy patches have run a second time in the same transaction,
  which only the rollback undoes (measured on a scratch database: the policies and functions are byte for byte as before). One arm
  converted by hand before the FIRST run would get the mark twice (`... OR teaches OR teaches`), which RLS section 505b fails
  afterwards; the file stays as it is, because its sha256 is the one that ran in production.
- **Deploy order:** the migration, then the merge. The API before this release is untouched by it (nothing is marked), and the API
  after it needs nothing of it. **Checks:** `teaches-pr3-data/prod-fore.sql` (61 checks) before and `prod-efter.sql` (69) directly
  after, in the notes folder of the round's coordinator (`side-session-notes/local_487a7ffc-d4e9-44ea-9a93-ae6556fb4370/`, outside
  the repository, as part 1's are); they hold the `md5(prosrc)` of the three functions (and the new one's) and the md5 of the USING and WITH CHECK of
  the 16 policies before and after, that no other function or policy changed, that nobody is marked, the grants and MAINTAIN, and the
  migration rows. The same numbers are in the pull request.
- **Rolling back:** nothing reads the arms' answers for a person who is not marked, so they can stay. To remove them, run the
  edit the other way (each policy's text without the OR, and the three functions from their earlier migrations:
  20261203090000 for `app.lesson_teacher_role`, 20261022090000 for the duty guard, 20261012130000 for the leak rule; take each
  one's `CREATE FUNCTION` text, not a copy of this release's).
- **Tests:** RLS sections 505-509 (the arms are main's with the mark added; the five that stay; the own rows through both roles
  for each profile, marked and not; the note, its läsår and risk 3; the guards and what stays refused: the pool, klasslärare, a
  cover request, a class timetable change; every table through both roles equal but for the listed few) and 505o on the owner's
  side (every arm over every row of every school admits only the person's own); sections 494 (the list with a reason for each
  `STAYS`, and exactly what may ask for the mark), 493g and 116 updated; `scripts/test/teaches-arms-snapshot.sh` (a snapshot of
  every table x verb x principal x role on main's schema and the branch's, whose difference is only the marked principals on the
  converted tables); the bench `scripts/bench/teaches-arms.ts`; and `probe-admin-areas.ts` `ar-j` now waits up to 30 s for the
  second connection to be seen blocked.

### 20.5 Part 2, the gateway: it knows the mark (no migration)

The gateway reads `Users.teaches` and uses it; the web and the apps do not yet (parts 5 and 6). **No migration, no change to the
engine's contract, and nothing changes for anybody the day it ships**: nobody is marked (the production has one administrator and
none marked), and the mark can be set from now on only by `PATCH /api/v1/users/:id` with `{"teaches": true}`, by rektor or a full
administrator, on an administrator who has a post.

- **Deploy order.** Part 1's migration is in production already, which this part needs (the API now selects `Users.teaches` on every
  request: a database without the column answers P2022 for every one). Part 3's arms (20.4, the database half of the note to the
  substitute) are in production too (20270216090000), as this part needs for the note's route and the lesson view's flags, which
  are the gateway's half of it: without the arms the database refuses the note, and `app.lesson_teacher_role` answers NULL for an
  administrator, so the view would be the administrator's as before. Nothing else is needed before the merge.
- **Everything is additive.** Older web and apps ignore the new fields: `teaches` on `GET /users` (what `usePeople()` reads),
  `GET /users/administrators` and `PATCH /users/:id`'s answer, `teachingAdministrators` on `GET /users/counts`, `fromTeaches` and
  `toTeaches` on `GET /users/:id/role-changes`. `POST /users` does not take `teaches` (the validation pipe refuses it: create, give a
  post, then mark), and `PATCH` of a person who is no administrator, a teacher or a läsare is a 400 with its own code.
- **Five new codes reach the client, and one existing one gains a case.** The two 409s, `TEACHES_NEEDS_A_POST` and
  `A_TEACHING_ADMINISTRATORS_LAST_POST_STAYS`, carry flat `params` where the refusal names them (`userId`, `academicYearId`; both are
  strings). The last one comes from the post's removal, from `PATCH`, and from the läsår's removal, which asks first and answers with
  `administrators` as a count and `userIds` as a comma-separated string of at most five ids, and no name. The three 400s of
  `PATCH /users/:id` carry **no** `params`, only their code: `TEACHES_NEEDS_AN_ADMINISTRATOR` (the person is neither an
  administrator nor a teacher), `A_READER_DOES_NOT_TEACH` (a läsare) and `A_TEACHER_TEACHES_ALREADY` (a teacher is that already). A
  deadlock against a mark is the existing `WRITE_CONFLICT` ("try again").
- **The lesson view has no rule of its own for an administrator who teaches.** It asks `app.lesson_teacher_role` and shows what that
  answers (REGULAR: the note read and written; NULL: the administrator's view as before). Whether the person stands on the lesson
  and has a post for the läsår of the lesson's group is that function's, part 3's, and nothing else in the gateway asks it again, so
  the view and the note's arms cannot disagree about a lesson dated outside its group's läsår.
- **The three routes an administrator who teaches may use as the teacher** are written out in `RolesGuard` by `@AsTeacher`, and the
  route-guards e2e spec holds the list to exactly those and refuses such a person every other teacher-only route: the lesson log's
  own week (`GET /lesson-logs`), the lessons the person's absence handed over (`GET /lesson-logs/handed-over`) and the note to the
  substitute (`PUT /lesson-logs/lessons/:id/substitute-note`). The class teacher, the cover request's colleague side, krisläge, mentor
  and the reporting rate are **not** opened here (the first two by decision 4; the rest are part 4's, with their arms).
- **"Who teaches" is one answer** (`src/staffing/teaching-staff.ts`, `teacherWhere` and `teachesLike`) at the places that ask it: Skolans
  dag, an exam's invigilators, an activity's teacher, `lärare.csv`, the import's teacher by e-mail and the label in SS12000 v1 (a
  teaching administrator is `Lärare` there; the `role` filter of that API is unchanged). The substitute, the suggestions, the cover
  request's recipients and the pool stay the teachers'. `GET /school-day/free` ("who is free") answers the same "who teaches", so a free
  administrator who teaches is listed there beside the free teachers; it is the page's search for who has nothing on, not the
  substitute pool, and removing them from it alone would give Skolans dag two answers to who teaches. Part 5's page words that.
- **Rolling back** is reverting the gateway: nothing in the database moves. A mark that has been set stays on the row and does nothing.

### 20.6 Part 4, krisläge, mentor and the reporting rate as the teacher (20270219090000)

The second part that asks for the mark in the database and the second that opens routes for it (part 2, 20.5, opened the three
routes of the read log). A marked administrator is a teacher in krisläge (the groups they answer for, and the rest of what a
teacher may mark), as a mentor (the pupil's mentors, the leave request, the absence watch) and in the reporting rate (the lessons
they stand on). The right stays the administrator's: no administrator arm is touched, nothing
an administrator may do is narrowed, and nobody who is not marked gets anything. **Nobody is marked in production** (one
administrator), so the migration and the merge change no answer there; RLS section 513 shows what happens the day somebody is.

- **The migration** (one file, one transaction): three insert arms on `CrisisReports` (`crisis_reports_teacher_insert`, `_found_insert`,
  `_free_insert`, all `TO app_authenticated`) get `app.current_user_teaches()` in OR with the teacher's test, so that a marked
  schemaläggare or expedition has **the teacher's whole right to mark** in a school whose start list
  (`CrisisSettings.startProfiles`) leaves them out (see "What a mark opens in krisläge" below: it is more than the own group);
  ten functions ask "teaches like a teacher" (one new, `app.teaches_like(role, mark)`, the SQL twin of the gateway's
  `teachesLike`, inlined into its callers, no grant; written `(role = 'TEACHER' OR (role = 'SCHOOL_ADMIN' AND mark)) IS TRUE` and not
  as a `coalesce`, which cost the two lesson functions +17–25 % over four weeks of lessons through a different join order). The two lesson functions (`app.reporting_lessons` and
  `app.absence_stats_lessons`) are replaced with a whole body behind an md5 guard (`20270210090000`'s method: two tests hold their text,
  `absence-stats-definition.spec.ts` and RLS 392o); the other eight are patched from the catalogue at named places (each with the
  number of occurrences it expects, and a replacement that already stands in the text stops it, so an arm is never wrapped twice);
  `app.absence_watch_digest_plan` changes for the MENTOR group's recipients only. 25 policies and `app.checklist_taught_ids()` name
  TEACHER and **stay**: the administrator's arm for the same table and verb admits every row they admit. For the alarm's seven read
  arms that is the point: an administrator reads every alarm, group and pupil list of the school, for good, so **the gateway narrows
  what a marked administrator is shown** (`CrisisService.mine` and `searchPupils` ask `app.crisis_window_open`,
  `app.crisis_answers_for` and `app.crisis_call_window_open` and read with `id in (…)`), and the database does not. Section 494 holds
  the list (the `PR4` tag is gone: every entry is converted or `STAYS` with a reason).
- **What a mark opens in krisläge (E2, chosen by the user on 2026-11-16: "as a teacher").** Only in a school whose start list has
  been narrowed (say to `[FULL, REKTOR]`), only for a marked SCHEMALAGGARE or EXPEDITION (REKTOR and FULL start and mark anyway),
  and only while an alarm runs (or ended within the hour: the window is the database's own). A marked person then gets what a
  teacher has, **not only the own group**, through the three arms. Measured on every cell of `CrisisReports` (all pupils × all calls ×
  FOUND/MISSING/AWAY/RETRACTED) against a twin teacher with the same groups, the mark opens **36 write cells**, the same for
  schemaläggare and expedition: **12 in the own group** (`_insert`: FOUND, MISSING and RETRACTED for the pupils of a group they
  answer for), **18 "found with me"** (`_found_insert`: FOUND or RETRACTED for a pupil of another group, with the person's own group as
  `foundInCallId`) and **6 free finds** (`_free_insert`: in an alarm where they have no group, FOUND or RETRACTED for pupils of
  groups they do not answer for; the arm asks only for the window and that the person has no call in the alarm, and the row is
  stamped `onBehalf = true`, E6). Nothing more: never AWAY, never to start, end or change an alarm, a list, a group or the start list,
  and never to put oneself on a call (eight tries, all 42501). It is the teacher's right, and it is the one place where this part
  gives a marked person more than the administrator profile had. **The marks cannot be taken back**: `CrisisReports` is an append log,
  so a wrong "found" stays in the protection protocol (a retraction is a new row). Taking the mark away stops new rows, it does not
  erase the written ones.
- **Do not run the migration while an alarm is open.** The table it locks is read by the management's live view and written by the
  phones during an alarm; `prod-fore.sql` has a check that no alarm is open (`CrisisAlarms.endedAt IS NULL` = 0).
- **Locks.** `ALTER POLICY` takes ACCESS EXCLUSIVE on its table (measured); `CREATE OR REPLACE FUNCTION` takes no table lock. One
  table, `CrisisReports`, is locked `NOWAIT` in a loop that retries every 50 ms for 30 s and holds nothing between tries (a waiting
  ACCESS EXCLUSIVE would queue every reader behind it). If it is not free in 30 s the migration stops with nothing changed and says so:
  Prisma then marks it failed and refuses every later `migrate deploy` (P3009) until
  `prisma migrate resolve --rolled-back 20270219090000_en_undervisande_administrator_svarar_i_larmet_ar_mentor_och_rapporterar`
  has been run, then deploy again.
- **Retroactive, by design.** A person who is marked today has their lessons of the last 90 days counted as held by the night's count
  (`app.reporting_compute` recomputes 90 days and rewrites rows whose figures changed), those without a saved register as not
  reported, and the reminder (`app.reporting_remind`) looks back 30 days. The history of the absence statistics stores months it does
  not recompute, so only an open month is affected. Rektor should know that a newly marked administrator can show an unreported
  history the first night; the handbook (part 7) says it. RLS 513o has the case as a named test.
- **The gateway** (no migration; additive): five routes carry `@AsTeacher` (`GET /crisis/mine`, `POST /crisis/mine/pupils`,
  `POST /crisis/mine/marks`, `GET /reporting-rate/mine`, `PATCH /leave-requests/:id/refer`), so the route-guards spec lists eight doors
  and holds twelve refusals; `UsersService.update` asks the mentors again when the mark changes (`app.leave_mentors` reads it):
  **marking a person sends one `LEAVE_REQUESTED` notice per pending leave application in the class they mentor**
  (`app.leave_requests_tell_new_mentors()`, the catch-up in `UsersService.update`), written in the transaction of the save and mailed
  after it, so it cannot be taken back by removing the mark; a deciding mentor of the school, in any class, who has no
  `LeaveRequestNotices` row for a pending application is told of it as well, since the catch-up (`app.leave_tell_mentors(school, NULL)`)
  is the school's and not the marked person's (a notice that gallring has removed is written again): it is not "nobody else" who is
  told (the production has no marked person, so none the day this ships);
  the notification preferences offer a marked administrator `LEAVE_REQUESTED`, `LESSON_REPORT_REMINDER` and `LESSON_PUPIL_MOVED`
  (not `COVER_REQUESTED`: SP409). The class teacher, the cover request's colleague side and the pool stay the teachers' (CT400, SP409).
- **Deploy order:** the migration, then the merge, **after** every lower stamp that is in the same round (`20270218090000`, C1, is run
  before this one). A new API against the old database is failsafe (the doors open, the database refuses: 42501 becomes 403
  `CRISIS_NOT_YOURS`, empty lists); an old API against the new database changes nobody's answer (nobody is marked). No column, no
  index, no engine contract. **Checks:** `scripts/prod-checks/teaches-pr4-fore.sql` before and `teaches-pr4-efter.sql` directly after
  (plain `SELECT`s, one row per check with `got`, `expected`, `ok`; in this repository so that this text points at nothing outside
  it). They hold: the Postgres version; no alarm open; nobody marked; the `md5(prosrc)` of the ten functions and the `md5` of the
  three arms before and after (below); the md5 of every other function and policy unchanged; that `app.teaches_like` does not exist
  before and has no grant after; the grants and, on 17, MAINTAIN; and the migration row finished and not rolled back. The counts of
  migration rows and the fingerprint of their names depend on production's own order (set `F04`–`F06`/`E03`–`E04` from its rows). The
  values in the files are those of production's order **after C1** (`20270218090000`, run first): 221 migrations and
  `20270218090000_ett_block_kan_forlaggas` last before this one (`F04`–`F06`), 222 after (`E03`–`E04`); run in that order the files
  gave 52 of 52 before and 52 of 52 after on Postgres 17 and 16.
- **md5(prosrc), before → after:** `reporting_lessons` `a263885d…` → `ec19a5e2…`; `absence_stats_lessons` `2b076764…` → `16826e85…`;
  `leave_mentors` `2e45bf18…` → `a0543c68…`; `absence_watch_mentees` `cb7f4c58…` → `5a5558cf…`; `absence_watch_digest_plan`
  `ee974a4a…` → `efc50076…`; `leave_mine_to_decide` `1526df12…` → `43acb82d…`; `leave_request_taken` `8d94bb7a…` → `a62479a0…`;
  `absence_watch_is_mentor_of` `d8db0338…` → `34158631…`; `ack_mentee_ids` `6f643d23…` → `69ff8f3a…`; `lesson_move_is_mentor`
  `d7ffb0bf…` → `bbde2675…`; `teaches_like` — → `a8f98492…`. A branch that rewrites one of these (a parallel PR) changes the "before":
  read `md5(prosrc)` on `origin/main` immediately before the merge and compare.
- **Rolling back:** nothing reads the arms' or the functions' answers for a person who is not marked, so they can stay. To remove them,
  run the edit the other way (the three arms' text without the OR; the eight patched functions from their earlier migrations'
  `CREATE FUNCTION` text, and the two lesson functions from `20270122091000`/`20270210090000`; `DROP FUNCTION app.teaches_like` last).
- **Tests:** RLS sections 510–514 (what the migration wrote; the three arms through the API's role for each profile that can be
  marked, with the start list narrowed; the mentor; the reporting rate; nothing else changed) and 510o/512o/513o on the owner's side;
  section 494 (the list); the adapter probe's `tk-a`…`tk-d` through the real services, the twin test of krisläge first;
  `scripts/test/teaches-pr4-snapshot.sh`; and the bench numbers in the pull request.

### 20.7 Part 5, the web: the group "Min undervisning" (no migration, no gateway change; the database it reads needs 20270212090000)

The web learns what the gateway and the database have known since parts 2 to 4: **an administrator who teaches** (`Users.teaches`)
has the teacher's own rows. The rights are the administrator's either way (the view narrows, the right does not).

- **What is shown, and to whom.** `Profile.teaches` is read with the session (strictly: `profile.teaches === true`; a profile without
  the field is not marked, and the huvudman's reader is `false`). Only a marked administrator is handed the group **"Min undervisning"**
  in her menu, as the **second** group (after Översikt and Kalenderprenumeration): seven rows built from the teacher's menu (Mitt schema,
  Larm, Närvaro, Min tjänst, **Min frånvaro**, Ledighet, Min rapportering). The group is server data (`teaching-admin-nav.ts`, like the
  other menus), so no byte of it is in the JavaScript bundle and `AppShell` and `lib/queries.ts` are untouched; the menu of an
  administrator without the mark is byte for byte what it was, and so are the teacher's, the pupil's and the guardian's. The
  production has no marked person today, so **nobody is shown anything the day this ships**.
- **What the pages do for her.** `/teacher/franvaro` becomes "Min frånvaro": it no longer asks `GET /cover-requests/mine` (the colleague
  side of the cover request, SP409, answers an administrator 403, and the page drew an error card every minute), and shows her own
  absences and the lessons she handed over. `/teacher/ledighet` narrows the school's whole list that the gateway hands an
  administrator to what a mentor is shown: the pending applications she is among the deciding mentors of and whose guardians' consent is
  not still awaited (a teacher's arm asks that it is complete), and on the decided tabs the ones she decided herself for a pupil she is
  a mentor of. It is a teacher mentor's pending list, read against the real gateway, and on the decided tabs the nearest a page can
  come: a teacher's decision is written as the mentor's and an administrator's as the administrator's (`decidedAs` ADMIN, also when
  she decides on this page), so a teacher's own rule (`decidedAs` MENTOR) cannot be copied, and an application she decided as rektor
  for a pupil of another mentor stays out. A teacher's own list is the gateway's, as it was. `/teacher/tjanst` says that her
  figures are counted from the schedule draft (an administrator reads the draft where a teacher reads the published schedule).
  `/teacher/crisis` has a link to the leadership's view. An alarm's notice in the bell leads her to `/teacher/crisis` instead of
  `/admin/crisis`. Mitt schema, Närvaro, Min rapportering and the lesson page needed no change.
- **The switch.** `/admin/people` has **Undervisar** on an administrator of any profile but the läsare, for rektor and a full
  administrator only (the others see it locked with the sentence that says who changes it). It is sent as a `PATCH /users/:id` of its
  own, after the post the same dialog may have written (`TEACHES_NEEDS_A_POST`), and never as `null`. The six refusals the mark can
  meet have texts in both languages (`TEACHES_NEEDS_A_POST`, `A_TEACHING_ADMINISTRATORS_LAST_POST_STAYS`,
  `TEACHES_NEEDS_AN_ADMINISTRATOR`, `A_READER_DOES_NOT_TEACH`, `A_TEACHER_TEACHES_ALREADY`, `WRITE_CONFLICT`), and the last one is
  also said where a post is removed (`/admin/staffing`) and a läsår is deleted (`/admin/years`). The role history says "undervisar nu"
  and "undervisar inte längre" when the mark moved, and nothing for a row written before the mark existed (`fromTeaches` is `null`
  there and `toTeaches` is `false`; an audit log is not filled in afterwards). The register's list has a small "undervisar" beside the
  role.
- **Nothing is run at deploy.** No migration, no engine, no change in any gateway answer (the one line in `src/` is a comment in
  `crisis.controller.ts`, and the correction of 20.6 above is a sentence). **But the web is not independent of the database:** the
  session's mark is read from the person's own `Users` row through PostgREST (`web/lib/auth.ts`, the profile read every signed-in
  request makes, as `hrRead` is), so the database the web reads must hold `Users.teaches` (migration `20270212090000`, in the
  production's 222 and in every database that has run part 1). Where the column is missing (a preview or an environment that lags)
  PostgREST answers 42703, the profile read returns nothing and nobody gets past `/no-profile`. There is no column privilege on
  `Users` in any migration, so the read is the plain table right, as for `hrRead`. "Additive against an older gateway" holds for what
  the gateway sends: `Person.teaches` and the administrators' `teaches` are optional in the types and `undefined` is false, so an
  older gateway shows nobody the group in a list. The one call that needs the gateway of part 2 is the switch's `PATCH` (an older
  gateway refuses the field).
- **Deploy order:** the migration of part 1 (already run in the production) before the web, as for the rest of the series; otherwise
  the web and the API deploy on their own.
- **Rolling back:** revert the pull request. The web keeps nothing (the mark is the database's), and a person who is marked stays
  marked, with the gateway and the database answering as parts 2 to 4 say.
- **Not in this part:** the planner's pickers and `lärare.csv` (the web's part 5b, 20.8 below), the mobile app (part 6) and the handbook (part 7).
- **Tests:** web unit tests for every page and for the menu (`role-nav.test.tsx` holds the group, its order and that nobody else gets
  it); `lib/teaching-admin.contract.test.ts` reads the gateway's controllers as text and holds that every route a page of the group
  calls admits her, that the doors are the route-guards spec's eight, and that the colleague side, the class teacher's and the pool's
  routes are in no page's table; Playwright (`teaching-admin.a11y.spec.ts`, `teaching-admin.smoke.spec.ts`, a baseline for her menu and
  a fifth person in the document-size gate) against the stub's marked administrator.

### 20.8 Part 5b, the web: the planner's pickers and `lärare.csv` (no migration, no gateway change)

The second half of the web's part. Where part 5a gave a marked administrator (`Users.teaches`) her own pages, this lets the planner **put
her on a lesson** and puts her in the school's **`lärare.csv`**, which the gateway has done since part 2. The rights are the
administrator's either way.

- **The pickers.** `web/lib/teaching-staff.ts` (one function, no imports) is the web's copy of the gateway's `teachesLike`
  (`src/staffing/teaching-staff.ts`; `lib/teaching-staff.test.ts` reads the two as text and holds the same sentence). Three kinds of use
  are kept apart, and the rule is a decision and not a style:
  - *Who teaches* (a post's teacher and co-teacher, the grundschema's teacher rows and lesson dialogs, an activity's teacher, a person's
    availability rule, the idle-gaps search, the generator's teacher count and the candidates page's håltimmar and week view, the
    absence's person, the placements page's teacher filter, the "Undervisar" card on `/admin/people`): `teachesLike`.
  - *The name of the person a lesson or brick already carries* (`/admin/lessons`, `/admin/placements`): anybody in the school's list,
    so that a mark taken off later does not leave her lesson without a name.
  - *Who may step in* (the substitute dialog on `/admin/lessons` and `/admin/teacher-absence`, the substitute pool's dialog behind
    Inställningar on `/admin/teacher-absence`, the cover board, the class teacher's appointment): unchanged, `role === "TEACHER"`. A
    teaching administrator is not in the substitute pool and is never asked (SP409, CT400), and the gateway refuses her as a substitute.
    On `/admin/lessons` one list became two, and on `/admin/teacher-absence` the register takes two (`teachers`, who can be absent, and
    `poolCandidates`, who the pool can take in): `POST /cover/pool` checks no role itself, but the database refuses a member who is not a
    teacher (`SubstitutePoolMembers_member_is_a_teacher`, SP409), so the web's list keeps the dialog from offering her for a pick that can
    only end in that refusal.
  `/admin/requirements` and `/admin/timetable` write the expression in place (no import), since they sit within 0,5 and 1,3 KB of their
  budgets; `lib/csv-export.ts` does too, since it ships with six pages.
- **`lärare.csv`.** The web's `teachersToCsv` takes a marked administrator as the gateway's copy
  (`src/school-export/csv-files.ts`) does, so the school's two files no longer differ as soon as someone is marked (review of #321,
  information 3). The shared cases `src/school-export/__fixtures__/csv-files-cases.json` are generated from the web page
  (`UPDATE_CSV_FILES_CASES=1 npx vitest run lib/csv-files-cases.test.ts`), never edited by hand, and the gateway's spec plays them: a marked
  person with a post, one who is not marked, one who is marked and has left, and one whose mark is explicitly false. The people page counts
  a marked administrator with a protected identity among those the teacher, qualification and duty files held out.
- **Skolans dag.** `GET /school-day/free` has listed a teaching administrator among the free since part 2; the card's description now says
  that she is not asked to cover (section 20.5 says the page that shows the list should).
- **`/teacher/ledighet`.** An administrator who teaches is handed the school's list cut at `LEAVE_LIST_LIMIT` (200) per tab and the page
  narrows it to hers afterwards, so in a school with more requests than that in one tab an older one of hers can lie outside the answer. The
  page says so, as a warning above the list, when the answer reached the limit (never for a teacher, whose list the database narrows before
  it is cut). A mentor filter in `GET /leave-requests` was weighed and left: it needs a new query parameter (the gateway's pipe forbids
  unknown ones, so an older gateway would answer 400), SQL against `app.leave_request_facts` to decide who decides the pending ones before the
  cut, a regenerated OpenAPI and a database run; the production has no marked person.
- **Nothing is run at deploy.** No migration, no engine, no change in any gateway answer. The web is additive against an older gateway:
  `Person.teaches` is optional in the types and `undefined` is false, so an older gateway lists nobody as teaching and the pickers are as they
  were. The production has no marked person, so **nobody sees a difference the day this ships**.
- **Bundle.** Measured on a build of this branch against a build of main with the same environment: `/admin/requirements` 189,4 → 189,5 KB
  (budget 190), `/admin/timetable` 188,7 → 188,7, `/admin/people` 187,7 → 187,8, `/admin/placements` 186,7 → 186,8, `/admin/gaps` 177,8 → 178,2,
  `/teacher/ledighet` 162,4 → 162,5; no route is over its budget and no budget was moved. The shell's chunk is the same one (79 of 91
  routes, 14 825 B gzipped in both). The document gate needs no new `measured`.
- **Rolling back:** revert the pull request. The web keeps nothing; a marked person stays marked.
- **Tests.** A page test per picker (a marked and an unmarked administrator: she is where she should be and not in the substitute
  picks), `lib/teaching-staff.test.ts`, the shared CSV cases, a smoke spec against the stub (`teaching-admin.pickers.smoke.spec.ts`), and in
  `lib/teaching-admin.contract.test.ts` a reading of every page of the group's imports with the compiler (`lib/api-literals.ts`): every
  `/api/v1/` route a page can name is in its table or is said, with a reason, not to be called for her.

## 21. Pinned lessons in the generator ("Fästa lektioner")

A lesson a school lays by hand before Generera has reached the engine as a
locked lesson, taken off its post (§ on *Förlagda poster*). A lock has to name
its room, and no proof of an impossible week can name a lock. The engine now
also takes the same lesson as a **pinned lesson**: a new optional key on a
requirement, `pinnedLessons`, one place per lesson of the post in the order
`lessonTeacherIds` has (longest lesson first), each place empty or
`{dayOfWeek, startTime, endTime, roomId?}`. A pinned lesson stays the post's
own lesson. The engine holds it at that weekday and start, in that room when
one is named and in a room it chooses when none is, and it comes back among the
post's lessons in the answer.

**Nothing sent the key in this release.** This release was the engine's half. No
migration, no setting, and no school's week changed: a request without the key
builds the model it built and is answered with the bytes it was answered with.
The release that sends it is §22.

### 21.1 Deploy order

**The engine first**, for the reason §19.1 gives: its request models forbid
unknown fields, so an engine without the key answers 422 to a run that carries
one.

1. Merge this release. Verify that `https://<solver-host>/openapi.json` has a
   schema named `PinnedLesson` and names `pinnedLessons` under
   `AnonymousRequirement`, and that no schema has been renamed (a name holding
   `__` is one that was).
2. A later release makes the gateway send the key (§22). That release is
   refused by an engine without this one, and says so in its own section.

### 21.2 Rolling back

Safe at any time while nothing sends the key: reverting this release takes the
key out of the engine and changes no answer. Once a gateway sends it, the
engine must not be rolled back past this release before that gateway is.

### 21.3 A pinned lesson is held to more than a locked one

A locked lesson is a window the generated lessons steer round. It has no
years, no subject and no margins of its own, and two locks are never compared.
A pinned lesson is a lesson of its post, and every rule of the post holds for
it. For a school this is where the two differ:

- **Refused before the week is laid, with the lesson named:** a pinned lesson
  outside the school's week or its time grid, outside the frame time of its
  years, across a rast of its years, or in a room its post may not use (type,
  size, years, or the rooms its subject is locked to).
- **Refused by the proof, with the lesson and the rule named:** a pinned
  lesson that breaks the subject's distribution rule (two pinned on one day
  under "at most one a day"), the teacher's daily cap or days a week, or the
  class's daily maximum. A locked lesson is taken as a fact by all four.
- **Two pinned lessons in each other's way** (one teacher, one class, one
  room, one hour) are refused with both named. Two locks are not compared.
- **In a parallel block** a lesson is pinned for every entry of the block or
  for none, at one time (`PLACED_LESSONS_OF_BLOCK_DIFFER`).

**Where the two are alike: the class's meal (19.7).** A pinned lesson cuts a
class's läsår into parts as a locked lesson does. Two posts pinned across the
lunch window, one in the autumn and one in the spring, give the class one meal
in each term, where a single meal for the year has no room in either. What a
pinned lesson takes from the meal is the lesson with its pupils' changing
minutes before and after, which a lock does not have, so two terms can differ
in those minutes alone. Unlike a lock's hour, the pinned lesson's is not taken
out of the meal's starts before the week is laid: the meal is kept clear of
it by the rule that keeps it clear of every lesson of the class, so a term
whose pinned lessons leave the meal no start is refused with those lessons
named.

A pinned lesson never gives way, in Bästa möjliga schema either.

### 21.4 Operations

- **The lines.** A pinned lesson in the way of a week is named as a förlagd
  lesson is: `PLACED_LESSON_IN_THE_WAY` with its room, and
  `PLACED_LESSON_IN_THE_WAY_ANY_ROOM` where the engine chooses the room.
- **A refused week with a pinned lesson is explained on the model without the
  objective.** Measured on the högstadium benchmark with 200 lessons pinned
  and two of them on one hour of a teacher's: the model with the objective
  named every rule of the week, 668 of 668, and the one without named the two
  pinned lessons, in 9 s on a loaded machine. A week without a pinned lesson
  is explained as section 23 says.
- **When the proof names nothing** inside its fifteen seconds, the week is
  solved once more with every pinned lesson free to move, as it is for the
  förlagda locks, and a timetable found then names them all.
- **The start step.** A lesson pinned at 08:05 takes a school that is searched
  every thirty minutes down to every five, as a lesson locked at 08:05 does.
- **A pinned room is a room class of its own**, as a locked lesson's room is,
  and costs the model what that costs. That holds for the school's places rule
  too (`placementRules.places`, for example at most one room a day for a
  class), which counts room groups, where two equal classrooms are one: two
  förläggningar of one class in two equal rooms A and B count as two places,
  and under a HARD limit of one place the week is refused
  (`PLACEMENT_PLACES_FORCED` before the model for locks, `PLACES_CANNOT_BE_KEPT`
  by the proof) although the same timetable with the rooms not named was
  possible (55 of 1,766 worlds with a HARD limit in the third review of #317,
  all solved with the rooms left out). §22.4 says how that reaches the school.
- **What pinned lessons cost the search.** Measured in paired runs under the
  same load, as the time to a first timetable of the satisfaction model. On
  the högstadium benchmark (423 lessons, two workers): 7.1 s without a pinned
  lesson, 20 s with 20 of which 10 name a room, 16.6 s with 200 of which 100
  name a room. On the 250-pupil benchmark (four workers): 3.1 s without,
  4.7 s with 12, 8.5 s with 120 of which 60 name a room, and 3.6 s with the
  same 120 and no room named. So a pinned lesson that names its room makes
  the first timetable 1.5 to 3 times as dear (up to 3.5 times when every one
  of the 120 names its room), and one that leaves the room to the engine
  about 1.2 times: the cost is the room's class of its own, not the pin. A
  locked lesson's room is a class of its own too, and a pinned lesson is not
  dearer than the same lesson sent as a lock. On the 250-pupil benchmark
  (paired, four workers, the same 120 lessons) a first timetable took 13 to
  15 s with every lesson pinned in its room and 36 to 43 s with the lessons
  sent as locks (7,870 variables against 87,642); on the högstadium benchmark
  the two were alike (one worker, not paired: 19.9 s pinned and 22.8 s locked
  with 200 lessons, 34.4 s and 35.6 s with 20). Like for like, with a room
  named on every pinned lesson, the locks build a model 3.5 to 12 times as
  large (20 lessons: 31,822 variables as locks, 9,047 as pinned lessons; 200
  lessons: 133,036 and 10,739). The 2,000-pupil benchmark is measured with
  the release that sends the field: §22.4.

## 22. A förläggning with no room: the engine chooses it ("Förläggning utan sal")

A förläggning (`TeachingRequirementPlacements`, one lesson of a post that the school lays by hand before
Generera) has always had to name its room, and Generera sent it to the engine as a locked lesson (§ on *Förlagda
poster*). Since §21 the engine can also hold a lesson of a post at a given time and choose the room as for any lesson
it places. On 2026-11-13 the user decided that the room may be left empty: **a row with no room is sent as a pinned
lesson, and the engine chooses its room at every Generera**. A row with a room is sent as before, as a lock, byte for
byte. The dialog on the timplan has "Motorn väljer sal" as its empty choice, and the week of förläggningar
(`/admin/placements`) shows it on the card.

Migration `20270213090000_forlaggning_utan_sal_motorn_valjer_salen`: `"TeachingRequirementPlacements"."roomId"` becomes
nullable. Nothing else of the table moves: the key to Rooms (MATCH SIMPLE, NO ACTION) tests nothing for a NULL, and the
CHECKs, the two fit functions (neither reads the room), the policies and the grants are the same, which the pull
request shows by md5 of the catalogue before and after (`prod-fore.sql` and `prod-efter.sql`, 30 read-only checks each) and
RLS sections 495 to 499 hold.

### 22.1 Deploy order

**The migration first, then the merge.** The lock is taken `NOWAIT` in a loop with a 30 s deadline (Generera reads
the table in a long transaction): it never waits while it holds a lock, and after 30 s it stops with nothing changed
(`prisma migrate resolve --rolled-back 20270213090000_forlaggning_utan_sal_motorn_valjer_salen`, then deploy again).

1. Run `prod-fore.sql`, then `prisma migrate deploy` from a tree that has the migration, then `prod-efter.sql`: the
   checks named `..._record_equal_before_and_after` must give the same figure twice, and `roomId` must read nullable.
   The API that is live meanwhile never names a NULL and every row there has a room, so it is undisturbed.
2. Merge. The engine and the API deploy together, as always. The engine has had `pinnedLessons` since §21: check that
   `https://<solver-host>/openapi.json` has a schema named `PinnedLesson`. A gateway that sends the key to an engine
   without it is answered 422, and the run is refused with `ENGINE_LACKS_PINNED_LESSONS` (503, "try again in a few
   minutes") and nothing is written: the week is NOT sent again without the key, because the lesson the school pinned
   would then be laid anywhere without a word.
3. After: a school with no förläggning without a room sends the payload it always sent (no `pinnedLessons` anywhere).

### 22.2 Rolling back

- **The previous API cannot be brought back while a row with no room exists.** It reads the room's name on every row
  it returns (`room: { select: { name: true } }`) and stops on a row with none. The column itself does not disturb it:
  it never writes a NULL. So before the API is rolled back past this release, check
  `SELECT count(*) FROM "TeachingRequirementPlacements" WHERE "roomId" IS NULL` and give each such row a room (the
  school, in the dialog) or remove it; the rows come back to the new API unchanged.
- The migration is rolled back with `ALTER TABLE "TeachingRequirementPlacements" ALTER COLUMN "roomId" SET NOT NULL`,
  which fails while a row with no room exists, for the same reason; then `prisma migrate resolve --rolled-back`.
- The engine must not be rolled back past §21 while this gateway is live (`ENGINE_LACKS_PINNED_LESSONS`).

### 22.3 What the gateway does with a row with no room

- **It is no lock.** It is no fixed lesson, it takes nothing off the post's demand (the post keeps the lesson), it adds
  no weekday to the post's `lockedDays` or the teacher's `lockedWeekdays` (the engine would count the lesson twice),
  and `placements` does not name it. It is a place in the post's `pinnedLessons`: one place per lesson, in the order
  `lessonTeacherIds` has (longest first), `null` where the engine places the lesson, `endTime` the start plus the
  length of the lesson at that place. On a post with periods the pin holds in the post's periods and in no others.
  A post's OWN row in a parallel block is refused by name, `BLOCK`; a block's lessons are pinned for every member
  together, with the engine taking a pin in a block for every member or none (§24).
- **A pair needs its rooms.** An odd and an even row of one length on an every-week post are one lesson in two
  places, and the engine cannot hold half a lesson of an every-week post, so a pair is sent as two locks, and a lock
  has a room. A pair with no room on a half is refused at the save (409 `REQUIREMENT_PLACEMENTS_DO_NOT_FIT`, rule
  `PAIR_ROOM`) and by the judge for a row another writer stored (`PAIR_ROOM`). The database does not hold the rule:
  its fit function is left as it was (RLS section 496 says so), so a writer that does not go through the gateway can
  store such a pair, and Generera then refuses the week with that row named.
- **Judged without a room.** No room clash, no room's unavailability and no other school's hold on a room; the
  teacher, class, pupils, frame time, lunch and year rules and the other schools' hold on the teacher as before.
  The judge is milder than the engine here (decision 12, §21.3): what the engine refuses and the gateway let
  through is a refusal that names the lesson and the rule, not an error.
- **The lesson that comes back** is known by post, weekday, start, length and, on a post that shares its lessons,
  teacher (the answer has no lesson index). It is written locked, generated and marked `fromPlacement`, **in the room
  the engine chose**, as a lock's lesson is. Versions, a discarded draft and an apply of a schemaförslag put it back
  as a förlagd lesson (the flag travels with the row), and a change of its room by hand is refused,
  `LESSON_IS_PLACED`. The engine may choose another room at the next Generera: that is the meaning of an empty room,
  and whoever wants the same room every time names it.
- **Stale and the basis.** A row changed, given a room or taken away while the engine solved is `GENERATE_STALE`
  (the key reads the room as it is, empty too). The basis a schemaförslag is solved from hashes each pin with the
  lesson its place belongs to (its length and teacher), so a pin on Bo's lesson and one on the lead's are two
  different weeks.
- **An answer without the pinned lesson** is an answer to another request: 502, nothing written.

### 22.4 Operations

- **What a school sees when Generera refuses.** The engine's lines (§21.4) reach the school with their values named
  back: `PLACED_LESSON_OUTSIDE_THE_WEEK`, `PLACED_LESSON_OUTSIDE_FRAME`, `PLACED_LESSON_MARGINS_PAST_THE_DAY`,
  `PLACED_LESSON_IN_A_RAST`, `PLACED_LESSON_ROOM_NOT_ALLOWED` and `PLACED_LESSONS_OF_BLOCK_DIFFER` before the model,
  and `PLACED_LESSON_IN_THE_WAY_ANY_ROOM` (a pin with no room) or `PLACED_LESSON_IN_THE_WAY` (one with) from the
  proof, each with the post by the school's own name, the weekday and the time (and the room when one is named). The
  gateway's own pre-flight (`PLACEMENT_CANNOT_STAND`) names a row with no room with `room = ANY_ROOM`, which the page
  words as "a room the timetable chooses".
- **The places rule (§21.4).** A school with a HARD limit on places that pins whole weeks with the rooms named can be
  refused where the same timetable with the rooms not named was possible. The sentence the school reads for
  `PLACEMENT_PLACES_FORCED` and `PLACES_CANNOT_BE_KEPT` now ends with the way out, and it is this release's: leave the
  room empty ("Motorn väljer sal") and the engine chooses it, which counts as one group where the rooms named counted as
  many. A förläggning with no room is never one of the groups.
- **What it costs the search.** Measured in paired, simultaneous runs (the three variants start at once, so they share
  the machine's load) of the first timetable of the satisfaction model, on the 500-pupil benchmark (720 lessons, two
  workers each, the lessons taken from a valid timetable of the same week, three rounds, a load of 24 to 52 on a
  machine shared with other sessions). With 144 lessons laid: **18.8 s** (median of 17.9 to 62.6) as pinned lessons
  with no room, which is what this release sends, against 54.9 s (46.2 to 141.6) with nothing laid and **265.6 s**
  (216.9 to 329.2) with the same 144 lessons as locks with their rooms, the way before this release; the models had
  10,845, 10,701 and 260,598 variables. With 72 lessons laid: 38.4 s, 121.4 s and 364.9 s, in 10,773, 10,701 and 156,287
  variables. In every round the pin was the quickest of the three (0.31 to 0.44 of the week with nothing laid), and a
  lock with its room 5 to 21 times the pin. So a lesson laid with the room left to the engine makes the first timetable
  no dearer than the same week with nothing laid (in these worlds it is cheaper, because the laid lessons come from a
  timetable that exists and hand the search a part of it), and the same lesson as a lock with its room dearer by a
  factor of 2.3 to 6.8 against nothing laid: the room's class of its own, which a lock builds for each lesson (§21.4). This is
  more than the 1.2 times on the smaller weeks of §21.4, which were pinned from timetables of 250 pupils and a
  högstadium; no run here was longer than 7 minutes, and the figures move with the load (a round's three variants
  share it, two rounds apart they do not).
- **The 1,000- and 2,000-pupil benchmarks have no first timetable to take lessons from, in any variant.** The 2,000-pupil
  benchmark is a TIMEOUT in `docs/verification-baseline.md` (570 s) and was one here with nothing laid: 603 s at a load of 20
  to 50. The 1,000-pupil school gave no first timetable in 300 s either (load 40 to 50), so the measurement that was meant for
  them was made on the largest size that gave one, 500 pupils. **Nothing was measured on a school of 1,000 or 2,000 with
  lessons laid, in any form, so this section makes no claim about them**: not that laying lessons with the room left to the
  engine leaves such a school no further from a first timetable, and not that it leaves it further. What was measured is that
  the same lessons as locks with their rooms cost the search more than as pinned lessons on every size that gave a timetable
  and was paired: 265.6 s against 18.8 s on 500 pupils with 144 laid, 36 to 43 s against 13 to 15 s on 250 pupils with 120
  laid (§21.4), with models of 260,598 and 87,642 variables as locks against 10,845 and 7,870 as pinned lessons. On the
  högstadium week the two were alike in time (22.8 s as locks against 19.9 s pinned with 200 laid, one worker, not paired; §21.4)
  and 12 times apart in variables (133,036 against 10,739). Nothing here moves the Generera budget.
- **Counting.** `SELECT count(*) FILTER (WHERE "roomId" IS NULL) AS pinned, count(*) AS all_rows FROM
  "TeachingRequirementPlacements"` says how many schools' rows the engine chooses the room for.

## 23. The explanation of a refused week ("Förklaringen av en vägran")

A week the engine has proved impossible is explained by a second, single-threaded
solve with assumptions, capped at 15 s (`EXPLAIN_CAP_SECONDS`), whose sufficient
assumption set names the rules in the way. Which model that solve runs on decides
what the school reads, and there is no contract change: the same lines, the same
codes, fewer of them.

- **A week of 50 lessons or more** (`EXPLAIN_SHARP_FROM_LESSONS`) is explained on the
  model WITHOUT the objective first, on 10 s of the cap (`SOLVER_EXPLAIN_SHARP_SECONDS`,
  default 10).
  The model with the objective answers with every assumption it registered (250 of
  250 on the engine's own refusals); without it the core is the rule that is the
  matter. Measured on the benchmark schools: 25 lines for a class of 36 lessons, 45
  for 72, 105 for 252 and 141 for 360 with the objective, against 1 to 5 lines at
  every size without it. On the högstadium benchmark (`hogstadium.py
  --teacher-day-rules --infeasible-days`): 273 lines against 1, the whole solve in
  5.5 s against 2.0 s. A teacher away four days from a school of 250 pupils, which came back with
  no cause at all (UNKNOWN at the cap), is named by her four days in 5.5 to 7.4 s.
- **The model with the objective is the reserve**, on what is left of the cap, when
  the first try proves nothing in its 10 s or proves the week without resting on any
  assumption (an empty core: 27 of the 250). A room that is too small is such a
  cause, and its literal cannot carry it, since the room's size is also the lesson's
  own room domain; the objective's "all" is how the school has always been told.
  No reserve is run after a solution: when the first try finds a timetable
  (`OPTIMAL` or `FEASIBLE`) the model with the objective has the same hard rules, so
  it cannot prove the week impossible either, and trying it only spent the rest of the
  cap (14.6 s on one large week). A reserve that itself finds a timetable proves
  nothing, and the answer stays what the first try left.
- **A week under 50 lessons is explained as it always was**, with the objective
  (and on a school with the walk, 5 s with it and then without). The core without
  the objective is ONE sufficient set: on the suite's small weeks 17 of 202 sharp
  cores left a second, independent cause unnamed that the full core names, and the
  tests keep naming them. A small week's full core is complete and readable (66
  lines at most).
- **A week with a pinned lesson**, of any size, is explained as section 21 says:
  without the objective on the whole cap, and no reserve.
- **What a large week with several causes costs.** It names ONE of them. The
  core without the objective is one sufficient set, so the school fixes the named
  cause and is told the next on the next run (1.5 to 6 s a run on the benchmark
  schools), in place of all of them among 100 to 270 lines. Measured by the
  review of this change on weeks of two or three independent causes, built by
  adding rules only: on 32 of 32 random weeks (180 and 252 lessons, two or three
  teachers away the whole week) exactly one cause is named, and on the högstadium
  week none of eight combinations (the post, the daily maximum, a teacher away)
  names every cause. The old full core named them all but did not mark them: on
  the 250-pupil school 5 of 25 availability lines were the cause. A loop that
  lifts the core and asks again was tried and left out of this change (one solve
  per cause, 2.6 s each on the högstadium week); it is a task of its own.
  The measured verdicts (the daily maximum, the walk and the blocks) run only when
  their line is IN the core, which on a large week is one sufficient set and not
  all of them: a large week whose core names something else is not measured for
  them, and the next run measures them if they are what is left. On a small week
  and in the reserve the core is the full one and they run as they always did.
- **Time, and what the window assumes.** A large refusal waits for the model
  without the objective: 2.6 s in the median and 7.4 s at most on the large
  weeks measured (0.14 s with the objective), under load 6 to 14, and 1.0 to 2.7
  times as long at 23 to 29. The cap is the same: the two explaining solves never
  add up to more than 15 s. The cores themselves were identical between two runs
  of the same tree.
  - **The production processor is not measured.** Nothing here says how long the
    first try takes on it; the numbers are from a shared development machine.
  - **The 10 s window is narrow on its own benchmark week.** The högstadium week
    with the walk and a daily maximum of four took 7.0 to 7.9 s on a lightly loaded
    machine, and did not finish inside 10 s in three of three paired runs at a load
    above about 10 (UNKNOWN at 9.1 to 10.0 s). The answer is still right, since
    the reserve then proves the week in 0.1 to 0.3 s, but a school with the walk
    and a daily maximum waits 5 to 11 s longer than before (22.2 s against 11.7 s in
    one whole solve; the longest explanation measured was 32.8 s against 22.8 s,
    most of it the verdicts' own probes on `SOLVER_PROBE_SECONDS`).
  - **At high load a large week falls back to the full core.** On a shared machine
    at load 68 to 77 the högstadium week with a post that cannot be held came back
    with the reserve's 273 and 267 lines, the first try UNKNOWN after 8.7 s and
    7.0 s, and the whole solve took 18.1 s and 16.9 s against 7.5 s and 9.0 s
    before. At load 12 it is 1 line in 3.6 s. Never wrong, but the gain is gone
    and the wait is longer.
  - **Moving the window without a release.** Set `SOLVER_EXPLAIN_SHARP_SECONDS` on
    the engine service (a Railway variable, like `SOLVER_PROBE_SECONDS`; the
    service restarts, no code is deployed). The value is the first try's share of
    the 15 s cap: raise it on a slower processor (the reserve gets the rest, so
    leave it at least a second), lower it to give the reserve more. It is
    logged at start-up (`service_starting`).
- **Where to look.** `benchmarks/hogstadium.py --teacher-day-rules --infeasible-days`
  prints the conflict codes of the högstadium week. The measurement and its data are
  in the session notes (`forklaring-utan-mal.md`).

## 24. A parallel block's förläggning: "Förlägg blocket" (`TeachingBlockPlacements`)

A parallel block ("Språkval åk 7": Spanska, Tyska and Franska over groups that cut across 7A, 7B and 7C) is timplansposter
whose lessons are laid at the same times (`TeachingRequirements."blockId"`). Until this release a post in a block could not
be laid by hand: the database refuses a row of its own on it (`TeachingRequirementPlacements`, rule `BLOCK`) and
Generera refuses a block with one lock while the rest are still to place (`BLOCK_PARTLY_LOCKED`). Since this release the
school can lay **a block's lesson** on a day and a time before Generera, from the timplan (**Block → Förlägg blocket**),
for all the block's posts at once, with a room of its own for each post or none (**"Motorn väljer sal"**, the engine
chooses it at every Generera). A block may have some of its lessons laid and the rest left to Generera, which a lock
cannot do. The rule of the single post stays as it was: a post in a block still cannot have a row of its own.

Migration `20270218090000_ett_block_kan_forlaggas`: two new tables, both school-bound with composite keys
`(x, "schoolId")` and `ON UPDATE NO ACTION` (RLS section 330 holds that):

- `"TeachingBlockPlacements"`: one lesson of the block (day 1 to 5, start, length 15 to 240 minutes on the five-minute
  grid, 08:00 to 18:00, the block's weeks). It carries `"academicYearId"` because the key to the block is the block's own
  existing `("id", "academicYearId", "schoolId")`; a new unique index on a table Generera reads in long transactions would
  have been one more lock to take.
- `"TeachingBlockPlacementRooms"`: one row for each post of the block that chose a room of its own for a lesson. **A post with
  no row is a post whose room the engine chooses.** The key to `"Rooms"` is `NO ACTION`: a room a block names is not
  removed, and `rooms.service.ts` refuses its removal by the block's name and the post.

Four arms of RLS on each table, to `app_authenticated` only: the school's `SCHOOL_ADMIN` reads, and the one who writes
`PLANERING` writes. No arm for `authenticated`, `anon` or `service_role`, no `MAINTAIN` on Postgres 17. No arm names
`TEACHER`, so RLS section 494 (the catalogue guard of `Users.teaches`) is untouched. RLS sections 500 to 504 hold all of it.

### 24.1 Deploy order

**The migration first, then the merge.** It takes `SHARE ROW EXCLUSIVE` on `Schools`, `TeachingBlocks`,
`TeachingRequirements`, `TeachingRequirementShares` and `Rooms` (the keys and the triggers), all five `NOWAIT` in a loop with
a 30 s deadline: it never waits while it holds a lock, and after 30 s it stops with nothing changed
(`prisma migrate resolve --rolled-back 20270218090000_ett_block_kan_forlaggas`, then deploy again). Nothing is taken in
`ACCESS EXCLUSIVE`: no existing column changes.

1. Run `prod-fore.sql`, then `prisma migrate deploy` from a tree that has every applied migration and this one, then
   `prod-efter.sql`: the checks named `..._record_equal_before_and_after` must give the same figure twice (the old triggers of
   `TeachingRequirements`, `TeachingRequirementShares` and `TeachingBlocks` are unchanged and exactly the new ones added, and the
   post's own fit function is the same by `md5`).
2. Merge. The engine is not touched and keeps `pinnedLessons` (§21): check that `https://<solver-host>/openapi.json` has a
   schema named `PinnedLesson`. An engine without it answers 422 and the run is refused with
   `ENGINE_LACKS_PINNED_LESSONS`, nothing written (§22.1).
3. After: a school with no block placed sends the payload it always sent.

### 24.2 Rolling back

- **The API before this one ignores the new tables.** Rolled back past this release, a block that has lessons laid is laid
  freely by Generera, **without a word**: the placements are not lost, but they do nothing until the release is back, and
  nobody is told. Check `SELECT count(*) FROM "TeachingBlockPlacements"` before rolling back and tell the schools that have
  some.
- The migration is rolled back in this order (nothing else points at the tables):
  `DROP TRIGGER "TeachingBlocks_placements_fit" ON "TeachingBlocks"`,
  `DROP TRIGGER "TeachingRequirementShares_block_placements_fit" ON "TeachingRequirementShares"`,
  `DROP TRIGGER "TeachingRequirements_block_placements_fit" ON "TeachingRequirements"`,
  `DROP TRIGGER "TeachingRequirements_block_placement_rooms_leave" ON "TeachingRequirements"`,
  `DROP TABLE "TeachingBlockPlacementRooms"`, `DROP TABLE "TeachingBlockPlacements"`,
  `DROP FUNCTION app.teaching_block_placements_fit()`, `DROP FUNCTION app.teaching_block_placement_rooms_leave()`; then
  `prisma migrate resolve --rolled-back 20270218090000_ett_block_kan_forlaggas`. The post's own fit function and triggers
  were never touched.
- The engine is not rolled back past §21 while this gateway is live.

### 24.3 What the gateway does with a block's lesson

- **It is a pinned lesson of every member, never a lock.** A lock inside a block makes the block partly locked, which
  Generera refuses (`BLOCK_PARTLY_LOCKED`, `judgeBlocks`, untouched), and a pinned lesson with a room does the same job. So
  each lesson of the block is one row for each member, marked as a block's, and `lockedRowsOf` and `pinnedRowsOf` are
  the only place that tells a lock from a pin: the fixed lessons, what the post is asked for, its locked days, the teacher's
  weekdays, `placements`, the kept timetable and the coverage base all read `lockedRowsOf` and see no block row. A block's
  lesson with a room is sent in `pinnedLessons` with `roomId`, in the payload's anonymous id.
- **The same place k at every member.** The engine holds place k of a block at one day and start for every member or none
  (`PLACED_LESSONS_OF_BLOCK_DIFFER`). The members have the same lessons (`TB409`), and the rows are given in the same stable
  order (day, start, id of the lesson) for every member, so each member's pin lands at the same place k in its post's
  lessons, which is longest first. A block that is not sent as a block (one member) sends the pin as an ordinary pin.
- **A block on another block's times is placed through the block it follows.** Its own placements are refused by the
  database (`BP409`, rule `FOLLOWER`), and the follower's lessons are written at the leader's times beside the answer
  (`mirrorLessons`), as plain generated lessons with no mark: it is the leader's lessons that are laid and marked.
- **The lesson that comes back** is known by post, weekday, start and length, and is written locked, generated and marked
  `fromPlacement`, in the room the engine chose or the one named. A lesson the answer lacks is an answer to another
  request: 502, nothing written. A block's lesson in the grundschema is changed in the dialog, not on the card: moving the
  block's card is refused with `LESSON_IS_PLACED`; locking and unlocking the block's lessons is allowed, as it is for a
  single placed lesson.
- **Judged as the rows of a post, member by member, in one call.** The members are different teaching groups and do not stand
  in each other's way; a teacher, a room or a pupil two members share is a real clash and is refused, with the member
  named (`BLOCK_PLACEMENT_REFUSED`). An ordinary post is judged beside a block's lessons, and a post's demand counts a
  block's lessons as lessons laid for each member. At Generera the same judge refuses a lesson that cannot stand
  (`PLACEMENT_CANNOT_STAND`, with the block's name in `params.block`) before the engine is woken.
- **A save is refused for the rows it new or changed, not for the ones the block has.** A block whose lessons have stopped
  holding for a member (a teacher made unavailable that day, a frame cut short) has to be mended one lesson at a time, so the
  save judges every row but refuses only a row that no equal row of the block's stored list stands behind: the row is one
  member's lesson (day, start, length, weeks and that member's own room), counted and not looked up, as for a post
  (`placement-unchanged.ts`, `block-placement-unchanged.ts`). A row that is let stand is named in the answer as a verdict that is
  not ok, at the lesson's place in the list as the block reads it (day, start), and `GET` says the same; Generera refuses it by
  name as before. Giving one member a room changes that member's row and not the others'. The stored list is the one read
  after the block's row was taken (`FOR NO KEY UPDATE`), so no second read is asked for as the post's save does.
- **Stale.** A block's lesson or a room row changed while the engine solved is `GENERATE_STALE`: the key is built from the
  block's rows themselves, not from the members' derived rows. The basis a schemaförslag is solved from hashes each post's pin
  with the room in real ids, so a changed block placement makes saved proposals stale by itself.
- **What the first version does not do.** Blocks with a member that shares its lessons between teachers (`SHARES`), pairs of
  odd and even weeks in a block (`WEEKS`), and a block that follows another (`FOLLOWER`) cannot be laid. A post that joins a
  block has the lesson at once with its room chosen by the engine; a post that leaves a block takes only its own room row with
  it. Membership is never refused.
- **A room row that stays behind.** The trigger that removes a post's room rows when it leaves a block takes no lock (a lock there
  deadlocked against the member check; three hunts of 300 attempts found it, §24.2 lists the trigger). A room row written by a
  save that read the post as a member can therefore be committed just after the post left, and stays. The gateway and Generera
  read the room rows of members only, so while the post is outside the block the row is ignored; the next save of the block's
  lessons replaces every row of the block and it goes. **If the post goes back into the block before that save, the row is the
  post's room again, without a refusal:** Förlägg blocket shows it as the post's room, Generera holds the lesson in it (or names
  `PLACED_LESSON_ROOM_NOT_ALLOWED` if the room cannot take the lesson). It takes the race and the move back within one window, and
  the probe leaves the row in ten of ten runs of the race, so it is a known state and not a rare one. Closing it needs a lock in the
  leaving trigger, which is what the three hunts removed, so it is not closed here. Found by the review of #328.

### 24.4 Operations

- **Counting.** `SELECT count(*) FROM "TeachingBlockPlacements"` says how many lessons of how many blocks the schools laid;
  `SELECT count(*) FROM "TeachingBlockPlacementRooms"` how many posts chose a room of their own.
- **Room rows that stayed behind** (§24.3): rows whose post is no longer a member of the block they are laid for. Normally none.
  ```sql
  SELECT r.id, r."requirementId", p."blockId" AS laid_for, q."blockId" AS member_of
  FROM "TeachingBlockPlacementRooms" r
  JOIN "TeachingBlockPlacements" p ON p.id = r."placementId" AND p."schoolId" = r."schoolId"
  JOIN "TeachingRequirements" q ON q.id = r."requirementId" AND q."schoolId" = r."schoolId"
  WHERE q."blockId" IS DISTINCT FROM p."blockId";
  ```
  A school that has one saves the block once more with Förlägg blocket (every row of the block is replaced), or the rows are deleted by
  `id`. Read the rows before deleting, and only in the school that asked.
- **What it costs the search.** Measured on the högstadium benchmark (228 posts, 423 lessons, 30 of the posts in 6 blocks; §21.4) as
  the time to a first timetable of the satisfaction model without the objective, two workers each, the three variants started at
  once so that they share the machine's load (6 to 18 at the start of each round, never over 24), the lessons taken from a valid
  timetable of the same week. With **all 45 block lessons** (9 places in 6 blocks) laid: **5.4 s** with no room named, 6.7 s with
  nothing laid and **91.4 s** with a room named on every post (three rounds: 5.40 to 5.48, 6.70 to 6.77 and 89.6 to 91.5), in 6,780,
  6,735 and 9,324 variables. With every other place laid (25 lessons in 5 blocks): 4.4 s, 6.8 s and 29.9 s, in 6,760, 6,735 and 9,052
  variables. **The three rounds of a size followed one search path** (the same number of conflicts in each), so their span is the
  load and nothing else; eight search seeds were run beside them, and over those the medians were 8.2 s with no room named, 6.9 s with
  nothing laid and 70.3 s (30 to 110) with rooms for all, and for half of them 8.0 s, 7.0 s and 31.8 s (21 to 41). So a block laid
  with its rooms left to the engine costs the first timetable about what the same week with nothing laid costs (a median of 1.1
  times for all the lessons and 0.9 for half; a gain or a loss that survives a change of seed is not there, the ratio per seed
  running 0.45 to 2.9), and a block laid with a room on every post makes it 4 to 11 times dearer (median over the seeds, 2.0 to 18.5
  in single seeds) and the model 38 per cent larger: the room's class of its own, as §21.4 says of the post's rows. **Leave the rooms
  empty unless the school has to say which room.** Measured on one school and one timetable the lessons were taken from, to a first
  timetable only (no objective), and the span between seeds is wide; it is not measured on the 1,000- and 2,000-pupil benchmarks,
  which give no first timetable (§22.4).
- **The places rule, and the way out (§21.4, §22.4).** A pinned room is a room class of its own. Two posts of one block with
  one of two equal rooms each count as two places for a school's places rule, and a week can be refused under a HARD limit
  of one place that was possible with the rooms not named. The way out is the same as for a post's förläggning: leave the
  rooms empty ("Motorn väljer sal") and the engine chooses them, which counts as one group.
- **Locks of the block.** A lesson of a block that somebody locks by hand while the rest is to place is refused as before
  (`BLOCK_PARTLY_LOCKED`); a block's lesson in the dialog is never a lock.

## 25. The Rastra app and an administrator who teaches ("Administratör som undervisar", part 6 of 7)

The app learns what the gateway, the database and the web have known since parts 1 to 5 (§20): **an administrator who teaches**
(`Users.teaches`, set by rektor or a full administrator on `/admin/people`). She is still a `SCHOOL_ADMIN`: she signs in to the same
app as every administrator, starts on the same tab and has the same tab bar. The rights are the administrator's either way; the
mark adds one view and takes nothing away.

- **What is shown, and to whom.** At an alarm the **Larm** tab opens on **her own roll call** (the groups she answers for, counted
  as a teacher counts them, with the list kept on the phone for the night the network is gone), and the administration's view
  (start, watch, end) is one tap away in the header (**"Ledningens vy ›"**, and **"Mitt upprop ›"** back). Larm opens on the roll
  call every time the tab is shown and every time the app comes back to the front (a phone picked up, a tapped push: no focus event is sent for a
  tab that is already the selected one), also when nothing is going (the way to start an alarm is the button in the header, which is drawn
  while the first read is still going). A push about
  an alarm opens Larm as it does for every administrator, and Larm opens on the roll call. An administrator without the mark, a
  teacher, a pupil and a guardian see exactly what they saw before: the administrator's view alone, the teacher's roll call alone,
  nothing. Every other tab, and the start, are as they were.
- **What stays the teachers'.** **Vikarie** (cover requests) is not hers, and the mark opens no tab for it: the gateway refuses
  every route of the colleague side to an administrator (`@Roles(TEACHER)`, SP409, §20.5), and the substitute pool refuses one, so a
  tab for it would show an error and nothing else. A cover push never leads her there (it lands on Notiser, as it does for every
  administrator). The class teacher's routes (CT400) are not in the app.
- **No Ledighet in the app.** The app has no staff view of leave: Ledighet is the guardian's (answering a request for consent) and
  the mentor's inbox is the web's (§20.7), so there is nothing for the mark to narrow on the phone.
- **Where the mark comes from.** The profile read the app makes at sign-in and at every start with a network is
  `Users` `select('id, role, teaches')` for the person's own row, under RLS through PostgREST, as the web's session read is (§20.7).
  It is read strictly (`teaches === true`; a null, an absent field, the string "true" are not a mark), cached beside the role
  (the keychain key `sp_teaches`, `'true'` or `'false'`, written every time, removed at sign-out) and re-read by the recheck at every
  start with a network and every time the app returns to the front, so a mark given or taken away reaches a phone within the next
  recheck. The huvudman's reader has no row at a school and signs in to no school's app (`NO_PROFILE`), as before.
- **The database the app reads must hold `Users.teaches`: migration `20270212090000`** (part 1; in the production's 222 and in every
  database that has run part 1). Where the column is missing (a preview or an environment that lags) PostgREST answers 42703, the
  profile read fails and **nobody signs in**, in **either** app (Rastra vårdnadshavare reads the profile with the same code, although
  it has no use for the mark; the login screen says "LOGIN_FAILED", not a missing column). A phone that already holds a cached profile
  restores it without the read, and a recheck that fails leaves the session as it is. Check
  `SELECT 1 FROM "_prisma_migrations" WHERE migration_name LIKE '20270212090000%'` before an app build points at a database.
- **Older apps behave as today** (risk 9 of the investigation). An app built before this part does not select the column and ignores
  the field: a marked administrator sees the administration's view in Larm alone and her phone keeps no roll call list, exactly as
  now. That is not a new fault, and there is nothing to deploy for it: no migration, no gateway change, no store release is
  needed before the gateway goes out. The gateway must be at part 4 (§20.6: the three doors of `GET /crisis/mine`,
  `POST /crisis/mine/pupils` and `POST /crisis/mine/marks`), which is in the production.
- **A phone updated in the middle of a session** holds a profile cached with no mark, which reads as not marked: it behaves as
  before until the recheck has read her row (at the next start with a network, or when the app next comes to the front), and an
  offline start shows what it showed. The other way round (the mark taken away while a phone still holds it) the roll call's read
  answers 403 until the recheck, and the screen says it could not read the list; nothing is shown that she may not see.
- **Nothing is run at deploy.** No migration, no engine, no gateway change. The production has no marked person today, so **nobody is
  shown anything the day this ships**.
- **Deploy order:** none beyond the migration of part 1 (already run). The app is released through the store builds (§15) when
  it suits.
- **Rolling back:** revert the pull request, or ship the previous build; a phone that holds the key `sp_teaches` leaves it in the
  keychain until the next sign-out, where it is removed with the rest of the session and read by nothing.
- **Not in this part:** the planner's pickers and `lärare.csv` (the web's part 5b) and the handbook (part 7).
- **Tests:** `appGate.test.ts` (which views and tabs each role has, marked or not, and where a push leads);
  `staffShell.test.tsx` (the tab bar of a teacher, an administrator and a marked administrator, Vikarie off for both
  administrators); `CrisisScreen.teaching.test.tsx` (the screen for each person against a stubbed gateway: the views, the switch,
  the reset at every focus, the routes asked); `crisisOffline.test.ts` (the phone keeps a list and asks about an alarm push for a
  teacher and a marked administrator and for no one else); `authService.test.ts` and `secureTokenStore.test.ts` (the profile read,
  the strict reading, the old cache, the recheck both ways); `CoverRequestsScreen.test.tsx` (a marked administrator reads nothing);
  `teachingAdmin.contract.test.ts` reads the gateway's controllers as text and holds that every call the staff shell makes admits
  her, that the cover requests stay a teacher's, that every call of the app is sorted and that no staff screen reads the leave
  service.

## 26. The job's doors answer no login ("Dörrvakten")

Six `SECURITY DEFINER` functions in the schema `app` that the API's role may run are not for a person: they are the door of
something that runs with no login: a background job, the SS12000 sync's principal or, at one of them, an integration key's principal. A job opens its
transaction with `withDeliveryService` and sets no claims; every login sets them. Four of the six asked whether the session
**resolved to a person** (`app.current_user_id() IS NOT NULL`), which is not the same as a login: the huvudman's reader and the
municipality's administrator have claims and no `Users` row, and for them the guard let go. The two meal doors had no guard at
all. Section 10, note (6), holds the same lesson for the three doors of Kvittens (20270202090000); the reviews of #289 and #279 named
these six.

What a login with no person row could do, measured as `app_authenticated` on real rows:

- `app.cover_requests_settle` closed every school's expired cover request and handed back the sender's `authId` and profile.
- `app.crisis_settle` ended every school's alarm that had stood open longer than it can (12 hours, 3 for an exercise).
- `app.leave_requests_tell_new_mentors` and `app.ss12000_source_secrets` have a door for a person and one for what runs with no
  login. At `leave_requests_tell_new_mentors` that is the sync's or an integration key's principal; at `ss12000_source_secrets`
  it is **the sync's principal only**: an integration key's principal is refused there (`SS403`, "integrationen läser inga
  hemligheter") and always was. A login with no person row got nothing alone, but was let into the principal's branch when
  the principal's own setting stood beside its claims, which no gateway route does. It was handed the school's owed leave
  notices (and the notices were written), and the ciphertexts of a source's secrets.
- `app.meal_letter` and `app.meal_letter_schools` answered anybody with a login, a teacher at another school included: the
  school's kitchen address and the day's counts, and the list of schools with the letter on.

No gateway route reaches a door with a login: the jobs run them in `withDeliveryService`, the sync in `withSyncPrincipal` and,
at the leave door only, the key in `withServicePrincipal` (no claims), and the person's door in an ordinary request. This is defence in
depth, and the gateway is not changed.

Migration `20270220090000_jobbens_dorrar_svarar_inte_en_inloggning_utan_personrad`: six `CREATE OR REPLACE FUNCTION` and six
`COMMENT ON FUNCTION`. **No table, no grant, no new object.** The guard is the one `app.ack_remind_request` got in
20270202090000: no claims (`request.jwt.claims`) and no lone subject setting (`request.jwt.claim.sub`), an empty string read as
none (a pooled connection reads `''` after another request's transaction, not `NULL`). Each door keeps its own answer:

| Door | What it does now |
|---|---|
| `cover_requests_settle`, `crisis_settle` | refuse every login (`CR403`, `KL403`), as they refused a person; the job's door (no claims) goes |
| `leave_requests_tell_new_mentors` | the person's branch is unchanged; the principal's branch lets in a session with no login only |
| `ss12000_source_secrets` | the sync reads with no login beside it; a login beside the sync's setting is refused (`SS403`), as a person always was; the administrator is unchanged |
| `meal_letter`, `meal_letter_schools` | `NULL` and no rows for a login. They stay `LANGUAGE sql` with the guard as a condition of the query, so the plan is the one it was (a `plpgsql` function is planned differently after five calls, and the job asks for the list every second minute) |

`md5(prosrc)` of the six, before and after (the bodies differ by the guard and nothing else; language, volatility,
`SECURITY DEFINER`, `search_path` and `jit = off` of the meal doors, owner and ACL are the same, `CREATE OR REPLACE` keeps owner
and ACL):

| Function | Before | After |
|---|---|---|
| `app.cover_requests_settle` | `4abfa824fd204376ba82929f62c90a96` | `8b8cc3e8b34179d90746aa1fc038694f` |
| `app.crisis_settle` | `7674b1cf4892beaba5f48926b8da17a0` | `df2d2c9d74b0245233de7b67c4b5c78f` |
| `app.leave_requests_tell_new_mentors` | `a75dd0895a688871a0654c8c4f97f3cf` | `3a42a387791b438d815432064bf82e80` |
| `app.ss12000_source_secrets` | `4ca02603ce4956cf53c4a00296e6a3c9` | `b820ebf456539d236b1bc4fea0e729bc` |
| `app.meal_letter` | `2a5d90dedca1516969347a06d216e87b` | `ceb84a1e99239a88f75064e6f15463f3` |
| `app.meal_letter_schools` | `f117f51aaf39fe038a4b516dbd82a367` | `d30fffeb44fbaa9ac84ffcca38145914` |

### 26.1 Deploy order

**The migration first, then the merge.** The file writes and alters no table. It takes `ShareUpdateExclusive` on the six
functions' own rows in `pg_proc` and, for the two `LANGUAGE sql` meal doors (checked when they are created), `ACCESS SHARE` on
`KitchenSettings`, `Schools` and `CalendarLunches` until it commits: that blocks only an `ACCESS EXCLUSIVE` `ALTER TABLE`, which
no request takes. Measured on PostgreSQL 17: the file runs in 0.13 s beside a door held open, and the doors answer in 0.14 s
while the file's transaction is open.

1. Run `prod-fore.sql`, then `prisma migrate deploy` from a tree that has every applied migration and this one (the file's
   `_prisma_migrations` checksum is its sha256, which `prod-efter.sql` holds), then `prod-efter.sql`. The checks named
   `..._record_equal_before_and_after` must give the same figure twice. A `prosrc` row of `prod-fore.sql` that is not ok means
   another change has rewritten one of the six since this file was made: stop, and build the migration on the body production
   has (two migrations that replace one function drop each other's change without a git conflict, so the later one is rebuilt on
   the earlier one's body).
2. Merge. Nothing in the gateway or the engine changed, and the jobs go on as they were: they set no claims, so the guard is open
   for them. An API released before this one runs against the new database and the other way round without a difference.
3. After: the next tick of the cover job (every 5 minutes), the crisis job (every 15) and the meal letter job (every 2) log as
   before; `JobRuns` has no failed row for them.

### 26.2 Rolling back

- Nothing is written to a table, so there is no data to put back. The migration is one transaction: if it stops, nothing
  applied, and `prisma migrate resolve --rolled-back 20270220090000_jobbens_dorrar_svarar_inte_en_inloggning_utan_personrad`
  lets the next deploy try again.
- To put the old doors back (which reopens the gap), write a new migration that runs `CREATE OR REPLACE FUNCTION` with the old
  bodies. They are in the files that wrote them, and `md5(prosrc)` of each must equal the "Before" column above:
  `app.cover_requests_settle` in 20270102091000, `app.crisis_settle` in 20270113091000, `app.leave_requests_tell_new_mentors` and
  `app.ss12000_source_secrets` in 20261212090300, `app.meal_letter` and `app.meal_letter_schools` in 20270123090000 (with
  their `COMMENT ON FUNCTION`). Copy the whole statement, language and settings included, because `CREATE OR REPLACE` resets
  whatever it does not repeat. Do not edit the migration after it has run: its checksum is in production's
  `_prisma_migrations`.

### 26.3 What is not done here

- **The tjänsteprincipalerna.** The guard asks for a login; it does not ask for no principal. `cover_requests_settle` and
  `crisis_settle` do not refuse a session that carries only a principal's setting and no claims (the same boundary as #289, its
  U-2). No gateway route calls the doors with a principal.
- **The other job functions** (`app.absence_stats_*`, `app.gallring_*`, `app.reporting_*` and the like) take a school id as an
  argument and have no principal check at all (the review of #282, U-1). They are a review of their own, not this migration.
- **Reading the setting without `missing_ok`** (`current_setting('request.jwt.claims')`) is caught by the text of each door in
  RLS sections 515 to 519, and by the adapter probe's new connection, but by no behaviour in the suite, which has set the
  setting before the section runs (#289's U-3).
- **A wrong sentence in the migration's header comment.** The comment of 20270220090000 says, under "Vad som fanns" and in the
  paragraph on who runs the doors, that the integration key's principal is one of those let in at both
  `leave_requests_tell_new_mentors` and `ss12000_source_secrets`. At `ss12000_source_secrets` that is wrong: the key's principal
  is refused there (`SS403`), before this migration and after it, and only the sync's principal is let in with no login. The
  function body and its `COMMENT ON FUNCTION` say it rightly. The header is not corrected, because a changed line changes the
  file's sha256, which is its checksum in `_prisma_migrations`; this section is the correction.

### 26.4 Operations

- RLS sections 515 to 519 (and 515o to 519o in `rls-owner-checks.sql`) hold it: the guard's text in every door, the rights
  unchanged (`app_authenticated` runs the six, `authenticated` and `anon` none), what each door answers under every setting a
  session can carry, and, with rows planted as the owner, that the job's door does its work while no login does: a cover
  request that ran out is settled and its sender named, an alarm that stood too long is ended, a leave notice is written, a
  source's secret is read, and a kitchen letter is handed over.
- After a release that rewrites one of the six, run `prod-fore.sql` of that release: the `prosrc` row of the function it
  rewrites is the one that must equal the "After" column above.

## 27. Generera as a queue entry ("Generera som kö", omgång 12, M4)

A Generera run is a row in `OptimizationJobs` that the API process which took the request works on in the background. The row
was durable and the work was not: every merge deploys the API, a run takes up to about four minutes, and a process that went in
the middle left its row at `RUNNING` for ever, the page polling it for ever, and nothing stopped two administrators starting two
runs of one year. Schemaförslag's runs (`ScheduleCandidateRuns`, 20261125090000) already had a heartbeat, a lease, a sweep and
a partial unique index; Generera now has the same. The engine is not changed.

Migration `20270222090000_en_generera_korning_har_en_lease_och_ett_lasar_hogst_en_aktiv`: three columns on `OptimizationJobs`,
two CHECKs, one partial unique index and one function. No new table, no grant on a table, no arm.

| Added | What it is |
|---|---|
| `claimedBy text` | The API process that runs it (`host:pid:random`), for the log. Null before the column and for a run an older API started. Never on the wire. |
| `heartbeatAt timestamptz` | The database's clock at the run's last sign of life. Default `now()`. |
| `leaseUntil timestamptz` | Until when the run holds its year. Default `now() + 15 minutes`, which is what an API from before the column gives a run. CHECK: at least the heartbeat and at most an hour past it. |
| `OptimizationJobs_one_active_per_year` | `UNIQUE (schoolId, academicYearId) WHERE status IN ('PENDING','RUNNING')`: at most one active run per year, by the database. |
| `app.optimization_jobs_sweep()` | `SECURITY DEFINER`, no argument, returns the number of runs it failed. Fails an active run whose lease ran out, or that began more than 30 minutes ago, `FAILED` with `ENGINE_RUN_ABANDONED`, finished when its lease ran out. Takes its rows `FOR UPDATE SKIP LOCKED`. Refuses (`GQ403`) a call that carries a login, as the doors of §26 do; only the API's role may run it. |

### 27.1 The lease, the heartbeat and what the engine can still be doing

`OptimizationJobsService` makes a first heartbeat before the engine call (`RUNNING`, the claimant, the lease: one
compare-and-set, `WHERE status IN ('PENDING','RUNNING')`) and then renews it every 30 seconds with a timer while the run
lives. Each renewal sets the lease to **the API's wait for the engine (`AI_ENGINE_TIMEOUT_MS`) plus 30 seconds**, clamped to the
database's 60–3600 s: at the 240 000 ms §5 asks for at a 180 s budget, 270 s. §5 requires `AI_ENGINE_TIMEOUT_MS` to exceed the
engine's ceiling (`optimize.solve_ceiling_seconds`: the budget, the probe and thirty seconds: 230 s at 180 and 20), so a run whose
lease has run out has no engine call left to wait for, and the year can be given to the next one without a second solve starting
beside the first. (The engine's 503 at its ceiling stops its wait and not its solve thread, which `ENGINE_TIMED_OUT` says to
the school; the ten seconds the API's wait has over the ceiling, and the thirty on top of it, are where that goes. It is a margin,
not a proof, until the engine reports when its thread ends.) When the engine can say its own ceiling (M1), the lease takes it from there; until then it follows the wait
the API enforces, as the page's "up to N minutes" does. `CANDIDATES_BACKGROUND=off` turns off this sweep as well as
schemaförslag's.

A renewal that finds the run no longer active (the sweep gave it up, a restart failed it, it ended) stops the timer and writes
nothing. A run whose engine call comes back after that writes its own outcome, `SUCCEEDED` or `FAILED`, over what was guessed
about it, and takes the abandonment off the row.

### 27.2 What ends a run whose process went away

1. **A restart that can say so.** `OnModuleDestroy` fails the runs this instance has in flight, best effort, at once:
   `FAILED`, `ENGINE_RUN_ABANDONED`. The year is free for the next start.
2. **The sweep.** Before every start (in a transaction of its own, so a failure costs only what it would have freed), and every
   five minutes as the job `generate-runs-sweep` in the gateway's runner (`JobRuns`).
3. **The page's own read.** `GET /optimization/jobs/:id` and the history show an active run past its lease as `FAILED`
   `ENGINE_RUN_ABANDONED`, finished when the lease ran out, before the sweep has come round. The page says
   "Körningen avbröts när tjänsten startades om. Kör Generera igen." and offers "Kör igen", also after a reload when the year's
   newest run is such a run, and the history names it "Avbröts".

### 27.3 One active run per year, and how it meets the other refusals

| Code | 409 when | Raised by |
|---|---|---|
| `GENERATE_ALREADY_RUNNING` | a Generera run of the year is going and a second is started | the partial unique index (23505 on the insert), the one thing that holds even for a start that took no lock |
| `CANDIDATES_RUNNING` | Generera is started beside a live schemaförslag run of the year | the start's own check, under the year's start lock |
| `GENERATE_RUNNING` | a schemaförslag run is started, or one is applied, beside a live Generera run of the year | the candidates' check, which now counts a Generera run only while it is inside its lease and its 15 minutes (`leaseUntil >= now`) |
| `SCHEDULE_BUSY` | the year's start lock is not free within 5 s, or (at the end of a run) the regeneration lock is not | `lockYearForSolveStart`, and the write at the end of a run, which stores it on the run |

`SCHEDULE_BUSY` is "someone is rewriting the year right now": an apply, a restore or a run's write holds the regeneration lock for a
moment, and the answer is to try again in a few seconds. `GENERATE_ALREADY_RUNNING` is "a run is going": the second start waits
for it, and the page keeps the button waiting with the reason beside it, and after a refused click reads the history again so the
run shows and is polled. The two kinds of run (Generera's and schemaförslag's) are kept apart as before, by the start lock and each
start's check of the other's table: a constraint cannot span two tables, so that half is not the database's.

### 27.4 Production's rows that hang now

Production can hold rows that stopped at `RUNNING`. A unique index cannot be built over two of one year, so the migration, in
its one transaction (the file has a `$$` body), first: closes every active run older than 15 minutes (no run of the old API
lasts that long; the old gateway and page already called a job older than that lost) as `FAILED` `ENGINE_RUN_ABANDONED`; leaves
every younger one exactly as it is, with fifteen minutes from its start as its lease; and **stops with nothing changed** if two
runs of one year are both younger than that (`prisma migrate resolve --rolled-back <name>`, then deploy again when one has ended).
`prod-fore.sql` counts them: `years_with_two_runs_going_both_younger_than_15_minutes_...` must be 0.

### 27.5 Deploy order, and what the old API does in between

**The migration first, then the merge.** The API after this names the new columns and calls the new function. The file takes
`OptimizationJobs` `ACCESS EXCLUSIVE` NOWAIT in a loop (50 ms apart, 30 s at most, then it stops with nothing changed), the only
table it touches; `ADD COLUMN` with a stable default rewrites nothing. The API before it names the old columns only and
keeps working; the one difference, said once: in the minutes between the migration and the API's deploy, a start of a year that
already has a run going fails (23505, a 500 from the old gateway) where it used to start a second solve beside the first.

Rollback: the API from before runs against the new schema unchanged. To take the guarantee away, `DROP INDEX
"OptimizationJobs_one_active_per_year"`; the columns and the function can stay.

### 27.6 What is not done

- No other process picks a lost run up: it is failed with a sentence that says so, and the administrator runs Generera again.
- The synchronous `POST /optimization/trigger` has no row and so no lease; it is not a queue entry.
- The lease follows `AI_ENGINE_TIMEOUT_MS` and not the engine's own ceiling until M1 lets the API read that.

### 27.7 Tests

RLS sections 530–534 (the catalogue; the index in action for each status and school; the CHECKs at their edges and the renewal
through the API's role and the roles that may not; the sweep to the microsecond with `now()` held still by the transaction;
the door's refusal of every shape of login and its rights), on PostgreSQL 16 and 17. The adapter probe's `gq-a`–`gq-j`
(`scripts/test/probe-generera-ko.ts`) run the real service against the database: a start's claim and lease, the second start's 409
and the adapter's own shape of the refusal, two starts at once as one run and one 409, a renewal, an expired lease read and swept,
a row a heartbeat holds skipped, the door through the adapter, a second year of one school beside the first, a run that comes back
after being given up, a restart, and a start while the API's own clock leads the database's by twenty minutes (the heartbeat and the
lease are both filled by the database's clock, which the check between them compares).

A run across a real jump of the database's clock was run by hand on the clock-shim image (a probe in CI cannot restart its
database, so it is not a CI step). Three steps ran against one database kept on a volume; between them it was recreated with its
`CLOCK_REALTIME` moved on by an offset, and the API process was started with its own clock moved on by the same offset. A run
started through the real service took a lease of 270 s and its process was ended without `OnModuleDestroy`. With the database's clock moved on 100 s the page read it as
running and a second start was 409 `GENERATE_ALREADY_RUNNING`; moved on 300 s the page read it as `FAILED`
`ENGINE_RUN_ABANDONED` while the row still said `RUNNING`, and a start swept it first (finished at its lease end) and went through.

## 28. A school's saved column mappings ("Kolumnmappning", part 1 of 3: the templates)

The browser maps the columns of a school's own file to Rastra's fields (round 12, X2); this part keeps what the school named.
Migration `20270223090000_en_skola_sparar_kolumnmallar_for_sina_importer` makes one table, `ImportMappingTemplates`
(`id`, `schoolId`, `kind`, `name`, `headerRow`, `placements`, `createdAt`, `updatedAt`), and the gateway gets
`api/v1/import-templates` (list, create, change, remove). The mapping is applied in the browser; nothing here reads a file.

- **What a row holds.** A kind of import (one of thirteen: the eleven CSV imports, the lokal timplan's and the table of
  Schemat som tabell), a name, the row the headers stand on when a title lies above them, and a list of `{ key, label, field }`:
  the header with case, spaces, punctuation and diacritics dropped, the header as written, and the field it stands for or
  null for a column the school chose not to read. Headers and fields, never a value, and never a header that has the shape of
  a personnummer (the gateway refuses one with `TEMPLATE_PERSONAL_NUMBER`, and the row has no key to a person).
- **Who.** Every administrator reads. Planering writes (the route says `@Area('PLANERING')` and the arms ask
  `app.current_user_may('PLANERING', true)`). Teachers, pupils, guardians and `anon` have no arm, and no PostgREST role holds
  a privilege on the table. An administrator with only Personal can map and import but cannot save the mapping (403
  `AREA_NOT_YOURS`).
- **The same change adds** two optional fields to a requirements row, `teacherSignature` and `coTeacherSignature` (a teacher
  by lärarsignatur for the year the dialog names, in place of an e-mail address), and their two names in
  `REQUIREMENT_FILE_COLUMNS` and `OPTIONAL_REQUIREMENT_COLUMNS`. A row naming a teacher both ways is refused, and so is a
  signature that two teachers hold in spellings that differ only in case.

### 28.1 Deploy order

1. Run the migration. It adds a table nothing else reads, so a gateway from before it is unaffected and a migration with no
   gateway is harmless. In production, as the owner, from a tree that has every applied migration: the release's
   `prod-fore.sql`, `migrate deploy`, the release's `prod-efter.sql` (read-only SQL kept with the release's notes, not in this
   repository). The migration's one lock on a live table is SHARE ROW EXCLUSIVE on `Schools` for the foreign key: it waits
   for a transaction that is writing `Schools` (nothing in the gateway does) and blocks nothing that reads it or checks a
   key against it.
2. Merge. The gateway answers the new routes, and the signature fields are accepted (`forbidNonWhitelisted` is on, so a
   gateway from before them answers 400 to a row that carries one: the web that sends them is deployed after this).
3. The web (parts 2 and 3) lists the templates when a dialog opens and treats a failed read as "no templates": it works
   against a gateway that has none of this.

### 28.2 Rolling back

- Nothing else reads the table, so `DROP TABLE "ImportMappingTemplates"` is the whole of it; the saved mappings go with it,
  and no import is affected (a mapping is only a convenience over the same rows). Mark the migration rolled back
  (`prisma migrate resolve --rolled-back …`) only if it stopped half-way: it is one transaction.
- The signature fields are additive: a client that never sends them is unchanged. Do not edit the migration after it has run.

### 28.3 What the gateway does with a template

- `name` is trimmed and held to 1-80 characters without control characters; `placements` to 200 posts and 40 000 bytes; every
  `field` must be one of the kind's (`src/import-templates/import-fields.ts`, held equal to a fixture the web reads); no
  field is placed twice and no two fields that read the same cells are placed together (`timeRange` with `start`/`end`,
  `teacherList` with `teacher`/`coTeacher`). A school keeps at most 20 templates per kind (409 `TEMPLATE_LIMIT`), and a name
  is taken once per school and kind (409 `TEMPLATE_NAME_TAKEN`, also for the second of two writers at once).
- The answers carry a `code` and flat `params` (the field, the kind, an index), never a header that looks like a personnummer.

### 28.4 Operations

- RLS sections 535 to 539 hold it, on PG 17 and PG 16: the catalogue (columns, keys, the CHECKs, indexes, four arms and no
  other, the API role's four privileges, nobody's MAINTAIN), who reads and who writes, the school, the bounds, and PostgREST's
  roles. Section 116's area matrix lists the table (`src/auth/admin-areas.ts`). The adapter probe's `km1` to `km5` run the
  service and the signature import through the real adapter.
- What `prod-efter.sql` asks of production, read-only and as the owner (the API's own login is not on the operator's
  machine, so each role's rights are read with `has_table_privilege`): the table has the columns, keys, CHECKs and indexes
  above, row security is on and not forced, the four arms read as the migration wrote them (text and md5), the API role holds
  SELECT, INSERT, UPDATE and DELETE and nothing more, `authenticated`, `anon` and `service_role` write nothing, nobody holds
  MAINTAIN, and no other table, function or arm changed. That a Planering administrator writes and a läsare does not is held
  by RLS sections 535 to 539, not asked of production.

## 29. The job's other doors answer no login ("Jobbens övriga dörrar", omgång 12, A2)

Section 26 closed six `SECURITY DEFINER` functions in the schema `app` that the API's role may run and that are for what runs
with no login. 37 more are of the same kind and had no guard at all: the doors of the background jobs (absence statistics,
absence watch, gallring, reporting rate, push and delivery, the school's export, the jobs' bookkeeping, the candidate sweep) and
of the SS12000 scheduler. Every job opens its transaction with `withDeliveryService` (`src/database/prisma.service.ts`), which
sets no claims; every login sets them. The doors take a school id, a run id or a lease as an argument and answer whoever asks.
The review of #334 (U-3) and of #282 (U-1) left them untried; this is the inventory, one door at a time.

What a login could do, measured as `app_authenticated` with claims for an ordinary teacher at another school, on real rows:

- `app.gallring_begin` opened a gallring run for any school, and with it `app.gallring_departed_due` listed that school's
  departed people with `Users.id`, `authId` and whether they have a login of their own to delete. `app.gallring_schools` listed the
  schools on the nightly list. `gallring_purge` and `gallring_pseudonymise` took what had already fallen due by the school's
  period, for any school, at any time of day.
- `app.push_targets` answered a user's Expo push token, for any school. Whoever holds a token can send notices to the device.
- `app.absence_watch_digest`, `app.reporting_digest` and `app.reporting_remind` answer the addresses of the school's rektor,
  administrators and teachers (and write the notices the job writes); `app.school_export_claim` answers the ordering
  administrator's login. Read in the body, not run on planted rows.
- The rest count, book and tidy (absence statistics, reporting rate, `JobRuns` and `JobClaims`, the candidate sweep, the SS12000
  scheduler) for any school. Their answers are smaller, but none of them tells a job from a login.

No gateway route reaches one with a login: all go through `withDeliveryService`. What protected them was the gateway and not
the database, the defence in depth that section 26 took back for six others. A mistake in a route that runs one in a `withRls`
transaction, or an SQL injection in a person's request, would have reached every school's push tokens, departed people's login ids and
the staff's addresses.

Beside them, `app.login_is_held_elsewhere(authId, userId)` is a person's door (an administrator's `withRls` in
`users.service.ts`) and answered a session with no login as well, a yes or no about whether a login id is held by any school.

Migration `20270224090000_jobbens_ovriga_dorrar_svarar_inte_en_inloggning`: 38 `CREATE OR REPLACE FUNCTION` and 38
`COMMENT ON FUNCTION`. **No table, no grant, no new object, no gateway change.** The guard is the one of section 26 (no claims, no
lone subject setting, an empty string read as none), each door refusing the way it answers:

| Doors | What they do now |
|---|---|
| 28 `plpgsql` doors | refuse a login with the family's own code, as the first statement: `AS403` (`absence_stats_*`), `AW403` (`absence_watch_digest`, `_evaluate`), `GL403` (`gallring_begin`, `_claim_person`, `_departed_due`, `_finish`, `_pseudonymise`, `_purge`), `JR403` (`job_claim_nightly`, `job_run_settled`), `PU403` (`push_due_receipts`, `_receipts_settled`, `_settle`), `RR403` (`reporting_compute`, `_digest`, `_remind`), `SC403` (`schedule_candidates_sweep`), `SS403` (`school_export_*`, `ss12000_due_sources`, `ss12000_housekeeping`). The job never sees them: it sets no claims |
| 9 `LANGUAGE sql` doors (`absence_watch_digest_due`, `absence_watch_schools`, `delivery_opt_outs`, `gallring_schools`, `job_claim_finished`, `job_runs_latest`, `push_targets`, `reporting_digest_due`, `reporting_schools`) | answer nothing to a login: the guard is a condition of the query, so they stay `LANGUAGE sql` and the plan is the one it was (a `plpgsql` function is planned differently after five calls) |
| `login_is_held_elsewhere` | the person's door asks for a login: it answers `NULL` to a session with none, and yes or no as before to one with. The caller (`loginIsHeldElsewhere`) already counts what is not `false` as held |

The service principals alone (`app.service_school_id`, `app.sync_school_id`) are let in, as in section 26 (its decision 5): it is the
principal's guard and not a person's, and no gateway route calls these doors with one. `app.schedule_candidate_runs_active()` is not
changed: `schedule-candidates.service.ts` calls it inside a person's `withRls` transaction, and it answers a number.

`md5(prosrc)` of the 38, before and after (the bodies differ by the guard and nothing else; language, volatility, `SECURITY DEFINER`,
`search_path`, `jit = off` of `absence_stats_month`, owner and ACL are the same, `CREATE OR REPLACE` keeps owner and ACL; the
"before" is main's `181cfc6f`, and production's is proved by the read-only query below):

| Function | Before | After |
|---|---|---|
| `app.absence_stats_month` | `38e6f66e73a8b1463403a873a9b9ebb4` | `e3a13cf605064934b74680ace428f329` |
| `app.absence_stats_plan` | `fe4be3f020bc5cafa67cae4e14920904` | `ee8384fd524d7533932084a5807a5499` |
| `app.absence_stats_trim` | `7c04a5d9d6802015f590c8fd05360033` | `b56fcdcab451c1efc3dea6261e1e21c6` |
| `app.absence_watch_digest` | `33b7080fd4cbcff036546330291131aa` | `e2faa250036d1172ed3b46246fb0ade5` |
| `app.absence_watch_digest_due` | `0e2cc7e928e4968be9174bffaf5ff5db` | `56a3535b7028c910a2ab3cf696362f3f` |
| `app.absence_watch_evaluate` | `6887434156b3653391f048c10e95102e` | `bce39e38a461202e20e3d5c83fe2cf71` |
| `app.absence_watch_schools` | `ae5df619a12580140917f0eeb1e9780b` | `0612ff0195d813b026c6c15ab4a0ad2e` |
| `app.delivery_opt_outs` | `afe39140c99747f71d7fa9801389f806` | `0c0f24e2c8d75f55eb6eab50f7b79ec8` |
| `app.gallring_begin` | `a45f7e98dcc92f5521f246ecd21ca4cb` | `48c292e57cd0e053ef8e9c3c0745b131` |
| `app.gallring_claim_person` | `544d8c822bcdc0a99b51197597431895` | `cb6f21244daa3afa0624c01def1a1e28` |
| `app.gallring_departed_due` | `0c416d79e729340fda00835cd02b2248` | `484b71d8c84069271c45ea62abc84bcc` |
| `app.gallring_finish` | `dac43dd28c3f774bddd131ae0ee3ffb0` | `7bc85742b38238441be0ee9234857e11` |
| `app.gallring_pseudonymise` | `1f2b20ccf7e10b66c90664c235162a43` | `d852d535cb86226eb97b068fa3984014` |
| `app.gallring_purge` | `6b5601ad006da9fa3309664e108f4720` | `2f5e9af613b6dc5ef6ea9ca361c21ee2` |
| `app.gallring_schools` | `678de0508a29750b2b7a0ae39f239ad1` | `f88b5e2cbec1733626246bc7d4952080` |
| `app.job_claim_finished` | `c0804d8e74853e8dc7e795e2aa185fd6` | `9ec4e83211895c0beb1c63c77e17d46d` |
| `app.job_claim_nightly` | `59b6040f15120cf6530a4d0269618435` | `5332d1b162b9d57b3ddb58170dc52047` |
| `app.job_run_settled` | `1b6f7e600d490460f9c3cba19e2d8caf` | `4121b2299b5154f28aaad8d0095df17c` |
| `app.job_runs_latest` | `599f2227928c6c265b3ea0b88b234001` | `b67c758ec597e45636829a90c519360d` |
| `app.login_is_held_elsewhere` | `f05324e3800a6efa51583b9c020058e5` | `5c87ea949eb907503cecab6094cfcf39` |
| `app.push_due_receipts` | `9efa979a7c37d3b45431a54c7b3187a1` | `c5addc3a80a4f005f88f1e2737fd037e` |
| `app.push_receipts_settled` | `086ae34de0257f0fcfc2aaa33cc872e4` | `70229119b7e03c03c231477745e371ab` |
| `app.push_settle` | `1ab3678ea869179159bc3bb1bc5fffde` | `0e42ecff8947a041cd48e56718376f1a` |
| `app.push_targets` | `65a2256aab3d0a8aba027c1f4a9096d4` | `b2a027b0d1583e974c08c1e4bd675c7e` |
| `app.reporting_compute` | `9d22e8a75121c9a4f348f4cde6bc1c67` | `736a4557fc1654d5accd56c340cc4c19` |
| `app.reporting_digest` | `a0d17f4d6d64b9d19afa544e4224887a` | `51289c0ffb8b3cd4410d5f375c07d7f0` |
| `app.reporting_digest_due` | `e3f650c7a604bd699aa47d4061303a58` | `9bfdb918471abf398ac35a756f47ac04` |
| `app.reporting_remind` | `08aa2c64014c626fbd98f70e9d82db5d` | `117b6e6aed8b4dae2b08602d8b915bda` |
| `app.reporting_schools` | `5dc7b516803cd03a04a71bebf29a17d0` | `bd505c0aab88a4a2db25643067bd7529` |
| `app.schedule_candidates_sweep` | `ea5aeeb4196a86bd5c12a5d0614bffca` | `3bfd9779243a25d1a6d7d00391f9fd01` |
| `app.school_export_claim` | `d033c18afc4ffe9854476d92ca32ea53` | `3c79426fd33650a5b341b8446c5797fb` |
| `app.school_export_expire` | `fc0178f3a5649fc4a13d43632fa45e47` | `15a062b3d4dc53c4454d3777e551f53a` |
| `app.school_export_fail` | `80b05c872c038c2c577a33c9f9cf068a` | `9457e2025313b0d23521fce72bd0e587` |
| `app.school_export_finish` | `b62862c5f2a2de574ccef7a685a5c07a` | `6c90611d521d3e02c75c21e7344d5cfc` |
| `app.school_export_heartbeat` | `355710ca6aa22169320f6f8aec9267ee` | `a54d44f9d7a4258cb88b64bdb8f9a444` |
| `app.school_export_put` | `c8bde3e2a8423f5cd5c281c867d8b90d` | `609642aa0572751dce7b6eed447b331f` |
| `app.ss12000_due_sources` | `4656df9e139c56f1470035745bb2a998` | `9495a294971450b17d3f76c2370b1b0c` |
| `app.ss12000_housekeeping` | `3444b63e1af391146fea30892c57a4fd` | `6ee3a36ae7c4abb8749f43ce5743f6d3` |

### 29.1 Deploy order

**The migration first, then the merge**, from a tree that has every applied migration and this one. The file writes and alters no table.
It takes `ShareUpdateExclusive` on the 38 functions' rows in `pg_proc` and, for the ten `LANGUAGE sql` functions (checked when
they are created), `ACCESS SHARE` on the tables they read until it commits: that blocks only an `ACCESS EXCLUSIVE` `ALTER TABLE`, which no request takes.

1. Run the read-only query `fn|md5` for the 38 functions against production (`PGOPTIONS='-c default_transaction_read_only=on'`; `COLLATE "C"`
   on its `ORDER BY`, because production sorts en_US). Every `md5` must equal the "Before" column. A row that does not means another change has
   rewritten the function since this file was made: stop, and build the migration on the body production has (two migrations that
   replace one function drop each other's change without a git conflict, so the later one is rebuilt on the earlier one's body).
2. `prisma migrate deploy`. Then the same query: the "After" column.
3. Merge. An API released before this one runs against the new database and the other way round without a difference: the jobs set
   no claims, so the guard is open for them. After: the next ticks of the jobs log as before; `JobRuns` has no failed row for them.

### 29.2 Rolling back

- Nothing is written to a table, so there is no data to put back. The migration is one transaction: if it stops, nothing applied.
- To put the old doors back (which reopens the gap), write a new migration that runs `CREATE OR REPLACE FUNCTION` with the old bodies and
  `COMMENT ON FUNCTION` with the old comments. They are in the files that last wrote them, and `md5(prosrc)` of each must equal the
  "Before" column: `delivery_opt_outs` in 20261013100000; `push_due_receipts`, `push_receipts_settled`, `push_settle`, `push_targets` in
  20261013110000; `ss12000_due_sources`, `ss12000_housekeeping` in 20261014110000; `job_claim_finished`, `job_claim_nightly`,
  `job_run_settled`, `job_runs_latest` in 20261021090000; `gallring_begin`, `gallring_departed_due`, `gallring_finish`,
  `gallring_schools` in 20261021110000; `schedule_candidates_sweep` in 20261125090000; `gallring_claim_person`,
  `login_is_held_elsewhere` in 20261212090000; `absence_watch_digest`, `_digest_due`, `_evaluate`, `_schools` in 20261231090100;
  `reporting_compute`, `_digest`, `_digest_due`, `_remind`, `_schools` in 20270112090100; `school_export_*` in 20270114090000;
  `absence_stats_month`, `_plan`, `_trim` in 20270121090000; `gallring_purge` in 20270204091000; `gallring_pseudonymise` in
  20270206091000. The whole file is `scripts/prod-checks/jobbdorrar-aterstallning.sql`, built from those bodies and proved to restore bodies,
  attributes and comments (`md5(prosrc)` of each of the 38 equals the "Before" column after it has run). Copy the whole statement, language and settings included, because `CREATE OR REPLACE` resets whatever it does not repeat.
  Do not edit the migration after it has run: its checksum is in production's `_prisma_migrations`.

### 29.3 What is not done here

- **The service principals.** The guard asks for a login and not for no principal (section 26.3, the same boundary).
- **`app.optimization_jobs_sweep()` is not in this migration.** Section 27 (#352) made it with the same guard (`GQ403`, as its first
  statement) in its own migration, so it is not one of the 38. Sections 520 and 521 hold its guard's text and its answer under every
  setting beside the other 28 `plpgsql` doors, so that one test file names every job door.
- **The 24 other doors without a guard of their own** are not for a job: 16 are guarded by a helper (`huvudman_*`, the `ss12000_*`
  secret doors and notification doors, the room loans), 7 answer by a secret in their argument (`calendar_feed`, `public_timetable`,
  `public_timetable_embed`, `sign_in_provider_for_domain`) or are policy helpers that `anon` may run because the policies call them
  (`school_grundschema_is_live`, `school_publish_mode`, `checklist_visible_ids`), and `schedule_candidate_runs_active` is a
  person's. Run through the same form matrix, each refuses what it should.
- **`login_is_held_elsewhere` changes for a session with no login**: `NULL` and not yes or no. Section 242b asked for the old answer
  ("with nobody signed in, the shared login was nobody's"); it now asks for `NULL` there, and for the answer past row security from a
  login that sees none of the rows.

### 29.4 Operations

- RLS sections 520 to 523 (and 520o, 521o in `rls-owner-checks.sql`) hold it: the guard's text in every door (and in the Generera sweep), the rights unchanged, what each
  `plpgsql` door answers under every setting a session can carry and beside each principal, the school lists and the login door, and, with
  rows planted as the owner, that the job's door answers a push token, an opt-out, a watch, a reporting week, a job run and a claim, and
  the gallring school's people due, while no login does. The history's guard (`TL403`) behind the gallring door is held in 521o.
- The suite runs the doors as the job does through `pg_temp.u12_<door>`, which the two suite files create from the catalogue: the same
  arguments and answer, claims set aside while the door runs and put back after (a function-level `SET` would be simpler, but the API's
  role may not create one that sets a custom parameter).
- Sections 464 (the md5 of `gallring_pseudonymise`), 83, 242b and 268h changed with it; the others only call the doors through the helper.

## 30. A subject takes its behörighet from another ("Behörighet som i ett annat ämne", omgång 12)

A school that makes its own subject for a work session in SO ("SO WS") found every SO teacher unqualified there: a behörighet
belongs to the subject row it was recorded on. Migration `20270225090000_ett_amne_har_behorighet_som_i_ett_annat` adds
`Subjects."qualificationSubjectId"`, the subject whose teachers' behörigheter this one uses, and the gateway counts a teacher
who holds SO as qualified for SO WS with the SO row's grades, kind and validity, wherever behörighet is counted. Nothing is
stored twice: the gateway derives the rows from the one pointer (`src/staffing/qualification-inheritance.ts`).

- **What changes in the database.** One nullable column (NULL for every subject that exists), a CHECK (a subject is not its
  own source), a composite key `("qualificationSubjectId", "schoolId")` to `Subjects("id", "schoolId")` with
  `ON DELETE SET NULL ("qualificationSubjectId")` (the column list is what lets a source be deleted: a plain SET NULL would
  null `schoolId` too, which is NOT NULL) and `ON UPDATE NO ACTION`, an index over the key, and a BEFORE trigger on a write
  that sets a link (`app.subjects_qualification_is_one_level()`, SQLSTATE `QS409`). No arm changes and no grant changes.
- **One level.** A subject others use inherits from nobody, and none points at itself. The gateway's service asks first and
  answers 409 with a code and the subjects named (`SUBJECT_QUALIFICATION_SOURCE_INHERITS`, `SUBJECT_QUALIFICATION_IS_INHERITED`,
  `SUBJECT_QUALIFICATION_IS_ITSELF`, and 400 `SUBJECT_QUALIFICATION_SOURCE_NOT_FOUND`); the trigger is what holds for a writer
  that did not ask, and for two that ask at once (it takes one advisory lock per school, so the second sees the first's
  commit). A deadlock with a key change on the same row (`UPDATE ... SET "code"` on a subject at the very moment another
  transaction points at it) is possible in principle and answers 409 `WRITE_CONFLICT`, nothing written.
- **Who reads the derived rows.** Every reader that asks who is qualified goes through one function,
  `readHeldQualifications`: the staffing report and its checks, the picker's ranking, the staffing proposal (the engine's
  contract is unchanged: it is sent the same eligibility sets, now including the derived holders), the hand-edit warning, the
  cover board's ranking, the lesson's substitute picker and the rollover. The readers that list the table (the school
  export, the register extract, the person's own form, the CSV) print the stored rows only. `GET /api/v1/teacher-qualifications`
  answers the stored rows, and with `?inherited=true` also the derived ones, each marked `viaSubjectId`, for the web screens
  that judge.

### 30.1 Deploy order

1. Run the migration before the merge (the gateway deploys on every merge, and the gateway after this reads the column). In
   production, as the owner, from a tree that has every applied migration: the release's `prod-fore.sql`, `migrate deploy`,
   the release's `prod-efter.sql` (read-only SQL kept with the release's notes, not in this repository). The migration takes
   `ACCESS EXCLUSIVE` on `Subjects` once, `NOWAIT` in a retry loop (every 50 ms, giving up after 30 s with nothing changed:
   `prisma migrate resolve --rolled-back …`, then deploy again). A gateway from before it names the columns of its own schema
   and writes none of these, so it is unaffected between the migration and the merge.
2. Merge. The gateway reads and writes the column; the web reads it through PostgREST's column list, so it needs the migration
   first (a `select` naming a column the table lacks fails).

### 30.2 Rolling back

- The column is additive: a gateway that never writes it is unchanged. To remove the feature, `DROP TRIGGER
  "Subjects_qualification_is_one_level" ON "Subjects"`, `DROP FUNCTION app.subjects_qualification_is_one_level()` and
  `ALTER TABLE "Subjects" DROP COLUMN "qualificationSubjectId"` (the CHECK, the key and the index go with the column); every
  subject then reads its own behörigheter, as before. Do not edit the migration after it has run.

### 30.3 Operations

- RLS sections 540 to 544 and 544o hold it, on PG 17 and PG 16: the catalogue (the column, the CHECK, the key with its column-list
  SET NULL, the index, the trigger and its function, the six arms of `Subjects` as they were and none that names the column, the
  API role's privileges on the column, nobody's MAINTAIN), who reads and who writes, the school (a pointer to another school's
  subject is refused by the key even for the owner), one level, and the lock. The adapter probe's `bi1` to `bi5` run the service,
  the trigger's refusal through the adapter, two writers at once (ten rounds, both orders), the readers and the load report on
  real rows.
- What `prod-efter.sql` asks of production, read-only and as the owner: the migration applied once with the checksum of the
  file, the column, the CHECK validated, the key validated with `SET NULL ("qualificationSubjectId")` and NO ACTION on update,
  the index valid and ready over the key's columns, the trigger enabled as BEFORE ... WHEN, the function a definer with a
  pinned search path that takes the school's lock and that no role may execute, the API role reading and writing the column
  and `anon` holding nothing on it, nobody holding MAINTAIN on `Subjects`, and no subject pointing at itself, at another school's
  subject or in a chain; arms, grants, the other columns, constraints, indexes and triggers of the table, and every other
  function are read as `record` rows and compared with `prod-fore.sql`'s.

## 31. A school releases a post for the engine ("Släppt för motorn", lärarval B1)

Föreslå bemanning never moves a teacher the school chose. A post that is staffed is fixed, as a pinned one is, unless the school has
**released** it; only then may a proposal give it to another qualified teacher. The release is one row per post in the new table
`TeachingRequirementReleases` (migration `20270226090000_en_skola_slapper_en_post_for_motorn`): the post, its school, who released it
(`releasedById`, null when the person has been removed) and when. Nothing is written without the school's approval, and the engine's
contract is unchanged: a staffed post that is not released goes to the engine as a fixed one, exactly as a pinned post always did.

A table of its own and not a column on `TeachingRequirements`, for three reasons that matter to an operator:

1. **Who may read it.** The school's teachers read `TeachingRequirements`; "this post may be moved" is the administration's to know. The
   table has no arm for a teacher, a pupil or a guardian, and none for a PostgREST role: `app_authenticated` holds `SELECT`, `INSERT`
   and `DELETE` (no `UPDATE`), the school's `SCHOOL_ADMIN` reads, and an administrator who writes `PLANERING` writes. `service_role` keeps
   `SELECT` as on the shares and the placements (it bypasses row security).
2. **The lock.** `ADD COLUMN` would take `ACCESS EXCLUSIVE` on the table every timplan read goes through. The new table's keys take
   `Schools`, `TeachingRequirements` and `Users` in `SHARE ROW EXCLUSIVE` (writes wait, reads do not), `NOWAIT` and all at once in a retry
   loop (as the förlagda poster's migration, 20270207090000): a refusal rolls the subtransaction back and tries again 50 ms later, and after 30 s the migration stops with
   nothing changed.
3. **The year.** A rollover makes new posts with new ids, so no release is carried (`TeachingRequirementRelease` is `SKIPPED` in the
   rollover registry); the school decides again each year what the engine may touch.

The primary key is `("requirementId", "schoolId")`, not the post alone: with the post alone `INSERT … ON CONFLICT DO NOTHING` skips the
key check when the row conflicts, and an administrator of another school who knew a post id could tell whether it was released. RLS
section 546 holds that.

A second confirmation, in the same change: an apply that gives a teacher a subject or a årskurs they do not teach today (a post they
lead, co-lead or take lessons of) is refused `409 STAFF_NEW_TEACHING_UNCONFIRMED` (flat `params`) unless the request lists that very
change in `confirmedNewTeaching`. The dialog lists those changes apart and asks twice. An undo asks for nothing, but only an undo that reverses the latest apply the log holds: a request that says
`undo: true` and reverses none is judged as any apply, by the release rule (`STAFF_ROW_NOT_RELEASED`) and by this confirmation, as the policy already judges it.

### 31.1 Deploy order

**The migration first, then the merge**, from a tree that has every applied migration and this one. The new API reads the table on every
proposal and apply; against a database without it they fail. An API released before this one runs against the new database as it did:
it never names the table.

1. The read-only checks before (`prod-fore.sql`, kept with the migration's files): the table, its keys, indexes and arms are not there, the
   latest applied migration has a lower stamp, the keys' targets exist, the server is Postgres 17 — every `ok` row must be `true`.
2. `prisma migrate deploy` (the file waits for no lock: see above). Then `prod-efter.sql`, and the `record` rows compared before to after.
3. Merge. Railway deploys the gateway within about two minutes. **The engine is not deployed with this change**; nothing in `/staff` moved.

### 31.2 Rolling back

- The table is new and nothing points at it: `DROP TABLE "TeachingRequirementReleases"` (its policies, keys and indexes go with it), and
  `DELETE FROM "_prisma_migrations" WHERE migration_name = '20270226090000_en_skola_slapper_en_post_for_motorn'` if the file is to run again.
  Revert the API first: after the drop the new API's proposal and apply fail on the missing table.
- The releases are the school's own decisions and are lost with the table; the posts and their teachers are untouched.

### 31.3 What is not done here

- **The shortcut "the whole subject in an årskurs" is not stored.** The page expands it to the posts' ids and writes them one by one; a
  post made afterwards is not released. One write path, one truth.
- **An apply does not take a release back.** The teacher an applied proposal gives is the engine's answer approved by the school, and the
  post stays released until the school withdraws it, whoever has the post after an apply.
- **A teacher chosen by hand takes the release back.** A PATCH of the post that leaves another lead (the post's dialog, the teacher's card,
  the unstaffed panel, the suggestions) and a requirements import that gives a post another lead delete the post's release in the same
  transaction and write one `ScheduleChangeLogs` row (`ENGINE_RELEASE`, `released: false`, `because: TEACHER_CHANGED_BY_HAND`), through
  `takeBackReleasesAfterHandChange` (`src/staffing/engine-release-handover.ts`). The school has then chosen, and the next proposal must not
  move that teacher. A save that sends the lead the post already has, and a file that names it, leave the release. No migration: it is the
  gateway's. `src/staffing/engine-release-writers.inventory.spec.ts` lists every file that updates `TeachingRequirements` and what each does
  to a release, so a new writer of the lead has to say. A term split makes new posts (no release) and a rollover carries none.
  **The take-back is the gateway's, and only the gateway's.** The spec reads the TypeScript in `src/`. A write of `"teacherId"` that does not
  go through it skips the take-back: PostgREST's `authenticated` role holds UPDATE on `TeachingRequirements` and the administrators' policy
  admits it, so an administrator who calls PostgREST by hand with her own token leaves a release on the post she picked (no client of ours
  does, and the staffing policy's checks are skipped the same way), and a SQL function in a migration that updated the table
  would not be found by the spec. Neither exists today.
- **"Bara obemannade" off changed meaning.** It used to let every unpinned post change hands; now it means unstaffed posts plus released
  ones, and a staffed post that is not released is never moved. A school that releases nothing sees exactly what "bara obemannade" always
  gave it, for either setting.
- **Candidates are chosen as before** (`qualificationCovers` over the recorded behörigheter). #361 (`Subjects.qualificationSubjectId`) has
  merged and is in this tree: the reader it changes (`readHeldQualifications`, through `readLoadInput`) is the one the proposal reads, so a
  subject that uses another's behörighet is offered to its holders without anything here knowing of it. "New subject" in the second
  confirmation is the post's own subject, though: a teacher who leads SO is given a new subject by an SO WS post.

### 31.4 Operations

- RLS sections 545 to 549 hold it: the catalogue (columns, keys and their actions, indexes, no CHECK, no trigger, the three arms, the
  privileges per role, the arms of `TeachingRequirements` unchanged by md5), every principal of the matrix school and two schools' isolation,
  the statements the gateway writes (`ON CONFLICT DO NOTHING` keeps the first person and time; no `UPDATE`), the person and the post removed,
  and, as the owner, every role by name, the school removed and every row. The fixtures plant one release in the matrix school so that the
  role matrix (section 116) has a row to probe, and the generated area matrix lists the table (`INSERT` and `DELETE` are `PLANERING`'s).
- The adapter probe's checks `sm1`–`sm7` (`scripts/test/probe-slappt-for-motorn.ts`) run the services through the real adapter: a release
  twice and at once, the arms, another school's 404 and 400, the proposal's reads, the second confirmation, a person, a post and a school
  removed, and a teacher chosen by hand (the post's PATCH and a file) taking the release back with its log row.

## 32. A search for the choice of teachers that eases the week ("Sök lärarval", lärarval F3)

Föreslå bemanning can ask the engine for the change of teachers, among the posts the school has **released** (§31), that makes the week
easier. It is a **background job**: it takes minutes, runs in the API process that took the request, keeps its state in a row, and hands the
school an ordinary proposal at the end, to be applied by Föreslå bemannings own apply (its policy, its second confirmation of new teaching,
its basis). Nothing is written to the school's tjänstefördelning by a search.

**Why a route of the engine's own.** `/check-week` cannot rank two weeks that are both over the supply: it counts the periods one after
the other and stops at the first it refuses, so an over figure is "the first refused period's" (relieving the autumn makes the answer *rise*
from 107 % to 144 %), and its week load has four seconds and one second of pricing. The engine now has
`POST /api/v1/week-bounds` (`optimization-engine/app/api/v1/week_bounds.py`): the payload Generera sends, plus `years`, `cutoffs` and
`seconds`, answered with each year's **exact** least week, week by week (`rows`), where every figure says whether it is exact
(`converged`) and whether it was stopped at its cutoff (`cutoff`). A pricing step CP-SAT did not finish proving makes a figure not exact
(the old count would have called it done: measured under load, 2 365 minutes for a graph whose bound is 2 730). The route never solves
and never refuses a week for being over the supply; a week one of the quick arithmetic counts refuses has `refusal` and no figures.

**The gateway drives the search**, one candidate per call: it counts each year a released post spans on its own (the baseline), judges the
tightest four, and tries every single re-lead and, where room is all that stops a move, a swap with the receiver's post nearest in charge (one partner for each such move, so a local optimum is the optimum of these moves and not of every swap), keeping a candidate only if every
figure of every year it touches was counted to the end, no year's tightest week is worse than when the search began, and the weeks as
a whole are lower, tightest first (`src/optimization/staffing-search.ts`). The rules for who may take a post (behörighet, tjänstgrad,
the post's co-teacher, shares, pinned and unreleased posts) are the plan's, the one Föreslå bemanning is judged by; the result is judged by
them again when it is read (`leadRefusal`, `growthRefusal`).

### 32.1 The queue entry

`StaffingSearchRuns` (migration `20270227090000_en_sokning_efter_lararval_ar_ett_jobb_med_lease`) has what a Generera run's row has (§27):
`claimedBy`, `heartbeatAt`, `leaseUntil` (the task renews it every five seconds, which is also when it sees a cancellation), one active run
per year (a partial unique index, `409 STAFFING_SEARCH_ALREADY_RUNNING`), and `app.staffing_search_sweep()`: a job door that takes no login
(`VO403`) and fails a run whose lease has run out (`SEARCH_ABANDONED`) or that began more than an hour ago, and deletes finished runs after
24 hours. It runs every five minutes (`staffing-search-sweep`, switched with `CANDIDATES_BACKGROUND`), and every start sweeps first.

**A run ends by the clock after 55 minutes** (`SEARCH_WALL_CLOCK_MAX_MS`), whatever `STAFFING_SEARCH_BUDGET_SECONDS` (up to 3600) and its waits (not counted in the budget) say:
it stops as `BUDGET` with the best it has, before the sweep's own hour calls a run that is still working lost.

**A run is not resumed.** A restart fails the runs of the instance at once (`SEARCH_INTERRUPTED`) and the sweep takes one that is lost: another
process has not got the administrator's login, which every read of the school needs. The run keeps its **checkpoint**, the moves accepted so far
(written after each), and every state the search accepts is a proven improvement on the one before, so what a lost run has is a proposal that can
still be shown. The table keeps ids and numbers only; the school's one finished run is replaced by the next start.

**The proposal's basis** (`basisSha256`) is the tjänstefördelning's with its releases, and the week's, together (`withWeekBasis`), as they were when
the search read them. The dialog applies it with `coversWeek: true`, and the week route (`POST …/staffing/proposal/week`) takes the same flag: a
change of the staffing, a release or the week between the search and the apply is `409 STAFF_PROPOSAL_STALE`.

### 32.2 Deploy order

**The migration first, then the merge**, from a tree that has every applied migration and this one. **The engine deploys with the API on every merge**,
and the contract change is additive (a new route, new classes named `WeekBounds*`, no other path or schema changed: the OpenAPI test compares every
other key against an engine without the route). In the minutes when the API is the newer of the two the route is a 404, which the search reads as
`SEARCH_ENGINE_OLDER` and says ("Schemamotorn är äldre än API:t…"); an engine that is the newer meets an API that never asks. The route is not one of
the four the engine times on `GET /api/v1/timing`: its wait is its own (the engine's 25 s plus the transfer, 40 s), and `AI_ENGINE_TIMEOUT_MS` does not touch it.

1. Read-only checks before: the table, its type, keys, indexes, arms and the function are not there, the latest applied migration has a lower stamp, the
   server is Postgres 17. 2. `prisma migrate deploy` (it waits for no lock: `Schools` and `AcademicYears` `NOWAIT`, together, 30 s). 3. Merge.

### 32.3 Rolling back

`DROP TABLE "StaffingSearchRuns"`, `DROP TYPE "StaffingSearchRunStatus"`, `DROP FUNCTION app.staffing_search_sweep()`, and
`DELETE FROM "_prisma_migrations" WHERE migration_name = '20270227090000_en_sokning_efter_lararval_ar_ett_jobb_med_lease'` if the file is to run again. Revert the
API first: after the drop its start and its sweep fail on the missing table. The runs are findings, not decisions: nothing of the school's is lost.

### 32.4 What the search cannot say, and what is not done here

- **It proves a lower bound, not a timetable.** The figure is the engine's own bound for each year and real week (`week_load`), the same relaxation
  `/check-week` uses. Lowering it does not promise a schedule (the study's 91.7 % still gave a `TIMEOUT` on a whole solve).
- **A teacher's lessons in other years are not in a year's graph.** A teacher who receives a post is charged for their whole tjänst (the plan counts every
  year) and their lesson hours across years are checked by the engine's own count (`_teacher_hours_verdict` is among the quick counts a candidate is
  refused by), but a clash with lessons in another year is not seen: the bound is optimistic there, as it always was.
- **Posts nobody leads are not searched.** Staffing them is Föreslå bemannings own question (and makes the week tighter by construction); a school applies a
  search's result and then runs Föreslå bemanning for the rest.
- **At most four years are judged** (the tightest of those a released post spans), and **a year is only judged when its figure as it stands is exact** (every week
  counted, every pricing step proved; the figure is never a lower bound, nor a first refused period's, since the route counts every week to the end), because
  "no tighter than today" cannot be decided against anything else. What is left out is never silent: the run's figures carry `leftOut`, the posts by reason
  (`NOT_FREE`, `UNSTAFFED`, `NO_CHOICE`, `NOT_IN_WEEK`, `YEAR_LIMIT`, `YEAR_NOT_COUNTED`) and the years that were not judged with `YEAR_LIMIT` or `YEAR_NOT_COUNTED`; the panel and
  the proposal say it in words.
- **More than 16 real weeks** in a year are counted to 16 and the answer says so; such a figure ranks nothing.
- **Generera and Schemaförslag have priority** over the year: the search waits (up to ten minutes IN ALL, not for each count, and not counted against its budget; after
  that it goes on beside them) while a Generera run or a schemaförslag run of the year is alive (a schemaförslag run as Generera's own start counts it,
  `yearHasActiveCandidateRun`). A Generera start does not look for a search, and another school's Generera run is not seen.
- **The engine is shared by every school, and a search never takes more of it than one count at a time.** The route holds a gate of one (not a setting, whatever
  the deployment says), answers 429 beyond it and never queues, so `/optimize` and `/check-week` are not behind it; a pricing is one CP-SAT worker. The gateway backs
  off from a 429 (2 s growing to 10 s, in one-second slices that a cancel interrupts) and from a 503 (up to eight times in a row for one candidate, then it is
  an engine failure), and **that wait is not counted in the search's time**: a search that was kept waiting has as much to count with as one that was not. A wait
  that has lasted 45 minutes in all ends the search (`SEARCH_ENGINE_BUSY`, stop `ENGINE_BUSY`) with the moves it has accepted, which can still be read as a proposal:
  a job that waits for ever is a job stuck in RUNNING. An older engine (404 or 405) ends it at once with `SEARCH_ENGINE_OLDER`, also in the middle of a search.
  The cost in time: a count of the study's åk 9 (89 posts) takes about 2.6 s with one count at a time (median at a load of 3–15; 3–4.6 s at 15–30), so the study's
  twelve-move search (450 counts) takes about 20 minutes of its own time (19.6 measured), a little over the default budget of 15 minutes: its tightest figure (91.7 %) is reached
  at about nine minutes (move 8) and the last moves and the exhaustive round that proves a local optimum come after; `STAFFING_SEARCH_BUDGET_SECONDS=1800` gives it the whole round.
  A search that runs out of budget keeps the best state it reached (every accepted move is a proven improvement).

### 32.5 Operations

- RLS sections 550 to 554 hold it: the catalogue (columns, keys and their actions, every constraint by name, indexes, the four arms, the privileges per role, the sweep's
  grants and guard), who reads and writes with every principal of the matrix school and two schools' isolation, every constraint, the sweep's behaviour, and, as the owner,
  every role by name and the cascades.
- Logs: `Staffing search started`, `Staffing search finished [stop, rounds, evaluations, moves, ms]`, and on the engine `week_bounds_*` with the elapsed milliseconds of each count.
  A search that ends `BUDGET` with moves was cut off while it still found improvements; raising `STAFFING_SEARCH_BUDGET_SECONDS` lets it go on.

## 33. Changes that would let a refused week be laid ("Åtgärdsförslag vid vägran", omgång 13, G6, part 1 of 3: the engine)

A school whose Generera was refused, or ran out of time, is told today what did not fit and not what to change. Bästa möjliga schema already lets five of the school's own rules
give way (Bästa möjliga schema, G2, `optimization-engine/app/solver/relaxation.py`) and says how far each did and what it would have needed. This part reads that answer as a list of changes and asks the one question the
answer cannot ask itself: **does the strict model, with exactly those changes made, accept the timetable the search found?**

### 33.1 The route

`POST /api/v1/suggest-changes` (`optimization-engine/app/api/v1/suggest_changes.py`, `app/solver/suggestions.py`, `app/schemas/suggestions.py`). The request is Generera's own
(`OptimizeScheduleRequest`), so the gateway builds one payload and asks any route with it; `search.maxSeconds` is the search's budget (60 s when absent, never more than
`SOLVER_MAX_TIME_SECONDS`), `search.workers` (four when the request names none, never every core of a shared engine) and `search.seed` pass through, `relaxation` is ignored and `probes` is always off. The answer is `verdict`, `changes` (the cheapest first),
`verified`, the seconds the search and the check were given, and, for a refusal by a hard rule, the strict explanation. **It places nothing and stores nothing.**

| `verdict` | Means |
|---|---|
| `CHANGES` | The search laid the week by letting the rules of `changes` give way |
| `SOLVABLE_AS_IS` | The search laid it, nothing gave way, **and the strict model accepted the timetable** (`verified` is always true here): the week has a timetable, whatever its own run said |
| `NOT_FOUND` | No timetable in the search's time, even with the five rules free, or one on which nothing gave way that the strict check was not shown to accept (no time for it): **not** a proof that none exists |
| `HARD_REFUSAL` | A rule that never gives way refuses the week; `conflicts` is the strict explanation; no change of the five can help |

A change names one of `SUBJECT_DAYS_APART`, `SUBJECT_PER_DAY`, `ROOM_LOCK`, `TEACHER_DAILY_CAP`, `TEACHER_WORK_DAYS` (the engine's own list, mildest first), the value the rule has
(`current`) and the value this very timetable needs (`needed`), the weekdays where the engine can say them (a post's extra day, only for a school with one week), and the
anonymous ids the request carried (`requirementIds`, `roomIds`, `resourceIds`: the work rule of a cap, the post of its days, the room rules of a lock). No name is in it. Its
`cost` is the engine's own price (the weight of a unit times the units the change removes), and the list is in that order, ties to the milder rule.

### 33.2 What `proof` says, and what it does not

- `SOLVED`: the engine solved the week with exactly this one change. `SOLVED_TOGETHER`: with exactly the changes of the list, **together**: one of them alone is not shown to
  be enough (the test builds a week where neither alone lays it). `MAY_HELP`: a timetable exists that breaks the rule this much, but the strict model's check of it did not
  finish or was not started.
- The check builds the STRICT model of the changed week (no priced rule), warm-starts it from the search's timetable and stops at its first solution. A hint that holds is
  accepted at once; one that does not holds the solve for what it needs to repair it, and a solution found that way proves the changed week as well.
- **It is a timetable that exists, not one the next Generera finds.** Generera has no hint, and the changed week may still run out of time.
- **It is not the cheapest.** The search's first timetable is not its best one; on the högstadium week the priced search ended at 40 s with five deviations where the strict
  solver lays the week cleanly (`verification-baseline.md`). The list is what the engine found.
- **"Found nothing in N seconds" says the N the search had.** For a `NOT_FOUND`, `searchSeconds` is the budget the search really ran on (the TIMEOUT report's own), not the one it was asked for: a caller that waits less than the engine's budget leaves it less, down to none.

### 33.3 Contract, deploy order, rolling back

- **Additive.** One new path and two new schemas (`SuggestChangesResponse`, `SuggestedChange`); `app.openapi()` was compared with `git archive` of main and nothing else changed
  (the tests keep the same comparison, and `GET /api/v1/timing` is unchanged). An engine older than the route answers 404, and the gateway (part 2) says so: a refusal or a
  TIMEOUT then reads as it does today.
- The engine deploys with the API on every merge (`engine-deploy-drift`): nothing calls the route until part 2, so the order does not matter. Rolling back is reverting the PR.

### 33.4 Time and the machine

The route is a solve and is held like one: **one at a time in a process**, answered 429 beyond it and never queued (the gateway backs off, as it does for `/week-bounds`).
`/optimize` is not behind the gate; they share the cores, which is why the gateway (part 2) does not start an analysis while the school has a run active and passes `workers` (a request that names none gets four, in the search and in the check).
**An analysis yields to a Generera, whichever school's** (review of #384). The engine is one process (`--workers 1`) shared by every school, and a Generera asks CP-SAT for every core unless its request names `workers`;
an analysis that started beside it would take them. `optimization-engine/app/solve_load.py` counts the solves of the process by kind, from the start of the solve's thread to its end (a 503 ends the wait, not the work), and both entrances to a Generera
(`/api/v1/optimize` and the legacy `/v1/schedule`, through `run_solver`) are counted. `/suggest-changes` answers **429 while a Generera runs** (`A timetable is being generated on this engine. Try again in a moment.`, which the gateway already reads as ENGINE_BUSY),
and the gate above still holds analyses to one. The count never refuses or queues a Generera. A Generera that starts while an analysis is already running shares the cores with it until it ends (four workers, a minute and a half at the default search, up to the ceiling below at the largest `maxSeconds`);
that case is not closed and is **logged** as `generation_beside_analysis` (a warning, with `analyses_running`, the analysis's own `analysis_request_id` and how long it had run, `analysis_seconds`: the overlap is read from those and from the analysis's `suggest_changes_completed`, whose `elapsed_ms` ends it),
and from the analysis's side as `analysis_beside_generation` for an analysis let in a moment before a Generera's thread began; the refusal is logged as `suggest_changes_yields_to_generation`: count those lines before building anything to stop an analysis. An analysis answered 503 has no line for the end of its thread.
The count is per process. At more than one replica each has its own, as the gates do. No contract changes: `app.openapi()` is identical to main's.
Its ceiling is the search plus up to 30 s for the check plus two builds' headroom (`route_limits`), shortened by the caller's `deadlineSeconds`; the check is given what is left
and is not started when that is under five seconds after the build. With the default 60 s search the ceiling is 60 + 30 + 60 = 150 s, well inside the API's 240 s wait for a Generera; a gateway that asks for a longer search (`maxSeconds` up to the engine's own budget) must keep its own wait above this sum.

### 33.5 Tests

`optimization-engine/tests/test_solve_load.py` (the shared count): the count by kind and through a failure, the analysis refused while a Generera runs and never started, a Generera that outlived its 503 still holding it back,
both entrances counted and back at zero, the analysis counted for its thread, and a Generera beside an analysis let through and logged (and silent when alone). Ten hand mutants; none survives.
`optimization-engine/tests/test_suggest_changes.py`: the changes by rule (pure), the changed week, the oracle (the strict solver asked cold lays the changed week for each of the
five rules, and not one step short of `needed`), the proof's shape, the four verdicts, the route (key, validation, the payload's own 400 as `/optimize` gives it, the gate, the
ceiling) and the OpenAPI comparison. Twenty-one hand mutants of `suggestions.py` were run against it; none survives.

## 34. Changes that would let a refused week be laid ("Åtgärdsförslag vid vägran", omgång 13, G6, part 2 of 3: the analysis in the gateway and its column)

Part 1 is the engine's route `POST /api/v1/suggest-changes` (the engine section above this one, if it has merged). This part is what the gateway does with it: an administrator asks for the
analysis of a run that ended without a timetable, the gateway asks the engine, and the answer is kept on the run for the page to read (part 3).

### 34.1 The route and what is kept

- `POST /api/v1/optimization/jobs/:id/suggestions` (`SuggestionsController`, `SuggestionsService`): school administrators with Schemaläggning or Drift, throttled at three a minute. It answers **202 at once**
  with the analysis `RUNNING`, and the page polls the run as it polls a Generera (`GET /api/v1/optimization/jobs/:id`), which now carries `suggestions` (the stored value, read through a whitelist) and
  `suggestionsOffered` (whether the button may be shown).
- **Asked for, never started by itself.** It costs the engine up to a minute and a half of its cores. It may be asked for a run that ended **INFEASIBLE** or **TIMEOUT**, with a 400 named by one of the five rules
  (`TEACHER_LESSON_LONGER_THAN_DAILY_CAP`, `TEACHER_DAILY_CAP_*`, `TEACHER_WORK_DAYS_*`, `SUBJECT_DISTRIBUTION_*`, `DISTRIBUTION_*`, `ROOM_LOCK_*`), or with the engine's own clock run out
  (`ENGINE_TIMED_OUT`, `ENGINE_WAIT_EXPIRED`, `ENGINE_PATH_CLOSED`: the road to the engine closed the call). Not for a run with a timetable, one still going, one the engine never answered (`ENGINE_NOT_REACHED`, `ENGINE_RUN_ABANDONED`) or one a rule that never gives way refused.
  A refused start is **409** with a code the page words: `SUGGESTIONS_NOT_FOR_THIS_RUN`, `SUGGESTIONS_RUN_IS_OLD` (the year has a newer run: a Generera that is going is the year's newest, so it is this one that a press meets), `SUGGESTIONS_YEAR_BUSY` (a schemaförslag run of the year is alive, or a Generera was started in the moment between the press reading its run as the newest and taking the year's start lock; the engine's cores are shared).
- **One solve stream per year, in both directions (D2).** The analysis claim takes the year's solve-start lock (`lockYearForSolveStart`, the one Generera's start and a schemaförslag run's start take) before it counts the year's runs, and Generera's start and a schemaförslag run's start are refused
  **409 `SUGGESTIONS_RUNNING`** while an analysis of the year is `RUNNING` and began less than 240 s ago (`suggestions-running.ts`: it waits for the engine 200 s at most; an analysis whose process went away holds nobody off for longer than that, where a read gives it up only after six minutes).
- **A second request to the engine, with its own budget**, not a step inside the run that ended: the week is fetched as a Generera fetches it (`prepareSchedule`, now, with the school's saved rules), and the engine is sent
  `search {maxSeconds: 60, workers: 4}` and `deadlineSeconds: 195`, and waited for 200 s. A week the school has changed since the run is analysed as it stands.
- It writes **only** `OptimizationJobs."suggestions"`: no timetable, no setting, no other row.

### 34.2 The column and the migration (`20270305090000`)

`OptimizationJobs."suggestions"` (jsonb, nullable, no default) with `OptimizationJobs_suggestions_is_a_small_object` (a JSON object, at most 8 KiB as text), under the table's own four administrator arms (RLS section 565).
- **Deploy order:** the migration is run **before** the merge (§2). The API before this part names its columns and reads no `suggestions`, so it is unaffected; the column is NULL for every run before it.
- **Rolling back:** revert the PR. The column can stay (nothing else reads it); dropping it is `ALTER TABLE "OptimizationJobs" DROP COLUMN "suggestions"` after the revert has deployed, with the lock the migration itself takes (NOWAIT in a loop).
- What the value holds (`suggestions.ts`): `state` (`RUNNING`, `DONE`, `FAILED`), the verdict and `verified` of the engine, `total` (how many changes the list had), at most six changes each of at most three named posts and rooms (names cut to 80 characters),
  and for a failure its code (`ENGINE_LACKS_SUGGESTIONS`, `ENGINE_BUSY`, `ENGINE_FAILED`, `NOTHING_TO_PLACE`, `ABANDONED`). The value is rebuilt through a whitelist on the way in and again on the way out; one that is not wholly well formed shows nothing.
- **No person's name and no figure of a post.** A cap's teacher rides as the teacher's Users id, which no view carries on; the page reads the name as it does for a free-day note. A change to a part-timer's days is stored in its **hidden form for every reader**
  (the rule, the price and the proof, and no post, no teacher, no number, no weekday; several are one): nothing HR is kept, and the post stays the one place the figure lives (`work-days.ts`).

### 34.3 What can go wrong, and what the page then says

- **`RUNNING` for ever.** A process that goes away mid-analysis (a deploy of the API happens at every merge) leaves `RUNNING`. A read treats a `RUNNING` older than six minutes as `FAILED`/`ABANDONED`, and a new press takes it over (the claim is one conditional `UPDATE`, as is the final write, which only
  overwrites the analysis the call itself started). Nothing sweeps it.
- **An engine older than the route** answers 404: `ENGINE_LACKS_SUGGESTIONS`, said as "not just now"; the run reads as it did. **429** from the engine (one analysis at a time in its process): `ENGINE_BUSY`. A **400** is the engine's hard rules refusing the week: not a failure but the answer
  (`HARD_REFUSAL`, no change of the five can help). Every other error is `ENGINE_FAILED`, with nothing of its text kept.
- **A change that was never checked** (`verified` false) is never above `MAY_HELP`, whatever the engine's changes say; the gateway lowers it. `SOLVABLE_AS_IS` is only to be said with `verified`.

### 34.4 Operations

- Logs: `Suggestions ended without a list [job, failure]` (a warning, with the error as text), `Suggestions answered by the gateway's pre-flight`, and on the engine `suggest_changes_requested` / `_completed` (verdict, number of changes, `verified`, elapsed ms) and `_busy` / `_timed_out`.
- Which runs have an analysis: `SELECT id, "suggestions"->>'state', "suggestions"->>'verdict', "suggestions"->>'startedAt' FROM "OptimizationJobs" WHERE "suggestions" IS NOT NULL ORDER BY "createdAt" DESC` (as the owner; the API role reads it under RLS).
- RLS section 565 holds it: the column and its check from the catalogue, the check's edges (an array, a number, a text, a JSON null, 8 192 characters and 8 192 **bytes**), the claim and the write as the service makes them, the four arms unchanged and not naming the column, and that a teacher and PostgREST's role read and write nothing.

### 34.5 Tests

`src/optimization/suggestions.spec.ts` (the stored value, the whitelist, the ranking, the bounds, abandonment), `suggestions.service.spec.ts` (what a start is refused for, a second press, the request, every way out writing the column), `suggestions.controller.spec.ts`,
`suggestions-contract.spec.ts` (the engine's names, by hand, mirrored by `tests/test_suggest_changes.py`), `suggestions-running.spec.ts` (the analysis as a solve stream of the year) and `optimization-jobs.suggestions.spec.ts` (the run as a reader sees it); the adapter probe's `ag-f` is the one-stream rule against a real database. Twenty-three hand mutants of `suggestions.ts` and `suggestions.service.ts` were run against them; none survives (one, a comment removed, is equivalent).

## 35. The solver corpus: weeks shaped like real schools as a measuring stick ("Riktiga veckor som mätstock", omgång 13, M5)

Every bench school the engine had before this (`solve_2000_students.py`, `validate_schedule.py`, `hogstadium.py`, `staff_60x400.py`) gives each class lessons of its own; what they share is
a block or a specialist room. A school with every year filled in is shaped otherwise. It is described here by its form and by no count, date or run that would point to a school (the repository is
public): in its upper years nearly every subject but Teknik is taught in groups that cut across the classes, a pupil sits in about a dozen groups, many teachers stand on parallel groups that take pupils
from the same class, its level groups (Matematik, Engelska, Svenska) draw from nearly every class of a year while the others draw from about half of them, and about a quarter of its weekly minutes run one
term only. That is the kind of week that has made Generera answer TIMEOUT, and no bench had it; a school of that form is within a few classes of the engine's limit of 5,000 group pairs in a request.
This section is the measuring stick that tells a school, and the nightly gate, where the line between a week the engine can lay and one it cannot runs.

### 35.1 What exists

| File | What it is |
|---|---|
| `optimization-engine/benchmarks/school_corpus.py` | The corpus: a deterministic generator `SchoolShape` → `OptimizeScheduleRequest` (fixed ids, a seeded generator, byte-identical on every machine and pinned by `test_school_corpus_pins.py`). Axes: **N** classes, **G** subjects taught in groups across the classes (0–10), **M** shared teachers (the engine's own reading, `week_load._shared_teachers`) and how many parallel groups each stands on, how far a group's pupils are mixed across the classes, språkval (teachers shared across the years, with or without a block), subjects that run one term only (`periods`, with two or six periods), blocks, a post count per teacher like production's, and grades of their own. `sweep_shapes()` moves one axis at a time from the base; `GATE_WEEKS` names the nightly's 13. A shape the engine would refuse (over 5,000 group pairs, over 2,000 requirements, a group no room holds, a week its own count proves impossible) is refused or left out, because a corpus week the engine refused would measure the refusal. |
| `optimization-engine/benchmarks/corpus_measure.py` | The measurer: seconds from `solve()`'s entry to the first timetable (prechecks, builds and phase 1a, or 1b where 1a gives up: what a school waits for, with phase 2 left out because it only spends the rest of the budget improving a timetable that exists), the outcome (`FIRST_SCHEDULE`, `TIMEOUT`, `INFEASIBLE`, `REFUSED`, or `ERROR` for a tree that cannot be handed the week), and the steps (`PRECHECKS`, `BUILD`, `SEARCH_CLEAN`, `SEARCH_CLONE`) from the engine's own `StageClock`. It changes nothing in the engine: a subclass of `SchedulerSolver` replaces `_generation_solver` and hands every generation search a recording `CpSolver`, which stops the solve at the first timetable. `tests/test_corpus_measure.py` keeps the hook: an engine that no longer calls it (`HOOK_NOT_CALLED`), one that swallows the stop, and a TIMEOUT that the wall clock and not the budget decided (`WALL_LIMIT_BEFORE_BUDGET`) are each an `ERROR` and a test failure, never a silent number. |
| `optimization-engine/benchmarks/corpus_report.py` | The tables below, from the measurements. |
| `scripts/bench/solve-corpus-gate.mjs` | The nightly gate's verdict, pure Node. |
| `.github/workflows/quality-gates.yml`, job `solver-corpus` | The nightly job. |

Two modes. **`clock`** is how production runs: every core, wall-clock seconds, comparable only on one machine at one load (every result carries the load average). **`count`** is one worker and a
fixed seed, so CP-SAT repeats the same search exactly, with the budget in CP-SAT's *deterministic* time (operations counted, not seconds: the same on every machine) and a wall-clock limit a thousand times
the budget as a safety that never binds: a search that ends before 95 % of its deterministic budget is an `ERROR` (`WALL_LIMIT_BEFORE_BUDGET`), never a TIMEOUT, because a verdict the host's load decided is not
count mode's (the first sweep's 40-times limit decided 13 of its 33 TIMEOUTs at load 55–119; they were measured again, and all 13 are real).

### 35.2 What the first measurement says: where the corpus's weeks stop being laid (read the correction under the first paragraph)

Measured 2026-11-22 (the record, tables and conditions are in docs/solve-corpus-measurement.md, the data in docs/solve-corpus-measurement.json and docs/solve-corpus-measurement-clock.json): the `sweep` profile, 77 of its
82 weeks, in count mode with a budget of 4 deterministic seconds a search, and a clock-mode check with all eight cores of this Mac. **The table is one core's, and its seconds are estimates** ("within" is the slowest
week of the row that got a timetable): the work times 18 s per deterministic second, which is what one worker took on this Mac when it was quiet (11 weeks, 8–25). By that figure the budget is about 72 s a
search and 144 s for a solve's two searches of one core of this Mac. Production gives a run 180 s on every core it has, so the two are not the same measure, and **production's processor is not measured** (§35.5).

**Read this before the table (correction of 2026-11-25, M8).** A "none (timeout)" row says that no timetable was found in 2 × 4 deterministic seconds for a week whose pupils' groups were drawn at random, with the day ending at 16:00. It is **not the limit of what the engine can lay**, and the line the table draws (five or six subjects in groups at nine classes) is not a line of the engine's reach. Seven of the weeks of the table that are TIMEOUT at 16:00 were measured and are on a cliff (the rows of more subjects in groups at 9 and 12 classes; the chain, term and production rows were not measured that way, §35.7): the same weeks are laid on 0.01 to 4 deterministic seconds of work when the day ends 30 to 120 minutes later (§35.7: `n9-g8` at 16:30, `n9-g10` at 17:00, `n12-g5` at 17:00, `n12-g6` at 18:00), and three of them were laid at 16:00 itself, `n9-g6` and `n12-g5` by laying the years one at a time and `n12-g4` at 15:30 (the engine accepts each result with every lesson pinned, and the 15:30 one on the week that ends at 16:00). A random draw of pupils may have **no timetable in its frame**, and a TIMEOUT there does not separate "hard" from "impossible". What the table measures is where this corpus's weeks stop having a timetable that one search finds in that budget. The school's own form (ten subjects in groups, half groups, terms, teachers on long chains) is **not known**: the weeks of that form that are TIMEOUT here are TIMEOUT at 16:00, and 18:00 gives a timetable for one and not for the others (§35.7); the word "none" in the table is not "cannot".

| A school with … | gets a timetable within | in |
|---|---|---|
| every subject by class (språkval in groups), 6 to 24 classes, 0 to 3 shared teachers (the språkval teachers) | 24 s | 10 of 10 weeks |
| three subjects (SO, NO, Idrott) in groups across the classes, no shared teacher, **6 to 12 classes** | 9 s | 6 of 6 weeks |
| the same at **15 and 18 classes**, which also have **3 shared teachers** (the språkval teachers, each on four parallel groups) | none (timeout) | 0 of 4 weeks |
| 9 classes, **up to 4** subjects in groups | 5 s | 8 of 8 weeks |
| 9 classes, 5 subjects in groups | 9 s | 1 of 2 weeks |
| 9 classes, **6 to 10** subjects in groups | none (timeout) | 0 of 6 weeks |
| 12 classes, **up to 3** subjects in groups | 9 s | 6 of 6 weeks |
| 12 classes, 4 subjects in groups | 16 s | 1 of 2 weeks |
| 12 classes, **5 to 10** subjects in groups | none (timeout) | 0 of 8 weeks |
| 9 or 12 classes, three subjects in groups, **no shared teacher** | 9 s | 4 of 4 weeks |
| the same with **1 shared teacher** (three parallel groups) | 9 s | 4 of 4 weeks |
| the same with **2 shared teachers** (three parallel groups each) | none (timeout) | 0 of 4 weeks |
| the same with **3 to 4 shared teachers** (two parallel groups each; 3 at 9 classes, 4 at 12) | 10 s | 4 of 4 weeks |
| the same with **5 to 8 shared teachers** (two parallel groups each; 5 at 9 classes, 8 at 12) | 9 s | 4 of 4 weeks |
| 12 classes, three subjects in groups, **no term subject** | 9 s | 2 of 2 weeks |
| the same with **3 subjects that run one term only** | 35 s | 1 of 2 weeks |
| the same with **5 term subjects** | none (timeout) | 0 of 2 weeks |
| the production form (ten subjects in groups, half groups, terms), **6 or 9 classes** | none (timeout) | 0 of 4 weeks |
| the same with the year cut into **six periods** instead of two | none (timeout) | 0 of 2 weeks |
| the same at 9 classes with **teachers who have a post count like production's** (the same numbered group in every grade, or two subjects each) | none (timeout) | 0 of 2 weeks |
| **30 classes in grades 4–9**, groups in grades 8 and 9 (ten subjects) and in grade 7 (three) | none (timeout) | 0 of 1 week |

**With all eight cores the lines move up.** Production runs CP-SAT on every core it has, and the portfolio finds what one worker cannot. Every week that one worker solved was solved with eight cores (median 2 s), and
6 of the 14 weeks that one worker gave up on were solved too (one run each; the load of this machine is in the table, 3 to 88, so a time is slower than a quiet machine's and a timeout proves nothing about one):

| Week | One worker (count mode) | All eight cores (clock mode, 180 s) |
|---|---|---|
| 6 classes, three subjects in groups | 0.18 work (≈ 4 s) | timetable in 0.7 s (load 4) |
| 9 classes, three subjects in groups | 0.17 work (≈ 4 s) | timetable in 1.3 s (load 4) |
| 12 classes, three subjects in groups | 0.45 work (≈ 9 s) | timetable in 9.3 s (load 7) |
| 18 classes, every subject by class | 1.32 work (≈ 24 s) | timetable in 8.4 s (load 58) |
| 24 classes, every subject by class | 0.73 work (≈ 14 s) | timetable in 3.1 s (load 53) |
| 15 classes, three subjects in groups (seed 1) | timeout | timetable in 26.2 s (load 14) |
| 15 classes, three subjects in groups (seed 2) | timeout | timetable in 138.5 s (load 60) |
| 18 classes, three subjects in groups (seed 1) | timeout | timeout at 180 s (load 61) |
| 9 classes, five subjects in groups (seed 2) | timeout | timetable in 33.0 s (load 49) |
| 9 classes, six subjects in groups (seed 1) | timeout | timeout at 180 s (load 87) |
| 9 classes, six subjects in groups (seed 2) | timeout | timeout at 180 s (load 52) |
| 12 classes, four subjects in groups (seed 1) | timeout | timetable in 32.0 s (load 82) |
| 12 classes, five subjects in groups (seed 1) | timeout | timetable in 41.0 s (load 50) |
| 12 classes, three subjects in groups, 2 shared teachers with three groups each (seed 1) | timeout | timeout at 180 s (load 76) |
| the same (seed 2) | timeout | timeout at 180 s (load 44) |
| 12 classes, three subjects in groups, three term subjects (seed 1) | 1.94 work (≈ 35 s) | timetable in 153.4 s (load 70) |
| the same (seed 2) | timeout | timetable in 163.9 s (load 40) |
| 9 classes, the production form (ten subjects in groups, half groups, terms) | timeout | timeout at 181 s (load 53) |
| the same with teachers who have several groups each | timeout | timeout at 181 s (load 53) |
| 30 classes in grades 4–9, groups in grades 8 and 9 (ten subjects) and in 7 (three) | timeout | timeout at 184 s (load 63) |

What the numbers say, in order of weight:

1. **The number of classes is not what stops these weeks; the form of the groups is** (and see the correction above: that is where the corpus's weeks stop having a timetable one search finds, not the engine's reach). By class, 24 classes (546 lessons) are a matter of seconds even on one core. With three subjects in groups the line is between
   12 and 15 classes on one core and between 15 and 18 on eight (the 15- and 18-class weeks are also the first with shared teachers, three språkval teachers on four parallel groups each, the chain of point 2: that row is the class count and the chain together). With more subjects in groups it is, on one core, four subjects at nine classes and three at twelve; on eight cores five at nine classes (7 and 33 s) and at least
   five at twelve (41 s), and six at nine classes got no timetable on eight cores either (two of two weeks, 180 s at loads of 87 and 52: a TIMEOUT, which is not a proof that there is none: the years one at a time lay `n9-g6` on 1.04 deterministic seconds, §35.7).
2. **What the engine cannot lay is a long chain of one person's parallel groups, not shared teachers as such.** A teacher on two parallel groups of a subject that take pupils from the same classes is cheap:
   up to eight of them at twelve classes get a timetable in 2 to 10 s on one core. One teacher on three such groups (nine lessons in a row that each of those classes waits out) is also fine; **two of them time out (year 7 at 95 % of the
   frame, `TIGHT_WEEK_LOAD`), on eight cores too, and three already are proved impossible by the engine's own year count** (105 %, `DEMAND_YEAR_WEEK_SHORT`; pinned by `test_school_corpus_manual_claims.py`), which is why the corpus no longer has those weeks (it would measure a refusal). The week's length, and not
   the number of shared teachers, is the wall; it is what the warning "Krock för lärare" and the year count say.
3. **Terms cost a lot** and the cost is not smooth: three term subjects at twelve classes get a timetable on one core in one of two weeks (35 s) and on eight cores in both (153 and 164 s at loads of 70 and 40, near the 180 s budget); five term subjects do not on one core.
4. **The same shape differs by seed, a lot near the edge** (0.26 or 3.5 work; 1.9 work or a timeout). A figure for one week is a lottery ticket; a count of weeks is a result, which is why the table counts.
5. **The production form does not get a timetable here at 16:00** (and whether it has one is not known, §35.7): ten subjects in groups with half groups and terms time out on one core at six and nine classes, with six periods instead of two, with teachers who have several groups each, and
   in a week of a whole school of that form (30 classes in grades 4–9, 868 lessons, 4,154 group pairs). Three of these weeks were also run with all eight cores and timed out at 180 s, at a load of 13 to 63: a timeout
   under that load is no proof, and what production's cores do with them is what §35.5 would say.
6. **The group-pair wall.** The engine takes 5,000 `groupConflicts` in a request, and the gateway refuses at that number with a named answer. The production form reaches it at about fifteen classes
   (12 classes: 3,858 pairs; 15: 5,849); a school of that form is within a few classes of it.

### 35.3 The nightly gate: this tree against a floor, in work and not in seconds

Job `solver-corpus` in `quality-gates.yml`, 30 minutes at most, about **12 to 18 minutes of runner time a night**: each of the two trees measures the gate's 13 weeks at **three seeds** (one seed took 1 to 3 minutes a tree on this Mac at loads of 23 to 57 with four searches
at a time, so three seeds take three times that), plus about 1.5 minutes for the install and the checkouts. The nightly `solver-benchmark` takes 2.4 minutes and the
latency job about 6. A change that makes every week time out at every seed would take the 30-minute ceiling, and the job is red then anyway. The repository is public, so a standard runner is not billed; the figure is
runtime. The job has not run on a runner yet (it cannot before merge): the first night, or a dispatch, shows the minutes.

- **Why not seconds.** ubuntu-latest is a mixed-CPU pool (the same tree's health throughput varied 2.6x between its machines; `scripts/bench/latency-gate.mjs` has the numbers), and a search
  takes as many seconds as the machine it drew. In count mode one worker with a fixed seed makes CP-SAT repeat the same search, so the operations it counts are the same everywhere.
- **The floor** is `main` as it was a week ago (`git rev-list -1 --before='7 days ago' origin/main`), checked out as a second tree in the same job, or the ref a dispatch input `corpus_floor` names.
  Nothing is stored and nothing is moved by hand. The same script and the same 13 weeks (`GATE_WEEKS`) run against both engines through `ENGINE_ROOT`, with one OR-Tools for both.
  **Dispatched on a branch with `corpus_floor=main` and `corpus_only=true` it is an A/B of the branch against main, and the only job that starts**
  (`gh workflow run quality-gates.yml --ref <branch> -f corpus_floor=main -f corpus_only=true`; without `corpus_only` a dispatch also starts the screenshot, mutation, Lighthouse, solver and latency jobs).
- **Three seeds, and the middle one.** A shape searched at another seed is another search, and that is what any change to how the model is built does to it: the same week, the same engine, another seed took from 0.11 to
  7.9 work across the gate's weeks (one week 3.5 at seed 1 and 0.2 to 0.9 at the other six), and one seed against another failed the verdict in **18 of 42** ordered pairs (43 %) for a change that does nothing;
  the request's `requirements` shuffled three times (same school, same seed) failed it all three times. `corpus_measure.py --seeds 3` searches each week at seeds 1 to 3 and the row is the middle one (a week is a TIMEOUT only when most seeds give up, and an `ERROR` is never diluted), and a week
  is **lost for certain** only when the floor found it at every seed well inside the budget and this tree at none. With three seeds, that rule, and the one edge week taken out, the same experiment (every ordered pair of
  disjoint three-seed sets out of seven seeds, read as floor and tree) fails **7 of 140 pairs (5 %)**, all of them on the geometric mean. The mean of the same pairs ranges from 0.74 to 1.36, so the limit of 1.25 catches a slowdown of about 1.5 and
  hardly one of 1.25. (This is the review of #394's measurement: the first design showed the gate quiet only for changes that do not touch the model, and a change that does is a new throw for every week.)
- **What fails it** (`scripts/bench/solve-corpus-gate.mjs`, with tests that also run on every pull request): a week the floor gives a timetable and this tree refuses; weeks lost for certain (above); and the
  geometric mean of this tree's work over the floor's, across the weeks both solve, above 1.25. Printed, deciding nothing: refusals that changed code, weeks that gained a timetable, and the
  wall-clock ratio of the two trees. Exit 2, not a pass, when the two cannot be compared (other weeks, another corpus version, another budget, or **a week that the two trees read differently**: an engine from before a
  field drops it and measures another week under the same name) and when nothing was compared at all.
- **What it cannot see.** A regression that shows only with several workers (the portfolio production runs); the Python time of the build (wall time: printed per step, not gated); and **a change of OR-Tools' pin**,
  because both trees run on this tree's OR-Tools: a step prints a warning when the pin has moved since the floor, so that a green verdict is not read as "the upgrade is harmless". A floor older than the hook
  (`_generation_solver`, 2026-10-18) or than terms in the engine (2026-11-12) answers `ERROR` for what it does not support, which is a gain and not a failure.
- **Terms are barely in it.** The only gate week with term subjects is an edge week (it gets a timetable at three of seven seeds), and the sweep's other term weeks (the second seed at three term subjects, both seeds at five, the production's form) do not get one at a budget of 4 deterministic seconds. **Decided: no (the user, 2026-11-22).** The nightly gate does not cover terms. What covering them would take is a budget of 8 for the gate's weeks, which doubles the cost. The gate keeps the one edge week it has, and no more.
- **Quiet when the model is not touched.** The gate's weeks measured on `main` at five points in time (2026-10-25, 11-01, 11-08, 11-14 and 11-22, 76 changes to the engine between them, among them M1, M2, M3 and
  the time chain): **the work for the weeks that solve is identical to the last digit at all five** (measured at one seed). So changes that do not move how the model is built are silent; the first change that does is a new throw of the dice for
  every week, which is what the seeds above are for.
- **Tested to see a regression.** An engine with its search made worse on purpose (`FIXED_SEARCH`, no probing, no linearization) against the floor on four weeks: exit 1, three weeks lost, a mean of 2.22. One
  with presolve switched off scored 0.43 and passed, because the gate times the work to a first timetable and presolve is part of it.
- **Running it by hand:** `ENGINE_ROOT=<other tree>/optimization-engine python benchmarks/corpus_measure.py --profile gate --mode count --det-budget 4 --seeds 3 --jobs 4 --json > head.json`, the same for the floor,
  then `node scripts/bench/solve-corpus-gate.mjs --head head.json --floor floor.json`. `corpus_report.py` turns a `--profile sweep` run into the tables of §35.2.

### 35.4 What it says about M7 (the engine in parts)

M7 assumes the size of `scheduler_solver.py` costs time. What can be measured is how much of the time to a first timetable is Python: the prechecks and the builds, against the search. On the 39 weeks of
the sweep that got a timetable it is **4 % in the median (1 % to 18 %)**: 0.1 to 1.6 s of 1.1 to 144 s (one worker, at loads of 4 to 83). The stage times exist only for weeks that got a timetable, so no week of the size that times out is in the figure. M7 is not needed for the time a solve takes of weeks like these. (Maintainability, and the mutation gate's hour for
`optimization-proxy.service.ts`, are other arguments and not measured here.)

### 35.5 The production processor (roadmap decision 8, the user's)

Nothing in §35.2 says how fast a production core is, and the engine runs its search on as many workers as production has cores (`num_workers` is left at its default). The user has approved one
**calibration**, not the corpus, on a one-off instance of the engine's image with production's plan (not on the live service, which a school's Generera would then compete with for the cores, and
with its own `API_KEY`, `SOLVER_MAX_TIME_SECONDS=180` as in production). The image copies only `app/`, so the measuring stick of §35.1 is not on it; what an instance has is the engine's HTTP route, which does
not say deterministic time but says enough (`scripts/bench/solve-corpus-calibrate.mjs`, pure Node, tests that also run on every pull request):

```
ENGINE_API_KEY=<the instance's key> node scripts/bench/solve-corpus-calibrate.mjs measure \
  --url https://<instance> --payloads <the three weeks> --label <name> --cores <vCPU of the plan> --ladder 10,20,40,80 --out prod.json
node scripts/bench/solve-corpus-calibrate.mjs convert prod.json trajectory.json
```

- **The weeks** are three of the corpus's (`n12-g3-m0-s1`, `n15-g3-m0-s1`, `n9-g6-m0-s1`, written by `school_corpus.py --week <name>`): one that a single worker solves in a few seconds, one that a single worker cannot solve and eight cores can in about half
  a minute, and one that neither can. They are synthetic: no school's data goes to the instance.
- **Per week** the script runs `check-week` (wall time), a search with **one worker** and a fixed seed for 20 s (on a week the search gives up on, the TIMEOUT answer says how many conflicts that search made in how many
  seconds: the engine's own account, M2), and a **ladder** with every core and budgets of 10, 20, 40 and 80 s until a timetable is found (the clock table of §35.2 for the instance's cores, at the ladder's resolution: a
  solved request spends its phase 2 to the end of its budget, so its wall time says nothing about when the timetable was found).
- **`convert`** turns the conflicts into seconds. One worker with a fixed seed makes the same conflicts at the same deterministic second on every machine, and `benchmarks/corpus_trajectory.py` writes that table for a week
  (conflicts at 0.25, 0.5, 1, 2 and 4 deterministic seconds); the probe's conflicts are read against it, by straight lines and never beyond its end, to the work they took, and the probe's seconds divided by it are
  the instance's **seconds per deterministic second**: the number that replaces 18 in §35.2 and turns every row of the table into production seconds without running the corpus again. It needs no baseline on a quiet
  machine and gives the same answer on a loaded one.
- **Never a secret in the output, and never to another address.** The key is read from the environment, sent as `X-API-Key` and never printed or written; the result names the run by its label and not by the address. The script follows no redirect (`fetch` drops `Authorization` across origins but not `X-API-Key`) and refuses plain `http` to any address but its own machine, before the first call.
- About six minutes of compute on the instance, a quarter of an hour to start and tear it down. The number of cores is not in the engine's answer: `--cores` is what the person running it writes.

### 35.6 Not done

- The clock table is one run per week at a load that varied from 4 to 87 (a second seed and a quiet machine are open), and clock mode covers 41 of the 77 measured weeks.
- The corpus has the shape of a school with every year filled in and not its details: lessons of other lengths (here every lesson is a högstadium lesson), its rooms, and the exact group
  lists of its pupils. A second school is the only real second opinion.
- The weeks the search gives up on are measured to the budget twice over (two searches) and are left out of the gate for what they cost; when one of them starts to solve, the sweep shows it and
  the gate's weeks can be moved to follow.

### 35.7 The cliff weeks, and what is not known about the school's form (M8, PR 3)

**What they are.** `school_corpus.CLIFF_WEEKS` names seven weeks of the sweep, each at the **lowest day end at which some road has laid it** (`corpus_measure.py --profile cliff`; a week whose end is 16:00 is the sweep's own). Each has a **witness** in `optimization-engine/benchmarks/corpus/cliff_witnesses.json`: the road, the encoding, the seed, the deterministic work, the engine tree it was found on, the digest of the request, and the start of every lesson. `benchmarks/cliff_weeks.py --verify` (and `tests/test_school_corpus_cliff.py`) pins every lesson at its start and asks the engine for a timetable: it must accept it without moving a lesson, and the rooms it hands out are checked **from the answer** (two lessons in a room at once, a room of the wrong type or too small), not on the engine's word. A TIMEOUT on a cliff week is therefore the search and not the week. They have no terms (the nightly gate does not cover terms), and **the gate does not read them yet**: a week no tree lays gives it nothing, and its rows are for M8's roads to turn from TIMEOUT to a timetable.

| Week (name) | Lowest day end laid | By | Work (2 × 4 det. s, seed 1) | The engine as it is (one worker, same budget) |
|---|---|---|---|---|
| `n12-g4-m0-s1-e1530` | 15:30 | years one at a time | 1.17 | TIMEOUT at 16:00; laid with the groups as cliques at 16:00 (3.19) |
| `n9-g6-m0-s1` | 16:00 | years one at a time | 1.04 | TIMEOUT at 16:15 (seeds 1 and 2; seed 3 lays it on 0.78); 0.44 at 16:30 |
| `n12-g5-m0-s1` | 16:00 | years one at a time | 5.70 | TIMEOUT at 16:00; 0.28 at 17:00 |
| `n9-g8-m0-s1-e1630` | 16:30 | the engine, pairs | 4.32 | TIMEOUT at 16:15; 0.015 at 17:00 |
| `n9-g10-m0-s1-e1630` | 16:30 | years one at a time | 5.54 | TIMEOUT at 16:30; 0.11 at 17:00 |
| `n12-g6-m0-s1-e1645` | 16:45 | years one at a time | 5.15 | TIMEOUT at 17:00; 0.20 at 18:00 |
| `n12-g10-m0-s1-e1700` | 17:00 | the engine, pairs | 3.85 | TIMEOUT at 16:45 (16:00); 0.02 at 18:00 |

"Years one at a time" is `m8_paths.py years` of M8's design note: each year laid with the years before it held (pinned lessons), a refusal that names lessons in the way letting go of them. The ends are the lowest the SEARCH tried (15-minute steps; the monolith as the engine has it, then with the groups as cliques, then the years one at a time, in the order `down`): another order or a larger budget may lay a week lower. The measurement was made in count mode, so the work is the same on every machine; the machine's load is not a part of it.

**What they say about the table of §35.2.** These seven weeks are TIMEOUT in the table and known to have a timetable at 15:30–17:00; `n9-g6` and `n12-g5` at 16:00 itself, and `n12-g4` at 15:30, so also at 16:00. At seed 1 the monolith needed at least 30 minutes more of the day than the years one at a time on the weeks both lay (`n9-g6`: 16:30 against 16:00; `n9-g10`: 17:00 against 16:30; `n12-g5` and `n12-g6` more, the ends tried for the monolith were further apart), which is about 6 % of the frame. That is one seed, and a week near its edge is a lottery (§35.2, point 4): `n9-g6` at 16:15 is TIMEOUT at seeds 1 and 2 and is laid at seed 3 on 0.78 work, and at 16:00 it is TIMEOUT at seeds 1, 2 and 3. On a week that has a timetable the engine's search is weaker than a search that lays the years one at a time, by 15 to 30 minutes of the day at the seeds tried. The other TIMEOUT rows of the table at 16:00 (`n9-g8`, `n9-g10`, `n12-g6`, `n12-g8`, `n12-g10` and the rest) are not known either way at 16:00.

**The school's form is not known.** Ten subjects in groups, half groups, terms and long teacher chains; weeks of the sweep with that form, count mode, pairs, 2 × 4 deterministic seconds, one worker, the day ending at 16:00 and at 18:00:

| Week | 16:00 | 18:00 |
|---|---|---|
| `n6-g10-m0-s1-t5-h` (6 classes) | TIMEOUT | a timetable, 3.25 |
| `n9-g10-m0-s1-t5-h` (9 classes) | TIMEOUT | TIMEOUT |
| `n9-g10-m0-s1-t5-q1-h` (9 classes, teachers on the same group in every year) | TIMEOUT | TIMEOUT |
| `n30-g10-m0-s1-t5-y0.0.0.3.10.10-h` (30 classes in grades 4–9, 868 lessons, 4,154 pairs) | TIMEOUT | TIMEOUT |

**A TIMEOUT on these rows does not separate "hard" from "impossible", and nothing here says that the school's form is out of the engine's reach or that it can be laid.** The six-class week has a timetable at 18:00 and none was found at 16:00; for the others neither is known. What is known is what the weeks are: random draws of pupils (a school's groups are not), with every lesson 60 or 90 minutes (a school's run from 40 to 140), no dining hall, a planning afternoon for every teacher that no school was asked about, and teachers with one group each or a few (a school's have chains of five to ten). A second school, or a **planted** week (a timetable first, the pupils second, which a first attempt could not fit pupils to), is the only fact; `g386-L-4`, `g386-M-4` and `g386-U-1` are the posts that would bring the corpus closer.

### 35.8 Starting from a schedule: `startLessons` (M8, PR 4; M9's engine part)

**What it is.** `POST /optimize` takes an optional `startLessons`: the lessons of a schedule that already exists (requirement, weekday, start and end; at most 5 000), for a week that resembles it. A request without the field is solved exactly as before and is the same JSON as before (the field is None by default, not `[]`: an empty list would put a key into every request, and `tests/test_school_corpus_pins.py` pins the corpus weeks' digests, which the nightly gate's stored results are named by). The openapi document differs from main's by the field, the `StartedLesson` schema and one more name in `TimeoutStageName`, `START`, nothing else. An engine older than the field answers it with a 422 (`extra_forbidden` at `['body', 'startLessons']`), so the engine says `startLessons` among the `capabilities` of `GET /api/v1/timing`, which a gateway that sends it reads first (as it reads `deadlineSeconds`). A Bästa möjliga schema run (`relaxation`) reads the field only where nothing in the week is priced (`prices_anything`: no daily maximum, no minimum of days between lessons, no teacher's day limit or cap, no locked room): the mode is then the strict solve and starts from the schedule like any other. A week with something priced is laid by the relaxed solve, which does not read the field. It is **not a lock** (a locked lesson is a fact about the school and a refusal if the week cannot keep it) **and not a hint** (a hint only says where the search starts): the engine holds each lesson where it is until the week shows that it cannot stay, lets it go, and lays what is free.

**How** (`app/solver/staged.py`, `SchedulerSolver._solve_from_start`). The schedule is read into places (an entry goes to a place of its own length, longest first; an entry that fits none, a requirement the week no longer has, a requirement the school pinned and a split lesson are left out, counted in the log as `dropped`). What clashes with THIS week is let go of up front (a teacher or a group in two places, a group pair of `groupConflicts` overlapping, a teacher's UNAVAILABLE time) together with the other lessons of the same block, and the rest is **pinned** as the engine's own `pinnedLessons`. Then the ordinary solve (`_solve_strict`, every step and every refusal as before) is asked: an answer that is a timetable is the answer (phase 2 improves it with the schedule as `previousLessons`, unless the caller sent its own); a TIMEOUT is final; and an INFEASIBLE is read: the held lessons the refusal names as in the way (`PLACED_LESSON_IN_THE_WAY`) are let go, or, when it names none and something is free, the held lessons one step from what is free, and the week is asked again. A pin the week's frame cannot hold (`PLACED_LESSON_OUTSIDE_FRAME` and its kin) is let go by the requirement its refusal names. At most six rounds; the last attempt holds nothing and is the ordinary solve with the schedule as a hint, so a week that has a timetable is never refused for what the schedule held. Nothing held is ever returned unchecked: **the answer is the engine's own** (rooms handed out as always, every lesson checked as always), and the tests check teachers, groups and rooms from the answer.

**The step `START`.** The time of reading the schedule and deciding what to let go of is a step of its own, `START`, between `PRECHECKS` and `BUILD`. Each attempt enters the engine's steps again, so a TIMEOUT's report sums a step that came back into the place it first ran (`StageClock.report`: each step once, in the order they first ran, and the same for a search that ran in two attempts), because the gateway keeps twelve steps and six searches of a report **as raw entries** (g458 L-3) and a driver with many attempts would otherwise have its whole report refused. No new phase was added (an unknown *phase* still refuses the whole report).

**Order of merge.** The gateway on main does not know the step `START`: its contract spec holds the gateway's list of steps to the engine's `Literal` and the page's card has no text for it. PR #458 makes the gateway skip a step it does not know (and carry the seconds as `otherSeconds`), and this PR is merged **after** it, with `START` named in that spec's `SKIPPED_FOR_NOW` until a gateway PR gives the step its name. Nothing sends `startLessons` yet (neither the gateway nor the page), so the field changes nothing in production by itself.

**What it does on the corpus.** One Mac, clock mode, a budget of 60 s, the host's load 25–40 (the two runs of a row were side by side, so they had the same load; no production seconds, calibration on the production processor is the user's step), corpus version 2, **one run each**. "Plain" is the week as it is solved today; "from a schedule" the same week with `startLessons` of a sibling week (the same requirements, another draw of pupils into groups: `-s2` for `-s1`), and the last column counts the requirements whose lessons did not stay where the schedule had them:

| Week | The schedule it starts from | Plain | From a schedule | Requirements moved |
|---|---|---|---|---|
| `n9-g5-m0-s1` | `n9-g5-m0-s2` laid by the engine (FEASIBLE, 120 s) | FEASIBLE at 60 s | OPTIMAL in 5.9 s | 3 of 108 (plain: 107) |
| `n12-g4-m0-s1` | `n12-g4-m0-s2` laid by the engine (FEASIBLE, 120 s) | FEASIBLE at 60 s | FEASIBLE at 60 s | 7 of 141 (plain: 137) |
| `n9-g6-m0-s2` | the witness of `n9-g6-m0-s1` (§35.7) | FEASIBLE at 60 s (**TIMEOUT** in two earlier runs) | FEASIBLE at 71 s | 24 of 108 (plain: 107) |
| `n12-g5-m0-s2` | the witness of `n12-g5-m0-s1` (§35.7) | **TIMEOUT** at 60 s | **FEASIBLE** at 64 s | 24 of 141 |
| `n9-g6-m0-s1` | its own witness | (TIMEOUT: §35.7) | OPTIMAL in 0.4 s | 0 |
| `n12-g5-m0-s1` | its own witness | (TIMEOUT in count mode: §35.7) | OPTIMAL in 0.5 s | 0 |

What the table says, and what it does not. Where the plain solve finds a timetable the one from a schedule is the same kind of timetable with 3 to 24 requirements moved instead of 107 or 137 (the plain solve has no reason to resemble anything), and on `n12-g5-m0-s2`, a week that is TIMEOUT today, one is laid that keeps five requirements in six where the schedule had them. `n9-g6-m0-s2` sits on the cliff of §35.7: it was TIMEOUT in two runs on the tree before the corpus' second version and FEASIBLE in this one, so the table does not show it as a week the road lays and the plain solve does not. **A FEASIBLE at the budget says that phase 2 ran on until it was stopped, and its seconds say nothing of when the first timetable came** (the same is true of the plain FEASIBLE rows); a run of `n9-g6-m0-s2` with the log on shows what the attempts are: the first was refused 1.6 s after the start (13 requirements clash with the week, 37 let go), the second after 4.2 s (67 let go), and the third held 41 and ran to the budget. The overrun past 60 s (up to 11 s) is phase 2's stop lag with the schedule as its disruption term, and the attempts share one deadline. **The schedule was laid by the engine or by a road of §35.7 on a week of the same school form; a schedule a school's own planner made, or one read in from another program, is not measured**, and neither is a week that resembles the schedule less than a sibling seed does (a school changing a year's groups between years). The weeks are the corpus's, one run each: it says that the road works on them and not how often.

### 35.8a Starting from a schedule: the gateway's side (M9, "Ett schema som start")

**What it is.** Generera takes an optional `startFrom` (`POST /api/v1/optimization/jobs` and `/trigger`): `{ "source": "CURRENT" | "PREVIOUS_YEAR" | "VERSION", "versionId"? }`. Absent it, Generera is what it was, byte for byte: the request to the engine has no `startLessons`, the job row has no `startedFrom`, and the controller and the jobs service call the proxy with the arguments they always did. With it, the gateway reads the schedule the school chose, maps its lessons to the posts of THIS week and sends them as `startLessons` (§35.8): the engine holds each lesson where it was, lets go of what clashes with the week and lays the rest. It is not a lock: nothing is written as locked, and nothing the school locked is ever given as a start (a lock is already in the payload as `fixedLessons`).

**The three sources** (`src/optimization/start-sources.ts`; the mapping is `start-schedule.ts`, pure and with no database):

| `source` | Reads | Notes |
|---|---|---|
| `CURRENT` | the year's draft: the lessons the next Generera replaces (the machine-owned masters the fetch has already read), not parked | A first Generera has none, and is refused (below). |
| `PREVIOUS_YEAR` | the masters of `AcademicYear.predecessorId` under the successor of each class (`StudentGroup.predecessorId`), not parked | A class with no successor (the leaving 9th grade, a new intake) is counted `NO_SUCCESSOR`. A lesson of several classes or of named pupils is `NOT_STARTABLE`. The dates of a lesson that ran in part of the year move as the rollover moved its post (`mapPeriod`, the whole-week shift), and a lesson whose period no longer fits is `OTHER_WEEKS`. Odd and even weeks are matched as they are: the rollover copies a post's parity unchanged (the preview already says that ISO week 53 swaps them), so a lesson and its post still agree. |
| `VERSION` | a saved version (`ScheduleVersion`) **of this year** | The machine's lessons only: a locked lesson, a lesson placed by hand, a parked lesson and a lesson written from a förläggning are left out (they are in the week as they stand). A snapshot from before `isGenerated` is read as the machine's. A file read in from Skola24, Untis or aSc is saved as a version (`schedule-exchange`), and is then started from like any other. |

A lesson is matched to a post by group, subject and the weeks it ran (parity and dates); a lesson that matches no post, a post that is not in the week (every lesson of it is locked), two posts that the lesson could belong to, and a post the engine does not start (split lessons, pinned lessons) are left out and counted by reason: `NO_SUCCESSOR`, `NO_POST`, `NOT_IN_WEEK`, `OTHER_WEEKS`, `AMBIGUOUS`, `NOT_STARTABLE`, `MORE_THAN_ASKED`. No more entries are given for a post than the week asks of it.

**An older engine never blocks Generera.** The gateway asks the engine what it can take (`GET /api/v1/timing`, `capabilities`): an engine that lists `startLessons` is sent it; one that has said what it can take and does not list it is not sent it and the schedule is not even read; one that has said nothing (it was not up when the API started, or it is older than `/timing` itself) is sent it once and answers 422 `extra_forbidden` at `['body','startLessons']`, which `callAiEngine` answers by sending the same week again without it (as it does for `placements` and `deadlineSeconds`). In both cases the week is laid as Generera lays it with no start, and the run says so: `startedFrom.engine` is `OLDER` and the counts are null, which the page puts in a sentence so that a school does not believe a schedule was held that was not. The 422 was read from a real older engine (`ed3f1db39`, the tree before PR #460): its body names `['body','startLessons']` as `extra_forbidden` among the other errors, which is what `refusesField` reads.

**What is refused, and when.** At the click (no job row): a `versionId` that is not one of this year's, `404 START_VERSION_NOT_FOUND`; `PREVIOUS_YEAR` for a year that was not rolled over from another, `409 START_NO_PREVIOUS_YEAR`. In the run, before the engine is woken and with nothing written: a schedule none of whose lessons belong to a post of the week (a first Generera that asks to start from the draft, a version of other classes), `409 START_NOTHING_TO_START_FROM`, with flat params that say why (`offered`, and `noPost`, `noSuccessor` … for each reason that left some out). A week laid from nothing is not what the school asked for. A week with nothing left to lay (every post locked) has nothing to start, and is not refused.

**What the run stores.** `OptimizationJobs."startedFrom"` (migration `20270308090000`, one nullable `jsonb` column and a CHECK for an object of at most 2 KiB, taken NOWAIT with retries as `20270228090000` was): `{ source, versionName, engine: USED | OLDER, offered, used, held, moved, laid, dropped }`, read back through a whitelist (`startedFromOf`). `held`, `moved` and `laid` are counted from the engine's answer set against the entries given, post by post: a lesson of the answer at the very time an entry of its post had is HELD (the end is part of the time), of the rest as many as the shorter side are MOVED, and what is left of the answer is LAID with nothing to replace. They sum to the lessons the answer holds, and they are the database's own count: the probe checks `held` against the lessons that stand where the saved baseline had them. No lesson and no person is in the column. Null for a run that started from nothing.

**What it does, in the probe** (`scripts/test/probe-schema-som-start-motor.ts`: a real engine of this tree on a real database, a school of six classes in three grades, ten subjects, eighteen teachers, a school day of 08:00 to 16:00, 180 lessons a week, 75 % of the week; the engine's own budget is 60 s; three runs of the whole probe on one shared Mac, with the host's load beside each because it was 40 to 100 and changed during the runs, so no row is a production second. Run A failed one step: the probe then asserted that a start moves no more lessons than the hint does (10 against 9), which is not what a start is for in a world this easy, and the assertion became a loose bound; B and C ran clean):

| Step | Result | Wall clock, run A / B / C (fetch, engine, write) |
|---|---|---|
| laid from nothing (the baseline) | 180 lessons, no clash | 17.6 / 1.1 / 1.6 s |
| the same week started from its own schedule | 180 held, 0 moved, 0 laid, the same lessons written | 2.1 / 0.4 / 1.1 s |
| two teachers lose a morning each (8 of their lessons clash): laid from nothing with the schedule as a hint, as Generera has always done | 9 of 180 not where they were | 63.8 / 61.5 / 27.9 s |
| the same week started from its own schedule | 171 held, 9 moved, 0 laid; the two teachers teach nothing in their mornings; no clash | 9.2 / 7.8 / 1.0 s |
| the same, from a saved version of the year | 171 held, 9 moved, 0 laid | 12.7 / 4.8 / 1.1 s |
| the year after: 4 classes continue, the leaving 9th grade has no successor, a new 7th grade continues nothing, from last year's schedule | 117 held, 3 moved, 60 laid (the new classes); the 60 lessons of the leaving classes counted `NO_SUCCESSOR`; no clash | 1.3 / 5.6 / 0.6 s |
| an engine from before `startLessons` (`ed3f1db39`) asked to start | laid as before, 180 lessons, no clash, `startedFrom.engine` `OLDER`, none moved or held counted | 2.8 s (one run) |

Load averages (`uptime`, 1 / 5 / 15 minutes) at the start and the end of each run: A 100.8 / 102.2 / 59.0 and 42.4 / 74.5 / 55.7; B 38.5 / 67.9 / 54.5 and 71.4 / 70.3 / 56.8; C 65.5 / 69.3 / 57.2 and 71.7 / 71.0 / 58.8. What to read is the ratio on the changed week, which is the same in the three: the week started from its schedule took a seventh to a twenty-eighth of the time the same week took from nothing (9.2 against 63.8 s, 7.8 against 61.5 s, 1.0 against 27.9 s), because the engine does not search for 180 lessons but for the 8 that clash and what they push. The hint (`previousLessons`, which Generera has always sent) already keeps most lessons where they were in a world this easy to keep, so the number that moved is the same with and without a start (9 and 9): what a start changes is time, and that the lessons that stay are exactly the school's own and are held, not rewarded. The corpus weeks that are TIMEOUT from nothing and are laid from a schedule are §35.8's, which this changes only by sending the field.

**Merge and deploy.** The migration is run in production **before** the merge (DEPLOYMENT §2): the API after this PR names `startedFrom` only for a run that asked for a start, so the API before it is not affected, and a run before the column has null. The migration takes its one lock (ACCESS EXCLUSIVE on `OptimizationJobs`) NOWAIT in a loop: if the table is not free once in 30 s it stops with nothing changed, and `prisma migrate deploy` then refuses (P3009) until `prisma migrate resolve --rolled-back 20270308090000_en_korning_sparar_vilket_schema_den_utgick_ifran` has been run; then deploy again. The engine is not changed by this PR; it already says `startLessons` among its `capabilities` (§35.8) and the gateway sends the field only to an engine that does, or to one that has said nothing and answers its own 422.

**Not done (and where it goes).** The page's choice of start and its sentences (the next PR of M9), the rollover's offer of last year's schedule (the third), and a file read in from Skola24, Untis or aSc as a saved version. A new class with no predecessor (an intake) has no schedule to start from, though its posts are copies of an older class's: the rollover knows which (`intake:<sourceId>`) and the database does not, so it is laid from nothing. A schemaförslag run does not start from a schedule; E7b builds on this.

## 36. What the school's base data holds, and what is missing ("Vad kom in", P1 Pilotkit, part 2)

A page, `/admin/intake` (menu: Grunddata › Vad kom in), and one route behind it, `GET /api/v1/intake`. It counts the active läsår's base data (the year, subjects, rooms, frame times, rasts, classes, teaching groups, teachers and pupils, the lokal timplan, the posts, the staffing) against what Generera and the steps after it ask for, and names each gap at one of three levels (stops Generera, gives a worse timetable, only another step reads). The rules are `src/intake/intake.ts`; the page gives each gap its words and the page that owns it. It writes nothing and holds no migration.

- **Deploy order.** Either. The route is new and nothing calls it but the page; a web that is ahead of the API shows "Det som kom in kunde inte hämtas" (a 404 is a failed read, never "nothing is missing"), and an API that is ahead is a route nobody calls. Nothing to run in production and nothing to roll back but the two deployments.
- **What it reads.** Counts, and the names of classes, subjects and årskurser, as the person asking, under row security: every administrator profile, the läsare and the huvudman's reader included (`huvudman-gets` holds the shape). It selects no person's name, no e-mail address, no percentage of a post and no signature; a post is a row that exists. A teacher, a pupil and a guardian have no route.
- **The active year only.** The route takes no year. A rolled year that is not yet activated has its classes' pupils still in the old classes (förberäknade klasslistor), and a count of what the school holds now cannot answer for it; `src/year-rollover/roster-readers.inventory.spec.ts` classifies the file CURRENT on purpose, and `src/staffing/employment-readers.inventory.spec.ts` POST (the existence of a row, never a figure).
- **What the page never says.** That a week can be laid, or that the school is ready. A page with no gap is the absence of the gaps counted, and the first thing it says under a clean count is to run Kontrollera veckan (5.2 of the manual).
- **The proofs.** `src/intake/intake.spec.ts` (the rules), `src/intake/intake.service.spec.ts` and `test/intake.e2e-spec.ts` (what is read, the gates and the shape, with the database faked), and `scripts/test/probe-intake.ts`, which CI's Database job runs after the schedule exchange probe: its own schools, each count against the rows it made, another school's and an inactive year's rows never counted, a TIOARIG läsår held against the frames in NIOARIG. Run it by hand against a scratch database:
  `DATABASE_URL='postgresql://app_authenticated:app_authenticated_local@localhost:<port>/schemapro?schema=public&connection_limit=2' PROBE_OWNER_URL='postgresql://postgres:postgres_local@localhost:<port>/schemapro' npx ts-node --transpile-only scripts/test/probe-intake.ts`
- **Where a gap's level comes from.** A gap is HARD only where the code stops the run: the engine refuses the request by name (`INPUT_NO_REQUIREMENTS`, `INPUT_NO_ROOMS`, `ROOM_NONE_ELIGIBLE_FOR_REQUIREMENT`: each raised before the search; the last also has two causes the page does not count, a room too small for the group and a room outside its årskurser, which Kontrollera veckan finds), the Generera page's own Förutsättningar hold the button (a läsår, a teacher, the staffed posts under Vägra), or a post cannot exist without it (a subject: a post belongs to a class or to a teaching group, so a class is not a stop). The manual's table (3.7) is held to `GAP_DEFINITIONS` by `web/lib/manual-pilotkit.test.ts`, and the web's words and links to the same list by `web/lib/intake.test.ts`.

## 37. Resetting the demo school, and never any other ("Demoskolans återställning", P1 Pilotkit, part 3)

`prisma/seed.ts` has always made one school, "Demo Skola" (slug `demo-skola`), with eight teachers, eighty pupils and the posts a week is generated from; `--reset` deleted it and made it again. It looked at the school's slug and nothing else, and `School.slug` is unique: a real school that had been given the slug would have been found and deleted with all its data. It also deleted in one statement and built in many, so a failure halfway left half a school, and it dropped the one thing a tester sets up: the login linked to the demo's administrator (§15.6).

```
npm run db:reset-demo              what a reset would do, and whether it may; nothing is written
npm run db:reset-demo -- --yes     do it
npm run db:seed -- --reset         the same as --yes, as it has always been run
```

All three connect with `DIRECT_URL`, the table owner's, as the seed does. **It is the operator's.** There is no button in the product, no role and no route that can reach it, and a school's own administrator cannot reset anything: a button would need a `SECURITY DEFINER` function that deletes a school and a mark on the school the API cannot set, which is a migration and a new door in a database whose doors were just inventoried (§29); it is a decision for when a pilot school is to practise on a demo school, and none has one.

**What stands between it and a real school.** In one transaction the school's row is locked (`SELECT … FOR UPDATE`), its facts are read *after* the lock, and `src/demo-school/demo-guard.ts` judges them. A school is the demo school when every person in it, active or not, whatever the role, has an address at the demo's domain, `demo-skola.example.com`, which is reserved (RFC 2606) and has no mailbox behind it, and when it also has the demo's slug and name and nothing tied to it from outside. It is refused, with nothing deleted, when:

| Refusal | When |
|---|---|
| `DATABASE_HAS_A_REAL_SCHOOL` | the demo school is **not there** and some school in the database has a person at an address outside the names reserved for examples: see below |
| `NOT_THE_DEMO_SCHOOL` | the slug or the name is not the demo's |
| `NO_PEOPLE` | nobody is in it: an empty school proves nothing |
| `PEOPLE_OUTSIDE_THE_DEMO` | one person has any other address, a deactivated one or a look-alike (`x@evil.demo-skola.example.com`, `x@demo-skola.example.com.evil.org`) included |
| `TIED_TO_A_HUVUDMAN` | a huvudman owns it, has asked for it or has it in its history |
| `TIED_TO_ANOTHER_SCHOOL` | a travel time, a room on loan or a shared teacher joins it to another school: a delete cascades through those rows and would reach the other end |

The refusal names a count and never an address. A person added while the reset runs cannot be missed: adding one takes a share lock on the school's row, which waits for the reset; the person then finds the school gone and the insert fails, so nobody is ever deleted unseen. A failure after the delete rolls everything back, the old school's id and rows included.

**A tester's own people stop it, and there is one way back.** §15.6 has a tester invite a test teacher, a pupil and a guardian to mailboxes of their own. Each is a person at an address outside the demo's domain, so the reset refuses the school (`PEOPLE_OUTSIDE_THE_DEMO`), a deactivated person included and a pseudonymised one too (it is at `pseudonym.invalid`, which is not the demo's domain), and it goes on refusing: the guard cannot tell a tester's mailbox from a real school's, and does not try. What a reset keeps in §15.6 is the login on a *seeded* row (the administrator's, or a seeded teacher's), never an invited person. To start over, the owner deletes the demo school by hand (`DELETE FROM "Schools" WHERE "slug" = 'demo-skola';`, which takes everything in it with it, the invited people too) and runs `npm run db:seed`, which is allowed when no person left in the database has a real address; the logins have to be linked again.

**A database with a real school and no demo.** `db:seed` runs against whatever `DIRECT_URL` names, and the production database holds one school and none with the demo's slug: without a stop, a seed or a `--reset` run against it by mistake would have added a school of eighty fictional pupils beside the real one. Where the demo school is not there, the script now makes it only if no person in the database, in any school, has an address outside the names reserved for examples (RFC 2606 and 6761: `example.com`, `example.net`, `example.org` and everything under them, and the top domains `.test`, `.example`, `.invalid` and `.localhost`). Otherwise it prints `NOT SEEDED`, with the number of schools that hold such a person and never an address, exits 1 and makes nothing; so do `db:seed`, `db:seed -- --reset` and `db:reset-demo`, with or without `--yes`. A school with nobody in it holds no personal data and does not count; a look-alike such as `example.com.evil.org` is a real domain. **Two kinds of real school are therefore not seen by it**, and a database that holds nothing else is not stopped; the limit is chosen, not overlooked (the review of #405, L-4): a school with no person at all, and a school whose people have all been pseudonymised (gallring writes `pseudonym-<id>@pseudonym.invalid`, and `.invalid` is reserved), since the guard reads people's addresses and neither school has an address a person can be reached by. A demo school can be seeded beside either, provided that no other school in the database has a person at a real address (one that has stops the seed as before). The first is a window, and §7 says how it opens: the school row and its first administrator are two statements, and a `db:seed` between them sees a school with nobody in it. A new database (CI's, a developer's) and one that holds made-up schools only (the RLS fixtures', the probes', the högstadium seed's) are not stopped. Where the demo school **is** there, a reset is judged by its own people as above and a real school in the same database is untouched; that case, and the refusal where the demo is not there, are proved on a throwaway database. There is no override: a database that holds a real school and also needs a demo school is a decision for a person, not a flag.

**Logins.** The seed's people have no login (random `authId`s that are in no Supabase project). A login only the demo school holds, such as the administrator linked in §15.6, is written back to the new row with the same address, `authId` and `invitedAt`. A login is a row with an `invitedAt` (§7: *`invitedAt` says the person has a login*): a seeded row given an `authId` and no `invitedAt` is not counted as a login, is not written back and is not in the count the script prints. A login another school also holds is **not**: a row takes a login another row holds only through the gateway's invitation (`Users_a_login_joins_another_school_by_invitation`, migration 20261204090000), and a script that went round that would open the door the invitation is for. That person is invited again at `/admin/people`, and the other school's row is untouched. The Supabase user is never deleted, and the script says how many logins were kept and how many were not, never whose.

**What the reset does not change.** The content is exactly what the seed made before it was a function (`prisma/demo-school.ts`): the RLS suite and the adapter probe count its rows, and all 171 tables that carry a school's rows hold the same counts as before. The demo school has no frame time, no rast, no lokal timplan and no teacher's post, and nothing in it stops Generera. The guard makes a reset safe for every *other* school in the database it is run against; it does not make a demo school belong in production, and the seed's warning, never to run it with production credentials, stands.

**The högstadium seed, and what `db:seed` says of a school that is there.** `npm run db:seed:hogstadium -- --reset` makes a school of its own fictional people (slug `hogstadieskolan`, every person at `hogstadieskolan.example.com`), and used to delete the school with that slug whatever was in it: the same fault as the demo school's, with the same remedy. It now deletes it in one transaction, with the row locked and the facts read after the lock, and only if the school passes the judgement above with the seed's own slug, name and domain; otherwise it prints `NOT RESET` with the reason (a count, never an address), exits 1 and deletes nothing (the review of #405, L-5). `db:seed` without `--reset`, where the school with the demo's slug is already there, judges it first too: of the demo school it says "Use --reset to recreate it", and of a school that is not the demo school it says `NOT RESET` with the reason and exits 1, and not the advice that ends in that refusal (L-7). The högstadium seed asks the same in every path: where its school is there and `--reset` was not asked it says `NOT RESET` of a school `--reset` would refuse, and where its school is not there it makes it only in a database that holds no school with a person at an address outside the reserved names, as the demo seed does (`NOT SEEDED`, exit 1, nothing made); run against the production database, which holds one such school, it makes nothing.

**The proofs.** `src/demo-school/demo-guard.spec.ts` holds the judgement with no database (the address boundaries, the order of the reasons, a spec of another name). `scripts/test/probe-demo-reset.ts`, which CI's Database job runs after the schedule exchange probe (it needs a database that holds no school with a real address when it starts, which CI's does), holds what a database adds, on schools it makes from a spec of its own and never on `demo-skola`: a real school's every row, counted and hashed in every table that has a `schoolId`, the same after a reset of the demo school; each refusal, with the refused school's rows unchanged; the two orders of a person added at the same time; the rollback; a login kept and one not kept; the read log (`PersonalDataAccess`, append-only, no foreign key to the school) not stopping a reset; and a database with a real school, where nothing is made by a seed, a reset or a dry run, and a demo school that is there is reset beside it; a school with nobody in it, one of reserved addresses and one of pseudonymised people, each made there, none of them a real school; the högstadium seed's deletion, refused for a person at a real address or another name and done for its own school; and what `db:seed` says of a school that is there. Run by hand against a scratch database:
`PROBE_OWNER_URL='postgresql://postgres:postgres_local@localhost:<port>/schemapro' npx ts-node --transpile-only scripts/test/probe-demo-reset.ts`
The seed, the reset and the demo school's builder are typechecked by `npm run typecheck:scripts`: they run with `ts-node --transpile-only`, so nothing else sees a renamed import until the day somebody resets.

## 38. The ordinance's teaching time, a teacher's level and exception ("Undervisnings- och planeringstid", R1, SFS 2026:1487)

The ordinance (SFS 2026:1487, in force 2027-07-01, grundskola only) gives a span of clock hours of teaching a year per stage and the planning time that goes with it, scaled by the post. It is built in parts, each its own pull request, and **two of them hold a migration**:

| Part | What it adds | Migration |
|---|---|---|
| A (#372) | The ordinance's figures as two global reference tables, `AssignmentScopeVersions` (one row per wording, with the day it takes effect) and `AssignmentScopeBands` (a span per stage), and `StaffingPolicies."assignmentScopeMode"` (`StaffingCheckMode`, default `WARN`) | `20270301090000_forordningens_nivaer_for_undervisningsuppdraget_ar_referensdata` |
| B–D, L-3, L-5 (#382, #387, #397, #399, #400) | The report of a teacher's teaching time and planning floor in `GET /staffing/load` and its cards (the staffing page, the teacher's own page), and the corrections the reviews asked for | none |
| E (#404) | The check at write time: a row that leaves a teacher over the ordinance's highest level warns (`WARN`, the default) or is refused (`REFUSE`, 409 `STAFF_TEACHER_OVER_SCOPE`) | none |
| F (#408) | Föreslå bemanning and the teacher-choice search plan against the highest level | none |
| G1 | `AssignmentScopeAssessments`: the rektor's own level for a teacher and a registered exception under 11 § (a table, an enum type, a trigger function) | `20270306090000_rektorn_satter_lararens_niva_och_registrerar_undantag_enligt_11` |
| G2, G3 | The gateway route and report that read the table, and the drawer and card that write it | none |
| H | A cheaper week count, the proposal no longer sends the level, and the manual says why a teacher near the ceiling gets no more posts | none |

### 38.1 Deploy order

- **A migration is run before its code is merged, in stamp order, with `prisma migrate deploy` from a tree that has every migration already applied** (§20.2 does the same; the round's `prod-migrering.sh` wraps it: it checks the file's sha256, reads `migrate status` first and refuses everything but exactly the pending migration): A's `20270301090000`, then `20270305090000` (the vägrad vecka, not R1), then G1's `20270306090000`. A is applied in production. G1's checks are `r1-prod/g1/prod-fore.sql`, `prod-efter.sql` and `prod-migrering.sh` in the round's notes (one SELECT per check, `public` and `app` only, nothing that names a person; the script checks the file's sha256 before it runs, and `prod-efter.sql` holds it too).
- **A gateway before a migration is unaffected by G1**: nothing reads `AssignmentScopeAssessments` until G2 is merged, no other table's arm or grant is touched and no existing function is changed. G1 holds one UPDATE of reference data A put in (the band for åk 7–9 quoted planning's paragraph as "4 § p. 1 och 5 § p. 1", and 4 § p. 1 covers åk 1–6 only: it becomes "4 § (tolkat) och 5 § p. 1"; no figure and no day moves, and A's own migration, whose checksum is in production, is untouched).
- **G1 takes `Schools`, `AcademicYears` and `Users` in `SHARE ROW EXCLUSIVE`, `NOWAIT`, all three together**, in a loop that retries every 50 ms for 30 s and holds nothing between tries, so a request that holds one of them never waits behind a migration that holds another. If the three are not free at once it stops with nothing changed, and says so: Prisma then marks the migration failed and refuses every later `migrate deploy` (P3009) until `prisma migrate resolve --rolled-back 20270306090000_rektorn_satter_lararens_niva_och_registrerar_undantag_enligt_11` has been run (the error names it); then deploy again.
- **The web may be ahead of or behind the gateway.** From E, `PUT /staffing/policy` carries `assignmentScopeMode`; a web before E sends no field, and a `PUT` is a replacement of the whole row, so a school that had chosen `REFUSE` or `OFF` is put back to `WARN` by the next save from a page opened before the rollout (the same as for `unstaffedGeneration`). The new web against a gateway before E is refused (400, the field does not exist) for the minutes between the two deployments.
- **What the default does on the day.** A's migration gave every existing policy row `WARN`, so from E's merge every school's writes of a row for a teacher with a post are asked about the ordinance's level, and warn. A school whose läsår begins before 2027-07-01 is not asked (the ordinance does not reach it: no wording holds on the year's first day), and neither is one whose numbering the ordinance has no band for (the ten-year grundskola).

### 38.2 Rolling back

- **G1:** `DROP TABLE "AssignmentScopeAssessments"; DROP TYPE "AssignmentScopeException"; DROP FUNCTION app.assignment_scope_assessments_decided();` and, if the quotation is to go back, `UPDATE "AssignmentScopeBands" SET "planningSection" = '4 § p. 1 och 5 § p. 1' WHERE "gradeFrom" = 7 AND "gradeNumbering" = 'NIOARIG';`. All of it is additive, and **nothing reads the table before G2**: after G2 a rollback rolls out a gateway without G2 first, since the load report and the write route read the table and a DROP before that gives an error for a läsår the ordinance reaches.
- **A:** `DROP TABLE "AssignmentScopeBands", "AssignmentScopeVersions"; ALTER TABLE "StaffingPolicies" DROP COLUMN "assignmentScopeMode";`, again after the gateway has been rolled back past every part that reads them. **A's own note said "nothing reads it", which holds only before B:** since B the gateway reads the two tables in `GET /staffing/load`, and since E the column is read by every staffing write, so a rollback of A rolls out a gateway before B first (review of #382, L-4).

### 38.3 What they read, and who may

- **The reference tables** are global and have the one `SELECT` arm every global table has (`current_school_id() IS NOT NULL`, `TO authenticated`); nothing writes them but a migration, so a new wording is a migration and moves the figures for every läsår that begins after it without code.
- **`AssignmentScopeAssessments` is an employee's HR data, like a post's percentage:** every administrator reads, the one who decides (the rektor or a full administrator) writes, and a teacher reads their own row. **Every arm is `TO app_authenticated`**; `authenticated` and `anon` (PostgREST) have nothing, unlike `TeacherEmployments`, which has a direct path for older reasons, and `service_role` has `SELECT` only. A teacher's own arm did not need the "marked" administrator who teaches (`Users.teaches`): such a person reads their row through the administrator's arm, and the row is recorded as STAYS in section 494.
- **"Who" and "when" are set by a trigger from the session and never by the writer**, so the record is true for every path in and not only the gateway; a call that sends another person's id or another date has them overwritten. The trigger leaves an update at a depth above one (`pg_trigger_depth() > 1`) as it is: the foreign key's `ON DELETE SET NULL` updates the row from inside the referencing trigger, and the first version overwrote the NULL with the person who was removed (section 569 caught it). The assessment belongs to the teacher and stays, without a name, when the rektor who made it is removed.
- **The rollover registry marks the table `SKIPPED`**: a level and an exception are for one läsår and the rektor decides again, so a year's rollover copies nothing. The removal inventory tells both keys to `Users` (`CASCADE` for the teacher, `SET NULL` for the decider), and the register extract (the teacher and the decider) and the school export's person tables hold the table.

### 38.4 The proofs

- RLS sections 566 (the catalogue), 567 (what a decider writes and what the trigger and the checks do), 568 (who reads) and 569 (what a removal does), and a row in the matrix school's fixtures; 21 mutants of the table are each killed by them, and section 494 records the teacher's own arm as STAYS. The adapter probe (`scripts/test/prisma-adapter-probe.ts`) holds the statement budgets of the writes E asks about (`'give a timplanspost a teacher'` 29 statements, two more than before E) and reads the ordinance's wording on the real database, a läsår it does not reach included.
- `src/staffing/assignment-scope.ts` is the one place the level is worked out (`scopeOfTeacher`); the write check, the import, Föreslå bemanning, the search and the report all go through it, and the figures a school sees are the same on every page. `teaching-weeks.contract.spec.ts` and the web's `teaching-hours.contract.test.ts` replay one fixture for the week arithmetic.
