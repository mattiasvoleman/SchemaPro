import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A handler that shows `error.message` shows the gateway's `detail`: English for a 404, a 429 and a 500, and the constant "One or more
 * fields failed validation." for a 400 from a DTO. lib/api-error-text.ts is where a failure becomes the reader's sentence, and this reads
 * the sources as text (the pattern of class-teacher.contract.test.ts) to keep the web from going back: the one-line sink that was written
 * a hundred times,
 *
 *     toast.error(error instanceof Error ? error.message : tCommon("error"))
 *
 * is `apiErrorText(error, tCommon)` now, and a new copy of the old line reads English to a Swedish principal.
 */
const web = join(__dirname, "..");
const ROOTS = ["app", "components", "lib"];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === ".next" ? [] : sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const FILES = ROOTS.flatMap((root) => sources(join(web, root)));
const text = (path: string) => readFileSync(path, "utf8");

/** `x instanceof Error ? x.message : tCommon("error")`, on one line or several, with or without the `&& x.message` guard. */
const RAW_SINK = /(\b\w+) instanceof Error(?: && \1\.message)?\s*\?\s*\1\.message\s*:\s*\w+\("error"\)/g;

describe("a failure is told through apiErrorText", () => {
  it("finds the sources it reads", () => {
    expect(FILES.length).toBeGreaterThan(500);
    expect(FILES.some((path) => path.endsWith("api-error-text.ts"))).toBe(true);
  });

  it("has no handler that shows error.message beside the generic sentence", () => {
    const raw = FILES.flatMap((path) =>
      [...text(path).matchAll(RAW_SINK)].map((match) => `${relative(web, path)}: ${match[0].replace(/\s+/g, " ")}`),
    );
    expect(raw).toEqual([]);
  });

  it("names a request that never got an answer in one place: api.ts throws it, api-error-text.ts reads it", () => {
    const named = FILES.filter((path) => text(path).includes("CLIENT_NETWORK_FAILURE")).map((path) => relative(web, path));
    expect(named).toEqual(["lib/api-error-text.ts"]);
    expect(text(join(web, "lib/api.ts"))).toMatch(/import \{ NETWORK_FAILURE \} from "@\/lib\/api-error-text";/);
  });
});
