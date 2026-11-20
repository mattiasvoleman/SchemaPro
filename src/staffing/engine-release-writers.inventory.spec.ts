import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/*
 * Släppt för motorn: who writes a post's lead, and what each does to the release.
 *
 * A release is the school saying that Föreslå bemanning may move a post's teacher. When a person then chooses a teacher for the post
 * by hand, the release must go (takeBackReleasesAfterHandChange, in the same transaction, with a log row), or the next proposal can
 * move the teacher the school has just picked. Which code is "a person choosing" is found by reading, so a new writer of
 * TeachingRequirements has to be classified here, with its reason: TAKES_BACK for a writer of the lead that calls the helper, KEEPS
 * for the staffing apply (the engine's answer approved by the school keeps its release, DEPLOYMENT §31.3), and NOT_THE_LEAD for a
 * writer that never writes teacherId. A file that writes the table and is in none of them fails here, with this paragraph.
 *
 * Every SITE is counted, not only every file: a file lists how many places in it write a post (`sites`), so a new method in
 * teaching-requirements.service.ts, or a second write in a file that is classified, fails here too and has to be read. A site is a use of
 * the Prisma delegate that is not a read, a create or a delete (any spelling: a chain over two lines, a variable that holds the delegate),
 * a raw `UPDATE "TeachingRequirements"` in any case and with a schema, and a nested write through a relation (`teachingRequirements:
 * { updateMany }` on a user, a subject, a group). For the files that never write the lead the call itself is read: its arguments must
 * not name teacherId. What is not TypeScript in src/ is out of reach of this reading: a SQL function in a migration that updated the table, or a write through PostgREST.
 *
 * Creates are not listed: a post made new has no release. A rollover and a term split make new posts and are not writers of an
 * old post's lead.
 */

type Kind = 'TAKES_BACK' | 'KEEPS' | 'NOT_THE_LEAD';

const WRITERS: Record<string, { kind: Kind; sites: number; reason: string }> = {
  'src/resources/teaching-requirements.service.ts': {
    kind: 'TAKES_BACK',
    sites: 1,
    reason: 'The PATCH of a post: a teacher chosen in the post’s dialog, the teacher’s card, the unstaffed panel or the suggestions.',
  },
  'src/import/import.service.ts': {
    kind: 'TAKES_BACK',
    sites: 4,
    reason: 'The requirements import: a file that gives a post another lead, by e-mail or by signature.',
  },
  'src/optimization/staffing-proposal.service.ts': {
    kind: 'KEEPS',
    sites: 1,
    reason: 'The apply of Föreslå bemanning: the engine’s answer, approved by the school. A released post stays released until the school takes it back.',
  },
  'src/resources/teaching-blocks.service.ts': {
    kind: 'NOT_THE_LEAD',
    sites: 3,
    reason: 'A parallel block’s members: their block key and their lessons and weeks, never their teachers.',
  },
  'src/resources/term-halves.service.ts': {
    kind: 'NOT_THE_LEAD',
    sites: 1,
    reason: 'A term split adjusts the lessons of the class’s other post; the new halves are new posts that copy the lead and have no release.',
  },
};

/** Comments out of the way: a sentence that says "teachingRequirement.update(" is no write, and an apostrophe in one is no quote. */
const withoutComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

/** The Prisma delegate used for anything but a read, a create or a delete: update, updateMany, upsert, and an alias of the delegate. */
const DELEGATE = /\.teachingRequirement\b(?!\s*\.\s*(?:find\w*|count|aggregate|groupBy|create\w*|delete\w*)\b)/g;
/** Raw SQL, in any case and with or without the schema. */
const RAW = /\bupdate\s+(?:only\s+)?(?:"?public"?\s*\.\s*)?"TeachingRequirements"/gi;
/** A nested write through the relation a user, a subject, a group or a school has to its posts. */
const NESTED = /\b(?:co)?[tT]eachingRequirements\s*:\s*\{\s*(?:update|updateMany|upsert|set|connect|disconnect)\b/g;

type Site = { via: 'DELEGATE' | 'RAW' | 'NESTED'; at: number };

const sitesIn = (text: string): Site[] =>
  [
    ...[...text.matchAll(DELEGATE)].map((m) => ({ via: 'DELEGATE' as const, at: m.index! })),
    ...[...text.matchAll(RAW)].map((m) => ({ via: 'RAW' as const, at: m.index! })),
    ...[...text.matchAll(NESTED)].map((m) => ({ via: 'NESTED' as const, at: m.index! })),
  ].sort((a, b) => a.at - b.at);

/** The parentheses of the call that starts after `from`, or null when they do not balance (then somebody has to read it). */
function callAfter(text: string, from: number): string | null {
  const open = text.indexOf('(', from);
  if (open < 0) return null;
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote !== null) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return null;
}

function* sourceFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sourceFiles(path);
    else if (name.endsWith('.ts') && !name.endsWith('.spec.ts') && !name.endsWith('.d.ts')) yield path;
  }
}

const ROOT = join(__dirname, '..', '..');
const readSource = (file: string): string => withoutComments(readFileSync(join(ROOT, file), 'utf8'));
const sources = [...sourceFiles(join(ROOT, 'src'))].map((path) => relative(ROOT, path)).sort();
const sitesOf = new Map(sources.map((file) => [file, sitesIn(readSource(file))] as const));
const found = sources.filter((file) => sitesOf.get(file)!.length > 0);

describe('who writes a post’s lead, and what each does to its release (släppt för motorn)', () => {
  it('lists every file that updates TeachingRequirements, and no other', () => {
    expect(found).toEqual(Object.keys(WRITERS).sort());
  });

  it('counts the places in each file that write a post, so a new one in a classified file has to be read too', () => {
    const counted = Object.fromEntries(found.map((file) => [file, sitesOf.get(file)!.length]));
    const declared = Object.fromEntries(Object.entries(WRITERS).map(([file, writer]) => [file, writer.sites]));
    expect(counted).toEqual(declared);
  });

  it.each(Object.entries(WRITERS).filter(([, writer]) => writer.kind === 'NOT_THE_LEAD'))(
    '%s never names the lead in a write: the call is read, not only counted',
    (file) => {
      const text = readSource(file);
      for (const site of sitesOf.get(file)!) {
        expect({ file, via: site.via }).toEqual({ file, via: 'DELEGATE' });
        // Written as `.teachingRequirement.update(`, not through an alias: an alias is a call somewhere else that the reading cannot find.
        const written = text.slice(site.at + '.teachingRequirement'.length);
        expect({ file, direct: /^\s*\.\s*(?:update|updateMany|upsert)\s*\(/.test(written) }).toEqual({ file, direct: true });
        const call = callAfter(text, site.at);
        expect({ file, readable: call !== null }).toEqual({ file, readable: true });
        expect({ file, call: /\b(?:co)?[tT]eacherId\b/.test(call!) }).toEqual({ file, call: false });
      }
    },
  );

  it.each(Object.entries(WRITERS).filter(([, writer]) => writer.kind === 'TAKES_BACK'))(
    '%s calls takeBackReleasesAfterHandChange',
    (file) => {
      expect(readSource(file)).toMatch(/takeBackReleasesAfterHandChange\(/);
    },
  );

  it.each(Object.entries(WRITERS).filter(([, writer]) => writer.kind !== 'TAKES_BACK'))(
    '%s does not call it: its writes are not a person choosing a lead',
    (file) => {
      expect(readSource(file)).not.toMatch(/takeBackReleasesAfterHandChange/);
    },
  );

  it('gives every writer a reason somebody can act on', () => {
    for (const [file, writer] of Object.entries(WRITERS)) {
      expect({ file, reason: writer.reason.length > 30 }).toEqual({ file, reason: true });
    }
  });

  it('keeps the staffing apply’s own write of the lead out of the helper: the apply keeps the release by design', () => {
    expect(WRITERS['src/optimization/staffing-proposal.service.ts']!.kind).toBe('KEEPS');
  });
});
