-- En tjänsts historik kan handla om en period.
--
-- TeacherEmploymentLogs (20261010090000) records every version of a teacher's
-- post and uppdrag, and says which by its entity: EMPLOYMENT or DUTY. The next
-- migration gives a post periods (TeacherEmploymentPeriods: the tjänst from
-- 1 november), and a period's versions are history of the same tjänst, so the
-- log gains a third kind for them.
--
-- In a migration of its own: PostgreSQL does not let a value added by ALTER
-- TYPE ... ADD VALUE be used in the transaction that added it, and the next
-- migration's trigger function names it.
--
-- The release before this one reads TeacherEmploymentLogs through a Prisma
-- client whose enum has two values, and would fail to read a PERIOD row. No
-- such row exists until a period is written, and only the release that ships
-- with this migration writes one; the minute or two both releases answer
-- while Railway swaps them is the window in which an old reader could meet
-- one, on the Historik card of a teacher whose post just got a period.

ALTER TYPE "TeacherLogEntity" ADD VALUE 'PERIOD';
