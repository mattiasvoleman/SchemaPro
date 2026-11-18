import fixture from './__fixtures__/personal-number-cases.json';
import { hasPersonalNumber, redactPersonalNumbers } from './file-safety';

/**
 * The shape of a personnummer, implemented twice and checked against one list (Kolumnmappning, X2).
 *
 * The browser drops a personnummer column before anything is sent (web/lib/personal-number.ts), and it can only do
 * that with the same shape the gateway refuses by: a copy of file-safety.ts's fold and expressions. If the two
 * drift, the browser either lets a number through that the gateway would refuse or drops a column the gateway
 * would have read. Neither suite can see the other, so both replay __fixtures__/personal-number-cases.json; this side
 * proves the fixture says what file-safety.ts says (the web's side proves its copy says the same).
 *
 * The fixture is GENERATED from file-safety.ts: when the shape changes, regenerate it from the two functions over its own
 * `text` values (and add the case that showed the change), then bring web/lib/personal-number.ts after. Never edit an answer by hand.
 */
describe('the personnummer shape the web copies', () => {
  it('has cases that are numbers and cases that are not, and redacts what it finds', () => {
    expect(fixture.cases.filter((c) => c.has).length).toBeGreaterThan(30);
    expect(fixture.cases.filter((c) => !c.has).length).toBeGreaterThan(30);
    expect(fixture.cases.every((c) => c.has === (c.redacted !== c.text))).toBe(true);
  });

  it.each(fixture.cases.map((c) => [c.text, c.has, c.redacted] as const))('%j is a number: %s, and reads %j once redacted', (text, has, redacted) => {
    expect(hasPersonalNumber(text)).toBe(has);
    expect(redactPersonalNumbers(text)).toBe(redacted);
  });
});
