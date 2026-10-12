-- En vårdnadshavares ansökan börjar obeslutad, och bara en elev anmäler sin
-- egen frånvaro.
--
-- Two INSERT arms from 20260713170100 let a caller write more than the arm is
-- for. Both were measured on a throwaway database at main (bb47a2f) through
-- PostgREST's role: SET LOCAL ROLE authenticated with the caller's claims,
-- which is how the app writes these tables.
--
--   * leave_requests_guardian_insert (rewritten in 20260822090000) checks the
--     school, the requester and the guardian link, and nothing about the
--     decision. `authenticated` holds INSERT on every column (20260806000000)
--     and no trigger guards them. The fixture guardian therefore filed a
--     request for their child with status = 'APPROVED', themselves as
--     decidedById, decidedAt = now() and decisionNote = 'Beviljad'. Such a row
--     never reaches the admin's inbox, which lists PENDING requests. It sits
--     under Beviljade with an approval no admin gave, and decideLeaveRequest
--     refuses it as already decided, so no admin can decide it afterwards.
--     The arm now admits only an undecided request: PENDING, with no decider,
--     decision time or decision note, the same narrowing the pupil's arm got
--     (20261015130000). It stays on `authenticated`: the app's
--     LeaveRequestsScreen inserts through PostgREST, and it sends none of
--     these four columns (schoolId, studentId, requestedById, the two dates
--     and the reason), so the defaults meet the check. The gateway's
--     createLeaveRequest writes the same columns.
--
--   * absence_reports_student_insert lets the caller report an absence with
--     themselves as both pupil and reporter, and never asks for the role. A
--     teacher filed one about themselves through PostgREST's role. The arm is
--     the adult pupil's (POST /absence-reports lets a STUDENT report only for
--     themselves, FamilyService.assertMayActForStudent), so it now asks for
--     STUDENT. A guardian keeps absence_reports_guardian_insert for their
--     children and an admin keeps absence_reports_admin_all. The arm stays on
--     `authenticated`, as before. No client writes the table as a pupil
--     through PostgREST, but the guardian's arm beside it must stay there for
--     the app's GuardianHomeScreen, and the gateway's own checks (both times
--     or neither, a note of at most 500 characters) are ones a guardian's
--     direct insert skips already. Moving the pupil's arm to the API's role
--     is a separate narrowing. This migration changes who may report, not
--     where from.
--
-- The names stay, so the arm catalogues in scripts/test/rls-policies.sql
-- (32f and 33g on their branches) are unchanged. Section 35 asserts both arms
-- under app_authenticated and authenticated.

DROP POLICY IF EXISTS "leave_requests_guardian_insert" ON "LeaveRequests";
CREATE POLICY "leave_requests_guardian_insert" ON "LeaveRequests"
    FOR INSERT TO "authenticated"
    WITH CHECK (
        "schoolId" = (select app.current_school_id())
        AND "requestedById" = (select app.current_user_id())
        AND "studentId" IN (
            SELECT gs."studentId" FROM "GuardianStudents" gs
            WHERE gs."guardianId" = (select app.current_user_id())
              AND gs."schoolId" = (select app.current_school_id())
        )
        AND "status" = 'PENDING'
        AND "decidedById" IS NULL
        AND "decidedAt" IS NULL
        AND "decisionNote" IS NULL
    );

DROP POLICY IF EXISTS "absence_reports_student_insert" ON "AbsenceReports";
CREATE POLICY "absence_reports_student_insert" ON "AbsenceReports"
    FOR INSERT TO "authenticated"
    WITH CHECK (
        (select app.current_user_role()) = 'STUDENT'
        AND "schoolId" = (select app.current_school_id())
        AND "reportedById" = (select app.current_user_id())
        AND "studentId" = (select app.current_user_id())
    );
