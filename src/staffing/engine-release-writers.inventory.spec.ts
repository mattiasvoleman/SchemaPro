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
 * Creates are not listed: a post made new has no release. A rollover and a term split make new posts and are not writers of an
 * old post's lead.
 */

type Kind = 'TAKES_BACK' | 'KEEPS' | 'NOT_THE_LEAD';

const WRITERS: Record<string, { kind: Kind; reason: string }> = {
  'src/resources/teaching-requirements.service.ts': {
    kind: 'TAKES_BACK',
    reason: 'The PATCH of a post: a teacher chosen in the post’s dialog, the teacher’s card, the unstaffed panel or the suggestions.',
  },
  'src/import/import.service.ts': {
    kind: 'TAKES_BACK',
    reason: 'The requirements import: a file that gives a post another lead, by e-mail or by signature.',
  },
  'src/optimization/staffing-proposal.service.ts': {
    kind: 'KEEPS',
    reason: 'The apply of Föreslå bemanning: the engine’s answer, approved by the school. A released post stays released until the school takes it back.',
  },
  'src/resources/teaching-blocks.service.ts': {
    kind: 'NOT_THE_LEAD',
    reason: 'A parallel block’s members: their block key and their lessons and weeks, never their teachers.',
  },
  'src/resources/term-halves.service.ts': {
    kind: 'NOT_THE_LEAD',
    reason: 'A term split adjusts the lessons of the class’s other post; the new halves are new posts that copy the lead and have no release.',
  },
};

const WRITES = /\.teachingRequirement\.(update|updateMany|upsert)\s*\(|\bUPDATE\s+"TeachingRequirements"/;

function* sourceFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sourceFiles(path);
    else if (name.endsWith('.ts') && !name.endsWith('.spec.ts') && !name.endsWith('.d.ts')) yield path;
  }
}

const ROOT = join(__dirname, '..', '..');
const found = [...sourceFiles(join(ROOT, 'src'))]
  .filter((path) => WRITES.test(readFileSync(path, 'utf8')))
  .map((path) => relative(ROOT, path))
  .sort();

describe('who writes a post’s lead, and what each does to its release (släppt för motorn)', () => {
  it('lists every file that updates TeachingRequirements, and no other', () => {
    expect(found).toEqual(Object.keys(WRITERS).sort());
  });

  it.each(Object.entries(WRITERS).filter(([, writer]) => writer.kind === 'TAKES_BACK'))(
    '%s calls takeBackReleasesAfterHandChange',
    (file) => {
      expect(readFileSync(join(ROOT, file), 'utf8')).toMatch(/takeBackReleasesAfterHandChange\(/);
    },
  );

  it.each(Object.entries(WRITERS).filter(([, writer]) => writer.kind !== 'TAKES_BACK'))(
    '%s does not call it: its writes are not a person choosing a lead',
    (file) => {
      expect(readFileSync(join(ROOT, file), 'utf8')).not.toMatch(/takeBackReleasesAfterHandChange/);
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
