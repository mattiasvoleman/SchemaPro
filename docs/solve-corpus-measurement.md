# The solver corpus: the first measurement (2026-11-22)

What a Generera run costs on weeks shaped like real schools, and where it stops finding a timetable. The corpus
and the measuring stick are described in docs/DEPLOYMENT.md §35; the numbers a school reads are in the manual (5.2).
This file is the record of the measurement behind them, so that it can be repeated and compared.

## How it was measured

| | |
|---|---|
| Corpus | `optimization-engine/benchmarks/school_corpus.py` (corpus version 1), the `sweep` profile: 34 weeks, two seeds each, 68 weeks. One axis moves at a time from the base (three subjects in groups across the classes, three classes a year): N classes, G subjects in groups, M shared teachers, term subjects, a språkval block, half groups, and the production school's form. |
| Engine | main at `9a61fbbe` (2026-11-22), CP-SAT from OR-Tools 9.15.6755, Python 3.11 |
| Mode | **count**: one worker, fixed seed, a budget of **4 deterministic seconds a search**, with the solve's two satisfaction searches (phase 1a, then 1b), so at most 8 deterministic seconds of work before a week is a TIMEOUT. The unit of "work" below is CP-SAT's deterministic second: operations counted, the same on every machine. |
| What is timed | From `solve()`'s entry to the first timetable: prechecks, builds and phase 1a (or 1b). Phase 2 (improving a timetable that exists) is left out. |
| Machine | darwin/arm64, 8 cores, shared with other sessions: **load average 4.5 to 119 during the run** (under 12 for the first dozen weeks, above 50 for most of the rest). Count mode's verdicts and work do not depend on the load; its wall-clock seconds do. |
| Run | `corpus_measure.py --profile sweep --mode count --det-budget 4 --jobs 4`, four weeks side by side (about 30 minutes) |

## Seconds

The seconds columns below are **estimates**: the work times 18. Eleven solved weeks were measured when the machine was quiet (load 4.5 to 11.5); one worker took
**18 s per deterministic second** in the median there (8 to 25). At load 50 to 80 the same weeks took 27 to 69 s per deterministic second. So "≈ 18 s per work" is
one core of this machine, quiet, and nothing says what a production core does (§35.5). By the same figure the budget of 4 deterministic seconds a search is about 72 s,
and the two searches of a solve about 144 s, close to the production budget of 180 s: a **timeout** below means "no timetable in about what production gives a run, on one core of this machine".

## What a week was: facts

| Week | Lessons | Group pairs | Shared teachers |
|---|---:|---:|---:|
| 9 classes, three subjects in groups | 207 | 259 | 0 |
| 12 classes, three subjects in groups | 270 | 404 | 0 |
| 18 classes, three subjects in groups | 408 | 903 | 3 |
| 24 classes, every subject by class | 546 | 166 | 3 |
| 9 classes, ten subjects in groups, half groups, terms (production form) | 288 | 2,326 | 0 |
| (the production school, filled) | 877 | 4,493 of 5,000 | 21 |

## The tables

### Classes, three subjects in groups across the classes (N)

| N classes | weeks | timetable | timeout | refused | work median | work p90 | ≈ s median | ≈ s p90 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 6 | 2 | 2 | 0 | 0 | 0.18 | 0.18 | 3.2 | 3.2 |
| 9 | 2 | 2 | 0 | 0 | 0.20 | 0.22 | 3.5 | 3.9 |
| 12 | 2 | 2 | 0 | 0 | 0.37 | 0.43 | 6.7 | 7.8 |
| 15 | 2 | 0 | 2 | 0 | - | - | - | - |
| 18 | 2 | 0 | 2 | 0 | - | - | - | - |

### Classes, every subject by class (no groups across the classes)

| N classes | weeks | timetable | timeout | refused | work median | work p90 | ≈ s median | ≈ s p90 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 6 | 2 | 2 | 0 | 0 | 0.08 | 0.08 | 1.4 | 1.4 |
| 9 | 2 | 2 | 0 | 0 | 0.13 | 0.13 | 2.3 | 2.3 |
| 12 | 2 | 2 | 0 | 0 | 0.33 | 0.33 | 5.9 | 5.9 |
| 18 | 2 | 2 | 0 | 0 | 1.14 | 1.29 | 20.6 | 23.2 |
| 24 | 2 | 2 | 0 | 0 | 0.78 | 0.82 | 14.1 | 14.8 |

### Subjects in groups across the classes (G), 9 classes

| G subjects | weeks | timetable | timeout | refused | work median | work p90 | ≈ s median | ≈ s p90 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 2 | 2 | 0 | 0 | 0.13 | 0.13 | 2.3 | 2.3 |
| 2 | 2 | 2 | 0 | 0 | 0.17 | 0.19 | 3.0 | 3.4 |
| 3 | 2 | 2 | 0 | 0 | 0.20 | 0.22 | 3.5 | 3.9 |
| 4 | 2 | 2 | 0 | 0 | 0.16 | 0.16 | 2.9 | 3.0 |
| 5 | 2 | 1 | 1 | 0 | 0.49 | 0.49 | 8.8 | 8.8 |
| 6 | 2 | 0 | 2 | 0 | - | - | - | - |
| 8 | 2 | 0 | 2 | 0 | - | - | - | - |
| 10 | 2 | 0 | 2 | 0 | - | - | - | - |

### Shared teachers (M), 9 classes, three subjects in groups

| M shared teachers | weeks | timetable | timeout | refused | work median | work p90 | ≈ s median | ≈ s p90 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 2 | 2 | 0 | 0 | 0.20 | 0.22 | 3.5 | 3.9 |
| 2 | 2 | 0 | 2 | 0 | - | - | - | - |
| 4 | 2 | 0 | 0 | 2 | - | - | - | - |
| 8 | 2 | 0 | 0 | 2 | - | - | - | - |

### Subjects in groups across the classes (G), 12 classes

| G subjects | weeks | timetable | timeout | refused | work median | work p90 | ≈ s median | ≈ s p90 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 2 | 2 | 0 | 0 | 0.33 | 0.33 | 5.9 | 5.9 |
| 2 | 2 | 2 | 0 | 0 | 0.30 | 0.38 | 5.4 | 6.9 |
| 3 | 2 | 2 | 0 | 0 | 0.37 | 0.43 | 6.7 | 7.8 |
| 4 | 2 | 1 | 1 | 0 | 0.88 | 0.88 | 15.8 | 15.8 |
| 5 | 2 | 0 | 2 | 0 | - | - | - | - |
| 6 | 2 | 0 | 2 | 0 | - | - | - | - |
| 8 | 2 | 0 | 2 | 0 | - | - | - | - |
| 10 | 2 | 0 | 2 | 0 | - | - | - | - |

### Shared teachers (M), 12 classes, three subjects in groups

| M shared teachers | weeks | timetable | timeout | refused | work median | work p90 | ≈ s median | ≈ s p90 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 2 | 2 | 0 | 0 | 0.37 | 0.43 | 6.7 | 7.8 |
| 2 | 2 | 0 | 2 | 0 | - | - | - | - |
| 4 | 2 | 0 | 0 | 2 | - | - | - | - |
| 8 | 2 | 0 | 0 | 2 | - | - | - | - |

### Term lessons (subjects that run one term only), 12 classes, three subjects in groups

| term subjects | weeks | timetable | timeout | refused | work median | work p90 | ≈ s median | ≈ s p90 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 2 | 2 | 0 | 0 | 0.37 | 0.43 | 6.7 | 7.8 |
| 3 | 2 | 1 | 1 | 0 | 1.94 | 1.94 | 34.9 | 34.9 |
| 5 | 2 | 0 | 2 | 0 | - | - | - | - |

### The production form (ten subjects in groups, half groups, terms, production's frame)

| N classes | weeks | timetable | timeout | refused | work median | work p90 | ≈ s median | ≈ s p90 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 6 | 2 | 0 | 2 | 0 | - | - | - | - |
| 9 | 2 | 0 | 2 | 0 | - | - | - | - |


## What the first measurement found

1. **Classes are not what stops the engine.** Every subject by class gets a timetable at every size tried, up to 24 classes (546 lessons), in 1.4 to 23 estimated seconds.
2. **Subjects taught in groups across the classes are.** With three of them, 12 classes get a timetable (two of two weeks) and 15 do not (none of four). At nine classes the line
   is between four subjects (all eight weeks solved) and six (none of six); at twelve, between three and five.
3. **Shared teachers are a wall, much lower than expected.** A shared teacher here is one who stands on three parallel groups of one subject that take pupils from the same classes
   (here SO and NO: nine lessons of one person in a row). **Two** of them already time out at nine and at twelve classes; **four** are proved impossible in 0.2 s
   (`DEMAND_REQUIREMENTS_EXCEED_WEEK` and `TEACHER_SHARED_BY_PARALLEL_GROUPS`). The production school has twenty-one.
4. **Terms cost.** Three subjects running one term only at twelve classes: one week of two solves, in 1.9 work (35 estimated seconds) where the same week without terms takes 0.45.
5. **The production school's own form does not get a timetable in the corpus even at two classes a year** (six classes in all), and production's history agrees: its Generera runs from 2026-08-31 to 2026-11-19 ended 21 times `FEASIBLE` (all by 2026-09-30), 2 `OPTIMAL`, 18 TIMEOUT, 17 `INFEASIBLE` and 39 `FAILED`; the runs that found a timetable had 44 to 53 lessons, and none has for the 877-lesson school.
6. **The Python part of a solve is small.** Prechecks plus builds are 4 % of the time to the first timetable in the median (1 to 18 %): 0.1 to 1.3 s of 1.5 to 40 s. File size does not cost solve time (docs/DEPLOYMENT.md §35.4).
7. **A week near the edge is a lottery.** The same shape with another seed: 0.26 or 3.5 work (a språkval block), 1.9 work or a timeout (three term subjects), 0.49 or a timeout (five subjects in groups at nine classes).

## What was not measured

- **Clock mode** (every core, as production runs) on the whole sweep: it was started and stopped because the machine's load reached 125, and wall-clock seconds at that load say nothing. Whether the
  portfolio of an eight-core run gets a timetable in the weeks that one worker gives up on is open.
- **The production processor.** docs/DEPLOYMENT.md §35.5 proposes one small calibration run there (decision 8).
- Lessons of other lengths than the högstadium's, the production school's rooms (one kitchen, one laboratory), and its pupils' exact group lists: the corpus has the shape and not those details.
