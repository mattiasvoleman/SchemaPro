# Timetable planning & editing

Implemented feature set (Tiers 1–3 of the flexibility roadmap).

## Editing (admin → Master timetable)

- **Drag & drop** — drag a lesson to move it (5-min snap), drag its bottom edge to resize. The ghost turns green/red live based on the client conflict engine; invalid drops are never saved.
- **Smart suggestions** — dropping on an occupied slot opens the nearest conflict-free slots, ranked by distance; click one to apply.
- **Click empty slot / "Add lesson"** — manually create lessons (`POST /api/v1/master-lessons`); delete and duplicate from the lesson editor (`DELETE /api/v1/master-lessons/:id`).
- **Locking** — lock toggle per lesson (manual creates default to locked). Locked lessons survive regeneration: the gateway subtracts them from the requirement demand and sends them to the solver as `fixedLessons` (hard blockers by teacher/group/room). Regeneration now deletes **unlocked lessons only**.
- **Undo/redo** — Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z (or Ctrl+Y) plus toolbar buttons; every step replays through the gateway so validation and audit still apply.
- **Bulk editing** — shift-click lessons to multi-select, then Lock / Unlock / Delete from the bulk bar (single undo step).
- **Conflict surfacing** — existing clashes (teacher/room/group double-bookings, weekly UNAVAILABLE constraints) are highlighted with a red ring and counted in a banner; detection in `web/lib/conflicts.ts` mirrors server validation.
- **Views** — combined grid plus "By teacher / By room / By class" lane views; all lanes stay fully editable.
- **Versions** — save named snapshots, restore any snapshot (an automatic safety snapshot is taken first). `api/v1/schedule-versions`.
- **Audit trail** — every create/update/delete/regenerate/restore is appended to `ScheduleChangeLogs` (before/after JSON, actor).

## One judge for a hand edit (En domare med ord, E1)

A lesson of the grundschema is held to the same rules whichever road it is written by: the PATCH and the create, a block's
card, a swap's apply and a förläggning. `src/calendar/lesson-judge.ts` is the hand edit's: the clash rule
(`findConflicts`: teacher, room, class, shared pupils, weekly closures), the stage's ramtid, the class's meal, the weekly rules
on whole årskurser, and the other schools' holds on a shared teacher or a room (`FRAME`, `LUNCH`, `GRADE_RULE` and
`OTHER_SCHOOL`, the board's rules of `src/swaps/board-rules.ts`), and the school day: a lesson is not put on a Saturday or
a Sunday (`SCHOOL_DAY`, the förläggning's own first question, in its words).

- **A no has a code and the other lesson.** 409 `MASTER_LESSON_REFUSED`, with flat `params`: `reason` (the heaviest),
  `reasons` (all, comma-joined), and the reason's own figures: the other lesson's `className`, `subjectName`, `day`, `start` and
  `end` for a clash (never a person), `resource` for a weekly closure, `schools` for another school's hold, `requirement` for the
  member of a block's card it is about. `detail` is a Swedish sentence for the clients that read nothing else. No write path of
  the grundschema's lessons answers 409 without a code (`lesson-write-refusals.inventory.spec.ts`).
- **Låt stå.** A lesson that already stands against a frame, a meal, a rule on årskurser, another school's hold or the school
  day may be changed on anything but where it stands: the board's rules are asked of an edit that moves its day, clock, dated
  window or classes (a change of weeks from every week to odd ones moves none of them), another school's holds of what the edit
  CHANGES (a teacher or room it did not already have: a lesson whose teacher is held elsewhere may be given another room), the
  school day of an edit that changes the day, as a förläggning that has stopped holding may be saved beside its rows. The clash
  rule is not eased.
- **The läsande frågan.** `POST /api/v1/master-lessons/judge` asks one or more tänkta drag, judged together as one move, with the
  PATCH's verdict on the rules above and nothing written: `{ ok, moves: [{ lessonId, ok, placed?, refusals: [{ reason, params, text }] }] }`.
  It does not answer for the whole PATCH: the staffing policy's REFUSE (a teacher without behörighet in the subject) is asked
  only when the edit is saved, after the judge, and answers 409 with its own code (`STAFF_TEACHER_NOT_QUALIFIED`); the
  question says ok where the save then says that.
- **Held in place by** `scripts/test/probe-domaren.ts` (the same drag through the hand edit's, a swap's and a förläggning's judge
  over real Postgres, with the cases in `src/calendar/__fixtures__/lesson-judge-cases.json` that the web's mirror is held to) and
  `src/calendar/lesson-judge.property.spec.ts` (the other schools' holds and the board's rules over random facts).

## Undantag med flit (E1b)

Under a no for the stage's ramtid or the class's meal the administrator may answer **"Lägg ändå"**. It is a question that says what
breaks, and only an administrator (the route's own role) can answer yes. Nothing else can be answered yes to: the teacher, the room,
the class and its pupils, a closed hour, a rule on årskurser, another school's time and the school day are refused with the same code
whatever the request names (decision 5: no forced clash).

- **By name.** `exempt: ['FRAME' | 'LUNCH']` on the PATCH, the create and the läsande frågan (`moves[].exempt`). The judge answers
  EVERY board rule a time breaks (`reasons: 'FRAME,LUNCH'`; `boardCodeOf` of a swap names the first only), so an exemption for the ramtid
  does not hide the lunch: what is named is let through, what is not is still asked. `exempted` says what the answer yes would save,
  `exemptable` whether the refusals are the ramtid and the meal and nothing else. A rule named that the time does not break is saved on nothing.
- **Saved on the lesson.** `MasterLessons.exemptFrom text[]` (`FRAME`, `LUNCH`, a CHECK on the two names; the same column on
  `PublishedLessons`), and the lesson is locked in the same breath (a request that names a rule and says `isLocked: false` is a 400). The
  lesson says it only when it has one (`exemptFrom` in the result, a version's blob, a publication's snapshot): every other lesson is
  the object it was.
- **For the time it was given for.** The trigger `MasterLessons_exemption_ends` takes it away when the day, clock, dates, lock or tray
  of the lesson change, for any writer that does not know the column (a swap's apply, an import, a restore): a writer that decides the
  exemption itself says `app.keep_exemptions = on` for its transaction (the PATCH that answers yes again for another breaking time,
  a discarded draft). The PATCH writes `exemptFrom` itself and answers `EXEMPTION_ENDED` (`params.rules`) when an edit ended one.
  Another time that breaks the rule asks again.
- **Generera and the engine.** An exempt lesson is locked, so Generera keeps it and plans around it. The engine needs nothing for the
  ramtid (a lock may lie outside its class's frame); for the lunch the payload names the lock (`fixedLessons[].exemptFromLunch: true`,
  sent only on a lock whose lesson has the exemption) and the engine no longer refuses a meal the school placed by hand on it
  (`LUNCH_PLACEMENT_COLLIDES`, `FixedLesson.exempt_from_lunch`). A meal the engine lays itself is still laid clear of the lock, and a
  reserved hour of the class is still a reservation. `scripts/test/probe-undantag-motor.ts` shows it against the real engine (by hand).
- **No automat gives one or moves one.** Generera, the swaps and Optimera salar never write the column; a lesson with an exemption is
  locked, so none of them moves it. A block card's members that move lose theirs (the card is judged against every rule and asked of no one's yes).
- **The seams.** A version's blob and its restore, a publication's snapshot and a discarded draft (a changed exemption is a change of
  the draft), the schedule file (the column `Undantag`: `Ramtid | Lunch`; read into another school the import lets through the rules the
  file names and the lesson breaks, never the rast or a clash, and refuses a word that is none of the two) and the publication check
  (`PUB_EXEMPTIONS`, information: the number of lessons and the rule each stands against).
- **Held in place by** `scripts/test/probe-undantag.ts` (the table and its trigger, the PATCH over real Postgres, a version, a
  discarded draft, the schedule file in and out), `src/calendar/lesson-judge.exempt.property.spec.ts` (the same drag with and without a
  name gets the same verdict on every rule but the one named) and `src/calendar/master-lessons.judge.exempt.spec.ts`.

## Brickorna och ägandet (E4)

- **Ett lås vid en flytt.** En olåst lektion som flyttas för hand (en annan dag, ett annat klockslag, andra veckor, eller tillbaka från parkeringen) låses av
  `PATCH /api/v1/master-lessons/:id`, och svaret säger det (`lockedByMove: true`): annars lägger nästa Generera om det handen just flyttat. Det gäller inte ett lås som
  begäran själv satte eller tog bort (en låst lektion som flyttas med `isLocked: false` låses upp), inte en lektion som redan är låst, inte en ny sal eller lärare
  (det flyttar ingenting av var lektionen står) och inte en lektion i ett parallellt block, vars lås är blockets (Lås blocket). Sidan säger "Flyttad och låst" och
  ger Lås upp; ett ångrat flyttande tar låset med sig, eftersom ögonblicksbilden bär lektionens lås.
- **Att låsa eller låsa upp frågar inte klashregeln** (granskaren g461, L-5). Ett PATCH som inte ändrar något domaren läser (dag, klockslag, veckor, lärare, sal,
  klasser, elever) och inte namnger `exempt` flyttar ingenting och krockar inte med något nytt, så en lektion som redan är dubbelbokad kan låsas och låsas upp.
  En ny sal, en flytt och en ny lärare frågas som förut.
- **Ett undantag ges inte åt en lektion på parkeringen** (granskaren g467, L-3): `exempt` på en lektion som redan ligger på parkeringen är 400, och den läsande
  frågan svarar inget undantag för en sådan. Det PATCH som parkerar lektionen får bära `exempt` (webbens Gör om skickar lektionens ögonblicksbild, undantaget med):
  parkeringen frågas inget och tar undantaget, så inget sparas och inget nekas.
- **Hålls av** `scripts/test/probe-brickor.ts` (mot riktig Postgres: en Generera-lektion är inte kvarhållen förrän den flyttats, då är den det, och en dubbelbokad
  lektion kan låsas) och `src/calendar/master-lessons.lock-at-move.spec.ts`.

## Tier 3

- **Minimal-disruption re-optimization** — the gateway sends the current unlocked placements as `previousLessons`; the solver is rewarded (weight `disruption`) for keeping lessons on those slots and warm-started with them as hints. Mid-term re-runs now change as little as possible.
- **Room-type eligibility** — `Subjects.requiredRoomType` (set in the Subjects page); the solver only places such subjects in matching rooms (hard constraint + INFEASIBLE explanation).
- **Richer objectives** — PREFERRED_FREE/BUSY now also apply to rooms and student groups; a `spread` objective penalizes same-subject lessons stacked on one weekday.
- **Optimization profile UI** — sliders on the Generate page (stability / spread / preferred-free / preferred-busy), persisted per browser, sent per run, all engine-side defaults env-overridable (`WEIGHT_DISRUPTION`, `WEIGHT_SPREAD`).
- **Durable job store** — `OptimizationJobs` table replaces the in-memory queue: the row outlives the API process, and powers the run-history list on the Generate page (`GET /api/v1/optimization/jobs?academicYearId=…`). A run is a queue entry: a lease the process renews while it works, at most one active run per school year (a second start is 409 `GENERATE_ALREADY_RUNNING`), and a sweep that ends a run whose process went away as `ENGINE_RUN_ABANDONED` — see docs/DEPLOYMENT.md §27.
- **Version diff** — compare any snapshot against the live timetable (added/removed lessons) before restoring (`GET /api/v1/schedule-versions/:id`).
- **iCal export & print** — download the filtered timetable as weekly-recurring `.ics` events, or print the current view.
- **Keyboard editing** — focus a lesson: arrow keys move it (±15 min / ±1 day, validated like drags), Enter opens the editor, Shift+Enter toggles selection.

## Tier 4 (final batch)

- **Realtime collaborative editing** — the socket.io gateway now tracks presence per school (`timetable:presence` → `timetable_presence` roster) and broadcasts `master_timetable_updated` on every create/update/delete. A change of a few lessons (a create, an update, a removal, a block's move or lock) says which in `lessonIds` (opaque ids, at most 200, said once the transaction has committed); any other change, and a client from before the field, reads the year again. The timetable page shows who's online, badges lessons a collaborator has open (soft edit-lock with an overwrite warning), and refetches live when anyone changes the schedule. Web client: `web/lib/use-timetable-realtime.ts` (new dep `socket.io-client`).
- **Co-teaching in generation** — `TeachingRequirements.coTeacherId` (set in the Requirements grid). The solver schedules both teachers together (no-overlap, availability and preferences apply to both), the master lesson carries `coTeacherId`, publishing creates a LEAD + ASSISTANT assignment pair, and both server- and client-side conflict validation include the co-teacher.
- **School rules in the solver** — guaranteed lunch break per class (window + minutes, hard constraint) and max lessons/day per class, configurable on the Generate page; teacher-gap minimization as a weighted objective ("compact teacher days" slider).
- **Date-specific constraints in the solver** — one-off dated UNAVAILABLE/PREFERRED constraints now act as soft weekday signals during generation (weight `WEIGHT_DATE_UNAVAILABLE`), while publishing continues to enforce dated absences exactly.
- **PDF export** — `web/lib/pdf.ts` renders the filtered timetable as a day-sectioned PDF (new deps `jspdf`, `jspdf-autotable`), alongside the existing iCal export and print.
- **Open-slot finder** — in the Add-lesson dialog: pick a subject and class (plus optional additional classes that must also be free, e.g. for joint activities — a student's availability is their class's), then "Search open slots". The finder scans the week for slots where every chosen class is free (lessons incl. co-teachers + weekly UNAVAILABLE constraints) and pairs each slot with the class's **assigned subject teacher** from the requirements matrix; when no assigned teacher is free in a slot, it offers a **fallback teacher** who teaches the subject and is free (marked "fallback"). Assigned-teacher matches always rank first; clicking a match fills day, time, and teacher into the form. Logic in `findOpenSlots` (`web/lib/placement-search.ts`), which the timetable fetches with the lesson dialogs.

## Swaps and chains (Byten och flyttar, G1)

`POST /api/v1/swaps/suggest` answers, for one picked lesson, the **swaps**
(two units exchange slots) and **chains of three** (A to B's slot, B to C's, C
to A's) that hold every hard rule, each with the parallel lessons that go along
and what it costs in the soft ones. `POST /api/v1/swaps/apply` writes a
proposal. Code in `src/swaps/`, dialog in `web/components/schedule/swap-dialog.tsx`
(button "Föreslå byten" in Justera lektion).

- **One definition of the hard rules.** Every proposal offered has been judged by
  `MasterLessonsService.findConflicts` (teacher, room, class and shared pupils,
  weekly unavailability, pupil buffers, halves, replacing groups) as ONE move —
  the movers left out of where they stood and laid where they go, the way a
  block card is moved. On top of it the grid's own hard kinds: ramtider, the
  class's lunch sitting, weekly rules on whole årskurser, and the other schools'
  holds (a shared teacher's lessons elsewhere, a room lent out or borrowed,
  `other-school-holds.ts`). The search prunes with a *subset* of the clash rule
  (same teacher, room, class, weekly row), so the prune can lose a proposal, never
  admit one. `swaps.service.spec.ts` holds the search against a brute force that
  knows only "does anything overlap": it finds exactly the clash-free swaps and
  chains. `SwapReads` (a `ConflictReads`) answers the rule's day read from the
  year snapshot; a spec shows the same answers as the database read for every
  placement.
- **Why the API and not the engine.** The engine's rules are constraints of a
  model, not predicates; asking it means rebuilding the school's model per
  question with anonymised ids both ways. The write path's rules are functions.
  The engine, its contract and `/openapi.json` are untouched, so there is
  nothing to deploy beside the API and no per-school switch.
- **A unit moves whole.** A lesson and the lessons laid beside it at the same
  day, clock and weeks: the same parallel block (or a block on its times), the
  two halves of one class, a replacing group and the class lesson it replaces
  with a pupil in common. `apply` refuses a move set that parts one
  (`SWAP_SPLITS_PARALLEL`), moves a locked lesson that is not the picked one
  (`SWAP_LOCKED`), or names a lesson that no longer stands where the page saw it
  (`SWAP_STALE`). Slots must be of one length.
- **Soft costs** (counts, never words): pupils' idle minutes (the håltimmesrapport's
  number — `swap-gaps.spec.ts` replays all cases of
  `src/common/__fixtures__/pupil-gaps-cases.json`), teachers' idle minutes,
  ämnesfördelning breaches, teacher-day breaches (cap, days, stretch; the post's
  limits are HR data, so a count and a read recorded as EMPLOYMENT), and lessons
  moved. Travel between sites and the delade lektioner's shares are not measured.
- **Apply** is the template's write path: `enterGrundschemaWrite` (DRAFT or
  DIRECT), the edit's share of the regeneration lock, rows held `FOR NO KEY UPDATE`
  in id order, a safety version (`snapshotInTransaction`), a guarded
  `updateMany` per lesson, `propagateTemplateChange` to the published calendar, a
  `ScheduleChangeLogs` row per lesson, the `SCHEDULE_CHANGED` notice, realtime. The
  answer's `undo` is the same moves reversed; send them to the same route.
- **What it takes out of the calendar, said beforehand.** `propagateTemplateChange`
  removes (does not move) a published calendar lesson that a move would carry
  to a time that has begun, or off the template's weeks ("never into the past"),
  and its vikarie, lesson log and homework go with it (`ON DELETE CASCADE`).
  A swap always moves a lesson to an earlier weekday, so it can. Each proposal of
  `suggest` carries `removedCalendarLessons`: the count of those rows, computed
  from the rows `reconcilableLessons` selects by `wouldRemoveOnUpdate` — the
  same `standsAt` decision the write path makes, held to the same number by
  `swap-calendar.spec.ts` — and zero in a DRAFT layer, which leaves the calendar
  alone. `apply` answers `removedCalendarLessons` too. **Undo restores the
  master lessons and moves the followed calendar lessons back; it does not
  recreate removed ones** (nor their vikarie or log). Publishing again creates new
  rows at the old times. The dialog says so before Tillämpa and after Ångra.
- **A clock is 00:00 to 23:59.** The apply's clocks are `^([01]\d|2[0-3]):[0-5]\d$`
  and the minutes the clash rule judges are read from the *parsed* time
  (`clockMinutes`), the value that is written: `parseTimeString` wraps an hour
  past 23 into the next day, so `34:00` used to be judged at minute 2040 and
  stored as 10:00.

## Lesson participants (multi-class & individual students)

A lesson keeps its primary class but can additionally contain **extra classes**
and/or **individual students from any class** (joint activities, electives,
support lessons). Data model: `MasterLessonGroups` / `MasterLessonStudents`,
mirrored to `CalendarLessonGroups` / `CalendarLessonStudents` at publish.

- **Editing** — the Add-lesson dialog has class chips (extra classes) and a
  searchable student picker; Duplicate carries participants along. The
  `PATCH /master-lessons/:id` endpoint accepts `extraGroupIds` / `studentIds`
  replacements.
- **Conflicts** — server and client validation treat a lesson as occupying
  *all* its classes, and an individual participant is busy whenever their own
  class has a lesson, they attend another lesson individually, or (symmetric)
  a lesson of their class is being placed. Grid cards show `+N` (extra
  classes) and `⊕N` (individual students).
- **Slot finder** — participant students' home classes must be free and their
  other individual lessons block the slot.
- **Publish** — participants are copied onto every materialized calendar
  lesson.
- **Attendance** — the teacher's attendance roster, on the web
  (`useLessonRoster`) and in the teacher app (`fetchRoster`), reads
  `GET /api/v1/attendance/lessons/:id/roster`, which asks the one roster
  reader (`src/calendar/lesson-roster.ts`): the primary class, every extra
  class, their teaching groups and individual participants, active pupils
  only (deduplicated); recording works unchanged.
- **Student visibility** — RLS `*_participant_select` policies on
  `MasterLessons`/`CalendarLessons` make participant lessons appear in
  students' schedules automatically (individually or via their class being an
  extra class), on top of the primary-group policy. On `CalendarLessons` an
  extra group that is one of the student's teaching groups counts too (a SvA
  group joined to another class's svenska), and
  `calendar_lesson_groups_member_select` shows them that extra-group row, as
  their guardian sees both (20261208090000).

- **Versions** — snapshots capture participants and restores recreate them.
- **Regeneration** — participant lessons are treated like locked lessons even
  when unlocked: preserved verbatim, subtracted from the primary class's
  demand, and forwarded to the solver as fixed blockers covering *all* their
  classes (`FixedLesson.extraGroupIds`).
- **Reports** — the per-class attendance report counts records by the
  *student's* class (not the lesson's primary class), so electives and
  multi-class lessons land in the right class's numbers.

Remaining by design: the generator never *creates* participant lessons — they
are manual constructs (use the open-slot finder), which regeneration now
always preserves.

## Migration

```bash
DIRECT_URL=<owner direct URL> npm run migrate:deploy
                            # 20260712100000_lesson_locking_and_change_log
                            # 20260713080000_tier3_solver_and_job_history
                            # 20260713120000_co_teaching
                            # 20260713150000_lesson_participants
npm run prisma:generate      # needs no database
cd web && npm install        # socket.io-client, jspdf, jspdf-autotable
```

The owner connection goes on the command as `DIRECT_URL` (docs/DEPLOYMENT.md
§2): since Prisma 7 the CLI reads no `.env` and never `DATABASE_URL`.

Adds `MasterLessons.isLocked` + `coTeacherId`, `Subjects.requiredRoomType`, `TeachingRequirements.coTeacherId`, `ScheduleChangeLogs`, `ScheduleVersions`, `OptimizationJobs` (all RLS-protected, admin-only for the new tables).

## Engine

`optimization-engine` accepts `fixedLessons`, `previousLessons`, `weights` (incl. `teacherGap`), `rules` (lunch/max-per-day), room `type`, requirement `requiredRoomType` and `coTeacherId` in `POST /api/v1/optimize` (and the legacy `/v1/schedule`). Fixed windows are rounded outward to whole slots, so off-grid manual placements still block correctly. Covered by 14 tests in `tests/test_optimize.py`, including `test_co_teacher_prevents_overlap` and `test_lunch_break_rule_is_enforced`.
