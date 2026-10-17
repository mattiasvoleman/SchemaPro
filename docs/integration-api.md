# SchemaPro integration API (SS12000)

External systems (Vklass, IST, StudyBee, municipal registries) integrate in
two ways. `/ss12000/v1` is a REST API modeled on **SS12000:2020** naming and
resources, a pragmatic subset whose mapping below is the contract.
`/ss12000/v2.0` is SS12000 2.1 in the standard's own shape (SIS OpenAPI
2.1.0). SchemaPro also pulls the roster from an SS12000 source (the consumer,
further down).

## Authentication

Every request carries `X-API-Key: sp_…`. Keys are created per school in
**Admin → Integrations** (plaintext shown once; SHA-256 stored). A key scopes
every request to exactly one school. Rate limit: 120 req/min (imports 10/min).
`/ss12000/v1` needs the key's scope `ss12000.v1` (the import
`ss12000.v1.import`). Every key that existed before scopes holds both. The
standard-shaped provider is `/ss12000/v2.0` (below).

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
| `GET /ss12000/v1/duties` | Duty (**SS12000 2.1.0 property names**) — one per teaching post of the active year, one per stretch of its grad for a post that changes during the year (with the opt-in) | TeacherEmployments (active users), their TeacherEmploymentPeriods (with the opt-in), their MENTORSKAP TeacherDuties, StaffingPolicies (the opt-in) |

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
| `id` | yes | always | the post's id (`TeacherEmployments.id`); a later stretch of a changing post has its own (below) |
| `meta` `{created, modified}` | yes | always | the post's `createdAt`; `modified` = the latest `updatedAt` of the post and its mentorships (best effort: a deleted mentorship does not move it; and it moves when a field this feed never sends changes — see below) |
| `person` `{id}` | — | always | the teacher's `Users.id`, the id `/persons` uses |
| `assignmentRole[]` `{group, assignmentRoleType, startDate, endDate}` | — | when the teacher has a MENTORSKAP uppdrag on a class of the active year | `{group: {id}, assignmentRoleType: "Mentor"}`, dated with the läsår. Other uppdrag kinds have no `AssignmentRoleType` value and are left out; the standard says teaching is not an assignment |
| `dutyAt` `{id}` | yes | always | the school's id, the Skolenhet `/organisation` returns |
| `dutyRole` | yes | always `"Lärare"` | a post here is a teaching post; Förstelärare is an uppdrag inside it, not a Duty |
| `description` | — | never | no source |
| `signature` | — | when set | `TeacherEmployments.signature` |
| `dutyPercent` (integer) | — | **only with the opt-in** | `round(employmentPercent)` |
| `hoursPerYear` (integer) | — | **only with the opt-in, ferietjänst only** | `round(StaffingPolicies.fullTimeAnnualHours × employmentPercent / 100)` |
| `startDate` | yes | always | the active läsår's start; a stretch's first day |
| `endDate` | — | always | the active läsår's end; a stretch's last day |

Deviations from the standard, stated: paging is the house's
`{totalCount, limit, offset, data}` ordered by the post's id, not `pageToken`;
no `expand`, `expandReferenceNames` or filters (no `modifiedAfter`: `meta.modified`
is best effort). `startDate`/`endDate` mean "employment at the skolenhet" in
the standard; SchemaPro holds no employment date, so the läsår's bounds are
sent, and a teacher gets a **new Duty id every läsår** (posts are per year).

**A post that changes during the year** (`TeacherEmploymentPeriods`,
20261022120000) is, **with the opt-in**, one Duty per stretch of the year in
which its grad stays the same whole percent: "50 % from 11 January" is the
autumn's Duty and the spring's, each with its own `dutyPercent`,
`hoursPerYear` (of its grad), `startDate` and `endDate`, and its mentorships
clipped to those dates. Every day of the läsår is in exactly one of them.
`meta.created` is the post's; `meta.modified` is the latest of the post's,
its periods' and its mentorships'. The first stretch keeps the post's id, so
a reference to the post's Duty still resolves. Every other stretch has an
id SchemaPro derives from its first day and a value of the post that no
integration ever gets: the same for as long as the stretch starts on that day,
so a period no Duty shows names nothing and moves no id, and not one a
reader can compute, so a stretch that is buried says nothing of when the
grad changed. A period that changes only the
nedsättning or the riktmärke splits nothing: the Duty carries neither, and
its dates would publish when they changed. Nor does a grad that rounds to
the same whole percent: `dutyPercent` is an integer, and the stretch keeps
its first part's grad, which its `hoursPerYear` is computed from. Without the opt-in, a post is one Duty for
the läsår whatever its periods, and no period is read. With the opt-in and
periods, a page counts Duties, not posts, ordered by the post's id and then
by date. A school with no periods pages exactly as before.

**The opt-in.** `dutyPercent` and `hoursPerYear` are standard fields, but a
school's keys are often held by systems that need nobody's tjänstgöringsgrad,
so they appear only when an admin turns on *Dela tjänstgöringsgrad och
årsarbetstid med integrationer* (`StaffingPolicies.shareEmploymentWithIntegrations`,
default off). `hoursPerYear` comes from the post, never from post −
nedsättning: with `dutyPercent` beside it the difference would publish the
nedsättning. **Never emitted as values**, whatever the switch: the
nedsättning, the avtalsform, the teacher's own riktmärke, the note and the
behörigheter — the feed's query does not select them.

What a reader can still **infer**, stated so a school can decide on the
switch knowing it:

* **The avtalsform, with the switch on.** `hoursPerYear` is sent for a
  ferietjänst only. When the school's policy has an annual-hours figure, a
  Duty that carries `dutyPercent` but no `hoursPerYear` is a semestertjänst.
  With the switch off neither field is sent and nothing can be told apart.
* **That a hidden field changed, and when — never to what.** `meta.modified`
  is the post's `updatedAt`, which moves on every save of the post: a changed
  nedsättning, riktmärke, note, avtalsform or number of teaching days a week
  (deltid in days, which the feed never sends) moves it while every field the
  feed sends stays the same. For a post split into stretches it is also the
  latest `updatedAt` of the post's periods, which moves the same way. A system
  polling the feed can see that something it is not shown changed on that
  teacher's post at that time. SchemaPro has
  no per-column timestamp to narrow it to the sent fields; the post's own
  version history (TeacherEmploymentLogs) is deliberately not readable by the
  service principal.

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

## SS12000 2.1 (v2.0): the provider

`/ss12000/v2.0` implements **SIS TK450, *SS12000 OpenAPI 3.0*,
`openapi_ss12000_version2_1_0.yaml`, `info.version` 2.1.0 (korrigendum
augusti 2022)**, sha256
`aee9a95a4c5bd25cebaf357d266592f94e9388ae785ee9ac3b58e1992acccd28`
(<https://www.sis.se/globalassets/standardutveckling/tksidor/tk-450/openapi_ss12000_version2_1_0.yaml>,
retrieved 2026-10-10; the SIS page lists 2.0.0 and 2.1.0 only). Below we call
it S1. The server path mirrors S1's `servers.url` (`…/v2.0`) and IST's layout,
so a consumer configured for an IST source appends the same resource paths to
`https://<host>/ss12000/v2.0`. `/ss12000/v1` is unchanged beside it.

Every schema and parameter the provider uses is generated from that file into
`src/integration/ss12000-v2/s1-provider.generated.ts`
(`scripts/ss12000/generate-s1-provider.cjs`). The contract spec walks every
object the provider emits against it.

### Authentication, scopes and limits

S1's only security scheme is `BearerAuth` (http, bearer). The integration key
is that bearer: `Authorization: Bearer sp_…`. `X-API-Key: sp_…` is also
accepted. A key resolves to one school. A missing, malformed or revoked key
answers **401** `{code: "UNAUTHENTICATED", …}` with `WWW-Authenticate: Bearer`;
S1 has no 401, so this is SchemaPro's extension.

Each key has **scopes** (`IntegrationApiKeys.scopes`, migration
`20261014120000`):

| Scope | Grants |
|---|---|
| `ss12000.v1` | `/ss12000/v1` (the house-shaped feeds above) |
| `ss12000.v1.import` | `POST /ss12000/v1/import/persons` |
| `organisations.read` | `/organisations*` |
| `persons.read` | `/persons*`: pupils and staff |
| `responsibles.read` | guardians in `/persons`, every `responsibles[]`, `expand=responsibleFor`. Without it guardians and their links do not exist for the key |
| `groups.read` | `/groups*`; `expand=groupMemberships` on persons |
| `duties.read` | `/duties*`; `expand=duties`, `expand=teachers`, `expand=assignmentRoles` |
| `activities.read` | `/activities*`; `expand=activity` on calendar events |
| `calendarEvents.read` | `/calendarEvents*` |
| `rooms.read` | `/rooms*` |
| `syllabuses.read` | `/syllabuses*`; `expand=syllabus` |
| `subscriptions.write` | `/subscriptions*` |
| `attendances.read` | `/attendances*`; `expand=attendance` on calendar events. **Only at a school that has decided to share attendance** (see "Attendances and Absences") |
| `absences.read` | `/absences*`. **Only at a school that has decided to share attendance** |

**Every key that existed before scopes holds `ss12000.v1` and
`ss12000.v1.import`.** That is the column's default, so v1 behaves exactly as
before for them. A key created without a choice gets the same. A new key can
be read-only (v1 without the import) or v2-only. A v1 route whose scope the
key lacks answers 403 in the house's body. A v2 resource, expand or
subscription whose scope it lacks answers 403 `SCOPE_MISSING`.

`expandReferenceNames=true` fills `displayName` only on references whose
resource the key may read. A person's name needs `persons.read` (and a
guardian's also `responsibles.read`), a group's needs `groups.read`, and so on.
A `groups.read`-only key therefore never learns a pupil's name through a
group's memberships.

Limits: 120 requests a minute **per key**, not per address, so one consumer
address serving many schools does not share one bucket. Per address, only
attempts that **fail** to authenticate count (no key, a malformed, unknown or
revoked one): past 600 a minute that address is refused before any lookup
until the minute passes. A request with a valid key never counts toward the
address. Past either limit the answer is 429 `TOO_MANY_REQUESTS` with
`Retry-After`.

### Paging, filters, meta and errors

* **Paging (S1 `limit`/`pageToken`).** Each list answers `{data, pageToken}`.
  `pageToken: null` means there is nothing more. `limit` is optional; when it
  is omitted the server picks 500, and it never goes above 1000. The token is
  opaque and bound to the key and the operation. It carries every parameter of
  the first request. S1 says a token "kan inte kombineras med andra filter men
  väl med `limit`". Generated clients always resend required parameters, so
  another parameter on a token request is accepted only if it equals the
  token's value. Anything else is 400 `INVALID_PAGE_TOKEN`. That is how
  `/calendarEvents` page 2 works with or without the window repeated.
* **Order.** Without `sortkey`, objects come by id. Every sortkey breaks ties
  by id, so a walk neither skips nor repeats an object that does not change
  during it. `ModifiedDesc` can skip or repeat an object that is modified
  mid-walk, which is inherent in sorting by a value that moves.
* **Filters.** Every parameter S1 defines for an operation is accepted. A
  filter on an attribute SchemaPro never holds (`civicNo`, `identifier.*`,
  `eduPersonPrincipalName`, `organisationCode`, `municipalityCode`, `parent`,
  the placement relationship types, the `civicNos` of a lookup) answers an
  empty page, which is true. A parameter S1 does not define, or a value that
  is not what S1's schema says, is 400 `INVALID_FILTER`. A sortkey on a field
  SchemaPro never holds (`CivicNo*`, `SubjectCode*`, `Course*`) is 400
  `SORTKEY_NOT_SUPPORTED`. Arrays are repeated parameters
  (`?groupType=Klass&groupType=Undervisning`). Date filters on a value that is
  not set always include the object, as S1's endDate filters say.
* **meta.** `created` is the row's creation. `modified` comes from
  `Ss12000EntityVersions` (migration `20261014130000`). Statement-level triggers
  move it exactly when an attribute the object **directly** carries changes,
  as S1's Meta definition requires. That includes list attributes (a class's
  memberships, a pupil's enrolments and responsibles) and an emitted id
  changing under the object. A phone number, an invitation or a nedsättning
  moves nothing. An object unchanged since the migration is dated by its own
  `updatedAt`.
* **Errors.** S1's `Error {code, message}`. A 404 has no body. 400 codes are
  `INVALID_FILTER`, `INVALID_ID`, `INVALID_PAGE_TOKEN`,
  `SORTKEY_NOT_SUPPORTED` and `INVALID_BODY`. 403 is `SCOPE_MISSING`, or
  `NOT_SHARED` for reading attendance and absence at a school that does not
  share them. 503 `TOO_LARGE` is S1's "Svaret är förstort" (a calendar
  lookup over 5000 events, an attendance lookup over 5000 attendances). The message never
  echoes a value you sent. **Logs carry the method, the path and the status,
  never the query string**, so a personnummer or a name in a filter never
  reaches a log line. That holds also for a request under `/ss12000/v2.0`
  that no route answers (an S1 endpoint SchemaPro does not serve, a wrong
  method): the house error filter drops its query from the log and from
  `instance`. A page token missing a parameter the operation requires is
  `INVALID_PAGE_TOKEN`.
* **Incremental reads.** Read with `meta.modified.after` and
  `/deletedEntities?after=`. **Overlap your cursor by ten minutes.** S1 is
  silent on this, but a version is dated by its transaction's start, so a long
  publish commits changes dated before it ended. Our own consumer does the
  same.

### Ids (S1 L5061: "ett enda namespace")

| Object | Id |
|---|---|
| Person, PersonReference | the source's id when an admin linked the person (`Users.ss12000Id`), else SchemaPro's |
| Group, GroupReference | the source's id when linked (`StudentGroups.ss12000Id`), else SchemaPro's |
| Organisation | one `Skolenhet` per skolenhet the school has (SchoolUnits, set up under Klasser or created by the consumer from the source): the source's id once the unit is linked, else the unit's own. A school without units is emitted itself, as before units: the source's skolenhet id when exactly one is chosen (organisationType `Skolenhet`, with its `schoolUnitCode`); with several, the school's own id as a `Skola`; with none, the school's own id as a `Skolenhet`. The sync turns the chosen skolenheter into units |
| Duty, DutyReference | the teacher's earliest live teaching-role duty at the source for the active year (`Ss12000DutyLinks`), else the post's id (`TeacherEmployments.id`, as v1). A teacher with a source duty and no post is referenced by that duty id in activities and events, but `/duties` serves posts only. A teacher with neither is left out |
| Activity | the master lesson's id. An ad-hoc lesson's own Activity has a UUIDv5 (SchemaPro namespace, name `adhoc-activity:<lesson id>`) and never the lesson's id |
| CalendarEvent, Room, Syllabus | SchemaPro's own |

Path ids, filters and lookups accept any RFC 4122 uuid version, matched
lowercased. IST's ids are not promised to be version 4. A link made after a
consumer saw an object under SchemaPro's id buries the old id in
`/deletedEntities`, so the consumer drops the duplicate.

### Resources, field by field

Only an S1 property is ever written, and an optional one only when SchemaPro
holds a value for it.

**Organisations** (`organisations.read`): one `Skolenhet` per unit. `id`,
`meta`, `displayName` (the unit's name, or Schools.name for a school without
units), `organisationType`, `schoolUnitCode` (the unit's eight-digit
skolenhetskod, when set), `schoolTypes`: the unit's own skolformer (the
source's, once linked), or, for a unit that lists none and for a school
without units, the active year's timplans for the årskurser it holds:
GRUNDSKOLA→`GR`, its årskurs 0 →`FKLASS`, ANPASSAD_GRUNDSKOLA_AMNEN→`GRS`,
ANPASSAD_GRUNDSKOLA_AMNESOMRADEN→`TR`, SPECIALSKOLA→`SP`, SAMESKOLA→`SAM`
(2.1.0 still names grundsärskola and träningsskola). `schoolTypes` is written
on a `Skolenhet` only, as S1 says, never on the `Skola` a school without units
that chose several skolenheter is emitted as. A unit's `meta.modified` is the
later of its own change and the school's (a timplan's skolform, the school's
name). `parentOrganisation`, `organisationCode` and
`municipalityCode` are not held.

Which unit something belongs to: a class (and its pupils' `enroledAt`, its
activities' `organisation`, its lessons for the `organisation` filter) is the
unit whose årskurser hold its årskurs; a group without an årskurs, a room's
`owner`, and an årskurs no unit holds are the first unit's (lowest first
årskurs). A Duty's `dutyAt` is the unit of the teacher's mentor classes when
they are one unit's, else the first unit. The `organisation` and
`relationship.organisation` filters match each object's own unit. When a
unit is added, removed, relinked or changed, or a class changes årskurs in a
school with two or more units, every object naming an organisation gets a
new `meta.modified`, and an id no longer emitted (the school's own, when its
first unit arrives) is listed by `/deletedEntities`.

**Persons** (`persons.read`; guardians need `responsibles.read`): active users.
`givenName`, `familyName`, and `emails` with one entry: `Skola elev` for a
pupil, `Skola personal` for staff, `Privat` for a guardian. A pupil with an
open class segment and a derivable school type has `enrolments`: `enroledAt`,
`schoolType`, `schoolYear` (only 0–11, in the numbering of the class's läsår: from HT 2028 the tioårig one, where 11 is specialskolan's last årskurs) and `startDate`. `startDate` is the
start of the pupil's unbroken chain of class segments, so a class move is not
a new enrolment, and moving up a year is not one either: the summer between
two consecutive läsår does not break the chain. There is no `endDate` while
the pupil is active.
`responsibles` holds `{person}` only; **`relationType` is omitted** because
SchemaPro does not store it. **`eduPersonPrincipalNames` is omitted**: S1
defines it as "spårbar, persistent och globalt unik", and an email address can
change and be reused. v1 still sends the email there. Expands: `duties`,
`responsibleFor`, `groupMemberships` (`{group: GroupFragment, startDate,
endDate}`), and `placements`/`ownedPlacements` (always `[]`; SchemaPro has no
förskola or fritids). `relationship.*` filters act on enrolment, duty,
responsibleFor.enrolment and groupMembership relations.

**Groups** (`groups.read`): classes and teaching groups of the **active and
past** läsår. A rolled-over year that is not yet active is a draft and never
leaves. `displayName`, `startDate`/`endDate` (the year's bounds), `groupType`
(`Klass`/`Undervisning`), `schoolType` (from the year's timplan for the
class's årskurs), and `organisation`. `groupMemberships`: a class lists its
StudentEnrollments segments as `{person, startDate, endDate}`. The segment's
exclusive end is turned into S1's inclusive one, and an open segment has no
`endDate`. A teaching group lists `{person}` per member; no dates are held.
`expand=assignmentRoles` gives the MENTORSKAP uppdrag as `Mentor`.

**Duties** (`duties.read`): the active year's posts of active teachers, built
by the same `toSs12000Duties` as v1's `/duties`, a changing post as one Duty
per stretch of its grad, with the opt-in, as described there. `dutyPercent` and
`hoursPerYear` are sent only when the school turned
`shareEmploymentWithIntegrations` on. The nedsättning, the target and the note
are never selected. The ids are then translated as above. When the Duty is
served under the **source's** duty id (a linked teacher), it carries the
source's `dutyRole`, `startDate` and `endDate` as the link stored them, and no
`dutyPercent` or `hoursPerYear`: S1 has one namespace for ids (L5061), and the
source holds its own figures under that id. Such a teacher's post is never
split. Activities and events reference a teacher's Duty by the id above,
the post's first stretch, for the whole year, and a teacher filter matches
that id only: nothing a key without `duties.read` reads moves with a period.
The same holds for persons: a person's `duty` relationship spans the whole
post, so `relationship.startDate.*` and `.endDate.*` tell nothing about a
stretch. `groups?expand=assignmentRoles`, which needs `duties.read`, names
each stretch a mentorship falls in, clipped to it, as the Duties' own
`assignmentRole` do. When a stretch stops being emitted (a period removed or
changed, the opt-in turned off, the teacher linked), its id is listed by
`/deletedEntities`; its id is opaque, so a key that reads the tombstones
after the school stopped sharing learns no date from them. The database
derives the stretch ids itself (`app.ss12000_split_duty_ids`), so the
versions and tombstones follow them. A write to a period moves a Duty's
`meta.modified` only when the stretches it makes change (dates, grad): a
nedsättning or a target written in a period moves none. What moves the
post's Duty moves every stretch of it. Posts already cut when the migration
ran were versioned then. A deactivated teacher's Duty
leaves `/duties` and is listed by `/deletedEntities`; the activities and
events naming it get a new `meta.modified`. An HR-only edit (employment
percent, contract kind) moves no Duty's `meta.modified` unless the school
shares those figures. `expand=person`.

**Activities** (`activities.read`): **the published** weekly timetable of the
active year. That is the live masters in DIRECT and the publication's snapshot
valid now in DRAFT, read through the same `readGrundschema` as v1's
`/activities`; a draft edit is never served, and parked lessons are not
activities. `displayName` (`<subject> — <group>`, as in v1),
`calendarEventsRequired`, `startDate`/`endDate` (the master's dates or the
year's), `activityType` (`Undervisning` when the subject counts toward the
timplan, else `Elevaktivitet`, S1's own example being mentorstid; changing
that flag on a subject moves its activities' `meta.modified`), `groups`,
`teachers` (`[{duty}]`), `syllabus` (when the Syllabus is served), and
`organisation`. An ad-hoc lesson is an Activity of its own, with
`calendarEventsRequired: false` and its date as both bounds.
**`minutesPlanned` is omitted**: no per-activity total over the period is
computed.

**CalendarEvents** (`calendarEvents.read`): the dated lessons (always the
published calendar) of the active and past years. `startTime.onOrAfter` and
`startTime.onOrBefore` are required (S1) and may span at most 400 days.
Fields: `activity`, `startTime`, `endTime`, `cancelled`, `rooms`,
`studentExceptions` (a pupil named on the lesson outside its groups), and
`teacherExceptions`. The exceptions compare the event's teachers with its
activity's: every teacher on the lesson counts. A cover removes only the
replaced teacher's row, so the vikarie participates, the replaced teacher does
not, and a co-teacher still on the lesson is not listed at all. **The event itself is only the fact: never a
pupil's absence, a reason, the lesson's note or a cancel cause.** `expand=activity`. `expand=attendance`
embeds the lesson's Attendances (below) under `_embedded.attendance`; it needs
`attendances.read` (else 403 `SCOPE_MISSING`) and the school's decision to
share (else 403 `NOT_SHARED`), and it reads the attendance of the events on
the page only.

**Rooms** (`rooms.read`): `displayName`, `seats` (capacity, when set),
`owner`.

**Syllabuses** (`syllabuses.read`): one per subject when the active year's
timplans have exactly one school form (S1 requires `schoolType`). Fields:
`subjectName`, `subjectDesignation` (the national code such as `MA`, not S1's
`subjectCode` such as `GRGRMAT01`, which is never sent), and `official`. A
school with none or several forms serves no Syllabus, and its activities carry
no `syllabus`.

**Attendances** (`attendances.read`, at a school that shares; see
"Attendances and Absences" below): one per recorded pupil and lesson
(AttendanceRecords) of the active and past years' lessons, of a pupil who is
active. `id` (the record's own), `meta`, `calendarEvent` (the lesson's
CalendarEvent id), `student`, `isReported` (false for a record whose status
is still unknown, which then has no minutes), and the minutes by the
närvarorapport's rule, the lesson's length rounded to whole minutes:

| Status | `attendanceMinutes` | `validAbsenceMinutes` (giltig) | `invalidAbsenceMinutes` (ogiltig) |
|---|---|---|---|
| Närvarande | the lesson | 0 | 0 |
| Giltig frånvaro (EXCUSED) | 0 | the lesson | 0 |
| Ogiltig frånvaro (ABSENT) | 0 | 0 | the lesson |
| Sen (LATE) | the lesson less 15 | 0 | 15 (at most the lesson) |

**Never written:** `absenceReason` (SchemaPro does not hand out a reason,
under any name), `reporter` (a member of staff's activity, not the pupil's
attendance), `otherAttendanceMinutes` (not held) and `reportedTimestamp`
(the register stamps its time anew at every save, so it would say when the
register was last saved, not when attendance was taken). Filters: `student`,
`calendarEvent`, `organisation` (the lesson's own group's skolenhet, as an
event's), and `meta.*`. S1 gives `/attendances` no sortkey: pages are by id,
and a page is read from the database, not from the whole school in memory.
`attendances/lookup {ids, activities, students, calendareEvents}` (S1's own
spelling) answers the attendances any of them names, at most 5000, else 503
`TOO_LARGE`; a whole school's or a pupil's years are read with
`GET /attendances?student=…` in pages instead.

**Absences** (`absences.read`, at a school that shares): one per absence
report (AbsenceReports) of a pupil who is active. `id`, `meta`, `student`,
`startTime` and `endTime` (the reported times on the day in the school's
timezone; a report without both times is the whole day, local midnight to
midnight), and `type`: **`Beviljad ledighet`** for a day of a granted leave
(written by the leave decision, AbsenceReports.grantedLeave), **`Anmäld
frånvaro`** for every other report. **Never written:** the report's kind
(sick, appointment, other), its note, the leave request's reason, and
`registeredBy` (who filed it, a guardian to a key that may not see
guardians). `organisation` is not written; the `organisation` filter matches
the pupil's class's skolenhet. `registeredBy` filters an attribute never
emitted and answers an empty page. Sortkeys `ModifiedDesc`, `StartTimeAsc`,
`StartTimeDesc`; `startTime.*` and `endTime.*` (`onOrAfter` inclusive, as the
name and calendar events have it, where S1's text for `/absences` says
"Exkluderande"). `absences/lookup {ids}`.

**DeletedEntities**: `{data: {persons, groups, duties, activitites,
calendarEvents, rooms, syllabuses, organisations, attendances, absences},
pageToken}`. The keys are S1's own spellings, `activitites` included. The
response has only the categories asked for that the key may read, with the
ids removed after `after`; `attendances` and `absences` once the school has
ever shared, also while it has stopped: an id and when it went is the
instruction to delete, never anything of the row, and only of a row that
may have been handed out (see "Starting, stopping, starting again"). At a
school that has never shared they are left out (a key
that could read nothing else is 403 `NOT_SHARED`). "Removed" means: a person
deactivated or deleted, a group, room, subject or lesson deleted, a master
deleted or parked (DIRECT) or absent from a new publication (DRAFT), a post
deleted, an id superseded by a link, a stretch of a changing post that is no
longer emitted, the activities and duties of a year that stops being active,
an attendance or absence deleted (by gallring too), and every attendance and
absence of a pupil who is deactivated (unburied when the pupil is active
again), the last two once the school has ever shared, whether or not it
shares at the moment. A future year's rows are never recorded. Tombstones
are kept 400 days. A guardian's id may appear under `persons` for a key
without `responsibles.read`: an id and nothing more.

**Lookups**: S1's bodies, at most 1000 ids in all. `persons/lookup {ids,
civicNos}` (civicNos match nothing). `organisations/lookup {ids,
schoolUnitCodes, organisationCodes}`. `activities/lookup {ids, teachers,
members}`. `calendarEvents/lookup {ids, activities, student, teacher}`, where
`student` and `teacher` are arrays under singular names, as S1 has them. S1
types the calendar lookup's answer `AttendancesArray`, an evident slip; it
answers `CalendarEvent[]`. `attendances/lookup {ids, activities, students,
calendareEvents}` as above. The rest take `{ids}`. Unknown keys or values
that are not uuids are 400 `INVALID_BODY`.

### Attendances and Absences (SS12000-närvaro)

Pupils' attendance and absence leave SchemaPro only when **the school has
decided so**: rektor or a full administrator records the decision under
Integrationer → API-nycklar → *Närvaro och frånvaro till integrationer*
(`POST /api/v1/integrations/attendance-sharing {shares, reference?}`,
`@Decides()`; it is one of the decisions of Roller i skolan, as gallring is,
and the database's insert arm asks `app.current_user_decides()` too; every
administrator reads it with `GET`). Each decision is
kept with who made it and when (AttendanceSharingDecisions, migration
`20261114090000`, append-only: a decision is replaced by a new one, never
changed or removed), and the latest is in force from the next request. **No
decision is not shared.**

* **Two gates, both enforced twice.** A read needs the scope
  (`attendances.read` or `absences.read`; else 403 `SCOPE_MISSING`) and the
  school's decision (else 403 `NOT_SHARED`). Under the service principal the
  two tables have no row policy at all and read as empty; the provider reads
  them through two database functions, `app.ss12000_attendances` and
  `app.ss12000_absences`, which answer only the columns listed above, only
  when `app.service_reads_attendance` says the request's key is the
  school's, not revoked, holds that resource's scope, and the school shares,
  and only of active pupils (attendance only of the emitted years). A read
  that slipped past the gateway would find no row, and no read can reach a
  note.
* **What leaves** is minutes per lesson and absence as giltig or ogiltig, and
  an absence's time and whether it is a granted leave. **Never** a reason, a
  note, a leave request's reason, the kind of report, or who reported it.
* **Starting, stopping, starting again.** A school that has never shared
  records nothing of its attendance for the provider.
  * **When it starts**, every Attendance and Absence reads as modified at
    that moment (`meta.modified` is never earlier than the start of the
    current run of sharing), so an incremental read from any time before
    it reads both whole: a first sync can ask `meta.modified.after` the
    start of term and get every row.
  * **While it is stopped**, every read of the two is 403 `NOT_SHARED`, and
    the integration should delete the attendance and absence it holds from
    the school. `/deletedEntities` is answered as before, the two
    categories included for a key with their scope: what goes meanwhile
    (gallring's purge, a pupil who leaves, a deleted record) is told by id,
    and so is everything else that goes, so an integration that keeps
    calling it without naming categories (S1's default) keeps deleting
    what it must. A subscription is told of those removals too. Only what
    may have left SchemaPro is told: a record or report created during the
    stop and removed during it was never handed out, and is told to
    nobody, also not with a pupil who leaves (told at the instant of the
    pupil's own removal, it would count the absences the pupil had while
    the school chose not to share). A change is not recorded.
  * **When it starts again**, everything reads as modified at that moment
    again, so the integration's next incremental read from before the stop
    reads every row as it is now, whether or not it saw the 403;
    `/deletedEntities` after its cursor lists what went that it has not
    been told (it never answered without them, so no cursor moved past
    one); and every subscription to them is told once, with
    `deletedEntities: true`, even if nothing changes after the start, and
    even if a notice was in flight when the school decided. An integration
    that missed the whole stop therefore ends up holding exactly what is
    shared.
* **Every read is in the läslogg** (PersonalDataAccess, `/admin/dataskydd`),
  with the key as reader and the channel INTEGRATION: an attendance as
  `ATTENDANCE`, a reported absence as `ABSENCE_REPORTS`, a granted leave's
  day as `LEAVE_REQUESTS`, for each pupil the answer names; embedded
  attendance (`expand=attendance`) too.
* **Gallring.** Gallring deletes attendance and absence as the school's
  periods say (ATTENDANCE, ABSENCE_REPORTS), and a deleted row is never
  served; the delete buries it, so `/deletedEntities` lists exactly what the
  night removed.
* **meta.modified** of an Attendance moves with its status, its lesson or
  pupil, the lesson's times (the minutes), the pupil's id being linked to the
  source, and its year becoming emitted (activated, or a new start date); of
  an Absence with its date and times, whether it is a granted leave, its
  pupil, the pupil's id and the school's timezone. A note moves neither, nor
  a re-save of the register. Either is never earlier than the start of the
  school's current run of sharing nor than the row's creation, and
  `meta.modified.after` and `.before` compare exactly what is emitted, for
  both resources. An incremental read of /attendances does not read the
  school's whole history: one of some ids, lessons or pupils is driven by
  that filter's index; any other (an organisation's too) reads the records
  changed since the cursor through their indexes (a record's version, a
  moved pupil's records, a record's creation:
  `AttendanceRecords_schoolId_createdAt_idx`, `20261114090150`) while they
  are fewer than 50 000, and from 50 000 (every pupil linked to the source,
  a year made emitted) walks the school's records in id order from the
  page's last until the page is full.
* **A register save never waits for the school's people lock, an apply's
  record versions or a sharing decision.** Each status a save writes at a
  sharing school moves
  that record's version. An administrator's apply that links or brings back
  pupils moves no record's version: it moves one row per pupil,
  `AttendancePupil` and `AbsencePupil`, which the two read functions take
  into every record's `meta.modified` (the latest of the record's version,
  the pupil's row, the start of the current run of sharing and the record's
  creation) and into
  `meta.modified.after` and `.before`; a subscription is told of it as a
  change of Attendance or Absence. So an apply and a save never share a row
  this adds, and neither waits for the other. As the apply commits, the
  pupils' rows are stamped again with the clock
  (`Users_ss12000_attendance_pupils_stamped`, a deferred constraint
  trigger), so an integration that read while the apply ran reads the
  linked pupils' records again. A save still meets an apply where it did
  before this: when the apply changes the e-mail of a person the save's
  foreign keys name (a pupil given a new record, the teacher recording, a
  guardian notified), the apply holds that person's row until it commits.
  The apply writes addresses last, so it holds those rows only for its last
  moments. The save waits for a lock at most 5 s, then answers 409
  `ATTENDANCE_REGISTER_BUSY` having written nothing; the phone's queue sends
  it again (a phone from before this counts it as one of its five
  attempts), and the web register says to try again in a moment. Two saves
  of one lesson write its records in pupil order, so they never hold one
  each of what the other waits for.
* **A mark is written only over an older one.** The phone's queue sends a
  batch again until it goes through (a refusal of the batch itself
  excepted), so a mark can arrive long after it was made. The register
  keeps each mark's `recordedAt` (when the teacher marked it on the phone;
  the server's clock for the web), and a save writes a pupil's mark only
  when the stored one is not later: a late phone mark leaves a newer
  correction standing, and alerts no guardian. A phone mark sent again is
  written again with its own time. A pupil the web sends back as the
  register holds it (the web saves every pupil it lists) is no new mark and
  is not written, so it keeps out no phone mark made before that save. The
  phone's time is its own clock, trusted within the register's limits: a
  mark dated in the future or more than 120 days back takes the server's
  clock, and so counts as made when it arrived.
* **Decisions are ordered against the writers.** A writer reads whether the
  school shares when its statement runs, and commits later. So every writer
  of attendance or absence first takes `'AttendanceSharing:<school>'`
  shared and holds it to its end, and a decision takes it exclusively: no
  decision commits between the read and the commit of a writer that holds
  it, so nothing it left unversioned or untold is readable after a start. A
  writer that versions (a register save, a lesson's times) never waits for
  it: one that cannot take it at once, because a decision is being written
  or waits to be, versions as if the school shared, a version more and
  never one less, so its commit is told whenever the school shares then
  (`app.attendance_recorded_as_shared`). A stop is dated by its commit
  (`committedAt`, stamped as its transaction commits, with only the
  commit's own write after it), and a removal during it trusts a version
  as a row that may have left only when its transaction began before that
  (`app.ss12000_may_have_left`): a row committed while the stop was being
  written is told when it goes, and one created and removed within the stop
  is told to nobody. A removal cannot guess: it waits while a decision is
  being written or waits to be (`app.attendance_removals_ordered`), at most
  until the decision gives up. A decision waits at most 5 s for the writers
  holding the lock, then answers 409 `ATTENDANCE_SHARING_BUSY` having
  written nothing; while an SS12000 apply or a publication touching the
  school's pupils or lessons runs, rektor decides once it is done.
* **A granted leave and a span.** Only the leave decision marks a day as
  `Beviljad ledighet` (a guardian or a pupil who tries is refused); and a
  reported span ends after it starts (a report from before 20261114090000
  that does not is served as the whole day).
* **Subscriptions** may name `Attendance` and `Absence` (with the scope, and
  only while the school shares: else 403 `NOT_SHARED`). A school that stops
  sharing stops the notices of their changes at once, even of a change made
  just before, and so does a key that loses the scope; their removals are
  still told (`deletedEntities: true`), and the other resource types of the
  same subscription are notified as before. When it starts again, each such
  subscription is told once (above). Whether it has been told is the
  decision's transaction against the subscription's watermark, the rule a
  change follows, so a notice claimed before the decision and settled after
  it does not swallow the start.

Read only: S1's `POST /attendances`, `DELETE /attendances/{id}` and `POST
/absences` are not served (404); a school's register is not written by an
integration.

### Subscriptions (webhooks)

S1's `/subscriptions`, for the key's own subscriptions only (another key's id
is 404); `subscriptions.write`:

* `POST /subscriptions` `{name, target, resourceTypes: [{resource: "Person"}, …]}`
  answers **201** `Subscription {id, expires, name, target, resourceTypes}`.
  `resourceTypes` takes S1's schema shape, `[{resource}]`. S1's own example
  (`["Organsation","Person","Duty"]`, plain strings, misspelt) is
  non-normative and answers 400. The resources are those the provider emits
  (`Organisation`, `Person`, `Group`, `Duty`, `Activity`, `CalendarEvent`,
  `Room`, `Syllabus`, `Attendance`, `Absence`), each needing its read scope;
  `Attendance` and `Absence` also the school's decision to share (403
  `NOT_SHARED`), and the notices of their changes stop when the school stops
  sharing or the key loses the scope (`app.ss12000_notifies`); their removals
  are told also while the school has stopped, to a key with the scope
  (`app.ss12000_notifies_removals`). `target` is https with no
  userinfo or fragment, at most 2048 characters, and an address that passes
  the sync's SSRF rules (no loopback, RFC 1918, CGNAT, link-local, ULA such as
  `*.railway.internal`, multicast, or mapped and NAT64 forms of them). It is
  vetted at creation and at every delivery, with the connection pinned to the
  vetted address. **409 `WEBHOOK_SECRET_MISSING`** until the school has created
  the key's signing secret; no unsigned notice is ever sent. 409
  `SUBSCRIPTION_LIMIT` at ten live subscriptions per key.
* `GET /subscriptions` (paged), `GET /subscriptions/{id}`.
* `PATCH /subscriptions/{id}`, no body (S1: "Uppdatera expire time"), moves
  `expires` 30 days ahead. It also lifts a suspension for failing deliveries,
  never a pause the school made.
* `DELETE /subscriptions/{id}` answers **204** and ends the subscription. The
  row stays as the record.

**The notice** is a POST to `target` with exactly S1's callback body:

```json
{"modifiedEntites": ["CalendarEvent", "Activity"], "deletedEntities": true}
```

`modifiedEntites` is S1's spelling. The notice carries no data and no id. Read
the changes with `meta.modified.after` and `/deletedEntities`. At most one
notice per subscription a minute, as S1 permits ("kan välja att skicka en notis
för multipla förändringar"). The delivery watermark is a transaction-id
horizon, not a time, so a change committed late is never skipped. Any 2xx is
accepted (S1 names 200).

**Signing** (a SchemaPro extension, in headers only):

```
X-SchemaPro-Delivery:  <uuid per attempt>
X-SchemaPro-Timestamp: <unix seconds>
X-SchemaPro-Signature: v1=<hex HMAC-SHA256(secret, timestamp + "." + raw body)>
```

The secret is per key, made by the school's admin (Admin → Integrations,
`POST /api/v1/integration-keys/:id/webhook-secret`). It is shown once and
stored sealed (AES-256-GCM with `INTEGRATION_SECRETS_KEY`, bound to the school
and the key). When it is replaced, the previous secret keeps signing for 24
hours and the header carries both (`v1=<new>,v1=<old>`). Verify like this:

```js
const { createHmac, timingSafeEqual } = require('node:crypto');
function verify(secret, headers, rawBody) {
  const timestamp = Number(headers['x-schemapro-timestamp']);
  if (Math.abs(Date.now() / 1000 - timestamp) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest();
  return String(headers['x-schemapro-signature']).split(',').some((part) => {
    const given = Buffer.from(part.trim().replace(/^v1=/, ''), 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
```

**Retries.** Each attempt has 10 seconds and no redirects, and at most 64 KB
of the answer is read and then dropped. After a failure the next attempt comes
in 1 min, 5 min, 30 min and 2 h, then every 6 h, each ±20 %. After 72 hours of
failure the subscription is suspended (the admin sees it; a PATCH lifts it). A
revoked key's subscriptions are never notified. Every attempt is logged with
its status, an outcome code and its duration, but no body and no header, and
the log is kept 30 days. The school's admin can pause and resume a
subscription.

### Left out, with reasons

| Item | Reason |
|---|---|
| `Placement` | S1 uses it for förskola and fritids only (`schoolType` FS, FTH, OPPFTH). SchemaPro holds no such data |
| `AttendanceEvent`, `AttendanceSchedule`, `AggregatedAttendance` | Check-ins and fritids schedules SchemaPro does not hold, and a sum a consumer can make from `/attendances` |
| Writing attendance or absence (`POST /attendances`, `DELETE /attendances/{id}`, `POST /absences`) | The register is the teachers' and the families', in SchemaPro; an integration reads it |
| `Attendance.absenceReason`, `reporter`, `otherAttendanceMinutes`, `reportedTimestamp`; `Absence.registeredBy` | A reason under any name never leaves, nor who reported or registered; no other activity is held; the register stamps its time anew at every save, so it would say when the register was last saved, not when attendance was taken. See "Attendances and Absences" |
| `Absence.organisation` | Optional in S1. The skolenhet of an absence would be the pupil's class's, which moves at every rollover without the absence changing; the `organisation` filter matches the pupil's class instead |
| `Programme`, `StudyPlan`, `SchoolUnitOffering`, `Resource`, `Grade`, `/log`, `/statistics` | No source in SchemaPro |
| A token endpoint for this provider | S1 requires only a bearer; the key is one. A JWT issuer would need a signing key of its own |
| civicNo, addresses, phone numbers, securityMarking, middleName | Not stored, or not stored for this |

## Pulling the roster from a source (SS12000 consumer)

The other direction: SchemaPro reads its pupils, staff, guardians and classes
from the school's student register (IST, Edlevo or any other provider of the
standard) instead of having them typed in twice. Nothing in the school changes
until an admin applies a diff, or a nightly run the admin explicitly enabled
applies the safe part of one. Nothing is ever deleted.

**The standard.** SIS TK450, *SS12000 OpenAPI 3.0*,
`openapi_ss12000_version2_1_0.yaml`, `info.version` 2.1.0 (korrigendum augusti
2022), sha256 `aee9a95a4c5bd25cebaf357d266592f94e9388ae785ee9ac3b58e1992acccd28`
(<https://www.sis.se/globalassets/standardutveckling/tksidor/tk-450/openapi_ss12000_version2_1_0.yaml>).
SIS's SS 12000 page lists 2.0.0 and 2.1.0 only; 2.1.0 is the newest
machine-readable API. Every path, parameter, enum and spelling the consumer
uses is S1's, transcribed in `src/integration/ss12000-sync/s1.ts`.

### The source

`PUT /api/v1/ss12000-source` (SCHOOL_ADMIN) names one source per school:

| field | rule |
|---|---|
| `baseUrl` | the provider's URL up to and including `/v2.0` (IST: `https://api.ist.com/ss12000v2-api/source/<id>/v2.0`). https, no user info, no query or fragment, no trailing slash |
| `authKind` | `OAUTH2_CLIENT_CREDENTIALS`, `BEARER_TOKEN` or `MTLS_CLIENT_CERT` (below) |
| `tokenUrl`, `clientId`, `tokenScope`, `tokenAuthStyle` | OAuth2 client credentials; `BASIC` (HTTP Basic) or `FORM` |
| `organisationIds` | the source's ids of the skolenheter this school is, 0–5, chosen from what *Testa anslutning* lists |
| `pageSize` | 100–2000 (IST suggests 1 000–2 000) |

S1 says only how a token is *presented* (`securitySchemes.BearerAuth`), not how
it is obtained:

* **OAuth2 client credentials** — `POST tokenUrl`, `grant_type=client_credentials`,
  the client in HTTP Basic or the form. IST EduCloud, *Fetch and use access token*
  (2021-12-30): `https://skolid.se/connect/token`, `expires_in` 3600. The access
  token lives in the API's memory until 60 s before it expires and is never stored.
* **Static bearer token** issued by the provider.
* **Client certificate** (mutual TLS), optionally with a bearer or an OAuth2
  client on top: Tieto Edlevo per Skolon's support article (2025-02-27). Whether
  Edlevo's endpoints are SS12000-shaped is not confirmed. Skolfederation's
  Moa/MATF metadata is not implemented; the server is verified by the CA store.

Credentials go in through `PUT /api/v1/ss12000-source/secrets/:kind`
(`CLIENT_SECRET`, `BEARER_TOKEN`, `CLIENT_KEY_PEM`, `CLIENT_CERT_PEM`) and never
come back out: `GET` answers `secrets: {kind: {setAt}}`. They are sealed with
`INTEGRATION_SECRETS_KEY` (AES-256-GCM) and bound to the school, the source, the
kind and the **host they are sent to**; changing that host clears them and the
admin types them again, so a stored secret cannot be pointed at another host.
Changing the organisations or the base host once people are linked answers 409
`SS12000_SOURCE_RELINK_REQUIRED` unless `confirmRelink: true`; the next run is
then FULL.

Outbound calls are https only, refuse every non-public address (loopback, RFC
1918, CGNAT, link-local and cloud metadata, ULA such as `*.railway.internal`,
IPv4-mapped and NAT64 forms of them), are pinned to the vetted address, follow no
redirect, time out after 30 s and read at most 32 MB. Errors are codes
(`SS12000_TOKEN_REFUSED`, `SS12000_HTTP_403`, `SS12000_TLS_FAILED`, …); nothing
the far side says is kept.

### What a run reads

Per organisation, with T the school's local today:

1. `GET /organisations/{id}`
2. `GET /persons?relationship.organisation={id}&relationship.entity.type=enrolment&relationship.endDate.onOrAfter=T` (pupils)
3. the same with `relationship.entity.type=duty` (staff)
4. the same with `relationship.entity.type=responsibleFor.enrolment` (guardians; a provider answering 400 is read through `/persons/lookup` instead)
5. `GET /groups?organisation={id}&groupType=Klass&groupType=Undervisning&endDate.onOrAfter=T`
6. `GET /duties?organisation={id}&endDate.onOrAfter=T`

Pages per S1: filters and `limit` on the first request, `pageToken` and `limit`
only after. An INCREMENTAL run adds `meta.modified.after` and reads
`GET /deletedEntities?after=…&entities=Person&entities=Group&entities=Duty`.
Anyone a pupil, a duty or a group names who was neither read nor linked is read
through `POST /persons/lookup {ids}` (S1 `PersonsExpandedArray`). An INCREMENTAL
run also looks up a *linked* person a changed group names as an active member:
S1's `groupMemberships` belong to Group, so a class move modifies the two groups
and not the Person, and without the pupil's record the move would be lost until
the next FULL run. A provider that refuses an incremental filter makes the run
FULL, and later runs too; a FULL run whose lookup is refused goes on and records
`SS12000_LOOKUP_REFUSED` in its errors with the number of ids left unread. A run
whose fetch does not complete, or a FULL fetch with no pupils (or staff) while
linked ones exist (`SS12000_SOURCE_EMPTY`), produces no diff.

**Never kept:** civicNo, birth date, sex, addresses, phone numbers, photo, and
the Duty's `dutyPercent`, `hoursPerYear` and signature. They are dropped when a
record is parsed.

### Mapping

| SS12000 | SchemaPro | rule |
|---|---|---|
| `Person.id` | `Users.ss12000Id` | matched first, always |
| `givenName` / `familyName` | `firstName` / `lastName` | UPDATE when different |
| `emails[]` | `email` | `Skola elev` for a pupil, `Skola personal` for staff, `Privat` for a guardian; the first EPPN as fallback for pupils and staff |
| enrolment at the organisation, active on T | role STUDENT (create only) | |
| Duty at the organisation, active on T | role TEACHER (create only) | Lärare, Förstelärare, Speciallärare/specialpedagog selected; Lärarassistent, Fritidspedagog, Förskollärare for review; other roles deselected |
| a pupil's `responsibles[]` | role GUARDIAN, `GuardianStudents` (origin SS12000) | `relationType` shown, not stored |
| `Group.id`, `groupType` Klass / Undervisning | `StudentGroups.ss12000Id`, CLASS / TEACHING_GROUP | the active läsår only |
| Klass `groupMemberships` active on T | `Users.studentGroupId` | through the role-guarded write; P4's trigger records the move (dated the school's today) |
| Undervisning `groupMemberships` | `StudentGroupMembers` | added, never removed |
| `Duty.id` | `Ss12000DutyLinks` | no HR figure; an ended duty gets `endedAt` |
| a chosen `Organisation` of type `Skolenhet` | `SchoolUnits` (`ss12000Id`, name, `code`, `schoolTypes`) | matched by id, else LINKed to the one unlinked unit with the same skolenhetskod (or, without a code, the same name), else CREATEd; the source owns the name, a valid eight-digit code and the skolformer SchemaPro holds; never automatic |
| active enrolments' `schoolYear` at the skolenhet | the unit's årskurs span | a FULL run only: set where the unit has none, widened to hold them, never narrowed; deselected after a local edit |
| `securityMarking` ≠ Ingen | — | every change for the person deselected, never automatic, not stored; any value other than `Ingen` (another Unicode form, case, an unknown value) counts as protected |

Without a stored id, a LINK by email is proposed only for exactly one active
local row with the same role and an address no other source person claims (a
linked person's new address counts as a claim, so an email update and a create
of the same address are both `PERSON_EMAIL_TAKEN`); a group LINK needs the same
name, year and kind. Everything else is a named conflict for the admin.

A LINK or RELINK is a proposal until it is applied. Every change that depends on
it — the name update beside it, a class move, a group membership, a guardian
link, a duty link — carries only the source's id, and the apply resolves it only
through a row linked before the apply or linked or created in it. When the admin
deselects a LINK ("not the same person"), the row the address matched gets
nothing; the dependants are skipped with `SS12000_DEPENDENCY_NOT_APPLIED`.

Skolenheter: a code that is not eight digits is `SCHOOL_UNIT_CODE_INVALID`
and is not written; one another unit of the school holds is
`SCHOOL_UNIT_CODE_TAKEN`; a span that would share an årskurs with another unit
is `SCHOOL_UNIT_SPAN_OVERLAP`; a skolform outside the seven SchemaPro holds
(`FKLASS`, `FTH`, `GR`, `GRS`, `TR`, `SP`, `SAM`) is
`SCHOOL_UNIT_TYPES_UNSUPPORTED`; a chosen organisation of another type is
`ORGANISATION_NOT_SKOLENHET`; a linked unit the source no longer reads is
`SCHOOL_UNIT_NOT_CHOSEN` and stays. With two or more units a class is the
unit's whose span holds its årskurs, so a class the source's group puts in
another unit is `GROUP_UNIT_MISMATCH`: the span or the class's årskurs is not
what the source says. No unit is written by the nightly run: the sync
principal reads `SchoolUnits` and has no arm to write it.

A record the parser refuses (`INVALID_RECORD`) is not an absence. A linked
person whose record was refused is `PERSON_RECORD_INVALID`, and while any person
record of a FULL run was refused, a deactivation inferred from absence
(`ABSENT_FROM_SOURCE`, a guardian's `NO_ACTIVE_CHILD`) is
`ROSTER_HAS_INVALID_RECORDS`: deselected and never automatic.

### Diff, apply, schedule

* `POST /api/v1/ss12000-sync/runs {mode}` — *Synka nu*, 202 `{runId}`.
* `GET /api/v1/ss12000-sync/runs`, `/runs/:id`, `/runs/:id/changes?entity&op&conflicts&cursor&limit`.
* `POST /api/v1/ss12000-sync/runs/:id/apply {basisHash, select?, deselect?, confirmMassDeactivation?}` —
  one transaction: the source locked (409 `SS12000_BUSY` after 10 s), the newest
  `DIFF_READY` run only, its basis recomputed over the rows it locks (409
  `SS12000_DIFF_STALE`), more deactivations than max(5, 10 %) of the linked
  active people refused unless confirmed (409 `SS12000_MASS_DEACTIVATION`), the
  cursors moved with it.
* `POST /api/v1/ss12000-sync/runs/:id/discard`.
* `GET /api/v1/ss12000-sync/provisioning` — linked, active people never invited.
  *Bjud in valda* is the existing `POST /api/v1/users/invitations` (500 ids a
  call): a new person is only ever a catalogue row with no identity and no mail
  until an admin invites them.
* `PATCH /api/v1/ss12000-source/schedule {scheduleEnabled, scheduleAutoApply, scheduleHourLocal, fullEveryDays}` —
  a nightly run at or after the school-local hour (DST-safe), FULL every
  `fullEveryDays`. With auto-apply on it applies only names, a class move, a
  teaching-group add, a guardian link between linked unprotected people, a duty
  link and a pupil's or guardian's deactivation, and stops at max(5, 2 %)
  deactivations. It never creates, links, changes an email, reactivates or
  deactivates staff. A manual diff younger than 24 h is not superseded: the
  night records `SKIPPED` (`REVIEW_PENDING`). A night that applies nothing says
  why in `autoApplyBlockedReason`: `MASS_DEACTIVATION`, `STALE` (the school
  changed between fetch and apply) or `REVIEW_REQUIRED` (all that is left needs
  an admin). A night that applies part of a diff sets the run's `appliedAt`, so
  its deactivations read as the sync's (and may be reactivated by a later sync)
  also after a newer run supersedes it.

A run's `before`/`after` hold names and emails only while it is `DIFF_READY`;
they are nulled the moment it reaches any other status, and a `DIFF_READY` run
expires after 30 days.

## The admin page (`/admin/integrations`)

Both directions are administered on one page, SCHOOL_ADMIN only, in two tabs.
It calls only the admin routes above; nothing on it reads or writes the
database directly. The manual describes it for the school in 7.2 and 7.3
(`docs/manual/anvandarmanual.html`).

**Elevregister** (the consumer):

* *Källsystem* — `PUT /api/v1/ss12000-source`. The address and token URL are
  checked in the browser against the gateway's rule (https, no user info, no
  query or fragment, no trailing slash) before they are sent; the gateway
  decides. A 409 `SS12000_SOURCE_RELINK_REQUIRED` opens a confirmation naming
  how many people and groups are linked, and only the confirmation sends
  `confirmRelink: true`.
* *Inloggningsuppgifter* — one write-only field per credential the sign-in
  needs (`secrets/:kind`). The field is never filled from the server, is
  cleared once the request settles (also on a refusal), and the row shows only
  *Sparad <när>* or *Saknas*. A PEM key or certificate is a textarea; the
  gateway parses it at save. Each row is a form (Enter saves), and the field
  opts out of password managers (`autocomplete="off"` and their ignore
  attributes) so none offers to generate or store a value there. A credential
  stored for a sign-in type the source no longer uses is listed too, with only
  *Ta bort*.
* *Testa anslutning* — `POST …/test`; the outcome is shown as the code's
  sentence (`integrations.codes.*`), never the provider's words, and the
  listed skolenheter (at most 5 chosen) are saved with the source's stored
  configuration plus `organisationIds`.
* *Synk* — *Synka nu* (`INCREMENTAL`; the gateway falls back to FULL when it
  must) and *Full synk*; the history (`GET …/runs?limit=20`) polls every 3 s
  while a run is `RUNNING` and names each status, trigger, mode, counts, status
  code, each error code with how often it occurred, a partial night's
  `appliedAt` and why a night applied nothing. *Visa äldre synkar* pages back
  with `before=<oldest startedAt>`.
* *Granska* — loads **every** change of the run (500 a page, up to the DTO's
  20 000) before anything can be applied, so the count shown is the count
  applied. The gateway's defaults arrive ticked or unticked; the apply sends
  only the difference (`select` / `deselect`) with the run's `basisHash`.
  Conflicts, notes, already auto-applied changes and every row of a run that
  is no longer `DIFF_READY` are not selectable. `RESPONSIBLE_ENDED_AT_SOURCE`
  rows are listed with a link to `/admin/people?guardians=<pupil id>` (the
  people register's guardian dialog), and the apply stays disabled until the
  admin ticks that they have seen them (all of them are listed). With nothing
  chosen the button is *Markera som granskad*: an apply with empty `select` /
  `deselect`, which changes nothing in the school but moves the cursors, so a
  run of conflicts only does not have to be discarded. *Välj alla visade utom
  flaggade* ticks the rows rendered (not those behind *Visa fler*) and never a
  protected identity or a change with a code. A 409 `SS12000_MASS_DEACTIVATION`
  shows its `deactivations` and `limit` and must be confirmed explicitly
  (`confirmMassDeactivation: true`); `SS12000_DIFF_STALE` disables the apply
  and says to sync again. A run past `DIFF_READY` opens read-only, by kind,
  operation and code (its names were nulled).
* *Nattlig synk* — `PATCH …/schedule`. Automatic apply is offered only while
  the schedule is on, with the exact set it covers and never covers.
* *Nya personer* — `GET /api/v1/ss12000-sync/provisioning`; nothing is
  pre-ticked, and *Bjud in valda* calls `POST /api/v1/users/invitations` 500
  ids at a time, summing the reports (a chunk that fails as a whole counts
  against each of its ids).

**API-nycklar** (the provider): `GET /api/v1/integration-keys/provider`. A new
key starts with the default scopes (`ss12000.v1`, `ss12000.v1.import`) ticked
and can be given any of the fourteen; the two attendance scopes are a group of
their own, which says so while the school does not share. *Ändra omfång* is
`PATCH /:id {scopes}` and refuses an empty set. *Närvaro och frånvaro till
integrationer*, at the top of the tab, is the school's decision
(`GET`/`POST /api/v1/integrations/attendance-sharing`): the decision in force
with who made it and its reference, what leaves and what never does, a
confirmation before a new decision is sent, and the earlier decisions. *Skapa / Byt signeringshemlighet* is
`POST /:id/webhook-secret`; the secret, like the key, is shown once and held
only until the admin closes the notice. Once opened the tab stays mounted
(hidden while *Elevregister* shows), so a tab switch — also one while the
request is in flight — does not lose a key or secret shown once. A copy that
the browser refuses says so. Each key lists its subscriptions
(target host only, resource types, expiry, last notice, failing since) with
*Pausa* / *Återuppta* (`POST /:id/subscriptions/:sid/pause|resume`). Revoking
a key asks first.

## Security model

**A key resolves to one school.** `IntegrationKeyGuard` hashes the
`X-API-Key` (SHA-256) and looks the hash up inside
`PrismaService.withServiceKeyLookup`. That lookup is the one step that cannot
be tenant-scoped — the tenant is what it resolves — so the transaction sets
`app.service_key_lookup` and matches only `integration_keys_service_lookup`
(SELECT) and `integration_keys_service_touch` (UPDATE): non-revoked rows of
`IntegrationApiKeys`, and no other table. A revoked key is invisible to the
lookup, so revocation takes effect on the next request. The guard's UPDATE
writes only `lastUsedAt`. The policy names no column and no school, and its
`WITH CHECK` asks only that the key stay unrevoked. Since `20261014120000` a
key carries its own reach (`scopes`), so a BEFORE UPDATE guard
(`app.integration_key_lookup_writes_are_narrow`) refuses any other column
inside the lookup (SQLSTATE SS403): the lookup reads scopes and never writes
them. The school id comes from the key row, never from request input.

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
| `TeacherEmploymentPeriods` | SELECT — a changing post's periods, read by `/duties` only with the opt-in (`20261022120000`); the query names only their dates and grad |
| `StaffingPolicies` | SELECT — the `/duties` opt-in and `fullTimeAnnualHours`: the school's configuration, no person's data (`20261010110000`) |
| `AttendanceRecords`, `AbsenceReports` | None. The provider reads them through `app.ss12000_attendances` and `app.ss12000_absences` (`20261114090000`, SECURITY DEFINER, the API's role alone), which answer the emitted columns (never a note, kind, reporter or the register's save time) only while the school's decision in force shares attendance, and only for a request whose key is the school's, live, and holds `attendances.read` or `absences.read` (`app.service_reads_attendance`). The versions' arm asks the same for `Attendance` and `Absence` rows; the tombstones' arm asks for a school that has ever shared instead (`app.service_reads_attendance_removals`), so a key with the scope is told what went also while the school has stopped |

Each write policy has a `WITH CHECK` on the same school, so a write can
neither create a row in another school nor move one there. There is no INSERT
on `Users` (unknown emails come back in `needsProvisioning`) and no DELETE
policy on any table. The `Users` policy scopes rows, not columns; the import
writes `firstName`, `lastName` and `studentGroupId`, and Prisma adds
`updatedAt` to every such UPDATE. The table itself refuses a class on anyone
but a pupil: the CHECK `Users_only_a_student_has_a_class`
(`"studentGroupId" IS NULL OR "role" = 'STUDENT'`, migration
`20260914120000_bara_en_elev_har_en_klass`) binds every writer, the service
principal included. The import sets the class in the same `UPDATE` that
requires `role = 'STUDENT'`, so a person whose role changes mid-sync gets
their names and no class instead of failing the batch on the CHECK. A
guardian link also has composite foreign keys to `Users (id, schoolId)` on
both sides, so its guardian and its student belong to the link's school
whoever writes it.

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
`LunchSettings`. Section 13 exercises `Users_only_a_student_has_a_class`, as
an admin rather than as the service principal. Section 14:
`_prisma_migrations` refuses this role a read and a DELETE with no principal,
as the service principal and as the key lookup, and no API role holds any
privilege on it. The write policies' `WITH CHECK` clauses are not asserted
there.

Sections 155–159 are SS12000-närvaro's: the catalogue of the decision table,
its arms, grants and triggers, of the two read functions (who may call them,
and exactly the columns they answer), of the versions' and tombstones' arms,
and that no arm of the two tables is the service principal's (155); the
tables read as empty to the service principal, and through the functions a
school that has not decided gives its key nothing, the sharing school's key
reads its own rows and no other school's, a key of one school named with the
other reads nothing, and once a school decides, each key reads exactly what
its scope says, only this year's attendance of active pupils, every row
reading as modified when the school started sharing (a read from before
that moment is whole, a second decision to share is not a new start), a
revoked or scopeless key nothing, PostgREST's role may not call them, and
nothing again when it stops (156); only a decision writes `grantedLeave`, a
decider's leave day is one without the column, and a span ends after it
starts (157); a decision is the administrator's, stamped and never changed
(158); and the versions and tombstones follow a status, the lesson's times,
a granted leave, a relink, a year activated, a removal, a removed lesson and
a pupil who leaves and comes back, seen only by a key with the scope, and
once the school has stopped a removal is still buried and told to the key
with the scope (not to one without it), but not of a row created and
removed within the stop, nor what was reported meanwhile for a pupil who
leaves, while a row versioned as the stop was decided still is; and
nothing is versioned (159). The
adapter probe's (nv-a)–(nv-m) run the same through the real services,
including that a school that never shared records nothing, the school's
timezone, a gallring night, a subscription that stops hearing when the
school stops sharing, an unfiltered /deletedEntities that still tells a
departed person and what went while the school is stopped and never what
was reported and went within it, an integration
that misses a stop and a start between two reads and is still told
everything (nv-j), a start decided while a notice is in flight (nv-k), and
register saves, phone-style for as long as an apply that links their
pupils stays open, each going through at once while the apply moves only
the pupils' own rows, stamped as it commits (nv-l), the real apply writing
e-mail addresses last, so a register save naming such a pupil goes through
until then (nv-n), and a start that waits
for a removal or a writer which read "not shared" (also at a school that
never shared), a save that goes through at once, versioning as if the
school shared, and a removal that waits while a start is being written, a
row committed while a stop is being written that is told when it goes
within the stop, a save during a start that never commits whose
record, removed within the stop, is told to nobody, and a decision that
answers 409 after waiting 5 s (nv-m).

The seven migrations after `20261114090000` exist for production's sake: it
migrates while the previous API serves requests, and the reviewed single
migration deadlocked with a register save, a lesson deleted, the webhook
tick and a provider read on a throwaway Postgres 17 (each time the request
was the side aborted). Now each migration takes its locks first, all at
once or none (NOWAIT, retried every 50 ms, giving up after 30 s with
nothing changed, as `20261104090000` does), each table in the weakest mode
it needs, so it never waits while it holds a lock and no request queues
behind it; the two indexes are built CONCURRENTLY; and the four tables requests
take in contradicting orders (keys, subscriptions, versions, tombstones)
are changed one per migration, so each needs only its own table free.
Raced against the same five request shapes, none of the eight ends either
side.

Section 4b runs both principals on a connection where an earlier transaction
set user claims, as a pooled connection has after any user request. PostgreSQL
leaves that setting reading `''` after COMMIT, not unset. The plain-PostgreSQL
fallback `auth.uid()` raised on `''` until `20260914230000`, and every policy
calling `app.current_school_id()` raised with it, so both helpers answered 500
there. Supabase's own `auth.uid()` reads `''` as no user, and that migration
leaves it untouched.

**The consumer's principals.** The sync acts as
`PrismaService.withSyncPrincipal` (`app.sync_school_id`, no claims): it reads its
school's people, groups, links and source, and writes narrowly — guards refuse it
anything but names, the class and the deactivation of a pupil or guardian on
`Users`, the cursors on its source, inserts of memberships and guardian links,
and duty links; it has no DELETE arm anywhere and cannot write an `ss12000Id`,
which only an admin's own claims can. `Ss12000SourceSecrets` has RLS with no arm
and no grant; only `app.ss12000_source_secrets` hands a ciphertext out, to the
school's sync principal or SCHOOL_ADMIN, never to the service principal of these
read endpoints. Every unlink of a guardian is recorded in
`GuardianStudentHistory`. RLS suite §30 asserts all of it.

**The provider's principal (v2.0).** Every v2 request runs in
`withServicePrincipal(schoolId, fn, {keyId})`, which also sets
`app.service_key_id`. The subscription arms name it, so a key reads, renews
and ends only its own subscriptions. `20261014130000` added SELECT arms for
the service principal on `StudentEnrollments`, `StudentGroupMembers`,
`AcademicYearTimplans`, `LocalTimplans`, `Ss12000DutyLinks`,
`Ss12000EntityVersions` and `Ss12000Tombstones`: what v2 emits, of its own
school only. `20261031090000` added `school_units_service_select` on
`SchoolUnits` (TO app_authenticated, as every arm there: the admin's FOR ALL
and the sync principal's SELECT); RLS suite §130–133 and probe se1–se6 hold
them. **There is no service arm on `Ss12000Sources`**, since an arm
cannot restrict columns and the source's row holds its base and token URLs.
`app.ss12000_provider_identity()` hands the principal the organisation ids and
skolenhetskoder only. Versions and tombstones are written by triggers alone;
the API holds SELECT. `IntegrationKeyWebhookSecrets` has RLS with no arm and
no grant. Only the delivery context (no claims, no principal) receives a
ciphertext, through `app.ss12000_webhook_secrets`. The delivery functions
refuse every principal. RLS suite §31 asserts all of it, and the adapter
probe's sp-a to sp-e check the provider against Postgres.

Wire personnummer/civic numbers are intentionally not accepted or stored.

## Positioning

`/activities` + `/calendarEvents` are the "lesson export" that lets SchemaPro
act as the scheduling engine feeding an existing Skola24/Vklass installation —
the adoption wedge from the parity roadmap.
