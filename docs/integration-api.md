# SchemaPro integration API (SS12000-inspired)

External systems (Vklass, IST, StudyBee, municipal registries) integrate via a
REST API modeled on **SS12000:2020** naming and resources. It is intentionally
a pragmatic subset — the mapping below is the contract.

## Authentication

Every request carries `X-API-Key: sp_…`. Keys are created per school in
**Admin → Integrations** (plaintext shown once; SHA-256 stored). A key scopes
every request to exactly one school. Rate limit: 120 req/min (imports 10/min).

```bash
curl -H "X-API-Key: sp_..." https://<host>/ss12000/v1/persons?limit=100
```

Paginated responses: `{ totalCount, limit, offset, data: [...] }` with
`?limit=` (≤500, default 100) and `?offset=`.

## Read endpoints

| Endpoint | SS12000 resource | Source |
|---|---|---|
| `GET /ss12000/v1/organisation` | Organisation (Skolenhet) | School |
| `GET /ss12000/v1/persons[?role=STUDENT\|TEACHER\|GUARDIAN\|SCHOOL_ADMIN]` | Person incl. enrolments + responsibles | Users, GuardianStudents |
| `GET /ss12000/v1/groups` | Group (groupType Klass) incl. memberships | StudentGroups |
| `GET /ss12000/v1/activities` | Activity (Undervisning) — weekly template | MasterLessons (active year), incl. co-teacher, extra classes, individual participants |
| `GET /ss12000/v1/calendarEvents?from=YYYY-MM-DD&to=YYYY-MM-DD` | CalendarEvent — dated lessons (**lesson export**) | CalendarLessons incl. cancelled flag, room, teacher assignments, participants |

Field notes: `eduPersonPrincipalNames` carries the school email;
`personRole` is Elev/Lärare/Vårdnadshavare/Personal; `responsibles` /
`responsibleFor` mirror guardian links; activities/events carry `groupIds`
(primary + extra classes) and `studentIds` (individual participants).

## Import (roster sync)

`POST /ss12000/v1/import/persons` with
`{ "persons": [{ "givenName", "familyName", "email", "groupDisplayName", "responsibleEmails": [] }] }`
(max 2000/call).

Semantics — **update-only for identity safety**: persons are matched by email
within the school; names, class membership (classes auto-created in the
active year) and guardian links are synced. Unknown emails are returned in
`needsProvisioning` — create those accounts in **Admin → People** (Supabase
identity provisioning stays an explicit admin action). Response:
`{ updated, groupsCreated, guardianLinks, needsProvisioning }`.

## Security model

**A key resolves to one school.** `IntegrationKeyGuard` hashes the
`X-API-Key` (SHA-256) and looks the hash up inside
`PrismaService.withServiceKeyLookup`. That lookup is the one step that cannot
be tenant-scoped — the tenant is what it resolves — so the transaction sets
`app.service_key_lookup` and matches only `integration_keys_service_lookup`
(SELECT) and `integration_keys_service_touch` (UPDATE, for `lastUsedAt`):
non-revoked rows of `IntegrationApiKeys`, and no other table. A revoked key is
invisible to the lookup, so revocation takes effect on the next request. The
school id comes from the key row, never from request input.

**The service principal is tenant-scoped in the database.** There is no user,
but integration requests do not run outside RLS: the API connects as
`app_authenticated`, a non-owner role, so policies apply to every statement.
Every `Ss12000Service` method runs inside
`PrismaService.withServicePrincipal(schoolId, …)`, which sets
`app.service_school_id` with `set_config(…, true)`. The setting is
transaction-local, so it cannot outlive the transaction on a pooled
connection. The service-principal policies
(`prisma/migrations/20260806010000_service_principal_policies` and
`20260914150000_integrationen_ser_vad_en_lektion_ar_gjord_av`) compare each
row's school with that setting, which confines every statement to the key's
school. The service's own `where: { schoolId }` clauses are defence in depth,
not the boundary: a query that forgets one sees nothing from another school
instead of leaking it.

What the principal is granted, always on the key's school only:

| Table | Access |
|---|---|
| `Schools` | SELECT — its own row, matched on `id` |
| `AcademicYears`, `MasterLessons`, `CalendarLessons` | SELECT |
| `Subjects`, `Rooms`, `MasterLessonGroups`, `MasterLessonStudents`, `CalendarLessonTeachers`, `CalendarLessonGroups`, `CalendarLessonStudents` | SELECT — what `/activities` and `/calendarEvents` read a lesson through |
| `Users` | SELECT, UPDATE |
| `StudentGroups` | SELECT, INSERT |
| `GuardianStudents` | SELECT, INSERT, UPDATE — the import upserts links |

Each write policy has a `WITH CHECK` on the same school, so a write can
neither create a row in another school nor move one there. There is no INSERT
on `Users` (unknown emails come back in `needsProvisioning`) and no DELETE on
any table. The `Users` policy scopes rows, not columns; the import writes only
`firstName`, `lastName` and `studentGroupId`. A guardian link also has
composite foreign keys to `Users (id, schoolId)` on both sides, so its
guardian and its student belong to the link's school whoever writes it.

No other table has a service-principal policy, and such a table reads as
empty to the principal rather than refusing it: `IntegrationApiKeys` once the
key is resolved, `RoomTypes` and `LunchSettings` among them. That is how both
feeds broke before `20260914150000`. The seven tables in the third row had no
policy, so a lesson's required `subject` came back missing and `/activities`
and `/calendarEvents` answered 500 for any school with a lesson. With only
`Subjects` and `Rooms` readable they answered 200 instead: lessons with no
named pupils and no extra classes, and dated lessons with no teachers either.
A relation added to a feed's `select` needs its
table in this list. The feeds read teachers and pupils as id columns, so
`Users` needs no more than it has.

**Asserted against Postgres.** `scripts/test/rls-policies.sql` runs as
`app_authenticated`. Section 2: the key-lookup principal sees API keys, but no
users, no schools and no revoked key. Section 3: the service principal sees
exactly one school and its own users, no other school's users or student
groups on a query without a tenant filter, and no API keys; and in
`MasterLessons`, `CalendarLessons` and the seven tables in the third row, its
own school's rows and none of another's. The fixtures plant a lesson with a
row in each of those tables in both schools, and the runner refuses to start
when the other school has none. Section 4: neither
setting survives COMMIT. Sections 5 and 6: it sees no `RoomTypes` and no
`LunchSettings`. The write policies' `WITH CHECK` clauses are not asserted
there.

Wire personnummer/civic numbers are intentionally not accepted or stored.

## Positioning

`/activities` + `/calendarEvents` are the "lesson export" that lets SchemaPro
act as the scheduling engine feeding an existing Skola24/Vklass installation —
the adoption wedge from the parity roadmap.
