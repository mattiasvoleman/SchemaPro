-- En administratör som undervisar, del 1: databasen. Markeringen Users."teaches".
--
-- ## Why
--
-- A rektor or a schemaläggare often teaches too. Planning already treats a
-- TEACHER and a SCHOOL_ADMIN alike as staff (the post, the picker, the
-- working-time rules, the rollover), but the teacher's own side (the note to
-- the substitute, the krisläge call, the mentor's decisions, the reporting
-- rate) asks for the role TEACHER and lets an administrator in nowhere. The
-- investigation "Kan en administratör undervisa?" chose a mark on the row,
-- not two rows per login and not a set of roles: one person stays one
-- Users.id, and the mark adds the teacher's own arms beside the
-- administrator's, which stay as they are.
--
-- ## What this migration adds, and what it does not do
--
-- It adds the mark and everything that must hold for it, and NO policy uses
-- it yet: every column is false for every row, so nothing a person can read or
-- write changes. The arms (the note to the substitute, krisläge, mentor, the
-- reporting rate) come in later migrations, each asking for the mark with
-- app.current_user_teaches(), and the gateway, the web and the app learn the
-- field in their own releases. Nothing here is read by the API before this
-- release, so it needs no particular deploy order.
--
-- * Users."teaches": false by default. A CHECK says it can be true only on an
--   administrator of a profile that writes something (FULL, REKTOR,
--   SCHEMALAGGARE, EXPEDITION), never on a läsare (LASARE) and never on
--   anybody else: a teacher teaches by being one, and a läsare changes
--   nothing. The list of profiles is positive, like the HR-läs CHECK's, so a
--   profile added later cannot teach until someone says so.
-- * Users_a_profile_follows_the_role takes the mark from anybody who stops
--   being an administrator or becomes a läsare, as it takes the profile and
--   HR-läs. It ZEROES, it does not refuse: the writer who changes the role
--   (the gateway before this release, an import, a decider in a hurry) cannot
--   know the mark, and a refusal would turn "make them a teacher" into an
--   error. Nothing is silent: the same statement's UserRoleChanges row says
--   fromTeaches true, toTeaches false. The CHECK is the backstop for a writer
--   that has switched the triggers off.
-- * Users_administrators_are_decided counts the mark as a change of an
--   administrator, which any change of an administrator's row already is
--   (OLD.role = SCHOOL_ADMIN): only rektor and a full administratör set or
--   take away the mark. The line is added so the rule says so, and so it
--   stays true if the guard is ever narrowed to named columns. What the
--   trigger lets through is what it always did: a signed-in person who decides
--   (including on their own row, as they may already change their own role
--   and profile), and a writer with no person (the owner, the seed, gallring,
--   the auth hook), the service principal and the sync. The sync cannot
--   reach the mark: Users_sync_writes_are_narrow refuses any administrator
--   and any column outside its list of free ones.
-- * UserRoleChanges gets "fromTeaches" and "toTeaches", written by
--   Users_role_changes_are_logged beside HR-läs. toTeaches is NOT NULL with
--   the default false, which is true of every row written before this
--   migration (nobody taught); fromTeaches is NULL where there is no earlier
--   value to name: at creation, and in rows written before this migration.
-- * app.current_user_teaches(): does the signed-in, active administrator at
--   the chosen school teach? The seventh of the helpers that pick the
--   caller's row (current_user_id, current_school_id, current_user_role,
--   current_user_group_id, current_user_may, current_user_decides), with the
--   clause rls-policies.sql section 10 holds equal. The huvudman's reader has
--   no row and teaches nothing.
--
-- ## Beslut 6: the mark needs a post
--
-- A person who teaches has a post, a TeacherEmployments row. That is the
-- brake on the one road by which an administrator could read more than they
-- do today: a schemaläggare writes who teaches a lesson, so one could name
-- themselves on a lesson to read its note to the substitute. The mark is set
-- by a decider, and a decider can set it only for a person who has a post;
-- the note's arm (a later migration) asks for the post of the lesson's läsår.
--
-- * Users_teaching_has_a_post: the mark is refused (TE409) unless the person
--   has a post for a läsår of the school. ANY läsår, not the current one: a
--   rule that asked for the active year would be stuck by every year switch
--   (Aktivera flips a flag and deletes nothing; the rollover only inserts the
--   next year's posts) and would leave a mark that stands "without a post"
--   the day the year changes. The year that matters for a lesson is asked
--   of the lesson's, where it belongs.
-- * TeacherEmployments_a_teaching_administrator_keeps_a_post: the last post of
--   a person who teaches is not removed (TE410). One of several is: a school
--   deletes a draft year, or a person's post for last year, without ceremony.
--   A person who is gone (Users delete, and every row's cascade from it) and a
--   school that is gone (a school's deletion cascades to both tables, in an
--   order nobody chose) are not "a teaching person losing a post": the
--   function asks whether the person and the school still exist, in the
--   snapshot of the statement that is deleting them, and lets the delete
--   through if they do not. A deactivation and gallring write Users and the
--   post's note and signature and delete no post, so neither is stuck. The
--   one cascade that is refused is a year's deletion that would take a
--   teaching person's only post: turn the mark off first.
-- * The two checks lock what the other reads: the mark's check locks the
--   person's posts FOR SHARE and the removal's check locks the person's other
--   posts FOR SHARE, so a mark set while the last post goes, and two last
--   posts going together, cannot both pass. A pair that closes a cycle ends
--   with one of them aborted (40P01), never with a mark and no post.
--
-- ## The three trigger functions are patched, not replaced
--
-- Users_a_profile_follows_the_role, Users_administrators_are_decided and
-- Users_role_changes_are_logged are read from the catalogue when the migration
-- runs (pg_get_functiondef), changed at named places by text, and created
-- again from that text. A body another branch has changed in the meantime
-- keeps its change; one whose lines are not where this migration expects them
-- stops it, with nothing changed, rather than being overwritten with an older
-- copy (parallel PRs rewriting one function drop a branch without a git
-- conflict). The names are the ones 20261110090000 chose.
--
-- ## Beside the live API: every lock at once, or none
--
-- Production runs this while the API before it serves requests. Users and
-- UserRoleChanges take ACCESS EXCLUSIVE (a column and a CHECK), and
-- TeacherEmployments a SHARE ROW EXCLUSIVE one (a trigger). A migration that
-- waited for one while it held another could close a cycle with a request that
-- holds the second and wants the first, and a waiting ACCESS EXCLUSIVE lock
-- queues every request behind it. So all three are taken first, NOWAIT and
-- together: a refusal rolls the subtransaction back and with it whatever it
-- got, and it tries again 50 ms later. The migration never waits while it
-- holds a lock and no request queues behind it. After 30 s of refusals it
-- stops with nothing done and can be rerun. lock_timeout bounds any wait
-- nobody foresaw. The new CHECK holds for every row (the column is false
-- everywhere), so validating it scans Users once.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "Users" IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "UserRoleChanges" IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "TeacherEmployments" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'Users, UserRoleChanges and TeacherEmployments were not free at once in 30 s: nothing is changed, run the migration again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- The mark, and its log
-- ---------------------------------------------------------------------------

ALTER TABLE "Users" ADD COLUMN "teaches" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Users"
    ADD CONSTRAINT "Users_teaches_is_a_teaching_administrators"
    CHECK (NOT "teaches" OR ("role" = 'SCHOOL_ADMIN' AND "adminProfile" IN ('FULL', 'REKTOR', 'SCHEMALAGGARE', 'EXPEDITION')));

COMMENT ON COLUMN "Users"."teaches" IS
  'An administrator who also teaches (20270212090000). True only on a SCHOOL_ADMIN of a profile that writes (never LASARE), and only while the person has a post (TeacherEmployments); set and taken away by rektor or a full administratör alone. Adds the teacher''s own arms beside the administrator''s: app.current_user_teaches().';

ALTER TABLE "UserRoleChanges"
    ADD COLUMN "fromTeaches" BOOLEAN,
    ADD COLUMN "toTeaches"   BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN "UserRoleChanges"."fromTeaches" IS
  'Users.teaches before the change; NULL where there was none to name (the person''s creation, and every row written before 20270212090000).';
COMMENT ON COLUMN "UserRoleChanges"."toTeaches" IS
  'Users.teaches after the change; false on every row written before 20270212090000, when nobody taught.';

-- ---------------------------------------------------------------------------
-- The helper: the seventh of the functions that pick the caller's row
-- ---------------------------------------------------------------------------

-- The clause from FROM to LIMIT is app.current_user_decides()'s, word for
-- word: rls-policies.sql section 10 holds the seven equal, so no helper can
-- answer for another row than the others do. A läsare's mark is false by the
-- CHECK, the role is asked anyway, as decides does.
CREATE FUNCTION app.current_user_teaches() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  RETURN (
    SELECT coalesce((
      SELECT u."role" = 'SCHOOL_ADMIN' AND u."teaches"
        FROM "Users" u
       WHERE u."authId" = (select auth.uid()) AND u."isActive"
         AND NOT (app.closed_schools() ? u."schoolId"::text)
         AND coalesce(app.requested_school() = u."schoolId"::text, true)
       ORDER BY u."loginSince", u."createdAt", u."id"
       LIMIT 1
    ), false)
  );
END
$$;

COMMENT ON FUNCTION app.current_user_teaches() IS
  'Is the signed-in, active SCHOOL_ADMIN at the chosen school marked as teaching (Users.teaches). False for everybody else, the huvudman''s reader included. Used by no policy before the arms that ask for it.';

-- ---------------------------------------------------------------------------
-- The three trigger functions, read from the catalogue and changed in place
-- ---------------------------------------------------------------------------

-- p_edits is [old, new, count, old, new, count, ...]: each old text must occur
-- exactly count times in the function as it stands, or nothing is changed.
CREATE FUNCTION pg_temp.tl_patch(p_fn regprocedure, p_edits text[]) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  def text := pg_get_functiondef(p_fn);
  i int;
  seen int;
  want int;
BEGIN
  FOR i IN 1..cardinality(p_edits) BY 3 LOOP
    want := p_edits[i + 2]::int;
    seen := (length(def) - length(replace(def, p_edits[i], ''))) / length(p_edits[i]);
    IF seen <> want THEN
      RAISE EXCEPTION '% is not as 20270212090000 expects: % occurrences of "%", expected %',
        p_fn, seen, left(p_edits[i], 70), want;
    END IF;
    def := replace(def, p_edits[i], p_edits[i + 1]);
  END LOOP;
  EXECUTE def;
END
$$;

-- The mark follows the role and the profile: only an administrator of a
-- profile that writes carries it. The same list as the CHECK.
SELECT pg_temp.tl_patch('app.users_profile_follows_the_role()'::regprocedure, ARRAY[
$o$  RETURN NEW;$o$,
$n$  -- Teaching (20270212090000): the mark goes with anybody who is not an
  -- administrator of a profile that writes. Zeroed, not refused (see the
  -- migration), and the log row says so.
  IF NOT (NEW."role" = 'SCHOOL_ADMIN' AND NEW."adminProfile" IN ('FULL', 'REKTOR', 'SCHEMALAGGARE', 'EXPEDITION')) THEN
    NEW."teaches" := false;
  END IF;
  RETURN NEW;$n$,
'1']);

-- The mark is a change of an administrator, which only a decider makes.
SELECT pg_temp.tl_patch('app.users_administrators_are_decided()'::regprocedure, ARRAY[
$o$            OR NEW."hrRead" IS DISTINCT FROM OLD."hrRead";$o$,
$n$            OR NEW."hrRead" IS DISTINCT FROM OLD."hrRead"
            OR NEW."teaches" IS DISTINCT FROM OLD."teaches";$n$,
'1']);

-- The log carries the mark beside HR-läs, on creation and on change.
SELECT pg_temp.tl_patch('app.users_role_changes_are_logged()'::regprocedure, ARRAY[
$o$"fromHrRead", "toHrRead", "actorId")$o$,
$n$"fromHrRead", "toHrRead", "fromTeaches", "toTeaches", "actorId")$n$,
'2',
$o$NULL, NEW."hrRead", app.current_user_id());$o$,
$n$NULL, NEW."hrRead", NULL, NEW."teaches", app.current_user_id());$n$,
'1',
$o$OLD."hrRead", NEW."hrRead", app.current_user_id());$o$,
$n$OLD."hrRead", NEW."hrRead", OLD."teaches", NEW."teaches", app.current_user_id());$n$,
'1',
$o$NEW."hrRead") IS NOT DISTINCT FROM (OLD."role", OLD."adminProfile", OLD."hrRead")$o$,
$n$NEW."hrRead", NEW."teaches") IS NOT DISTINCT FROM (OLD."role", OLD."adminProfile", OLD."hrRead", OLD."teaches")$n$,
'1']);

DROP FUNCTION pg_temp.tl_patch(regprocedure, text[]);

-- The two triggers that name columns now name the mark as well. The
-- decision guard has no column list and needs no change.
CREATE OR REPLACE TRIGGER "Users_a_profile_follows_the_role"
    BEFORE INSERT OR UPDATE OF "role", "adminProfile", "hrRead", "teaches" ON "Users"
    FOR EACH ROW EXECUTE FUNCTION app.users_profile_follows_the_role();

CREATE OR REPLACE TRIGGER "Users_role_changes_are_logged"
    AFTER INSERT OR UPDATE OF "role", "adminProfile", "hrRead", "teaches" ON "Users"
    FOR EACH ROW EXECUTE FUNCTION app.users_role_changes_are_logged();

-- ---------------------------------------------------------------------------
-- Beslut 6: the mark needs a post, and the post stays while the mark stands
-- ---------------------------------------------------------------------------

-- BEFORE, and named to sort after Users_administrators_are_decided, so that a
-- person who may not set the mark is refused for that (AR403) before they are
-- told what the person lacks. The mark that goes in is the one the profile
-- trigger left: WHEN is judged after the BEFORE triggers that fire earlier.
CREATE FUNCTION app.users_teaching_has_a_post() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  IF NOT NEW."teaches" OR (TG_OP = 'UPDATE' AND OLD."teaches") THEN
    RETURN NEW;
  END IF;
  -- FOR SHARE: a post being removed holds its row, so the removal that comes
  -- first is seen by this check, and one that comes after waits for the mark.
  PERFORM 1
     FROM "TeacherEmployments" e
    WHERE e."userId" = NEW."id" AND e."schoolId" = NEW."schoolId"
      FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TEACHES_NEEDS_A_POST: en administratör som undervisar har en tjänst för ett läsår, skapa tjänsten först'
      USING ERRCODE = 'TE409',
            DETAIL  = format('userId=%s', NEW."id");
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Users_teaching_has_a_post"
    BEFORE INSERT OR UPDATE OF "teaches" ON "Users"
    FOR EACH ROW WHEN (NEW."teaches")
    EXECUTE FUNCTION app.users_teaching_has_a_post();

-- The person's last post is not removed while they teach. Not asked of a
-- person who is gone or a school that is gone: their rows are deleted by the
-- cascade of that deletion, whichever table the cascade reaches first, and the
-- parent is no longer there to ask in the statement that deletes the child.
CREATE FUNCTION app.teacher_employments_keep_a_teaching_administrators_post() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  PERFORM 1 FROM "Users" u
    WHERE u."id" = OLD."userId" AND u."schoolId" = OLD."schoolId" AND u."teaches";
  IF NOT FOUND THEN
    RETURN OLD;
  END IF;
  PERFORM 1 FROM "Schools" s WHERE s."id" = OLD."schoolId";
  IF NOT FOUND THEN
    RETURN OLD;
  END IF;
  PERFORM 1
     FROM "TeacherEmployments" e
    WHERE e."userId" = OLD."userId" AND e."schoolId" = OLD."schoolId" AND e."id" <> OLD."id"
      FOR SHARE;
  IF FOUND THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'A_TEACHING_ADMINISTRATORS_LAST_POST_STAYS: en administratör som undervisar behåller sin sista tjänst, ta bort markeringen först'
    USING ERRCODE = 'TE410',
          DETAIL  = format('userId=%s academicYearId=%s', OLD."userId", OLD."academicYearId");
END
$$;

CREATE TRIGGER "TeacherEmployments_a_teaching_administrator_keeps_a_post"
    BEFORE DELETE ON "TeacherEmployments"
    FOR EACH ROW EXECUTE FUNCTION app.teacher_employments_keep_a_teaching_administrators_post();

-- ---------------------------------------------------------------------------
-- The two new trigger functions are no API role's to call (the same as the
-- three beside them, 20261110090000). The helper has the default, as its
-- sibling current_user_decides has: a policy asks it.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  fn text;
  r text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'app.users_teaching_has_a_post()',
    'app.teacher_employments_keep_a_teaching_administrators_post()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'app_authenticated', 'service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', fn, r);
      END IF;
    END LOOP;
  END LOOP;
END
$$;
