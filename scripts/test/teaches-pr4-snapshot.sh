#!/usr/bin/env bash
#
# The snapshot that shows nothing else changed (20270219090000, "En administratör som undervisar, del 4").
#
#   A_SERVICE=db17 A_DB=fx17 B_SERVICE=db17 B_DB=fxb17 scripts/test/teaches-pr4-snapshot.sh [outdir]
#
# A is a database with the schema of main (the migration before 20270216090000) and the fixtures of rls-fixtures.sql, B the same data
# with the branch's migration. Both throwaway databases of a compose project (COMPOSE_FILE / COMPOSE_PROJECT_NAME as for
# run-rls-tests.sh). The script runs scripts/test/teaches-pr4-snapshot.sql as the API's role on each, writes a.txt and b.txt to the
# output directory, and prints the lines that differ. Exit 0 if every difference is a marked principal on CrisisReports (the three
# converted insert arms), a function line (what the mark is meant to change) or the log of the mark, 1 otherwise.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../.." && pwd)"
cd "$repo_root"
out="${1:-reports/teaches-pr4/snapshot}"
mkdir -p "$out"
APP_ROLE="${APP_ROLE:-app_authenticated}"
APP_PASSWORD="${APP_PASSWORD:-app_authenticated_local}"

run() { # service db outfile
  docker compose exec -T -e "PGPASSWORD=${APP_PASSWORD}" "$1" psql -U "$APP_ROLE" -h localhost -d "$2" -X -v ON_ERROR_STOP=1 -tA \
    -f /dev/stdin < scripts/test/teaches-pr4-snapshot.sql | grep -E ' = ' > "$3"
}

echo "==> A: ${A_SERVICE:?}/${A_DB:?}"
run "$A_SERVICE" "$A_DB" "$out/a.txt"
echo "==> B: ${B_SERVICE:?}/${B_DB:?}"
run "$B_SERVICE" "$B_DB" "$out/b.txt"
echo "    $(wc -l < "$out/a.txt") lines in A, $(wc -l < "$out/b.txt") in B"

diff "$out/a.txt" "$out/b.txt" | grep -E '^[<>]' > "$out/diff.txt" || true
echo "==> $(grep -c '^<' "$out/diff.txt" || true) lines differ"

# The marked principals on CrisisReports, the function lines, and the log of the mark.
allowed='^[<>] larm-(rektor|full|schema|exp)\|marked\|(app_authenticated|authenticated)\|(CrisisReports|UserRoleChanges|FN:[a-z_]+)\|'
if grep -Ev "$allowed" "$out/diff.txt" > "$out/unexpected.txt"; then
  echo "==> UNEXPECTED differences (not a marked principal on CrisisReports, a function line or the log of the mark):"
  head -50 "$out/unexpected.txt"
  exit 1
fi
echo "==> every difference is a marked principal on CrisisReports, a function line or the log of the mark: $(wc -l < "$out/diff.txt") lines"
