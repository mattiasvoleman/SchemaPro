import decodeUriComponent from 'decode-uri-component';
import { parse } from 'query-string';

/**
 * Guards the vendored `decode-uri-component` (mobile/vendor/decode-uri-component).
 *
 * expo-router parses the query string of every incoming deep link through
 * query-string, which decodes each value with decode-uri-component. Every
 * published version up to 0.4.2 burns superlinear CPU on malformed
 * percent-encoding (GHSA-vcc3-ghjq-m6fr), and on a phone the JavaScript thread
 * is the UI thread: a `schemapro://` link carrying a 3 kB malformed value froze
 * the app for over a minute. The patched 0.5.0 is ESM-only and unusable from
 * query-string 7's `require()`, so the fix is vendored as CommonJS.
 *
 * That vendoring is invisible to `npm audit`, which cannot see a `file:`
 * dependency. This test is what stands between a future install and a silently
 * reintroduced freeze.
 */
describe('deep-link query decoding', () => {
  it('reaches a callable decoder, the interop a plain override breaks', () => {
    // The ESM-only upstream build resolves to `{default: fn}` here, and
    // query-string's `require()` call fails with "is not a function".
    expect(typeof decodeUriComponent).toBe('function');
    expect(decodeUriComponent('st%C3%A5le')).toBe('ståle');
  });

  it('decodes the Swedish characters a roster actually contains', () => {
    expect(parse('name=Bj%C3%B6rn&klass=9A')).toEqual({
      name: 'Björn',
      klass: '9A',
    });
    expect(parse('l%C3%A4rare=%C3%85sa%20%C3%96berg')).toEqual({
      lärare: 'Åsa Öberg',
    });
  });

  it('leaves malformed percent-encoding alone instead of guessing at it', () => {
    // An incomplete UTF-8 sequence and a lone invalid byte both survive as
    // written, rather than being rearranged into something that decodes.
    expect(parse('a=%E0%A4%A')).toEqual({ a: '%E0%A4%A' });
    expect(parse('a=%FF')).toEqual({ a: '%FF' });
    // `%C2` is upstream's one deliberate exception: it is mapped to the
    // replacement character so it cannot act as a combinator during the
    // replacement pass. Asserted so a future re-sync notices if that changes.
    expect(parse('a=%C2')).toEqual({ a: '�' });
    expect(parse('a=100%25%20klart')).toEqual({ a: '100% klart' });
  });

  it('parses a malformed deep-link value in milliseconds, not minutes', () => {
    // 3 000 characters of unbroken invalid percent-encoding: the shape that took
    // decode-uri-component 0.2.2 past 60 seconds. The ceiling is generous — the
    // patched decoder does this in about a millisecond — because the regression
    // being guarded against is three orders of magnitude away, and a tight bound
    // would only turn a slow CI runner into a red build.
    const malformed = `a=${'%C2'.repeat(1000)}`;

    const started = Date.now();
    parse(malformed);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(1000);
  });
});
