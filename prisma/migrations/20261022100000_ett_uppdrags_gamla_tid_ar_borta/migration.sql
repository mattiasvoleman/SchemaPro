-- Ett uppdrags gamla tid är borta.
--
-- The second half of the contract 20261022090000 began. That migration took
-- every meaning from TeacherDuties.blockedConstraintId — its triggers, its
-- foreign key, its UNIQUE — and held the column empty with a CHECK, because
-- the API release it was deployed under still named the column in every
-- SELECT (Prisma lists a model's scalar columns by name). The release that
-- shipped with 20261022090000 does not name it: not in the schema, not in a
-- response, not in the rollover. So the column itself goes now, and its
-- CHECK with it.
--
-- DEPLOY ORDER. Only once the API running is that release or later: this
-- migration is safe before the merge of its own branch, but not before the
-- release with 20261022090000 has replaced the one before it.
--
-- The history keeps versions written before 20261017090000 with the key in
-- their JSON, and app.teacher_staffing_log keeps the key in its strip list,
-- where removing a key no row has any longer is no change.

ALTER TABLE "TeacherDuties" DROP COLUMN "blockedConstraintId";
