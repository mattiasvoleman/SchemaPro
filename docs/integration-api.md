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
| `GET /ss12000/v1/duties` | Duty (**SS12000 2.1.0 property names**) — one per teaching post of the active year | TeacherEmployments (active users), their MENTORSKAP TeacherDuties, StaffingPolicies (the opt-in) |

Field notes: `eduPersonPrincipalNames` carries the school email;
`personRole` is Elev/Lärare/Vårdnadshavare/Personal; `responsibles` /
`responsibleFor` mirror guardian links; activities/events carry `groupIds`
(primary + extra classes) and `studentIds` (individual participants).

### `/duties`: the one feed in the standard's own shape

The other feeds are SS12000-*inspired*: house field names (`groupIds`,
`teacherIds`) beside SS12000 resource names. `/duties` is the first that
emits the standard's own object. Every property is checked against **SIS
TK450, SS12000 OpenAPI 3.0, `info.version` 2.1.0** (korrigendum augusti 2022),
`components.schemas.Duty`,
<https://www.sis.se/globalassets/standardutveckling/tksidor/tk-450/openapi_ss12000_version2_1_0.yaml>,
retrieved 2026-10-09; the SIS page lists no newer YAML. A contract test
(`src/integration/ss12000-duties.contract.spec.ts`) fails on any key the 2.1.0
schemas do not define, at any depth.

| 2.1.0 property | Required | Emitted | Source |
|---|---|---|---|
| `id` | yes | always | the post's id (`TeacherEmployments.id`) |
| `meta` `{created, modified}` | yes | always | the post's `createdAt`; `modified` = the latest `updatedAt` of the post and its mentorships (best effort: a deleted mentorship does not move it) |
| `person` `{id}` | — | always | the teacher's `Users.id`, the id `/persons` uses |
| `assignmentRole[]` `{group, assignmentRoleType, startDate, endDate}` | — | when the teacher has a MENTORSKAP uppdrag on a class of the active year | `{group: {id}, assignmentRoleType: "Mentor"}`, dated with the läsår. Other uppdrag kinds have no `AssignmentRoleType` value and are left out; the standard says teaching is not an assignment |
| `dutyAt` `{id}` | yes | always | the school's id, the Skolenhet `/organisation` returns |
| `dutyRole` | yes | always `"Lärare"` | a post here is a teaching post; Förstelärare is an uppdrag inside it, not a Duty |
| `description` | — | never | no source |
| `signature` | — | when set | `TeacherEmployments.signature` |
| `dutyPercent` (integer) | — | **only with the opt-in** | `round(employmentPercent)` |
| `hoursPerYear` (integer) | — | **only with the opt-in, ferietjänst only** | `round(StaffingPolicies.fullTimeAnnualHours × employmentPercent / 100)` |
| `startDate` | yes | always | the active läsår's start |
| `endDate` | — | always | the active läsår's end |

Deviations from the standard, stated: paging is the house's
`{totalCount, limit, offset, data}` ordered by the post's id, not `pageToken`;
no `expand`, `expandReferenceNames` or filters (no `modifiedAfter`: `meta.modified`
is best effort). `startDate`/`endDate` mean "employment at the skolenhet" in
the standard; SchemaPro holds no employment date, so the läsår's bounds are
sent, and a teacher gets a **new Duty id every läsår** (posts are per year).

**The opt-in.** `dutyPercent` and `hoursPerYear` are standard fields, but a
school's keys are often held by systems that need nobody's tjänstgöringsgrad,
so they appear only when an admin turns on *Dela tjänstgöringsgrad och
årsarbetstid med integrationer* (`StaffingPolicies.shareEmploymentWithIntegrations`,
default off). `hoursPerYear` comes from the post, never from post −
nedsättning: with `dutyPercent` beside it the difference would publish the
nedsättning. **Never emitted**, whatever the switch: the nedsättning, the
avtalsform, the teacher's own riktmärke, the note and the behörigheter — the
feed's query does not select them.

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
(SELECT) and `integration_keys_service_touch` (UPDATE): non-revoked rows of
`IntegrationApiKeys`, and no other table. A revoked key is invisible to the
lookup, so revocation takes effect on the next request. The guard's UPDATE
writes only `lastUsedAt`, but the policy does not hold it there: it names no
column and no school, and its `WITH CHECK` asks only that the key stay
unrevoked. Inside the lookup a statement can rewrite any column of any
school's live key, `schoolId` and `keyHash` included; only revoking one is
refused. The school id comes from the key row, never from request input.

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
| `TeacherEmployments`, `TeacherDuties` | SELECT — what `/duties` reads (`20261006100000`, `20261007090000`); the query names only the Duty's columns |
| `StaffingPolicies` | SELECT — the `/duties` opt-in and `fullTimeAnnualHours`: the school's configuration, no person's data (`20261010110000`) |

Each write policy has a `WITH CHECK` on the same school, so a write can
neither create a row in another school nor move one there. There is no INSERT
on `Users` (unknown emails come back in `needsProvisioning`) and no DELETE
policy on any table. The `Users` policy scopes rows, not columns; the import
writes `firstName`, `lastName` and `studentGroupId`, and Prisma adds
`updatedAt` to every such UPDATE. A guardian link also has composite foreign
keys to `Users (id, schoolId)` on both sides, so its guardian and its student
belong to the link's school whoever writes it.

No other table has a service-principal policy. Every such table but one reads
as empty to the principal rather than refusing it, since `authenticated` holds
it and row-level security filters out every row: `IntegrationApiKeys` once the
key is resolved, `RoomTypes` and `LunchSettings` among them. That is how both
feeds broke before `20260914150000`. The seven
tables in the third row had no policy, so a lesson's required `subject` came
back missing and `/activities` and `/calendarEvents` answered 500 for any
school with a lesson. With only `Subjects` and `Rooms` readable they answered
200 instead: lessons with no named pupils and no extra classes, and dated
lessons with no teachers either. A relation added to a feed's `select` needs
its table in this list and in section 3 of the suite below. The feeds read
teachers and pupils as id columns, so `Users` needs no more than it has.

`TeacherEmploymentLogs` (a tjänst's history, staffing Fas 3) has no
service-principal policy on purpose and reads as empty to it; the RLS suite's
section 7h asserts that, and that the principal reads its own school's policy
row and no other school's.

The one that refuses it is `_prisma_migrations`, Prisma's migration history,
which holds no school data. Until `20260914180000` it was the one table in `public` without
row-level security, `authenticated` held SELECT, INSERT, UPDATE and DELETE on
it, and every `app_authenticated` connection, the service principal included,
read all of its rows and could delete them. That migration revoked every
privilege on it from `anon`, `authenticated`, `service_role` and
`app_authenticated`, and switched row-level security on with no policy. The
principal and every other API role are now refused with "permission denied";
only the role that runs the migrations, which owns the table, reaches it.

**Asserted against Postgres.** `scripts/test/rls-policies.sql` runs as
`app_authenticated`. Section 2: the key-lookup principal sees API keys, but no
users, no schools and no revoked key. Section 3: the service principal sees
exactly one school, its own users and no other school's on a query without a
tenant filter, and no API keys; and in `AcademicYears`, `StudentGroups`,
`GuardianStudents`, `MasterLessons`, `CalendarLessons` and the seven tables in
the third row, its own school's rows and none of another's. The fixtures plant
rows in each of those tables in both schools, and in each link table a row
filed under the second school but attached to the first school's lesson, which
the first school's principal must not see. The runner refuses to start when any
of them is missing. Section 4: neither
setting survives COMMIT. Sections 5 and 6: it sees no `RoomTypes` and no
`LunchSettings`. Section 14: `_prisma_migrations` refuses this role a read and
a DELETE with no principal, as the service principal and as the key lookup,
and no API role holds any privilege on it. The write policies' `WITH CHECK`
clauses are not asserted there.

Section 4b runs both principals on a connection where an earlier transaction
set user claims, as a pooled connection has after any user request. PostgreSQL
leaves that setting reading `''` after COMMIT, not unset. The plain-PostgreSQL
fallback `auth.uid()` raised on `''` until `20260914230000`, and every policy
calling `app.current_school_id()` raised with it, so both helpers answered 500
there. Supabase's own `auth.uid()` reads `''` as no user, and that migration
leaves it untouched.

Wire personnummer/civic numbers are intentionally not accepted or stored.

## Positioning

`/activities` + `/calendarEvents` are the "lesson export" that lets SchemaPro
act as the scheduling engine feeding an existing Skola24/Vklass installation —
the adoption wedge from the parity roadmap.
