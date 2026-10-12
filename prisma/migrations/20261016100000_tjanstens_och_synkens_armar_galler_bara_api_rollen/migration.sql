-- Tjänsteprincipalens och synkens armar gäller bara API:ts roll.
--
-- 56 policies on 32 tables in "public" were created without a TO clause, so
-- they apply TO public: to app_authenticated, which the gateway connects as,
-- but also to PostgREST's authenticated (every signed-in web and mobile user)
-- and to anon. They are the arms of the gateway's three principals, and each
-- admits rows on a GUC alone:
--
--   * the service principal (*_service_*, PrismaService.withServicePrincipal):
--     app.current_service_school_id(), read from app.service_school_id, and
--     for the subscription arms also app.current_service_key_id();
--   * the sync (*_sync_*, withSyncPrincipal): app.current_sync_school_id(),
--     read from app.sync_school_id;
--   * the key lookup (integration_keys_service_lookup and _touch,
--     withServiceKeyLookup): app.is_service_key_lookup(), read from
--     app.service_key_lookup.
--
-- Those three methods are the only code that sets the GUCs. Their callers are
-- the gateway's integration services (IntegrationKeyGuard, Ss12000Service,
-- Ss12000V2Service, Ss12000SubscriptionsService, Ss12000SyncService), which
-- reach the database through PrismaService as app_authenticated. Web and
-- mobile read through supabase-js .from() as authenticated, with no RPC, no
-- set_config and no connection of their own. So these arms have never
-- admitted a row to authenticated or anon, and they are not meant to.
--
-- Today only one thing keeps them from doing so: PostgREST does not let a
-- client set those GUCs. Measured on a throwaway database with Supabase's
-- default ACL, migrated to 20261016090000, seeded and with the RLS fixtures
-- applied. As authenticated with no user claims and app.service_school_id
-- set, the school's 91 Users rows were readable, email included, and all 91
-- were updated. With app.service_key_lookup = 'on', authenticated read an
-- integration key's hash and touched the row. Lacking USAGE on schema "app"
-- does not help, because a policy holds its functions by oid and PUBLIC
-- executes them. 20261016090000 took anon's table grants away, but
-- authenticated keeps its grants because web and mobile need them. One
-- function in an exposed schema that sets a config value, or one
-- db-pre-request hook, would make every signed-in user a service principal
-- for any school they name. The arms should not apply to that role at all.
--
-- ## The change
--
-- ALTER POLICY ... TO "app_authenticated" on each of the 56, named one by
-- one. ALTER POLICY with TO alone keeps the command, USING and WITH CHECK.
-- A missing arm fails the migration instead of being skipped, so a database
-- that the migrations did not shape is noticed. Guarded on pg_roles like
-- 20261013090000 and 20261015130000. A bare Postgres without
-- app_authenticated has no API role to give the arms to, so there they stay
-- TO public. Moving them to authenticated instead would defeat the purpose.
--
-- app_authenticated is a member of authenticated, so the API keeps every
-- authenticated arm and now also has these. authenticated does not inherit
-- app_authenticated's arms. The API's role must be named app_authenticated,
-- as docs/DEPLOYMENT.md §3 creates it. The guardian's lesson arms
-- (20261013090000) and the pupil's leave arm (20261015130000) already depend
-- on that name.
--
-- RLS section 37 asserts that no policy in "public" applies to PUBLIC, that
-- every policy calling a principal's function is app_authenticated's alone,
-- and that with each GUC set authenticated reads and updates nothing through
-- the arms while app_authenticated still does.

DO $$
DECLARE
  arm record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    RETURN;
  END IF;

  FOR arm IN SELECT * FROM (VALUES
    ('AcademicYearTimplans', 'academic_year_timplans_service_select'),
    ('AcademicYears', 'academic_years_service_select'),
    ('AcademicYears', 'academic_years_sync_select'),
    ('CalendarLessonGroups', 'calendar_lesson_groups_service_select'),
    ('CalendarLessonStudents', 'calendar_lesson_students_service_select'),
    ('CalendarLessonTeachers', 'calendar_lesson_teachers_service_select'),
    ('CalendarLessons', 'calendar_lessons_service_select'),
    ('GuardianStudents', 'guardian_students_service_insert'),
    ('GuardianStudents', 'guardian_students_service_select'),
    ('GuardianStudents', 'guardian_students_service_update'),
    ('GuardianStudents', 'guardian_students_sync_insert'),
    ('GuardianStudents', 'guardian_students_sync_select'),
    ('IntegrationApiKeys', 'integration_keys_service_lookup'),
    ('IntegrationApiKeys', 'integration_keys_service_touch'),
    ('LocalTimplans', 'local_timplans_service_select'),
    ('MasterLessonGroups', 'master_lesson_groups_service_select'),
    ('MasterLessonStudents', 'master_lesson_students_service_select'),
    ('MasterLessons', 'master_lessons_service_select'),
    ('PublicationPendingRemovals', 'publication_pending_removals_service_select'),
    ('PublishedLessons', 'published_lessons_service_select'),
    ('Rooms', 'rooms_service_select'),
    ('Schools', 'schools_service_select'),
    ('Schools', 'schools_sync_select'),
    ('Ss12000DutyLinks', 'ss12000_duty_links_service_select'),
    ('Ss12000DutyLinks', 'ss12000_duty_links_sync_insert'),
    ('Ss12000DutyLinks', 'ss12000_duty_links_sync_select'),
    ('Ss12000DutyLinks', 'ss12000_duty_links_sync_update'),
    ('Ss12000EntityVersions', 'ss12000_entity_versions_service_select'),
    ('Ss12000Sources', 'ss12000_sources_sync_select'),
    ('Ss12000Sources', 'ss12000_sources_sync_update'),
    ('Ss12000Subscriptions', 'ss12000_subscriptions_service_insert'),
    ('Ss12000Subscriptions', 'ss12000_subscriptions_service_select'),
    ('Ss12000Subscriptions', 'ss12000_subscriptions_service_update'),
    ('Ss12000SyncChanges', 'ss12000_sync_changes_sync_insert'),
    ('Ss12000SyncChanges', 'ss12000_sync_changes_sync_select'),
    ('Ss12000SyncChanges', 'ss12000_sync_changes_sync_update'),
    ('Ss12000SyncRuns', 'ss12000_sync_runs_sync_insert'),
    ('Ss12000SyncRuns', 'ss12000_sync_runs_sync_select'),
    ('Ss12000SyncRuns', 'ss12000_sync_runs_sync_update'),
    ('Ss12000Tombstones', 'ss12000_tombstones_service_select'),
    ('StaffingPolicies', 'staffing_policies_service_select'),
    ('StudentEnrollments', 'student_enrollments_service_select'),
    ('StudentGroupMembers', 'student_group_members_service_select'),
    ('StudentGroupMembers', 'student_group_members_sync_insert'),
    ('StudentGroupMembers', 'student_group_members_sync_select'),
    ('StudentGroups', 'student_groups_service_insert'),
    ('StudentGroups', 'student_groups_service_select'),
    ('StudentGroups', 'student_groups_sync_select'),
    ('Subjects', 'subjects_service_select'),
    ('TeacherDuties', 'teacher_duties_service_select'),
    ('TeacherEmployments', 'teacher_employments_service_select'),
    ('TimetablePublications', 'timetable_publications_service_select'),
    ('Users', 'users_service_select'),
    ('Users', 'users_service_update'),
    ('Users', 'users_sync_select'),
    ('Users', 'users_sync_update')
  ) AS t(tbl, name)
  LOOP
    EXECUTE format('ALTER POLICY %I ON %I TO "app_authenticated"', arm.name, arm.tbl);
  END LOOP;
END
$$;
