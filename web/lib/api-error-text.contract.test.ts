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

/**
 * The forms the one-line sink takes, each as the pattern that finds it:
 *
 *   - `x instanceof Error ? x.message : <any other sentence>` (`t("failed")`, `""`, a Swedish fallback), with or without the
 *     `&& x.message` guard, and with `ApiError` for `Error`: the reserve sentence is not what makes it a leak;
 *   - `x instanceof ApiError || x instanceof Error ? x.message : …`;
 *   - `(x as Error).message` and `(x as ApiError).message`;
 *   - `toast.error(String(x))`;
 *   - `errorText(t, x, "")` and the like (a helper that takes the fallback for a failure with no code of its own): an empty fallback
 *     is the failure's own `message`, so pass `tCommon`, which says a 404, a 429, a 5xx and a lost connection in the reader's language;
 *   - a toast whose text reads `error.message`, `err.message`, `cause.message` or `caught.message` anywhere in the call.
 */
const RAW_SINKS: ReadonlyArray<readonly [string, RegExp]> = [
  ["instanceof ? x.message :", /(\b\w+) instanceof (?:Api)?Error(?: && \1\.message)?\s*\?\s*\1\.message\s*:\s*[^\n;]+/g],
  ["instanceof || instanceof ? x.message", /instanceof (?:Api)?Error\s*\|\|\s*\w+ instanceof (?:Api)?Error\s*\?\s*\w+\.message/g],
  ["(x as Error).message", /\(\s*\w+ as (?:Api)?Error\s*\)\.message/g],
  ["toast(String(x))", /toast\.\w+\(\s*String\(/g],
  ["errorText(…, \"\")", /\b(?:errorText|failureText|publicationErrorText)\(\s*(?:\w+,\s*)?[\w.]+,\s*""\s*\)/g],
  ["toast reads x.message", /toast\.(?:error|warning|info|message)\([^;]{0,800}?\b(?:error|err|cause|caught)\.message\b/g],
];

/**
 * The places a failure's own `message` is read for a reason that is not a sentence for the reader, and why: the file, a piece of the
 * hit that picks the place out, and the reason. A new read is a failing test here: say it through `apiErrorText(error, tCommon)`, or
 * add it with the reason.
 */
const NOT_A_SENTENCE: ReadonlyArray<{ file: string; hit: string; why: string }> = [
  {
    file: "lib/api.ts",
    hit: "cause instanceof Error ? cause.message",
    why: "builds the ApiError out of what fetch rejected with: that `message` is the browser's, and apiErrorText never shows it (NETWORK_FAILURE)",
  },
  {
    file: "lib/placement-write.ts",
    hit: "reason instanceof Error ? reason.message",
    why: "WriteFailure.message is the reason's, for a log; the page reads `reason` and says it through apiErrorText",
  },
  {
    file: "lib/week-check.ts",
    hit: "error instanceof Error ? error.message",
    why: "an `unavailable` outcome keeps the failure's words for the record; the panel says unavailableOlder or unavailable and shows no message",
  },
  {
    file: "lib/queries.ts",
    hit: "error instanceof Error ? error.message",
    why: "the row a later import batch stopped at keeps the failure's `message` and carries the failure itself (`failure`), which the dialog says through apiErrorText",
  },
];

const hits = (path: string): string[] =>
  RAW_SINKS.flatMap(([name, pattern]) => [...text(path).matchAll(pattern)].map((match) => `${name}: ${match[0].replace(/\s+/g, " ").slice(0, 120)}`));

const excused = (file: string, hit: string): boolean =>
  NOT_A_SENTENCE.some((place) => place.file === file && hit.includes(place.hit));

describe("a failure is told through apiErrorText", () => {
  it("finds the sources it reads", () => {
    expect(FILES.length).toBeGreaterThan(500);
    expect(FILES.some((path) => path.endsWith("api-error-text.ts"))).toBe(true);
  });

  it("has no handler that shows error.message, beside the generic sentence or any other", () => {
    const raw = FILES.flatMap((path) => {
      const file = relative(web, path);
      return hits(path).filter((hit) => !excused(file, hit)).map((hit) => `${file}: ${hit}`);
    });
    expect(raw).toEqual([]);
  });

  it("keeps its list of exceptions to reads that are still there", () => {
    const stale = NOT_A_SENTENCE.filter((place) => !hits(join(web, place.file)).some((hit) => hit.includes(place.hit))).map((place) => place.file);
    expect(stale).toEqual([]);
  });

  it("names a request that never got an answer in one place: api.ts throws it, api-error-text.ts reads it", () => {
    const named = FILES.filter((path) => text(path).includes("CLIENT_NETWORK_FAILURE")).map((path) => relative(web, path));
    expect(named).toEqual(["lib/api-error-text.ts"]);
    expect(text(join(web, "lib/api.ts"))).toMatch(/import \{ NETWORK_FAILURE \} from "@\/lib\/api-error-text";/);
  });
});
