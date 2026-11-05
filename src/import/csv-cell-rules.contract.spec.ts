import { isEmail, isHexColor, maxLength } from 'class-validator';
import fixture from './__fixtures__/csv-cell-rules.json';

/**
 * The import DTOs' cell rules, implemented twice, checked against one list.
 *
 * web/lib/csv-cell-rules.ts copies @IsEmail(), @IsHexColor() and
 * @MaxLength() so the import dialog refuses a cell with its row and column
 * named, instead of posting a file the ValidationPipe 400s whole. If the two
 * drift, the browser either refuses a file the gateway would take or lets a
 * 400 through again. Neither suite can see the other, so both replay
 * __fixtures__/csv-cell-rules.json; this side proves the fixture says what
 * class-validator says, which also catches a class-validator or validator
 * upgrade that changes an answer.
 *
 * The fixture was GENERATED from class-validator (the script is in the
 * commit message); regenerate it rather than editing a case by hand.
 */
describe('the import cell rules agree with class-validator', () => {
  it('reaches valid and invalid cases of every rule', () => {
    expect(fixture.emails.some((c) => c.valid)).toBe(true);
    expect(fixture.emails.some((c) => !c.valid)).toBe(true);
    expect(fixture.hexColors.some((c) => c.valid)).toBe(true);
    expect(fixture.hexColors.some((c) => !c.valid)).toBe(true);
    expect(fixture.lengths.some((c) => !c.maxLength60)).toBe(true);
  });

  it.each(fixture.emails.map((c) => [c.value, c.valid] as const))('@IsEmail() on %j is %s', (value, valid) => {
    expect(isEmail(value)).toBe(valid);
  });

  it.each(fixture.hexColors.map((c) => [c.value, c.valid] as const))('@IsHexColor() on %j is %s', (value, valid) => {
    expect(isHexColor(value)).toBe(valid);
  });

  it.each(fixture.lengths.map((c) => [c.value, c.length, c.maxLength60] as const))(
    '@MaxLength counts %j as %i',
    (value, length, fits60) => {
      expect(maxLength(value, length)).toBe(true);
      expect(length === 0 || !maxLength(value, length - 1)).toBe(true);
      expect(maxLength(value, 60)).toBe(fits60);
    },
  );
});
