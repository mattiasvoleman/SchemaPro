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

Six of eleven gates pass today. The rest have a harness and a measured number
they are failing against — which is the point: before this work none of them
could be evaluated at all.

| Gate | Status |
| :--- | :--- |
| API dependency audit | ✓ pass (0/0/0) |
| Mobile dependency audit | ✓ pass (12 advisories allowlisted: zod, with no patch in the range the Expo CLI declares, and 11 whose fix is a new major (glob, minimatch) or younger than the seven-day rule (nine node-forge, which a plain lockfile bump takes once 1.4.1 is admitted on 2026-11-03); leases expire 2026-11-05, zod's and GHSA-86w9-cpqp-85rv's 2026-11-20; braces and sprintf-js are no longer reported and image-size left with Expo SDK 57, measured 2026-11-01) |
| WCAG 2.1 AA (axe-core) | ✓ pass (10/10, one real defect fixed) |
| Visual regression | ✓ pass (16/16 on linux-x64 baselines) |
| API coverage | ✗ 95.09% vs 95% (ratcheted at 95; remainder is module wiring) |
| Mobile coverage | ✗ 12.83% vs 95% (first floor at 12; runner stood up 2026-08-22) |
| Solver coverage | ✗ 89.50% vs 95% (ratcheted at 81) |
| Mutation score | ✗ 71.31% of the API vs 85% (2026-11-02: 48,433 of 67,921 valid mutants detected, 5,610 of them uncovered ones that count as survived, in 279 files); gated one slice a night against the slice's own floor (59–88%), so that it fails when a slice gets worse |
| Bundle size | ✓ pass (tiered; 30/30 routes, shared 126.1/130KB) |
| Solver, 2,000 students | ✗ 1,300 validated (~9.5 min); 2,000 now measured honestly: TIMEOUT at 570s |
| Web dependency audit | ✓ pass (0/0/0) |
| API P99 latency | ✗ §2 not met on the CI runner: reads p99 46–181ms vs 50ms (their p50 35–61ms, 56–61ms on the slowest CPU model), write p99 17–167ms vs 150ms over 300 samples; gated relative to the run's authenticated-read floor instead, where sixteen healthy runs on three CPU models pass (read shares 0.871–0.962 vs ≥ 0.80) and a handler with four extra statements (about 22% more expensive, as its share has it) fails 4 of 4 |
| Lighthouse LCP/TTI | — not yet run |
| Web unit coverage | ✗ 88.98% vs 95% (ratcheted at 87; harness landed) |
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
| API latency | `scripts/bench/api-latency.mjs` (measures), `scripts/bench/latency-gate.mjs` (verdict) | `quality-gates.yml` → api-latency (nightly); the verdict's tests in `ci.yml` → api |
| Solver wall clock | `optimization-engine/benchmarks/solve_2000_students.py` | `quality-gates.yml` → solver-benchmark (nightly) |
| Solver model diagnosis | `optimization-engine/benchmarks/profile_model.py` (build breakdown, ablation, rules×objective matrix) | not gated — diagnostic, lifts the complexity guard |
| Schedule correctness | `optimization-engine/benchmarks/validate_schedule.py` — re-derives every rule from the request and checks the response, sharing no code with the model builders | `quality-gates.yml` → solver-benchmark (nightly, 400 students) |
| Dependency audit | `npm audit` / `pip-audit` | `ci.yml` → security |
| SAST | Semgrep (`p/owasp-top-ten`, `p/nestjs`, `p/react`, …) | `ci.yml` → security |

---

## Code quality

| Metric | Target | Measured | Status | How to measure |
| :--- | :--- | :--- | :--- | :--- |
| API line coverage | ≥ 95% | **95.10%** (2485/2613) | ✓ | `npm run test:cov` |
| API statement coverage | ≥ 95% | 95.09% (2717/2857) | ✓ | same |
| API branch coverage | ≥ 95% | 84.98% (1313/1545) | ✗ | same |
| API function coverage | ≥ 95% | 90.59% (520/574) | ✗ | same |
| Solver line coverage | ≥ 95% | **89.50%** (1333 stmts, 125 missed) | ✗ | `npm run test:engine:cov` |
| Mutation score, the API | ≥ 85% | **71.31%** (48,433 / 67,921; slices 60.31–89.26%) | ✗ | `npm run test:mutation`, one slice a night |
| Mobile unit coverage | ≥ 95% | **12.83%** statements (services, utils, hooks) | ✗ | `npm run test:mobile:cov` |
| Web unit coverage | ≥ 95% | **88.98%** lines (1397/1570) | ✗ | `npm run test:unit:cov` in `web/` |

The API suite is 868 tests across 47 suites, all passing. The solver suite is
73 tests; the web unit suite 685 across 51 files.

The line and statement rows were closed by taking the first of the two options
this section used to describe: the e2e harness (`test/utils/test-app.ts`) now
boots **every** feature module rather than five, so `*.module.ts` DI wiring is
exercised as a graph instead of being excluded from collection. That moved
lines 91.77% → 95.16% and functions 83.86% → 90.99% without a single test
written against wiring itself.

What the harness buys is not the number. Six specs (`import`, `planning`,
`scheduling`, `portal`, `resources`, `attendance`) now drive routes over HTTP
through the real routing table, ValidationPipe, RBAC guard and RFC-7807 filter,
which is where the failures a unit spec cannot see live: a route that does not
resolve at all, a DTO that rejects the payload the browser actually sends, a
missing `@Roles`. `route-guards.e2e-spec.ts` asserts over the whole routing
table at once — every route is either `@Roles`-gated or explicitly `@Public`,
and the public surface is exactly the health probes and SS12000 — so a
controller added later is covered the moment it is registered.

Branches remain below target; they are dominated by defensive null-handling in
the solver proxy and calendar services.

The test-writing pass also pinned **11 suspected production bugs** — each has a
test documenting current behaviour with a "suspected bug" comment (unhandled
promise rejections on disconnect and in job startup, an update-path bypass of
the students-only group rule, notification fan-out computed from a stale
snapshot, mixed-format time-range validation, and more). They are deliberately
NOT fixed in the coverage commit; fixing them flips each pinning test.

### The gate is ratcheted, not met

§2's 95% remains the target. `jest.base.js` carries per-metric floors just
under what the suite achieves today, so CI blocks regression instead of failing
permanently on a known gap — an always-red pipeline trains people to ignore it,
which is how a real failure hides among the expected ones.

Thresholds are per-metric because one number cannot fit: 92% of lines are
covered but only 84% of functions. A single shared value would either let line
coverage regress 8 points unnoticed, or fail the build on functions no matter
what. Raise them via the `COVERAGE_MIN*` repository variables as coverage
grows; never lower one to green a build.

### The mutation gate: a slice of the API a night, against the slice's own floor

**What it requires, since 2026-11-03.** `quality-gates.yml` → mutation mutates one of twenty slices of the API each night and fails when that slice scores under *its floor*: its measured score minus one percentage point, rounded down, checked in beside the files of the slice in `scripts/mutation-slices.json`. The slice is the day of the year (UTC) modulo 20, so the whole API is covered every twenty nights within a year (across a new year slices 1 to 5 run twice in a row and the longest wait for a slice is 25 or 26 nights). A `workflow_dispatch` takes one slice, a list (`3,7`) or `all` (`mutation_slice`), ten jobs at a time. §2's 85% stays the target; the report prints it beside the floor, and it is **not met**: measured on 2026-11-02, 48,433 of the 67,921 valid mutants are detected, **71.31%** (5,610 of the 67,921 are mutants no test reaches, which count as survived, as they always did; scored on covered code alone it would be 77.73%), and of the twenty slices two are at 85 (slice 1 at 89.26%, slice 11 at 86.39%). The floors run from 59% to 88%. The gate is a ratchet: it fails when a slice gets worse, never because the target is missed, and the target moves into reach by raising the floors as tests are written.

**Why a slice.** On 2026-10-06, the last green night, the job mutated 57 files and 7,522 mutants (1,774 tests) in 41:50 and scored 94.07%. On 2026-11-02 it was 280 files, 73,861 mutants and 7,749 tests, with `mutate` unchanged since 2026-09-13: the API had grown about tenfold in four weeks. The runner gets through about 50 mutants a minute now against about 180 then, so the whole set is half a day of it, and the 90 minutes of a job reach one part in seven. What was tried, all on the 4-vCPU runners:

| Run | What | Result |
| :--- | :--- | :--- |
| 37440931235, 2026-10-06 | the whole API in one job: 57 files, 7,522 mutants | 94.07%, 41:50 |
| 41422825454, 2026-11-02 | the nightly, red since 2026-10-07 | died in the dry run: six specs read files outside the sandbox's whitelist (fixed in the whitelist, not by leaving the specs out) |
| 41440346900 | the whole API in one job: 73,861 mutants | cancelled at 90 minutes after 10,097 mutants |
| 41454768502 | 20 slices dealt by mutant count | 22 to over 95 minutes for slices of the same size; two cancelled, one ended by a runner shutdown; scores 55–81% |
| 41470197321 | 10 slices by mutant count, `ignoreStatic` | four cancelled at 90 minutes, one more took 89 |
| 41519740264 | 40 slices by mutant count, with the timing reporter | all finished but one, 6–63 minutes; 830 minutes of mutation testing in all, on 266 files |

Mutant count says nothing about time. Among the thirty dearest files the time runs from 0.3 to 8.5 seconds a mutant that has to be run; 19 files are half of all the time and 50 are three quarters; the dearest, `optimization-proxy.service.ts`, is 62 minutes on its own, `common/utils/prisma-errors.ts` 44 and `staffing/teacher-load.ts` 43. Stryker's own estimate does not help: it planned 4 seconds of test time for a file that took 162. So the slices are dealt by *measured* seconds, from the 40-slice run (the nine files of slice 14 from another run: that slice ended four times in a runner shutdown, see below), by the longest-first rule, and the dealing is checked in. One file, `optimization-proxy.service.ts`, is dealt in two line ranges (`:1-2092` and `:2093-99999`) because Stryker runs the mutants that lie wholly inside a range and the cut falls on a line no mutant crosses; the last range runs to the end of any file, so lines added later are mutated too. The twenty slices are 42–44 minutes each, with about a minute of setup, against the 60 that a slice may take.

**What the score leaves out.** Three things, and they are in every floor:

- **Generated code**: `src/**/*.generated.ts` is not mutated. It is one file today, `integration/ss12000-v2/s1-provider.generated.ts`, S1's schemas and parameters as a data module, 3,225 of the 73,861 mutants; a mutant there changes what the generator wrote, not anything a test of the gateway answers for.
- **Static mutants** (`ignoreStatic`): mutants in code that runs when a module loads (a top-level constant, a lookup table) cannot be pointed at one test, so Stryker would run the whole suite for each. In the 20-slice run Stryker warned, for 18 of the 20 slices, that they were 1–12% of the slice's mutants and, by its own estimate, 42–94% of its test time; they are not run, and count neither as detected nor as undetected. The estimate is Stryker's and the saving was not isolated (the runs that differ in it differ in their slices too); what is given up is the constants and tables no test is pointed at. 2,419 of the 70,636 mutants (3.4%) are ignored this way. It does not flatter the score: on the seven slices of the 20-slice run that finished before the option, the static mutants that were valid were detected at 76.9% against 66.6% for the rest, so leaving them out lowers a slice's score by 0.1–0.6 points.
- **What counts**: as Stryker counts it, detected = killed or timed out, undetected = survived or not covered by any test (such a mutant takes no time to decide), and mutants that are ignored or do not compile count in neither.

**The slices as measured** (the seconds are wall time of the mutation phase; the figures are from 2026-11-02, with a mutant's time limit of 60 seconds, and a night is somewhat shorter now that it is 10):

| Slice | Files | Mutants | Measured | Floor | Minutes | Dearest files |
| ---: | ---: | ---: | ---: | ---: | ---: | :--- |
| 0 | 1 | 820 | 79.95 % | 78 % | 44 | common/utils/prisma-errors.ts (44 min) |
| 1 | 1 | 692 | 89.26 % | 88 % | 43 | staffing/teacher-load.ts (43 min) |
| 2 | 9 | 2211 | 79.78 % | 78 % | 42 | optimization/optimization-proxy.service.ts:2093– (39 min), optimization/room-loan-windows.ts (1 min), publication/other-school-clashes.ts (1 min) |
| 3 | 14 | 2661 | 65.63 % | 64 % | 42 | cover/cover-rules.ts (29 min), notifications/notifications.service.ts (4 min), optimization/other-school-holds.ts (2 min) |
| 4 | 13 | 5472 | 60.31 % | 59 % | 42 | calendar/master-lessons.service.ts (28 min), cover/cover.service.ts (4 min), optimization/pupil-cohorts.ts (3 min) |
| 5 | 13 | 4039 | 80.16 % | 79 % | 42 | common/timplan-planned.ts (27 min), optimization/candidate-basis.ts (5 min), publication/publish-mode.ts (2 min) |
| 6 | 15 | 5110 | 73.59 % | 72 % | 42 | optimization/optimization-proxy.service.ts:1–2092 (23 min), integration/ss12000-sync/diff.ts (5 min), access-log/access-log.ts (4 min) |
| 7 | 15 | 3879 | 62.27 % | 61 % | 42 | cover/cover-context.ts (22 min), integration/ss12000-sync/outbound.ts (6 min), integration/ss12000-v2/slice.ts (4 min) |
| 8 | 14 | 4086 | 75.61 % | 74 % | 42 | staffing/teaching-weeks.ts (21 min), optimization/schedule-candidates.service.ts (7 min), year-rollover/rollover-source.ts (4 min) |
| 9 | 16 | 2377 | 81.05 % | 80 % | 42 | year-rollover/activation-plan.ts (17 min), staffing/employment-periods.ts (7 min), notifications/expo-push.client.ts (5 min) |
| 10 | 16 | 4000 | 66.44 % | 65 % | 42 | common/timplan-delivered.ts (15 min), calendar/lesson-roster.ts (7 min), staffing/staffing-enforcement.ts (5 min) |
| 11 | 16 | 2546 | 86.39 % | 85 % | 42 | common/teacher-day.ts (15 min), common/stretch.ts (7 min), timplan/generate-requirements.ts (5 min) |
| 12 | 25 | 5998 | 61.21 % | 60 % | 42 | optimization/staffing-proposal.service.ts (14 min), common/grade-numbering.ts (8 min), database/pool-config.ts (6 min) |
| 13 | 16 | 2507 | 76.27 % | 75 % | 42 | common/replacing-groups.ts (14 min), calendar/publish-days.ts (8 min), notifications/push-messages.ts (6 min) |
| 14 | 16 | 3570 | 76.40 % | 75 % | 42 | year-rollover/projected-rosters.ts (14 min), supervision/supervision-load.ts (8 min), common/subject-distribution.ts (6 min) |
| 15 | 16 | 3886 | 76.56 % | 75 % | 42 | staffing/staffing-checks.ts (13 min), year-rollover/rollover-plan.ts (8 min), notifications/notification-delivery.service.ts (6 min) |
| 16 | 16 | 5202 | 67.06 % | 66 % | 42 | common/timplan-scheduled.ts (12 min), common/lesson-lengths.ts (9 min), common/year-rollover.ts (7 min) |
| 17 | 16 | 4776 | 71.64 % | 70 % | 42 | integration/ss12000-v2/ss12000-v2.service.ts (12 min), staffing/load-input.ts (9 min), integration/ss12000-v2/model.ts (6 min) |
| 18 | 16 | 2455 | 71.57 % | 70 % | 42 | common/utils/time.ts (11 min), calendar/lesson-recurrence.ts (10 min), optimization/room-eligibility.ts (7 min) |
| 19 | 16 | 4349 | 71.10 % | 70 % | 42 | import/import.service.ts (10 min), common/timplan-coverage.ts (10 min), timplan/timplan-coverage.service.ts (7 min) |

**Raising a floor.** When the tests of a slice's files improve, run that slice (`mutation_slice=N`), download the artifact `mutation-report-slice-N`, unpack it, and run `node scripts/mutation-slice.mjs --remeasure <unpacked>/slice-N`. It replaces the slice's figures in `scripts/mutation-slices.json` with the run's and sets the floor to floor(score − 1), and it changes nothing else; commit that on its own, saying which tests earned it. A floor is not raised by editing the number: the sums beside it are held against it by a unit test.

**Lowering a floor.** `--remeasure` refuses a floor lower than the slice has. `--lower` says it is meant, and the commit that does it says why (a file removed, a rule deliberately dropped); a slice that fell under its floor because tests were lost is a failure to fix, not a floor to move.

**A slice whose files change.** A slice that is dealt other files gets a new floor only after it has been measured: `--remeasure` refuses a run of other files than the slice's, and `--deal --of N --split file=parts@mutation.json <file-times.json of every slice of a run>` makes a new dealing, with new floors, from a run of all of them. Re-deal when a few files have grown enough to cost more than a slice may, or when the floors have drifted so far up that nobody trusts the old balance.

**A new file, a file that is gone.** A file in `mutate` that the dealing does not know goes to the slice with the least seconds so far (files placed in name order, mutants times the dealing's median seconds a mutant, a tie to the lower slice); the report says which file went to which slice and that the floor was measured without it. A new file the tests do not reach is therefore what takes its slice under the floor: add tests, or measure the slice again. A file in the dealing that no longer exists is skipped and named.

**A cut a mutant crosses.** `optimization-proxy.service.ts` is dealt in two line ranges, and a mutant that starts above the cut and ends below it is wholly inside neither: no slice would run it, and nothing in a score would show that it was lost. The cut is made at a line no mutant crosses, but the lines move when the file is edited, and this file is edited nearly every day (59 commits since 1 September, 20 since 24 October, and 31 of 202 unmerged branches touch it). In the file as it is, 72 % of the lines are inside some mutant, because a long method is one block mutant from its first line to its last. So the line in `scripts/mutation-slices.json` is only a **hint**, and nobody renames it by hand. A slice that holds a part of such a file asks Stryker's instrumenter for the file's mutants, whole and part by part, and runs the parts as they are tonight: a cut that no mutant crosses stays where the dealing has it, and one that a mutant crosses is moved to the nearest line none does, the lower of two equally near, between the two parts it divides. The log, `slice.json` and the summary say which cut moved, to where, and how many mutants changed part; `Stryker` is given `src/…:1-55` and `src/…:56-99999` for `:1-2092` and `:2093-99999`, and the dealing is as it was. `node scripts/mutation-slice.mjs --check-ranges` does the same for every such file and prints where each cut is, for use after editing one.

*When it is red.* Only where the parts cannot be run, and only for a slice that holds a part of the file (a slice with none of it does not ask, and is never made red by it): (1) no line between the two parts is free of the mutants that cross it; (2) the move hands more mutants to the other part than a part may lose, a tenth of the smaller part's dealt mutants, which is what the 90 % guard below lets a slice lose before it calls it short (84 for the 848 of the smaller part of this file): a larger move means the dealing is out of date and `--deal` is the answer; (3) the keys leave a gap, overlap or stop short, so that a mutant is in no part or in two. Every mutant is followed to the ranges that hold it, with Stryker's own count of what each runs, so that one lost and one run twice do not make the totals agree. *Why a tenth.* A part's score moves by about the handed mutants' share of the part times the scores' difference; the two parts of this file are 833 and 1,415 valid mutants at 77.3 and 84.3 %, so a move of 84 changes the smaller by about 0.7 points, within the point under each measured score that is there for moved lines. *What the file's history says.* In the 30 steps between the 31 versions of the file since 18 October (2,416 to 4,679 lines), each taken as one edit to a freshly made dealing, the cut had to move in 15 and the move handed over 0 to 37 mutants, except the 274 of the one edit of +937 lines, which is red; with the dealing made once at the first of them and never again, the parts drift apart, and the 9 versions in which the move would hand over more than 84 are the same 9 in which the smaller part has already lost more than a tenth. What it costs is the same as before: a drift of the file relative to the hint is the dealing getting old, and `--deal` makes it new. A check that needs no hand-renamed key and no conflict between branches is what the moving cut buys; the Stryker the check needs is the one `npm run test:mutation` installs at pinned versions, which is where it runs.

**What a red night is.** The job says which: *under its floor* (the summary names the weakest files; the tests got worse, or a new file in the slice is not covered); *the runner has received a shutdown signal* (not a score: run it again; it ended 3 of the 70 jobs of the three slice runs, at random, and slice 14 four times at one mutant, below); *no report* (Stryker did not finish; the log has its progress). The script itself turns more nights red, each with exit 1 and a `Slice N: …` line in the log and the summary, because Stryker lets them through with 0 or with a figure that means nothing: *the report holds no valid mutant* (every mutant Ignored or errored, a score of n/a; the log says why nothing ran, usually a `mutate` pattern or a line range that matches nothing); *has no file to mutate* (every file of the slice's dealing is gone: make a new dealing with `--deal`); and *only X of the slice's Y mutants were in the report* (fewer than 90 % of the mutants the dealing gave the slice, with any new files placed in it). The last is not a failed run: Stryker finished and the score is true, but code has been removed from a file in the slice, so the floor was measured over more mutants than are left, and a run over fewer is not comparable with it. It stays red every time the slice comes round until the slice is counted again: download the red run's artifact `mutation-report-slice-N` (it is uploaded on a red night too) and run `node scripts/mutation-slice.mjs --remeasure <unpacked>/slice-N` on it, which sets the slice's mutant count and a floor from that run, and commit the result with the change that removed the code. `--remeasure` refuses a floor lower than the slice has, so if the removed code was what held the score up, `--lower` says that is meant, as under *Lowering a floor*. A shrink of less than 10 % does not turn the night red; the slice is counted again the next time its floor is raised. Three more nights are red for reasons the script keeps to itself: *the score is under the slice's floor, whatever Stryker's own exit code says* (the script compares the report's score with the floor too and does not leave the comparison to Stryker's `thresholds.break`, so a Stryker that reads the threshold otherwise, or dies after it wrote the report, cannot let a slice under its floor through); *Stryker was stopped by a signal after it wrote its report* (the run is not taken as finished, whatever the report says); and *the line ranges of a file it holds cannot be run as dealt* (above).

**A mutant that kills the runner.** Slice 14 of the 40-slice run ended four times with "The runner has received a shutdown signal", at the same point (mutant 916 of 1,687), whatever was done to Stryker's processes: a lower priority (`nice`) and a 3 GB cap on Node's heap changed nothing. Bisecting by line range on CI (`mutate: file:from-to`, a throwaway workflow) narrowed it to the 14 mutants wholly inside lines 201–215 of `src/notifications/notification-delivery.service.ts`, and there the job died with a 60-second time limit for a mutant, with one worker, with a 1 GB heap and with two workers, and went through in about a minute with a limit of 8 and of 3 seconds (run 41554633962). `timeoutMS` is therefore 10 seconds.

The mechanism was found afterwards, by running the mutants against that file's own digest test on a laptop. `if (notice.userId !== target.user_id) continue;` is on line 213, and turned into `if (false) continue;` (or `===`) it makes `push()` build a message for every pair of recipient and notice: 1,203 × 1,203, about 1.45 million messages with their formatted text, in the test of a whole-school digest. That was 3,352 MiB after 5 seconds and 7,089 MiB after 10, outside V8's heap limit, which is why the heap caps did nothing; no network is reached, the transport is mocked. With four workers and two such mutants side by side, a 16 GB runner does not hold them. So `timeoutMS` is a memory guard more than a time limit: it has to end the process before the memory is gone, and a faster CPU allocates more in the same ten seconds. A Timeout counts as detected, so the shorter limit can raise a score and not lower it; of the 70,636 mutants 155 timed out at 60 seconds. Only slices 0, 2, 11 and 15 and the nine files of slice 14 have run at 10 seconds (slice 11, run 41567860495: 86.39 %, floor 85, reproducing the measured score), and the first night of each other slice will be the check of its floor.

**The square is out of the code (2026-11-03).** It was real, though cheap in the size of a school: `push()` compared every device row of a group with every notice of the group, targets × notices comparisons before it built a message, and kept a group by copying its array once for each notice. Timed on the same digest with two devices a person, the old and the new `push()`: 1,800 people 322 ms against 278, 5,000 1.5 s against 0.9 s, 10,000 3.8 s against 1.8 s, 20,000 13.8 s against 3.4 s (a loaded laptop: the trend, not the figures). Now a group's notices are indexed by person once and a device is given its owner's, and the group is built by pushing. The behaviour is the same: the old and the new service gave identical messages, identical questions to the database and identical settled tickets on 400 random batches (14,576 messages: several devices a person, rows nobody asked for, a person with a digest and its reversal in one group, both languages, tickets in error), and the same spec passes against both. The mutant on the old line 213 does not exist any more. What remains of lines 201–215 was run on the new code, by Stryker with one worker: the 34 mutants wholly inside lines 186–232 take 130 s and the process group never passes 1,556 MiB with a limit of 10 seconds (the old mutant was past 1,400 MiB after four seconds and still growing), and with a limit of 60 seconds the same 34 give the same statuses (30 killed, 1 timed out, 2 survived, 1 not covered) in 141 s at 1,427 MiB at most. The one Timeout is a mutant that loops, `at -= RECIPIENT_CHUNK`, which is no danger to the runner. The whole file: 216 mutants, 89.35 % (the dealing has 214 and 89.25 %), 413 s with four workers, the group at 3,240 MiB at most, which is four workers' own weight.

*Can `timeoutMS` go back to 60 seconds?* For this file's sake, yes: nothing in it needs the guard any more. It is left at 10 seconds. A raise makes every night longer (155 timeouts at 60 seconds are about 130 minutes of worker time over the API, a minute or two of a slice's wall time with four workers) and gains no score, since a Timeout is detected either way; the floors were measured at 60 and reproduced at 10 in four slices, with 0 of 6,917 mutants changing status; and a mutant that loops allocates until the limit ends it, so a limit is wanted whatever its value. Raise it only with a reason, and then measure the slices again.

**Final runs.** Slices 0, 2 and 15 of this dealing went through the real nightly workflow on the pull request's branch (`mutation_slice=0,2,15`, run 41557289392). All three passed against their floors and reproduced the measured scores to the hundredth:

| Slice | Held | Score | Floor | Mutation phase | Whole job |
| ---: | :--- | ---: | ---: | ---: | ---: |
| 0 | `prisma-errors.ts` alone, the dearest slice | 79.95% | 78% | 34:31 | 35.1 min |
| 2 | the second range of `optimization-proxy.service.ts` (`:2093-99999`) and eight files | 79.78% | 78% | 40:18 | 40.8 min |
| 15 | `notification-delivery.service.ts`, the file that killed the runner, and fifteen files | 76.56% | 75% | 34:34 | 35.2 min |

Each took less than the 42–44 minutes the dealing says; the dealing was measured with a limit of 60 seconds for a mutant, now 10, and on whatever CPU those runners drew, and which of the two accounts for the difference is not established. Slice 2 shows that a line-range part runs in the real flow, slice 15 that the runner survives the mutants that killed it. The same run's latency job passed (floor 449 req/s on an EPYC 7763, reads at 0.904 and 0.914 of it).

**The weakest files, for the tests that raise the floors.** Of the 67,921 valid mutants, 19,488 are undetected (13,878 survived and 5,610 reached by no test). A run's `summary.md` ranks the slice's files, weakest first; in the three final slices the weakest are `common/utils/prisma-errors.ts` (131 survived) in slice 0; `lesson-log/class-book.service.ts` (55.00%, 94 survived), `gallring/gallring.service.ts` (70.11%, 44) and `users/my-schools.service.ts` in slice 2; `cover/cover-reports.service.ts` (53.67%, 78), `cover/cover-decisions.ts` and `users/per-login-throttler.guard.ts` in slice 15.

### Mutation score is measured only over files that have tests

**History: this section describes 2026-08, when five files had tests; the next section is the gate as it stands.** Per file, mutating production sources only:

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

**Web now has a Vitest + Testing Library harness** (`web/vitest.config.ts`):
367 tests across 34 files, 87.07% lines / 85.33% statements / 83.28% functions /
79.87% branches over `lib/`, `components/`, `utils/` and `i18n/`. App-router
routes (`app/**`) are excluded from unit coverage deliberately — they are server
components exercised end-to-end by the Playwright suites, and counting them here
would dilute the number with lines no unit test can honestly execute. Floors are
ratcheted in `vitest.config.ts` (87/85/83/79), raised via the
`WEB_COVERAGE_MIN*` repository variables. The remaining gap to 95% is mostly
`lib/queries.ts` pass-through hooks that are mechanically identical to covered
representatives, plus `lib/auth.ts` and the Supabase middleware (server-side
modules, now testable via the `server-only` alias stub). This pass also pinned
**5 suspected front-end bugs** — unfolded ICS content lines, a missing .catch on
keyboard undo/redo, a confirm dialog dismissible mid-mutation via Escape, a
lane-field leak in timetable click callbacks, and double-counted GROUP conflict
hits.

## Frontend performance

| Metric | Target | Measured | Status |
| :--- | :--- | :--- | :--- |
| Route-own JS, admin tier | ≤ 190KB | **177.8KB** | ✓ |
| Route-own JS, core tier | ≤ 170KB | **164.4KB** | ✓ |
| Route-own JS, auth tier | ≤ 110KB | **96.6KB** | ✓ |
| Route-own JS, system tier | ≤ 50KB | **22.1KB** | ✓ |
| Shared framework runtime | ≤ 130KB | **126.1KB** | ✓ |
| §2 flat total-payload budget | ≤ 150KB | 303.9KB worst | ✗ (see below) |
| LCP (Slow 4G) | ≤ 1.2s | not measured | — |
| TTI | ≤ 1.5s | not measured | — |
| INP | ≤ 100ms | **not lab-measurable** | — |

`npm run bench:bundle` — **all 30 routes pass their tier budgets.**
`npm run bench:bundle:flat` still reports the §2 figure verbatim (28 of 30 over
a flat 150KB), so the original metric has not been hidden.

### Why the budget is tiered rather than flat

A flat total-payload budget cannot be met by any route, and not for a reason
anyone can fix. The framework floor is 126.1KB — react-dom + react 69.8,
the Next App Router client 44.5, Turbopack runtime and misc 11.9. Grepping
those chunks for every dependency in `package.json` returns no matches, and a
hello-world on this Next/React pair measures the same. Under a 150KB total
budget a page could contain 24KB of its own code and still fail, which makes
the gate unactionable and teaches everyone to ignore CI.

Budgets therefore apply to each route's **own** JavaScript, with the shared
runtime gated separately at 130KB. The split makes both numbers actionable:
route budgets catch a page importing something heavy, and the shared budget
catches application code leaking into the root layout — which is exactly how
react-query and sonner ended up on the login page.

The tier numbers are ratchets set just above today's measurements, the same
approach used for the coverage gates. Tighten them as routes shrink.

The decisive number is the third row: at 126.1KB the Next runtime consumes 84%
of the 150KB budget *before any application code loads*.
No route can pass this gate by trimming page-level imports alone — the shared
bundle itself has to change (or the budget has to be restated as, say, per-route
page JS excluding the framework runtime, which is a different metric than §2
specifies).

**Correction — the earlier 164.7KB figure was wrong.** It counted
`polyfillFiles`, which Next's App Router emits with `noModule: true`
(`next/dist/server/app-render/app-render.js`). Every browser this app targets
supports ES modules and therefore *never downloads* that 38.6KB chunk. The gate
was inflating all 30 routes by 38.6KB of code no modern user fetches. It now
measures `rootMainFiles` only and reports the legacy polyfill payload
separately.

Composition of the 126.1KB, by fingerprinting the chunks: react-dom + react
69.8KB, Next App Router client 44.5KB, Turbopack runtime and misc 11.9KB.
**None of it is application code** — a hello-world on this Next/React pair
measures the same. It is a framework floor, not bloat.

Two concrete leads from the per-chunk breakdown:

1. ~~jsPDF is eagerly bundled into the timetable page.~~ **Fixed.** A single
   146.5KB gzipped chunk (471KB raw) of `jsPDF` + `AutoTable` sat in the initial
   payload of exactly one route, making `/[locale]/(app)/admin/timetable`
   492.5KB against ~346KB for its siblings. Moving it behind
   `await import("jspdf")` in the export handler took that route to **355.4KB**,
   a 137KB drop, and back in line with its siblings.

2. ~~The `(auth)` pages are 74KB above the shared floor.~~ **Partly fixed.**
   `QueryClientProvider` and sonner's `<Toaster/>` sat in the root layout, so
   all four unauthenticated routes downloaded a query cache and a toast
   renderer neither uses — verified by grep: nothing under `(auth)` imports
   either. Moving them into `(app)/layout.tsx` cut **17.1KB** from every auth
   route (113.7 → 96.6KB own JS).

3. **`socket.io-client` was in the timetable's initial payload.** Only the
   timetable editor uses it and the connection is established after mount, so
   a dynamic import inside the effect removed **12.8KB** (190.6 → 177.8KB own
   JS) with no behavioural change.

4. **Supabase is 70.2KB on every route, including `/login`.** `createBrowserClient`
   pulls the whole SDK — auth, postgrest, realtime, storage, functions — because
   `SupabaseClient` instantiates all five as properties, so the bundler cannot
   drop the unused ones. A login form needs only `signInWithPassword`. Using
   `@supabase/auth-js` directly on auth routes is worth an estimated 25–35KB,
   but it means re-implementing the `@supabase/ssr` cookie contract; **not
   attempted, and it needs a spike before anyone commits to it.**

5. **`NextIntlClientProvider` is rendered with no `messages` prop**, which
   next-intl treats as "send everything" — all 32 namespaces reach the client
   on every route, so `/login` carries the admin timetable strings. That is RSC
   payload rather than JS bundle, so it does not move this gate, but it is real
   transfer weight. Narrowing it per route group is worth ~6–7KB and was left
   out of the bundle work because getting it wrong breaks translations
   silently.

Full per-route table: `npm run bench:bundle`. Largest chunks:
`node -e` gzip sweep over `web/.next/static/chunks` (see git history of this doc).

INP is a **field** metric: it requires real user interactions and cannot be
produced by a lab run. `lighthouserc.json` asserts Total Blocking Time at the
same 100ms threshold as the closest lab proxy. Actually gating the real INP ≤
100ms target needs RUM — `web-vitals` reporting to an analytics endpoint. That
does not exist yet, so this row cannot be honestly closed by CI alone.

LCP and TTI need a Lighthouse run against the built app; the build now succeeds
so these are unblocked — `npm run bench:lighthouse`.

## Backend / solver

| Metric | Target | Measured | Status |
| :--- | :--- | :--- | :--- |
| Schedule generation, 2,000 students | < 10s | **400 in <10s; 1,300 in ~9.5 min; 2,000 TIMEOUT at 570s** | ✗ |
| API P99, reads | ≤ 50ms | **66–181ms** on the two list endpoints over five CI runs; printed, not gated — the gate is each read's share of health's throughput (below) | ✗ |
| API P99, updates | ≤ 150ms | **85–167ms** over 300 samples in four CI runs, above 150ms in one; printed, not gated until its baseline is calibrated (below) | ✗ |

### API latency, measured against the real stack

Run on docker-compose (Postgres + API + solver) with a seeded database,
25 connections, 20s per scenario. **Zero non-2xx in every scenario** — see the
warning below about why that number is the first thing to check.

| Scenario | p50 | p99 | §2 target | |
| :--- | ---: | ---: | ---: | :--- |
| `GET /health/ready` | 5ms | 12ms | 50ms | ✓ |
| `GET /api/v1/schedule-versions` | 52ms | 71ms | 50ms | ✗ |
| `GET /api/v1/optimization/jobs` | 54ms | 86ms | 50ms | ✗ |
| `POST /api/v1/attendance/report` | 40ms | 83ms | 150ms | ✓ |

`/health/ready` is `@Public()` and `@SkipThrottle()`: no bearer token, no
identity lookup, no transaction, no RLS — one bare `SELECT 1`. So ~12ms is what
the framework and a pooled connection cost on this hardware, not the floor of an
authenticated read. The two list endpoints sit at roughly six times that, and
that is not their own queries: the seed creates no schedule versions or
optimization jobs, so both return `[]` from a query that matches no row for a
policy to judge. The gap is the path every JWT request pays
around its query — token verification, the identity lookup's transaction, the
guards and the RLS transaction the handler runs in. Writes pass with headroom.

Caveats worth carrying: these are Docker Desktop numbers on a laptop VM, so
treat them as relative rather than absolute — CI is the gating run, and its
numbers and the gate they set are further down. Nor do they fit that gate's
thresholds: health's p50 here is a tenth of a read's, where on the runner it is
about a quarter. The write figure here is 24 serial samples, not a flood, so
its p99 is the slowest of them; the benchmark now takes 300.

**The gateway's read surface is small by design.** The web client queries
Supabase directly (`web/lib/queries.ts`); this API handles writes, AI proxying
and the SS12000 feed. The benchmark times two of the API's authenticated list
reads, not every GET it has. An earlier version of the benchmark invented paths
like `/api/v1/resources/rooms` that do not exist and would have timed 404s.

**Two endpoints cannot be flood-tested, for good reasons.** The global
throttler is 120 req/60s, and `POST /attendance/report` carries its own
`@Throttle({ limit: 10, ttl: 30_000 })`. Under load 99.9% of responses were
429, and the benchmark cheerfully reported PASS on the throttler's latency
until the non-2xx guard was tightened from "all failed" to ">1% failed". The
attendance route is now sampled serially instead — 10 per 30s is 0.33 req/s and
autocannon's minimum rate is 1 req/s, so the allowance cannot be expressed to it
at all — in 300 single requests 300ms apart across twelve throttler buckets,
each with a baseline GET halfway to the next (below). Raise `THROTTLE_LIMIT` on the target before a run —
the throttler is not what this gate measures.

### The gate is relative to the run's own authenticated floor

**No absolute millisecond decides the run, and since 2026-11-02 neither does
health.** `quality-gates.yml` → api-latency fails on quantities that hold across
runners, measured against the same run's authenticated-read floor:

- **Reads**: each authenticated read's throughput as a share of the floor's
  must be **≥ 0.80**. The floor is `GET /api/v1/schedule-versions` for an
  academic year that does not exist — `200 []` after everything a real read
  pays — taken as the median of three 20s rounds that run straight after the
  reads.
- **The floor**: an absolute guard, **≥ 300 req/s**. Passing it proves every
  read ≥ 240 req/s whatever the floor did. It is the only thing that sees a
  regression on the path every authenticated request shares, and only a large
  one (below).
- **Health**: an absolute guard, **p99 ≤ 50ms** and **≥ 1000 req/s**, as
  before. It no longer divides anything.
- **The write** is measured against a serial baseline interleaved with it and
  printed as write ÷ baseline at p50, p95 and p99. It is **not gated** until ten
  runs have calibrated a threshold (below).
- **Invalid, exit 2**: more than 1% of any row's attempts failed, and health,
  either read or the floor rounds not measured. A failed attempt is a non-2xx
  answer or a connection error; autocannon's `errors` already include its
  `timeouts` ("connection errors, including timeouts"), so a timeout is counted
  once and not twice. A share without its numerator or its denominator has no
  verdict.
- **Printed, deciding nothing**: each read's and the floor's share of health,
  the gate from 2026-09-14 to 2026-11-02, so a night can still be set beside
  the old ones; and the CPU model the runner drew (the `Runner` step).

Every p50, p99 and max is still printed, with §2's 50ms / 150ms beside each row
as met or not met. Unchanged: 25 connections, 20s per read, the scenarios, the
300-sample write on twelve trackers, the fixtures and the token. Changed: the
floor rounds run every night and before the write (they were `--floor`, a
dispatch option, after it).

The verdict is `scripts/bench/latency-gate.mjs`, a pure module with no imports.
`scripts/bench/latency-gate.test.mjs` runs it with `node --test` in `ci.yml` →
api on the rows of fourteen real runs and holds it by eight mutants of the gate,
so a change to it is proven on the pull request, not first at night.

**Why the share of health stopped holding.** The gate of 2026-09-14 divided
each read by health and was calibrated on five runs of the private repository's
2-vCPU runners (0.226–0.265). The repository went public on 2026-09-30 and its
runs since are on 4-vCPU runners, a mixed pool: all 35 runners of run
41443397511 (below) report `lscpu` 4 CPUs, and they were 19 AMD EPYC 7763, 9
EPYC 9V74, 6 EPYC 9V45 and one Xeon 8573C. Health is one `SELECT 1` on the
pool; a read is token verification, two transactions and an RLS policy, and
they do not scale alike with the CPU:

| CPU, healthy tree | runs | health req/s | reads req/s | floor req/s | read ÷ health | floor ÷ health | read ÷ floor |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| EPYC 7763 | 9 | 2051–2212 | 403–429 | 433–462 | 0.188–0.199 | 0.206–0.215 | 0.900–0.962 |
| EPYC 9V74 | 4 | 2902–3114 | 533–568 | 566–605 | 0.175–0.187 | 0.186–0.202 | 0.925–0.952 |
| EPYC 9V45 | 3 | 4930–5341 | 597–689 | 661–749 | 0.120–0.129 | 0.133–0.140 | 0.871–0.958 |
| all | 16 | 2051–5341 (2.6×) | 403–689 (1.7×) | 433–749 | 0.120–0.199 | 0.133–0.215 | 0.871–0.962 |

On the same tree, with no change, the share of health fell from 0.20 to 0.12
with the CPU the night drew, and not one of the sixteen reached 0.20. The
nightly agrees: of the 35 runs whose logs survive, 2026-09-30 to 2026-11-02,
32 had a read under 0.20 (31 of the 34 scheduled ones), at shares of
0.121–0.205, while health ranged 2091–5715 req/s and the reads 395–761. The
three scheduled runs that passed (10-03, 10-04, 10-08) were 0.201–0.204. The floor
is a read without its own query, so it moves with the CPU as the reads do: its
share of the reads has a CV of 2.1% on schedule-versions and 1.5% on
optimization/jobs where the share of health has 15%.

**The sixteen healthy runs**, all of 41443397511 (a throwaway branch, since
deleted: the nightly's api-latency job on 35 fresh runners, `--floor-rounds 3`
and `--json`). Read ÷ floor and read ÷ health are schedule-versions, then
optimization/jobs:

| Runner | CPU | health | schedule-versions | optimization/jobs | floor (median of 3) | read ÷ floor | read ÷ health |
| :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| base #9 | EPYC 7763 | 2051 | 405 | 404 | 436 | 0.930, 0.927 | 0.198, 0.197 |
| base #6 | EPYC 7763 | 2081 | 403 | 407 | 439 | 0.916, 0.926 | 0.193, 0.196 |
| base #4 | EPYC 7763 | 2089 | 407 | 404 | 449 | 0.906, 0.900 | 0.195, 0.193 |
| base #3 | EPYC 7763 | 2103 | 406 | 417 | 433 | 0.937, 0.962 | 0.193, 0.198 |
| base #1 | EPYC 7763 | 2150 | 424 | 427 | 455 | 0.933, 0.938 | 0.197, 0.199 |
| base #13 | EPYC 7763 | 2154 | 406 | 417 | 444 | 0.914, 0.939 | 0.188, 0.193 |
| base #14 | EPYC 7763 | 2155 | 423 | 426 | 457 | 0.926, 0.931 | 0.196, 0.197 |
| base #5 | EPYC 7763 | 2156 | 411 | 423 | 451 | 0.910, 0.937 | 0.190, 0.196 |
| base #16 | EPYC 7763 | 2212 | 423 | 429 | 462 | 0.915, 0.928 | 0.191, 0.194 |
| base #10 | EPYC 9V74 | 2902 | 543 | 544 | 585 | 0.928, 0.929 | 0.187, 0.187 |
| base #2 | EPYC 9V74 | 3039 | 539 | 533 | 566 | 0.952, 0.941 | 0.177, 0.175 |
| base #8 | EPYC 9V74 | 3106 | 552 | 546 | 590 | 0.937, 0.925 | 0.178, 0.176 |
| base #15 | EPYC 9V74 | 3114 | 568 | 562 | 605 | 0.938, 0.928 | 0.182, 0.180 |
| base #12 | EPYC 9V45 | 4930 | 634 | 638 | 665 | 0.952, 0.958 | 0.129, 0.129 |
| base #11 | EPYC 9V45 | 4959 | 597 | 608 | 661 | 0.903, 0.919 | 0.120, 0.123 |
| base #7 | EPYC 9V45 | 5341 | 652 | 689 | 749 | 0.871, 0.920 | 0.122, 0.129 |

**Threshold: 0.80, and exactly 0.80 passes.** Over the 32 shares: min 0.871,
median 0.928, mean 0.9275, σ 0.018, max 0.962. The rules the earlier gate used
do not agree this time:

- min − (median − min) = 2 × 0.871 − 0.928 = 0.8137.
- median × (1 − max(20%, range ÷ min = 10.5%)) = 0.928 × 0.80 = 0.7426.
- A one-sided 99%/95% tolerance bound over the 16 runs' mean shares: 0.9275 −
  3.464 × 0.0157 = 0.8730, 3.464 being the factor for n = 16 (and 5.741 for
  n = 5, the 5.74 used for the first gate). It bounds a mean of two shares and
  lies on the lowest single share seen, so it is not a threshold for one.

0.80 is the round number under the middle one, 1.7% below it. It sits 8.2%
below the lowest of the 32 shares, 7σ below their mean. A read that becomes x
more expensive than the floor fails when share ÷ (1 + x) < 0.80: from +8.9% at
the lowest share seen, +16.0% at the median, +20.3% at the highest. The gate it
replaces caught a read a quarter to a third more expensive, on five runs of one
CPU; this one catches +16% at the median share, because its share has a small
fraction of the spread.

**Its noise.** A read's 20s window sometimes runs slow beside its neighbours.
Counting every window that no injected change touched (the sixteen healthy
runs' 32; schedule-versions in the 13 handler runs below; both reads in the six
path runs: 57 in the final calibration, 24 in the first, 12 in the older
private runs) 2 of 93 fell under 0.80:

- 0.792: schedule-versions at 453 req/s against floor rounds of 563, 572 and
  575, in a run whose jobs carried twelve extra statements.
- 0.748: optimization/jobs on an EPYC 9V74 in the first calibration, run
  41441911608 (12 healthy runs, five floor rounds measured after the write, the
  median taken), where the floor rounds rose from 554 to 598 req/s across the
  run. The script now measures the floor straight after the reads, so that the
  two windows are neighbours; none of the sixteen fell under 0.871. The lowest
  of the older private runs is 0.833 (34839849296's jobs, the window whose p99
  was 181ms).

That is about one night in twenty red on a tree that has not changed. Rerun it
before looking at the tree; two reds in a row are not this.

**What it reaches, on a handler.** The same tree with K extra `SELECT 1`
statements compiled into `optimization/jobs` only, on 13 further runners of the
same three models (run 41443397511; the switches existed on that branch and are
not in the tree). What was measured is K: two extra statements passed 3 of 3,
four failed 4 of 4, eight and twelve failed 3 of 3 each; K = 3 was never run.
The cost in the table is derived from the share (the healthy median 0.932 ÷ the
variant's mean), about 5% a statement, so the line between pass and fail lies
between about +11% and +22%.

| Extra statements | runs | cost of the read, derived from the share | optimization/jobs ÷ floor | fails at 0.80 | old gate, jobs ÷ health |
| :--- | ---: | ---: | ---: | ---: | ---: |
| 2 | 3 | about +10% | 0.828–0.853 | 0 of 3 | 0.111–0.174 |
| 4 | 4 | about +22% | 0.752–0.787 | 4 of 4 | 0.154–0.160 |
| 8 | 3 | about +40% | 0.647–0.682 | 3 of 3 | 0.126–0.136 |
| 12 | 3 | about +53% | 0.567–0.648 | 3 of 3 | 0.094–0.118 |

schedule-versions beside it, on the same path without the change, stayed at
0.79–1.03: one of the 13 below 0.80 (the 0.792 above). The old gate failed all
13, as it failed every healthy run.

**What each read catches.** Only `optimization/jobs` is a handler the floor does
not share. The floor is `GET /api/v1/schedule-versions` for a year that does not
exist, and the read is the same route, `ScheduleVersionsController.list` and its
handler, for the benchmark's year; only the academic year's UUID differs. A
regression in that handler, or in `ScheduleVersionsService.list`, slows the read
and the floor alike, so schedule-versions ÷ floor moves only with what grows
with the year's rows (the seed has none), and otherwise measures noise and a
constant level difference: in the 25 runs checked afterwards the floor ran 7–8%
above both reads, which the runs cannot tell apart as the order (floor last) or
the year that exists against the one that does not. In effect the gate checks
one handler. A second one worth checking needs a floor that none of the gated
reads shares, and a new denominator needs new history; neither is part of this
change.

**What it cannot see.** A regression on the path every authenticated request
shares — the token, the identity lookup, the guards, the RLS transaction —
slows the floor as much as the read, so no share moves. With four extra
statements in each of a request's two transactions (+35% on an EPYC 7763: the
floor fell from 455 to 338 req/s) the shares were 0.916–0.947 on all three
runs and the run passed; with twelve (+120%) two of three failed the floor
guard, at 205 and 209 req/s, and the third, an EPYC 9V45 at 415, passed it.

| Variant | runs | CPUs | floor req/s | floor ÷ health | reads ÷ floor | floor guard |
| :--- | ---: | :--- | ---: | ---: | ---: | :--- |
| 4 statements per transaction | 3 | 7763, 7763, Xeon 8573C | 323–405 | 0.115–0.155 | 0.916–0.947 | 3 pass |
| 12 | 3 | 7763, 7763, 9V45 | 205–415 | 0.078–0.101 | 0.871–0.970 | 2 fail, 1 passes |

That is what the share of health used to see, and it saw it on the one CPU it
was calibrated on. **The floor guard is a tripwire, not a regression gate.**
≥ 300 req/s sits 28% below the lowest healthy floor seen (414; 433 in the
sixteen) and fires at about +50% on a request on the slowest model, later on
the faster ones (749 → 300 is +150%). Within one CPU model the floor ÷ health
ratio is steady (0.206–0.215 on the nine 7763s) and fell to 0.154 and 0.097 in
those runs, so comparing a night with the same model's nights would see what
the guard does not; the `Runner` step prints the model for that, and nothing
gates on it, because a model nobody has calibrated has no baseline. A reference
that does not contain the gateway's code but costs what an authenticated read
costs (a Postgres-only probe, say) would be the proper denominator for this
path, and is not part of this change.

**The health guard.**

- **p99 ≤ 50ms**, failing above: §2's own read target, the one row that meets
  it on the runner. Seen: 12–32ms.
- **≥ 1000 req/s**, failing below. Seen: 1722–5715.
- Health is the framework and a pooled `SELECT 1`. A regression on that path — a
  global interceptor, the pool — slows the floor as much as health, so no share
  sees it; only this guard can, and only when it is large: if health's p99
  grows with its cost it fires at +56% on the runs at 32ms and at +317% on the
  12ms ones the fast CPUs give.

**History: the gates before 2026-11-02.** Absolute budgets first, then a share
of health.

**Why the absolute budgets failed.** Five latency-only runs on the 2-vCPU
`ubuntu-latest` runner, 25 connections, 20s per read, zero non-2xx in every
row. They measure the same application code: `48c82db` carries rebased copies
of the three perf commits, and `15edbcc` and `849858c` changed only the
benchmark and its docs. Latencies are p50/p99 in ms.

| Run | Commit | health | schedule-versions | optimization/jobs | floor rounds | write p50/p99/max |
| :--- | :--- | ---: | ---: | ---: | ---: | ---: |
| 34825468923 | `48c82db` | 2433 req/s, 8/24 | 586 req/s, 40/86 | 590 req/s, 41/72 | – | 43/152/152, 24 samples |
| 34832429087 | `15edbcc` | 1930 req/s, 11/32 | 476 req/s, 49/107 | 494 req/s, 49/87 | 469, 479, 479 req/s | 51/104/157 |
| 34838510625 | `849858c` | 2708 req/s, 8/22 | 670 req/s, 35/69 | 670 req/s, 36/66 | 677, 694, 697 req/s | 39/167/236 |
| 34839849296 | `849858c` | 1771 req/s, 12/32 | 441 req/s, 53/120 | 400 req/s, 58/181 | 444, 481, 480 req/s | 48/85/193 |
| 34839859422 | `849858c` | 1722 req/s, 12/32 | 439 req/s, 53/115 | 456 req/s, 53/90 | 460, 481, 483 req/s | 48/100/183 |

On `849858c`, with no code change, the 140ms read / 150ms write budgets failed
two runs of three: 34838510625 on the write's p99 of 167ms, 34839849296 on
jobs' p99 of 181ms. Health's own throughput moved 1.57× across the five runs. A
millisecond budget wide enough for the slow runner lets a read double on the
fast one — at 34838510625's 69 and 66ms a read needed +103% to reach 140ms —
and one tight enough for the fast runner fails the slow one on noise.

**Why throughput, and not a latency ratio.**

- autocannon reports whole milliseconds, and health's p50 is 8–12ms: rounding
  alone moves a p50 ratio's denominator by 4–6%. The req/s figures rest on
  8,000–54,000 counted requests.
- At 25 closed-loop connections req/s = 25 ÷ mean latency, so the share is
  exactly the inverse ratio of the mean latencies. It covers the whole
  distribution, which is where an extra per-request cost shows.
- Over the five runs health p50 ÷ read p50 ranged 0.195–0.229 (34825468923 is
  already below 0.20), health p99 ÷ read p99 0.177–0.368 (2.1×), and the req/s
  share 0.226–0.265 (1.17×), while health itself ranged 1722–2708 req/s.

| Run | schedule-versions | optimization/jobs | floor rounds (not gated) |
| :--- | ---: | ---: | ---: |
| 34825468923 | 0.241 | 0.242 | – |
| 34832429087 | 0.247 | 0.256 | 0.243, 0.248, 0.248 |
| 34838510625 | 0.247 | 0.247 | 0.250, 0.256, 0.257 |
| 34839849296 | 0.249 | 0.226 | 0.251, 0.272, 0.271 |
| 34839859422 | 0.255 | 0.265 | 0.267, 0.279, 0.280 |

Ten route shares: min 0.2259, median 0.2474, mean 0.2475, max 0.2648,
σ 0.0104 (CV 4.2%). Range ÷ min is 17.2%, and the worst drop below the median
is 8.7% — 34839849296's jobs row, the same window whose p99 was 181ms.

**The share of health, 2026-09-14 to 2026-11-02.** Its threshold was 0.20, and
exactly 0.20 passed: the same three rules, applied to those five runs, gave
0.198–0.204 (min − (median − min) = 0.2043, median × 0.80 = 0.1979, the
99%/95% tolerance bound over the five runs' mean shares 0.1976). The lowest
share seen was 12.9% above it, so a read failed it from +12.9% (+23.7% at the
median, +32.4% at the highest). Two older runs of the same command measured it
on real changes. 34680196887 on `7634a55`, before the pool was sized to the load
and identity looked up once, failed at shares of 0.134 and 0.138. 34754776477 on
`a017b19`, the stack of that time with #60's three auth/RLS perf commits
reverted, passed at 0.213 and 0.218: the gate caught a read roughly a quarter to
a third more expensive, not a change the size of that perf work. The unit test
held both runs until 2026-11-02 and cannot now, since neither has floor rounds.
The derivations, the sensitivity table and the argument about a slowed health
window are in this file's git history before that date.

**The write takes 300 samples on twelve trackers.** Over 24 samples the p99 is
the slowest single write — 152ms in run 34825468923, 194ms in 34832429087 —
roughly their p96, and on a fresh database only the first sample inserts. Over
300 it is rank 297. At the route's own pace of one sample per 3.2s that would
take 16 minutes, so the samples rotate across twelve `X-Forwarded-For`
addresses 300ms apart: the throttler keys its bucket on `req.ip`, `main.ts`
trusts one proxy hop, and each bucket sees a hit at most every 3.6s — 9 inside
any 30s, under the limit of 10. A mistake there would show as 429s and fail the
run on the non-2xx check, which over 300 samples lets up to 3 non-2xx pass
where 24 allowed none.

**The write's baseline is interleaved with it.** Each write sample is followed
150ms later by one serial GET of the floor with the same token and
`X-Forwarded-For`, and 150ms after that by the next write. The writes stay
300ms plus latencies apart, so the arithmetic above is unchanged, and the GET
counts in its own handler's bucket. The pair is adjacent in time and each
follows the other after the same idle, which cancels the runner's CPU speed,
the authenticated path (token, identity lookup, guards, RLS), the network stack
and short disturbances. It does not cancel write-only I/O — WAL flush,
checkpoints — and that remainder is what calibration measures. The run prints
write ÷ baseline at p50, p95 and p99 from unrounded samples, and write p50 ÷
health p50 as a fallback candidate.

**Why not a ratio to the load rows.** Over the four 300-sample runs:

| Ratio | 34832429087 | 34838510625 | 34839849296 | 34839859422 | Spread |
| :--- | ---: | ---: | ---: | ---: | ---: |
| write p50 ÷ health p50 | 4.64 | 4.88 | 4.00 | 4.00 | 22% |
| write p50 ÷ schedule-versions p50 | 1.04 | 1.11 | 0.91 | 0.91 | 23% |
| write p50 ÷ health mean latency | 3.94 | 4.22 | 3.40 | 3.31 | 27% |
| write p99 ÷ health p99 | 3.25 | 7.59 | 2.66 | 3.13 | 2.9× |
| write p99 ÷ schedule-versions p99 | 0.97 | 2.42 | 0.71 | 0.87 | 3.4× |

§2's update target is a p99, and every p99 ratio spans 2.9–3.4×. A median
ratio divides a serial service time on an idle box by a latency that is mostly
queueing under 25 connections, and the two scale differently with core count
and with the CPU-to-disk speed ratio. Four runs are too few for an honest
threshold anyway, and the tail does not follow CPU speed: 34838510625 had the
fastest CPU (health 2708 req/s), the best write p50 (39ms) and the worst write
tail (p99 167ms, max 236ms).

**Calibrating the write.** Exactly ten runs of the merged code, each with 300
pairs and zero non-2xx in both rows, including at least one with health below
2000 req/s and one above 2300 — the two runner clusters seen so far — or up to
fifteen until they do. The nightly supplies them at no extra cost, and the
validation dispatch before merge is run 1. Then:

- A percentile is gateable if its ratio's range ÷ min over the ten runs is
  ≤ 25% (the read share's is 17%, the old margin 24%).
- Gate p99 if it is gateable (§2's statistic), else p95, else p50.
- The threshold is max + (max − median), rounded up to 0.1, and the run fails
  when the ratio exceeds it.
- If no percentile qualifies, the write stays ungated and the ten runs go back
  for a decision.

Setting that threshold also makes the write and its baseline required rows.

**What it costs the nightly.** No extra sleep — the 300ms between writes is
split in two — so the baseline adds 300 serial GETs, about 3–5s and at most
15s. One disclosed trade-off: each write now follows 150ms idle and a GET
instead of 300ms idle, so later absolute write numbers are not strictly
continuous with the table above. The benchmark step took 226–228s with the
floor rounds on `849858c`, 304s in 34832429087, which ran both writes, and 138s
in 34825468923 with neither the floor rounds nor the 300-sample write. The three
floor rounds, about 60s, now run every night and before the write rather than
after it; the step took 215–221s on the 35 runners of 41443397511 and the whole
job 5–5.7 minutes, against 4.5–5 for the nightly it replaces (which failed at
its last step).

**Scope.** The thresholds are calibrated for GitHub `ubuntu-latest` as a public
repository gets it — 4 vCPU, a mixed pool of CPU models — 25 connections, 20s
per read; the earlier ones were calibrated on 2 vCPU. The Docker Desktop table
above is not comparable: health's p50 there is a tenth of a read's (5 against
52–54ms), where on the runner it is a fifth to a quarter, so a local run can
look different from the runner's on the laptop's shape alone. Read its
milliseconds, not its verdict. The reads' p50 on the runner, 56–61ms on the
slowest model (35–61 over all three), against §2's 50ms, is a separate question
from this gate and is not touched by it.

The floor is
`GET /api/v1/schedule-versions?academicYearId=00000000-0000-4000-8000-000000000000`:
a valid v4 UUID naming no academic year, so the answer is `200 []` after
everything a real authenticated read pays. It is also what the write's baseline
samples serially, and, since 2026-11-02, the gate's denominator. The 140ms read
budget the first gate replaced was derived from 34832429087's floor rounds; the
derivation is in this file's git history.

### The solver cannot accept a 2,000-student school

At realistic constraint density (one recurring weekly unavailability per
teacher) the engine refuses the payload before any solving happens:

```
2000 students / 80 classes / 960 requirements / 92 rooms / 166 constraints
  status            REJECTED
  model complexity  2,655,360 (budget 2,000,000)
```

There are two separate problems here, and the first was hiding the second.
Reproduce any of what follows with `benchmarks/profile_model.py`, which lifts
the guard so the model can be measured at sizes the service refuses.

**1. The guard rejects the payload, but its formula measures the wrong thing.**

`SchedulerSolver.MAX_MODEL_COMPLEXITY` is 2,000,000 and the estimate is
`lessons × rooms + lessons × constraints × days`. Measuring what the build
actually costs at 2,000 students shows that formula is not a proxy for anything:

| builder | build time | share of build | share of the guard's estimate |
| :--- | ---: | ---: | ---: |
| `room_no_overlap` | 4.10s | 48.0% | 10% |
| `rules` (lunch + per-day cap) | 3.12s | 36.6% | **not modelled at all** |
| `objective` | 0.71s | 8.3% | not modelled |
| `capacity` | 0.29s | 3.4% | not modelled |
| `availability` | 0.26s | 3.0% | **90%** |

The term contributing 90% of the estimate accounts for 3% of the real cost, and
the second-largest real cost is absent from the formula. The cause is that
`_decisions_for_constraint` filters: a TEACHER constraint only ever touches that
teacher's lessons, never all of them. So `lessons × constraints × days`
overcounts, and it does so as roughly *n³* while the real model grows about *n²*
— the estimate drifts from 0.75× the true variable count at 250 students to
4.05× at 2,000. Larger schools get rejected ever more aggressively for a cost
they do not incur.

A proxy that tracks the real model is `lessons × rooms + lessons × days ×
lunch_candidates × 3`, which stays within 0.79–0.87× of the true variable count
across an 8× range of school sizes.

**2. Lifting the guard does not produce a schedule.**

Removing the ceiling entirely and running the 2,000-student school:

| | |
| :--- | :--- |
| model | 655,106 variables, 1,622,688 constraints |
| build | 8.5–8.9s — **alone over the 10s budget, before any search** |
| solve, 9s limit | TIMEOUT, **0 of 2,880 lessons** |
| solve, 291s limit | TIMEOUT, **0 of 2,880 lessons** |

Five minutes of search does not find one feasible timetable. So the guard was
never the binding limit on capability — it was masking the fact that the model
does not solve at this scale at all.

Nor is this a large-school problem. Every size tested fails the 10s budget:

| students | variables | build | solve | result |
| ---: | ---: | ---: | ---: | :--- |
| 250 | 52,930 | 0.56s | 9.52s | 0 of 360 |
| 500 | 114,231 | 1.29s | 8.88s | 0 of 720 |
| 1,000 | 261,313 | 3.20s | 7.22s | 0 of 1,440 |
| 1,500 | 441,515 | 5.62s | 5.11s | 0 of 2,160 |
| 2,000 | 655,106 | 8.91s | 1.66s | 0 of 2,880 |

The synthetic school is satisfiable: room utilisation is 63–65%, specialist-room
demand is well inside supply, and 36 lessons/week/class fits the 8/day cap. This
is not an over-constrained fixture.

**What actually blocks it.** Adding constraint groups cumulatively isolates the
cause — at 250 students, with a 10s budget:

| rules | objective | status | scheduled |
| :--- | :--- | :--- | ---: |
| off | off | **OPTIMAL in 5.0s** | 360 / 360 |
| off | on | TIMEOUT | 0 / 360 |
| on | off | TIMEOUT | 0 / 360 |
| on | on | TIMEOUT | 0 / 360 |

The core model — capacity, teacher/group/room no-overlap, availability — solves
to optimality. Adding *either* the lunch rules *or* the objective terms
independently takes it from solved-in-5s to nothing-found-in-10s.

**Root cause, confirmed.** `AssumptionRegistry.register` calls
`model.AddAssumption()` (`app/solver/conflict_analyzer.py:39`), and
`_add_capacity_constraints` calls it **once per lesson instance** — 380
assumption literals at 250 students, 3,046 at 2,000. CP-SAT's own log, on the
real 250-student fixture with `num_workers=8` explicitly set:

```
Forcing sequential search as assumptions are not supported in multi-thread.
Forcing presolve to keep all feasible solutions in the presence of assumptions.
Starting search at 0.80s with 1 workers.
1 full problem subsolver: [main]
```

CP-SAT **overrides `num_workers`**, which is the mechanical reason setting it to
8 changed nothing. The solver runs on one core with the weakest strategy, no
LNS portfolio, and solution-losing presolve reductions disabled. Demoting those
literals to plain unit clauses — an identical feasible set, verified by
exhaustive enumeration — restores the full portfolio:

| 250 students, core model | with `AddAssumption` | demoted to unit clause |
| :--- | :--- | :--- |
| workers | 1 | **8** |
| subsolvers | `[main]` | 6 full + 2 first-solution + 2 LNS + 2 helpers |
| result | TIMEOUT | **OPTIMAL** |

This is also why "either rules or objective independently kills it" looked like
two separate causes. It is one model with no margin: running on 1/8 of the
machine, anything added tips it over.

The second cost is the lunch encoding, which creates three booleans per
(group × day × candidate start × lesson) — 302,400 variables at 2,000 students,
**46% of the whole model** — to express a rule whose information content is
O(groups × days). Restating it as one variable-start interval per (group, day)
inside the group's existing `NoOverlap` is exactly equivalent and costs 400
variables.

**Measured effect of the fixes.** All four are now landed: assumption demotion,
the interval lunch encoding and the within-day start domain in `530eef3`, and
the room-class allocator in `a028def`.

Through the real `solve()` path, with every schedule checked by
`benchmarks/validate_schedule.py` rather than trusting the solver's status,
after the two-phase solve landed (`0834832`):

| students | budget | result |
| ---: | ---: | :--- |
| 250 | 10s | FEASIBLE, 360/360, VALID |
| 400 | 10s | FEASIBLE, 576/576, VALID |
| 500 | 120s | FEASIBLE, 720/720, VALID |
| 750 | 120s | FEASIBLE, 1,080/1,080, VALID |
| 1,000 | 180s | FEASIBLE, 1,440/1,440, VALID |
| 1,300 | 570s | FEASIBLE, 1,872/1,872, VALID |

Before this work no size produced a valid timetable at all. `solve()` now
proves existence first (a sequential portfolio of two satisfaction encodings —
neither dominates; the smaller "clean" build wins below ~500 students and the
cleared-clone build is the only one that works at 1,000+) and spends the
remaining budget optimising from the winner as a hint. When optimisation
produces nothing, the existence schedule is returned rather than an empty
TIMEOUT.

**Warm starts** (`682f9f0`): a previous schedule's placements now seed the
phase-1 existence search. Measured on the phase-1 satisfaction solve — 500
students: 35.6s cold → 2.2s warm; 1,000 students: TIMEOUT at 120s cold → 6.7s
warm; a perturbation that invalidates part of the previous schedule (the
most-loaded teacher losing Monday morning) costs nothing. End-to-end at 1,000
students with a 30s budget: valid, with 1,418 of 1,440 lessons keeping their
previous slot. Cold generation remains the expensive once-per-school event;
regeneration is now interactive.

The complexity guard has been re-derived (`523339f`): `_estimate_model_size`
predicts the variable count per builder (96,700 predicted vs 92,546 measured at
2,000 students — within 4.5%) against a budget of 1,000,000, replacing a
formula that charged 2.65M for this school. With the guard fixed, 2,000
students reaches the solver for the first time and the result is a real
measurement: **TIMEOUT at both 10s and 570s, zero lessons**. Extrapolating from
1,300 needing 474s of satisfaction search, 2,000 cold-start needs patience
beyond ten minutes, a warm start from `previous_lessons`, or decomposition —
now a measured statement rather than a guess blocked by arithmetic.

Model size at 2,000 students fell from 655,106 variables to 92,546, and build
from 8.5s to 1.6s. The room block alone went from 264,960 variables to 7,200.

Note a fixture artifact when reading the curve: the benchmark generator cycles
room types, so at 425 and 450 students a single gymnasium must host 51-54
lessons against 50 available slots. Those sizes are genuinely infeasible and the
solver correctly proves it in 0.6s. 475 and above are well-formed again.

Earlier prototype measurements, at a 10s budget:

| students | model | first solution | verdict |
| ---: | ---: | ---: | :--- |
| 250 | 12,130 vars | 3.0s | **VALID**, 360/360 |
| 400 | 19,139 vars | 6.2s | **VALID**, 576/576 |
| 500 | 23,991 vars | never (60s) | nothing |
| 2,000 | 95,426 vars | never (120s) | nothing |

At 2,000 students the model shrinks from 655,106 variables to 95,426 (−85%) and
build from 8.5s to 1.6s — but the search still finds nothing. Dropping the
objective trades reach for optimality and moves the cliff by one step: 500
students reaches OPTIMAL 720/720 in 26.9s, 750 finds nothing in 60s.

So the honest position is that these fixes take the engine from **no size at
all** to roughly **400–500 students**, and 2,000 remains a factor of four away
behind a hard cliff rather than a gradient. §2's target is not a tuning
question.

Note also that `Solve()` runs to its time limit whenever optimality is not
proven, so total wall clock is pinned at the budget and says nothing about when
a usable answer appeared — hence the separate first-solution column above.

### The solver can emit a lesson that runs past the end of the day

`_create_lesson_decisions` (`app/solver/scheduler_solver.py:210`) gives `start`
the contiguous domain `[0, horizon - duration]` — the whole week, not one day.
Nothing constrains a lesson to lie within a single day; `_day_var` only
*derives* the day by integer division. Twelve start values are invalid:

```
{37, 38, 39, 77, 78, 79, 117, 118, 119, 157, 158, 159}
```

Each puts a 60-minute lesson across an 18:00 → 08:00 boundary.
`_extract_lessons` reports such a lesson as `day_of_week=1, 17:30:00–18:30:00` —
half an hour past the configured 18:00 day end — while the model has actually
reserved the teacher, group and room for the *next* morning's first two slots.
`TimeGrid.decode_absolute` never checks `start_slot + duration <= slots_per_day`.

This is not theoretical: `validate_schedule.py` caught the solver choosing
start slot 38 on a real 250-student run. Restricting the domain to within-day
windows fixes it at no measurable cost.

### A payload that names nobody was owed no lunch

The second thing this gate has caught, and the reason it stood red from
`be8e184` (2026-09-03) until this entry. It had already been red for three
nights before that, for a different reason — a TIMEOUT with no lessons at
all — and that cleared in the same nightly window as this arrived, so the
nightly of 2026-09-04 went straight from one failure to the other. `be8e184`
narrowed `_lunch_group_ids` to read the payload's `groups` and nothing else —
right, and for a good reason: once the gateway fills that list it names the
home classes, and unioning the lesson-carrying groups in on top reserved
thirty minutes on every teaching group's day for a meal nobody takes there.

What went with it was the case where the list is *absent*. `groups` is
optional so the engine can ship ahead of the gateway that fills it, and the
schema states what is owed meanwhile, beside the field: the free-window
guarantee still reaches every group with requirements. Read as "the payload's
groups, full stop", such a payload built **not one lunch interval** — 0 where
80 were due for the benchmark's 16 classes over 5 days — and the solver
returned a timetable taught edge to edge through 11:00–13:00, with an empty
`lunches` list and a confident FEASIBLE over the top of it. Between 55 and 64
group-days with nowhere to eat on each night's runner (53 and 69 on two local
runs), on a school that had asked for lunch.

Not only the benchmark: the gateway derives `groups` from the läsår's groups
of `kind: 'CLASS'`, so a school that has entered only teaching groups sends an
empty list with a full timplan and reached the same silence.

This is exactly the failure mode the validator exists for — CP-SAT reported
FEASIBLE for the model it was given, and the model had no lunch in it. No
engine test could see it: every test in `test_optimize.py` that solved with a
lunch window named its class, one of them after a stretch of flakiness that
was the same bug in miniature. The fix is one line — the payload's `groups`
when it has any, the groups with lessons when it has none. The tests beside it
hold both halves of that rule in three places — the solver, the timeout
diagnosis and the validator — each once with no `groups` sent on purpose and
once with a named list taken at its word.

A sibling change read the same red gate from the other side of the seam and
reached the opposite rule for the absent list: it made the benchmark name its
sixteen classes, and the checker owe lunch to nobody when a request names
nobody. The two agreed about a named list and contradicted each other about
an absent one, and the schema had already decided which was right — the
comment beside `groups` promises the guarantee to every group with
requirements. So they landed together under that one rule. The benchmark
names its classes, which is what the gateway sends for a school that has
entered them and what the nightly gate now exercises; the checker reads who
eats exactly as the engine does. For this school the two readings are the same
set, and the gate command passes both ways — with the payload as built, and
with `groups` stripped so that the fallback is what is solved and checked.

The checker stopped skipping rows in the same change. Availability windows are
folded onto the grid rather than parsed strictly, so the product's own
00:00–23:59 closure is enforced instead of raising and being passed over; a
row with no weekday reaches every teaching day; a GRADE_LEVEL reservation
reaches every group whose years overlap it; and a STUDENT_GROUP row covering
the whole lunch window excuses that class from lunch that day, as it does in
the engine.

### Schemaförslag: four emphases, four timetables — at one budget

A schemaförslag run asks for two to four candidates of the year's week, each a
few `ObjectiveWeights` overrides and a seed on top of the school's request,
every one warm-started from the current draft. Whether "Färre håltimmar för
lärarna" has fewer håltimmar than "Behåll mest" is a measurement, and the
design set its bar: each non-KEEP candidate's share of the draft's lessons
moved differs from KEEP's by at least **3 percentage points**, TEACHER_GAPS
leaves the teachers **fewer idle minutes** than KEEP (per teacher and day, the
minutes between the first lesson's start and the last one's end not spent
teaching), and SPREAD's week is **more even** (per class, the variance of its
lessons per weekday). `benchmarks/candidate_variants.py` runs the procedure
on the bench school (`solve_2000_students.py`: 720 lessons at 500 pupils,
1,440 at 1,000). A cold solve on the engine's own weights is the draft (120 s
and 300 s); its lessons go back as `previousLessons`, and each variant is sent
a `search` of four workers, the probes on the first call only. The design's
procedure, measured first, sent KEEP no `maxSeconds` and every later
candidate 30; the gateway as shipped sends every candidate the same
`maxSeconds` (below). Every candidate came back FEASIBLE and passed
`validate_schedule.py`.

**The clock is CPU time, not the wall.** The host's load average was 90–470
through every run, so a thirty-second wall budget measured the neighbours.
`--cpu-clock` stops each CP-SAT solve when its process has spent
`limit × workers` CPU-seconds and reads the solver's own deadline off the same
count, so the seconds here (30.4–31.1 per candidate, 60.4–61.0 for a
sixty-second KEEP) are what the work takes on a host with those cores to
itself; the real wall time was 50–540 s a candidate. CP-SAT on four workers is
not deterministic, so a row is a distribution: means, ranges in brackets.

**First, a candidate came back worse than its draft.** Phase 2's hint was
phase 1's timetable alone, and CP-SAT completed the objective's own variables
by search, so the local search started from a broken objective: 16,274 for the
draft's own lessons, which had scored 825 when the draft was solved. At 500
pupils TEACHER_GAPS returned **6,840** minutes of håltimmar (the compare
page's figure, `web/lib/gaps.ts`) against the draft's 930, SPREAD 2,970 and
FREE 15,390; at 1,000 no candidate's phase 2 found anything in its thirty
seconds, and two of the three came back as the draft unchanged. A request that
carries `search` now completes the hint first with the timetable held
(`SchedulerSolver._complete_the_hint`, under half a CPU-second here): the same
candidates gave 390, 330 and 240 at 500 pupils and a timetable of their own at
1,000. Generera sends no `search` and is solved as before.

**At the design's budgets TEACHER_GAPS fails, and none of four retunes fixes
it.** The design sent KEEP no `maxSeconds`, so it got the engine's sixty
seconds against the others' thirty. Over every run, a thirty-second TEACHER_GAPS averaged 2,120
idle minutes at 500 pupils (seven runs) and 29,930 at 1,000 (four) against a
sixty-second KEEP's 1,880 and 28,340 (three each), and at 1,000 its 7.3 %
moved was within 1.4 points of KEEP's 5.9 %. Four retunes — disruption 0 and
1 at teacherGap 8, the first again with spread 0, teacherGap 30 at disruption
2, one run each — each left more idle minutes than the sixty-second KEEP of
its run at both sizes (1,950–2,580 against 1,920; 31,200–32,760 against
28,980), and three of
them moved within a point of it at 1,000. The budget buys CPU: a 1,000-pupil
KEEP on every core for thirty seconds (29,160) lands within 3 % of one on four
cores for sixty (28,340). The comparison is fair only at one budget.

**At one budget the design's table passes.** Every candidate, KEEP included,
at `maxSeconds` 30 and four workers; six runs of KEEP and TEACHER_GAPS at 500
pupils, three of everything else:

| 500 pupils | moved % | apart from KEEP % | teacher idle min | håltimmar | day variance | same-day pairs |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| draft | — | — | 3,180 | 930 | 0.76 | 35 |
| KEEP | 1.2 [0.4–1.7] | — | 2,490 [2,100–2,760] | 605 | 0.78 | 38 |
| TEACHER_GAPS | 6.7 [4.6–8.8] | 6.7 | **2,080** [1,320–2,640] | 365 | 0.68 | 30 |
| SPREAD | 6.3 [5.0–8.3] | 6.3 | 2,070 | 440 | **0.69** [0.62–0.72] | 25 |
| FREE | 45.8 [41.5–51.1] | 45.9 | 1,950 | 310 | 0.70 | 16 |

| 1,000 pupils | moved % | apart from KEEP % | teacher idle min | håltimmar | day variance | same-day pairs |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| draft | — | — | 34,920 | 21,840 | 1.41 | 606 |
| KEEP | 1.9 [1.7–2.4] | — | 32,440 [32,370–32,490] | 20,010 | 1.33 | 600 |
| TEACHER_GAPS | 7.8 [6.2–10.0] | 8.0 | **29,190** [28,230–30,450] | 17,370 | 1.11 | 565 |
| SPREAD | 16.1 [11.3–19.7] | 17.5 | 38,380 | 24,890 | **0.94** [0.80–1.09] | 507 |
| FREE | 12.0 [6.4–15.6] | 13.5 | 36,920 | 23,930 | 1.15 | 560 |

Run by run, against the KEEP of the same run: all 21 moved-% margins clear 3
points (the narrowest 3.3, SPREAD at 500); SPREAD is the more even week, with
fewer same-day pairs, in 6 of 6; TEACHER_GAPS has fewer idle minutes in
**8 of 9**. The miss is at 500 pupils, 2,640 against 2,100: that draft has 930
håltimmar left in the whole school's week, and the spread between runs is as
wide as the effect. No two candidates of a run came within 4.6 % of each
other, so none would be stored as `sameAs`. Sixty seconds each (one run per
size) passes too, by more: TEACHER_GAPS 1,350 against 2,010 and 24,450 against
26,700. A teacherGap of 16 (three runs at 500) gave 1,960 idle minutes, inside
the spread of the table's 8, so the table stays as designed. The seeds do not
separate the first two: CP-SAT's default `random_seed` is 1, TEACHER_GAPS'
seed, so KEEP and TEACHER_GAPS differ by their weights alone.

So the table is the design's — KEEP no overrides and no seed; TEACHER_GAPS
disruption 2, teacherGap 8, seed 1; SPREAD disruption 2, spread 9, seed 2;
FREE disruption 0, seed 3 — and **every candidate, KEEP included, is sent the
same `maxSeconds`**, `CANDIDATE_MAX_SECONDS` (`searchFor` in
`src/optimization/candidate-variants.ts`), which is what the gateway does.

**Four workers cost what they withhold.** KEEP's teacher idle minutes on four
workers and on every core of the 8-core host, the number of runs in
parentheses:

| KEEP | 500, 30 s | 500, 60 s | 1,000, 30 s | 1,000, 60 s |
| :--- | ---: | ---: | ---: | ---: |
| 4 workers | 2,490 (6) | 1,880 (3) | 32,440 (3) | 28,340 (3) |
| every core | 1,770 (2) | 1,470 (1) | 29,160 (2) | 21,240 (1) |

At 1,000 pupils every core for sixty seconds leaves a quarter fewer idle
minutes than four, and every core for thirty comes within 3 % of four for
sixty. The cap is the price of two runs and a Generera sharing one machine.

Caveats: one bench school and one draft, the benchmark's own optimised solve,
so at 500 pupils there is little left to remove. The CPU clock flatters a
solve slightly — presolve runs on one thread and is counted as if on all of
them — and under this load the four workers did not get equal shares. The
candidates' wall-clock behaviour on an idle host is not measured here.

### Schemaförslag after Lärarens dag: thirty seconds still holds

The thirty seconds above were chosen before Lärarens dag (#160) gave the
solver teachers' daily caps, posts with a number of days and wished free days,
and day limits make the search harder: to a first timetable, cold, one seed in
three was still searching at 240 s on the posts alone (the comment above the
days probe in `scheduler_solver.py`). So the candidate budget was measured
again on the högstadium week (`benchmarks/hogstadium.py`: 450 pupils, 26
teachers, 423 lessons, språkval and elevens val in blocks), without and with
`--teacher-day-rules` (three caps, three posts, five wished free days, each
binding and none impossible), on 2026-10-20 and 2026-10-23 at main ea5bad52,
whose engine is the engine of b6a5c21a.

THE PROCEDURE is the gateway's. The draft is Generera's solve of the week, on
the engine's weights, sixty seconds on every core and no `search`. It is
FEASIBLE with 423 of 423 lessons and valid both ways:

- without the rules: objective 462, 510 håltimmar;
- with the rules: objective 1,052, 1,620 håltimmar, 4 of 5 wishes kept.

Phase 1a took 10.2 s and 8.9 s cold. Each candidate is the week with the
draft's lessons as `previousLessons`, the variant's overrides and seed, and
the gateway's `search`: `maxSeconds` 30, four workers, the probes on KEEP
only. The engine is configured as production (SOLVER_MAX_TIME_SECONDS 60,
probe 20). Three arms:

- **off**: no rules, and the draft without them;
- **on**: the rules, and the draft solved with them;
- **late**: the rules, warm-started from the draft without them. This is a
  school that sets caps, days and wishes after Generera has written its
  timetable and then asks for förslag.

The arms run in pairs: per repetition and variant, the two arms of a round
start at the same moment with four workers each on the 8-core Mac, three
repetitions a round. The driver was a scratch wrapper around
`SchedulerSolver.solve` that times each stage and reuses
`candidate_variants.py`'s metrics and its `_CpuClock`. That benchmark builds
only the bench school, so the command is not in the repository.

**Every candidate is applicable.** 120 of 120 candidates came back with phase
2's timetable, FEASIBLE or OPTIMAL, and every one valid under
`validate_schedule.py`, which checks the caps and the posts:

- at 30 s: 48 on the wall clock and 48 on the CPU clock;
- at 60 s: 24 on the CPU clock, where the three FREE candidates without the
  rules were OPTIMAL.

None returned phase 1's fallback, none timed out, and none came near its
deadline.

**Where the thirty seconds go.** Wall clock, load 14–54, mean [range] over
all four variants:

| 30 s, wall clock | off (12) | on (24) | late (12) |
| :--- | ---: | ---: | ---: |
| validation and lunch stage | 0.02 | 0.02 | 0.02 |
| the two model builds | 0.24 | 0.27 | 0.26 |
| phase 1a, warm | 2.45 [2.23–2.97] | 2.54 [2.27–3.15] | 2.60 [2.47–3.13] |
| `_complete_the_hint`: its solve / the whole step | 0.07 / 0.14 | 0.06 / 0.13 | 0.06 / 0.13 |
| phase 2 | 27.4 | 27.3 | 27.3 |
| the call | 30.29 [30.25–30.38] | 30.32 [30.28–30.41] | 30.32 [30.28–30.33] |

- **The rules cost almost nothing per call.** Lärarens dag adds 0.1 s to phase
  1 and 0.03 s to the builds. A draft that breaks the rules is repaired in the
  same 2.6 s.
- **The cold search never reaches a candidate.** That is the search day limits
  make hard. A run refuses without a draft (CANDIDATES_NEED_A_DRAFT), and the
  draft's lessons are hinted into phase 1.
- **A call costs 0.3 s beyond its budget.** The engine's own ceiling is the
  budget plus 30 s, and the gateway's is the budget plus 45 s, plus 20 s for
  the lead.

**The lead's probe split.** The probe runs only after a TIMEOUT, which no
candidate reached. So it was called directly, on the lead's request and under
the lead's scoped settings (probe = min(20, `maxSeconds`/2)), on the CPU clock:

| lead's probe | relaxations | slice | cost, idle-host s |
| :--- | :--- | ---: | ---: |
| off, `maxSeconds` 30 | blocks, lunch | 7.5 s | 9.2 |
| on, `maxSeconds` 30 | blocks, the posts' days, the caps, lunch | 3.75 s | 13.5 |
| off, `maxSeconds` 60 | blocks, lunch | 10 s | 11.6 |
| on, `maxSeconds` 60 | blocks, the posts' days, the caps, lunch | 5 s | 17.3 |

- **The time fits.** A lead that times out at thirty answers in about
  30 + 13.5 + 0.3 ≈ 44 s, inside the engine's sixty and the gateway's
  ninety-five.
- **The split costs the answer instead.** This week has a timetable, yet in
  every probe only the lunch relaxation found one inside its slice. The
  slices without the blocks, the posts' days or the caps ran out, because a
  slice of 3.75 s is less than this week's cold first timetable.
- **So on a school this size a TIMEOUT is unlikely to name a post or a cap.**
  A probe can only name a rule whose relaxed week it solves within its
  slice, and a week without its post is about this week.

**On a full four cores the emphases still do what their labels say.** The
table is on the CPU clock: each solve stops at `limit × workers`
CPU-seconds, the seconds an idle four-core host takes, at load 40–270. With
the rules, it holds six runs (two rounds paired with off and with late), and
three otherwise:

| 30 s, CPU clock | moved % | apart from KEEP % | håltimmar | teacher idle min | day variance | same-day pairs | wishes kept |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| off: draft | — | — | 510 | 870 | 0.643 | 2 | — |
| off: KEEP | 2.9 [1.9–3.5] | — | 160 [120–240] | 390 | 0.629 | 3 | — |
| off: TEACHER_GAPS | 12.5 [12.1–12.8] | 13.0 | **40** [0–60] | 90 | 0.605 | 4 | — |
| off: SPREAD | 11.6 [10.6–12.5] | 12.1 | 10 | 60 | **0.557** | **1** | — |
| off: FREE | 73.1 | 73.0 | 0 | 0 | 0.468 | 0 | — |
| on: draft | — | — | 1,620 | 2,100 | 0.668 | 14 | 4 of 5 |
| on: KEEP | 3.5 [3.1–4.5] | — | 1,320 [1,260–1,380] | 1,685 | 0.636 | 15 | 5.0 |
| on: TEACHER_GAPS | 16.3 [14.2–18.7] | 16.8 | **900** [810–1,050] | 1,175 | 0.578 | 13 | 4.8 |
| on: SPREAD | 12.7 [7.8–16.3] | 12.7 | 1,095 | 1,385 | **0.595** | **7** | 5.0 |
| on: FREE | 72.9 | 72.8 | 485 | 680 | 0.606 | 6 | 5.0 |

Run by run, against the KEEP of the same run:

- **Moved %.** Every non-KEEP margin clears 3 points: 9 of 9 without the
  rules, 18 of 18 with them.
- **TEACHER_GAPS.** It leaves fewer håltimmar and fewer idle minutes than KEEP
  in 3 of 3 runs without the rules and 6 of 6 with them.
- **SPREAD.** It has fewer same-day pairs in 3 of 3 and 6 of 6, and the lower
  day variance in 3 of 3 and 5 of 6.

**The comparison needs CPU, not more clock.** On the wall-clock rounds the
host gave each candidate about 77 CPU-seconds [65–83], two and a half of its
four cores. There "Färre håltimmar för lärarna" still beat KEEP in 3 of 3 runs
without the rules, but in only 2 of 6 with them (4 of 6 on idle minutes). With
the rules, each emphasis needs more search to pull away from the draft than
without. Sixty seconds on the CPU clock (three runs each) is not the fix:

| 60 s, CPU clock | moved % | apart from KEEP % | håltimmar | teacher idle min | day variance | same-day pairs | objective |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| off: KEEP | 4.3 [4.0–4.5] | — | 70 [60–90] | 210 | 0.635 | 3 | 321 |
| off: TEACHER_GAPS | 13.6 | 13.9 | **0** | 0 | 0.588 | 2 | 171 |
| off: SPREAD | 11.9 | 12.7 | 0 | 20 | **0.557** | **0** | 176 |
| off: FREE | 72.5 | 72.5 | 0 | 0 | 0.504 | 0 | 0 |
| on: KEEP | 6.5 [4.5–8.5] | — | 900 [600–1,200] | 1,220 | 0.638 | 17 | 842 |
| on: TEACHER_GAPS | 19.7 | 20.4 | **750** [360–1,050] | 940 | 0.579 | 13 | 1,791 |
| on: SPREAD | 17.6 | 18.7 | 800 | 1,030 | **0.599** | **6** | 705 |
| on: FREE | 81.8 | 82.3 | 150 [0–450] | 200 | 0.490 | 2 | 97 |

What sixty seconds changes:

- **Every candidate improves.** KEEP's objective falls 10 % both ways, and
  TEACHER_GAPS' falls 18 % with the rules.
- **KEEP improves as much as the emphases.** With the rules, KEEP goes from
  1,320 to 900 håltimmar and TEACHER_GAPS from 900 to 750, and TEACHER_GAPS
  beats KEEP in 2 of 3 runs.
- **Every run costs twice as long.** Three candidates take 91 s at thirty and
  181 s at sixty.
- **The rules make the week look worse; they do not make it unsolvable.**
  FREE gets the week with the rules down to 150 håltimmar. The candidates
  that are held near a draft of 1,620 håltimmar keep most of them.

**From a draft without the rules** (the late arm, CPU clock, three runs):

- **Every candidate is applicable and valid.** But KEEP has to move 17.7 %
  [16.8–18.2] of the draft to honour the rules.
- **The emphases separate less.** TEACHER_GAPS beats KEEP on håltimmar in 2 of
  3 runs (1,880 against 1,730 on average, KEEP ranging 1,020–2,160), and on
  the wall clock in 1 of 3. SPREAD's margins hold in 3 of 3.
- **Fewer wishes are kept.** Every emphasis keeps 3 of the 5 wishes (FREE
  2.7). From a draft that honours them the candidates keep 4.7–5 of 5, and
  the same week's cold Generera keeps 4.
- **Sixty seconds was not measured on this arm.** So whether it buys the
  wishes back is open. A school that sets wishes after its timetable exists
  gets fewer of them from a förslag run than from a fresh Generera.

**So `CANDIDATE_MAX_SECONDS` stays at 30.**

- **The status holds.** Every candidate is applicable at thirty with the rules
  on, in every arm.
- **The overhead is small.** The time beyond the budget is 0.3 s, and the
  lead's worst case stays inside both deadlines.
- **The emphases hold.** On a full four cores each one does what its label
  says.
- **What moves the comparison under the rules is the CPU a candidate gets.**
  At 77 CPU-seconds TEACHER_GAPS beat KEEP in 2 of 6 runs, at 120 in 6 of 6,
  and at 240 KEEP had closed in (2 of 3).
- **A longer default would not help.** It would not buy back what a starved
  host withholds as surely as it doubles every run, and on an idle host it
  lets KEEP catch up.
- **The figure to watch is the cores a candidate gets on Railway.** That is
  `CANDIDATE_SOLVER_WORKERS` and the engine's real cores, not the budget.

A default above sixty would also not be what it says. The gateway accepts
`CANDIDATE_MAX_SECONDS` up to 120. The engine caps a request's `maxSeconds` at
its own SOLVER_MAX_TIME_SECONDS (`settings_for_search`: only ever smaller),
which is 60 by default. Meanwhile the gateway's call timeout and lease are
computed from the uncapped figure.

Caveats: one school and one draft per arm, three runs a row. The host has six
performance and two efficiency cores, and nothing kept the two arms of a
pair on the same kind. The CPU clock flatters presolve, as above. The
wall-clock rounds were at load 14–54 rather than idle, and that is what the
77 CPU-seconds describe. The sixty-second wall-clock round was dropped: by
then load was 150–240, and its candidates got 93–144 CPU-seconds, hardly more
than the thirty-second rounds' 77.

### Elevernas håltimmar: what the rule costs and buys

Measured on 2026-10-30 on branch claude/elevernas-haltimmar (main 228f956d
below it) with `benchmarks/pupil_gaps.py`: the högstadium week
(`benchmarks/hogstadium.py`, 450 pupils in 90 cohorts, 423 lessons, språkval
and elevens val) solved with the rule off and on at the same moment, in two
processes, on the shared 8-core Mac at load 58–107. Every number is per run;
the pupils' and the teachers' minutes are counted the same way for both arms
(`pupil_idle_minutes` on the cohorts, and the same day rule for each teacher).

THE MODEL. The rule adds 4,395 variables to the full model (9,759 → 14,154)
and 9,126 constraints (26,470 → 35,596), and its build goes from 0.14–0.26 s
to 0.26–0.50 s. The satisfaction model phase 1a solves is the SAME model
either way, sha256 of its proto equal with and without `pupilGaps`, with and
without blocks: so the rule moves the time to a first timetable by the
full model's extra build only (it is made before phase 1 starts), a quarter of
a second here. Phase 1a's first-solution times on the same model varied 8–64 s
between runs at this load, which is the machine and not the rule. Phase 1b,
the cleared clone, carries the extra variables free; it runs only when 1a
finds nothing, which these weeks never needed.

THE SOLVE, 90 s, idle pupil-minutes in an ordinary week (teachers' minutes):

| Week | Rule off | Rule on | Pupils | Teachers |
|---|---|---|---|---|
| with blocks, run 1 | 110,250 (3,300) | 107,250 (3,450) | −2.7 % | +4.5 % |
| with blocks, run 2 | 138,750 (3,150) | 117,750 (3,510) | −15.1 % | +11.4 % |
| without blocks, run 1 | 182,550 (6,390) | 120,900 (6,360) | −33.8 % | −0.5 % |
| without blocks, run 2 | 181,050 (6,150) | 149,700 (7,440) | −17.3 % | +21.0 % |

With blocks the språkval and elevens val already take one slot of every
class's week each, so the cohorts' days are their classes' and the rule has
little left to close; without them the generator chooses where every
språkval and elevens val hour goes, and the rule is what keeps them at the
edge of the pupils' day. The teachers pay for it in some runs and not in
others: a class's whole håltimme weighs two teachers' (WEIGHT_PUPIL_GAP 4
against a teacher's 2, the rest scaled by 25), and phase 2 trades them
inside its 80 seconds. Both arms were FEASIBLE with 423 of 423 lessons in
every run; the numbers move a lot between runs at this load, so the
direction is the finding and not the percentage.

AT 2,000 PUPILS (`solve_2000_students.py`, home classes only, one cohort
per class: 80): the full model goes from 63,714 to 80,514 variables (+26 %)
and 171,823 to 208,383 constraints, and the satisfaction model is again the
same proto with and without the rule. The term's own build was 2.6 s of a
9.4 s full build at load 114 (the full build without it 7.5 s at load 140), of
which `_day_reach` was most: on a stepped week every start is an interval of
its own. The term now reads one hull per day instead, the same days and never
narrower, and builds the same 80,514 variables in 2.2 s at load 99. So the
rule adds about a third to the full model's build, which is made before phase 1
starts: on the way to a first timetable at 2,000 pupils that is seconds under
this load, never the search itself, whose model it does not touch. The
2,000-pupil week was measured for its model and its build only, not solved
in pairs: at a load where the högstadium's phase 1a took up to 64 s, a
90-second pair there would have measured the machine.

THE TERM AGAINST THE COUNT, on the review's two random corpora
(`solve_loop.py`, 266 schools of one or two classes: halves with pupils
placed and in neither, SvA and Fd, språkval across years, idrott with ombyte
and dusch, locks and pupils named on them, closed time, ramtider and lunch;
the second corpus adds locked half rotations, locks on two classes and a
locked svenska beside SvA). Every school was solved with the rule off and on
at 4 s, and every timetable pinned in the full model with the rule on: the
term at that week against a count by the term's own rules (no minimum hole,
the placed lunch, no margins on locks). On 0c35f998 the term added each
lock's whole length whatever it overlapped, and differed in 7 of 298 and 81
of 234 weeks, all but one under. At seed-5056, nine pupils in neither half
with the halves' slöjd locked together, it saw no hole where there were 675
pupil-minutes, and the rule on doubled the school's 335. With a cohort's
locks and closed time merged into one union of windows per day, each slot
once against the lessons beside it, the term is that count in all 532 weeks
with the lunch left out of both. With the lunch it differs in 3 and 6 weeks,
5–35 minutes under, each where the class's placed lunch overlaps a dusch or
a lock of another of the pupils' groups: the term credits the lunch whole.
Where both arms were OPTIMAL (137 and 91 schools) the rule on was worse than
off in none, by the count or by the term's own rules, and the engine's count
and the response's were the review's own per-pupil count on every timetable.
The benchmark schools have no locks in a cohort and no closed time inside a
day, and build the same 14,154 and 80,514 variables as before.

ODD AND EVEN WEEKS, since main's A/B-veckor (#221) gave the engine both. A
cohort whose day has a lesson or a lock on alternate weeks gets that day once
per week, of what runs in it, so slöjd odd and hemkunskap even at one hour are
the hour once in each week and never two hours in one. Its terms are the two
weeks' sum; in such a school every other cohort's day counts twice and the
rest of the objective is multiplied by 50 rather than 25, so every term weighs
the ordinary week the report counts, half of each. A school without
alternating lessons builds exactly the model it built before. The count does
the same in halves, so `pupilIdleMinutes` is a number and can end in .5: an
odd-week hole of 15 minutes is 7.5 minutes of an ordinary week, as the
report's weekShare has it. The fixture's three alternating cases are
replayed by the report, the gateway and the engine.

A COMPLETE HINT FOR PHASE 2 was tried and is not in this change. Phase 2
is hinted with phase 1's lessons and rooms only; the term's first and last
per key, cohort and day are left to CP-SAT's completion, as every other
objective variable of a Generera is (`_complete_the_hint` runs for a
schemaförslag alone). Solved deterministically (one worker, seed 0, 40
deterministic seconds a solve, `model_identity.py`'s patch), the same week
with the rule on ended phase 2 at an objective of 333,150 with blocks and
345,045 without on the partial hint, and at 221,250 and 225,795 on a complete
one, with the SAME lessons in all four: the partial hint's budget went on
repairing the term's variables. Whether that buys pupils' minutes needs a
multi-worker measurement, and the wall-clock pair tried here timed out on
both arms at load 99–107 (phase 1a, the same model on both). Until then a
Generera solves exactly as the table above measured it.


### Sammanhängande undervisning: a hard rule that cost too much, and a wish that works

Measured on 2026-11-01 and 2026-11-02 on branch claude/sammanhangande-undervisning-b67a95
(main 1d593496 and later below it) with `benchmarks/consecutive_teaching.py`: the
högstadium week (`benchmarks/hogstadium.py`, 450 pupils, 26 teachers, 423 lessons,
språkval and elevens val) and the nightly gate's bench school (400 pupils, 576 lessons),
the eight busiest teachers limited to *A* = 180 minutes in a row then 30 free, or *B* =
180 then 15, solved with the limit off and on at the same moment in two processes of
eight workers, on the shared 8-core Mac at load 6–35 (the first run of the wish
measured at load 45–115 and is not used). "Over the limit" is counted by
`validate_schedule.stretch_breaches` and by the harness's own spans, independent of the
engine's model. The rule a hard constraint (the prototype, measured first, dropped):

| Hard rule, A (180/30), 8 flagged | off (main) | on |
|---|---|---|
| first solution, three pairs | 16.96 / 8.24 / 8.42 s | 17.83 / 27.47 / 84.52 s |
| first solution, B (180/15) | 8.31 / 8.10 / 8.72 s | 11.23 / 12.41 / 27.43 s |
| full solve, 90 s, three pairs | FEASIBLE 423/423 VALID ×3 | TIMEOUT, 0/423 ×3 |

Every second of it was the disjunctive rows that keep a floating break clear of the
teacher's lessons: with the same variables and no no-overlap the time was main's, a
rule that hardly bound cost as much as one that did, and pair-links between the breaks,
a single cumulative per teacher and solver parameters did not help. So the generator
treats the limit as a wish (`consecutive.py`): the full model's objective pays for each
generated lesson whose stretch is not ended by a break in time, and the satisfaction
model, which phase 1a solves, is byte for byte main's (the model files exported with
and without a flagged teacher are equal, `test_consecutive.py`), so the time to a first
timetable is main's by construction:

| First solution, satisfaction model | off | on A | off | on B |
|---|---|---|---|---|
| three pairs | 10.21 / 10.05 / 20.35 s | 10.32 / 17.07 / 17.92 s | 22.95 / 10.02 / 25.74 s | 22.83 / 16.19 / 20.68 s |
| variables / rows | 6,735 / 17,094 | 6,735 / 17,094 | 6,735 / 17,094 | 6,735 / 17,094 |

The full model grows from 9,759 variables and 26,470 rows to 10,233 and 27,418 (eight
teachers); `_estimate_model_size` says 12,085, an upper bound as it must be.

THE SOLVE, 90 s, at the final weight (250 a lesson), three pairs each, head ffd4eea7.
Cells are teachers over the limit of the eight (teachers' idle minutes, all 26 teachers):

| Week | Rule off | Rule on |
|---|---|---|
| högstadiet, A, pairs 1–3 | 8 (4,500), 8 (6,660), 7 (5,130) | 1 (7,200), 0 (7,170), 1 (4,230) |
| högstadiet, B, pairs 1–3 | 7 (2,850), 8 (3,150), 8 (8,340) | 0 (4,770), 3 (3,840), 2 (4,710) |
| bench school, A, pairs 1–3 | 5 (13,680), 5 (13,020), 6 (11,730) | 1 (13,560), 1 (14,550), 2 (11,010) |

Every run FEASIBLE with every lesson placed (423/423 and 576/576) and no problem from
the independent validator, on both arms. The idle minutes move as much between runs of
one arm as between arms, so what the wish costs the other terms is inside the noise of
this host; a break is a gap and a teacher kept from a long stretch waits somewhere
instead, which is what the weight pays for.

WHICH WEIGHT, and what that took. The wish's price was first 40, the free-day wish's.
At 40, three pairs each on the same head: A left 5, 6, 3 of the eight over the limit
(off 8, 7, 8), B 7, 3, 3 (off 7, 8, 7), the bench school 1, 0, 0 (off 4, 3, 5), which
failed the criterion written in the pull request beforehand (at most two of the eight
in every pair where three or more were over in the off arm). Other runs at 40 gave
3, 2, 0, 2 and 2, 1, 6, 5 (A, four pairs each); with three teachers flagged (the
realistic case) four pairs left 2, 1, 2, 1 of three over where off had 3, 3, 3, 3. At 100
(four runs) 2, 3, 6, 4 and at 250 (eight runs) 0, 0, 3, 5 and 5, 1, 1, 0: the count at
250 averages 1.9 against 3.2 at 40 (11 runs) and 3.75 at 100, and 7.5 for the school
with the wish off. The weight is not what a break is worth (a half hour of idle time
costs the teacher 12): it is the gradient the search needs in the minute and a half it
has. A single worker and eight seeds shows nothing at any weight (the same timetable
every time), because the improvement comes from the workers that run LNS; the
measurement is eight workers or nothing.

AT 250 THE CRITERION IS MET IN FIVE OF THE SIX HÖGSTADIUM PAIRS and missed in one: the
second B pair leaves three teachers over the limit where the criterion says two. A
limit is therefore *tried*, not kept: one or two of the eight busiest teachers can be
left over it in a minute and a half, and the run's notes name them.

THE ORACLE (`test_consecutive.py`, every placement of one to three lessons in a
four-hour morning, seven cases, 40- and 80-minute lessons on a 30-minute start step,
locks that are already over the limit, two locks ten minutes apart): the model's price
is zero exactly when no stretch with a generated lesson in it is over the limit, and
with nothing locked it is the weight times the number of lessons that begin an
over-long stretch. A break confined to the start step (six values for X = 180 where
thirty-seven are open) is exact when X and Y are whole steps and no lock has an edge
between two steps; paired against the free break at A, four pairs each, the count of
teachers over was 3, 2, 0, 2 against 6, 1, 0, 2 (within the noise of the host), so
the smaller search is kept.

THE REVIEW ROUND (2026-11-02, independent review of PR #231; its own numbers marked
*reviewer*). Three things were added to what is measured above.

Search room (*reviewer*, 60 s = production's `SOLVER_MAX_TIME_SECONDS`, eight workers each,
load 30–85, rule A on the eight busiest, teachers over the limit of eight, off → on):
bench school 5→0, 7→1; högstadium on its own 6→4, 7→6, 6→0; högstadium with the pupils'
idle time and the teacher-day rules also on 5→5, 6→8, 6→7 (and on 120 s 8→7, 6→4);
with the pupils' idle time alone 7→7, 6→5; all 26 teachers flagged with both on 5→6, 4→7,
7→6, 8→5, 6→5. The wish works where the search has room and does nothing measurable when
the pupils' idle time is on beside it; the 0–3 of 8 above is the högstadium without
those switches, on 90 s. The same arm run twice gave pupil idle time of 53 000–163 000
minutes, so the cost columns of that run are direction and not measure.

The rerun case, which the review asked to be measured and was only counted before (a school
that has a timetable turns the switch on and generates again with it as `previousLessons`;
`--mode rerun`; criterion written before the run: R1 both arms FEASIBLE 423/423 with an
empty validator, R2 the wish leaves at most four of eight over where the timetable had at
least five, R3 reported with no requirement): the högstadium solved first as it is
(FEASIBLE 423/423, **8 of 8** over rule A), then three pairs of 60 s, eight workers each,
started together, load 22–66. Teachers over / previous slots no lesson of the same
requirement holds any more / teachers' idle minutes, off → on: 8 / 7 / 450 → **1** / 139 / 2 940;
8 / 44 / 600 → **3** / 186 / 3 420; 8 / 16 / 390 → **0** / 93 / 2 610. R1 and R2 met. R3: the wish
moved 139, 186 and 93 of 423 slots (33 %, 44 %, 22 %) where leaving it off moved 7, 44 and
16, so switching it on in the middle of a term and generating again rearranges a fifth to
nearly half of the timetable, not only the flagged teachers' lessons, and the teachers'
idle time rises to the range a fresh generation on today's model gives (2 850–8 340) from
the lower level the previous timetable had. The sample is three pairs on a loaded host.

The reviewer's mutants against the tests: the engine's fourteen (E01–E14): nine killed,
including the five the first tests missed (E05 no night shift, E01 X + 5, E10 the lattice
of starts ignoring Y, E12 locks exactly Y apart, E13 locked stretches merged over the
night), five survive and are equivalent (E02, E03, E09, E11, E14); the gateway's thirty-one
plus six more clauses of `holdsOnlyAConsecutiveLimit` (37): 34 killed, S05 and T06
equivalent, C05 equivalent in practice (`ON_LESSON` stops first); the trigger's T6 (the
write question asked as a read) killed by the new rows of RLS section 288. The two cases
that must never be priced (locks exactly Y apart, an odd and an even week's lessons) have
a test of their own, since the other cases require that something is priced.

### Corrections to earlier entries in this document

- An earlier revision said the complexity guard was "pessimistic … not the
  solver's actual capability", implying the solver could hit the target if
  allowed. Lifting the guard disproves that: 0 of 2,880 lessons in 291s.
- `_add_capacity_constraints` skipping the constraint when no room is eligible
  (`if not allowed_indices: continue`) was reported here as a silent-corruption
  bug. It is not: `_validate_request` (`:186-195`) rejects such a payload
  upfront with a specific message, so that branch is unreachable defensive code.
- "Adding the objective destroys the model" is too simple. On the production
  encoding an objective *helps*, because it unlocks CP-SAT's scheduling LNS
  subsolvers; on the fixed encoding it *hurts* at 500 students, where pure
  satisfaction reaches OPTIMAL and the optimising model finds nothing. Both were
  measured. The unifying explanation is the missing margin, not the objective.

## Security & accessibility

| Metric | Target | Measured | Status |
| :--- | :--- | :--- | :--- |
| RLS / tenancy policies | no cross-tenant leak | **all assertions pass** | ✓ |
| API dependency audit | 0 critical/high/moderate | **0 / 0 / 0** | ✓ |
| Mobile dependency audit | 0 critical/high/moderate | **0 failing** (12 suppressed — zod has no patch in range, the rest are fixes that are a new major or younger than the seven-day rule; build-time-only surface; expiring allowlist; measured 2026-11-01) | ✓ |
| Web dependency audit | 0 critical/high/moderate | **0 / 0 / 0** | ✓ |
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

**All four packages now report 0 / 0 / 0** — the three npm packages and the
solver's Python dependencies.

**The solver's Python chain — resolved.** `pip-audit --strict` reported 11
advisories across two transitively-pinned packages: `starlette 0.41.3` (nine)
and `protobuf 5.26.1` (two). Neither is a direct dependency — they arrive via
`fastapi` and `ortools`, both of which were pinned to exact versions well
behind their parents' current releases.

Clearing all nine starlette advisories needs **≥1.3.1**, which is a major-line
jump from 0.41. It was viable because modern `fastapi` declares
`starlette>=0.46.0` with no upper bound. Verified in a `python:3.12-slim`
container matching CI — 23/23 engine tests pass on starlette 1.4.1 — and again
by rebuilding the production image, which runs `python:3.11-slim`, and
confirming `/health` responds.

One advisory was self-inflicted along the way: an arbitrarily chosen
`pydantic-settings 2.13.0` carried GHSA-4xgf-cpjx-pc3j, caught by re-running
the audit after the first upgrade pass rather than assuming it was done.

**The `jspdf` chain — resolved.** `jspdf` (critical) → `dompurify` (moderate)
and `jspdf-autotable` (high) were the last holdouts, and clearing them meant
two majors: `jspdf` 2 → 4 and `jspdf-autotable` 3 → 5.

Those majors turned out to be **drop-in for this codebase**, which was not
obvious in advance and is the reason it needed verifying rather than merging.
`web/lib/pdf.ts` needed no changes: `autoTable(doc, options)` accepts the same
options shape, and the undocumented `doc.lastAutoTable.finalY` we rely on for
multi-table cursor positioning still exists and still advances correctly.

Verified by generating a real PDF through the exact call sequence
`exportTimetablePdf` uses — three tables, checked `finalY` advanced each time,
and asserted the output carries a `%PDF-` header at a plausible size — then by
a full `next build` to confirm the bundler resolves the new export shape.

Worth recording, because it nearly produced a false alarm: `jspdf-autotable` v5
ships CommonJS with `__esModule: true` and the function on
`module.exports.default`. A bundler honours that marker, so
`(await import("jspdf-autotable")).default` is the function and the app code is
correct. **Node's ESM interop does not** — there the same expression yields
`module.exports`, and the function sits at `.default.default`. A first attempt
at the verification script failed with `autoTable is not a function` and looked
like a broken upgrade; the script was wrong, not the app. Any future Node-side
probe of a browser-only module needs the same care.

Typecheck does not catch this class of problem: `tsc` passed against both the
correct and incorrect interop shapes.

**`next` + `sharp` — resolved.** These were briefly held back. `npm audit fix`
upgrades `next` 16.2.9 → 16.3.0, clearing nine advisories including
GHSA-6gpp-xcg3-4w24, a middleware/proxy bypass specific to App Router apps
using Turbopack with a single locale, which describes this app exactly. But on
16.3.0 with **next-intl 4.13.1** the production build died in page-data
collection with `TypeError: Cannot read properties of undefined (reading
'validationLevel')` — after compilation and typechecking had both passed, and
with no stack frame in application code.

The cause was a version skew, not a Next.js regression: `validationLevel`
appears in `next/dist/server/config-schema.js` only in 16.3.0, so it became a
recognised `next.config` option in that release, and next-intl 4.13.1's plugin
wrapper did not supply it. **next-intl 4.13.3+ does.** The pin is gone; `web`
now runs `next ^16.3.0` with `next-intl ^4.13.5`, the build succeeds, and both
`next` and `sharp` are clear.

Worth keeping in mind for the next upgrade: nothing short of a full `npm run
build` catches this class of failure. Compile and typecheck both pass on the
broken combination.

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

2. **Builds are slow here.** `next build` took 87 minutes to compile plus 10
   minutes of typechecking on this machine, and cold ts-jest compiles take ~100s
   (warm: 1s). One earlier build attempt died with
   `TurbopackInternalError … Operation timed out (os error 60)` — a local
   filesystem timeout, not a source error. Budget accordingly or measure on CI.

3. **Visual baselines are not committed.** They must be generated on the same
   platform CI runs (Linux/Chromium) or every diff fails on font rendering
   alone. Generate them in a Linux container:
   `npm run test:visual:update`, then review the images in the PR.

4. **API latency needs a seeded database.** `api-latency.mjs` calls a run
   invalid when more than 1% of any row's attempts fail (non-2xx answers,
   connection errors, timeouts), so it cannot be satisfied against the mocked
   Prisma layer. `quality-gates.yml` brings up `docker-compose.yml`,
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

Baselines are committed per **platform and CPU architecture** — 32 files, 16
`-darwin-arm64` and 16 `-linux-x64`. CI is configured with
`updateSnapshots: "none"`, so it fails rather than silently writing its own;
that is what makes a missing baseline a failure instead of a free pass.

**What actually decides whether a baseline matches: installed fonts.**
`globals.css` asks for `"Inter", ui-sans-serif, system-ui, -apple-system,
"Segoe UI", …` and Chromium resolves that stack to whatever the machine has.

| Environment | Font families |
| :--- | ---: |
| `mcr.microsoft.com/playwright` image | 29 |
| bare `ubuntu` (what CI's runner starts from) | 3 |

Same OS, same architecture, same browser build — different glyphs, and a
uniform ~1–2% diff on every screenshot that is indistinguishable from a real
regression.

**Generate them on the runner. Nothing else works.** Three local attempts
failed, and the third disproved the first two:

| Attempt | Produced on | Result |
| :--- | :--- | :--- |
| 1 | macOS arm64 | failed on CI |
| 2 | arm64 Linux container (Playwright image) | failed on CI |
| 3 | QEMU-emulated amd64 (Playwright image) | failed on CI with **byte-identical pixel counts to #2** |

That last row is the diagnosis. The attempt-2 and attempt-3 baselines hash
identically, so CPU architecture never affected the output at all — both came
from the Playwright image, and the image's fonts are what differed from CI's.
The `process.arch` suffix in `snapshotPathTemplate` is still worth keeping as
hygiene, but it fixed nothing here.

Each attempt also "verified" green where it was generated, which is worthless:
re-running in the environment that produced the files passes by construction.
The only meaningful verification is a run in the environment that will check
them.

So: run the **Regenerate visual baselines** job in `quality-gates.yml`
(Actions → Quality Gates → Run workflow). It uses ubuntu-latest and
`npx playwright install --with-deps`, exactly as the `web` job does. It
regenerates, re-runs *without* the update flag to prove the files match, and
uploads them as the `visual-baselines-linux-x64` artifact. Download, replace
the `*-linux-x64.png` files, review the images, commit.

A sturdier option, not taken here because it changes how the app looks: ship
Inter as a self-hosted font instead of relying on the system stack. The gate
would then stop depending on the host's font set entirely. That is a design
decision, not a test fix.

The `-darwin-arm64` set stays committed so the gate still works locally on
Apple Silicon; it is never used by CI.

## Known-failing gate, older than the work above

`npm run bench:solver` fails: 11.56 s against a 10 s budget on a 2,000-student
payload. Measured at `4916a39` as well, so it predates the lunch and time-lock
work and is not a regression from it. The benchmark payload carries neither
`groupConflicts` nor `diningSeats`, so it cannot see that work at all — which is
also why it is a poor guard for it. Worth its own investigation, and worth a
payload that exercises what schools actually send.
