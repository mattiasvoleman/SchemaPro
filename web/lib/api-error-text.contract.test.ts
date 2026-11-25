import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { GATEWAY_LOG } from "@/lib/api-error-text";

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

/** The names a caught failure goes by in the sources: `error`, `err`, `e`, `ex`, `cause`, `caught`, `failure`, `reason`, `exception`. */
const FAILURE = String.raw`(?:error|err|e|ex|cause|caught|failure|reason|exception)`;

/**
 * The forms the one-line sink takes, each as the pattern that finds it:
 *
 *   - `x instanceof Error ? x.message : <any other sentence>` (`t("failed")`, `""`, a Swedish fallback), with or without the
 *     `&& x.message` guard or an optional chain (`x?.message`), and with `ApiError` for `Error`: the reserve sentence is not what makes
 *     it a leak;
 *   - `x instanceof ApiError || x instanceof Error ? x.message : …`;
 *   - `(x as Error).message` and `(x as ApiError).message`;
 *   - `toast.error(String(x))`;
 *   - `errorText(t, x, "")` and the like (a helper that takes the fallback for a failure with no code of its own): an empty fallback
 *     is the failure's own `message`, so pass `tCommon`, which says a 404, a 429, a 5xx and a lost connection in the reader's language;
 *   - a toast whose text reads `x.message` or `x?.message` anywhere in the call, for any of the names above and however long the call is;
 *   - an optional chain on the failure's message wherever it is: `error?.message ?? t("failed")` is the same read as the ternary above.
 */
const RAW_SINKS: ReadonlyArray<readonly [string, RegExp]> = [
  ["instanceof ? x.message :", /(\b\w+) instanceof (?:Api)?Error(?: && \1\??\.message)?\s*\?\s*\1\??\.message\s*:\s*[^\n;]+/g],
  ["instanceof || instanceof ? x.message", /instanceof (?:Api)?Error\s*\|\|\s*\w+ instanceof (?:Api)?Error\s*\?\s*\w+\??\.message/g],
  ["(x as Error).message", /\(\s*\w+ as (?:Api)?Error\s*\)\??\.message/g],
  ["toast(String(x))", /toast\.\w+\(\s*String\(/g],
  ["errorText(…, \"\")", /\b(?:errorText|failureText|publicationErrorText)\(\s*(?:\w+,\s*)?[\w.]+,\s*""\s*\)/g],
  ["toast reads x.message", new RegExp(String.raw`toast\.(?:error|warning|info|message)\([^;]{0,2000}?\b${FAILURE}\??\.message\b`, "g")],
  ["x?.message", new RegExp(String.raw`\b${FAILURE}\?\.message\b`, "g")],
];

/**
 * The places a failure's own `message` is read for a reason that is not a sentence for the reader, and why: the file, a piece of the
 * hit that picks the place out, and the reason. A new read is a failing test here: say it through `apiErrorText(error, tCommon)`, or
 * add it with the reason.
 */
const NOT_A_SENTENCE: ReadonlyArray<{ file: string; hit: string; why: string }> = [
  {
    file: "lib/api.ts",
    hit: "cause instanceof Error ? cause.message : String(cause)",
    why: "builds the ApiError out of what fetch rejected with: that `message` is the browser's, and apiErrorText never shows it (NETWORK_FAILURE)",
  },
  {
    file: "lib/placement-write.ts",
    hit: "reason instanceof Error ? reason.message : \"Förläggningarna sparades inte.\"",
    why: "WriteFailure.message is the reason's, for a log; the page reads `reason` and says it through apiErrorText",
  },
  {
    file: "lib/week-check.ts",
    hit: "error instanceof Error ? error.message : \"\" }",
    why: "an `unavailable` outcome keeps the failure's words for the record; the panel says unavailableOlder or unavailable and shows no message",
  },
  {
    file: "lib/queries.ts",
    hit: "error instanceof Error ? error.message : \"Importen avbröts.",
    why: "the row a later import batch stopped at keeps the failure's `message` and carries the failure itself (`failure`), which the dialog says through apiErrorText",
  },
];

const hitsIn = (source: string): string[] =>
  RAW_SINKS.flatMap(([name, pattern]) => [...source.matchAll(pattern)].map((match) => `${name}: ${match[0].replace(/\s+/g, " ").slice(0, 120)}`));

const hits = (path: string): string[] => hitsIn(text(path));

const excused = (file: string, hit: string): boolean =>
  NOT_A_SENTENCE.some((place) => place.file === file && hit.includes(place.hit));

/** One line of source per form the patterns above are written to find: a form missing here is a form nobody has tried the guard on. */
const FORMS: ReadonlyArray<readonly [string, string]> = [
  ["the ternary", 'toast.error(error instanceof Error ? error.message : tCommon("error"))'],
  ["the ternary with ApiError and another sentence", 'const m = e instanceof ApiError ? e.message : t("failed")'],
  ["the ternary with an empty fallback", 'const m = reason instanceof Error ? reason.message : ""'],
  ["the ternary through an optional chain", 'const m = err instanceof Error ? err?.message : ""'],
  ["the ternary with a guard", 'toast.error(error instanceof Error && error.message ? error.message : t("x"))'],
  ["the ternary over several lines", 'toast.error(\n  error instanceof Error\n    ? error.message\n    : t("failed"),\n)'],
  ["a cast", "toast.error((e as Error).message)"],
  ["a cast to ApiError", "toast.error((cause as ApiError).message)"],
  ["String(x) in a toast", "toast.error(String(err))"],
  ["an empty fallback to errorText", 'errorText(tErrors, source.error, "")'],
  ["a template in a toast", 'toast.error(`${t("x")}: ${error.message}`)'],
  ["a toast on `e`", "onError: (e) => toast.error(e.message)"],
  ["a toast on `ex`", "toast.error(ex.message)"],
  ["a toast on `failure`", "toast.error(failure.message)"],
  ["a toast on an optional chain", 'toast.error(error?.message ?? t("x"))'],
  ["a toast whose text is long", `toast.error("${"x".repeat(1500)}" + error.message)`],
  ["an optional chain outside a toast", 'setMessage(failure?.message ?? "")'],
];

const SINKS_FOUND = (line: string): string[] => RAW_SINKS.filter(([, pattern]) => new RegExp(pattern.source, pattern.flags).test(line)).map(([name]) => name);

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

  it.each(FORMS)("finds %s", (_form, line) => {
    expect(SINKS_FOUND(line)).not.toEqual([]);
  });

  it("excuses a file for the read it was listed for and no other: a new copy of the old line beside it is caught", () => {
    for (const place of NOT_A_SENTENCE) {
      const source = text(join(web, place.file));
      const unlisted = (extra: string) => hitsIn(`${source}\n${extra}\n`).filter((hit) => !excused(place.file, hit));
      expect(unlisted("")).toEqual([]);
      expect(unlisted('export const leak = (error: unknown) => toast.error(error instanceof Error ? error.message : "x");')).not.toEqual([]);
    }
  });

  it("does not take a message that is not a failure's for a sink", () => {
    for (const line of ["const text = problem.message", "toast.error(t(error.code))", "setRefusal({ message: refusal.message })", "toast.error(t('x', { name: user.name }))"]) {
      expect(SINKS_FOUND(line)).toEqual([]);
    }
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

  it("lists as the gateway's own only sentences its sources still say", () => {
    // The gateway is two directories up from web/lib, and its sentences are written over several literals where a line is long.
    const gateway = ["common/filters/http-exception.filter.ts", "auth/roles.guard.ts", "auth/jwt.strategy.ts"]
      .map((file) => text(join(web, "..", "src", file)))
      .join("\n")
      .replace(/'\s*\+\s*'/g, "");
    // Nest's own, thrown by the framework when a guard says no: not in src/.
    const framework = new Set(["Forbidden resource"]);
    const gone = Object.keys(GATEWAY_LOG).filter((sentence) => !framework.has(sentence) && !gateway.includes(sentence));
    // A sentence the gateway has reworded or given a code is no longer a log's: take it out of GATEWAY_LOG (lib/api-error-text.ts), and
    // the web shows what the gateway says now.
    expect(gone).toEqual([]);
  });
});
