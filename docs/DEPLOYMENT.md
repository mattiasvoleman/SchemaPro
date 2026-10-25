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
> for the mobile apps, which ship later as new store apps (§8.1). Until they
> do, the app on people's phones is still "SchemaPro", and no push or e-mail
> names an app. The repository, packages,
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
     med skolkonto" on `/<locale>/auth/callback`), and the app's
     `schemapro://auth/callback` (§11)
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
| `SOLVER_TIMEOUT_SECONDS` | `60` (raise for very large schools) |

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
| `AI_ENGINE_TIMEOUT_MS` | `90000` (must exceed the solver timeout) |
| `CANDIDATE_MAX_SECONDS` | optional, `5`–`120`, default `30`: Schemaförslag's solve budget for each candidate, the same for all of them so the emphases are compared at one budget (docs/verification-baseline.md). Each candidate call waits this plus 45 s (plus 20 s for the first call's probes), whatever `AI_ENGINE_TIMEOUT_MS` says |
| `CANDIDATE_SOLVER_WORKERS` | optional, `1`–`16`, default `4`: the solver workers a candidate solve uses, so a plain Generera beside it keeps the other cores |
| `CANDIDATE_RUNS_MAX` | optional, `1`–`10`, default `2`: candidate runs active across all schools at once; a start beyond it answers 409 `CANDIDATES_BUSY`. A run cut off by a redeploy while the engine was solving for it, or whose call timed out (cancelled or not), frees its year at once but keeps counting here until that solve could have ended (at most its call's timeout, about 1½ minutes at the defaults): the engine solves on once its caller stops waiting, whether the API restarted or only gave up on the call, and the engine's own 503 at its timeout does not stop the solve either. "Ta bort förslagen" hides such a run at once, and the sweep deletes its row after that |
| `THROTTLE_TTL_SECONDS` / `THROTTLE_LIMIT` | `60` / `120` |
| `PUBLIC_VIEWER_PROXY_KEY` | optional, at least 32 random characters, the **same value as on the web app**. Schemavisaren (`/v/<token>`) is fetched by the web server, so without it every family shares the web server's rate-limit bucket (120 a minute); with it the API trusts the viewer's address the web server forwards |
| `PUSH_NOTIFICATIONS` | `off` (the default, and what unset means) or `expo`. Off, push is inert: `GET /api/v1/push/config` answers `{enabled:false}`, the app never asks for permission, registration is refused (409 `PUSH_DISABLED`), no Expo request is made and no receipt is checked. Turn it on only as in §8.1 |
| `EXPO_ACCESS_TOKEN` | optional, at least 20 characters; sent as a Bearer to Expo only when set, which Expo requires once *enhanced push security* is on for the EAS project |
| `EXPO_PUSH_API_URL` | optional, `https` only; defaults to `https://exp.host/--/api/v2/push` |
| `INTEGRATION_SECRETS_KEY` | optional; base64 of exactly 32 random bytes (`openssl rand -base64 32`), kept in Railway's variables and nowhere else. The SS12000 source's credentials (client secret, static token, client key and certificate) are sealed with it (AES-256-GCM, bound to school, source, kind and the host they are sent to), and so are the integration keys' webhook signing secrets (bound to school and key, 20261014120000). Unset: an admin cannot save a credential or create a signing secret (503 `SS12000_SECRETS_NOT_CONFIGURED`), no sync runs, and no key can register a subscription. Losing it means every school re-enters its credentials and recreates its signing secrets; it never decrypts anything else |
| `INTEGRATION_SECRETS_KEY_PREVIOUS` | optional, same shape: the key before a rotation, which still decrypts and never encrypts. Rotate by moving the current key here, setting a new one, letting each school's admin save its credential again (or waiting for the next save), then clearing it |
| `SS12000_BACKGROUND` | `on` (default) or `off`: the 5-minute tick that runs scheduled syncs and marks stale and expired runs, and the 1-minute tick that delivers v2.0 subscription notices and purges old tombstones and delivery rows. A school's sync runs at night only once its admin turns the schedule on, and auto-applies only once the admin turns that on too; a notice goes out only once a consumer has registered a subscription |
| `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | recommended `15` (Railway's own default is `0`): the seconds between SIGTERM and SIGKILL when a deploy replaces the instance. On SIGTERM the API marks a Schemaförslag run that was solving as interrupted, stops taking requests, lets the ones in flight finish, and only then closes its database pool. With `0` it is killed before any of that: the run is left to its lease (about three minutes), and a request in flight is cut off as before |
| `CANDIDATES_BACKGROUND` | `on` (default) or `off`: the quarter-hourly sweep that marks abandoned candidate runs FAILED, deletes runs older than seven days, and deletes the emptied rows "Ta bort förslagen" left of runs whose engine call was still out, once that call could have ended. Every start in any school sweeps first, so off only delays those deletions |
| `GALLRING_BACKGROUND` | `on` (default) or `off`: the 5-minute tick of the nightly gallring. A school's run starts at 03:00 its local time, once a night, and only for the kinds its admin has given a period on `/admin/dataskydd`; a school that has decided nothing loses nothing |

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

## 8. Mobile app (teacher attendance)

The mobile app is distributed as a build, not a deployment:

```bash
cd mobile
npm install --legacy-peer-deps
cp .env.example .env.local   # EXPO_PUBLIC_API_BASE_URL, EXPO_PUBLIC_SUPABASE_URL,
                             # EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY
npx expo start               # development on a device via Expo Go*
npx eas build --platform all # store/TestFlight builds via EAS
```

\* Note: `expo-secure-store` and biometrics require a development build
(`npx expo run:ios` / `run:android`) rather than Expo Go.

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
2. **An EAS project and credentials**: FCM V1 credentials (Android) and an
   APNs key (iOS, a paid Apple developer account) uploaded to EAS.
3. **A new native build** of the app with `EXPO_PUBLIC_EAS_PROJECT_ID` set to
   the EAS project's id (the `expo-notifications` config plugin needs a new
   binary; remote push does not work in Expo Go on Android). Without the id
   the app reports push as unavailable and registers nothing. The same build
   carries the display name `mobile/app.json` gives it, today "SchemaPro"
   (it was "SchemaPro Teacher"); the slug, bundle identifier and Android
   package are unchanged, so it installs as an update of the existing app.
   The renamed apps, Rastra and Rastra vårdnadshavare, come later with new
   bundle identifiers (`se.rastra.app`, `se.rastra.vardnadshavare`). They are
   new store apps that people install beside the old one, each with its own
   FCM and APNs setup and its own push tokens, and this step is rewritten
   when they land. Until then no text the API sends names an app.
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
   record attendance for today's lesson. On mobile: sign in, open the
   schedule tab, take attendance in airplane mode, re-enable network and
   confirm the queue syncs (banner returns to *Connected*, records appear in
   the web view).
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
    (`NotificationOptOuts`), which never hold the two types, because this
    release refuses opting out of them (400).

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

## 11. School-account sign-in ("Logga in med skolkonto")

Staff sign in with the account they already have in their organisation's
Microsoft Entra ID or Google Workspace, on the web and in the app. Supabase
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
| `EXPO_PUBLIC_SCHOOL_ACCOUNTS=on` | app (build time) | Shows the button in the app. |

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
2. Deploy the API, the web and the app's JavaScript with the switches off.
   The Inloggning tab is visible to every school admin from the merge on, and
   says the feature is not turned on yet.
3. Turn the hook on (11.2), then set up the providers (11.3, 11.4) and the
   redirect URLs (11.5). With the providers on and the hook off, anyone
   invited could sign in with any matching school account and nothing would
   be pinned: **never enable a provider without the hook.**
4. Make a new native build of the app with `EXPO_PUBLIC_SCHOOL_ACCOUNTS=on`
   (`expo-web-browser` is a native module; the variable is in
   `mobile/.env.example`), publish it and wait until staff have updated.
   **Only then** go on: once the next step lets schools save, an admin can
   turn on *Kräv skolkonto för personal*, and an older app has no
   school-account button and cannot sign staff in at all once their
   password is refused. The switch's help text says so too. The older app
   itself still starts: the new JavaScript loads the module only when the
   button is used, and asks for an update if it is missing.
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

1. App registrations → New registration. Supported account types: *Accounts
   in any organizational directory (Any Microsoft Entra ID tenant —
   Multitenant)*, without personal Microsoft accounts. Redirect URI (Web):
   `https://<project-ref>.supabase.co/auth/v1/callback`.
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
2. Audience: *External* (several Workspaces sign in). Scopes: `openid`,
   `.../auth/userinfo.email`, `.../auth/userinfo.profile`; nothing sensitive,
   so no security assessment, but brand verification takes a few days.
3. Supabase dashboard → Authentication → Sign In / Providers → Google:
   enable, Client ID, Client Secret.
4. Per school: if its Workspace restricts third-party apps, the Workspace
   administrator trusts Rastra's client ID (Security → Access and data
   control → API controls). The school's admin saves the Workspace's primary
   domain (the `hd` Google sends) on Inloggning.

### 11.5 Redirect URLs

Authentication → URL Configuration → Redirect URLs must contain
`https://<web origin>/**` (or `/sv/auth/callback` and `/en/auth/callback`)
and `schemapro://auth/callback` for the app. A redirect that is not listed
fails at Auth, before any provider.

### 11.6 Verify (per school)

1. Invite a test member of staff with their real school address; do not open
   the invitation e-mail.
2. On /admin/integrations → Inloggning, save the provider, the domain and the
   organisation. The status reads *På*.
3. Sign out. On /login, type the address and choose *Logga in med skolkonto*.
   The provider's sign-in opens with the address filled in, and you land on
   the role's start page. Repeat once in the app.
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

**Accepted risk: the app's custom scheme.** The app comes back from the
provider on `schemapro://auth/callback`, and any app on the phone can
register that scheme. A malicious app installed on a teacher's phone could
start a school-account sign-in of its own with that redirect and receive the
result, and Entra may sign in silently through the shared browser session.
The fix is a claimed https redirect (Universal Links on iOS, verified App
Links on Android) on the web origin, which needs the app's signing identity
and an `apple-app-site-association` / `assetlinks.json` served by the web;
it is planned with the app's store release (roadmap, Appbygget). Until then
the risk is accepted: it needs a malicious app already installed on a staff
member's phone, and the 24-hour limit above bounds how long a stolen session
lasts.

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
    typecheck + e2e, web typecheck + build, solver pytest and mobile
    typecheck on every push/PR.
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
