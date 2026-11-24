/**
 * The validation sentences of a 400, read for the property each is about and said in the reader's language.
 *
 * The gateway's ValidationPipe answers a DTO that does not hold with the sentences its decorators give (`errors.body` of the problem,
 * api.ts keeps them as `ApiError.problems`). Three shapes come, and only the first two say which property they mean:
 *
 *   - class-validator's own, in English, which most decorators of the gateway use ("name should not be empty", "capacity must not be
 *     greater than 10000"): the property comes first, the rest is a fixed wording per decorator;
 *   - a DTO's own, in the form `property: sentence` ("minutesPerWeek: minst 1 minut per vecka.") or `property must be …`;
 *   - a DTO's own with no property in it ("Nivån kan vara högst 1500 timmar.").
 *
 * The first is said again from the catalogue (`common.validation*`: a frame around a phrase), so that a Swedish reader is not given
 * English; the others are shown as they came. The property is read from the first two, so that a form can draw the sentence at the
 * field it is about (components/ui/form-field.tsx). A wording this does not know is shown as it came and is never lost.
 *
 * It asks the translator for keys only, like api-error-text.ts: the page tests replace next-intl with an echo.
 */

/** A property path as class-validator writes it: `name`, `items.0.name`. */
const NAME = String.raw`([A-Za-z_$][\w$]*(?:\.[\w$]+)*)`;

/** The wordings of class-validator's decorators (and the gateway's own `X must be …`) that are said in the catalogue: key, values. */
const SHAPES: ReadonlyArray<readonly [RegExp, string, readonly string[]]> = [
  [new RegExp(`^${NAME} should not be empty$`), "empty", []],
  [new RegExp(`^${NAME} should not be null or undefined$`), "required", []],
  [new RegExp(`^${NAME} must be a string$`), "string", []],
  [new RegExp(`^${NAME} must be (?:a UUID|a valid UUIDv4\\.?)$`), "uuid", []],
  [new RegExp(`^${NAME} must be an integer number$`), "integer", []],
  [new RegExp(`^${NAME} must be a number conforming to the specified constraints$`), "number", []],
  [new RegExp(`^${NAME} must not be less than (-?[\\d.]+)$`), "min", ["min"]],
  [new RegExp(`^${NAME} must not be greater than (-?[\\d.]+)$`), "max", ["max"]],
  [new RegExp(`^${NAME} must be shorter than or equal to (\\d+) characters$`), "maxLength", ["max"]],
  [new RegExp(`^${NAME} must be longer than or equal to (\\d+) characters$`), "minLength", ["min"]],
  [new RegExp(`^${NAME} must be a boolean value$`), "boolean", []],
  [new RegExp(`^${NAME} must be an array$`), "array", []],
  [new RegExp(`^${NAME} must contain no more than (\\d+) elements$`), "arrayMax", ["max"]],
  [new RegExp(`^${NAME} must contain at least (\\d+) elements$`), "arrayMin", ["min"]],
  [new RegExp(`^${NAME} must be one of(?: the following values)?: (.+?)\\.?$`), "oneOf", ["values"]],
  [new RegExp(`^property ${NAME} should not exist$`), "unknown", []],
  [new RegExp(`^nested property ${NAME} must be either object or array$`), "nested", []],
  [new RegExp(`^${NAME} must be an object$`), "object", []],
  [new RegExp(`^${NAME} must be an email$`), "email", []],
  [new RegExp(`^${NAME} must be a valid ISO 8601 date string$`), "isoDate", []],
  [new RegExp(`^${NAME} must be (?:a real date in )?YYYY-MM-DD(?: form)?\\.?$`), "date", []],
  [new RegExp(`^${NAME} must be HH:MM\\.?$`), "time", []],
];

/** `property: sentence`, the form the gateway's own DTO messages and services write when they name the field. */
const PREFIXED = new RegExp(`^${NAME}: (\\S.*)$`);

const EACH = "each value in ";

/** The half of next-intl's translator for `common` this needs. */
export type ValidationLookup = (key: string, values?: Record<string, string | number>) => string;

/**
 * The key of a phrase in `common`: `validationEmpty` for `empty`. Flat, as the rest of `common` is (a test reads the namespace as a
 * record of strings).
 */
const keyOf = (phrase: string): string => `validation${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}`;

export interface ValidationProblem {
  /** The property the sentence is about, when it says so. */
  field: string | null;
  /** Said of every value of a list property (class-validator's `each`). */
  each: boolean;
  /** The catalogue's key under `common.validation` and its values, for a wording this knows. */
  phrase: { key: string; values: Record<string, string> } | null;
  /** The sentence as the gateway wrote it. */
  raw: string;
}

export function readValidation(sentence: string): ValidationProblem {
  const raw = sentence.trim();
  const each = raw.startsWith(EACH);
  const rest = each ? raw.slice(EACH.length) : raw;
  for (const [pattern, key, names] of SHAPES) {
    const match = pattern.exec(rest);
    if (!match) continue;
    const values: Record<string, string> = {};
    names.forEach((name, index) => {
      values[name] = match[index + 2] ?? "";
    });
    return { field: match[1] ?? null, each, phrase: { key, values }, raw };
  }
  return { field: PREFIXED.exec(raw)?.[1] ?? null, each: false, phrase: null, raw };
}

/** One sentence in full: "Fältet ”name” får inte vara tomt." for a wording the catalogue has, the gateway's own for any other. */
export function validationSentence(problem: ValidationProblem, t: ValidationLookup): string {
  if (!problem.phrase || problem.field === null) return problem.raw;
  const phrase = t(keyOf(problem.phrase.key), problem.phrase.values);
  return t(problem.each ? keyOf("each") : keyOf("field"), { field: problem.field, problem: phrase });
}

/** A sentence's first letter in capitals and a stop after it, if it has none. */
const sentenceOf = (text: string): string => {
  const capital = text.charAt(0).toLocaleUpperCase() + text.slice(1);
  return /[.!?…]$/.test(capital) ? capital : `${capital}.`;
};

/**
 * The sentence for the field it is about, with no frame naming the field: "Får inte vara tomt." beside the control that holds the
 * property. The gateway's own `property: sentence` loses its property for the same reason.
 */
export function fieldSentence(problem: ValidationProblem, t: ValidationLookup): string {
  if (problem.phrase) return sentenceOf(t(keyOf(problem.phrase.key), problem.phrase.values));
  const prefixed = PREFIXED.exec(problem.raw);
  return prefixed ? sentenceOf(prefixed[2]!) : problem.raw;
}
