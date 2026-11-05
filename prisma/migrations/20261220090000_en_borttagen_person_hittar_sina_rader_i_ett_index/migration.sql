-- En borttagen person hittar sina rader i ett index: every foreign key into a
-- person (Users, HuvudmanMembers) now has an index that starts with the
-- person's column. Twenty-four had none that the lookup could use.
--
-- Removing a Users row makes Postgres look in every table that names it: for
-- the rows to null (SET NULL), to remove (CASCADE) or to refuse the removal
-- with. The lookup is an equality on the key's columns, once for each person
-- removed. Over 3 million attendance marks the gateway's bulk removal of 500
-- pupils ran out its 60 s (409 BULK_TIMED_OUT, nothing removed); with these
-- indexes the same removal went through in 3 to 10 s: 3.3 s on Postgres 16,
-- where it was first measured, and 7.8 to 10.1 s alone (9.0 s beside the run
-- without them) on Postgres 17 over a heavier fixture (120 000 lessons, every
-- mark naming a recorder), where a review measured it again; both on a host
-- under load. Over 1.5 million marks, 150 pupils took 14.2 s and then 0.8 s,
-- and 500 took 33.6 s and then 2 to 5 s (five runs; the rest is the pupils'
-- own marks going with them). The other tables of that fixture are nearly
-- empty, so the time was the AttendanceRecords key's.
--
-- The list is read from the catalogue, not from the schema: every foreign key
-- into Users or HuvudmanMembers (the two tables that hold people) that no
-- full index serves, one that starts with the person's column or whose first
-- columns are the key's own, in whatever order (the lookup is an equality on
-- each). Twenty-five; one of them, PersonalDataAccess (actorId, schoolId), is
-- answered by the partial index it has on actorId (the lookup's equality
-- implies its predicate, and the planner takes it), so twenty-four are built
-- here. The planner was asked of each, with sequential scans switched off,
-- what it can read to answer the lookup.
--
-- Eight have nothing that narrows it: it reads the whole table, or the whole
-- of an index that does not start with the key:
--
--   AttendanceRecords (recordedById)           SET NULL   the register's marks
--   AbsenceReports (reportedById)              CASCADE    a guardian's reports
--   LeaveRequests (requestedById)              CASCADE    a guardian's requests
--   LeaveRequests (decidedById)                SET NULL   the requests a person decided
--   LeaveRequests (referredById)               SET NULL   the requests a person referred
--   RoomBookings (decidedById)                 SET NULL   the bookings a person decided
--   PersonalDataAccess (huvudmanMemberId)      SET NULL   the reads of a huvudman's member
--   DevicePushTokens (userId, schoolId)        CASCADE    a person's devices
--
-- Sixteen are narrowed to one school (or one huvudman) by an index that
-- starts with it, and read that school's rows only. That is bounded, not
-- nothing: on a scratch copy of MasterLessons (50 schools of 3 000 lessons)
-- the lookup of coTeacherId read the school's 3 000 rows, 3 ms a person
-- (0.04 ms with the index), which is 1.5 s for 500 pupils. They are built
-- too, for one rule that needs no judgement of how big a table will get and
-- that section 291 of rls-owner-checks.sql keeps (a key to a person that no
-- index answers fails it):
--
--   AttendanceSharingDecisions (decidedById, schoolId)     SET NULL
--   HuvudmanApiKeys (createdById, huvudmanId)              SET NULL
--   HuvudmanSchoolEvents (byMemberId, huvudmanId)          SET NULL
--   HuvudmanSchoolEvents (byUserId, schoolId)              SET NULL
--   HuvudmanSchoolRequests (requestedById, huvudmanId)     SET NULL
--   HuvudmanSchools (requestedById, huvudmanId)            SET NULL
--   HuvudmanSchools (acceptedById, schoolId)               SET NULL
--   LeaveDelegationDecisions (decidedById, schoolId)       SET NULL
--   LocalTimplans (decidedByUserId, schoolId)              RESTRICT
--   LocalTimplans (gradeSpanSetByUserId, schoolId)         RESTRICT
--   MasterLessons (coTeacherId, schoolId)                  SET NULL
--   RetentionDecisions (decidedById, schoolId)             SET NULL
--   RoomLoans (decidedById, ownerSchoolId)                 SET NULL
--   RoomLoans (requestedById, borrowerSchoolId)            SET NULL
--   TeacherDuties (userId, schoolId)                       CASCADE
--   TeachingRequirements (coTeacherId, schoolId)           SET NULL
--
-- PersonalDataAccess is the läslogg, the largest and fastest growing table
-- of the lot, and nearly every row has no huvudmanMemberId (only a
-- huvudman's own reader sets it). Its index is partial, WHERE the column is
-- not NULL, as its actorId sibling is (20261212090100): the equality the
-- lookup asks implies the predicate, so the planner uses it, and the index
-- stays empty until a huvudman's reader reads (8 kB, where a full index held
-- 3.8 MB after 600 000 reads, an entry for each). Prisma cannot express a
-- partial index, so schema.prisma says so in a comment and declares the rest.
-- DevicePushTokens has an index that starts with schoolId and userId, but
-- only WHERE revokedAt IS NULL, which a lookup of every token cannot use; the
-- only index it can read is (id, schoolId), end to end.
--
-- Not CONCURRENTLY. Under Prisma 7.10 a file of plain statements is applied
-- one statement at a time, so CONCURRENTLY builds would run (tried); but a
-- file with a DO block, as the lock loop below is, is applied as one
-- transaction, where CONCURRENTLY is refused (25001, tried). The builds are
-- short (286 ms over 1.5 million marks, 110 ms over a million läslogg rows);
-- a CONCURRENTLY build that fails half way leaves an invalid index and a file
-- to resolve by hand (20261114090100); and that Prisma applies a file
-- statement by statement is nothing it promises. A plain build in one
-- transaction is all or nothing.
--
-- Its locks are taken the way the migrations that touch live tables take
-- theirs: NOWAIT and together, so a refusal rolls the subtransaction back with
-- whatever it got and it tries again 50 ms later. The migration never waits
-- while it holds a lock, and no request queues behind it; once it has them
-- all it builds the indexes without waiting for anything a request holds.
-- After 30 s of refusals it stops with nothing done, but Prisma will not run
-- the file again (P3009) until the failed run is marked rolled back, so the
-- message says so: prisma migrate resolve --rolled-back <this migration>, then
-- deploy. lock_timeout bounds any wait nobody foresaw. SHARE is the mode
-- CREATE INDEX takes: it lets reads through and holds writes for the build.
--
-- No IF NOT EXISTS, as no index of this repository has one: an index of one of
-- these names that was not made here is something to look at, and a failure
-- rolls the whole file back.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "AttendanceRecords", "AbsenceReports", "LeaveRequests", "RoomBookings",
                 "PersonalDataAccess", "DevicePushTokens",
                 "AttendanceSharingDecisions", "HuvudmanApiKeys", "HuvudmanSchoolEvents",
                 "HuvudmanSchoolRequests", "HuvudmanSchools", "LeaveDelegationDecisions",
                 "LocalTimplans", "MasterLessons", "RetentionDecisions", "RoomLoans",
                 "TeacherDuties", "TeachingRequirements" IN SHARE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'The tables the indexes are built on were not free at once in 30 s: nothing is changed. Mark this migration rolled back (prisma migrate resolve --rolled-back 20261220090000_en_borttagen_person_hittar_sina_rader_i_ett_index) and run prisma migrate deploy again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

-- Nothing narrows the lookup.

CREATE INDEX "AttendanceRecords_recordedById_idx" ON "AttendanceRecords"("recordedById");

CREATE INDEX "AbsenceReports_reportedById_idx" ON "AbsenceReports"("reportedById");

CREATE INDEX "LeaveRequests_requestedById_idx" ON "LeaveRequests"("requestedById");

CREATE INDEX "LeaveRequests_decidedById_idx" ON "LeaveRequests"("decidedById");

CREATE INDEX "LeaveRequests_referredById_idx" ON "LeaveRequests"("referredById");

CREATE INDEX "RoomBookings_decidedById_idx" ON "RoomBookings"("decidedById");

CREATE INDEX "DevicePushTokens_userId_schoolId_idx" ON "DevicePushTokens"("userId", "schoolId");

CREATE INDEX "PersonalDataAccess_huvudmanMemberId_idx" ON "PersonalDataAccess"("huvudmanMemberId") WHERE "huvudmanMemberId" IS NOT NULL;

-- Narrowed to one school (or one huvudman).

CREATE INDEX "AttendanceSharingDecisions_decidedById_schoolId_idx" ON "AttendanceSharingDecisions"("decidedById", "schoolId");

CREATE INDEX "HuvudmanApiKeys_createdById_huvudmanId_idx" ON "HuvudmanApiKeys"("createdById", "huvudmanId");

CREATE INDEX "HuvudmanSchoolEvents_byMemberId_huvudmanId_idx" ON "HuvudmanSchoolEvents"("byMemberId", "huvudmanId");

CREATE INDEX "HuvudmanSchoolEvents_byUserId_schoolId_idx" ON "HuvudmanSchoolEvents"("byUserId", "schoolId");

CREATE INDEX "HuvudmanSchoolRequests_requestedById_huvudmanId_idx" ON "HuvudmanSchoolRequests"("requestedById", "huvudmanId");

CREATE INDEX "HuvudmanSchools_requestedById_huvudmanId_idx" ON "HuvudmanSchools"("requestedById", "huvudmanId");

CREATE INDEX "HuvudmanSchools_acceptedById_schoolId_idx" ON "HuvudmanSchools"("acceptedById", "schoolId");

CREATE INDEX "LeaveDelegationDecisions_decidedById_schoolId_idx" ON "LeaveDelegationDecisions"("decidedById", "schoolId");

CREATE INDEX "LocalTimplans_decidedByUserId_schoolId_idx" ON "LocalTimplans"("decidedByUserId", "schoolId");

CREATE INDEX "LocalTimplans_gradeSpanSetByUserId_schoolId_idx" ON "LocalTimplans"("gradeSpanSetByUserId", "schoolId");

CREATE INDEX "MasterLessons_coTeacherId_schoolId_idx" ON "MasterLessons"("coTeacherId", "schoolId");

CREATE INDEX "RetentionDecisions_decidedById_schoolId_idx" ON "RetentionDecisions"("decidedById", "schoolId");

CREATE INDEX "RoomLoans_decidedById_ownerSchoolId_idx" ON "RoomLoans"("decidedById", "ownerSchoolId");

CREATE INDEX "RoomLoans_requestedById_borrowerSchoolId_idx" ON "RoomLoans"("requestedById", "borrowerSchoolId");

CREATE INDEX "TeacherDuties_userId_schoolId_idx" ON "TeacherDuties"("userId", "schoolId");

CREATE INDEX "TeachingRequirements_coTeacherId_schoolId_idx" ON "TeachingRequirements"("coTeacherId", "schoolId");
