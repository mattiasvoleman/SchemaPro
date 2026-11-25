import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ts from 'typescript';

/**
 * NO WRITE PATH OF THE GRUNDSCHEMA'S LESSONS ANSWERS 409 WITHOUT A CODE (En domare med ord, E1).
 *
 * A refusal a client cannot tell from another is a sentence the client can only show: the web words a coded problem in the
 * reader's language and puts the other lesson's class, subject, day and time in it (common.codes), and the mobile app and an older
 * web read `detail`, `code` and `params` and nothing else. A 409 that is a bare sentence was the hand edit's own until this phase
 * (MasterLessonsService threw `new ConflictException(unique.join(' '))` at three places) and is the swaps' apply's clash today
 * unless the next line says otherwise.
 *
 * This reads src/ (not the specs) and fails on:
 *
 *  1. a file that writes a MasterLesson (a `masterLesson.create|update|…` call, or raw SQL that inserts into, updates or deletes
 *     from "MasterLessons") that is not in WRITERS: a new writer is named here, and its refusals are held to the rule below;
 *  2. a `new ConflictException(...)` in one of WRITERS whose argument is not an object literal with a `code`.
 *
 * What a 400 or a 404 is told in is not in question here; only the conflict, which is the answer to "you cannot, because of the
 * rest of the timetable" and the one a person acts on.
 */

const ROOT = join(__dirname, '..', '..');
const SRC = join(ROOT, 'src');

/** Every file of src/ that writes a master lesson, and what it writes it for. */
const WRITERS: Record<string, string> = {
  'src/calendar/master-lessons.service.ts': 'the hand edit: create, PATCH, a block card, lock, delete',
  'src/swaps/swaps.service.ts': 'Byten och flyttar: apply',
  'src/calendar/schedule-versions.service.ts': 'restore of a version',
  'src/publication/draft.service.ts': 'discard and refill of a draft',
  'src/optimization/room-optimization.service.ts': 'apply of a room proposal',
  'src/optimization/optimization-proxy.service.ts': 'Generera’s write-back and the candidate’s apply',
  'src/schedule-exchange/exchange.service.ts': 'the timetable import’s apply',
};

const WRITE_CALL = /\bmasterLesson\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/;
const WRITE_SQL = /(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"MasterLessons"/i;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === '__fixtures__' ? [] : sources(path);
    return /\.ts$/.test(entry.name) && !/\.(?:spec|e2e-spec)\.ts$/.test(entry.name) ? [path] : [];
  });
}

const files = sources(SRC).map((path) => ({ path, file: relative(ROOT, path), text: readFileSync(path, 'utf8') }));

/** `new ConflictException(...)` expressions of a file, with whether the argument is an object literal that names a `code`. */
function conflicts(text: string, path: string): Array<{ line: number; coded: boolean }> {
  const found: Array<{ line: number; coded: boolean }> = [];
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'ConflictException') {
      const argument = node.arguments?.[0];
      const coded =
        argument !== undefined &&
        ts.isObjectLiteralExpression(argument) &&
        argument.properties.some((property) => (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) && property.name.getText() === 'code');
      found.push({ line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, coded });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('the writers of the grundschema’s lessons', () => {
  it('are the ones this list names: a new writer says here that its refusals have a code', () => {
    const writers = files.filter(({ text }) => WRITE_CALL.test(text) || WRITE_SQL.test(text)).map(({ file }) => file);
    expect(writers.sort()).toEqual(Object.keys(WRITERS).sort());
  });

  it.each(Object.keys(WRITERS))('%s: every 409 it throws has a code', (file) => {
    const { text, path } = files.find((entry) => entry.file === file)!;
    const uncoded = conflicts(text, path).filter((entry) => !entry.coded);
    expect(uncoded.map((entry) => `${file}:${entry.line}`)).toEqual([]);
  });
});
