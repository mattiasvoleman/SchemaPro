import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * The repository is public and already names a school. What the M5 documents say about the one school
 * whose weeks the corpus is shaped after must therefore stay a form: no count, no date, no run history
 * (review of #386, M-8, took the figures out of the corpus module; this keeps them out of the documents
 * that quote it). A test cannot hold the figures themselves, since a file that names them is the leak,
 * so it holds the shapes of statement that carried them in the first draft of #395:
 *
 *   - "answered TIMEOUT in <a month>" and any sentence about "its Generera runs" or "the runs that found a
 *     timetable": a customer's run history, with a date;
 *   - "the one filled school", "the filled school": that there is exactly one;
 *   - "the size (and shape) of the real school": a corpus week's size given as the school's;
 *   - a manual that tells a school what happened to "a week" in "an earlier analysis": the same history,
 *     told without a name.
 *
 * The last describe runs the checker on sentences with one fault each, so that a check that stops looking
 * turns this red.
 */

const ROOT = join(__dirname, '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

const MONTH = '(?:January|February|March|April|May|June|July|August|September|October|November|December)';

const SHAPES: ReadonlyArray<readonly [RegExp, string]> = [
  [new RegExp(`(?:TIMEOUT|Generera)[^.\\n]{0,80}\\b(?:in|during|since|on)\\s+${MONTH}\\b`), 'a run history with a month'],
  [/\b(?:its|their|the school's) Generera runs\b|\bruns that found a timetable\b|\bthe runs that\b/i, "a customer's run history"],
  [/\b(?:the|its) (?:one |only )?filled school\b/i, 'that there is exactly one school filled in'],
  [/\b(?:size|shape)(?: and (?:shape|size))? of the real school\b/i, "a corpus week's size given as the school's"],
  [/\bi en tidigare analys\b|\bsom motorn inte lagt på\b/i, 'an earlier analysis of one school, told without a name'],
];

/** What in `text` carries the shapes above, as sentences; empty when nothing does. */
function leaks(text: string): string[] {
  const flat = text.replace(/\s+/g, ' ');
  return SHAPES.flatMap(([shape, why]) => {
    const found = shape.exec(flat);
    return found ? [`"${found[0]}": ${why}`] : [];
  });
}

/** From the heading of section 35 of DEPLOYMENT.md to the next section's, or the end. */
function section35(): string {
  const text = read('docs/DEPLOYMENT.md');
  const from = text.indexOf('\n## 35. ');
  if (from < 0) throw new Error('DEPLOYMENT.md has no section 35');
  const next = text.indexOf('\n## 36. ', from);
  return text.slice(from, next < 0 ? undefined : next);
}

/** Section 5.2 of the user manual: from its heading to the next h3. */
function manual52(): string {
  const text = read('docs/manual/anvandarmanual.html');
  const from = text.indexOf('<h3 id="s52">');
  const next = text.indexOf('<h3 id="s53">', from);
  if (from < 0 || next < 0) throw new Error('the manual has no section 5.2');
  return text.slice(from, next);
}

describe('the M5 documents describe the school by its form and say nothing of its runs', () => {
  it('DEPLOYMENT.md section 35', () => {
    expect(leaks(section35())).toEqual([]);
  });
  it('docs/solve-corpus-measurement.md', () => {
    expect(leaks(read('docs/solve-corpus-measurement.md'))).toEqual([]);
  });
  it('the user manual, section 5.2', () => {
    expect(leaks(manual52())).toEqual([]);
  });
});

describe('the checker sees what it is for', () => {
  it.each([
    ['a week that answered TIMEOUT in March', 1],
    ["The school's Generera runs ended in a refusal", 1],
    ['the runs that found a timetable were few', 1],
    ['The only filled school in production is shaped otherwise', 1],
    ['a week of the size of the real school', 1],
    ['i en tidigare analys lades en vecka som motorn inte lagt på tjugo minuter', 1],
    ['That is the kind of week that has made Generera answer TIMEOUT, and no bench had it', 0],
    ['a school of that form is within a few classes of the engine limit', 0],
  ])('%s', (sentence, expected) => {
    expect(leaks(sentence).length).toBeGreaterThanOrEqual(expected);
    if (expected === 0) expect(leaks(sentence)).toEqual([]);
  });
});
