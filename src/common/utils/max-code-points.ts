import { ValidateBy, type ValidationOptions } from 'class-validator';

/**
 * At most `max` Unicode code points — what PostgreSQL's char_length counts.
 *
 * class-validator's MaxLength does not count that: validator's isLength
 * subtracts every variation selector (U+FE0E/U+FE0F) that follows a character,
 * so a name of 100 "a" + U+FE0F passes MaxLength(100) at 200 code points and
 * reaches a CHECK (char_length <= 100) that refuses it — a 500, since nothing
 * names that CHECK to the caller. An emoji such as "⭐️" carries the selector,
 * so a long enough real text hits it. [...value] iterates by code point, so an
 * astral character is one, as it is to the column.
 *
 * Non-strings pass, for IsString beside it to refuse with its own sentence.
 */
export function MaxCodePoints(max: number, options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'maxCodePoints',
      constraints: [max],
      validator: {
        validate: (value: unknown) => typeof value !== 'string' || [...value].length <= max,
      },
    },
    options,
  );
}
