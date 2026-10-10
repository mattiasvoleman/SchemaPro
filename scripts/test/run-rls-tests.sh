#!/usr/bin/env bash
#
# Runs the row-level-security policy tests against the docker-compose database.
#
#   scripts/test/run-rls-tests.sh
#
# Exits non-zero on the first failed assertion, so it works as a CI gate.
#
# These tests exist because the e2e suite mocks PrismaService and therefore
# cannot see the database contract at all. Three production-breaking bugs
# shipped behind that blind spot — missing grants, an identity lookup returning
# zero rows under RLS, and an integration API silently returning empty payloads.
#
# Assumes the stack is up and seeded:
#   docker compose up -d --wait
#   npm run db:seed          (with DIRECT_URL pointing at localhost:5432)

set -euo pipefail

DB_SERVICE="${DB_SERVICE:-db}"
DB_NAME="${DB_NAME:-schemapro}"
DB_OWNER="${DB_OWNER:-postgres}"
APP_ROLE="${APP_ROLE:-app_authenticated}"
APP_PASSWORD="${APP_PASSWORD:-app_authenticated_local}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../.." && pwd)"
cd "$repo_root"

compose() { docker compose "$@"; }

echo "==> Applying fixtures as ${DB_OWNER}"
# The last line of the fixtures script is the id of the primary school; the
# unprivileged role cannot discover it, so it is captured here and passed in.
school_a="$(
  compose exec -T "$DB_SERVICE" psql -U "$DB_OWNER" -d "$DB_NAME" \
    -v ON_ERROR_STOP=1 -tA -f /dev/stdin \
    < scripts/test/rls-fixtures.sql | tail -n 1 | tr -d '[:space:]'
)"

if [ -z "$school_a" ]; then
  echo "FAIL: fixtures did not yield a school id. Is the database seeded?" >&2
  exit 1
fi
echo "    primary school: ${school_a}"

# The authenticated policies key off auth.uid(), so the assertions need a real
# admin authId to act as. Like the school id, the unprivileged role cannot look
# it up — with no principal set it sees zero users — so the owner reads it here.
#
# `isActive` is part of the predicate because the fixtures now plant a
# DEACTIVATED admin in this same school. Picking that one would resolve to no
# principal at all and fail every section below for the wrong reason.
admin_auth_id="$(
  compose exec -T "$DB_SERVICE" psql -U "$DB_OWNER" -d "$DB_NAME" \
    -v ON_ERROR_STOP=1 -tAc \
    "SELECT \"authId\" FROM \"Users\" WHERE \"schoolId\" = '${school_a}' \
       AND role = 'SCHOOL_ADMIN' AND \"isActive\" AND \"authId\" IS NOT NULL LIMIT 1" \
  | tr -d '[:space:]'
)"

# The deactivated admin of the SAME school. Read as the owner for the usual
# reason, and required to be inactive here so a fixture that silently stopped
# deactivating them cannot let the lockout assertions pass vacuously.
inactive_user_id="$(
  compose exec -T "$DB_SERVICE" psql -U "$DB_OWNER" -d "$DB_NAME" \
    -v ON_ERROR_STOP=1 -tAc \
    "SELECT id FROM \"Users\" \
      WHERE \"authId\" = '00000000-0000-4000-8000-000000000003' AND NOT \"isActive\"" \
  | tr -d '[:space:]'
)"

if [ -z "$inactive_user_id" ]; then
  echo "FAIL: no deactivated admin in the primary school; fixtures did not run." >&2
  exit 1
fi

# The other school's pupil, for the cross-tenant guardian assertion. Read as the
# owner: the app role cannot see the second tenant at all, which is the point.
student_b="$(
  compose exec -T "$DB_SERVICE" psql -U "$DB_OWNER" -d "$DB_NAME" \
    -v ON_ERROR_STOP=1 -tAc \
    "SELECT id FROM \"Users\" WHERE \"authId\" = '00000000-0000-4000-8000-000000000002'" \
  | tr -d '[:space:]'
)"

if [ -z "$student_b" ]; then
  echo "==> could not read the second school's pupil; fixtures did not run" >&2
  exit 1
fi

# The second school's room lock. Section 7d asserts that no rule from another
# school is visible, and with nothing planted over there that passes while
# proving nothing — so the runner refuses to start instead. Counted as the
# owner, since the app role cannot see the other tenant at all.
foreign_rule_rooms="$(
  compose exec -T "$DB_SERVICE" psql -U "$DB_OWNER" -d "$DB_NAME" \
    -v ON_ERROR_STOP=1 -tAc \
    "SELECT count(*) FROM \"RoomPreferenceRooms\" rr \
       JOIN \"RoomPreferences\" p ON p.id = rr.\"preferenceId\" \
      WHERE rr.\"schoolId\" <> '${school_a}' AND p.kind = 'LOCK'" \
  | tr -d '[:space:]'
)"

if [ "${foreign_rule_rooms:-0}" = "0" ]; then
  echo "FAIL: no room lock in the second school; fixtures did not run." >&2
  exit 1
fi

# The second school's rows, table by table. Section 3 asserts the service
# principal sees none of another school's rows in the tables SS12000 reads, and
# one table with nothing planted over there makes its half pass while proving
# nothing. The same list as section 3's; counted as the owner.
for table in AcademicYears StudentGroups GuardianStudents MasterLessons CalendarLessons \
    Subjects Rooms MasterLessonGroups MasterLessonStudents \
    CalendarLessonTeachers CalendarLessonGroups CalendarLessonStudents; do
  foreign_rows="$(
    compose exec -T "$DB_SERVICE" psql -U "$DB_OWNER" -d "$DB_NAME" \
      -v ON_ERROR_STOP=1 -tAc \
      "SELECT count(*) FROM \"${table}\" WHERE \"schoolId\" <> '${school_a}'" \
    | tr -d '[:space:]'
  )"
  if [ "${foreign_rows:-0}" = "0" ]; then
    echo "FAIL: no ${table} rows in the second school; fixtures did not run." >&2
    exit 1
  fi
done

# And in each link table, a row attached to one of the primary school's lessons
# but filed under another school. Without one, a policy that asked the lesson's
# school instead of the row's own passes section 3.
for link in MasterLessonGroups:MasterLessons:masterLessonId \
    MasterLessonStudents:MasterLessons:masterLessonId \
    CalendarLessonTeachers:CalendarLessons:calendarLessonId \
    CalendarLessonGroups:CalendarLessons:calendarLessonId \
    CalendarLessonStudents:CalendarLessons:calendarLessonId; do
  IFS=: read -r table lessons lesson_key <<< "$link"
  crossed_rows="$(
    compose exec -T "$DB_SERVICE" psql -U "$DB_OWNER" -d "$DB_NAME" \
      -v ON_ERROR_STOP=1 -tAc \
      "SELECT count(*) FROM \"${table}\" x JOIN \"${lessons}\" l ON l.id = x.\"${lesson_key}\" \
        WHERE l.\"schoolId\" = '${school_a}' AND x.\"schoolId\" <> l.\"schoolId\"" \
    | tr -d '[:space:]'
  )"
  if [ "${crossed_rows:-0}" = "0" ]; then
    echo "FAIL: no ${table} row filed under another school than its lesson's; fixtures did not run." >&2
    exit 1
  fi
done

# The second school's tjänstefördelning rows. Section 7h asserts that an admin
# and a teacher of the primary school see none of another school's policy,
# posts or behörigheter, and section 17 the same of its uppdrag; with nothing
# planted over there each of those passes while proving nothing. Counted as
# the owner, like the room lock.
for table in StaffingPolicies TeacherEmployments TeacherSubjectQualifications TeacherDuties TeacherEmploymentLogs; do
  foreign_rows="$(
    compose exec -T "$DB_SERVICE" psql -U "$DB_OWNER" -d "$DB_NAME" \
      -v ON_ERROR_STOP=1 -tAc \
      "SELECT count(*) FROM \"${table}\" WHERE \"schoolId\" <> '${school_a}'" \
    | tr -d '[:space:]'
  )"
  if [ "${foreign_rows:-0}" = "0" ]; then
    echo "FAIL: no ${table} row in the second school; fixtures did not run." >&2
    exit 1
  fi
done

# The second school's local timplans. Section 16 asserts that school A's admin
# sees neither of them and that school B's admin sees both, and it needs one of
# each status there: a family arm that ignored the tenant would show the
# decided one, an admin arm that ignored it would show both. Also read as the
# owner: the second school's DECIDED plan and its subject, which section 16
# names in composite-key refusals that a policy alone cannot make.
for status in DRAFT DECIDED; do
  foreign_plans="$(
    compose exec -T "$DB_SERVICE" psql -U "$DB_OWNER" -d "$DB_NAME" \
      -v ON_ERROR_STOP=1 -tAc \
      "SELECT count(*) FROM \"LocalTimplans\" p \
         WHERE p.\"schoolId\" <> '${school_a}' AND p.status = '${status}' \
           AND EXISTS (SELECT 1 FROM \"LocalTimplanEntries\" e WHERE e.\"localTimplanId\" = p.id)" \
    | tr -d '[:space:]'
  )"
  if [ "${foreign_plans:-0}" = "0" ]; then
    echo "FAIL: no ${status} local timplan with an entry in the second school; fixtures did not run." >&2
    exit 1
  fi
done

plan_b="$(
  compose exec -T "$DB_SERVICE" psql -U "$DB_OWNER" -d "$DB_NAME" \
    -v ON_ERROR_STOP=1 -tAc \
    "SELECT id FROM \"LocalTimplans\" WHERE \"schoolId\" <> '${school_a}' AND status = 'DECIDED' \
      ORDER BY \"createdAt\" LIMIT 1" \
  | tr -d '[:space:]'
)"
subject_b="$(
  compose exec -T "$DB_SERVICE" psql -U "$DB_OWNER" -d "$DB_NAME" \
    -v ON_ERROR_STOP=1 -tAc \
    "SELECT id FROM \"Subjects\" WHERE \"schoolId\" <> '${school_a}' AND code = 'RLSFIX' LIMIT 1" \
  | tr -d '[:space:]'
)"
school_b="$(
  compose exec -T "$DB_SERVICE" psql -U "$DB_OWNER" -d "$DB_NAME" \
    -v ON_ERROR_STOP=1 -tAc \
    "SELECT id FROM \"Schools\" WHERE slug = 'rls-fixture-school'" \
  | tr -d '[:space:]'
)"
if [ -z "$plan_b" ] || [ -z "$subject_b" ] || [ -z "$school_b" ]; then
  echo "FAIL: could not read the second school, its decided timplan or its subject; fixtures did not run." >&2
  exit 1
fi

# The second school's duty slot: an UNAVAILABLE TEACHER constraint a duty there
# links to. Section 17 has school A's admin point a duty at it, stamped with
# school A, which only the composite (blockedConstraintId, schoolId) key can
# refuse — and the link trigger must leave it to the key rather than describe
# school B's row. Read as the owner, like the decided plan above.
constraint_b="$(
  compose exec -T "$DB_SERVICE" psql -U "$DB_OWNER" -d "$DB_NAME" \
    -v ON_ERROR_STOP=1 -tAc \
    "SELECT c.id FROM \"AvailabilityConstraints\" c \
       JOIN \"TeacherDuties\" d ON d.\"blockedConstraintId\" = c.id \
      WHERE c.\"schoolId\" <> '${school_a}' AND c.reason = 'RLS fixture: APT' LIMIT 1" \
  | tr -d '[:space:]'
)"
if [ -z "$constraint_b" ]; then
  echo "FAIL: no linked duty slot in the second school; fixtures did not run." >&2
  exit 1
fi

# The second school's year attachments, one to a plan of each status. Section
# 18 asserts that school A's admin, teacher, pupil and guardian see none of
# them and that school B's admin sees both; with nothing planted there each
# half passes while proving nothing. Also read: that year's id, which section
# 18 names in a composite-key refusal a policy alone cannot make.
for status in DRAFT DECIDED; do
  foreign_attachments="$(
    compose exec -T "$DB_SERVICE" psql -U "$DB_OWNER" -d "$DB_NAME" \
      -v ON_ERROR_STOP=1 -tAc \
      "SELECT count(*) FROM \"AcademicYearTimplans\" a \
         JOIN \"LocalTimplans\" p ON p.id = a.\"localTimplanId\" \
        WHERE a.\"schoolId\" <> '${school_a}' AND p.status = '${status}'" \
    | tr -d '[:space:]'
  )"
  if [ "${foreign_attachments:-0}" = "0" ]; then
    echo "FAIL: no year attached to a ${status} local timplan in the second school; fixtures did not run." >&2
    exit 1
  fi
done

year_b="$(
  compose exec -T "$DB_SERVICE" psql -U "$DB_OWNER" -d "$DB_NAME" \
    -v ON_ERROR_STOP=1 -tAc \
    "SELECT \"academicYearId\" FROM \"AcademicYearTimplans\" WHERE \"schoolId\" <> '${school_a}' LIMIT 1" \
  | tr -d '[:space:]'
)"
if [ -z "$year_b" ]; then
  echo "FAIL: could not read the second school's attached year; fixtures did not run." >&2
  exit 1
fi

# One of the second school's classes, in that same year. Section 19 has school
# A's admin link a group to it (a cross-school predecessor, which only the
# composite (predecessorId, schoolId) keys can refuse), and file a linked group
# of its own under school B's year (which the plain academicYearId key lets
# through and the link trigger must refuse without naming school B's rows).
# The year is the one read just above: the fixtures' 'RLS Fixture Year' is the
# only year school B has, and section 18's attachments hang on it.
group_b="$(
  compose exec -T "$DB_SERVICE" psql -U "$DB_OWNER" -d "$DB_NAME" \
    -v ON_ERROR_STOP=1 -tAc \
    "SELECT id FROM \"StudentGroups\" WHERE \"schoolId\" = '${school_b}' AND \"academicYearId\" = '${year_b}' AND name = 'RLS Fixture Class'" \
  | tr -d '[:space:]'
)"
if [ -z "$group_b" ]; then
  echo "FAIL: could not read the second school's class in its year; fixtures did not run." >&2
  exit 1
fi

if [ -z "$admin_auth_id" ]; then
  echo "FAIL: no SCHOOL_ADMIN with an authId in the primary school." >&2
  exit 1
fi

# The second school's tillgodoräknad dag. Section 23 asserts that school A's
# admin and teacher see none of B's credits and that B's admin sees it; with
# nothing planted there the tenant half passes while proving nothing.
foreign_credits="$(
  compose exec -T "$DB_SERVICE" psql -U "$DB_OWNER" -d "$DB_NAME" \
    -v ON_ERROR_STOP=1 -tAc \
    "SELECT count(*) FROM \"TimplanCredits\" WHERE \"schoolId\" = '${school_b}'" \
  | tr -d '[:space:]'
)"
if [ "${foreign_credits:-0}" = "0" ]; then
  echo "FAIL: no timplan credit in the second school; fixtures did not run." >&2
  exit 1
fi

# The second school's class history. Section 26 asserts that no role of the
# primary school reads another school's segments; with none over there the
# tenant half passes while proving nothing. Counted as the owner.
foreign_enrolments="$(
  compose exec -T "$DB_SERVICE" psql -U "$DB_OWNER" -d "$DB_NAME" \
    -v ON_ERROR_STOP=1 -tAc \
    "SELECT count(*) FROM \"StudentEnrollments\" WHERE \"schoolId\" = '${school_b}'" \
  | tr -d '[:space:]'
)"
if [ "${foreign_enrolments:-0}" = "0" ]; then
  echo "FAIL: no class history in the second school; fixtures did not run." >&2
  exit 1
fi

# The second school's published statement (section 26d), likewise.
foreign_statements="$(
  compose exec -T "$DB_SERVICE" psql -U "$DB_OWNER" -d "$DB_NAME" \
    -v ON_ERROR_STOP=1 -tAc \
    "SELECT count(*) FROM \"TimplanStatements\" WHERE \"schoolId\" = '${school_b}'" \
  | tr -d '[:space:]'
)"
if [ "${foreign_statements:-0}" = "0" ]; then
  echo "FAIL: no published statement in the second school; fixtures did not run." >&2
  exit 1
fi

echo "==> Running policy assertions as ${APP_ROLE} (the role the API uses)"
compose exec -T "$DB_SERVICE" env "PGPASSWORD=${APP_PASSWORD}" \
  psql -U "$APP_ROLE" -h localhost -d "$DB_NAME" \
  -v ON_ERROR_STOP=1 -v "school_a=${school_a}" -v "admin_auth_id=${admin_auth_id}" \
  -v "student_b=${student_b}" -v "inactive_user_id=${inactive_user_id}" \
  -v "plan_b=${plan_b}" -v "subject_b=${subject_b}" -v "school_b=${school_b}" \
  -v "constraint_b=${constraint_b}" -v "year_b=${year_b}" -v "group_b=${group_b}" \
  -v "inactive_auth_id=00000000-0000-4000-8000-000000000003" -tA -f /dev/stdin \
  < scripts/test/rls-policies.sql

echo "==> RLS policy tests passed"
