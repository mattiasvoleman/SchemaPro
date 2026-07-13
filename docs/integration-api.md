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

Integration requests run outside user RLS (there is no user); tenant
isolation is enforced in code by scoping **every** query to the key's school
id, and keys are revocable at any time. Wire personnummer/civic numbers are
intentionally not accepted or stored.

## Positioning

`/activities` + `/calendarEvents` are the "lesson export" that lets SchemaPro
act as the scheduling engine feeding an existing Skola24/Vklass installation —
the adoption wedge from the parity roadmap.
