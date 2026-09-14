-- Only a pupil has a class: Users."studentGroupId" is NULL unless "role" is
-- STUDENT, and the table is what says so.
--
-- ## Why
--
-- app.current_user_group_id() returns the caller's "studentGroupId" without
-- looking at the role, and eleven SELECT policies — the pupil's lessons,
-- lesson groups and teachers, meals, sittings, rasts and the class itself —
-- key on it. A teacher, guardian or admin whose row carries a class is handed
-- that class's read path. Until now the rule lived in the writers, and not
-- every writer could hold it:
--
--   * UsersService.update has judged the merged row since 3b1931c
--     (2026-08-22). Before that it refused only a body naming both a group and
--     a non-student role, so `PATCH { role: 'TEACHER' }` on a pupil kept the
--     class. That is an admin correcting a role, which is ordinary use.
--   * Since 92133cf that check reads the row FOR NO KEY UPDATE, which queues
--     a second PATCH and nothing else. The SS12000 import reads the role
--     without a lock before writing a class, so under READ COMMITTED (see
--     "Isolation" in PrismaService) a PATCH that commits between the import's
--     read and its write stores a teacher in a class with every check having
--     passed.
--   * users_admin_all grants an admin UPDATE on "Users" with their own token,
--     through PostgREST, where no TypeScript runs at all.
--
-- A CHECK is the one place all of those writes land. It is evaluated on the
-- row a statement is about to store, so no interleaving of transactions can
-- commit a row it refuses.
--
-- ## Existing rows are cleaned, not stopped on
--
-- The first bullet means a database that ran that code may already hold such
-- rows, and nothing in the repository can query production to say whether it
-- does. Rather than fail the deploy on them, the class is cleared from every
-- non-pupil before the constraint is added:
--
--   * It only ever removes access. The role is left as it is. The web and
--     mobile class lists and the rosters generation reads for rooms and
--     lunches already ask for role = 'STUDENT', so to them the class was never
--     there. Attendance's roster check deliberately does not, so a non-pupil
--     holding a class could have attendance recorded in its lessons; that
--     ends here too.
--   * Failing instead stops every later migration until someone resolves this
--     one by hand, over rows whose likeliest story is an admin who fixed a
--     role and not the class.
--   * When the role was the mistake — a pupil saved as a teacher — the admin
--     sets the role back and puts the pupil in their class again.
--
-- To see what will change, run this as the owner before deploying:
--
--     SELECT id, "schoolId", role, "studentGroupId", "updatedAt"
--       FROM "Users"
--      WHERE "studentGroupId" IS NOT NULL AND role <> 'STUDENT';
--
-- "updatedAt" is not stamped, so it still dates the edit that left the row
-- this way.
--
-- ## The lock comes first
--
-- ACCESS EXCLUSIVE is the lock the ALTER takes anyway. Taken before the UPDATE
-- instead, no write can store a new offending row between the cleanup and the
-- constraint, and the migration never upgrades a weaker lock while readers
-- hold theirs, which is how a lock upgrade deadlocks. It costs the UPDATE's
-- duration on top: one pass over one table.
--
-- ## What stays in the services
--
-- UsersService's 400 and the import's role-keyed write stay. A violation of
-- this CHECK reaches a caller as an unmapped 500; the service refuses the
-- ordinary case in words first, and the import keeps a lost race from rolling
-- back a whole batch over one person.

LOCK TABLE "Users" IN ACCESS EXCLUSIVE MODE;

UPDATE "Users"
   SET "studentGroupId" = NULL
 WHERE "studentGroupId" IS NOT NULL
   AND "role" <> 'STUDENT';

ALTER TABLE "Users"
    ADD CONSTRAINT "Users_only_a_student_has_a_class"
    CHECK ("studentGroupId" IS NULL OR "role" = 'STUDENT');
