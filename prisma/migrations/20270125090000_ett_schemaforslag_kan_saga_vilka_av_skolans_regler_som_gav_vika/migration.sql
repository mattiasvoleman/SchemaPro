-- Ett schemaförslag kan säga vilka av skolans regler som gav vika.
--
-- Bästa möjliga schema (G2). Generera and a schemaförslag refuse a week the
-- school's rules cannot all hold, by name, and place nothing: the school then
-- has to change a rule before it has a timetable to look at. The engine can
-- now place the week with FIVE of the school's own shaping rules turned from
-- rows into prices (optimization-engine/app/solver/relaxation.py): a teacher's
-- cap of minutes a day, a part-timer's teaching days, a subject's cap per day
-- and its days apart, and a subject's locked rooms. Everything else stays hard
-- (a teacher, class, pupil or room booked twice; a lesson outside the frame
-- times; the walk between two sites; a teacher's lunch and night's rest; a
-- teacher marked unavailable; a requirement's own room type, capacity and
-- years; lunch; lesson lengths; a parallel block's shared start; the group's
-- own daily cap). The answer lists what gave way, rule by rule and how far, and
-- the school decides whether it can live with that BEFORE the timetable is
-- applied. Three columns carry the decision; nothing else is added.
--
-- ## LunchSettings."generatorBestEffort"
--
-- The school's switch, in the Skolregler row beside
-- "generatorKeepsTravelTime", "generatorKeepsPupilGapsDown" and
-- "generatorKeepsConsecutiveTeaching" (20261218090000), for the reason they
-- are there: it sits in the same form. BOOLEAN NOT NULL DEFAULT false, so
-- every school is off until it says otherwise, and a migration cannot turn on
-- a mode in which a rule of the school's is broken: that is the school's to
-- ask for, as the other three efforts are. Off, a candidate run that asks for
-- the mode is refused (409 BEST_EFFORT_NOT_ENABLED), nothing is sent to the
-- engine that was not sent before, and a candidate that already carries
-- deviations cannot be applied (the same code), so turning the switch off
-- again withdraws the school's consent for the ones left on the page.
--
-- ## ScheduleCandidates."deviations"
--
-- The rules that gave way in the candidate's timetable, in the shape of the
-- candidate's "conflicts" and "notes" (a conflict-shaped entry: category
-- DEVIATION, the sentence's code, its scalar params, the engine's English, the
-- names of what it is about; the teacher a cap is about as a Users id kept for
-- the server in "subjectIds" and named when the page reads it, never as a
-- name, exactly as a free-day note keeps its teacher). An entry about a
-- part-timer's days is stored in the hidden form every sentence about a
-- post's days is stored in (TEACHER_WORK_DAYS_HIDDEN, no figure, no post, no
-- teacher), because the figure is HR data and a candidate is read on a page
-- with no HR path: the post is the one place the figure lives.
--
--   NULL   the candidate did not come from the mode (every candidate stored
--          before this, and every candidate of an ordinary run);
--   []     the mode ran and nothing gave way: a clean timetable;
--   [ … ]  what gave way, which the school must accept to apply the candidate.
--
-- A list or NULL, by a CHECK of its own (the candidate's lessons, notes and
-- the run's draftNotes are held the same way). Written once with the
-- candidate: the table has no UPDATE grant, and this does not give it one.
-- Table grants reach a new column, so the API's role holds SELECT, INSERT and
-- DELETE on it as on every column of the table; service_role keeps the SELECT
-- it has had since 20261125090000; no other role reads the table.
--
-- ## PublicationSettings."gateDeviations"
--
-- The policy of the new publish check PUB_DEVIATIONS (src/publication/
-- publication-gates.ts GATE_COLUMN, one check to one column, held by its
-- spec): a timetable applied from a candidate with deviations that no
-- publication has followed. WARN like every gate column until the school
-- chooses, so a school that never opens the settings is refused nothing it can
-- publish today; a school that wants the deviations to stop a publish sets it
-- to REFUSE, as it does for its clashes. A constant default: PostgreSQL adds
-- the column without rewriting the table.
--
-- ## Where the acceptance is kept, and why not in a table
--
-- The school accepts the deviations when it applies the candidate (the apply
-- carries the candidate's digest back), and the acceptance is kept in the
-- REGENERATE entry of ScheduleChangeLogs the apply already writes, in its
-- "after" (source, runId, ordinal, variant, metrics): the accepted list, its
-- digest and the moment. WHO accepted is the entry's own "actorId", which the
-- registerutdrag and the removal already treat as a person column; the
-- entry holds no Users id of its own. A table of its own would hold one more
-- person reference per acceptance, to be classified in the registerutdrag, the
-- removal inventory, the school export and people-files.ts, for a record that
-- is read in one place (the publish check, which looks for the newest entry
-- of the year). The cost: "after" is JSON that no person-removal reaches by
-- column, so the accepted list is kept WITHOUT the "subjectIds" of the
-- candidate's copy and without a name, and the log's own retention (gallring)
-- applies to it as to every entry.
--
-- No new table, no new policy and no GRANT: the rows' arms are row-level and
-- read every column, and the privileges are table-level. MAINTAIN is not
-- touched. RLS sections 410–414 hold it.
--
-- ## Beside the live API
--
-- The API before this names its columns, so it neither reads nor writes the
-- new ones: its Skolregler upsert leaves the switch as it was, a candidate it
-- stores has null deviations, and its publication settings read leaves the
-- policy at its default. A candidate with deviations exists only after a
-- school has turned the switch on, which no school can do before the API that
-- writes it is serving, so no instance that predates this can be asked to
-- apply one. Roll the API back past this only with no candidate with
-- deviations on the page.
--
-- ADD COLUMN (a constant default, or nullable with no default: nothing is
-- rewritten) and ADD CONSTRAINT take each table ACCESS EXCLUSIVE, and the
-- tables are live: the generator reads LunchSettings at the start of every
-- run, a publish reads PublicationSettings, and the Schemaförslag page polls
-- the candidates every two seconds while a run goes. All three locks are
-- taken in one statement, NOWAIT, all or nothing, and again 50 ms later while
-- a request holds one: the migration never waits while it holds a lock, so
-- nothing queues behind it and no cycle with a request is possible
-- (policy-migration-lock-order). After 30 s of refusals it stops with nothing
-- done; Prisma then records it as failed (P3009), and
-- `prisma migrate resolve --rolled-back
-- 20270125090000_ett_schemaforslag_kan_saga_vilka_av_skolans_regler_som_gav_vika`
-- comes before it is run again. lock_timeout bounds any wait nobody foresaw.
-- The CHECK reads the candidates under the lock; they hold a week of runs at
-- most.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "LunchSettings", "PublicationSettings", "ScheduleCandidates" IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'LunchSettings, PublicationSettings and ScheduleCandidates were not free at once in 30 s: nothing is changed, run the migration again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

ALTER TABLE "LunchSettings"
  ADD COLUMN "generatorBestEffort" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "PublicationSettings"
  ADD COLUMN "gateDeviations" "PublishGateMode" NOT NULL DEFAULT 'WARN';

ALTER TABLE "ScheduleCandidates"
  ADD COLUMN "deviations" JSONB;
ALTER TABLE "ScheduleCandidates"
  ADD CONSTRAINT "ScheduleCandidates_deviations_is_a_list" CHECK ("deviations" IS NULL OR jsonb_typeof("deviations") = 'array');

COMMENT ON COLUMN "LunchSettings"."generatorBestEffort" IS
  'Bästa möjliga schema (20270125090000): whether an administrator who plans may ask for a timetable in which the school''s own shaping rules (a teacher''s cap per day, a part-timer''s days, a subject''s cap per day and days apart, a subject''s rooms) may give way, listed as deviations the school accepts before the timetable is applied. Off by default; off refuses the run (BEST_EFFORT_NOT_ENABLED). Written by PLANERING.';
COMMENT ON COLUMN "PublicationSettings"."gateDeviations" IS
  'Bästa möjliga schema (20270125090000): whether PUB_DEVIATIONS, a timetable applied from a candidate with deviations that no publication has followed, warns or stops a publish. WARN until the school chooses.';
COMMENT ON COLUMN "ScheduleCandidates"."deviations" IS
  'Bästa möjliga schema (20270125090000): the rules that gave way in the candidate''s timetable, one conflict-shaped entry each (category DEVIATION; a teacher''s Users id server-only in subjectIds; an entry about a post''s days in its hidden form). Written once with the candidate. NULL: the candidate did not come from the mode. []: the mode ran and nothing gave way.';
