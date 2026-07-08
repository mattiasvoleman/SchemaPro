# SchemaPro

AI-driven school scheduling & attendance platform. A school admin sets up the
catalog (subjects, rooms, groups, teachers), defines the curriculum demand and
availability constraints, and lets a CP-SAT solver generate a conflict-free
master timetable — which is then published into a dated calendar that powers
teacher/student schedule views and offline-first attendance tracking.

## Architecture

```
┌──────────────┐   reads (RLS)    ┌────────────────────┐
│  Next.js web │─────────────────▶│                    │
│  (sv/en)     │   mutations      │  Supabase Postgres │
└──────┬───────┘        │         │  (RLS on all       │
       │                ▼         │   12 tables)       │
┌──────────────┐   ┌─────────┐    │                    │
│ Expo mobile  │──▶│ NestJS  │───▶└────────────────────┘
│ (attendance) │   │ gateway │ Prisma withRls()
└──────────────┘   └────┬────┘
     reads (RLS)        │ anonymized payloads only (no PII)
                        ▼
                   ┌──────────┐
                   │ FastAPI  │
                   │ OR-Tools │
                   └──────────┘
```

- **Web** (`web/`): Next.js 16 App Router, TypeScript, Tailwind, Radix/CVA
  design system, next-intl (Swedish + English), TanStack Query, dark mode.
  Role-based areas for admins, teachers and students.
- **API** (`src/`): NestJS gateway. Verifies Supabase JWTs, resolves the app
  role from the `Users` table, and runs every query inside
  `PrismaService.withRls()` so PostgreSQL RLS is enforced end-to-end. Also the
  PII-masking proxy in front of the AI engine.
- **AI engine** (`optimization-engine/`): Python FastAPI + Google OR-Tools
  CP-SAT solver. Receives **only anonymized UUIDs and numbers** — never names,
  emails or free text. Returns a weekly plan plus a conflict analysis.
- **Mobile** (`mobile/`): Expo/React Native teacher app. Supabase sign-in,
  tokens in `expo-secure-store`, offline attendance queue in local SQLite with
  exponential-backoff sync, read-only schedule tab.
- **Database** (`prisma/`): 12-table multi-tenant schema; RLS enabled on every
  table (see “Security model” below).

## The core workflow

1. **Setup** — admin walks through the setup wizard: academic year → subjects
   → rooms → groups → people (`/admin/setup`). Users are invited via the
   Supabase Admin API and land on a set-password page.
2. **Demand & constraints** — teaching requirements matrix (lessons/week per
   group × subject) and availability constraints (weekly or date-specific,
   hard or soft) (`/admin/requirements`, `/admin/constraints`).
3. **Generate** — `/admin/generate` starts an optimization job
   (`POST /api/v1/optimization/jobs`). The gateway anonymizes the data, calls
   the solver, writes `MasterLessons` back, and the UI polls job status. If the
   model is infeasible, the solver's conflict report explains why.
4. **Review & publish** — `/admin/timetable` shows the master timetable per
   group/teacher. Clicking a lesson opens an adjust dialog (day, time, room,
   teacher) validated against the rest of the timetable
   (`PATCH /api/v1/master-lessons/:id`); future published lessons move along.
   Publishing (`POST /api/v1/calendar/publish`) materializes dated
   `CalendarLessons` for the term — idempotently, skipping full-day group
   closures.
5. **Daily use** — teachers and students see their week (`/teacher`,
   `/student`); teachers record attendance on web or mobile (offline-safe,
   idempotent `POST /api/v1/attendance/report`); students see their own
   attendance history.
6. **Operations** — the **Day planner** (`/admin/lessons`) cancels/reinstates
   lessons and assigns substitute teachers per lesson; changes are pushed
   live over WebSocket (`calendar_lesson_updated`) to affected teachers.
   **Reports** (`/admin/reports`) shows attendance rates per class/student
   with CSV export.

Want demo data? `npm run db:seed` (with owner credentials in `DIRECT_URL`)
creates a complete demo school ready for schedule generation.

> Deploying to production? Follow the step-by-step runbook in
> [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## Getting started

### Prerequisites

- Node.js 20+, npm
- A [Supabase](https://supabase.com) project (Auth + Postgres)
- Python 3.11+ (for the AI engine)

### 1. Database + API

```bash
npm install
cp .env.example .env       # fill in Supabase connection strings + JWT secret
npm run migrate:deploy     # tables, indexes, RLS, policies
npm run prisma:generate
npm run dev:api            # http://localhost:4000
```

The API must connect as the least-privilege `app_authenticated` role (a member
of `authenticated`, not the table owner) so RLS applies to every query.

### 2. AI engine

```bash
cd optimization-engine
pip install -r requirements.txt
API_KEY=local-dev-shared-key uvicorn app.main:app --port 8000
```

Set the same key as `AI_ENGINE_API_KEY` in the root `.env`.

### 3. Web

```bash
cd web
npm install
cp .env.example .env.local  # Supabase URL + publishable key, API base URL
npm run dev                 # http://localhost:3000
```

### 4. Mobile

```bash
cd mobile
npm install --legacy-peer-deps
cp .env.example .env.local  # API base URL + Supabase URL/key
npm start
```

### Docker (Postgres + API + solver)

```bash
JWT_SECRET=<your-supabase-jwt-secret> docker compose up --build
```

Boots Postgres (with RLS roles bootstrapped), applies migrations, and starts
the API on `:4000` and the solver on `:8000`.

## Bootstrapping the first admin

Migrations create the schema but no data. Create a `Schools` row, sign up a
user through Supabase Auth, then insert a `Users` row with `role =
'SCHOOL_ADMIN'` and `authId` set to the Supabase `auth.users.id`. From there,
everything else happens in the web UI.

## Security model

Follows the non-negotiable constraints in `.cursorrules`:

- **Privacy by design.** All keys are anonymized UUIDv4. PII lives exclusively
  on `Users` and is stripped at the gateway — the AI engine and any external
  service only ever see fresh, per-request anonymous ids.
- **RLS everywhere.** All 12 tables have row-level security: students see
  their own data and their group's schedule; teachers see their school and may
  write attendance only for lessons they are assigned to; admins are scoped to
  their school. Clients read directly from Supabase under RLS; mutations go
  through the NestJS gateway, which sets the JWT claims on the transaction via
  `withRls()` so the same policies apply.
- **Secrets via environment only.** See `.env.example` in the root, `web/`
  and `mobile/`. The Supabase service-role key (used solely for user
  invitations) never leaves the server.
- **Mobile safety.** Tokens in `expo-secure-store` (chunked keychain storage,
  `WHEN_UNLOCKED_THIS_DEVICE_ONLY`); attendance queues offline in SQLite and
  syncs idempotently with exponential backoff.

## Testing

| Suite | Command | Notes |
| --- | --- | --- |
| API e2e (Jest + supertest) | `npm run test:e2e` | Boots the real Nest app with a mocked database — no Postgres needed. Covers attendance ingestion, CRUD, RBAC and validation. |
| Web smoke (Playwright) | `cd web && npx playwright test` | Starts the dev server; exercises locale routing, auth gating and the login form. Run `npx playwright install chromium` once first. |
| Solver (pytest) | `npm run test:engine` | The full CP-SAT suite. |

## Repository layout

```
├── src/                  # NestJS gateway (auth, CRUD, calendar, optimization proxy, attendance)
├── prisma/               # Schema + migrations (RLS policies live here)
├── web/                  # Next.js app (admin/teacher/student UIs, sv+en)
├── mobile/               # Expo teacher app (offline attendance, schedule)
├── optimization-engine/  # FastAPI + OR-Tools CP-SAT solver
├── test/                 # API e2e tests
├── docker-compose.yml    # Postgres + API + solver
└── scripts/db-init/      # Local-dev role bootstrap (app_authenticated)
```
