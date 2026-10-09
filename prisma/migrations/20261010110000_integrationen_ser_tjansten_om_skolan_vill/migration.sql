-- Integrationen ser tjänsten om skolan vill.
--
-- Fas 3 adds GET /ss12000/v1/duties: one SS12000 Duty per teacher's post of
-- the active läsår, read by the integration's service principal. Two facts
-- that feed are configuration, not personal data, and both live here.
--
-- ## StaffingPolicies."shareEmploymentWithIntegrations" BOOLEAN NOT NULL DEFAULT false
--
-- SS12000 2.1.0 defines Duty.dutyPercent ("Tjänstgöringsgrad i procent") and
-- Duty.hoursPerYear as standard fields, so emitting them is within the
-- standard. But a school's API keys are held by systems that need none of it
-- — a lärplattform (Vklass, StudyBee) wants who teaches whom, not anybody's
-- deltid — and a tjänstgöringsgrad is a personnel fact about a colleague. So
-- the default is OFF: /duties names the person, the school, the role, the
-- signature, the mentorships and the dates, and dutyPercent / hoursPerYear
-- appear only once an administrator ticks the switch on the policy card. The
-- nedsättning is never emitted either way (SS12000 has no field for it, and
-- the feed takes hoursPerYear from the post, not from post − nedsättning, so
-- the difference cannot be reconstructed from two published numbers).
--
-- NOT NULL DEFAULT false: every existing row reads false, and ADD COLUMN with
-- a constant default rewrites nothing.
--
-- ## staffing_policies_service_select
--
-- The service principal reads the policy row of its school, for the switch
-- above and for fullTimeAnnualHours (hoursPerYear of a ferietjänst). The same
-- one-liner every principal arm carries (20260914150000). This is the
-- school's configuration — riktmärke, modes, the agreement's annual figures —
-- and not data about any person, which is why the arm is acceptable on a
-- table 20261006100000 kept closed to the principal ("no field for it" was the
-- reason then; the switch is the field now). It is SELECT only: an
-- integration never writes the policy.
--
-- TeacherEmployments and TeacherDuties already carry their principal arms
-- (20261006100000, 20261007090000), reserved for this feed. The feed selects
-- exactly the columns a Duty is made of; reductionPercent, the target and the
-- note are never selected (src/integration/ss12000.service.ts, asserted by a
-- unit test).

ALTER TABLE "StaffingPolicies"
    ADD COLUMN "shareEmploymentWithIntegrations" BOOLEAN NOT NULL DEFAULT false;

CREATE POLICY "staffing_policies_service_select" ON "StaffingPolicies"
    FOR SELECT
    USING ("schoolId" = app.current_service_school_id());
