/**
 * A Stryker reporter that records what each file cost, for scripts/mutation-slice.mjs.
 *
 * Mutants arrive in file order, so the wall time between one result and the
 * next, summed per file, is the time that file held the runner (four test
 * processes at once, so it is the file's share of the run and not a single
 * mutant's latency). Mutants that need no test run — no coverage, ignored —
 * arrive at once and cost nothing. Next to it the file records what Stryker
 * planned for it from the dry run: how many mutants had to be run, and the
 * summed net time of the tests that cover them. 2026-11-02's slices showed that
 * the planned time does not predict the wall time (Stryker estimated static
 * mutants at 59% of a slice's time and leaving them out saved far less), so
 * both are kept and the measured one is what the slices are dealt by.
 *
 * Written to $MUTATION_TIMING_FILE every 200 results and when Stryker winds
 * up, and a line per file ("FILE-TIME <ms> <results> <planned runs> <file>")
 * goes to the log each time the file changes, so a job that is cancelled still
 * leaves what it had, in the log as well as in the artifact.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { declareClassPlugin, PluginKind } from '@stryker-mutator/api/plugin';

const OUT = process.env.MUTATION_TIMING_FILE;

const relativeToProject = (file) => relative(process.cwd(), file);

class TimingReporter {
  constructor() {
    this.files = new Map();
    this.last = Date.now();
    this.results = 0;
    this.current = null;
  }

  entry(file) {
    if (!this.files.has(file)) {
      this.files.set(file, { ms: 0, mutants: 0, run: 0, plannedNetMs: 0, plannedTests: 0, statuses: {} });
    }
    return this.files.get(file);
  }

  onMutationTestingPlanReady({ mutantPlans }) {
    for (const plan of mutantPlans) {
      const entry = this.entry(relativeToProject(plan.mutant.fileName));
      entry.mutants++;
      if (plan.plan === 'Run') {
        entry.run++;
        entry.plannedNetMs += plan.netTime ?? 0;
        entry.plannedTests += plan.runOptions?.testFilter?.length ?? 0;
      }
    }
    this.last = Date.now();
  }

  onMutantTested(result) {
    const now = Date.now();
    const file = relativeToProject(result.fileName);
    if (this.current !== null && this.current !== file) this.line(this.current);
    this.current = file;
    const entry = this.entry(file);
    entry.ms += now - this.last;
    entry.statuses[result.status] = (entry.statuses[result.status] ?? 0) + 1;
    this.last = now;
    if (++this.results % 200 === 0) this.write();
  }

  wrapUp() {
    if (this.current !== null) this.line(this.current);
    this.write();
  }

  line(file) {
    const e = this.files.get(file);
    const done = Object.values(e.statuses).reduce((sum, n) => sum + n, 0);
    console.log(`FILE-TIME ${e.ms} ${done} ${e.run} ${file}`);
  }

  write() {
    if (!OUT) return;
    mkdirSync(dirname(OUT), { recursive: true });
    const files = Object.fromEntries([...this.files].sort(([a], [b]) => (a < b ? -1 : 1)));
    writeFileSync(OUT, JSON.stringify({ results: this.results, files }, null, 1) + '\n');
  }
}
TimingReporter.inject = [];

export const strykerPlugins = [declareClassPlugin(PluginKind.Reporter, 'timing', TimingReporter)];
