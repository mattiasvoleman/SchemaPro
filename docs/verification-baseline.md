# Verification baseline — measured against the §2 metric table

This is the "benchmark dashboard" the engineering spec asks for in §7.5, filled
in with **measured** numbers rather than intentions. Every row is either a real
reading from the harness or explicitly marked as not yet measurable, with the
reason. No threshold is recorded as met without a number behind it.

Regenerate any row with the command in its **How to measure** column. When a
number changes, update it here in the same commit.

Measured: 2026-08-05, on the development machine (darwin/arm64). Absolute
wall-clock figures are machine-dependent; CI numbers are the ones that gate.

---

## Scorecard

Three of eleven gates pass today. The rest have a harness and a measured number
they are failing against — which is the point: before this work none of them
could be evaluated at all.

| Gate | Status |
| :--- | :--- |
| API dependency audit | ✓ pass (0/0/0) |
| Mobile dependency audit | ✓ pass (0/0/0) |
| WCAG 2.1 AA (axe-core) | ✓ pass (10/10, one real defect fixed) |
| Visual regression | ◐ harness verified, Linux baselines needed |
| API coverage | ✗ 37.62% vs 95% |
| Solver coverage | ✗ 78% vs 95% |
| Mutation score | ✗ 66.21% vs 85% |
| Bundle size | ✗ 492.5KB worst / 166.9KB floor vs 150KB |
| Solver, 2,000 students | ✗ payload rejected before solving |
| Web dependency audit | ✗ 1 critical / 3 high / 1 moderate |
| API P99 latency | — needs a seeded DB (CI only) |
| Lighthouse LCP/TTI | — not yet run |
| Web unit coverage | — no harness exists |
| INP | — not lab-measurable at all |

---

## Where the harness stands

| Gate | Harness | Wired into CI |
| :--- | :--- | :--- |
| Unit + integration coverage | `jest.config.js` (unit + e2e projects, combined coverage) | `ci.yml` → api |
| RLS / tenancy policies | `scripts/test/run-rls-tests.sh` | `ci.yml` → rls |
| Mutation score | `stryker.conf.json` | `quality-gates.yml` → mutation (nightly) |
| Visual regression | `web/e2e/visual.spec.ts` | `ci.yml` → web |
| Accessibility | `web/e2e/a11y.spec.ts` (axe-core) + `web/lighthouserc.json` | `ci.yml` → web, `quality-gates.yml` → lighthouse |
| Bundle size | `scripts/bench/bundle-size.mjs` | `ci.yml` → web |
| Frontend performance | `web/lighthouserc.json` | `quality-gates.yml` → lighthouse (nightly) |
| API P99 latency | `scripts/bench/api-latency.mjs` | `quality-gates.yml` → api-latency (nightly) |
| Solver wall clock | `optimization-engine/benchmarks/solve_2000_students.py` | `quality-gates.yml` → solver-benchmark (nightly) |
| Dependency audit | `npm audit` / `pip-audit` | `ci.yml` → security |
| SAST | Semgrep (`p/owasp-top-ten`, `p/nestjs`, `p/react`, …) | `ci.yml` → security |

---

## Code quality

| Metric | Target | Measured | Status | How to measure |
| :--- | :--- | :--- | :--- | :--- |
| API line coverage | ≥ 95% | **37.62%** (748/1988) | ✗ | `npm run test:cov` |
| API statement coverage | ≥ 95% | 38.57% (841/2180) | ✗ | same |
| API branch coverage | ≥ 95% | 31.38% (376/1198) | ✗ | same |
| API function coverage | ≥ 95% | 20.68% (90/435) | ✗ | same |
| Solver line coverage | ≥ 95% | **78%** (908 stmts, 168 missed) | ✗ | `npm run test:engine:cov` |
| Mutation score, tested files | ≥ 85% | **66.21%** (192 killed / 97 survived) | ✗ | `npm run test:mutation` |
| Web unit coverage | ≥ 95% | **no harness** | ✗ | — |

The API suite is 82 tests across 7 suites (5 unit, 2 e2e), all passing.

### Mutation score is measured only over files that have tests

Per file, mutating production sources only:

| File | Score | Survived |
| :--- | :--- | :--- |
| `common/utils/prisma-errors.ts` | 90.91% | 2 |
| `health/health.controller.ts` | 90.91% | 1 |
| `common/utils/request-context.ts` | 83.33% | 1 |
| `common/utils/time.ts` | 81.33% | 13 |
| `room-bookings/room-bookings.service.ts` | **54.55%** | 80 |

The aggregate above covers **only these five files**. A whole-project run would
score far lower, because ~85 source files have no tests for a mutant to fail.

`room-bookings.service.ts` is the interesting result: 43 tests give it high line
coverage but kill barely half its mutants. High coverage with weak assertions is
precisely what mutation testing exists to expose — the fix is stronger
assertions on the existing tests, not more of them.

Not every survivor is a test gap. In `time.ts`, mutating `get('second')` to
`get("")` survives because the timezone offset it feeds is whole minutes, so the
seconds term cannot change the result — an equivalent mutant. Triage survivors
before writing tests to chase them.

**Web has no unit-test runner at all** — no Vitest/Jest, no component tests. The
Playwright suites cover routing, accessibility and pixels, not component logic.
Closing the 95% row for `web/` means standing up a component-test harness first;
that is a separate piece of work, not a coverage push.

## Frontend performance

| Metric | Target | Measured | Status |
| :--- | :--- | :--- | :--- |
| Initial gzip JS, worst route | ≤ 150KB | **492.5KB** | ✗ |
| Initial gzip JS, best real route | ≤ 150KB | **216.3KB** | ✗ |
| Shared runtime alone | (within 150KB) | **166.9KB** | ✗ |
| LCP (Slow 4G) | ≤ 1.2s | not measured | — |
| TTI | ≤ 1.5s | not measured | — |
| INP | ≤ 100ms | **not lab-measurable** | — |

`npm run bench:bundle` — 30 routes measured, **every one over budget**.

The decisive number is the third row: at 166.9KB, the Next runtime plus
polyfills exceed the entire 150KB budget *before any application code loads*.
No route can pass this gate by trimming page-level imports alone — the shared
bundle itself has to change (or the budget has to be restated as, say, per-route
page JS excluding the framework runtime, which is a different metric than §2
specifies).

Two concrete leads from the per-chunk breakdown:

1. **jsPDF is eagerly bundled into the timetable page.** A single 146.5KB
   gzipped chunk (471KB raw) is `jsPDF` + `AutoTable`, and it is referenced by
   exactly one route — `/[locale]/(app)/admin/timetable` — which is why that
   route is 492.5KB against ~346KB for its siblings. A `await import("jspdf")`
   inside the export handler removes it from initial load entirely. This is also
   the library carrying the critical `dompurify` advisory, so the export path is
   worth revisiting on both counts.

2. **The `(app)` group carries ~130KB more than the `(auth)` group** (346KB vs
   290KB) and the auth pages themselves are 74KB above the shared floor. Worth
   checking what the app shell pulls in unconditionally.

Full per-route table: `npm run bench:bundle`. Largest chunks:
`node -e` gzip sweep over `web/.next/static/chunks` (see git history of this doc).

INP is a **field** metric: it requires real user interactions and cannot be
produced by a lab run. `lighthouserc.json` asserts Total Blocking Time at the
same 100ms threshold as the closest lab proxy. Actually gating the real INP ≤
100ms target needs RUM — `web-vitals` reporting to an analytics endpoint. That
does not exist yet, so this row cannot be honestly closed by CI alone.

LCP and TTI need a Lighthouse run against the built app; the build now succeeds
(on pinned next 16.2.9) so these are unblocked — `npm run bench:lighthouse`.

## Backend / solver

| Metric | Target | Measured | Status |
| :--- | :--- | :--- | :--- |
| Schedule generation, 2,000 students | < 10s | **rejected before solving** | ✗ |
| API P99, reads | ≤ 50ms | **71–86ms** on list endpoints | ✗ |
| API P99, updates | ≤ 150ms | **83ms** | ✓ |

### API latency, measured against the real stack

Run on docker-compose (Postgres + API + solver) with a seeded database,
25 connections, 20s per scenario. **Zero non-2xx in every scenario** — see the
warning below about why that number is the first thing to check.

| Scenario | p50 | p99 | Budget | |
| :--- | ---: | ---: | ---: | :--- |
| `GET /health/ready` | 5ms | 12ms | 50ms | ✓ |
| `GET /api/v1/schedule-versions` | 52ms | 71ms | 50ms | ✗ |
| `GET /api/v1/optimization/jobs` | 54ms | 86ms | 50ms | ✗ |
| `POST /api/v1/attendance/report` | 40ms | 83ms | 150ms | ✓ |

`/health/ready` is one `SELECT 1`, so ~12ms is the framework-plus-connection
floor on this hardware. The two list endpoints sit at roughly six times that,
which places their cost in their own queries and RLS policy evaluation rather
than in the stack. Writes pass with headroom.

Caveats worth carrying: these are Docker Desktop numbers on a laptop VM, so
treat them as relative rather than absolute — CI is the gating run. The write
figure is 24 serial samples, not a flood (see below), so its p99 is indicative.

**The gateway's read surface is small by design.** The web client queries
Supabase directly (`web/lib/queries.ts`); this API handles writes, AI proxying
and the SS12000 feed. Only three JWT-authenticated GET endpoints exist, and all
three are measured above. An earlier version of the benchmark invented paths
like `/api/v1/resources/rooms` that do not exist and would have timed 404s.

**Two endpoints cannot be flood-tested, for good reasons.** The global
throttler is 120 req/60s, and `POST /attendance/report` carries its own
`@Throttle({ limit: 10, ttl: 30_000 })`. Under load 99.9% of responses were
429, and the benchmark cheerfully reported PASS on the throttler's latency
until the non-2xx guard was tightened from "all failed" to ">1% failed". The
attendance route is now sampled serially at 3.2s intervals instead: 10 per 30s
is 0.33 req/s and autocannon's minimum rate is 1 req/s, so the allowance cannot
be expressed to it at all. Raise `THROTTLE_LIMIT` on the target before a run —
the throttler is not what this gate measures.

### The solver cannot accept a 2,000-student school

At realistic constraint density (one recurring weekly unavailability per
teacher) the engine refuses the payload before any solving happens:

```
2000 students / 80 classes / 960 requirements / 92 rooms / 166 constraints
  status            REJECTED
  model complexity  2,655,360 (budget 2,000,000)
```

`SchedulerSolver.MAX_MODEL_COMPLEXITY` is 2,000,000 and the estimate is
`lessons × rooms + lessons × constraints × days`. That second term multiplies
every lesson by every constraint, but a constraint only ever applies to the one
resource it names — so the estimate is pessimistic by a wide margin, and it is
the binding limit here, not the solver's actual capability. Either the budget or
the estimate needs revisiting before this row can be closed.

Measurements at reduced density, for the record:

| Shape | Complexity | Wall clock | Reported status |
| :--- | :--- | :--- | :--- |
| 2,000 students, 8 subj, density 0.3 | 647,040 | 13.6s | INFEASIBLE |
| 2,000 students, 12 subj, density 0.7 | 1,935,360 | 19.6s | INFEASIBLE |
| 1,000 students, 8 subj, density 0.5 | 240,960 | 11.4s | INFEASIBLE |
| 500 students, 8 subj, density 0.5 | 59,040 | 10.0s | INFEASIBLE |

Two things to read from this table. First, wall clock is dominated by **model
construction**, not search: every run was given a 9s CP-SAT limit yet took 10–20s
total. Second, every one of those INFEASIBLE verdicts is suspect — see below.

### `INFEASIBLE` does not mean infeasible

`SchedulerSolver._map_status` collapses every non-OPTIMAL, non-FEASIBLE CP-SAT
status into `"INFEASIBLE"`, including `UNKNOWN` (hit the time limit without
finding a solution) and `MODEL_INVALID`. A school whose timetable is merely
hard to find is told its requirements are impossible — and `solve()` then
attaches a conflict analysis derived from a search state where nothing was ever
proven.

Demonstration: on one payload, **removing** the lunch rule flipped the reported
status from FEASIBLE to INFEASIBLE. Removing a constraint cannot make a model
infeasible, so the status is reporting a timeout, not a proof.

This has to be fixed before any solver row here means anything, because the
benchmark's own pass/fail check trusts that status.

## Security & accessibility

| Metric | Target | Measured | Status |
| :--- | :--- | :--- | :--- |
| RLS / tenancy policies | no cross-tenant leak | **all assertions pass** | ✓ |
| API dependency audit | 0 critical/high/moderate | **0 / 0 / 0** | ✓ |
| Mobile dependency audit | 0 critical/high/moderate | **0 / 0 / 0** | ✓ |
| Web dependency audit | 0 critical/high/moderate | **1 / 3 / 1** | ✗ |
| Solver dependency audit (`pip-audit`) | 0 critical/high/moderate | not measured | — |
| Semgrep SAST | 0 findings | not measured | — |
| WCAG 2.1 AA (axe-core) | 0 violations | **0 violations, 10/10 pass** | ✓ |
| Lighthouse accessibility | 100 | not measured | — |
| Visual diff | ≤ 0.1% variance | darwin baselines only | — |

### One real AA violation found and fixed

The axe suite failed on first run with **58 nodes** failing `color-contrast` — all
of them in **dark mode only**; the light theme passed on all six routes. This is
exactly the single-theme regression the dark-mode case was written for.

Cause: `--primary` at `243 85% 68%` measures **4.37:1** against `--card`
(`#131316`), under the 4.5:1 AA floor for normal text. Every `text-primary`
link and label inherited it. Raised to `243 85% 70%` (**4.83:1**), hue and
saturation unchanged — the smallest change that clears the threshold, with the
measurement recorded in a comment beside the token so nobody lowers it blind.

A second failure was **my test being wrong**, not a defect: it asserted the
submit button was the next tab stop after the password field, but the
"forgot password?" link legitimately sits between the password label and its
input. Rewritten to assert reachability and relative order rather than
adjacency, plus a separate check that Enter submits the form. Both now pass.

Everything non-breaking was applied to the API and mobile packages, taking them
from 4 high / 6 moderate and 3 high respectively to **zero**: `postcss`,
`socket.io-parser`, `brace-expansion`, `fast-uri` and `qs`.

Web's five residual advisories split into two independent problems.

**The `jspdf` chain** — `jspdf` (critical) → `dompurify` (moderate) and
`jspdf-autotable` (high). Clearing them needs major upgrades (`jspdf` 2 → 4,
`jspdf-autotable` 3 → 5) that change the PDF export API. That is a code change
with its own verification, not an `npm audit fix`.

**`next` + `sharp` (both high) are a deliberate, documented trade.** `npm audit
fix` upgrades `next` 16.2.9 → 16.3.0, clearing nine advisories — including
GHSA-6gpp-xcg3-4w24, a middleware/proxy bypass specific to App Router apps using
Turbopack with a single locale, which describes this app exactly. But on 16.3.0
with next-intl 4.13.1 the production build **fails**:

```
✓ Compiled successfully in 86.9min
  Running TypeScript ...
  Finished TypeScript in 10.4min ...
  Collecting page data using 7 workers ...

> Build error occurred
TypeError: Cannot read properties of undefined (reading 'validationLevel')
```

Compilation and typechecking both pass; the failure is in page-data collection,
with no stack frame in application code — which is exactly why this is easy to
land without noticing.

Narrowed down by diffing the two installed trees: `validationLevel` appears in
`next/dist/server/config-schema.js` **only in 16.3.0** (zero occurrences in
16.2.9), so it became a recognised `next.config` option in that release. The
consumer is `next/dist/server/app-render/instant-validation/instant-config.js`
(present in both versions), which handles an `instantConfig` object. So 16.3.0
reads `<something>.validationLevel` during page-data collection and that object
is undefined for this project — most likely a config block next-intl's
`createNextIntlPlugin` wrapper drops, or one Next fails to default when absent.

`next` is therefore **pinned to the exact version `16.2.9`** in
`web/package.json` (not a caret range) so `npm install` cannot drift back into a
broken build. Reverting also reverts `sharp`, which is why two high advisories
reappear. Shipping a working build with two known advisories beat shipping no
build at all, but this is a temporary position, not a resolution — resolving it
means finding the next-intl/Next 16.3 incompatibility and unpinning.

Note on tooling: Stryker, autocannon and `@lhci/cli` are **not** committed
devDependencies. Each carries transitive advisories (`typed-rest-client` → `qs`,
`hyperid`/`uuid`, and `lighthouse` → `@sentry/node` → `cookie` respectively)
that would fail this gate on tools which ship nothing to users. They install
on demand — see the `test:mutation`, `bench:latency` and `lighthouse` scripts —
so `npm audit` can stay at zero tolerance instead of needing an exception list.

Note on tooling: Stryker, autocannon and `@lhci/cli` are **not** committed
devDependencies. Each carries transitive advisories (`typed-rest-client` → `qs`,
`hyperid`/`uuid`, and `lighthouse` → `@sentry/node` → `cookie` respectively)
that would fail this gate on tools which ship nothing to users. They install
on demand — see the `test:mutation`, `bench:latency` and `lighthouse` scripts —
so `npm audit` can stay at zero tolerance instead of needing an exception list.

The browser suites are written and enumerate cleanly (31 tests: 6 smoke, 9
a11y, 16 visual across desktop and mobile viewports) but have never executed,
because they need a production build.

Both axe-core and Lighthouse cover only *automatable* checks. Neither can
establish AA conformance on its own — keyboard traps, focus order and meaningful
alternative text still need a manual pass. A green run means "no automated
violations", and that is all CI should be read as claiming.

---

## Known blockers

1. **`next` is pinned to 16.2.9** because 16.3.0 breaks the build (see the
   security section). Do not run `npm audit fix` in `web/` without re-verifying
   `npm run build` — it will re-upgrade `next` and silently break the build,
   since compilation and typechecking both still pass.

2. **Builds are slow here.** `next build` took 87 minutes to compile plus 10
   minutes of typechecking on this machine, and cold ts-jest compiles take ~100s
   (warm: 1s). One earlier build attempt died with
   `TurbopackInternalError … Operation timed out (os error 60)` — a local
   filesystem timeout, not a source error. Budget accordingly or measure on CI.

3. **Visual baselines are not committed.** They must be generated on the same
   platform CI runs (Linux/Chromium) or every diff fails on font rendering
   alone. Generate them in a Linux container:
   `npm run test:visual:update`, then review the images in the PR.

4. **API latency needs a seeded database.** `api-latency.mjs` refuses to report
   when every request returns non-2xx, so it cannot be satisfied against the
   mocked Prisma layer. `quality-gates.yml` brings up `docker-compose.yml`,
   seeds, and mints a token with `scripts/bench/mint-token.mjs`; the seed script
   must create an active `SCHOOL_ADMIN` for that step to find a subject.

5. **The 95% coverage gates fail today.** `jest.config.js` defaults to the spec
   target, so CI is red until the suites are built out. Set the `COVERAGE_MIN`
   (API) and `ENGINE_COVERAGE_MIN` (solver) repository variables to ratchet
   deliberately — the default never silently weakens.

## Fixed while building this

- `npm run test:e2e` hung forever on any machine without the `watchman` binary
  (jest's haste-map probe never fell back). `watchman: false` is now set in both
  jest configs; discovery went from >180s to 0.9s.
- The e2e module graph was missing `NotificationsModule`, so every e2e suite
  failed to compile after `AttendanceService` gained that dependency. CI on this
  branch was red before any of this work.
- The shared Prisma tx mock vivified symbol lookups, which broke any
  `toHaveBeenCalledWith(tx, …)` assertion inside jest's equality check.
- The API had **no health endpoint**, so nothing could probe the container.
  `GET /health` (liveness, touches nothing) and `GET /health/ready` (readiness,
  checks Postgres) are now served, deliberately split so a database blip cannot
  trigger a cluster-wide restart storm.
- **Stryker could never complete a run.** Its sandbox copies the project into
  `.stryker-tmp`, and unrestricted that meant `optimization-engine/.venv`
  (138M) plus `web/` and `mobile/` `node_modules` (439M + 169M) — it sat at 0%
  CPU indefinitely. The `ignorePatterns` whitelist in `stryker.conf.json` cut a
  run from *never* to 24 seconds.
- A dark-mode WCAG AA contrast violation across 58 nodes (see above).

## Tenancy: the service principal

`withSystemTransaction` was believed to bypass RLS. It cannot — the API
connects as a non-owner and every table has `relrowsecurity`, so with no claims
set queries return **zero rows without erroring**. Three call sites were
affected in three different ways:

- `JwtStrategy` and `RealtimeGateway` — fixed with `withVerifiedSubject`,
  scoping the lookup to the already-verified JWT subject.
- `IntegrationKeyGuard` and the six SS12000 methods — could not be, because
  they authenticate with an `X-API-Key` and have no `auth.uid()` to scope by.
  Every SS12000 endpoint silently returned an empty payload, which an
  integrating system reads as "this school has no data".

Resolved with **service-principal policies** rather than a `BYPASSRLS` role.
The integration key resolves to exactly one school, so the principal is not
cross-tenant — it is "the service acting for school X" — and the policies
enforce in the database what the service layer already intended. A query that
forgets its own `where: { schoolId }` now returns nothing instead of leaking.

Two transaction-local settings drive it, so neither can outlive a transaction
or leak onto a pooled connection:

| Setting | Set by | Grants |
| :--- | :--- | :--- |
| `app.service_key_lookup` | `withServiceKeyLookup` | SELECT/UPDATE on non-revoked `IntegrationApiKeys`, nothing else |
| `app.service_school_id` | `withServicePrincipal` | One school's rows across the seven tables SS12000 touches |

Verified against a real database, as the role the API actually uses:

| Principal | API keys | Users | Schools |
| :--- | ---: | ---: | ---: |
| none (the old broken state) | 0 | 0 | 0 |
| key-lookup only | 1 | 0 | 0 |
| service principal, school A | 0 | 89 (0 from school B) | 1 |

The user count was taken **without a `WHERE` clause**, which is the point: the
policy alone confines it. `scripts/test/run-rls-tests.sh` encodes all of this,
including that the settings do not survive `COMMIT`, and runs per-PR in
`ci.yml`.

## Verification that the gates are not vacuous

A gate that cannot fail is worse than no gate, so each was checked against a
known-bad input rather than assumed working:

- **Visual**: changed `--primary` hue from 243 to 300 and re-ran. The dark-mode
  baseline failed with a diff image; the seven light-mode baselines correctly
  passed, since only the dark token moved. Reverted, 16/16 green again.
- **Accessibility**: the suite failed on first run and caught a real defect
  (58 contrast violations) plus a bug in one of its own assertions.
- **Bundle size**: fails today on all 30 routes, with per-route numbers.
- **Coverage / mutation**: both currently report below threshold and exit
  non-zero.
- **RLS policies**: dropping `users_service_select` fails with "saw 0 users for
  its own school"; adding a policy that lets the key-lookup principal read
  `Users` fails with "leaked 90 user rows". Checked in both directions —
  too strict and too permissive — then restored.
- **Solver benchmark**: exits non-zero on the §2 target shape.

Baselines are committed with a `-darwin` suffix (Playwright's default), so they
do **not** collide with the `-linux` baselines CI needs. CI is configured with
`updateSnapshots: "none"`, so it will fail rather than silently write its own —
generate the Linux set deliberately in a container.
