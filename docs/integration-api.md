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
| `meta` `{created, modified}` | yes | always | the post's `createdAt`; `modified` = the latest `updatedAt` of the post and its mentorships (best effort: a deleted mentorship does not move it; and it moves when a field this feed never sends changes — see below) |
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
  nedsättning, riktmärke, note or avtalsform moves it while every field the
  feed sends stays the same. A system polling the feed can see that something
  it is not shown changed on that teacher's post at that time. SchemaPro has
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
address serving many schools does not share one bucket. Before a key is known,
600 attempts a minute per address. Past either limit the answer is 429
`TOO_MANY_REQUESTS` with `Retry-After`.

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
  `SORTKEY_NOT_SUPPORTED` and `INVALID_BODY`. 503 `TOO_LARGE` is S1's
  "Svaret är förstort" (a calendar lookup over 5000 events). The message never
  echoes a value you sent. **Logs carry the method, the path and the status,
  never the query string**, so a personnummer or a name in a filter never
  reaches a log line.
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
| Organisation | the source's skolenhet id when exactly one is chosen (organisationType `Skolenhet`, with its `schoolUnitCode`); with several, the school's own id as a `Skola`; with none, the school's own id as a `Skolenhet` |
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

**Organisations** (`organisations.read`): `id`, `meta`, `displayName`
(Schools.name), `organisationType`, `schoolUnitCode`, `schoolTypes` (the
active year's timplans: GRUNDSKOLA→`GR`, its årskurs 0 →`FKLASS`,
ANPASSAD_GRUNDSKOLA_AMNEN→`GRS`, ANPASSAD_GRUNDSKOLA_AMNESOMRADEN→`TR`,
SPECIALSKOLA→`SP`, SAMESKOLA→`SAM`; 2.1.0 still names grundsärskola and
träningsskola).

**Persons** (`persons.read`; guardians need `responsibles.read`): active users.
`givenName`, `familyName`, and `emails` with one entry: `Skola elev` for a
pupil, `Skola personal` for staff, `Privat` for a guardian. A pupil with an
open class segment and a derivable school type has `enrolments`: `enroledAt`,
`schoolType`, `schoolYear` (only 0–10) and `startDate`. `startDate` is the
start of the pupil's unbroken chain of class segments, so a class move is not
a new enrolment, and there is no `endDate` while the pupil is active.
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

**Duties** (`duties.read`): the active year's posts, built by the same
`toSs12000Duty` as v1's `/duties`. `dutyPercent` and `hoursPerYear` are sent
only when the school turned `shareEmploymentWithIntegrations` on. The
nedsättning, the target and the note are never selected. The ids are then
translated as above. `expand=person`.

**Activities** (`activities.read`): **the published** weekly timetable of the
active year. That is the live masters in DIRECT and the publication's snapshot
valid now in DRAFT, read through the same `readGrundschema` as v1's
`/activities`; a draft edit is never served, and parked lessons are not
activities. `displayName` (`<subject> — <group>`, as in v1),
`calendarEventsRequired`, `startDate`/`endDate` (the master's dates or the
year's), `activityType` (`Undervisning` when the subject counts toward the
timplan, else `Elevaktivitet`, S1's own example being mentorstid), `groups`,
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
activity's. When the lesson has a vikarie, the event's teachers are the
SUBSTITUTE rows (the vikarie participates, the planned teachers do not);
otherwise every row counts. **Only the fact: never an absence, a reason, the
lesson's note or a cancel cause.** `expand=activity`. `expand=attendance` is
403: no scope grants attendance (see "Left out").

**Rooms** (`rooms.read`): `displayName`, `seats` (capacity, when set),
`owner`.

**Syllabuses** (`syllabuses.read`): one per subject when the active year's
timplans have exactly one school form (S1 requires `schoolType`). Fields:
`subjectName`, `subjectDesignation` (the national code such as `MA`, not S1's
`subjectCode` such as `GRGRMAT01`, which is never sent), and `official`. A
school with none or several forms serves no Syllabus, and its activities carry
no `syllabus`.

**DeletedEntities**: `{data: {persons, groups, duties, activitites,
calendarEvents, rooms, syllabuses, organisations}, pageToken}`. The keys are
S1's own spellings, `activitites` included. The response has only the
categories asked for that the key may read, with the ids removed after
`after`. "Removed" means: a person deactivated or deleted, a group, room,
subject or lesson deleted, a master deleted or parked (DIRECT) or absent from
a new publication (DRAFT), a post deleted, an id superseded by a link, and
the activities and duties of a year that stops being active. A future year's
rows are never recorded. Tombstones are kept 400 days. A guardian's id may
appear under `persons` for a key without `responsibles.read`: an id and
nothing more.

**Lookups**: S1's bodies, at most 1000 ids in all. `persons/lookup {ids,
civicNos}` (civicNos match nothing). `organisations/lookup {ids,
schoolUnitCodes, organisationCodes}`. `activities/lookup {ids, teachers,
members}`. `calendarEvents/lookup {ids, activities, student, teacher}`, where
`student` and `teacher` are arrays under singular names, as S1 has them. S1
types the calendar lookup's answer `AttendancesArray`, an evident slip; it
answers `CalendarEvent[]`. The rest take `{ids}`. Unknown keys or values that
are not uuids are 400 `INVALID_BODY`.

### Subscriptions (webhooks)

S1's `/subscriptions`, for the key's own subscriptions only (another key's id
is 404); `subscriptions.write`:

* `POST /subscriptions` `{name, target, resourceTypes: [{resource: "Person"}, …]}`
  answers **201** `Subscription {id, expires, name, target, resourceTypes}`.
  `resourceTypes` takes S1's schema shape, `[{resource}]`. S1's own example
  (`["Organsation","Person","Duty"]`, plain strings, misspelt) is
  non-normative and answers 400. The resources are those the provider emits
  (`Organisation`, `Person`, `Group`, `Duty`, `Activity`, `CalendarEvent`,
  `Room`, `Syllabus`), each needing its read scope. `target` is https with no
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
| `Attendance`, `Absence`, `AttendanceEvent`, `AggregatedAttendance` | Pupils' absence is sensitive, and S1's Attendance carries reasons. It needs its own privacy design |
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
through `POST /persons/lookup {ids}` (S1 `PersonsExpandedArray`). A provider that
refuses an incremental filter makes the run FULL, and later runs too. A run
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
| `securityMarking` ≠ Ingen | — | every change for the person deselected, never automatic, not stored |

Without a stored id, a LINK by email is proposed only for exactly one active
local row with the same role and an address no other source person claims; a
group LINK needs the same name, year and kind. Everything else is a named
conflict for the admin.

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
  night records `SKIPPED` (`REVIEW_PENDING`).

A run's `before`/`after` hold names and emails only while it is `DIFF_READY`;
they are nulled the moment it reaches any other status, and a `DIFF_READY` run
expires after 30 days.

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
school only. **There is no service arm on `Ss12000Sources`**, since an arm
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
