import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The text of a fixture under web/lib/__fixtures__/skola24/ (synthetic; see the README there). Tests only. */
export function readFixture(name: string): string {
  return readFileSync(join(__dirname, "skola24", name), "utf8");
}
