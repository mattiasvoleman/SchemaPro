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
admin_auth_id="$(
  compose exec -T "$DB_SERVICE" psql -U "$DB_OWNER" -d "$DB_NAME" \
    -v ON_ERROR_STOP=1 -tAc \
    "SELECT \"authId\" FROM \"Users\" WHERE \"schoolId\" = '${school_a}' \
       AND role = 'SCHOOL_ADMIN' AND \"authId\" IS NOT NULL LIMIT 1" \
  | tr -d '[:space:]'
)"

if [ -z "$admin_auth_id" ]; then
  echo "FAIL: no SCHOOL_ADMIN with an authId in the primary school." >&2
  exit 1
fi

# Same for a student: the staff-only policies are proved by the principal they
# must exclude, and a lookup that quietly found nobody would turn that
# assertion into a pass.
student_auth_id="$(
  compose exec -T "$DB_SERVICE" psql -U "$DB_OWNER" -d "$DB_NAME" \
    -v ON_ERROR_STOP=1 -tAc \
    "SELECT \"authId\" FROM \"Users\" WHERE \"schoolId\" = '${school_a}' \
       AND role = 'STUDENT' AND \"authId\" IS NOT NULL LIMIT 1" \
  | tr -d '[:space:]'
)"

if [ -z "$student_auth_id" ]; then
  echo "FAIL: no STUDENT with an authId in the primary school." >&2
  exit 1
fi

echo "==> Running policy assertions as ${APP_ROLE} (the role the API uses)"
compose exec -T "$DB_SERVICE" env "PGPASSWORD=${APP_PASSWORD}" \
  psql -U "$APP_ROLE" -h localhost -d "$DB_NAME" \
  -v ON_ERROR_STOP=1 -v "school_a=${school_a}" -v "admin_auth_id=${admin_auth_id}" \
  -v "student_auth_id=${student_auth_id}" -tA -f /dev/stdin \
  < scripts/test/rls-policies.sql

echo "==> RLS policy tests passed"
