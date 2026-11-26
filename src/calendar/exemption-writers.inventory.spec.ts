import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ts from 'typescript';

/**
 * NO AUTOMAT GIVES AN EXEMPTION, AND NO WRITE PATH GIVES ONE WITHOUT THE REQUEST NAMING THE RULE (Undantag med flit, E1b).
 *
 * `MasterLessons.exemptFrom` is written by an administrator who answered the question "Lägg ändå" for a time, or put back as it was: so the
 * files that SET the property (an object property `exemptFrom: …` that is not a `select`'s `true`) are a short list, each with the reason it
 * is on it, and Generera, the swaps, the room optimization and the förläggning are not on it. A new file that sets it fails here until
 * it is named, with what it writes it for. The trigger MasterLessons_exemption_ends ends an exemption any other writer leaves across a changed
 * time (probe-undantag.ts); this keeps the list of writers that mean to keep one.
 */

const ROOT = join(__dirname, '..', '..');
const SRC = join(ROOT, 'src');

const SETTERS: Record<string, string> = {
  'src/calendar/lesson-exemption.ts': 'the key a lesson’s result carries (exemptionKey): only a lesson that has one says so; a swap’s log and answer use it too',
  'src/calendar/master-lessons.service.ts': 'the PATCH and the create that name the rule (`exempt`), the result that says it, and the block card whose members lose it',
  'src/calendar/schedule-versions.service.ts': 'a version’s snapshot and its restore: the lesson put back as the exemption it was',
  'src/publication/draft.service.ts': 'a discarded draft: the lesson as it was published',
  'src/publication/published-grundschema.ts': 'the publication’s own copy of the lessons, and the read of it',
  'src/publication/publication-gates.reader.ts': 'the publication check’s read of the lessons, to count them (PUB_EXEMPTIONS)',
  'src/schedule-exchange/exchange.service.ts': 'the schedule file: the import of a lesson whose file names the rule, and the export that says it',
};

const AUTOMATS = ['src/optimization/', 'src/swaps/', 'src/requirement-placements/'];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === '__fixtures__' ? [] : sources(path);
    return /\.ts$/.test(entry.name) && !/\.(?:spec|e2e-spec)\.ts$/.test(entry.name) ? [path] : [];
  });
}

/** Whether a file sets a property called exemptFrom (a select's `exemptFrom: true` reads and sets nothing). */
function sets(text: string, path: string): boolean {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && node.name.getText() === 'exemptFrom' && node.initializer.kind !== ts.SyntaxKind.TrueKeyword) found = true;
    if (ts.isShorthandPropertyAssignment(node) && node.name.text === 'exemptFrom') found = true;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('the files that set a lesson’s exemption', () => {
  const setters = sources(SRC)
    .map((path) => ({ file: relative(ROOT, path), text: readFileSync(path, 'utf8'), path }))
    .filter(({ text, path }) => sets(text, path))
    .map(({ file }) => file);

  it('are the ones this list names, each for the reason it gives', () => {
    expect(setters.sort()).toEqual(Object.keys(SETTERS).sort());
  });

  it('are none of the automats: Generera, a swap, the room optimization and the förläggning give no exemption and move no lesson that has one', () => {
    expect(setters.filter((file) => AUTOMATS.some((dir) => file.startsWith(dir)))).toEqual([]);
  });
});
