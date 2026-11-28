import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { UNREGULATED_HOURS_INTERPRETATION } from './assignment-scope';

/*
 * The two notes the card knows in English (web/lib/assignment-scope.ts KNOWN_INTERPRETATIONS) are the notes the gateway holds today, word
 * for word: the band note of årskurs 7-9 that migration 20270301090000 writes, and T7, a constant here. A card in English shows the English
 * for a note that IS one of them and the note as recorded for any other (the review of #397, L-4), so the Swedish in the web lib must be the
 * Swedish here: this fails when either is reworded without the other, and the catalogue is held to the same words.
 */
const root = join(__dirname, '..', '..');
const web = readFileSync(join(root, 'web/lib/assignment-scope.ts'), 'utf8');
const messages = (locale: 'sv' | 'en') =>
  (JSON.parse(readFileSync(join(root, `web/messages/${locale}.json`), 'utf8')) as {
    staffing: { scope: { knownInterpretation: Record<string, string>; interpretationTranslated: string } };
  }).staffing.scope;

/** The text of a SQL string literal as it is written inside quotes: '' is one quote. */
const bandNote = (): string => {
  const dir = join(root, 'prisma', 'migrations');
  const name = readdirSync(dir).find((entry) => entry.startsWith('20270301090000_'));
  const sql = readFileSync(join(dir, name!, 'migration.sql'), 'utf8');
  const match = /'(Tolkning: 5 § säger[^']*(?:''[^']*)*)'\)/.exec(sql);
  if (!match) throw new Error('the band note is not in the migration');
  return match[1]!.replace(/''/g, "'");
};

describe('the notes the card knows in English', () => {
  it("has the band note of årskurs 7-9 as the migration writes it", () => {
    expect(web).toContain(JSON.stringify(bandNote()).slice(1, -1));
  });

  it("has T7 as the gateway's constant says it", () => {
    expect(web).toContain(JSON.stringify(UNREGULATED_HOURS_INTERPRETATION.note).slice(1, -1));
  });

  it('has the Swedish of both in the Swedish catalogue, word for word, and an English that is not the Swedish', () => {
    const [sv, en] = [messages('sv'), messages('en')];
    expect(sv.knownInterpretation['band7to9']).toBe(bandNote());
    expect(sv.knownInterpretation['unregulated']).toBe(UNREGULATED_HOURS_INTERPRETATION.note);
    for (const key of ['band7to9', 'unregulated']) {
      expect(en.knownInterpretation[key]!.length).toBeGreaterThan(40);
      expect(en.knownInterpretation[key]).not.toBe(sv.knownInterpretation[key]);
    }
    expect(Object.keys(en.knownInterpretation)).toEqual(Object.keys(sv.knownInterpretation));
    expect(sv.interpretationTranslated).toBe(en.interpretationTranslated);
  });
});
