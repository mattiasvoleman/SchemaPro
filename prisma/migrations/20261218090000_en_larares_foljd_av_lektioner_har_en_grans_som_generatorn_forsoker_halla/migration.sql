-- En lärares följd av lektioner har en gräns som generatorn försöker hålla.
--
-- Sammanhängande undervisning: "högst X minuters undervisning i följd, sedan Y
-- minuter ledigt", set per teacher on the post by those who decide (rektor and
-- a full administrator). Three things keep it, and only the first is soft:
--
--   * THE GENERATOR TRIES. It pays for every lesson of the teacher whose
--     stretch is not ended by a break in time, in the full model's objective,
--     and refuses no week over it: the way it treats the wished free day. A
--     hard rule was built first and measured on the högstadium school (450
--     pupils, 26 teachers, 423 lessons, the eight busiest teachers flagged):
--     the first solution took 27–85 s where the school's own takes 8, and the
--     full solve found no timetable at all in 90 s in three pairs of three.
--     Soft, the same school solves 423 of 423 in every pair and leaves 0–3 of
--     the 8 teachers over the limit (one or two in the usual run) where
--     today's model leaves 7–8 (docs/verification-baseline.md). THAT IS THE
--     WEEK WITHOUT THE PUPILS' IDLE-TIME SWITCH AND THE TEACHER-DAY RULES, on
--     90 s: the review measured the same week with both on, and with 60 s
--     (production's SOLVER_MAX_TIME_SECONDS) the wish moved the count of
--     teachers over the limit by nothing measurable (5→5, 6→8, 6→7), where
--     the bench school, with room to search, went from 5 and 7 to 0 and 1. A
--     wish works where the search has room. "Tries" is the promise, and the
--     Generera line names the teachers it did not manage.
--   * A HAND EDIT OF THE GRUNDSCHEMA IS WARNED when it leaves a teacher's
--     stretch longer than the limit (TEACHER_CONSECUTIVE_TOO_LONG), never
--     refused.
--   * THE VIKARIETAVLA NEVER PROPOSES a cover that would put a teacher over it
--     (hard, in every cover path), and warns on a manual pick.
--
-- Columns:
--
--   * TeacherEmployments."maxConsecutiveTeachingMinutes": the most minutes of
--     teaching in a row, 30..480 on the engine's five-minute grid.
--   * TeacherEmployments."consecutiveBreakMinutes": the free time that ends a
--     stretch, 5..120, also a multiple of 5. A gap shorter than this does not
--     end it. Both columns or neither: a limit with no break, or a break with
--     no limit, is a rule nothing can read, and the CHECK says so by name.
--   * LunchSettings."generatorKeepsConsecutiveTeaching": boolean, NOT NULL,
--     default false. The school's Skolregler row, beside
--     "generatorKeepsTravelTime" (20261209090000) and
--     "generatorKeepsPupilGapsDown" (20261216090000), for the reason they are
--     there. OFF until the school turns it on, as the roadmap decides: a term
--     that moves the lessons of every teacher who has the rule is the school's
--     to ask for, and one switched on by a migration would change the next
--     Generera of every school. Off sends the engine neither field
--     (src/optimization/optimization-proxy.service.ts), so a school that has
--     not turned it on gets the payload, the model and the response it got
--     before. The hand-edit warning and the Vikarietavla do not look at the
--     switch: the limit is the teacher's, and only the generator's EFFORT is
--     the school's to turn on.
--
-- Null is off for the post's columns, as for every optional rule of the post.
--
-- ## Why the post, and not the work rule
--
-- A limit on how long a teacher teaches in a row can be an arbetsanpassning
-- after sick leave, and then it states something about a person's health. It
-- was first built as a column of the work rule, beside the cap and the wish,
-- and it was decided that it is HR data, treated as deltid in days is
-- (TeacherEmployments."maxTeachingDaysPerWeek", 20261123090000): so it sits
-- on the post, as the days do.
--
-- The work rule cannot hold it. Every TEACHER and SCHOOL_ADMIN of the school
-- reads every column of every row of TeacherWorkRules
-- (teacher_work_rules_staff_select), row security cannot hide a column, and a
-- column privilege would take the column from the gateway's own read, which
-- runs as the same role as theirs. The post is the table whose arms already
-- keep other people's rows from the role PostgREST uses.
--
-- Who writes it: those who decide. The post's INSERT and DELETE arms and the
-- WITH CHECK of its UPDATE arm ask app.current_user_decides() (rektor and full,
-- 20261110100000), every one of them is TO app_authenticated, and the teacher
-- has no write arm on it at all: a teacher does not write their own post, and
-- the schemaläggare who sets the cap and the wish no longer sets the limit. An
-- administrator who does not decide is refused by the arm (42501, row-level
-- security) and a DELETE reaches no row; through PostgREST's role nobody
-- writes a post.
--
-- Who reads it:
--
--   * Through the gateway (app_authenticated) every administrator's SELECT arm
--     shows the post, because the row also carries the signature the schedule
--     shows and the target in minutes tjänstefördelning is measured against.
--     THE GATEWAY is what leaves the HR columns out of its answer for an
--     administrator without HR-läs (hideHr, src/staffing/hr-visibility.ts),
--     the limit with the days. Row security cannot do that; its part is the
--     next line.
--   * Directly (authenticated, PostgREST's role) a teacher reads their own
--     post and its history (teacher_employments_teacher_own_select,
--     teacher_employment_logs_teacher_own_select), and NOBODY else does: the
--     administrators' arms on the post and on its history are TO
--     app_authenticated alone since 20261028090000, so a colleague, an
--     administrator with or without HR-läs and a läsare read no post of anyone
--     else through that role. The service principal's arm is the API role's as
--     well.
--   * The post's history (TeacherEmploymentLogs, written by
--     app.teacher_staffing_log) records the row as JSON, everything but a short
--     list of columns, so the two columns are logged with no change to the
--     trigger, and the gateway masks them there as it masks the days.
--     Administrators' arms on the history are the API role's alone, the
--     teacher's own are the teacher's own versions.
--   * The SS12000 triggers on the post (app.ss12000_v_employments and its
--     siblings) name the signature, the person, the year and, where the school
--     shares them, the percentage and the contract kind; none names these.
--
-- RLS section 288 holds every one of these, role by role, as the API's role
-- and as PostgREST's. TeacherWorkRules is not touched: this migration does not
-- replace app.teacher_work_rules_day_is_planned, which stays as 20261123090000
-- made it, and the work rule carries no column of this feature.
--
-- The cost of the choice: the limit is the läsår's, as the days are, it is
-- carried to the next year with the post (the rollover), and a teacher with no
-- post that year cannot have one.
--
-- No new table, so no arm, no GRANT and nothing in TABLE_WRITE_GATES or the
-- role matrix (RLS section 116) moves: the post stays the decisions'. The
-- rows' arms are row-level and read every column, and the privileges are
-- table-level, so the new columns are held exactly as the days are. MAINTAIN
-- is not touched. RLS sections 287–289 hold it.
--
-- ## Beside the live API
--
-- Additive: two nullable columns with named CHECKs on one table, one boolean
-- with a constant default on another (Postgres 11+ adds it to the catalogue
-- without rewriting the table). No row changes. Checked against the API that
-- serves before this (origin/main, src/staffing/teacher-employments.service.ts,
-- src/import/import.service.ts, src/year-rollover/rollover-apply.ts):
--
--   * Its PUT of a post is an upsert whose update is employmentData(dto): the
--     columns it always writes, and SCB's three and the days only when the DTO
--     carries them ("absent keeps"). It names neither new column, so its UPDATE
--     leaves both as they are, and its INSERT leaves them null and null, which
--     the pair CHECK admits. The same holds for the import's update of a post.
--     Its reads select the columns of its own schema, so it never reads them.
--   * Its rollover (createMany) writes next year's posts without them: a
--     rollover run by the API before this carries no limit. The API after this
--     carries it; the two columns are only ever written by the API after.
--   * Its Skolregler upsert does not name the new switch, so a save leaves it
--     off, or as it was.
--
-- The API after this reads them, so this runs first. Do not roll the API back
-- to one before this once a limit has been set: the history it serves lists a
-- key of a version that it does not know (employment-log-diff), and masks only
-- the keys it does know, so it would show a limit to an administrator without
-- HR-läs. RLS section 289 runs the old API's statements against a post that
-- holds a limit.
--
-- Production migrates beside the API that is serving it. ADD COLUMN takes each
-- table ACCESS EXCLUSIVE for a moment (the CHECKs scan the post's few rows;
-- nothing is rewritten), and a waiting ACCESS EXCLUSIVE queues every reader
-- behind it: the generator reads both tables at the start of every run, the
-- Skolregler card and the Anställning card on every load. The generator reads
-- the Skolregler and then the posts in one transaction, so a migration that
-- took the posts and then waited for the Skolregler would close a cycle with
-- it, and a request that takes them the other way round would close another.
-- Both locks are taken first, NOWAIT and together: a refusal rolls the
-- subtransaction back and with it whatever it got, and it tries again 50 ms
-- later. It never waits while it holds a lock. After 30 s of refusals it stops
-- with nothing done and can be rerun (prisma migrate resolve --rolled-back,
-- then deploy). lock_timeout bounds any wait nobody foresaw.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "TeacherEmployments" IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "LunchSettings" IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'TeacherEmployments and LunchSettings were not free at once in 30 s: nothing is changed, run the migration again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

ALTER TABLE "TeacherEmployments"
    ADD COLUMN "maxConsecutiveTeachingMinutes" INTEGER,
    ADD COLUMN "consecutiveBreakMinutes"       INTEGER,
    ADD CONSTRAINT "TeacherEmployments_maxConsecutiveTeachingMinutes_check"
        CHECK ("maxConsecutiveTeachingMinutes" BETWEEN 30 AND 480 AND "maxConsecutiveTeachingMinutes" % 5 = 0),
    ADD CONSTRAINT "TeacherEmployments_consecutiveBreakMinutes_check"
        CHECK ("consecutiveBreakMinutes" BETWEEN 5 AND 120 AND "consecutiveBreakMinutes" % 5 = 0),
    ADD CONSTRAINT "TeacherEmployments_consecutive_is_a_pair_check"
        CHECK (("maxConsecutiveTeachingMinutes" IS NULL) = ("consecutiveBreakMinutes" IS NULL));

ALTER TABLE "LunchSettings"
    ADD COLUMN "generatorKeepsConsecutiveTeaching" BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN "TeacherEmployments"."maxConsecutiveTeachingMinutes" IS
  'Most minutes of teaching in a row (a stretch ends at a break of consecutiveBreakMinutes); null = no limit. Soft in the generator, warned on a hand edit, hard in the Vikarietavla. Both columns or neither. HR data, like the days (maxTeachingDaysPerWeek): written by those who decide, left out of the gateway''s answer for an administrator without HR-läs.';
COMMENT ON COLUMN "TeacherEmployments"."consecutiveBreakMinutes" IS
  'The free time between two of the teacher''s lessons that ends a stretch of teaching; null = no limit. Both columns or neither. HR data, like the days (maxTeachingDaysPerWeek).';
COMMENT ON COLUMN "LunchSettings"."generatorKeepsConsecutiveTeaching" IS
  'Sammanhängande undervisning: the generator tries to keep each teacher''s stretches of teaching within their post''s limit. A wish, not a guarantee. Off by default; off sends the engine no limit. Written by PLANERING.';
