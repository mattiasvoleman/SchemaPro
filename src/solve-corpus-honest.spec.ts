import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * What the manual's table answers is "when was the first timetable found, on one core of a development machine, in
 * the slowest of the measured weeks". It sits under the question "Hur lång tid tar en körning?", and a school reads
 * a seconds column under that question as how long the run takes. It does not: after the first timetable
 * the engine spends the rest of the run's time improving it (phase 2, `solve()`), so a run that found one in nine
 * seconds goes on for as long as the run may. This holds the manual to saying so, to calling its seconds
 * estimates for one core, to promising nothing to a school, and to saying what a class count counts (all the
 * measured weeks are åk 7-9 with the same number of classes in each year, but the largest).
 */

const ROOT = join(__dirname, '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

const manual = read('docs/manual/anvandarmanual.html');
const section = manual.slice(manual.indexOf('id="hur-lang-tid"'), manual.indexOf('<h3 id="s53">'));
const text = section.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');

describe('the manual, 5.2, says what its table measures', () => {
  it('says the seconds are those of the first timetable and that the run goes on after it', () => {
    expect(text).toContain('inte hur länge körningen pågår');
    expect(text).toContain('förbättrar motorn schemat');
  });

  it('promises nothing to a single school', () => {
    expect(text).toContain('inget löfte för en enskild skola');
  });

  it('says what a class count counts', () => {
    expect(text).toContain('åk 7–9 med lika många klasser i varje årskurs');
  });

  it('calls a time that ran out a minimum, and says more cores can change it', () => {
    expect(text).toMatch(/minst<\/em>|minst så lång tid/);
    expect(text).toContain('med flera kärnor kan det gå');
  });

  it('heads the first table as estimates for one core', () => {
    expect(section).toContain('<th>Första schemat inom (cirka, en kärna)</th>');
    expect(section).not.toContain('<th>Schema inom</th>');
  });

  it('heads the eight-core column as one run on a loaded machine', () => {
    expect(section).toContain('<th>Åtta kärnor (en körning, belastad dator)</th>');
  });
});

describe('the record does not set one core of a development machine beside production as if they were alike', () => {
  it.each(['docs/DEPLOYMENT.md', 'docs/solve-corpus-measurement.md'])('%s', (file) => {
    expect(read(file)).not.toMatch(/close to (?:the )?production(?:'s| budget)/);
  });
});
