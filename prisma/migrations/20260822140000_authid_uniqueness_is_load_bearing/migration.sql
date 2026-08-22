-- Write down why Users.authId is unique, on the column itself.
--
-- Four SECURITY DEFINER functions in the app schema answer "who am I" and
-- "which school am I in" by selecting a single value WHERE "authId" = auth.uid().
-- Every policy in this database rests on them. They are declared RETURNS uuid,
-- not SETOF — so with two rows for one authId they do not error and do not
-- warn: they return whichever row the heap hands over first, and the answer
-- flips when rows are rewritten. Measured: the answer changed from one person
-- to another after nothing more than a DELETE and an INSERT elsewhere in the
-- table.
--
-- That makes the unique constraint the thing holding the whole authorization
-- layer upright, and it does not look like it from the schema. A future change
-- that relaxes it — the obvious first step towards letting one person work in
-- several schools — must rewrite those four functions in the same migration,
-- or every session silently starts resolving to an arbitrary school.
--
-- A comment cannot enforce anything. Its job is to be found by whoever is
-- about to drop the constraint. The enforcement is the assertion added to
-- scripts/test/rls-policies.sql in this change, which fails the build if the
-- constraint disappears.

COMMENT ON COLUMN "Users"."authId" IS
    'Supabase Auth user id (auth.users.id = JWT sub = auth.uid()). The UNIQUE '
    'constraint on this column is load-bearing: app.current_user_id, '
    'app.current_school_id, app.current_user_role and app.current_user_group_id '
    'all resolve a single row by this value and are declared RETURNS uuid, so a '
    'duplicate makes them return an arbitrary row without error. Do not relax '
    'the constraint except in the same migration that rewrites those four '
    'functions.';
