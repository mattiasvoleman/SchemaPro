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
the catalogue **invalid**: not used by the planner, still kept up to date by
every write, and holding its name. The rerun then stops at the same statement
with

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
postgresql://app_authenticated.<ref>:<PASSWORD>@aws-0-<region>.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1&sslmode=require&uselibpqcompat=true
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
> `connection_limit` still sizes the API's pool. Do not add `query_timeout`:
> the API refuses to start with it (src/database/pool-config.ts).

> Sanity check: connect as `app_authenticated` and run
> `select count(*) from "Schools";` — it must return **0 rows visible** (RLS
> filters everything for a session with no JWT claims), not an error.

The API enforces this at boot: it reads its own privileges from `pg_roles` and
**refuses to start** if the role is a superuser or has `BYPASSRLS`, because
either makes PostgreSQL skip every policy and returns other schools' rows
instead of erroring. A misconfigured `DATABASE_URL` therefore fails loudly on
deploy rather than silently disabling tenancy.

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
| `SOLVER_MAX_TIME_SECONDS` | `60`: the solve budget in seconds (raise for very large schools). A solve that times out answers after this plus `SOLVER_PROBE_SECONDS` (default `20`). The old `SOLVER_TIMEOUT_SECONDS` is gone: nothing read it. |

The solver needs no database and no PII ever reaches it. Keep it on a private
network reachable only by the API if your host supports it.

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
| `AI_ENGINE_URL` | solver base URL, scheme included (`https://…`) — a bare hostname is not a URL and surfaces as "AI engine unavailable" |
| `AI_ENGINE_API_KEY` | the shared secret from step 0 |
| `AI_ENGINE_TIMEOUT_MS` | `90000` (must exceed the solver's `SOLVER_MAX_TIME_SECONDS` + `SOLVER_PROBE_SECONDS`; at a 180 s budget use at least `240000`) |
| `CANDIDATE_MAX_SECONDS` | optional, `5`–`120`, default `30`: Schemaförslag's solve budget for each candidate, the same for all of them so the emphases are compared at one budget (docs/verification-baseline.md). Each candidate call waits this plus 45 s (plus 20 s for the first call's probes), whatever `AI_ENGINE_TIMEOUT_MS` says |
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
| `CANDIDATES_BACKGROUND` | `on` (default) or `off`: the quarter-hourly sweep that marks abandoned candidate runs FAILED, deletes runs older than seven days, and deletes the emptied rows "Ta bort förslagen" left of runs whose engine call was still out, once that call could have ended. Every start in any school sweeps first, so off only delays those deletions |
| `COVER_REQUESTS_BACKGROUND` | `on` (default) or `off`: the 5-minute tick that settles the open vikarieförfrågningar: the ones whose time is out end `EXPIRED` and the administrator who asked is told nobody said yes, the ones whose lesson or absence went away end `CLOSED` and the colleagues they waited on are told. A question past its time cannot be answered whether or not it has run; the tick settles the stored status, frees the lesson for a new question and tells who it concerns |
| `CRISIS_BACKGROUND` | `on` (default) or `off`: the quarter-hourly look at alarms left open in Krisläge. A real alarm that has stood open for 12 hours, or an exercise for 3, is ended (`autoEnded`), because only one of each kind can be open and a forgotten one would stop the next. Nobody is told; the app reads the alarm again when it is opened. With `off` an alarm is ended by an administrator or not at all |
| `GALLRING_BACKGROUND` | `on` (default) or `off`: the 5-minute tick of the nightly gallring. A school's run starts at 03:00 its local time, once a night, and only for the kinds its admin has given a period on `/admin/dataskydd`; a school that has decided nothing loses nothing |
| `SCHOOL_EXPORT_BACKGROUND` | `on` (default) or `off`: the 30-second job of the whole-school export (`/admin/dataskydd`). It takes the oldest order, if any, builds the zip as the administrator who ordered it (their login and school under row-level security) and stores it in pieces in `SchoolExportChunks`; a file is fetchable for three days and then deleted. With no order a pass is one expiry check and one claim. Needs migration `20270114090000`: run it before the API that has this job |
| `ABSENCE_WATCH_BACKGROUND` | `on` (default) or `off`: the 5-minute tick of Frånvarobevakning's nightly count. A school's night starts at 05:00 its local time, once a night, and only for a school whose administrator has turned the bevakning on (`/admin/absence-watch`; off for every school until then). The night counts the pupils over the school's limits as of yesterday and, on the first day after a whole week or month, writes the digest of each group that has a limit. Off, nothing is counted or sent and the findings already made stay |
| `REPORTING_RATE_BACKGROUND` | `on` (default) or `off`: the 5-minute tick of Rapporteringsgrad's nightly job. A school's night starts at 06:00 its local time, once a night, for every school with a lesson in the last 90 days (the count is not a switch; only the reminders and the weekly notice are, under `/admin/reporting-rate`). The night stores each teacher's held and reported lessons per day, tells the teachers of lessons that stood open past the school's limit (if the school turned that on) and, on Mondays, tells rektor and the full administrators the week's totals (likewise). **Off, this is the emergency brake:** nothing is counted, reminded or sent, the days already stored stay and the pages show them unchanged (they stop getting newer), and a teacher's list of open lessons, which reads the lessons live, still answers. A value that is neither `on` nor `off` is refused at start |
| `ACK_BACKGROUND` | `on` (default) or `off`: the quarter-hourly pass of Kvittens' reminders (`ack-reminders` in `JobRuns`). It reminds, once, each guardian who has not confirmed themself a request whose time the school chose has come, one request at a time and each in a transaction of its own; a school with kvittens off, or with no reminder time, has nothing for it to do. `off` stops every reminder in every school; the requests, the confirmations and the notices of a new request go on. The test setup turns it off. |

No `DIRECT_URL` here: that is the owner connection from step 2, and the API
never reads it. Keeping owner credentials out of the API's environment is the
point.

Verify: any request without a bearer token returns `401` in the RFC-7807
shape, e.g. `curl -i https://api.yourschool.example/api/v1/subjects -X POST`.

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
  180 minutes; the limit is on this school's post. The engine has no
  terms: a teacher with an autumn post and a spring post that never meet is
  read as one week, so the engine may pay for a stretch the gateway, which
  reads real weeks, does not see (it errs toward the stricter reading, never
  the looser). The engine clips a locked window to the school day, so a lock
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
  writes at most **10 requests an hour** and a school gets at most **20 000
  new receipts in 24 hours** (five requests to every guardian of a school of
  2 000 pupils, far more than a school needs; under four minutes of mail a day
  at most: 20 000 addresses, 49 to a mail, one mail every half second): the 11th request or the receipts past the day's are refused
  whole with 429 (`ACK_TOO_MANY_REQUESTS`, `ACK_TOO_MANY_RECIPIENTS`) by the
  database (triggers; the owner and the migrations are not counted, and the
  two limits take an advisory lock each, the sender's first and the school's
  then, so two requests at the limit do not both pass), and `POST
  /api/v1/acknowledgements` is throttled to five a minute besides. To change a
  number is a migration. The delivery has a second, **urgent lane** for the
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
  **Rollback of the code** is a revert; the tables stay and are unread. Rollback
  of the data, only if nothing in it is wanted: `BEGIN; DELETE FROM
  "Notifications" WHERE "type"::text IN ('ACK_REQUESTED', 'ACK_REMINDER');
  DELETE FROM "NotificationOptOuts" WHERE "type"::text IN ('ACK_REQUESTED',
  'ACK_REMINDER'); DROP TABLE "AckReceipts", "AckRequests", "AckSettings";
  DROP TYPE "AckRule", "AckReminderOutcome"; COMMIT;` and the two gallring functions restored to the bodies with the md5
  above. Count the notices first (`SELECT count(*) FROM "Notifications" WHERE
  "type"::text LIKE 'ACK\_%'`). What a rollback changes: nobody can ask or
  confirm, and the requests already made are gone.
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
  `20270118090000_schemavisaren_har_ett_lage_per_sort_och_en_publik` (or a later
  one that is not this); `prisma migrate status` lists exactly this migration
  as pending; `SELECT to_regprocedure('app.academic_year_lessons_go_first()'),
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
  **Rolling back** is `DROP TRIGGER "AcademicYears_a_lessons_go_first" ON
  "AcademicYears"; DROP FUNCTION app.academic_year_lessons_go_first();` and
  `prisma migrate resolve --rolled-back
  20270120090000_ett_lasars_lektioner_tas_bort_forst_pa_varje_vag`; do it
  together with rolling back the API, or the API before it is the one that
  deletes the lessons itself. What it changes: removing a year goes back to the
  keys' order and files the extra tombstones; nothing is lost.
  **The composite keys' ON UPDATE:** the same release adds RLS section 388,
  which fails the next composite key that holds a school and follows its parent
  when the parent is updated (`ON UPDATE CASCADE`; make it `NO ACTION`, as
  20270115090000 did for 38). 98 older ones are named in the section, and the
  list only gets shorter. No migration changes any of them: moving a parent to
  another school is not something any code path does, and the swap would take
  ACCESS EXCLUSIVE on `Users`, `StudentGroups` and the other parents together.

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
  `DIRECT_URL`, gives a demo school whose people have no login and which has
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
