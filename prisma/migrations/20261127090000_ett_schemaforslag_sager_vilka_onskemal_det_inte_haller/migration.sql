-- Ett schemaförslag säger vilka önskemål det inte håller.
--
-- A teacher's work rule may wish one weekday free
-- (TeacherWorkRules."preferredFreeDayOfWeek", 20261123090000). The generator
-- pays for a lesson on that day and gives the wish up where keeping it would
-- cost more, and Generera names every wish its timetable broke beside the
-- finished run (OptimizationJobs."notes", 20261123090100). A schemaförslag is
-- solved under the same wishes, and until now its comparison said nothing of
-- them: a school could apply the candidate with the fewest håltimmar without
-- seeing that it gives a teacher lessons on the day they asked to have free.
--
-- ## ScheduleCandidates."notes"
--
-- The wishes a candidate's timetable breaks — its own lessons with their
-- timplanspost's teachers, beside the lessons every candidate keeps (locked
-- and handmade ones, as the run's fetch read them) — in the shape of
-- Generera's notes: a conflict-shaped entry per wish, with its code, the
-- weekday, the work rule as the resource and the teacher's Users id kept for
-- the server (subjectIds), named when the page reads it and never stored as
-- a name. Measured once, when the run stores the candidate, from the same
-- fetch the candidate was solved from; the basis already covers the wishes
-- (its "rules" part) and the kept lessons ("preserved"), so the notes of a
-- candidate an apply accepts are the notes of the timetable it writes. Null
-- on a candidate with no timetable (INFEASIBLE, TIMEOUT, REJECTED) and on
-- every candidate stored before this; an empty list when every wish is kept.
--
-- ## ScheduleCandidateRuns."draftNotes"
--
-- The same for the draft the run was solved from — the kept lessons and the
-- draft's own, a parked one occupying no day — so the comparison's first
-- column has a figure each candidate is read against, as the run's
-- "unplaced" keeps the draft's beside the candidates'. Written when the run
-- succeeds; null on every other run and on every run before this.
--
-- Both are lists or null (a CHECK each), like the candidate's lessons. No
-- grant changes: the API's role holds its table grants on every column, a
-- candidate is still written once (no UPDATE), and no other role reads
-- either table.
--
-- ## Beside the live API
--
-- The API before this names its columns, so it neither reads nor writes the
-- new ones, and a candidate it stores has null notes, which the new web
-- shows as not measured. ADD COLUMN (nullable, no default: nothing is
-- rewritten) and ADD CONSTRAINT take each table ACCESS EXCLUSIVE, and the
-- tables are live — the page polls the overview every two seconds while a
-- run goes, and a run's task holds its row while it stores a candidate.
-- Both locks are taken in one statement, NOWAIT, all or nothing, again 50 ms
-- later while a request holds one, and after 30 s the migration stops with
-- nothing done and can be rerun (policy-migration-lock-order). The checks
-- read the tables under the lock; they hold a week of runs at most.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "ScheduleCandidateRuns", "ScheduleCandidates" IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'ScheduleCandidateRuns and ScheduleCandidates were not free at once in 30 s: nothing is changed, run the migration again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

ALTER TABLE "ScheduleCandidates" ADD COLUMN "notes" JSONB;
ALTER TABLE "ScheduleCandidates"
  ADD CONSTRAINT "ScheduleCandidates_notes_is_a_list" CHECK ("notes" IS NULL OR jsonb_typeof("notes") = 'array');

ALTER TABLE "ScheduleCandidateRuns" ADD COLUMN "draftNotes" JSONB;
ALTER TABLE "ScheduleCandidateRuns"
  ADD CONSTRAINT "ScheduleCandidateRuns_draftNotes_is_a_list" CHECK ("draftNotes" IS NULL OR jsonb_typeof("draftNotes") = 'array');
