#!/usr/bin/env node
/**
 * Mutation testing, one slice a night.
 *
 *   node scripts/mutation-slice.mjs                  tonight's slice, run
 *   MUTATION_SLICE=3 node scripts/mutation-slice.mjs slice 3, run
 *   node scripts/mutation-slice.mjs --list           every slice: files and mutants
 *   node scripts/mutation-slice.mjs --list --slice 3 slice 3's files
 *   node scripts/mutation-slice.mjs --plan           which slices a workflow run takes
 *
 * WHY A SLICE. The API has 73,861 mutants in 280 files (2026-11-02); on
 * 2026-10-06 it had 7,522 in 57, and that run took 41 minutes. On the runner
 * Stryker gets through roughly 50 mutants a minute now, so the whole set is
 * a day of runner time and the job's 90 minutes reach one part in seven. The
 * gate is the same number, §2's 85%, measured on a slice that fits: the files
 * are dealt into SLICES balanced slices by their mutant counts, tonight's is
 * the day of the year (UTC) modulo SLICES, and the whole API is covered every
 * SLICES nights. docs/verification-baseline.md has the slices as measured.
 *
 * BALANCED BY MUTANTS, COUNTED WHEN IT RUNS. Stryker's own instrumenter counts
 * each file's mutants (a few seconds for all of src/), and the longest-first
 * rule hands the biggest file left to the lightest slice, ties to the lower
 * slice and to the file name. Nothing is checked in, so the slices follow the
 * code as it grows; the price is that a new file can move another one to a
 * different slice. Every job of one run counts the same tree and gets the same
 * slices.
 *
 * WHAT STAYS THE SAME. The files that are mutated at all are stryker.conf.json's
 * `mutate` list, read here and nothing else, so what is left out of it is left
 * out of every slice. The break threshold is the config's too: Stryker applies
 * it to the mutants it was given, which is the slice.
 *
 * WHAT IT WRITES, under reports/mutation/slice-N/ — the number is in the path,
 * so ten nights can be laid side by side: stryker.conf.json (the config the run
 * used, `mutate` being the slice's files), slice.json (number, size, files),
 * index.html and mutation.json (Stryker's report), summary.md (score, and every
 * file's score, weakest first). The summary is also appended to the Actions
 * job summary. The exit code is Stryker's.
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, globSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_SLICES = 10;
const BASE_CONFIG = 'stryker.conf.json';
const REPORTS = 'reports/mutation';

/** 1 January is day 1, in UTC. */
export function dayOfYear(date) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const day = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return Math.round((day - start) / 86_400_000);
}

export const tonightsSlice = (date, of) => dayOfYear(date) % of;

/** '' is tonight's, 'all' is every slice, otherwise a whole number below `of`. */
export function parseSlice(value, of) {
  const text = String(value ?? '').trim();
  if (text === '' || text === 'all') return text;
  const n = Number(text);
  if (!Number.isInteger(n) || n < 0 || n >= of) {
    throw new Error(`slice must be a whole number from 0 to ${of - 1}, 'all' or empty, got '${text}'`);
  }
  return n;
}

/** The slices a run takes: tonight's, the one asked for, or all of them. */
export function plan({ input = '', date = new Date(), of = DEFAULT_SLICES } = {}) {
  const asked = parseSlice(input, of);
  if (asked === 'all') return Array.from({ length: of }, (_, i) => i);
  return [asked === '' ? tonightsSlice(date, of) : asked];
}

/**
 * `counts` is [{ file, mutants }]; returns `of` slices { slice, mutants,
 * files: [{ file, mutants }] }, the files of a slice in name order.
 */
export function balance(counts, of = DEFAULT_SLICES) {
  const slices = Array.from({ length: of }, (_, slice) => ({ slice, mutants: 0, files: [] }));
  const byWeight = [...counts].sort((a, b) => b.mutants - a.mutants || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  for (const entry of byWeight) {
    const lightest = slices.reduce((best, s) => (s.mutants < best.mutants ? s : best));
    lightest.files.push(entry);
    lightest.mutants += entry.mutants;
  }
  for (const s of slices) s.files.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return slices;
}

/**
 * The files the config's `mutate` list names, in Stryker's own sense: patterns
 * in order, a `!` pattern taking files out of what the ones before it put in.
 */
export function filesToMutate(patterns, glob = (pattern) => globSync(pattern)) {
  const files = new Set();
  for (const pattern of patterns) {
    const negated = pattern.startsWith('!');
    for (const file of glob(negated ? pattern.slice(1) : pattern)) {
      if (negated) files.delete(file);
      else files.add(file);
    }
  }
  return [...files].filter((file) => /\.[cm]?[jt]sx?$/.test(file)).sort();
}

/** Mutants per file, counted by Stryker's instrumenter on the same files it would mutate. */
async function countMutants(files) {
  const { createInstrumenter } = await import('@stryker-mutator/instrumenter');
  const { commonTokens } = await import('@stryker-mutator/api/plugin');
  const { createInjector } = await import('typed-inject');
  const quiet = {
    trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
    isTraceEnabled: () => false, isDebugEnabled: () => false, isInfoEnabled: () => false,
    isWarnEnabled: () => false, isErrorEnabled: () => false, isFatalEnabled: () => false,
  };
  const instrumenter = createInstrumenter(createInjector().provideValue(commonTokens.logger, quiet));
  const input = files.map((name) => ({ name, content: readFileSync(name, 'utf8'), mutate: true }));
  const { mutants } = await instrumenter.instrument(input, { plugins: null, excludedMutations: [], ignorers: [] });
  const perFile = new Map(files.map((file) => [file, 0]));
  for (const mutant of mutants) perFile.set(mutant.fileName, (perFile.get(mutant.fileName) ?? 0) + 1);
  return files.map((file) => ({ file, mutants: perFile.get(file) ?? 0 }));
}

/** Stryker's own score: detected ÷ (detected + undetected), the rest not counted. */
const DETECTED = new Set(['Killed', 'Timeout']);
const UNDETECTED = new Set(['Survived', 'NoCoverage']);

export function scoreOf(statuses) {
  let detected = 0;
  let undetected = 0;
  for (const status of statuses) {
    if (DETECTED.has(status)) detected++;
    else if (UNDETECTED.has(status)) undetected++;
  }
  const valid = detected + undetected;
  return { detected, undetected, valid, score: valid === 0 ? null : (detected / valid) * 100 };
}

/** The slice's score and each file's from Stryker's JSON report, weakest file first. */
export function summarise(report) {
  const files = Object.entries(report.files ?? {}).map(([file, { mutants }]) => ({
    file,
    ...scoreOf(mutants.map((m) => m.status)),
    survived: mutants.filter((m) => m.status === 'Survived').length,
    noCoverage: mutants.filter((m) => m.status === 'NoCoverage').length,
  }));
  const total = scoreOf(Object.values(report.files ?? {}).flatMap(({ mutants }) => mutants.map((m) => m.status)));
  files.sort((a, b) => (a.score ?? 101) - (b.score ?? 101) || (a.file < b.file ? -1 : 1));
  return { total, files };
}

const pct = (score) => (score === null ? 'n/a' : `${score.toFixed(2)} %`);

export function summaryMarkdown({ slice, of, mutants, files }, summary, thresholdBreak) {
  const lines = [`## Mutation slice ${slice} of ${of}`, ''];
  if (!summary) {
    lines.push(`No report: Stryker did not finish (${mutants} mutants in ${files.length} files). The job log has its progress.`);
    return lines.join('\n') + '\n';
  }
  const { total } = summary;
  lines.push(
    `**Score ${pct(total.score)}** (break at ${thresholdBreak} %): ${total.detected} of ${total.valid} mutants detected, ` +
      `${total.undetected} not, in ${files.length} files.`,
    '',
    '| File | Score | Detected | Survived | No coverage |',
    '| :--- | ---: | ---: | ---: | ---: |',
    ...summary.files.map((f) => `| ${f.file} | ${pct(f.score)} | ${f.detected} | ${f.survived} | ${f.noCoverage} |`),
  );
  return lines.join('\n') + '\n';
}

const number = (n) => String(n).padStart(6);

function printSlice(s, of) {
  console.log(`Slice ${s.slice} of ${of}: ${s.mutants} mutants in ${s.files.length} files`);
  for (const { file, mutants } of s.files) console.log(`${number(mutants)}  ${file}`);
}

function parseArgs(argv, env) {
  const flag = (name) => argv.includes(name);
  const value = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  // An unset variable and an empty one (an unset workflow input) both mean the default.
  const of = Number(value('--of') || env.MUTATION_SLICES || DEFAULT_SLICES);
  if (!Number.isInteger(of) || of < 1) throw new Error(`--of must be a positive integer, got '${of}'`);
  return {
    of,
    asked: value('--slice') || env.MUTATION_SLICE || '',
    plan: flag('--plan'),
    list: flag('--list'),
  };
}

async function main() {
  const { of, asked, plan: wantPlan, list } = parseArgs(process.argv.slice(2), process.env);

  if (wantPlan) {
    // Two lines for $GITHUB_OUTPUT; needs nothing installed.
    console.log(`slices=${JSON.stringify(plan({ input: asked, of }))}`);
    console.log(`of=${of}`);
    return 0;
  }

  const base = JSON.parse(readFileSync(BASE_CONFIG, 'utf8'));
  const files = filesToMutate(base.mutate);
  const slices = balance(await countMutants(files), of);
  const total = slices.reduce((sum, s) => sum + s.mutants, 0);

  if (list) {
    const one = parseSlice(asked, of);
    if (typeof one === 'number') printSlice(slices[one], of);
    else {
      console.log(`${total} mutants in ${files.length} files, ${of} slices`);
      for (const s of slices) console.log(`slice ${s.slice}: ${number(s.mutants)} mutants in ${s.files.length} files`);
    }
    return 0;
  }

  const [n] = plan({ input: asked, of });
  const chosen = slices[n];
  const dir = join(REPORTS, `slice-${n}`);
  mkdirSync(dir, { recursive: true });

  if (process.env.GITHUB_ACTIONS) console.log(`::group::Slice ${n} of ${of}: ${chosen.mutants} mutants in ${chosen.files.length} files`);
  else console.log(`Slice ${n} of ${of}: ${chosen.mutants} mutants in ${chosen.files.length} files`);
  for (const { file, mutants } of chosen.files) console.log(`${number(mutants)}  ${file}`);
  if (process.env.GITHUB_ACTIONS) console.log('::endgroup::');
  console.log(`(the API has ${total} mutants in ${files.length} files; this is ${((chosen.mutants / total) * 100).toFixed(1)} %)`);

  const configPath = join(dir, 'stryker.conf.json');
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        ...base,
        slice_comment: `Slice ${n} of ${of}, written by scripts/mutation-slice.mjs: \`mutate\` is this slice's files, the reports carry its number.`,
        mutate: chosen.files.map((f) => f.file),
        htmlReporter: { fileName: join(dir, 'index.html') },
        jsonReporter: { fileName: join(dir, 'mutation.json') },
      },
      null,
      2,
    ) + '\n',
  );
  const slice = { slice: n, of, mutants: chosen.mutants, files: chosen.files, apiMutants: total, apiFiles: files.length };
  writeFileSync(join(dir, 'slice.json'), JSON.stringify({ ...slice, date: new Date().toISOString() }, null, 2) + '\n');

  const stryker = spawnSync(join('node_modules', '.bin', 'stryker'), ['run', configPath], { stdio: 'inherit' });

  const reportPath = join(dir, 'mutation.json');
  const summary = existsSync(reportPath) ? summarise(JSON.parse(readFileSync(reportPath, 'utf8'))) : null;
  const markdown = summaryMarkdown(slice, summary, base.thresholds?.break ?? 0);
  writeFileSync(join(dir, 'summary.md'), markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  console.log(markdown.split('\n').slice(0, 3).join('\n'));

  return stryker.status ?? 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error);
      process.exitCode = 2;
    },
  );
}
