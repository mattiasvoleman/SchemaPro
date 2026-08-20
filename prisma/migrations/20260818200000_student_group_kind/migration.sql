-- Classes and teaching groups become distinguishable.
--
-- Both have always lived in "StudentGroups", and nothing recorded which was
-- which: the UI guessed from gradeLevel being NULL. That guess is wrong in
-- both directions — a nivågrupp for year 7 legitimately carries a gradeLevel,
-- and a teaching group created a minute ago has no members yet — so the
-- timplan could not group its rows honestly.

CREATE TYPE "StudentGroupKind" AS ENUM ('CLASS', 'TEACHING_GROUP');

ALTER TABLE "StudentGroups"
    ADD COLUMN "kind" "StudentGroupKind" NOT NULL DEFAULT 'CLASS';

-- Backfill from the only evidence that exists: a group somebody has added
-- cross-class members to IS a teaching group. Groups with neither members nor
-- a gradeLevel are teaching groups too — that is what the CSV import and the
-- "create group, then add members" flow produce, and a home class always ends
-- up with either a year or students.
UPDATE "StudentGroups" g
   SET "kind" = 'TEACHING_GROUP'
 WHERE EXISTS (
         SELECT 1 FROM "StudentGroupMembers" m WHERE m."studentGroupId" = g."id"
       )
    OR (
         g."gradeLevel" IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM "Users" u WHERE u."studentGroupId" = g."id"
         )
       );
