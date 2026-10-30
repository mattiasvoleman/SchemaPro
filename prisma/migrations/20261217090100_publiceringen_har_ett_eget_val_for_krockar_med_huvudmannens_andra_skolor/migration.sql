-- Publiceringen har ett eget val för krockar med huvudmannens andra skolor.
--
-- Roadmap: Kommun lane, phase "Delade lokaler och lärare", second half (the
-- generator and the publish). The publish check PUB_OTHER_SCHOOL names the
-- lessons that meet another school of the huvudman: a shared teacher's
-- lesson there with the walk between the schools, a room lent to it in an
-- approved window, or the school's own room for a borrowed one outside every
-- approved window (src/publication/other-school-finding.ts).
--
-- Every check follows one policy column (src/publication/publication-gates.ts
-- GATE_COLUMN, one to one, held by its spec), and the school decides each:
-- a school may stop a publish on its own clashes and only be warned about
-- another school's timetable, which it cannot change itself, or the other way
-- round. So the check has a column of its own, WARN like every other until
-- the school chooses: a school that never opens the settings is refused
-- nothing it can publish today.
--
--   PublicationSettings."gateOtherSchool"  "PublishGateMode" NOT NULL DEFAULT 'WARN'
--
-- A constant default: PostgreSQL adds the column without rewriting the
-- table. No new policy and no GRANT: the arms and the grants are the
-- table's, row by row, as for every gate column before it (20261113090000's
-- gateEmptyHalf).
--
-- ## Beside the live API
--
-- ADD COLUMN takes ACCESS EXCLUSIVE on "PublicationSettings", one row per
-- school, written when a school saves its settings and read by every
-- publish. Taken NOWAIT in a loop: a refusal tries again 50 ms later, so the
-- migration never waits while it holds the lock and no publish queues behind
-- it; after 30 s it stops with nothing changed. lock_timeout bounds any wait
-- nobody foresaw. The API before this release reads the row by name of the
-- columns it knows and is unchanged.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "PublicationSettings" IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'PublicationSettings was not free in 30 s: nothing is changed, run the migration again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

ALTER TABLE "PublicationSettings"
    ADD COLUMN "gateOtherSchool" "PublishGateMode" NOT NULL DEFAULT 'WARN';

COMMENT ON COLUMN "PublicationSettings"."gateOtherSchool" IS
  'Delade lokaler och lärare (20261217090100): whether PUB_OTHER_SCHOOL, a lesson that meets another school of the huvudman (a shared teacher, a lent or a borrowed room), warns or stops a publish. WARN until the school chooses.';
