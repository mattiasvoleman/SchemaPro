# The solver corpus: the first measurement (2026-11-22)

What a Generera run costs on weeks shaped like real schools, and where it stops finding a timetable. The corpus and the measuring stick are described in docs/DEPLOYMENT.md §35; the numbers a school
reads are in the manual (5.2). This file is the record of the measurement behind them, so that it can be repeated and compared. The data is `docs/solve-corpus-measurement.json` (count mode, 77 weeks) and
`docs/solve-corpus-measurement-clock.json` (clock mode, 41 weeks); the tables are `corpus_report.py docs/solve-corpus-measurement.json --seconds-per-work 18 --lang en`.

## How it was measured

| | |
|---|---|
| Corpus | `optimization-engine/benchmarks/school_corpus.py` (corpus version 1), the `sweep` profile at main `01fcb4707` (the corpus after the review of #386): 77 of its 82 weeks. One axis moves at a time from the base (three subjects in groups across the classes, three classes a year): N classes, G subjects in groups, M shared teachers and how many groups each stands on, term subjects, a språkval block, half groups, and the production school's form (two and six periods, teachers with several groups, 30 classes in grades 4–9). The six weeks of the second seed of the new production-form variants were not measured. |
| Engine | CP-SAT from OR-Tools 9.15.6755, Python 3.11, the engine of main at `9a61fbbe` (the corpus build is byte-identical for the 60 weeks measured on it: checked) |
| Count mode | one worker, fixed seed, a budget of **4 deterministic seconds a search**, with the solve's two satisfaction searches (phase 1a, then 1b), so at most 8 deterministic seconds of work before a week is a TIMEOUT. The unit of "work" is CP-SAT's deterministic second: operations counted, the same on every machine. |
| Clock mode | every core (eight), wall-clock seconds, a budget of 180 s as in production, one run each. |
| What is timed | From `solve()`'s entry to the first timetable: prechecks, builds and phase 1a (or 1b). Phase 2 (improving a timetable that exists) is left out. |
| Machine | darwin/arm64, 8 cores, shared with other sessions: **load average 4.5 to 119 during the count run** and 4 to 87 during the clock runs. Count mode's verdicts and work do not depend on the load; seconds do. |

**A correction made before this was written down.** The first count run had a wall-clock safety limit of forty times the budget, and at the load of those hours it, and not the budget, ended 13 of the 33 TIMEOUTs: a search
stopped at 1.5 to 3.9 of its 4 deterministic seconds is the host's verdict and not count mode's. The 13 weeks were found by reading `searches[].deterministic` of every TIMEOUT row, the safety was raised to a thousand
times, a search that still ends before 95 % of its budget is now an `ERROR` (`WALL_LIMIT_BEFORE_BUDGET`), and the 13 were measured again: **all 13 are TIMEOUTs on both searches' full budgets**, so every TIMEOUT below is the
budget's. **A second correction came from the review of the corpus**: the first run's weeks with four and eight shared teachers of three groups each are not in the corpus any more (the engine's own count refuses them on
arithmetic, so they measured a refusal); the corpus takes four and eight with two groups each instead, and they were measured here.

## Seconds

The seconds columns of the count tables are **estimates**: the work times 18. Eleven solved weeks were measured when the machine was quiet (load 4.5 to 11.5); one worker took **18 s per deterministic second** in the
median there (8 to 25). At load 50 to 80 the same weeks took 27 to 69 s. So "≈ 18 s per work" is one core of this machine, quiet, and nothing says what a production core does (§35.5). By the same figure the budget of
4 deterministic seconds a search is about 72 s, and the two searches of a solve about 144 s, close to the production budget of 180 s: a **timeout** below means "no timetable in about what production gives a run, on one core
of this machine".

## The tables (count mode, one core)

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
| 1 (with 3 groups each) | 2 | 2 | 0 | 0 | 0.24 | 0.27 | 4.4 | 4.9 |
| 2 (with 3 groups each) | 2 | 0 | 2 | 0 | - | - | - | - |
| 3 (with 2 groups each) | 2 | 2 | 0 | 0 | 0.23 | 0.28 | 4.1 | 5.0 |
| 5 (with 2 groups each) | 2 | 2 | 0 | 0 | 0.28 | 0.41 | 5.0 | 7.4 |

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
| 1 (with 3 groups each) | 2 | 2 | 0 | 0 | 0.41 | 0.44 | 7.3 | 8.0 |
| 2 (with 3 groups each) | 2 | 0 | 2 | 0 | - | - | - | - |
| 4 (with 2 groups each) | 2 | 2 | 0 | 0 | 0.48 | 0.51 | 8.7 | 9.2 |
| 8 (with 2 groups each) | 2 | 2 | 0 | 0 | 0.39 | 0.41 | 6.9 | 7.4 |

### Term lessons (subjects that run one term only), 12 classes, three subjects in groups

| term subjects | weeks | timetable | timeout | refused | work median | work p90 | ≈ s median | ≈ s p90 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 2 | 2 | 0 | 0 | 0.37 | 0.43 | 6.7 | 7.8 |
| 3 | 2 | 1 | 1 | 0 | 1.94 | 1.94 | 34.9 | 34.9 |
| 5 | 2 | 0 | 2 | 0 | - | - | - | - |

### The production form (ten subjects in groups, half groups, terms, production's frame)

| N classes (variant) | weeks | timetable | timeout | refused | work median | work p90 | ≈ s median | ≈ s p90 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 6 (t5-h) | 2 | 0 | 2 | 0 | - | - | - | - |
| 6 (t5p6-h) | 1 | 0 | 1 | 0 | - | - | - | - |
| 9 (t5-h) | 2 | 0 | 2 | 0 | - | - | - | - |
| 9 (t5-q1-h) | 1 | 0 | 1 | 0 | - | - | - | - |
| 9 (t5-q2-h) | 1 | 0 | 1 | 0 | - | - | - | - |
| 9 (t5p6-h) | 1 | 0 | 1 | 0 | - | - | - | - |
| 30 (t5-y0.0.0.3.10.10-h) | 1 | 0 | 1 | 0 | - | - | - | - |


## All eight cores (clock mode)

Count mode is one worker. Production runs CP-SAT on every core it has, and CP-SAT's portfolio may find what one worker cannot. 41 weeks were run in clock mode at the loads in the table (other sessions were using
the machine, so a time is slower than a quiet machine's, and a timeout proves nothing about one).

| Week | One worker (count mode) | All eight cores (clock mode, 180 s) |
|---|---|---|
| 6 classes, three subjects in groups | 0.18 work (≈ 4 s) | timetable in 0.7 s (load 4) |
| 9 classes, three subjects in groups | 0.17 work (≈ 4 s) | timetable in 1.3 s (load 4) |
| 12 classes, three subjects in groups | 0.45 work (≈ 9 s) | timetable in 9.3 s (load 7) |
| 18 classes, every subject by class | 1.32 work (≈ 24 s) | timetable in 8.4 s (load 58) |
| 24 classes, every subject by class | 0.73 work (≈ 14 s) | timetable in 3.1 s (load 53) |
| 15 classes, three subjects in groups (seed 1) | timeout | timetable in 26.2 s (load 14) |
| 15 classes, three subjects in groups (seed 2) | timeout | timetable in 138.5 s (load 60) |
| 18 classes, three subjects in groups (seed 1) | timeout | timeout at 180 s (load 61) |
| 9 classes, five subjects in groups (seed 2) | timeout | timetable in 33.0 s (load 49) |
| 9 classes, six subjects in groups (seed 1) | timeout | timeout at 180 s (load 87) |
| 9 classes, six subjects in groups (seed 2) | timeout | timeout at 180 s (load 52) |
| 12 classes, four subjects in groups (seed 1) | timeout | timetable in 32.0 s (load 82) |
| 12 classes, five subjects in groups (seed 1) | timeout | timetable in 41.0 s (load 50) |
| 12 classes, three subjects in groups, 2 shared teachers with three groups each (seed 1) | timeout | timeout at 180 s (load 76) |
| the same (seed 2) | timeout | timeout at 180 s (load 44) |
| 12 classes, three subjects in groups, three term subjects (seed 1) | 1.94 work (≈ 35 s) | timetable in 153.4 s (load 70) |
| the same (seed 2) | timeout | timetable in 163.9 s (load 40) |
| 9 classes, the production form (ten subjects in groups, half groups, terms) | timeout | timeout at 181 s (load 53) |
| the same with teachers who have several groups each | timeout | timeout at 181 s (load 53) |
| 30 classes in grades 4–9, groups in grades 8 and 9 (ten subjects) and in 7 (three) | timeout | timeout at 184 s (load 63) |

Every one of the 27 weeks that one worker solved was solved with eight cores, in a median of 2 s. 6 of the 14 weeks that one worker gave up on were solved too, so **the lines
in the count tables are one core's and move up with the cores**. The ones that did not move are the long chains (two teachers on three parallel groups each) and six subjects in groups at nine classes; the three production-form weeks
that were run timed out at 180 s at loads of 13 to 63.

## What the first measurement found

1. **Classes are not what stops the engine; the form of the groups is.** Every subject by class gets a timetable at every size tried, up to 24 classes (546 lessons). With three subjects in groups across the classes,
   12 classes get one on one core and 15 do not; on eight cores 15 do and 18 do not.
2. **What the engine cannot lay is a long chain of one person's parallel groups, not shared teachers as such.** Teachers with two parallel groups each, up to eight at twelve classes, are laid in 2 to 10 s. One teacher with
   three groups is fine. Two of them time out, on eight cores too, and four are refused by the engine's own count (they were in the first run and are not in the corpus).
3. **Terms cost, and not smoothly.** Three term subjects at twelve classes: one week of two on one core (1.9 work, ≈ 35 s) and both on eight cores (153 and 164 s at loads 70 and 40); five term subjects: neither.
4. **The production school's own form does not get a timetable in the corpus** on one core at six or nine classes, with six periods, with teachers who have several groups each, and at the size of the real school (30 classes,
   868 lessons, 4,154 group pairs); the three weeks run on eight cores timed out too, under load.
5. **The Python part of a solve is small.** Prechecks plus builds are 4 % of the time to the first timetable in the median (1 to 18 %) on one core: 0.1 to 1.3 s of 1.5 to 40 s. File size does not cost solve time (docs/DEPLOYMENT.md §35.4).
6. **A week near the edge is a lottery.** The same shape with another seed: 0.26 or 3.5 work (a språkval block), 1.9 work or a timeout (three term subjects), 0.49 or a timeout (five subjects in groups at nine classes).

## What was not measured

- The production processor (docs/DEPLOYMENT.md §35.5 proposes one small calibration there: decision 8).
- Clock mode for the whole sweep, a second run of any clock week, and clock mode on a quiet machine.
- Lessons of other lengths than the högstadium's, the production school's rooms, and its pupils' exact group lists: the corpus has the shape and not those details.
