import { idForms, normalize, TermIndex, termsOf } from './free-text';
import { cellOf, type CellRules } from './person-tables';

const MARKED = '11111111-1111-4111-8111-111111111111';
const PERSON = { first: 'Åsa', last: 'Öhman-Ek', email: 'Asa.Ohman-Ek@skolan.example' };

describe('what free text is searched for', () => {
  it('normalizes case, spaces of every kind, commas and hyphens to one space', () => {
    expect(normalize('  Åsa,  ÖHMAN-Ek  ')).toBe('åsa öhman ek');
    expect(normalize('A\tB\nC')).toBe('a b c');
  });

  it("gives a person's names in both orders and the address, and nothing for a name of one word", () => {
    expect(termsOf([PERSON])).toEqual(['åsa öhman ek', 'öhman ek åsa', 'asa.ohman ek@skolan.example']);
    expect(termsOf([{ first: 'Cher', last: '', email: '' }])).toEqual([]);
  });

  it('gives an id as it is written and without hyphens', () => {
    expect(idForms([MARKED.toUpperCase()])).toEqual([MARKED, MARKED.replace(/-/g, '')]);
  });
});

describe('a dumped cell, against the forms free text takes', () => {
  const rules: CellRules = { markedOut: new Set([MARKED]), markedTerms: termsOf([PERSON]) };
  const held = (value: string) => cellOf('note', value, rules).held;

  it.each([
    ['the full name', 'Åsa Öhman-Ek ringde'],
    ['in capitals', 'ÅSA ÖHMAN-EK ringde'],
    ['reversed, with a comma', 'Öhman-Ek,  Åsa (mamma)'],
    ['with a hard space between the names', 'Åsa  Öhman-Ek'],
    ['with a hyphen for the space', 'Åsa-Öhman-Ek'],
    ['with the possessive s', 'Åsa Öhman-Eks mamma'],
    ['the id', `se ${MARKED}`],
    ['the id in capitals', `SE ${MARKED.toUpperCase()}`],
    ['the id without hyphens', `se ${MARKED.replace(/-/g, '')}`],
    ['the address', 'skriv till ASA.OHMAN-EK@skolan.example'],
  ])('is empty for %s', (_form, value) => {
    expect(held(value)).toBe(true);
  });

  it.each([
    ['a first name alone', 'Åsa ringde'],
    ['a name without its diacritics', 'Asa Ohman-Ek ringde'],
    ['no name at all', 'Kom sent, bussen'],
  ])('is kept for %s, which README.txt says it cannot find', (_form, value) => {
    expect(held(value)).toBe(false);
  });
});

describe('looking for many names at once', () => {
  const index = new TermIndex(termsOf([{ first: 'Anna-Lena', last: 'Ek', email: 'al@skolan.example' }, { first: 'Bo', last: 'Lund', email: 'bo@skolan.example' }]));

  it.each([
    ['a name', 'Anna-Lena Ek ringde'],
    ['reversed', 'Ek, Anna Lena (mamma)'],
    ['with the possessive s', 'Bo Lunds pappa'],
    ['in capitals', 'BO LUND'],
    ['an address', 'skriv till AL@skolan.example'],
    ['a name at the end of the text', 'Sist: Bo Lund'],
  ])('finds %s', (_what, text) => {
    expect(index.found(text)).toBe(true);
  });

  it.each([
    ['a first name alone', 'Anna kom sent'],
    ['two other words', 'Lund och Ek'],
    ['nothing', ''],
  ])('does not find %s', (_what, text) => {
    expect(index.found(text)).toBe(false);
  });

  it('finds nothing in an empty index', () => {
    expect(new TermIndex([]).found('Anna-Lena Ek')).toBe(false);
  });
});
