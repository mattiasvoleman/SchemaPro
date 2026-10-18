import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';

/*
 * The product is Rastra (decided 2026-10-17): Rastra Schema in Swedish and
 * Rastra timetable in English for the web app and everything but the mobile
 * apps, which are Rastra and Rastra vårdnadshavare. Nothing a user, guardian,
 * pupil or integrator reads may say SchemaPro.
 *
 * What counts as read: every string and JSX text in the gateway's and the
 * web's code (not comments, specs or tests), the message catalogues, the
 * user-facing documents and the accessibility-tree baselines. The old name
 * stays only in the identifiers below, which something stored or integrated
 * derives from. A hit is text a branch added before the rename, and the
 * rename script (rastra-namn-rename.py in the round's shared notes) or a hand
 * edit puts the new name in.
 */

const ROOT = join(__dirname, '..');

/** Identifiers that keep the old name, each with why. */
const KEPT: ReadonlyArray<readonly [RegExp, string]> = [
  [/X-SchemaPro-[A-Za-z*]+/gi, "the app's client header and the webhook's signing headers: a receiver verifies by these names"],
  [/SchemaPro-SS12000-Webhook/g, "the webhook's User-Agent, which a receiver may match on"],
  // Not followed by a dot or a word character, so an address such as kontakt@schemapro.se still counts.
  [/@schemapro(?![.\w-])/g, 'the ICS UIDs: a changed UID duplicates every subscribed event'],
  [/schemapro\.(?:scheduleRules|optimizationWeights)/g, "browser storage keys: a renamed key forgets the user's settings"],
  [/schemapro(?:UserId|Invitation)/g, 'Supabase Auth metadata keys on every invited login'],
  [/SCHEMAPRO_SS12000_NAMESPACE/g, 'the namespace every derived SS12000 id comes from'],
  [/noreply@schemapro\.app/g, 'the sending domain'],
  [/schemapro(?:-dev)?:\/\//g, "the mobile app's URL scheme"],
  [/formerly SchemaPro\b/g, 'the rename, said where the product is named'],
];

const tracked = (patterns: string[]): string[] =>
  execFileSync('git', ['ls-files', '-z', '--', ...patterns], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);

// A git pathspec's * crosses directories, so src/*.ts is every .ts under src/.
const CODE = tracked(['src/*.ts', 'web/app/*.ts', 'web/app/*.tsx', 'web/components/*.ts', 'web/components/*.tsx', 'web/lib/*.ts', 'web/lib/*.tsx']).filter(
  (path) => !/\.(spec|test)\.tsx?$/.test(path) && !path.includes('/__fixtures__/'),
);

const DOCUMENTS = tracked([
  'web/messages/*.json',
  'docs/manual/*.html',
  'docs/integration-api.md',
  'docs/tillganglighetsredogorelse.md',
  'docs/skarmlasartest.md',
  'README.md',
  'PRODUCT.md',
  'DESIGN.md',
  'web/e2e/aria-baselines/*.yml',
]);

/** What is left of `text` once the kept identifiers are taken out, if it still names SchemaPro. */
function oldName(text: string): string | null {
  let rest = text;
  for (const [pattern] of KEPT) rest = rest.replace(pattern, '');
  return /schemapro/i.test(rest) ? text.trim().slice(0, 160) : null;
}

/** The strings and JSX text of a source file, with their lines; comments are not tokens here. */
function texts(path: string, source: string): Array<{ line: number; text: string }> {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: Array<{ line: number; text: string }> = [];
  const add = (node: ts.Node, text: string) => found.push({ line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, text });
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node)) add(node, node.text);
    else if (ts.isTemplateExpression(node)) {
      add(node.head, node.head.text);
      for (const span of node.templateSpans) add(span.literal, span.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe('the product name (Rastra, 2026-10-17)', () => {
  it('reads every surface it guards', () => {
    expect(CODE.length).toBeGreaterThan(500);
    expect(CODE).toEqual(expect.arrayContaining(['src/main.ts', 'src/notifications/push-messages.ts', 'web/app/[locale]/layout.tsx']));
    expect(DOCUMENTS).toEqual(
      expect.arrayContaining([
        'web/messages/sv.json',
        'web/messages/en.json',
        'docs/manual/anvandarmanual.html',
        'docs/integration-api.md',
        'docs/tillganglighetsredogorelse.md',
        'README.md',
        'PRODUCT.md',
      ]),
    );
  });

  it('is never SchemaPro in a string or JSX text of the gateway or the web', () => {
    const left: string[] = [];
    for (const path of CODE) {
      const source = readFileSync(join(ROOT, path), 'utf8');
      if (!/schemapro/i.test(source)) continue;
      for (const { line, text } of texts(path, source)) {
        const hit = oldName(text);
        if (hit) left.push(`${path}:${line}: ${hit}`);
      }
    }
    expect(left).toEqual([]);
  });

  it('is never SchemaPro in the messages, the user-facing documents or the accessibility baselines', () => {
    const left: string[] = [];
    for (const path of DOCUMENTS) {
      readFileSync(join(ROOT, path), 'utf8')
        .split('\n')
        .forEach((text, index) => {
          const hit = oldName(text);
          if (hit) left.push(`${path}:${index + 1}: ${hit}`);
        });
    }
    expect(left).toEqual([]);
  });
});
