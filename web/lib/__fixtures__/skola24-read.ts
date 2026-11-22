import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeCsvBytes } from "@/lib/csv-encoding";

/** The bytes of a fixture under web/lib/__fixtures__/skola24/ (synthetic; see the README there). Tests only. */
export function readFixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(__dirname, "skola24", name)));
}

/**
 * The text of a fixture, decoded the way a file is when a school chooses it (lib/csv-encoding.ts): the TF fixtures are Windows-1252, as
 * Skola24's own files are, so reading them as UTF-8 would break every å, ä and ö.
 */
export function readFixture(name: string): string {
  const decoded = decodeCsvBytes(readFixtureBytes(name));
  if (decoded.problem !== null) throw new Error(`${name}: ${decoded.problem}`);
  return decoded.text;
}

/** The check digit (Luhn, the personnummer's) of the nine digits ÅÅMMDDNNN. */
function checkDigitOf(nine: string): number {
  let sum = 0;
  for (let at = 0; at < nine.length; at += 1) {
    const doubled = Number(nine[at]) * (at % 2 === 0 ? 2 : 1);
    sum += doubled > 9 ? doubled - 9 : doubled;
  }
  return (10 - (sum % 10)) % 10;
}

/**
 * A string with the SHAPE of a personnummer (ÅÅMMDD-NNNN, which is all the mapping tests) that cannot be anyone's: its check digit is wrong on
 * purpose, so no person has it. A test that needs many numbers takes them from here and never from a counter, because one counter value in ten
 * has a correct check digit, and a number with one can belong to somebody.
 */
export function unrealPersonalNumber(at: number): string {
  const nine = `00010${(at % 8) + 1}${String(100 + (at % 900))}`;
  return `${nine.slice(0, 6)}-${nine.slice(6)}${(checkDigitOf(nine) + 1) % 10}`;
}

/** Whether a personnummer-shaped string (ÅÅMMDD-NNNN or ÅÅÅÅMMDD-NNNN) has a correct check digit: a number somebody may have. */
export function hasValidCheckDigit(text: string): boolean {
  const digits = text.replace(/\D/g, "").slice(-10);
  return digits.length === 10 && checkDigitOf(digits.slice(0, 9)) === Number(digits[9]);
}
