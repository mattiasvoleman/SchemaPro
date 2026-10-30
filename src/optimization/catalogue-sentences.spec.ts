import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { freeDayWishMessage, TEACHER_FREE_DAY_WISH_NOT_KEPT } from './free-day-wishes';
import { DAYS_BEARING_CODES, TEACHER_WORK_DAYS_HIDDEN, WORK_DAYS_HIDDEN_MESSAGE } from './work-days';
import { HOLD_CODES, holdMessage, type HoldKind } from './other-school-holds';

/**
 * The sentences the generator's gateway writes itself, held to the one
 * catalogue (optimization-engine/app/messages.py), through the fixture the
 * engine generates for the web (tests/generate_engine_messages.py).
 *
 * Two kinds of drift, each a leak or a lie. A code containing WORK_DAYS that
 * DAYS_BEARING_CODES does not list is a sentence with a post's days in it that
 * reaches every administrator as the engine wrote it — the list is what the
 * gateway masks by. And English rendered here that is not the catalogue's is
 * a screen falling back to one sentence in one place and another elsewhere.
 */
describe('the generator gateway’s sentences are the catalogue’s', () => {
  const fixture = JSON.parse(
    readFileSync(join(__dirname, '..', '..', 'web/i18n/__fixtures__/engine-messages.json'), 'utf8'),
  ) as Record<string, string>;

  /** {name}, {name, select, …} and {name, plural, …} with #, and nothing more. */
  const render = (template: string, params: Record<string, string | number>): string => {
    let out = '';
    for (let i = 0; i < template.length; ) {
      if (template[i] !== '{') {
        out += template[i++];
        continue;
      }
      let depth = 0;
      let end = i;
      for (; end < template.length; end++) {
        if (template[end] === '{') depth++;
        if (template[end] === '}' && --depth === 0) break;
      }
      const inside = template.slice(i + 1, end);
      i = end + 1;
      const [name, kind, ...rest] = inside.split(',');
      const value = params[name!.trim()]!;
      if (kind === undefined) {
        out += String(value);
        continue;
      }
      const branches = new Map<string, string>();
      const body = rest.join(',');
      const branch = /(\w+)\s*\{/g;
      let match: RegExpExecArray | null;
      while ((match = branch.exec(body)) !== null) {
        let d = 1;
        let j = branch.lastIndex;
        for (; j < body.length && d > 0; j++) d += body[j] === '{' ? 1 : body[j] === '}' ? -1 : 0;
        branches.set(match[1]!, body.slice(branch.lastIndex, j - 1));
        branch.lastIndex = j;
      }
      const key = kind.trim() === 'plural' ? (value === 1 ? 'one' : 'other') : String(value);
      const chosen = branches.get(key) ?? branches.get('other')!;
      out += render(kind.trim() === 'plural' ? chosen.replace('#', String(value)) : chosen, params);
    }
    return out;
  };

  it('lists every days-bearing code of the catalogue, and no code the catalogue lacks', () => {
    const inCatalogue = Object.keys(fixture)
      .filter((code) => code.includes('WORK_DAYS') && code !== TEACHER_WORK_DAYS_HIDDEN)
      .sort();
    expect([...DAYS_BEARING_CODES].sort()).toEqual(inCatalogue);
  });

  it('says TEACHER_WORK_DAYS_HIDDEN as the catalogue does, with nothing to substitute', () => {
    expect(fixture[TEACHER_WORK_DAYS_HIDDEN]).toBe(WORK_DAYS_HIDDEN_MESSAGE);
  });

  it.each([1, 2, 3, 4, 5, 6, 7])('says TEACHER_FREE_DAY_WISH_NOT_KEPT for weekday %i as the catalogue does', (day) => {
    expect(fixture[TEACHER_FREE_DAY_WISH_NOT_KEPT]).toBeDefined();
    // The day is all the sentence takes: whose wish it is stands beside it.
    expect(freeDayWishMessage(day)).toBe(render(fixture[TEACHER_FREE_DAY_WISH_NOT_KEPT]!, { day }));
  });

  // Delade lokaler och lärare: the gateway reads a refusal about another
  // school's hold as that school's, in the catalogue's words.
  const holds: Array<[HoldKind, number]> = (['TEACHER_BUSY', 'ROOM_LENT', 'ROOM_BORROWED'] as const).flatMap((kind) =>
    [1, 3, 5].map((day): [HoldKind, number] => [kind, day]),
  );
  it.each(holds)('says the %s line for weekday %i as the catalogue does', (kind, day) => {
    for (const travel of ['yes', 'no']) {
      const params = { schools: 'Norraskolan, Södra', day, start: '09:45', end: '11:15', room: 'Idrottshallen', travel };
      expect(fixture[HOLD_CODES[kind]]).toBeDefined();
      expect(holdMessage(kind, params)).toBe(render(fixture[HOLD_CODES[kind]]!, params));
    }
  });
});
