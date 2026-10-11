-- En elev ansöker om sin egen ledighet.
--
-- POST /leave-requests lets a STUDENT file (family.controller.ts), and
-- FamilyService.assertMayActForStudent lets a pupil act for themselves and
-- no one else. But 20260713170100 gave LeaveRequests no INSERT arm for a
-- pupil: only leave_requests_admin_all and leave_requests_guardian_insert
-- (rewritten in 20260822090000). AbsenceReports, created beside it, has
-- absence_reports_student_insert. So every pupil's request failed in the
-- database. Reproduced on a throwaway database at main: the real
-- FamilyService.createLeaveRequest as an active STUDENT, through
-- PrismaService as app_authenticated, threw P2039 with 42501 "new row
-- violates row-level security policy for table LeaveRequests", which
-- HttpExceptionFilter answers as a 500, "An unexpected database error
-- occurred".
--
-- The pupil was meant to file. leave_requests_student_select lets them read
-- their own requests, a decision notifies the requester alone
-- (decideLeaveRequest), and LEAVE_DECIDED is one of a STUDENT's notice
-- types (notification-types.ts), which only a request of their own can
-- send them.
--
-- leave_requests_student_insert keeps absence_reports_student_insert's
-- three conditions (the school is the caller's, the pupil and the requester
-- are both the caller) and narrows the arm three ways:
--
--   * The caller is a STUDENT. Without it any principal could file a
--     request naming themselves as the pupil, and an admin's approval would
--     write full-day AbsenceReports for a teacher or a guardian.
--   * The request is undecided: PENDING, with no decider, decision time or
--     decision note. `authenticated` holds INSERT on every column
--     (20260806000000) and no trigger guards them, so without this a pupil
--     could file a request that is already approved.
--   * The arm is for the API's role alone (app_authenticated), not for
--     PostgREST's (authenticated). The gateway checks the range
--     (endDate >= startDate) and the DTO bounds the reason. A direct insert
--     would skip both, and neither web nor the app offers a pupil a leave
--     form, so nothing reads or writes the table as a pupil through
--     PostgREST. Created only where the role exists, like the guardian's
--     lesson arms (20261013090000). Where it does not, a pupil files
--     nothing, which is the safe side.
--
-- The guardian, admin and pupil SELECT arms are unchanged.
-- scripts/test/rls-policies.sql section 34 asserts the arm under both roles.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    CREATE POLICY "leave_requests_student_insert" ON "LeaveRequests"
        FOR INSERT TO "app_authenticated"
        WITH CHECK (
            (select app.current_user_role()) = 'STUDENT'
            AND "schoolId" = (select app.current_school_id())
            AND "studentId" = (select app.current_user_id())
            AND "requestedById" = (select app.current_user_id())
            AND "status" = 'PENDING'
            AND "decidedById" IS NULL
            AND "decidedAt" IS NULL
            AND "decisionNote" IS NULL
        );
  END IF;
END
$$;
