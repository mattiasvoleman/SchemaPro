/**
 * The import DTOs' cell rules, so the import dialog refuses a cell with the
 * row and the column named instead of posting it.
 *
 * Every import body is validated whole by the gateway's ValidationPipe, and a
 * single cell it refuses — an e-mail address without a top-level domain, a
 * colour that is no hex colour, a class name of 61 characters — is a 400 for
 * the whole upload, which the dialog could only show as "One or more fields
 * failed validation." with no row in it. So the mappers in lib/csv.ts ask
 * these first, row by row.
 *
 * Copies of class-validator's @IsEmail(), @IsHexColor() and @MaxLength() as
 * class-validator 0.14 calls validator 13 (isEmail with its defaults, isFQDN,
 * isByteLength, isHexColor, isLength), not imports: the web does not carry
 * validator, and these four are a few lines each. They must stay identical,
 * because the point is that the browser refuses exactly what the gateway
 * would — a stricter copy refuses a file the school could import, a looser
 * one lets the 400 back in. src/import/__fixtures__/csv-cell-rules.json is
 * the list of cases both sides replay (csv-cell-rules.contract.spec.ts
 * against class-validator itself, csv-cell-rules.test.ts against this file).
 */

/** validator's isLength: UTF-16 units, a surrogate pair and a presentation sequence counted once. */
export function textLength(value: string): number {
  const presentationSequences = value.match(/[^️︎][️︎]/g) ?? [];
  const surrogatePairs = value.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g) ?? [];
  return value.length - presentationSequences.length - surrogatePairs.length;
}

/** validator's isByteLength: the UTF-8 bytes encodeURI would write. */
function byteLength(value: string): number {
  return encodeURI(value).split(/%..|./).length - 1;
}

/** validator's isHexColor without require_hashtag. */
export function isHexColor(value: string): boolean {
  return /^#?([0-9A-F]{3}|[0-9A-F]{4}|[0-9A-F]{6}|[0-9A-F]{8})$/i.test(value);
}

/** validator's isFQDN as isEmail calls it: a TLD required, no underscores, no trailing dot. */
function isDomain(value: string): boolean {
  const parts = value.split(".");
  const tld = parts[parts.length - 1]!;
  if (parts.length < 2) return false;
  if (!/^([a-z¡-¨ª-퟿豈-﷏ﷰ-￯]{2,}|xn[a-z0-9-]{2,})$/i.test(tld)) return false;
  if (/\s/.test(tld)) return false;
  if (/^\d+$/.test(tld)) return false;
  return parts.every(
    (part) =>
      part.length <= 63 &&
      /^[a-z_¡-￿0-9-]+$/i.test(part) &&
      !/[！-～]/.test(part) &&
      !/^-|-$/.test(part) &&
      !/_/.test(part),
  );
}

/* eslint-disable no-control-regex */
const QUOTED_USER_UTF8 =
  /^([\s\x01-\x08\x0b\x0c\x0e-\x1f\x7f\x21\x23-\x5b\x5d-\x7e -퟿豈-﷏ﷰ-￯]|(\\[\x01-\x09\x0b\x0c\x0d-\x7f -퟿豈-﷏ﷰ-￯]))*$/i;
/* eslint-enable no-control-regex */
const USER_UTF8_PART = /^[a-z\d!#$%&'*+\-/=?^_`{|}~¡-퟿豈-﷏ﷰ-￯]+$/i;

/**
 * validator's isEmail with its defaults, as @IsEmail() calls it: å, ä and ö
 * allowed before the @ (noah.sjö@…), a top-level domain required after it,
 * 254 characters in all, 64 bytes before the @ and 254 after it.
 */
export function isEmailAddress(value: string): boolean {
  if (value.length > 254) return false;
  const parts = value.split("@");
  const domain = parts.pop()!;
  let user = parts.join("@");
  if (byteLength(user) > 64 || byteLength(domain) > 254) return false;
  if (!isDomain(domain)) return false;
  if (user[0] === '"' && user[user.length - 1] === '"') {
    user = user.slice(1, user.length - 1);
    return QUOTED_USER_UTF8.test(user);
  }
  return user.split(".").every((part) => USER_UTF8_PART.test(part));
}
