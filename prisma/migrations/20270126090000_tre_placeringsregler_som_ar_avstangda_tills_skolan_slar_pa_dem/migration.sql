-- Tre placeringsregler som är avstängda tills skolan slår på dem.
--
-- G3, Placeringsregler. The generator places a lesson where it fits, and a
-- school has three things to say about where that should be, none of which
-- it could say until now:
--
--   1. A SUBJECT is not the first, or not the last, lesson of a class's day
--      (idrott inte först, och inte sist). Per subject, two marks.
--   2. A CLASS or a TEACHER is in at most N DIFFERENT room groups and at most
--      M different buildings in a day. Four limits, each optional, because a
--      school limits a class's walking without limiting its teachers' (a
--      teacher walks between rooms by trade). 1 is a single one: never a
--      change. The same room twice is one place, so A–B–A–B is two places:
--      what is counted is how many places a day holds, not how many times
--      the party moves between them. The engine holds the first exactly;
--      counting the moves between neighbouring lessons exactly would cost
--      about five times the model's size, and measured on the högstadium
--      school the two rules differ enough to matter (22 class days kept the
--      places and broke the moves), so the rule is named for what it holds.
--   3. A ROOM several groups may share at one time (gymnastiksalen, aulan)
--      holds the pupils of every lesson in it together, up to its capacity.
--      Per room, one mark.
--
-- Each rule has a MODE: OFF, SOFT or HARD. SOFT pays a weight for every
-- breach, on the scale of the other wishes, and refuses no week; HARD forbids
-- the breach, and a week that cannot keep it is refused by name before the
-- school waits for a timetable that cannot exist. THE DEFAULT IS OFF, for
-- every school and for the rows already there: a rule that moves lessons is
-- the school's to ask for, as every effort switch before it (travel time,
-- the pupils' idle time, teaching in a row), and a rule switched on by a
-- migration would change the next Generera of every school. OFF sends the
-- engine nothing, so a school that has not turned a rule on gets the payload,
-- the model and the response it got before.
--
-- ## Where the columns are, and why
--
--   * "LunchSettings" (Skolregler, one row per school): the mode and the
--     weight of each rule, and the four limits of rule 2. The row is the
--     school's own rules and the form is the Skolregler tab; the switches
--     before these are columns of it for that reason
--     ("generatorKeepsTravelTime", "generatorKeepsPupilGapsDown",
--     "generatorKeepsConsecutiveTeaching", 20261218090000).
--       "placementEdgeMode" / "placementEdgeWeight"        rule 1
--       "placementPlacesMode" / "placementPlacesWeight"  rule 2
--       "maxClassRoomsPerDay", "maxTeacherRoomsPerDay",
--       "maxClassBuildingsPerDay", "maxTeacherBuildingsPerDay"
--                                                          rule 2's limits
--       "placementSharedMode" / "placementSharedWeight"    rule 3
--   * "Subjects"."notFirstInDay", "notLastInDay": rule 1's marks. A subject
--     is the right unit: a school thinks "not idrott first", not "not this
--     timplanspost first", and a mark on the subject follows it into every
--     class and every year without being written again. Both false is no
--     rule, which is every subject until a school marks one.
--   * "Rooms"."canBeShared": rule 3's mark. Nothing the school has told us
--     says a room can hold two groups at once, and a room is exclusive in the
--     engine and in the clash check today, so sharing needs its own mark; a
--     rule that turned every room into a shared one would put two classes in
--     a classroom the first time its capacity allowed.
--
-- A building is not a new concept: "Rooms"."building" is the room
-- optimisation's building (20260911120000, a name of 1..60 characters), and rule 2
-- counts the different ones a day holds, as the room optimisation tells them
-- apart. As there, a room WITHOUT a building is itself a value (the main
-- house); a school that names only its annex has the annex a walk from every
-- other room. A skolområde ("Rooms"."siteId") is not a building here: the walk
-- between skolområden is Restid i generatorn (20261124090000), a rule of its
-- own with a figure in minutes. A place in the room sense is a room GROUP,
-- the engine's interchangeability class, so two equal classrooms are one
-- place in the model and the post-pass keeps a party in the room it had.
--
-- ## The weights, the limits and what the database refuses
--
--   * A weight is 1..1000 (LunchSettings_placement…Weight_check), the engine's
--     own range and the scale of the other weights (spread 3, a room wish 5,
--     a free day 40, teaching in a row 250). The default is 250, and the
--     column is kept as it is while the mode is OFF or HARD, so a school that
--     switches a rule off and on again does not lose the figure it chose.
--   * A limit is 1..20 or null (LunchSettings_max…PerDay_check). 1 is a
--     single room group or building in a day, never a change; 0 would be a
--     day in no room at all, which no school means. Null is no limit on that
--     count, and the school may limit a class's rooms and nothing else.
--   * A rule 2 that is SOFT or HARD needs at least one limit
--     (LunchSettings_placementPlaces_needs_a_limit_check): a mode with no
--     number is a rule nothing can read, and the engine refuses a block that
--     limits nothing. The API says so in a sentence first (400,
--     PLACEMENT_PLACES_NEEDS_A_LIMIT); the CHECK is for every other way in.
--   * Rule 1 with no subject marked, and rule 3 with no room marked, are
--     allowed and do nothing. That is the order a school works in: it turns
--     the rule on, then marks. Refusing the mode until a mark exists would
--     make the form's first click an error, and the gateway sends nothing for
--     a rule that has nothing to apply to.
--
-- ## Who writes it, and who reads it
--
-- No new table, so no new arm, no GRANT, and nothing in TABLE_WRITE_GATES
-- (src/auth/admin-areas.ts) or the role matrix (RLS section 116) moves: the
-- three tables stay the PLANERING area's. The rows' arms are row-level and
-- read every column, and the privileges are table-level, so each new column
-- is held exactly as its table's other columns are. No privilege is
-- granted, revoked or changed here, MAINTAIN (Postgres 17's, which ALL now
-- includes) among them.
--
--   * LunchSettings: SELECT by the school's SCHOOL_ADMIN and TEACHER;
--     INSERT, UPDATE and DELETE by a SCHOOL_ADMIN who writes PLANERING (the
--     UPDATE arm asks that in WITH CHECK only, so a row lock for a read keeps
--     working for every administrator). A pupil and a guardian read no row.
--   * Rooms, Subjects: SELECT by every member of the school
--     (rooms_member_select, subjects_member_select) and by the service
--     principal of the school; writes by a SCHOOL_ADMIN who writes PLANERING.
--     That a pupil can read "canBeShared" and "notFirstInDay" is not a
--     disclosure: they read the room's name, capacity and building, and the
--     subject's name, as before, and a mark says how the school wishes a
--     lesson placed, not who is where.
--
-- Through PostgREST (authenticated) the same arms hold, and anon holds no
-- privilege on either table. RLS sections 415–419 run every one of these,
-- role by role, as the API's role and as PostgREST's.
--
-- ## SS12000 and the year rollover
--
-- The SS12000 providers emit nothing new. app.ss12000_v_rooms bumps a room's
-- meta.modified for its name and capacity, and app.ss12000_v_subjects for a
-- subject's name and national code; none of them names a column here, so
-- setting a mark moves no version (RLS section 418 holds it). Rooms and
-- Subjects have no läsår, so the year rollover carries nothing: the marks are
-- the school's and stay. The Skolregler row is the school's as well.
--
-- ## Beside the live API
--
-- Additive: one enum type, ten columns with a constant default on one table,
-- two booleans with a constant default on another, one on a third (Postgres
-- 11+ adds a column with a constant default to the catalogue without
-- rewriting the table); no row changes. Checked against the API that serves
-- before this (origin/main, src/resources/lunch-settings.service.ts,
-- subjects.service.ts, rooms.service.ts, src/import/import.service.ts):
--
--   * Its upsert of the Skolregler names the columns it knows. The update
--     half leaves every new column as it is, the create half reads the
--     defaults (OFF, 250, null): a school that has set a rule keeps it
--     through a save by the old API.
--   * Its create of a subject or a room reads the defaults (false), and its
--     update names only the fields of its body, so a mark survives an edit by
--     the old API. The CSV import creates a subject or a room with the
--     defaults and never updates one.
--   * It never reads the columns, so it never sends them, and a PUT or a POST
--     from a web ahead of it is refused (forbidNonWhitelisted): the web is
--     deployed after the API, as before.
--
-- The API after this reads them, so this runs first. The engine and the API
-- deploy from the same merge, and the engine's new fields are optional and
-- sent only for a school with a rule on, which no school has until it turns
-- one on after the deploy. Rolling the engine back alone after that fails the
-- school's Generera: roll the API back with it, or switch the rules off first
-- (docs/DEPLOYMENT.md says how). The columns can stay through a rollback.
--
-- Production migrates beside the API that is serving it. ADD COLUMN takes
-- each table ACCESS EXCLUSIVE for a moment (the CHECKs scan the Skolregler's
-- few rows; nothing else is rewritten), and a waiting ACCESS EXCLUSIVE queues
-- every reader behind it: the generator reads all three at the start of every
-- run, the Skolregler card, the rooms page and the subjects page on every
-- load, and a request takes them in no fixed order (the generator reads the
-- rooms and then the Skolregler, a save of the Skolregler reads nothing
-- else). A migration that took one and then waited for another could close a
-- cycle with one of them. So all three are taken first, NOWAIT
-- and together: a refusal rolls the subtransaction back and with it whatever
-- it got, and it tries again 50 ms later. It never waits while it holds a
-- lock. After 30 s of refusals it stops with nothing done and can be rerun
-- (prisma migrate resolve --rolled-back, then deploy). lock_timeout bounds
-- any wait nobody foresaw.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "LunchSettings" IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "Subjects" IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "Rooms" IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'LunchSettings, Subjects and Rooms were not free at once in 30 s: nothing is changed, run the migration again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

CREATE TYPE "PlacementRuleMode" AS ENUM ('OFF', 'SOFT', 'HARD');

ALTER TABLE "LunchSettings"
    ADD COLUMN "placementEdgeMode"                "PlacementRuleMode" NOT NULL DEFAULT 'OFF',
    ADD COLUMN "placementEdgeWeight"              INTEGER NOT NULL DEFAULT 250,
    ADD COLUMN "placementPlacesMode"              "PlacementRuleMode" NOT NULL DEFAULT 'OFF',
    ADD COLUMN "placementPlacesWeight"            INTEGER NOT NULL DEFAULT 250,
    ADD COLUMN "maxClassRoomsPerDay"              INTEGER,
    ADD COLUMN "maxTeacherRoomsPerDay"            INTEGER,
    ADD COLUMN "maxClassBuildingsPerDay"          INTEGER,
    ADD COLUMN "maxTeacherBuildingsPerDay"        INTEGER,
    ADD COLUMN "placementSharedMode"              "PlacementRuleMode" NOT NULL DEFAULT 'OFF',
    ADD COLUMN "placementSharedWeight"            INTEGER NOT NULL DEFAULT 250,
    ADD CONSTRAINT "LunchSettings_placementEdgeWeight_check"
        CHECK ("placementEdgeWeight" BETWEEN 1 AND 1000),
    ADD CONSTRAINT "LunchSettings_placementPlacesWeight_check"
        CHECK ("placementPlacesWeight" BETWEEN 1 AND 1000),
    ADD CONSTRAINT "LunchSettings_placementSharedWeight_check"
        CHECK ("placementSharedWeight" BETWEEN 1 AND 1000),
    ADD CONSTRAINT "LunchSettings_maxClassRoomsPerDay_check"
        CHECK ("maxClassRoomsPerDay" BETWEEN 1 AND 20),
    ADD CONSTRAINT "LunchSettings_maxTeacherRoomsPerDay_check"
        CHECK ("maxTeacherRoomsPerDay" BETWEEN 1 AND 20),
    ADD CONSTRAINT "LunchSettings_maxClassBuildingsPerDay_check"
        CHECK ("maxClassBuildingsPerDay" BETWEEN 1 AND 20),
    ADD CONSTRAINT "LunchSettings_maxTeacherBuildingsPerDay_check"
        CHECK ("maxTeacherBuildingsPerDay" BETWEEN 1 AND 20),
    ADD CONSTRAINT "LunchSettings_placementPlaces_needs_a_limit_check"
        CHECK ("placementPlacesMode" = 'OFF'
               OR num_nonnulls("maxClassRoomsPerDay", "maxTeacherRoomsPerDay",
                               "maxClassBuildingsPerDay", "maxTeacherBuildingsPerDay") > 0);

ALTER TABLE "Subjects"
    ADD COLUMN "notFirstInDay" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "notLastInDay"  BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Rooms"
    ADD COLUMN "canBeShared" BOOLEAN NOT NULL DEFAULT false;

COMMENT ON TYPE "PlacementRuleMode" IS
  'Placeringsregler: how a rule is held. OFF sends the engine nothing (the week is generated as before), SOFT pays a weight for every breach and refuses nothing, HARD forbids the breach and a week that cannot keep it is refused by name.';
COMMENT ON COLUMN "LunchSettings"."placementEdgeMode" IS
  'Placeringsregel 1: a subject marked notFirstInDay / notLastInDay is kept off the first / last lesson of a class''s day. OFF until the school turns it on. Written by PLANERING.';
COMMENT ON COLUMN "LunchSettings"."placementEdgeWeight" IS
  'SOFT only: what a lesson at an end it should not be at costs, 1..1000 on the scale of the other wishes (a free day 40, teaching in a row 250). Kept while the mode is OFF or HARD.';
COMMENT ON COLUMN "LunchSettings"."placementPlacesMode" IS
  'Placeringsregel 2: a class and a teacher (apart) are in at most N different room groups and M different buildings in a day. SOFT or HARD only while at least one of the four limits is set. OFF until the school turns it on.';
COMMENT ON COLUMN "LunchSettings"."placementPlacesWeight" IS
  'SOFT only: the cost of a place over a limit, 1..1000. Kept while the mode is OFF or HARD.';
COMMENT ON COLUMN "LunchSettings"."maxClassRoomsPerDay" IS
  'Most different room groups a class is in during a day; 1..20, null = no limit; 1 is a single one. A room GROUP is the engine''s interchangeability class, not the concrete room: two equal classrooms are one place in the model.';
COMMENT ON COLUMN "LunchSettings"."maxTeacherRoomsPerDay" IS
  'Most different room groups a teacher is in during a day; 1..20, null = no limit; 1 is a single one.';
COMMENT ON COLUMN "LunchSettings"."maxClassBuildingsPerDay" IS
  'Most different buildings a class is in during a day (Rooms.building; a room without one is the main house); 1..20, null = no limit; 1 is a single one.';
COMMENT ON COLUMN "LunchSettings"."maxTeacherBuildingsPerDay" IS
  'Most different buildings a teacher is in during a day; 1..20, null = no limit; 1 is a single one.';
COMMENT ON COLUMN "LunchSettings"."placementSharedMode" IS
  'Placeringsregel 3: the pupils of the lessons in a room marked canBeShared, at one time, fit its capacity together. OFF until the school turns it on.';
COMMENT ON COLUMN "LunchSettings"."placementSharedWeight" IS
  'SOFT only: the cost per pupil over the capacity at the room''s worst moment of the week, 1..1000. Kept while the mode is OFF or HARD.';
COMMENT ON COLUMN "Subjects"."notFirstInDay" IS
  'Placeringsregel 1: the subject is not the first lesson of a class''s day. Read only while LunchSettings.placementEdgeMode is not OFF; false = no rule.';
COMMENT ON COLUMN "Subjects"."notLastInDay" IS
  'Placeringsregel 1: the subject is not the last lesson of a class''s day. Read only while LunchSettings.placementEdgeMode is not OFF; false = no rule.';
COMMENT ON COLUMN "Rooms"."canBeShared" IS
  'Placeringsregel 3: the room may hold several lessons at the same time as long as their pupils fit its capacity together. false = exclusive, as every room has always been. Read only while LunchSettings.placementSharedMode is not OFF; a room without a capacity stays exclusive whatever this says.';
