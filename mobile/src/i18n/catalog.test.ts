import { en } from './en';
import { sv } from './sv';

/**
 * The two catalogues agree by test, not by discipline — the mobile twin of
 * web/i18n/messages.test.ts. tsc already refuses an en.ts with a key missing
 * or extra; what it cannot see is a placeholder that one language names and
 * the other does not (a sentence that prints "{count}" to an English reader),
 * a plural with only one of its forms, or an empty string.
 */

type Tree = { readonly [key: string]: string | Tree };

function flatten(tree: Tree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    if (typeof value === 'string') out.set(`${prefix}${key}`, value);
    else for (const [inner, text] of flatten(value, `${prefix}${key}.`)) out.set(inner, text);
  }
  return out;
}

const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

const svFlat = flatten(sv as unknown as Tree);
const enFlat = flatten(en as unknown as Tree);

describe('the mobile catalogues', () => {
  it('carry the same keys in both languages', () => {
    expect([...svFlat.keys()].filter((key) => !enFlat.has(key))).toEqual([]);
    expect([...enFlat.keys()].filter((key) => !svFlat.has(key))).toEqual([]);
  });

  it('carry the same placeholders in every message', () => {
    const mismatched = [...svFlat.entries()]
      .map(([key, text]) => ({ key, sv: placeholders(text), en: placeholders(enFlat.get(key) ?? '') }))
      .filter((row) => row.sv.join() !== row.en.join());
    expect(mismatched).toEqual([]);
  });

  it('give every plural both its forms, and both forms the count', () => {
    for (const flat of [svFlat, enFlat]) {
      for (const key of flat.keys()) {
        const one = key.match(/^(.*)_one$/);
        const other = key.match(/^(.*)_other$/);
        if (one) expect(flat.has(`${one[1]}_other`)).toBe(true);
        if (other) {
          expect(flat.has(`${other[1]}_one`)).toBe(true);
          expect(placeholders(flat.get(key)!)).toContain('count');
        }
      }
    }
  });

  it('have no empty message', () => {
    expect([...svFlat.entries(), ...enFlat.entries()].filter(([, text]) => text.trim() === '')).toEqual([]);
  });

  it('are Swedish in sv.ts where it matters most: the tabs and the login', () => {
    expect(sv.tabs).toMatchObject({ schedule: 'Schema', notifications: 'Notiser', settings: 'Inställningar' });
    expect(sv.login.submit).toBe('Logga in');
  });
});
