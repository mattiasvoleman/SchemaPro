#!/usr/bin/env node
/**
 * Mutation testing, one slice a night.
 *
 *   node scripts/mutation-slice.mjs                  tonight's slice, run
 *   MUTATION_SLICE=3 node scripts/mutation-slice.mjs slice 3, run
 *   node scripts/mutation-slice.mjs --list           the dealing: every slice, its floor and its files
 *   node scripts/mutation-slice.mjs --list --slice 3 one slice's files, and any new file placed in it
 *   node scripts/mutation-slice.mjs --plan           which slices a workflow run takes
 *   node scripts/mutation-slice.mjs --check-ranges   whether a cut of a file dealt in line ranges still holds all its mutants
 *   node scripts/mutation-slice.mjs --deal --of 20 file-times.json ...   make a dealing
 *   node scripts/mutation-slice.mjs --remeasure reports/mutation/slice-3 [--lower]   a slice's new floor
 *
 * WHY A SLICE. The API has 70,636 mutants in 279 files (2026-11-02; 73,861
 * before the generated file was left out), against 7,522 in 57 on 2026-10-06,
 * when the whole run took 41 minutes. Stryker now gets through roughly 50
 * mutants a minute on the runner, and the whole set is half a day of it. The
 * gate is a slice a night: the files are dealt into a number of slices,
 * tonight's is the day of the year (UTC) modulo that number, and the whole API
 * is covered every that many nights within a year; across a new year the
 * slices after 31 December run twice in a row and the longest wait for a slice
 * is a few nights more (25 or 26 for twenty slices).
 *
 * DEALT BY MEASURED SECONDS, NOT BY MUTANTS. Mutant counts say nothing about
 * time: slices of the same size took 21 to over 95 minutes. So the dealing is
 * made from a measured run of every file (mutation-timing-reporter.mjs writes
 * what each file cost), by the longest-first rule — the dearest file left
 * goes to the lightest slice, ties to the lower slice and the file name — and
 * is CHECKED IN as scripts/mutation-slices.json, so that a slice is the same
 * files night after night and its floor means the same thing. It holds each
 * file's measured seconds, mutants, detected and valid mutants, and each
 * slice's seconds, score and floor.
 *
 * A DEAR FILE IN PARTS. One file can cost more than a slice may: with the
 * first dealing, optimization-proxy.service.ts alone was 62 minutes. Such a
 * file is dealt in line ranges, the way Stryker names them (`file:1-812`), cut
 * where each part has about the same number of mutants that have to be run; the
 * last part ends at line 99999, so lines added later are mutated too. The parts'
 * seconds are the file's, shared by the mutants they run; their scores are
 * exact, from the file's mutants. `--deal ... --split <file>=<parts>@<mutation.json>`.
 * Edits shift the lines, and a mutant that moves into the next part moves its
 * score with it: the one point under the measured score is for that as well.
 *
 * A CUT A MUTANT CROSSES. A cut is made at a line no mutant crosses, but an edit
 * above it moves the lines, and a mutant that starts before the cut and ends
 * after it is wholly inside neither part: no slice runs it, and nothing in the
 * score shows that it was lost. So every run of a slice first asks Stryker's
 * instrumenter (the version `npm run test:mutation` installs, the one that will
 * run the mutants) for the mutants of each file that is dealt in parts, whole
 * and part by part, and the night is red when the parts hold another number than
 * the file has. The message says which cut and the nearest line to move it to.
 * `--check-ranges` does only that, for use when the file has been edited.
 *
 * THE FLOOR. A slice's floor is its measured score minus one percentage point,
 * rounded down. It is the slice's `break` threshold, so the night's job fails
 * when the slice scores under it, and only then; §2's 85% stays the target and
 * is what the report is set against. A floor is raised when the tests get
 * better: run the slice (a dispatch of `mutation_slice=N`), download its
 * artifact and `--remeasure` the slice's directory, which puts that run's
 * figures and floor(score − 1) in the dealing for that slice, in a commit of
 * its own. It refuses to lower a floor unless given `--lower`, which is an
 * explicit decision, said in the commit that does it. A slice whose files
 * change gets a new floor only after it has been measured again: `--remeasure`
 * refuses a run of other files than the slice's, and `--deal` makes a new
 * dealing, with new floors, from a run of all the slices.
 *
 * A NEW FILE. A file in `mutate` that the dealing does not know goes to the
 * slice with the least seconds so far, counting the files placed before it (in
 * name order), at its mutants times the dealing's median seconds a mutant; ties
 * to the lower slice. The report names the file and the slice. The slice's
 * floor was measured without it, so a new file that tests do not reach is what
 * takes a slice under its floor: the signal that it needs tests, or that the
 * slice needs measuring again. A file in the dealing that is gone is skipped
 * and named in the report.
 *
 * WHAT STAYS THE SAME. The files that are mutated at all are stryker.conf.json's
 * `mutate` list, read here, so what it leaves out (controllers, DTOs, generated
 * code) is left out of every slice. `ignoreStatic` is its too, and the dealing
 * was measured with it on.
 *
 * WHAT IT WRITES, under reports/mutation/slice-N/ — the number is in the path,
 * so nights can be laid side by side: stryker.conf.json (the config the run
 * used, `mutate` being the slice's files and `break` its floor), slice.json,
 * Stryker's index.html and mutation.json, file-times.json (what each file cost
 * tonight) and summary.md (score against floor and target, every file's score,
 * weakest first). The summary is also appended to the Actions job summary. The
 * exit code is Stryker's, and 1 where Stryker's is 0 but the night measured
 * nothing, scored under the floor, or lost mutants to a cut (exitCodeFor,
 * rangeProblems).
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, globSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const TARGET = 85;
const BASE_CONFIG = 'stryker.conf.json';
const DEALING = 'scripts/mutation-slices.json';
const REPORTS = 'reports/mutation';

const byName = (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0);

/** A dealt key is a file, or a file's line range: `src/a.ts:1-812`. */
export const baseOf = (key) => key.replace(/:\d+-\d+$/, '');

/** The lines a dealt key names, { from, to } from 1, or null for a whole file. */
export function rangeOf(key) {
  const match = /:(\d+)-(\d+)$/.exec(key);
  return match ? { from: Number(match[1]), to: Number(match[2]) } : null;
}
const LAST_LINE = 99999;
const COSTS_TIME = new Set(['Killed', 'Timeout', 'Survived']);

/**
 * One measured file as `parts` line ranges. `entry` is { ms, mutants,
 * statuses }, `mutants` the file's mutants from Stryker's report ({ status,
 * location: { start: { line }, end: { line } } }, lines from 1). Stryker runs
 * the mutants that lie WHOLLY inside a range, so a cut must not fall inside any
 * mutant: it is put on the line nearest to where the mutants that cost time
 * (killed, timed out, survived) split evenly, among the lines no mutant
 * straddles, and every mutant is then in exactly one part. The seconds are
 * shared by those mutants, and each part's statuses are counted from its own
 * mutants. Returns [[key, entry]].
 */
export function splitEntry(file, entry, mutants, parts) {
  const timed = mutants.filter((m) => COSTS_TIME.has(m.status)).map((m) => m.location.start.line).sort((a, b) => a - b);
  if (parts < 2 || timed.length < parts) throw new Error(`${file} cannot be cut in ${parts} parts`);
  const lastLine = Math.max(...mutants.map((m) => m.location.end.line));
  // The lines a cut may follow: no mutant starts on or before the line and ends after it.
  const free = Array.from({ length: lastLine }, (_, i) => i + 1).filter((line) => line < lastLine && !mutants.some((m) => m.location.start.line <= line && m.location.end.line > line));
  const ends = [];
  for (let k = 1; k < parts; k++) {
    const ideal = timed[Math.floor((timed.length * k) / parts) - 1];
    const after = ends[ends.length - 1] ?? 0;
    const candidates = free.filter((line) => line > after);
    if (candidates.length === 0) throw new Error(`${file} has no line between its mutants to cut at`);
    ends.push(candidates.reduce((best, line) => (Math.abs(line - ideal) < Math.abs(best - ideal) ? line : best)));
  }
  ends.push(LAST_LINE);
  const result = [];
  let from = 1;
  for (const to of ends) {
    const inPart = mutants.filter((m) => m.location.start.line >= from && m.location.end.line <= to);
    const statuses = {};
    for (const m of inPart) statuses[m.status] = (statuses[m.status] ?? 0) + 1;
    const share = inPart.filter((m) => COSTS_TIME.has(m.status)).length / timed.length;
    result.push([`${file}:${from}-${to}`, { ms: entry.ms * share, mutants: inPart.length, statuses }]);
    from = to + 1;
  }
  const covered = result.reduce((sum, [, e]) => sum + e.mutants, 0);
  if (covered !== mutants.length) throw new Error(`${file}: the parts hold ${covered} of ${mutants.length} mutants`);
  return result;
}

/** 1 January is day 1, in UTC. */
export function dayOfYear(date) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const day = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return Math.round((day - start) / 86_400_000);
}

export const tonightsSlice = (date, of) => dayOfYear(date) % of;

/**
 * The slices a run takes: '' is tonight's, 'all' every slice, otherwise a
 * number or a comma list of numbers below `of`.
 */
export function plan({ input = '', date = new Date(), of }) {
  const text = String(input ?? '').trim();
  if (text === '') return [tonightsSlice(date, of)];
  if (text === 'all') return Array.from({ length: of }, (_, i) => i);
  const slices = text.split(',').map((part) => {
    const n = Number(part.trim());
    if (part.trim() === '' || !Number.isInteger(n) || n < 0 || n >= of) {
      throw new Error(`slice must be whole numbers from 0 to ${of - 1} (comma-separated), 'all' or empty, got '${text}'`);
    }
    return n;
  });
  return [...new Set(slices)].sort((a, b) => a - b);
}

/**
 * `items` is [{ file, mutants, weight? }]; the weight is what a file is dealt
 * by (its measured seconds, or the mutant count where nothing is measured).
 * Returns `of` slices { slice, mutants, weight, files }, the files of a slice
 * in name order.
 */
export function balance(items, of) {
  const slices = Array.from({ length: of }, (_, slice) => ({ slice, mutants: 0, weight: 0, files: [] }));
  const weightOf = (entry) => entry.weight ?? entry.mutants;
  const heaviestFirst = [...items].sort((a, b) => weightOf(b) - weightOf(a) || byName(a, b));
  for (const entry of heaviestFirst) {
    const lightest = slices.reduce((best, s) => (s.weight < best.weight ? s : best));
    lightest.files.push(entry);
    lightest.mutants += entry.mutants;
    lightest.weight += weightOf(entry);
  }
  for (const s of slices) s.files.sort(byName);
  return slices;
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

/** The same from a file's status counts, { Killed: 3, Survived: 1, ... }. */
export function scoreOfCounts(counts) {
  return scoreOf(Object.entries(counts).flatMap(([status, n]) => Array(n).fill(status)));
}

/** A slice's floor: its measured score minus one percentage point, rounded down. */
export const floorOf = (score) => Math.floor(score - 1);

/**
 * The dealing, from measured files: Map file → { ms, mutants, statuses }, as
 * mutation-timing-reporter.mjs writes them. A file whose results are fewer than
 * its mutants was cut off, and a dealing cannot be made from half a file.
 */
export function deal(measured, of, { run = null, date = new Date().toISOString().slice(0, 10), ignoreStatic = true } = {}) {
  const incomplete = [...measured].filter(([, m]) => Object.values(m.statuses).reduce((a, b) => a + b, 0) < m.mutants).map(([file]) => file);
  if (incomplete.length > 0) throw new Error(`these files were not measured to the end: ${incomplete.sort().join(', ')}`);
  const items = [...measured].map(([file, m]) => ({ file, mutants: m.mutants, weight: Math.round(m.ms / 100) / 10 }));
  const slices = balance(items, of).map((s) => {
    const files = {};
    let detected = 0;
    let valid = 0;
    for (const { file, mutants, weight } of s.files) {
      const { detected: d, valid: v } = scoreOfCounts(measured.get(file).statuses);
      files[file] = { seconds: weight, mutants, detected: d, valid: v };
      detected += d;
      valid += v;
    }
    const score = valid === 0 ? null : (detected / valid) * 100;
    return {
      slice: s.slice,
      seconds: Math.round(s.weight * 10) / 10,
      mutants: s.mutants,
      detected,
      valid,
      score: score === null ? null : Math.round(score * 100) / 100,
      floor: score === null ? 0 : floorOf(score),
      files,
    };
  });
  return {
    comment:
      "The dealing scripts/mutation-slice.mjs runs by: each file's measured seconds, mutants, detected and valid mutants, and each slice's score and floor (its measured score minus one point, rounded down). " +
      'Made by `node scripts/mutation-slice.mjs --deal --of N <file-times.json of every slice of a run>`; see the header of the script for how a floor is raised and when a slice needs a new one.',
    measured: date,
    run,
    ignoreStatic,
    slices,
  };
}

/**
 * A slice measured again: `report` is Stryker's mutation.json from a run of
 * slice `n` and `times` its file-times.json. The run must have mutated the
 * slice's files and no others, or the figures are not the slice's. Returns the
 * dealing with that slice's figures and floor replaced; a lower floor than the
 * one it had is refused unless `lower` says it is meant.
 */
export function remeasure(dealing, n, { report, times }, { lower = false, date = new Date().toISOString().slice(0, 10) } = {}) {
  const slice = dealing.slices[n];
  const keys = Object.keys(slice.files);
  const bases = keys.map(baseOf);
  if (new Set(bases).size !== bases.length) throw new Error(`slice ${n} holds two parts of one file; measure it with --deal`);
  const ran = Object.keys(report.files ?? {});
  const unexpected = ran.filter((f) => !bases.includes(f));
  const missing = keys.filter((key) => slice.files[key].mutants > 0 && !ran.includes(baseOf(key)));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error(`slice ${n} was not run on its own files (ran ${unexpected.join(', ') || 'no other file'}; did not run ${missing.map(baseOf).join(', ') || 'none'}): measure all slices with --deal`);
  }
  const files = {};
  let detected = 0;
  let valid = 0;
  let mutants = 0;
  let seconds = 0;
  for (const key of keys) {
    const base = baseOf(key);
    const list = report.files[base]?.mutants ?? [];
    const { detected: d, valid: v } = scoreOf(list.map((m) => m.status));
    const secs = Math.round((times.files?.[base]?.ms ?? 0) / 100) / 10;
    files[key] = { seconds: secs, mutants: list.length, detected: d, valid: v };
    detected += d;
    valid += v;
    mutants += list.length;
    seconds += secs;
  }
  const score = valid === 0 ? null : (detected / valid) * 100;
  const floor = score === null ? 0 : floorOf(score);
  if (floor < slice.floor && !lower) {
    throw new Error(`slice ${n} scored ${score.toFixed(2)} %, which would lower its floor from ${slice.floor} % to ${floor} %: pass --lower to say that is meant`);
  }
  const slices = dealing.slices.map((s) =>
    s.slice === n ? { slice: n, seconds: Math.round(seconds * 10) / 10, mutants, detected, valid, score: score === null ? null : Math.round(score * 100) / 100, floor, measured: date, files } : s,
  );
  return { ...dealing, slices };
}

/**
 * New files, those in `files` the dealing does not know, each placed in the
 * slice with the least seconds so far, in name order. `counts` is [{ file,
 * mutants }] for the new ones. Returns { placed: [{ file, mutants, slice,
 * seconds }], gone: [file] }.
 */
export function placeNew(dealing, files, counts) {
  const known = new Set(dealing.slices.flatMap((s) => Object.keys(s.files).map(baseOf)));
  const present = new Set(files);
  const perMutant = dealing.slices
    .flatMap((s) => Object.values(s.files))
    .filter((f) => f.mutants > 0)
    .map((f) => f.seconds / f.mutants)
    .sort((a, b) => a - b);
  const median = perMutant.length === 0 ? 0 : perMutant[perMutant.length >> 1];
  const load = dealing.slices.map((s) => s.seconds);
  const placed = [];
  for (const { file, mutants } of [...counts].filter((c) => !known.has(c.file)).sort(byName)) {
    const slice = load.reduce((best, seconds, i) => (seconds < load[best] ? i : best), 0);
    const seconds = Math.round(mutants * median * 10) / 10;
    load[slice] += seconds;
    placed.push({ file, mutants, slice, seconds });
  }
  const gone = [...known].filter((file) => !present.has(file)).sort();
  return { placed, gone };
}

/** The files a slice runs tonight: its dealt files that still exist, and the new ones placed in it. */
export function filesOf(dealing, n, files, placed) {
  const present = new Set(files);
  return [...Object.keys(dealing.slices[n].files).filter((key) => present.has(baseOf(key))), ...placed.filter((p) => p.slice === n).map((p) => p.file)].sort();
}

/**
 * The mutants tonight's slice is expected to run: those the dealing gave its
 * files that are still there, and the mutants counted for the new files placed
 * in it. A file that is gone is not expected, and a slice that lost one is not
 * short of mutants for it. `dealt` is the slice's `files`.
 */
export function expectedMutants(dealt, sliceFiles, placed) {
  return sliceFiles.reduce((sum, key) => sum + (dealt[key]?.mutants ?? placed.find((p) => p.file === key)?.mutants ?? 0), 0);
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

let instrumenterOnce = null;

/**
 * Stryker's instrumenter, which makes the mutants a run would run, imported when
 * it is first needed: the tests of this script run without Stryker installed.
 * Takes [{ name, content, mutate }], `mutate` being true or Stryker's mutation
 * ranges (lines from 0), and returns the API mutants.
 */
function instrumenter() {
  instrumenterOnce ??= (async () => {
    const { createInstrumenter } = await import('@stryker-mutator/instrumenter');
    const { commonTokens } = await import('@stryker-mutator/api/plugin');
    const { createInjector } = await import('typed-inject');
    const quiet = {
      trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
      isTraceEnabled: () => false, isDebugEnabled: () => false, isInfoEnabled: () => false,
      isWarnEnabled: () => false, isErrorEnabled: () => false, isFatalEnabled: () => false,
    };
    const instrumenter = createInstrumenter(createInjector().provideValue(commonTokens.logger, quiet));
    return async (input) => (await instrumenter.instrument(input, { plugins: null, excludedMutations: [], ignorers: [] })).mutants;
  })();
  return instrumenterOnce;
}

/** Mutants per file, counted by Stryker's instrumenter. Only a file the dealing does not know needs it. */
async function countMutants(files) {
  if (files.length === 0) return [];
  const instrument = await instrumenter();
  const mutants = await instrument(files.map((name) => ({ name, content: readFileSync(name, 'utf8'), mutate: true })));
  const perFile = new Map(files.map((file) => [file, 0]));
  for (const mutant of mutants) perFile.set(mutant.fileName, (perFile.get(mutant.fileName) ?? 0) + 1);
  return files.map((file) => ({ file, mutants: perFile.get(file) ?? 0 }));
}

/** One file's mutants for `mutate` as Stryker passes it on: true, or mutation ranges with lines from 0. */
async function mutantsOf(file, mutate) {
  const instrument = await instrumenter();
  return instrument([{ name: file, content: readFileSync(file, 'utf8'), mutate }]);
}

/**
 * The lines to move a cut to: the one nearest `cut` that no mutant crosses,
 * between the start of the part before it and the end of the part after it
 * (exclusive of the latter). `crossing` is [{ from, to }] per mutant, lines from 1.
 */
function nearestFreeLine(cut, lo, hi, crossing) {
  const free = (line) => !crossing.some((m) => m.from <= line && m.to > line);
  for (let distance = 1; distance < hi - lo; distance++) {
    if (cut - distance >= lo && free(cut - distance)) return cut - distance;
    if (cut + distance < hi && free(cut + distance)) return cut + distance;
  }
  return null;
}

/**
 * Whether every file the dealing cuts in line ranges still has each of its
 * mutants in exactly one of them. Stryker runs the mutants that lie wholly
 * inside a range, so a mutant that crosses a cut is in neither part and no slice
 * runs it, and ranges that overlap run a mutant twice: both show as the parts
 * holding another number of mutants than the file has. `mutantsOf(file, mutate)`
 * is the instrumenter's mutants of the file for `mutate` as Stryker passes it on
 * (true, or ranges with lines from 0), the very ones a run of the part would
 * make. `files` are the files that exist; a file that is gone has nothing to
 * lose. Returns one text for each file that loses or doubles mutants, and none
 * when the parts hold the files.
 */
export async function rangeProblems(dealing, files, mutantsOf) {
  const present = new Set(files);
  const parts = new Map();
  for (const slice of dealing.slices) {
    for (const key of Object.keys(slice.files)) {
      const range = rangeOf(key);
      if (range) parts.set(baseOf(key), [...(parts.get(baseOf(key)) ?? []), { key, ...range }]);
    }
  }
  const problems = [];
  for (const [file, ranges] of [...parts].filter(([file]) => present.has(file)).sort(([a], [b]) => (a < b ? -1 : 1))) {
    ranges.sort((a, b) => a.from - b.from);
    const all = await mutantsOf(file, true);
    let held = 0;
    for (const { from, to } of ranges) {
      const mutate = [{ start: { line: from - 1, column: 0 }, end: { line: to - 1, column: Number.MAX_SAFE_INTEGER } }];
      held += (await mutantsOf(file, mutate)).length;
    }
    if (held === all.length) continue;
    const keys = ranges.map(({ key }) => key.slice(file.length));
    const crossing = all.map((m) => ({ from: m.location.start.line + 1, to: m.location.end.line + 1 }));
    const cuts = ranges.slice(0, -1).map(({ to }) => to);
    const isCrossed = (line) => crossing.some((m) => m.from <= line && m.to > line);
    // Each cut a mutant crosses moves to the nearest line none does, within the two parts it divides.
    const moved = cuts.map((to, i) => (isCrossed(to) ? nearestFreeLine(to, ranges[i].from, ranges[i + 1].to, crossing) : to));
    const movable = moved.every((line, i) => line !== null && line >= ranges[i].from && (i === 0 || line > moved[i - 1]));
    const off = Math.abs(all.length - held);
    const them = off === 1 ? 'it' : 'them';
    const effect =
      held < all.length
        ? `${off} ${off === 1 ? 'mutant lies' : 'mutants lie'} across a cut or outside the ranges, so no slice runs ${them}`
        : `${off} ${off === 1 ? 'mutant is' : 'mutants are'} in two ranges, so two slices run ${them}`;
    let fix;
    if (cuts.some(isCrossed) && movable) {
      const now = ranges.map(({ from, to }, i) => `:${i === 0 ? from : moved[i - 1] + 1}-${i === ranges.length - 1 ? to : moved[i]}`);
      const moves = cuts.flatMap((to, i) => (to === moved[i] ? [] : [`the cut at line ${to} to line ${moved[i]}`]));
      fix = `move ${moves.join(' and ')}, the nearest ${moves.length === 1 ? 'line' : 'lines'} no mutant crosses, so that the keys of ${file} in ${DEALING} are ${now.join(', ')} (the figures of the parts then move a few mutants; the point under each measured score is for that)`;
    } else if (cuts.some(isCrossed)) {
      fix = `no line near the cut is free of the mutants that cross it, so cut ${file} somewhere else in ${DEALING}`;
    } else {
      fix = `make the keys of ${file} in ${DEALING} follow on from one another, the first from line 1 and the last to line ${LAST_LINE}`;
    }
    problems.push(`${file} is dealt in the line ranges ${keys.join(', ')}, which hold ${held} mutants, and the file has ${all.length}: ${effect}. Fix it: ${fix}; or make a new dealing with --deal.`);
  }
  return problems;
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

/** A slice whose report holds fewer than this share of the mutants it was dealt is red until it is measured again. */
export const MIN_RAN = 0.9;

/**
 * The job's exit code. Stryker's own is kept when the run measured something,
 * but a run that did not is never a pass: Stryker scores NaN when there is
 * nothing valid to score, and `NaN < break` is false, so it exits 0 on a slice
 * whose files are all gone, whose range matches no mutant, or whose report is
 * empty. `ran` is the number of mutants in the report, `expected` those the
 * dealing gave the slice (and the new files placed in it).
 *
 * The floor is compared here too, on the report's own score, and not left to
 * Stryker's `thresholds.break`: a Stryker that read the threshold another way,
 * or was killed after it wrote the report, would otherwise pass a slice that is
 * under its floor. The comparison is Stryker's (`score < floor` fails, the
 * floor itself passes).
 */
export function exitCodeFor({ status, summary, ran, expected, floor }) {
  if (!Number.isFinite(floor)) throw new Error('exitCodeFor needs the slice\'s floor');
  const stryker = status ?? 1;
  if (summary === null) return { code: stryker || 1, reason: 'Stryker left no report' };
  if (summary.total.valid === 0) return { code: stryker || 1, reason: 'the report holds no valid mutant, and a score of n/a is not a pass' };
  if (summary.total.score < floor) {
    return { code: stryker || 1, reason: `the score ${pct(summary.total.score)} is under the slice's floor of ${floor} %, whatever Stryker's own exit code says` };
  }
  if (ran < expected * MIN_RAN) {
    return { code: stryker || 1, reason: `only ${ran} of the slice's ${expected} mutants were in the report (at least ${Math.ceil(expected * MIN_RAN)} are expected): Stryker finished, so a file in the slice has lost code or the slice is not the one that was dealt; if the code was removed on purpose, run --remeasure on this run's artifact to count the slice again and set its floor` };
  }
  if (status === null || status === undefined) return { code: 1, reason: 'Stryker was stopped by a signal after it wrote its report, so the run is not taken as finished' };
  return { code: stryker, reason: null };
}

/** What the summary says about how tonight's slice differs from the dealing. */
export function dealingNotes({ placed, gone }, n) {
  const lines = [];
  const here = placed.filter((p) => p.slice === n);
  if (here.length > 0) {
    lines.push(`Not in the dealing, placed in this slice by the rule (least seconds so far): ${here.map((p) => `${p.file} (${p.mutants} mutants)`).join(', ')}. The floor was measured without them.`);
  }
  if (placed.length > here.length) {
    lines.push(`Not in the dealing and placed in other slices: ${placed.filter((p) => p.slice !== n).map((p) => `${p.file} → slice ${p.slice}`).join(', ')}.`);
  }
  if (gone.length > 0) lines.push(`In the dealing and gone: ${gone.join(', ')}.`);
  return lines;
}

export function summaryMarkdown({ slice, of, mutants, files, floor, measured, notes = [] }, summary) {
  const lines = [`## Mutation slice ${slice} of ${of}`, ''];
  if (!summary) {
    lines.push(`No report: Stryker did not finish (${mutants} mutants in ${files.length} files). The job log has its progress.`);
    return lines.join('\n') + '\n';
  }
  const { total } = summary;
  const verdict = total.score === null ? 'no valid mutants' : total.score >= floor ? 'at or above its floor' : 'UNDER ITS FLOOR';
  lines.push(
    `**Score ${pct(total.score)}** against this slice's floor of ${floor} % (${verdict}) and the target of ${TARGET} %: ` +
      `${total.detected} of ${total.valid} mutants detected, ${total.undetected} not, in ${files.length} files. Dealing measured ${measured}.`,
    ...notes.map((note) => `\n${note}`),
    '',
    '| File | Score | Detected | Survived | No coverage |',
    '| :--- | ---: | ---: | ---: | ---: |',
    ...summary.files.map((f) => `| ${f.file} | ${pct(f.score)} | ${f.detected} | ${f.survived} | ${f.noCoverage} |`),
  );
  return lines.join('\n') + '\n';
}

const number = (n) => String(n).padStart(6);
const minutes = (seconds) => `${Math.round(seconds / 60)} min`;

/** The lines that say what a slice runs: its files with mutants and seconds, `new` and the mutants counted for a file the dealing did not know. */
export function sliceLines(s, n, of, floor, files, notes, placed = []) {
  const lines = [`Slice ${n} of ${of}: ${s.mutants} mutants in ${files.length} files, about ${minutes(s.seconds)} of mutation testing, floor ${floor} %`];
  for (const file of files) {
    const dealt = s.files[file];
    const added = placed.find((p) => p.file === file);
    lines.push(`${number(dealt?.mutants ?? added?.mutants ?? 0)}  ${dealt ? `${String(Math.round(dealt.seconds)).padStart(5)} s` : '  new  '}  ${file}`);
  }
  return [...lines, ...notes];
}

function printSlice(...args) {
  for (const line of sliceLines(...args)) console.log(line);
}

function parseArgs(argv, env) {
  const flag = (name) => argv.includes(name);
  const value = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  return {
    asked: value('--slice') || env.MUTATION_SLICE || '',
    plan: flag('--plan'),
    checkRanges: flag('--check-ranges'),
    list: flag('--list'),
    deal: flag('--deal'),
    remeasure: value('--remeasure') ?? null,
    lower: flag('--lower'),
    of: value('--of'),
    run: value('--run') ?? null,
    splits: argv.flatMap((a, i) => (a === '--split' ? [argv[i + 1]] : [])),
    inputs: flag('--deal') ? argv.filter((a, i) => !a.startsWith('--') && !['--of', '--run', '--split'].includes(argv[i - 1])) : [],
  };
}

function loadDealing() {
  if (!existsSync(DEALING)) throw new Error(`${DEALING} is missing: make it with --deal from a measured run of every slice`);
  return JSON.parse(readFileSync(DEALING, 'utf8'));
}

async function makeDealing({ of, run, inputs, splits }) {
  const count = Number(of);
  if (!Number.isInteger(count) || count < 1) throw new Error('--deal needs --of <number of slices>');
  if (inputs.length === 0) throw new Error('--deal needs the file-times.json of every slice of a measured run');
  const measured = new Map();
  for (const path of inputs) {
    for (const [file, m] of Object.entries(JSON.parse(readFileSync(path, 'utf8')).files ?? {})) {
      if (measured.has(file)) throw new Error(`${file} is measured twice (${path})`);
      measured.set(file, m);
    }
  }
  for (const split of splits) {
    const m = /^(.+)=(\d+)@(.+)$/.exec(split);
    if (!m) throw new Error(`--split wants <file>=<parts>@<mutation.json>, got '${split}'`);
    const [, file, parts, report] = m;
    const entry = measured.get(file);
    if (!entry) throw new Error(`--split: ${file} is not among the measured files`);
    measured.delete(file);
    const mutants = JSON.parse(readFileSync(report, 'utf8')).files[file]?.mutants;
    if (!mutants) throw new Error(`--split: ${report} has no mutants for ${file}`);
    for (const [key, part] of splitEntry(file, entry, mutants, Number(parts))) measured.set(key, part);
  }
  // A file in `mutate` that no run reported on has no mutants (a type-only file) or was not measured.
  const reported = new Set([...measured.keys()].map(baseOf));
  const silent = filesToMutate(JSON.parse(readFileSync(BASE_CONFIG, 'utf8')).mutate).filter((f) => !reported.has(f));
  const unmeasured = (await countMutants(silent)).filter((c) => c.mutants > 0).map((c) => c.file);
  if (unmeasured.length > 0) throw new Error(`these files have mutants and no measurement: ${unmeasured.join(', ')}`);
  for (const file of silent) measured.set(file, { ms: 0, mutants: 0, statuses: {} });
  const dealing = deal(measured, count, { run });
  writeFileSync(DEALING, JSON.stringify(dealing, null, 2) + '\n');
  console.log(`${measured.size} files dealt into ${count} slices, written to ${DEALING}`);
  for (const s of dealing.slices) console.log(`slice ${s.slice}: ${minutes(s.seconds)}, ${s.mutants} mutants in ${Object.keys(s.files).length} files, score ${s.score} %, floor ${s.floor} %`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2), process.env);

  if (args.deal) {
    await makeDealing(args);
    return 0;
  }

  if (args.remeasure) {
    const dir = args.remeasure;
    const { slice: n } = JSON.parse(readFileSync(join(dir, 'slice.json'), 'utf8'));
    const before = loadDealing();
    const after = remeasure(
      before,
      n,
      {
        report: JSON.parse(readFileSync(join(dir, 'mutation.json'), 'utf8')),
        times: JSON.parse(readFileSync(join(dir, 'file-times.json'), 'utf8')),
      },
      { lower: args.lower },
    );
    writeFileSync(DEALING, JSON.stringify(after, null, 2) + '\n');
    const [was, is] = [before.slices[n], after.slices[n]];
    console.log(`slice ${n}: score ${was.score} % → ${is.score} %, floor ${was.floor} % → ${is.floor} %, ${minutes(was.seconds)} → ${minutes(is.seconds)}`);
    return 0;
  }

  const dealing = loadDealing();
  const of = dealing.slices.length;

  if (args.plan) {
    // Two lines for $GITHUB_OUTPUT; needs nothing installed.
    console.log(`slices=${JSON.stringify(plan({ input: args.asked, of }))}`);
    console.log(`of=${of}`);
    return 0;
  }

  const base = JSON.parse(readFileSync(BASE_CONFIG, 'utf8'));
  const files = filesToMutate(base.mutate);
  const known = new Set(dealing.slices.flatMap((s) => Object.keys(s.files).map(baseOf)));

  if (args.checkRanges) {
    const problems = await rangeProblems(dealing, files, mutantsOf);
    for (const problem of problems) console.error(problem);
    if (problems.length === 0) console.log('Every file dealt in line ranges has each of its mutants in exactly one range.');
    return problems.length > 0 ? 1 : 0;
  }

  const placement = placeNew(dealing, files, await countMutants(files.filter((f) => !known.has(f))));

  if (args.list) {
    const wanted = args.asked === '' ? 'all' : args.asked;
    if (wanted === 'all') {
      console.log(`${dealing.slices.reduce((sum, s) => sum + s.mutants, 0)} mutants in ${known.size} files, ${of} slices, measured ${dealing.measured}${dealing.run ? ` (run ${dealing.run})` : ''}`);
      for (const s of dealing.slices) {
        console.log(`slice ${String(s.slice).padStart(2)}: ${minutes(s.seconds).padStart(7)}, ${number(s.mutants)} mutants in ${String(Object.keys(s.files).length).padStart(2)} files, score ${String(s.score).padStart(5)} %, floor ${s.floor} %`);
      }
      for (const line of dealingNotes(placement, -1)) console.log(line);
    } else {
      for (const n of plan({ input: wanted, of })) {
        printSlice(dealing.slices[n], n, of, dealing.slices[n].floor, filesOf(dealing, n, files, placement.placed), dealingNotes(placement, n), placement.placed);
      }
    }
    return 0;
  }

  const [n] = plan({ input: args.asked, of });
  // A cut that a mutant crosses loses it from every slice: found before the slice is run.
  const crossed = await rangeProblems(dealing, files, mutantsOf);
  const chosen = dealing.slices[n];
  const sliceFiles = filesOf(dealing, n, files, placement.placed);
  const notes = dealingNotes(placement, n);
  const dir = join(REPORTS, `slice-${n}`);
  mkdirSync(dir, { recursive: true });

  if (process.env.GITHUB_ACTIONS) console.log('::group::The slice');
  printSlice(chosen, n, of, chosen.floor, sliceFiles, notes, placement.placed);
  if (process.env.GITHUB_ACTIONS) console.log('::endgroup::');
  // Said here, outside the collapsed group, and again in the summary; the slice is run all the same, since its score is true, and the night is red.
  for (const problem of crossed) console.error(`${process.env.GITHUB_ACTIONS ? '::error::' : ''}${problem}`);

  if (sliceFiles.length === 0) {
    console.error(`Slice ${n} has no file to mutate: every file in the dealing is gone. A night that mutated nothing is not a pass; make a new dealing with --deal.`);
    return 1;
  }

  const configPath = join(dir, 'stryker.conf.json');
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        ...base,
        slice_comment: `Slice ${n} of ${of}, written by scripts/mutation-slice.mjs: \`mutate\` is this slice's files, \`thresholds.break\` its floor, the reports carry its number.`,
        mutate: sliceFiles,
        thresholds: { ...base.thresholds, break: chosen.floor },
        // Beside Stryker's own: what each file cost, see mutation-timing-reporter.mjs.
        plugins: [...(base.plugins ?? ['@stryker-mutator/*']), './scripts/mutation-timing-reporter.mjs'],
        reporters: [...(base.reporters ?? []), 'timing'],
        htmlReporter: { fileName: join(dir, 'index.html') },
        jsonReporter: { fileName: join(dir, 'mutation.json') },
      },
      null,
      2,
    ) + '\n',
  );
  const slice = { slice: n, of, mutants: chosen.mutants, floor: chosen.floor, measured: dealing.measured, files: sliceFiles, notes: [...notes, ...crossed] };
  writeFileSync(join(dir, 'slice.json'), JSON.stringify({ ...slice, date: new Date().toISOString() }, null, 2) + '\n');

  // A report left by an earlier run of the slice is not this run's: without it, a Stryker that dies is read as the one that finished.
  rmSync(join(dir, 'mutation.json'), { force: true });

  const stryker = spawnSync(join('node_modules', '.bin', 'stryker'), ['run', configPath], {
    stdio: 'inherit',
    env: { ...process.env, MUTATION_TIMING_FILE: join(dir, 'file-times.json') },
  });

  const reportPath = join(dir, 'mutation.json');
  const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null;
  const summary = report === null ? null : summarise(report);
  const markdown = summaryMarkdown(slice, summary);
  writeFileSync(join(dir, 'summary.md'), markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  console.log(markdown.split('\n').slice(0, 3).join('\n'));
  // The log keeps the ten weakest files, so a red night is readable without the artifact.
  for (const f of summary?.files.slice(0, 10) ?? []) {
    console.log(`${pct(f.score).padStart(9)}  ${String(f.survived).padStart(4)} survived  ${String(f.noCoverage).padStart(4)} no coverage  ${f.file}`);
  }

  const ran = Object.values(report?.files ?? {}).reduce((sum, f) => sum + f.mutants.length, 0);
  const expected = expectedMutants(chosen.files, sliceFiles, placement.placed);
  const { code, reason } = exitCodeFor({ status: stryker.status, summary, ran, expected, floor: chosen.floor });
  if (reason !== null) console.error(`Slice ${n}: ${reason}.`);
  if (crossed.length > 0) console.error(`Slice ${n}: the line ranges lose mutants (above), so the night is red until a cut is moved or the dealing is made again.`);
  return crossed.length > 0 ? code || 1 : code;
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
