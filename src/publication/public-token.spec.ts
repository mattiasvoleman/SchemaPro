import { createHash } from 'node:crypto';
import { codeForDisplay, newCode, newToken, tokenHashOf, viewerTokenOf } from './public-token';

describe('a Schemavisaren code', () => {
  it('is twenty characters of Crockford base32 and never repeats', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const code = newCode();
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{20}$/);
      seen.add(code);
    }
    expect(seen.size).toBe(2000);
  });

  it('draws every symbol with the same chance: a code is 100 bits, not fewer', () => {
    const tally = new Map<string, number>();
    const draws = 20_000;
    for (let i = 0; i < draws; i++) for (const symbol of newCode()) tally.set(symbol, (tally.get(symbol) ?? 0) + 1);
    expect(tally.size).toBe(32);
    const expected = (draws * 20) / 32;
    for (const [, count] of tally) expect(Math.abs(count - expected) / expected).toBeLessThan(0.05);
  });

  it('is shown in four groups of five', () => {
    expect(codeForDisplay('ABCDEFGHJKMNPQRSTVWX')).toBe('ABCDE-FGHJK-MNPQR-STVWX');
  });
});

describe('viewerTokenOf (the one place an address becomes a link)', () => {
  it('takes a token as it is, case and hyphens included', () => {
    const token = newToken();
    expect(viewerTokenOf(token)).toBe(token);
    const hyphenated = 'ab-cdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP';
    expect(hyphenated).toHaveLength(43);
    expect(viewerTokenOf(hyphenated)).toBe(hyphenated);
  });

  it('takes a code however it is typed, and hashes every spelling alike', () => {
    const code = 'K7QM2X9DRT4V8WNB5C3H';
    const spellings = ['K7QM2X9DRT4V8WNB5C3H', 'K7QM2-X9DRT-4V8WN-B5C3H', 'k7qm2-x9drt-4v8wn-b5c3h', ' K7QM2 X9DRT 4V8WN B5C3H ', 'k7qm2x9drt4v8wnb5c3h'];
    for (const spelling of spellings) expect(viewerTokenOf(spelling)).toBe(code);
    expect(new Set(spellings.map((spelling) => tokenHashOf(viewerTokenOf(spelling)!))).size).toBe(1);
  });

  it('hashes a code as it is kept, whichever way the code is written or shown', () => {
    const code = newCode();
    expect(tokenHashOf(codeForDisplay(code))).toBe(tokenHashOf(code));
    expect(tokenHashOf(codeForDisplay(code).toLowerCase())).toBe(tokenHashOf(code));
    // A token, and anything that is no link, as it stands.
    const token = newToken();
    expect(tokenHashOf(token)).toBe(createHash('sha256').update(token).digest('hex'));
    expect(tokenHashOf('short')).toBe(createHash('sha256').update('short').digest('hex'));
  });

  it('reads I and L as 1 and O as 0, as the alphabet leaves them out', () => {
    expect(viewerTokenOf('K7QM2-X9DRT-4V8WN-B5C3H'.replace('3', 'L').replace('7', 'I'))).toBe('K1QM2X9DRT4V8WNB5CLH'.replace('L', '1'));
    expect(viewerTokenOf('0'.repeat(20))).toBe('0'.repeat(20));
    expect(viewerTokenOf('O'.repeat(20))).toBe('0'.repeat(20));
  });

  it.each([
    ['too short', 'K7QM2X9DRT4V8WNB5C3'],
    ['too long', 'K7QM2X9DRT4V8WNB5C3HH'],
    ['a U, which the alphabet leaves out', 'U'.repeat(20)],
    ['a symbol outside the alphabet', 'K7QM2X9DRT4V8WNB5C3!'],
    ['nothing', ''],
    ['a long string that is neither', 'x'.repeat(64)],
    ['more than any link is', 'A'.repeat(65)],
  ])('is no link: %s', (_why, raw) => {
    expect(viewerTokenOf(raw)).toBeNull();
  });

  it.each([[undefined], [null], [42], [['K7QM2X9DRT4V8WNB5C3H']], [{}]])('is no link: not a string (%p)', (raw) => {
    expect(viewerTokenOf(raw)).toBeNull();
  });
});
