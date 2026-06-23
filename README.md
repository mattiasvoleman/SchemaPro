# SchemaPro — Database Layer

Secure, multi-tenant PostgreSQL data layer for the AI-driven school scheduling &
attendance system. Built with **Prisma ORM** on top of **PostgreSQL** with native
**Row-Level Security (RLS)** enforced on every table.

## Design principles

These follow the non-negotiable constraints in `.cursorrules`:

- **Privacy by design (GDPR/PII).** Every primary and foreign key is an
  anonymized **UUIDv4** (`gen_random_uuid()`), so only opaque identifiers ever
  reach the Python AI engine. **PII lives exclusively on the `Users` table**
  (`firstName`, `lastName`, `email`, `phone`) and must be masked at the NestJS
  gateway before any data is sent to the optimizer or an external LLM.
- **Defense in depth.** RLS is enabled on **all 12 tables**. No application query
  can read or write rows outside the caller's school or role.
- **Performance.** Indexes are tuned for the hot path — date/time range scans of
  the calendar (`schoolId+date`, `studentGroupId+date`, `roomId+startsAt`, etc.).
- **No secrets in code.** Connection strings come from `process.env`
  (`DATABASE_URL`, `DIRECT_URL`). See `.env.example`.

## Data model

| Table | Purpose |
| --- | --- |
| `Schools` | Tenant root. Every other row carries a `schoolId`. |
| `Users` | Students, teachers and school admins (the only PII table). |
| `Rooms` | Physical rooms / resources. |
| `Subjects` | Subjects taught. |
| `AcademicYears` | Scheduling periods (terms / years). |
| `StudentGroups` | Classes / groups; a student's primary group. |
| `TeachingRequirements` | Curriculum demand (lessons/week per subject & group). |
| `MasterLessons` | Recurring weekly template produced by the AI engine. |
| `CalendarLessons` | Concrete dated lesson instances. |
| `CalendarLessonTeachers` | Teacher ↔ lesson assignment (co-teaching/substitutes). |
| `AttendanceRecords` | Per-student, per-lesson attendance. |
| `AvailabilityConstraints` | Hard/soft constraints consumed by OR-Tools. |

Every table is multi-tenant via a denormalized `schoolId`, which keeps RLS
policies uniform and index-friendly.

## Row-Level Security model

The migration creates helper functions and one set of policies per role.

### How the request context is established

The NestJS gateway must:

1. Connect to PostgreSQL as the least-privilege role **`app_authenticated`**
   (created by the migration) — never as a superuser or the table owner.
2. Open a transaction per request and inject the verified JWT payload:

```sql
SET LOCAL "request.jwt.claims" = '{"sub":"<authId>","role":"TEACHER"}';
```

Helper functions then resolve the caller:

- `auth.uid()` / `auth.role()` — read the raw JWT claims.
- `app.current_user_id()`, `app.current_school_id()`, `app.current_user_role()`,
  `app.current_user_group_id()` — `SECURITY DEFINER` lookups that authoritatively
  resolve the caller from the `Users` table (matching `Users.authId = auth.uid()`).

> RLS is intentionally **not** forced on the table owner so these
> `SECURITY DEFINER` helpers can resolve identity without recursive policy
> evaluation. Because the app connects as `app_authenticated` (a non-owner),
> every application query is still fully constrained by RLS.

### Policy summary

| Role | Access |
| --- | --- |
| **Student** | Reads **only their own** `Users` row, their own group's `StudentGroups` / `MasterLessons` / `CalendarLessons` (their schedule), and **only their own** `AttendanceRecords`. Read-only metadata (subjects, rooms) for rendering. |
| **Teacher** | Reads **all users and schedules within their own school**. May **insert/update attendance only for lessons they are assigned to** (checked via `CalendarLessonTeachers`). Manages their own availability constraints. |
| **School admin** | **Full read/write within their own school** on every table. |

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Configure secrets (never commit the real .env)
cp .env.example .env   # then fill in DATABASE_URL / DIRECT_URL

# 3. Apply the migration (creates tables, indexes, RLS, policies)
npm run migrate:deploy   # production
# or, during development:
npm run migrate:dev

# 4. Generate the typed Prisma client
npm run prisma:generate
```

## Useful scripts

| Script | Description |
| --- | --- |
| `npm run prisma:validate` | Validate the schema. |
| `npm run prisma:format` | Format the schema. |
| `npm run migrate:dev` | Create/apply a dev migration. |
| `npm run migrate:deploy` | Apply pending migrations (CI/prod). |
| `npm run migrate:status` | Show migration status. |
| `npm run studio` | Open Prisma Studio. |

## Files

- `prisma/schema.prisma` — full data model.
- `prisma/migrations/20260623120000_init/migration.sql` — DDL + RLS enablement +
  policies (the security layer requested for this milestone).
