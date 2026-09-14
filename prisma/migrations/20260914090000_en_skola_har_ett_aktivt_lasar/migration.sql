-- A school has one active academic year, and the table holds it to that.
--
-- ## Why
--
-- "Only one academic year may be active per school" was kept by
-- AcademicYearsService alone: activating a year first set the school's active
-- years inactive with one UPDATE, then wrote its own row active, in the same
-- withRls transaction. That transaction runs READ COMMITTED, where the UPDATE
-- sees only the rows its statement snapshot holds, and two activations at once
-- both commit. Measured on a migrated and seeded database, both calls through
-- the real service as the seeded admin under RLS:
--
--   - A year is active. T1 activates X and has not committed. T2's UPDATE
--     finds the active year, waits for T1's row lock, re-reads the row as
--     inactive once T1 commits, and skips it. X was not active in T2's
--     snapshot, so T2 never looks at it, and writes its own year active. Two
--     PATCHes and two POSTs alike end with two active years.
--   - No year is active. Neither UPDATE finds a row, so nothing waits: T2
--     commits while T1 is still open, and T1 commits after it.
--
-- Nothing that reads the flag agrees on which of two active years counts. The
-- web's useActiveYear, and the admin pages that default to the active year,
-- take the earliest "startDate", then "id". Ss12000Service's activities export
-- the weekly lessons of every active year at once, and its person import files
-- the groups it creates under whichever active row findFirst meets.
--
-- ## Why an index and not a lock
--
-- An advisory lock on the school, taken before the UPDATE, would queue the
-- second activation behind the first, but only inside AcademicYearsService.
-- "authenticated" holds INSERT and UPDATE on this table and
-- academic_years_admin_all admits a school admin, so the same admin can write
-- "isActive" through PostgREST with their own token, where no lock the API
-- takes is taken. The index states the rule where every write lands. The
-- second of two racing activations now fails on its own write with 23505,
-- which Prisma raises as P2002 and rethrowPrismaError answers with 409.
--
-- ## Schools that already have more than one
--
-- Production is not readable from where this was written, so it cannot be
-- assumed clean, and CREATE UNIQUE INDEX over a duplicate would abort the
-- deploy and hold back every migration after it. Each school with more than
-- one active year keeps the one the web already shows as active (earliest
-- "startDate", then lowest "id", the order useActiveYear reads) and the others
-- are set inactive, so no admin page defaults to a different year after the
-- deploy than before it. The rows changed get a fresh "updatedAt", which is the
-- trace this leaves, and one PATCH re-activates a year it chose wrongly.
--
-- The table is locked first. SHARE ROW EXCLUSIVE stops writes and lets reads
-- through until the migration commits: an activation committed between the
-- UPDATE and the CREATE would otherwise fail the CREATE.
--
-- schema.prisma cannot state a partial index, so the model does not show this
-- one; see the note on model AcademicYear. Prisma's differ skips partial
-- indexes too: `prisma migrate diff` from the migrations to the schema prints
-- the same script with this migration as without it, so `migrate dev` neither
-- drops the index nor notices it is gone.

LOCK TABLE "AcademicYears" IN SHARE ROW EXCLUSIVE MODE;

UPDATE "AcademicYears" AS year
SET "isActive" = false, "updatedAt" = CURRENT_TIMESTAMP
FROM (
    SELECT "id",
           row_number() OVER (PARTITION BY "schoolId" ORDER BY "startDate", "id") AS position
    FROM "AcademicYears"
    WHERE "isActive"
) AS ranked
WHERE year."id" = ranked."id"
  AND ranked.position > 1;

CREATE UNIQUE INDEX "AcademicYears_one_active_per_school"
    ON "AcademicYears" ("schoolId")
    WHERE "isActive";
