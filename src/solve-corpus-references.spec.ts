import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * The files of the solver corpus (the report, the measurer, the generator, the nightly job, the gate) name the
 * section of docs/DEPLOYMENT.md that describes them by its number, and the numbers of that file collide: two
 * branches each take the next one. #394 was written when the corpus section was to be 33; G6 took 33 and 34
 * first and the corpus is 35, so its two references said "§33" (the section about changes that would let a
 * refused week be laid). This holds every such reference in the corpus's own files to a section that is about
 * the corpus, so that the next collision turns the build red instead of sending a reader to another section.
 */

const ROOT = join(__dirname, '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

const REFERENCE = /DEPLOYMENT(?:\.md)? §(\d+)/g;

/** The corpus's own files, and the part of the nightly workflow that is its job (with the comment above it). */
function corpusTexts(): Array<[string, string]> {
  const files = [
    'optimization-engine/benchmarks/school_corpus.py',
    'optimization-engine/benchmarks/corpus_measure.py',
    'optimization-engine/benchmarks/corpus_report.py',
    'scripts/bench/solve-corpus-gate.mjs',
    'docs/solve-corpus-measurement.md',
  ];
  const texts: Array<[string, string]> = files.filter((file) => existsSync(join(ROOT, file))).map((file) => [file, read(file)]);
  const workflow = '.github/workflows/quality-gates.yml';
  if (existsSync(join(ROOT, workflow))) {
    const lines = read(workflow).split('\n');
    const job = lines.findIndex((line) => line === '  solver-corpus:');
    if (job >= 0) {
      const end = lines.findIndex((line, index) => index > job && /^  [a-z-]+:$/.test(line));
      texts.push([workflow, lines.slice(Math.max(0, job - 12), end < 0 ? undefined : end).join('\n')]);
    }
  }
  return texts;
}

/** The sections of DEPLOYMENT.md that a reference in `text` points to but that are not about the corpus. */
function wrongReferences(text: string, deployment: string): string[] {
  const wrong: string[] = [];
  for (const match of text.matchAll(REFERENCE)) {
    const number = match[1]!;
    const heading = new RegExp(`^## ${number}\\. (.*)$`, 'm').exec(deployment)?.[1] ?? '(no such section)';
    if (!/solver corpus/i.test(heading)) wrong.push(`§${number} is "${heading}"`);
  }
  return wrong;
}

describe('the corpus names the section of DEPLOYMENT.md that is about it', () => {
  const deployment = read('docs/DEPLOYMENT.md');

  it('has a section about the corpus', () => {
    expect(/^## \d+\. The solver corpus/m.test(deployment)).toBe(true);
  });

  it.each(corpusTexts())('%s', (_file, text) => {
    expect(wrongReferences(text, deployment)).toEqual([]);
  });

  it('sees a reference to another section', () => {
    const sample = '## 33. Changes that would let a refused week be laid\n\n## 35. The solver corpus: weeks\n';
    expect(wrongReferences('see docs/DEPLOYMENT.md §33', sample)).toEqual(['§33 is "Changes that would let a refused week be laid"']);
    expect(wrongReferences('see DEPLOYMENT.md §35 and DEPLOYMENT §35', sample)).toEqual([]);
    expect(wrongReferences('DEPLOYMENT.md §99', sample)).toEqual(['§99 is "(no such section)"']);
  });
});
