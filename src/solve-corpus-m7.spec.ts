import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * The answer to M7 ("is the Python part of a solve what costs time?") is a share computed over the weeks of the
 * count measurement that have stage times, and the documents quote it with the number of those weeks and the
 * ranges behind it. The first draft of #395 quoted 27 weeks (the number of weeks that were also run on eight cores;
 * 39 got a timetable and have stage times) and a range of 1.5 to 40 s (the weeks run from 1.1 to 144 s). This
 * recomputes the figures from the JSON and holds the two documents to them, and to saying that a week which timed
 * out has no stage times, so the share is that of the weeks small enough to be laid.
 */

interface Week {
  status: string;
  stages: Record<string, number>;
  firstScheduleSeconds: number | null;
  load: [number, number];
}

const ROOT = join(__dirname, '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8').replace(/\s+/g, ' ');
const weeks = (JSON.parse(readFileSync(join(ROOT, 'docs/solve-corpus-measurement.json'), 'utf8')) as Week[]).filter(
  (week) => week.status === 'FIRST_SCHEDULE',
);

const python = (week: Week): number => (week.stages.PRECHECKS ?? 0) + (week.stages.BUILD ?? 0);
const share = weeks.map((week) => python(week) / (week.firstScheduleSeconds ?? 1)).sort((a, b) => a - b);
const median = share.length % 2 ? share[(share.length - 1) / 2]! : (share[share.length / 2 - 1]! + share[share.length / 2]!) / 2;
const pct = (value: number): string => String(Math.round(value * 100));
const seconds = weeks.map((week) => week.firstScheduleSeconds ?? 0);
const loads = weeks.flatMap((week) => week.load);

const figures = {
  n: weeks.length,
  median: pct(median),
  low: pct(share[0]!),
  high: pct(share[share.length - 1]!),
  pythonLow: Math.min(...weeks.map(python)).toFixed(1),
  pythonHigh: Math.max(...weeks.map(python)).toFixed(1),
  totalLow: Math.min(...seconds).toFixed(1),
  totalHigh: String(Math.round(Math.max(...seconds))),
  loadLow: String(Math.round(Math.min(...loads))),
  loadHigh: String(Math.round(Math.max(...loads))),
};

describe('the answer to M7 is the share the measurement gives', () => {
  it('is over the weeks that have stage times, and no week that timed out is one of them', () => {
    const all = JSON.parse(readFileSync(join(ROOT, 'docs/solve-corpus-measurement.json'), 'utf8')) as Week[];
    expect(all.filter((week) => Object.keys(week.stages).length > 0).length).toBe(figures.n);
    expect(all.filter((week) => week.status !== 'FIRST_SCHEDULE').every((week) => Object.keys(week.stages).length === 0)).toBe(true);
  });

  it('DEPLOYMENT.md 35.4 quotes it', () => {
    const text = read('docs/DEPLOYMENT.md');
    expect(text).toContain(`On the ${figures.n} weeks of the sweep that got a timetable it is **${figures.median} % in the median (${figures.low} % to ${figures.high} %)**`);
    expect(text).toContain(`${figures.pythonLow} to ${figures.pythonHigh} s of ${figures.totalLow} to ${figures.totalHigh} s (one worker, at loads of ${figures.loadLow} to ${figures.loadHigh})`);
    expect(text).toContain('The stage times exist only for weeks that got a timetable');
  });

  it('the record quotes it', () => {
    const text = read('docs/solve-corpus-measurement.md');
    expect(text).toContain(`${figures.median} % of the time to the first timetable in the median (${figures.low} to ${figures.high} %) on one core, over the ${figures.n} weeks that got a timetable`);
    expect(text).toContain(`${figures.pythonLow} to ${figures.pythonHigh} s of ${figures.totalLow} to ${figures.totalHigh} s (loads ${figures.loadLow} to ${figures.loadHigh})`);
    expect(text).toContain('The weeks that time out have no stage times');
  });

  it('the record counts the weeks it did not measure as the sweep minus the measured', () => {
    const text = read('docs/solve-corpus-measurement.md');
    const swept = Number(/77 of its (\d+) weeks/.exec(text)?.[1]);
    const word = ['none', 'one', 'two', 'three', 'four', 'five', 'six', 'seven'][swept - 77] ?? String(swept - 77);
    expect(text).toContain(`The ${word} weeks of the second seed`);
  });
});
