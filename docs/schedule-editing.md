# Timetable planning & editing

Implemented feature set (Tiers 1–3 of the flexibility roadmap).

## Editing (admin → Master timetable)

- **Drag & drop** — drag a lesson to move it (5-min snap), drag its bottom edge to resize. The ghost turns green/red live based on the client conflict engine; invalid drops are never saved.
- **Smart suggestions** — dropping on an occupied slot opens the nearest conflict-free slots, ranked by distance; click one to apply. A time is offered only if the page's own check lets it through **and** the gateway's possible-times answer calls it free (`startsTheGatewayLets`, `web/lib/possible-times.ts`): the page holds no room lent to another school, nor a teacher's lessons there (OTHER_SCHOOL), and the answer the board holds for a dragged lesson is read, else asked, and where it does not come in time (2.5 s) or comes in another shape the page's check alone decides, as before.
- **A stretch painted "Ledigt, annan sal" is laid with the mouse too** — while a lesson is dragged the board paints where it can stand; over a square of a stretch that is free only in another room the ghost turns valid and carries that room (`PossibleHold` follows the ghost and the answer, `web/components/schedule/possible-layer.tsx`), and the drop moves the lesson there with `roomId`, as Enter does. Only a move of the lesson's own length: a resize is not a start the gateway judged.
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
  The file's first eighteen worlds have a class with no pupil in it, one class to a lesson, no window of dates and no other school;
  the worlds from the nineteenth on (`generateRichWorlds`, their cases after the first eighteen's) carry pupils with a home class,
  teaching groups of pupils from several classes (PUPILS), lessons with an extra class or with pupils named on them, lessons and
  meals that run in a window of dates, and a room that a second school has borrowed for an hour (OTHER_SCHOOL). The förläggning's
  judge is not asked to agree on a lesson that has an extra class or a named pupil: its row is a post's and has no word for them.
  The board's painting (`probe-mojliga-tider.ts`) is held to the same file, so a time the board paints open or closed is the time
  the judge lets through or refuses in every one of its worlds. After those come four richer worlds with no pupil named on a lesson
  (the possible-times probe holds its prune exact only where none is, since it cannot see one) and six edge worlds
  (`generateEdgeWorlds`), written by hand, that ask each turn of a comparison on both sides: a pupil named on two lessons, two windows
  of dates that meet on one day, a window that touches a meal's first or last day, an extra class of the younger stage's ramtid, a
  teaching group no pupil of which the ramtid reaches, and an hour lent to another school that a lesson touches without covering; a seventh asks for pupils who have left (`Users.isActive` false, `inactive` in the world): the
  judge reads active pupils only, so two groups, or a group and a class, that share only such a pupil share none, and a ramtid is read from the pupils who are there. The page reads the
  gateway's memberships the same way (`activeMemberships`, `use-schedule-engine.ts`).

## Att lägga: grundschemats bricklåda (E4)

`GET /api/v1/board-tray?academicYearId=…[&groupId=…]` (`src/board-tray/`) svarar med en **bricka** för varje lektion en timplanspost har kvar, räknad som Generera räknar:
samma funktion (`demandLeftOf`, `post-demand.ts`) genom samma läsning som Förlägg i veckan ritar sina poster med (`boardPostOf`), så att talet på brädet och talet Generera
skickar är ett. En skillnad, och den är brädets: det som redan står på grundschemat svarar en lektion, också det Generera lagt och ingen låst (Generera raderar det fria före
sin räkning, brädet visar det stående). En förläggning svarar en lektion och sägs för sig, en parkerad lektion svarar ingen, och en post i ett parallellt block läggs med
blocket (`blockId`, `cannotPlace: 'BLOCK'`). Ingen person nämns, bara id.

Svaret har `bricks` (den valda klassens, eller årets; längsta lektionerna först i fast ordning, `possibleTimes: null` tills E3:s fråga finns), huvudets tal (`tally`:
lektioner, lagda, svarade av en förläggning, kvar) och `groups` (kvar per klass, för klassväljaren). En läsning varje administratör får göra.

Hålls av `scripts/test/probe-att-lagga.ts` (mot riktig Postgres: samma tal som Förlägg i veckan, fria och parkerade lektioner, en förläggning, en annan skolas år) och, för hand mot
en riktig motor, `scripts/test/probe-att-lagga-motor.ts`: brickorna per post är det motorn sedan lägger, och facket är tomt efteråt.

### Att lägga en bricka (E4, läggningen)

`POST /api/v1/board-tray/lay` lägger en bricka på en tid. Brickan har en **bild** (`partKey`: hash av postens del — lärare, minuter, antal, låsta, lagda, kvar och id:na på de parkerade lektioner som är delens brickor; en lektion som flyttas i tid ändrar den inte), som läsningen
ger och som skrivningen jämför med det den ser med låset taget. Två som läst samma bild och lägger varsin: den första skriver, den andra får `409 REQUIREMENT_PLACEMENTS_STALE` (samma kod som
Förlägg i veckan) och ingenting skrivs för den. Läggningen tar årets lås (`enterGrundschemaWrite`, `lockYearForGrundschemaEdit`) och sedan postens (`lockPostForShares`) före läsningen, i samma
ordning som alla andra skrivningar på grundschemat, och skriver sedan med `createIn`/`updateIn` i samma transaktion, så att domaren (`judgeLessons`) dömer lektionen som varje handläggning och
ingenting läggs vid sidan av den.

- En vanlig bricka blir en ny **låst** lektion (`isLocked: true`, `isGenerated: false`): Generera låter den stå och räknar den som lagd (`PRESERVED_FROM_REGENERATION`), så att ingenting läggs två gånger.
- En **parkerad** lektion är en bricka, nämligen sig själv (`lessonId`), om den är postens egen (samma klass, ämne, lärare och längd) och, tillbakalagd, svarar posten (veckorna och datumen omsluter postens, som `lockCoversDemand` läser en stående lektion). Läggningen flyttar tillbaka den (`updateIn`, `isParked: false`), ingen ny lektion görs och den räknas inte två gånger. En läggning som inte nämner lektionen när delens alla brickor är parkerade lektioner nekas som en gammal bild (`409 REQUIREMENT_PLACEMENTS_STALE`): en ny lektion bredvid den parkerade vore en lektion för mycket.
- En lektion Generera skrivit från en förläggning (`fromPlacement`) vars rad tagits bort står kvar och räknas som lagd; läsningen matchar den mot postens tider i stället för mot raden.
- Utan sal läggs brickan som den är och svaret säger `noRoom: true` (Klart e: "Utan sal"). Salen väljer den som lägger, ur E3:s `room-choices` (rang 1 är den generatorn skulle ta). Läggningen frågar generatorns egen regel för salen (`roomAllowed`: platser, typ, årskurser) och nekar en sal den inte skulle ta med `409 BOARD_ROOM_NOT_ALLOWED` och skälet i `params.reason` (`SEATS`, `TYPE` eller `YEARS`); domaren vägrar dessutom en sal som är upptagen eller stängd, som vid varje handredigering.
- Undantag med flit (`exempt: ['FRAME', 'LUNCH']`) bärs som vid en handredigering ("Lägg ändå"): domaren dömer det, och bara de två reglerna kan nämnas.
- Ett block läggs inte här, och inte heller en bricka utan lärare (`cannotPlace` → `409 BOARD_BRICK_CANNOT_BE_LAID`, med skälet i `params.reason`); en bricka som inte finns kvar efter låset är samma `409 REQUIREMENT_PLACEMENTS_STALE` som en gammal bild.

Hålls av `src/board-tray/board-tray.lay.spec.ts` och `board-tray.identity.spec.ts` (bild, parkerad, föräldralös, tvåa), samt `scripts/test/probe-att-lagga.ts` (al-e…al-g: mot riktig Postgres, två som lägger
samtidigt och en parkerad lektion som läggs tillbaka) och `scripts/test/probe-att-lagga-skrivvagen.ts` (sk-a…sk-f: domaren dömer läggningen som en handredigering, salen, parkerade lektioner, sex samtidiga).

## Possible times (Möjliga tider, E3)

`POST /api/v1/master-lessons/possible-times` answers "where can this lesson stand, and which time is best?" without writing anything. It
is the scheduler's door, as the judge is, and it names one subject: `lessonId` (a lesson that exists; a lesson on the tray is a brick) or
`brick` (a lesson that does not exist yet: group, subject, minutes, and what is known of teacher, room, extra groups, pupils and weeks).
Optional: `days` (Monday to Friday), `from` and `to` (the board's visible day, 07:00–18:00), `stepMinutes` (5) and `limit` (12, at most 40).

- **Every start of the week gets one answer.** `STANDS` (where the lesson stands now), `CLOSED` (a rule shuts the stretch whatever else
  is there: `FRAME`, `LUNCH`, `GRADE_RULE`, `OTHER_SCHOOL` with the schools' names, or `AVAILABILITY` with the resource it closes),
  `FREE` and `CHANGE` (the judge lets it through, `CHANGE` when the room had to be another: the run carries `rooms`, the room each
  lesson of the unit that moves to another stands in as the judge let it through, and a run is cut where those rooms change, so the board can lay
  the lesson on any square of it with the room that square was judged in; for a `brick` the `lessonId` of `rooms` and of `options[].lessons` is `''`,
  as `subject.lessonId` is null, and `roomAt` of the web asks for it so), `IN_THE_WAY` (exactly one lesson that is free
  to move holds the stretch, named by class, subject, day and clock in `blockers`) and `CROWDED` (several, or a locked one, hold it; the run
  says how many). Starts are returned as runs of one answer per day.
- **The order is the written cost.** Each time the judge accepts is costed with the swap search's own soft measure (the pupils' and the
  teachers' idle minutes, the subject's distribution, the teacher's day), plus the school's wishes (`PREFERRED_FREE` breaks, `PREFERRED_BUSY`
  meets) and a small price for another room. `options` are the best `limit`, best first, with `rank`, the figures before and after, the
  wishes and the room each lesson of the unit would stand in. A tie goes to the earlier time.
- **The judge has the last word.** The query prunes in memory (the swap search's snapshot, one read of the year) and asks `judgeLessons`
  about what survives, in the order of the cost, for 1.2 s at most; a time it had no time for is not painted (`stats.truncated`). A time is
  never called free that the judge refuses, and the prune never loses one the judge lets through.
- **A brick** stands nowhere: it is in its pupils' cohorts, its teacher's week and its post's distribution, but counts for nothing until a
  time lays it, so the figures before are the school without it. A parallel block's brick is placed on its own.
- **Never an undantag.** A time that needs one (E1b) is not offered; the query holds every rule.
- **Held in place by** `src/calendar/possible-times.spec.ts` (the prune against a brute force, the order against a count by hand),
  `possible-times.service.spec.ts` and `scripts/test/probe-mojliga-tider.ts` (every start of the week of every lesson of the judge's fall
  file, over real Postgres: the judge and the query must agree).

### What can lie here, and the room chooser (E3)

Two more questions over the same machinery, both the scheduler's door, both writing nothing.

- `POST /api/v1/master-lessons/what-fits-here` turns the question around: the schemaläggare picked an empty `dayOfWeek` and `startTime` on
  the board, and `candidates` are the lessons that are waiting (up to 200, each `lessonId` or `brick`). A lesson on the tray is a brick
  with its own id, so putting it out moves that lesson and creates no new one. The answer has one row per candidate in the order of the
  request (`FREE`, `CHANGE`, `CLOSED` with the rule, `IN_THE_WAY` with the lesson named in `blockers`, `CROWDED`, `STANDS`, `PLACED` for a
  förläggning's lesson, or `UNJUDGED` when the judge's time ran out) and `fits`, the indices of the ones that fit, best first by the
  written cost, each with its `rank`, figures, wishes and the room it would stand in. A candidate fits only when the judge lets it through.
- `POST /api/v1/master-lessons/room-choices` lists the school's rooms for a `lessonId` or `brick` laid at a day and clock: the free rooms
  the generator would put the lesson in first, ranked (the lesson's own room, then its own kind of room, then the smallest that is big
  enough, then its own building), then the free ones it would not (too small, another type, outside the group's years), then the busy
  ones naming the lesson that stands in them (class, subject, day, clock), then the shut ones (a weekly row on the room, or another school's
  hold, named). Each row has its seats against the pupils the lesson needs. The teacher and the class are not part of this question.
- **Held in place by** `src/calendar/room-choices.spec.ts` (against a brute force on the hourly school), `what-fits.service.spec.ts`, and the
  probe's (mt-f/g): every candidate and every room, over the judge's fall file, held against `POST /judge`.

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
- **Ett byte låser det det flyttar** (granskaren g486, M-2). `POST /api/v1/swaps/apply` låser varje lektion den flyttar som inte var låst, i samma skrivning, och svaret säger det
  som ett PATCH gör: `lockedByMove: true` och `lockedLessonIds`, de lektioner byten låste (inte en som redan var låst, som den valda lektionen kan vara). Annars lägger nästa
  Generera om bägge där de stod. En låst lektion är en låst partner: Byt och Föreslå hoppar över den, så ett par som bytt plats byts inte igen av en slump.
  **Utom en lektion i ett parallellt block vars andra lektioner byten lämnar olåsta** (granskaren g505, M-1): Generera vägrar ett block där bara några av lektionerna är
  låsta (`BLOCK_PARTLY_LOCKED`), så ett byte som flyttar ett kort av ett block med flera kort låser inte kortets lektioner, och nästa Generera lägger om blocket som förr.
  Ett block läggs för hand med sitt kort (`block-card`), som låser blocket helt. Flyttar byten blockets alla lektioner, eller är de andra redan låsta, låses de som andra.
  **Ångra** är samma flyttar omvända till samma väg, och den tar låset av igen utan något nytt fält i begäran (den äldre webbens Ångra går som förut): en låst lektion
  som inte är den valda flyttas bara om dess senast loggade ändring var den som låste den (olåst före, låst efter) och begäran för den tillbaka dit den ändringen fann den;
  då låses den upp. Ett lås handen satt efteråt, eller en lektion som flyttats sedan, nekas som förut (`SWAP_LOCKED`).
- **Ett blockkort som flyttas låser sitt block** (g486, M-2). `PATCH /api/v1/master-lessons/block-card` skriver bara dag och klockslag till kortets lektioner, men låser sedan
  blocket helt, med `lockBlock`s egen skrivning: varje placerad lektion i varje medlem, och i ett block på samma tider (en lektion på parkeringen låses inte). Det är blockets
  lås och inte kortets, eftersom Generera vägrar ett block där bara några av lektionerna är låsta (`BLOCK_PARTLY_LOCKED`), så kortets lås ensamt hade flyttat vägran till
  nästa Generera. Svaret har `lockedByMove: true` och `lockedLessonIds`; ett kort som släpps där det stod är ingen flytt och låser inget. Att ta tillbaka låset är
  `lockBlock` med `isLocked: false` och de id svaret nämnde: ett ångrat korts flytt tar inte låset med sig.
- **Att låsa eller låsa upp frågar inte klashregeln** (granskaren g461, L-5). Ett PATCH som inte ändrar något domaren läser (dag, klockslag, veckor, lärare, sal,
  klasser, elever) och inte namnger `exempt` flyttar ingenting och krockar inte med något nytt, så en lektion som redan är dubbelbokad kan låsas och låsas upp.
  En ny sal, en flytt och en ny lärare frågas som förut.
- **Ett undantag ges inte åt en lektion på parkeringen** (granskaren g467, L-3): `exempt` på en lektion som redan ligger på parkeringen är 400, och den läsande
  frågan svarar inget undantag för en sådan. Det PATCH som parkerar lektionen får bära `exempt` (webbens Gör om skickar lektionens ögonblicksbild, undantaget med):
  parkeringen frågas inget och tar undantaget, så inget sparas och inget nekas.
- **Veckorna som skickas med är inte veckorna som skrivs** (granskaren g509, M-3). Justera lektion skickar lektionens veckor (`recurrence`, `startDate`, `endDate`) som
  de stod vid varje Spara, och Ångra skickar dem vid varje återställning. Bara veckor som skiljer sig från lektionens egna lämnar en lektion Generera lagt över till
  skolan (`isGenerated: false`; Generera kan inte lägga datum eller udda och jämna veckor utanför en posts egna, så det enda sättet att behålla dem är att lektionen står
  kvar). Dagen är fönstret: samma dag skriven som tidsstämpel (`2026-08-17T23:59:59+02:00`) är samma första dag. En ny sal, en ny lärare eller en flytt med veckorna som de
  stod lämnar lektionen Generera lagd, och sidans mening "Fri för motorn" stämmer därför också efter Spara, för en ny sal, en ny lärare och ett lås som brytaren visar; en
  flytt eller andra veckor ändrar vem som äger lektionen, och meningen läser inte dem (webben). En flytt låser lektionen (ett lås vid en flytt, ovan), och det är låset som
  håller den. En lektion i ett block frågas om sitt block bara när den flyttas. En lektion i ett block som står i inget kort när den flyttas (inget kort att lämna, inget att
  gå med i) får inget lås och lämnas inte över: Generera lägger om blocket, som efter en dragning (ett PATCH har alltid gjort så). Dialogen gjorde den handgjord förut, av
  samma slump som ovan.
- **Hålls av** `scripts/test/probe-brickor.ts` (mot riktig Postgres: en Generera-lektion är inte kvarhållen förrän den flyttats, då är den det, en dubbelbokad
  lektion kan låsas, ett byte låser sina två lektioner och Ångra tar låset av, ett blockkort låser hela sitt block, och Justera lektions Spara lämnar bara över en lektion vars veckor ändrats, br-w), `src/calendar/master-lessons.lock-at-move.spec.ts`,
  `src/swaps/swaps.apply.spec.ts` och blockkortets prov i `master-lessons.service.spec.ts`.

## Skriv in förläggningarna (E4b)

En skola som har förlagt lektioner och inte får Generera att gå klart behöver ett schema att arbeta i. `POST /api/v1/placement-write-in` (`{ academicYearId }`) skriver årets förläggningar
till grundschemat som de lektioner Generera hade skrivit ur dem, och frågar inte motorn. `GET /api/v1/placement-write-in?academicYearId=…` svarar vad en skrivning skulle göra utan att
skriva något (varje administratör får läsa det, skrivningen är schemaläggarens som en handredigering). Svaret har `lessonsWritten`, `lessonsReplaced`, `postsWritten`,
`calendarLessonsRemoved`, `safetyVersionId` och `notWritten`.

- **Vad som skrivs.** En förläggning som veckan håller (samma dom som brädet och Generera ger, `RequirementPlacementsService.judgedYear`, mot de lektioner Generera behåller och mot varandra) och som
  anger en sal. Lektionen är postens vid radens dag, klockslag, sal och veckor, **låst, Genereras egen och märkt från en förläggning** (`placedLessonWritesOf`, den enda platsen utanför hämtningen som gör en
  förläggning till en lektion), så nästa Generera skriver om den ur raderna som de då står och en handredigering kan inte flytta den (`LESSON_IS_PLACED`).
- **Vad som lämnas, med skäl i `notWritten`.** `REFUSED`: veckan håller inte raden (domen följer med; en krock nekar båda raderna, som Generera nekar hela körningen), eller generatorn skulle inte ta salen (`verdict.reason` är då `BOARD_ROOM_NOT_ALLOWED`, med salen och `reason` `SEATS`, `TYPE` eller `YEARS`: färre platser än elever, en annan sorts sal än ämnet kräver, eller årskurser salen är avstängd från). Det är samma regel som en läggning i den salen nekas med (`roomAllowed`, `placement-room-refusal.ts`): ett lås med sal frågar motorn inget om salen, men en lektion bron skriver för hand hålls till läggningens regel. Salarna frågas för alla raderna på en gång. `NO_ROOM`: raden lämnar salen åt motorn,
  och bara motorn väljer sal. `BLOCK`: ett blocks förläggningar är motorns (ett lås i ett block är ett delvis låst block). De ligger kvar som förläggningar och Generera lägger dem.
- **Vad den ersätter.** De lektioner en tidigare körning skrev ur förläggningar för en post bron skriver för, som Generera raderar dem före sin skrivning: en rad som flyttats skrivs inte bredvid sin gamla lektion.
  Det som svarar en rad bron inte skriver (motorns sal, eller en rad som slutat hålla) står kvar, tid för tid, annars tar bron bort det bara motorn kan lägga tillbaka. En post bron inte skriver för rörs inte.
  En lektion som redan är precis det raden skulle skriva (samma lärare, sal, klockslag och veckor) lämnas, och raden skriver ingen kopia: en andra skrivning över samma rader ändrar ingenting
  (inga nya id, ingen version, ingen loggrad, inget i kalendern).
- **Hur.** Som varje omskrivning av året: läget, sedan årets regenereringslås (exklusivt, högst 5 s, annars `409 SCHEDULE_BUSY`), sedan läsningarna den bestämmer av, en återställningspunkt (en version, som ett byte tar en),
  kalenderns daterade lektioner för de ersatta från skolans idag (i läget Direkt, som en regenerering), ersättningen, skrivningen och en loggrad per lektion som gick (`DELETE`) och per lektion som kom (`CREATE`).
  Säges efter commit som en ändring av mastertidtabellen.
- **Direkt frågar först** (P5, beslut 8; granskaren g505, M-2). De daterade lektioner skrivningen tar bort från kalendern är publicerade lektioner som når elever och vårdnadshavare, så en skrivning som
  tar bort några i en publicerad period ställer samma fråga som en handredigering, en gång (`requireDirectReachAnswered`, med antalet borttagna): `409 DIRECT_REACH_UNANSWERED`, och inget skrivs.
  En skrivning som inte når någon publicerad lektion frågar aldrig.
- **Hålls av** `src/requirement-placements/placement-write-in.spec.ts` (vad som skrivs, lämnas och ersätts), `placement-write-in.service.spec.ts` (ordningen, förhandsvisning, utkast, 409),
  `test/placement-write-in.e2e-spec.ts` (vägarna och vem som får), `scripts/test/probe-skriv-in.ts` och `probe-skriv-in-direkt.ts` (mot riktig Postgres, i CI) och, för hand mot en riktig motor, `scripts/test/probe-skriv-in-motor.ts`:
  Generera, körd efter bron, skriver samma lektioner ur samma rader, och bron efter Generera ändrar ingenting.

## Lägg det som går (E7a)

Påfyllning i gatewayen för brickorna i Att lägga: de markerade brickorna, en klass, en årskurs eller skolan. Den bevisar ingenting och säger det: svaret är ett förslag, aldrig "går inte".
`POST /api/v1/board-fill/propose` (`{ academicYearId, scope, … }`) läser och skriver ingenting. `scope` är `BRICKS` (`bricks`: postId, teacherId, minutes och brickans `nth` ur bricklådan),
`CLASS` (`studentGroupId`), `GRADE` (`gradeLevel`, årskursen i läsårets egen numrering) eller `SCHOOL`. Båda dörrarna är schemaläggarens, som domaren och Möjliga tider.
Ett förslag rymmer högst 600 brickor som går att lägga (Ta ins gräns): frågar man om fler är svaret `400 BOARD_FILL_TOO_MANY` med `asked` och `max` som platta `params`, och sidan ber om en årskurs eller en klass i taget.

- **Hur.** Brickorna läggs en i taget, den med **färst lediga starter först** (räknad om efter varje läggning, men bara för de brickor en lagd lektion kan ha tagit en start från: samma lärare,
  en grupp som delar en elev med klassen, ett fåtal salar). Var och en läggs på en start ur de lägst kostade (samma kostnad som Möjliga tider rangordnar med: elevernas och lärarnas håltimmar, ämnets
  fördelning, lärarens dag och skolans önskemål) som **tar minst ifrån de andra**: av de tolv lägsta startarna den som lämnar flest andra brickor med en start kvar, och därefter den lägsta kostnaden.
  Salen är den minsta som generatorns regel tillåter (`roomAllowed`) och ingen håller just då; har skolan ingen sådan sal läggs brickan "Utan sal". Starterna är de punkter där något i skolan börjar
  eller slutar (en lektion, en måltid, en stängd timme, ramen) och där en lektion av brickans längd skulle sluta vid en sådan. Beskärningen är `probeAt` (E3), och **domaren har sista ordet** om varje start
  (`judgeLessons`, med de lektioner förslaget redan lagt stående): en start domaren nekar läggs inte. Ett förslag föreslår aldrig en tid som kräver ett undantag, ger inget, och flyttar ingenting som ligger:
  `moved` är platsen för valet "får flytta" (E5a:s sökning, en senare PR) och är alltid tom. En bricka som är en lektion på bricklådan döms som den lektion den är (dess andra klasser, namngivna elever och veckor),
  så som Ta in skriver den; och en lärare vars tjänst bär en gräns (dagar, sammanhängande undervisning) läses som den läses i Möjliga tider och loggas som läsning av tjänsten (`EMPLOYMENT`).
- **Svaret.** `placed` (per bricka: dag, tid, sal eller "Utan sal", hur många starter som var lediga och vilken av dem, bäst först, den lades på, kostnaden), `left` (per bricka varför den inte lades:
  `NO_FREE_START` ingen start är ledig för den med det som ligger, `JUDGE` domaren nekade de starter den prövade, `TIME` tiden tog slut innan den påbörjades, `BLOCK` ett block läggs med blocket,
  `NO_TEACHER` ingen lärare), `asked`, `truncated`, `answeredBy: "FILL"` och en `basis`. Tiden är 20 sekunder (beslut 8); därefter lämnas de som inte påbörjats med `TIME` och förslaget gäller det som hann.
- **Ta in.** `POST /api/v1/board-fill/apply` (`{ academicYearId, basis, items: [{ key, dayOfWeek, startTime, roomId }], versionName? }`) är den enda skrivningen. En transaktion: läget och årets lås (**exklusivt**, som Generera och en återställning tar det: en Ta in i taget; en andra som kommer medan den första skriver får `409 SCHEDULE_BUSY` efter 5 s, och när den kommer in efter den första är dess `basis` gammal), posternas lås i id-ordning,
  `basis` jämförd med läget nu (`409 BOARD_FILL_STALE` och ingenting skrivs om en lektion eller post ändrats sedan förslaget lästes), en **version före** ("Före påfyllning"), och sedan varje lektion genom bricklådans
  egen skrivning (`BoardTrayService.writeBrick`, samma som en läggning för hand): domaren dömer den igen mot det som nu ligger i databasen, en sal generatorn inte tar nekas (`BOARD_ROOM_NOT_ALLOWED`), lektionen
  görs låst och handgjord, loggas och säges som en handredigering. En lektion på bricklådan som läggs tillbaka frågar P5:s fråga i läget Direkt (`409 DIRECT_REACH_UNANSWERED`, och allt rullas tillbaka, versionen med).
  Svaret har versionen och, per bricka, lektionens id och om den skapades.
- **Webben.** Knappen *Lägg det som går* sitter i brädets verktygsrad bredvid Att lägga (`components/schedule/fill-head.tsx`, med i lektionsdialogernas bit) och dialogen hämtas först när den trycks
  (`fill-dialog.tsx`). Dialogen frågar efter en klass, en årskurs eller hela skolan (med det som är kvar i Att lägga för var och en), föreslår, och säger "Lade 31 av 36. Ingenting annat flyttades.", varför
  de andra inte lades och att påfyllningen inte bevisar något. Förslaget ritas som streckade rutor på brädet (`fill-layer.tsx`, en egen lat fil som grindens `behind` hämtar när ett förslag visas; dialogen
  är inte modal och täcker inte brädet). *Ta in i schemat* skriver det och sparar en version före; i Direkt frågar sidan P5:s fråga först. *Kasta* och stängning lämnar schemat orört, men medan *Ta in* pågår
  står dialogen kvar (Escape och krysset gör ingenting): en skrivning som är på väg tas inte tillbaka av att fönstret stängs. Ett förslag hör till sitt läsår och släpps när brädet byter läsår. I vyerna per klass,
  lärare och sal ritar varje bräda bara de brickor som är dess egna, och brickor på samma tid ritas bredvid varandra. Får *Ta in* inget svar (nätet bröt, eller kanten gav 502 eller 504 över en transaktion som går vidare)
  säger dialogen att det inte är säkert att förslaget togs in, läser om brädet och släpper förslaget, i stället för att be om ett nytt försök som mötte sitt eget första försök som 409 "inget skrevs". En orsak till
  att en bricka blev över som sidan inte har ord för räknas ändå (`OTHER`), och `web/lib/board-fill.contract.test.ts` håller listan till gatewayens. Tog tiden slut (`TIME`) och något lades är vägen vidare att ta in det
  som lades och föreslå igen: ett förslag som inte tas in kastas, och nästa börjar om från första brickan. Efter *Ta in* släpper sidan sina ångra-steg, som efter ett byte. Versionen som sparas före heter efter det som
  frågades ("Före påfyllning: 7A", "…: årskurs 7", "…: hela skolan"; webben skickar `versionName`), och toasten som säger att något lades har en **Ångra** i femton sekunder: den återställer den versionen. Det är hela
  grundschemat som versionen hade det, så en kollegas ändring efter *Ta in* går med (toasten säger det; en återställning sparar en version av sitt eget först, och det finns inget steg-för-steg-tillbaka förrän E5b:s
  "en ändring av N lektioner är en transaktion med ångra"); en återställning som möter en körning som skriver om året säger det (`SCHEDULE_BUSY`) och ändrar inget. Lagret på brädet hämtas med `useLazyModule` och inte med
  `lazy()`: en flik som stått över en deploy och inte får sin chunk ritar ingenting i stället för att ta ned sidan. Markerade brickor har ingen knapp i webben än (bricklådan kan inte markera; gatewayens `BRICKS` finns).
- **Hålls av** `src/board-fill/fill-plan.spec.ts` (ordningen avgör: ett fall där den först-lagda tar den enda starten en annan har; ingen lagd bricka krockar, ligger utanför ramen eller i en måltid; domaren frågas i kostnadsordning;
  tiden; salen; starterna), `board-fill.service.spec.ts` (vad som läses och skrivs, ordningen på lås och version, `basis`), `fill-reads.spec.ts`, `test/board-fill.e2e-spec.ts` (dörrarna och valideringen),
  `scripts/test/probe-lagg-det-som-gar.ts` (mot riktig Postgres, i CI: förslaget skriver ingenting, varje lagd lektion godkänns av domaren, Ta in skriver exakt förslaget efter en version och rör inget som låg,
  ett ändrat schema nekas, scopen, Direkt) och, för provet på korpusens veckor, `scripts/bench/fill-corpus.ts`.

## Tier 3

- **Minimal-disruption re-optimization** — the gateway sends the current unlocked placements as `previousLessons`; the solver is rewarded (weight `disruption`) for keeping lessons on those slots and warm-started with them as hints. Mid-term re-runs now change as little as possible.
- **Room-type eligibility** — `Subjects.requiredRoomType` (set in the Subjects page); the solver only places such subjects in matching rooms (hard constraint + INFEASIBLE explanation).
- **Richer objectives** — PREFERRED_FREE/BUSY now also apply to rooms and student groups; a `spread` objective penalizes same-subject lessons stacked on one weekday.
- **Optimization profile UI** — sliders on the Generate page (stability / spread / preferred-free / preferred-busy), saved for the school (`OptimizationProfiles`, DEPLOYMENT §43), sent per run, all engine-side defaults env-overridable (`WEIGHT_DISRUPTION`, `WEIGHT_SPREAD`).
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
