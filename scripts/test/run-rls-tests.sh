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

# The second school's lesson rows, table by table. Section 3 asserts the service
# principal sees none of another school's rows in the tables the SS12000 feeds
# read, and one table with nothing planted over there makes its half pass while
# proving nothing. The same list as section 3's; counted as the owner.
for table in MasterLessons CalendarLessons Subjects Rooms MasterLessonGroups \
    MasterLessonStudents CalendarLessonTeachers CalendarLessonGroups CalendarLessonStudents; do
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

if [ -z "$admin_auth_id" ]; then
  echo "FAIL: no SCHOOL_ADMIN with an authId in the primary school." >&2
  exit 1
fi

echo "==> Running policy assertions as ${APP_ROLE} (the role the API uses)"
compose exec -T "$DB_SERVICE" env "PGPASSWORD=${APP_PASSWORD}" \
  psql -U "$APP_ROLE" -h localhost -d "$DB_NAME" \
  -v ON_ERROR_STOP=1 -v "school_a=${school_a}" -v "admin_auth_id=${admin_auth_id}" \
  -v "student_b=${student_b}" -v "inactive_user_id=${inactive_user_id}" \
  -v "inactive_auth_id=00000000-0000-4000-8000-000000000003" -tA -f /dev/stdin \
  < scripts/test/rls-policies.sql

echo "==> RLS policy tests passed"
