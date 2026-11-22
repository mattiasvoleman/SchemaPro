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
