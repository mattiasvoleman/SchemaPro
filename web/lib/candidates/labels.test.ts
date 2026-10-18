import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import {
  changedPartsText,
  FIRST_FAILED_KEYS,
  firstFailedKey,
  isActiveRun,
  isApplicable,
  PART_KEYS,
  REFUSAL_KEYS,
  refusalKey,
  REQUEST_ERROR_KEYS,
  requestErrorKey,
  RUN_ERROR_KEYS,
  runErrorText,
  safetyVersionName,
  signed,
  SOLVER_KEYS,
  solverKey,
  staleParts,
  VARIANT_KEYS,
  variantLabel,
  type EngineLookup,
} from "./labels";

/** An echo of the key and its values, as the page tests' next-intl stub. */
const t = (key: string, values?: Record<string, string | number>) =>
  values ? `${key}(${Object.values(values).join("|")})` : key;

const engine = (known: Record<string, string>): EngineLookup =>
  Object.assign((key: string, values?: Record<string, string | number>) => {
    const template = known[key]!;
    return template.replace(/\{(\w+)\}/g, (_, name: string) => {
      if (values?.[name] === undefined) throw new Error(`missing ${name}`);
      return String(values[name]);
    });
  }, { has: (key: string) => key in known });

describe("which runs and candidates the pages treat as live", () => {
  it("polls, and holds Generera back, while a run is pending, running or being cancelled", () => {
    expect(["PENDING", "RUNNING", "CANCELLING"].every((status) => isActiveRun(status as never))).toBe(true);
    expect(isActiveRun("SUCCEEDED")).toBe(false);
    expect(isActiveRun("FAILED")).toBe(false);
    expect(isActiveRun(undefined)).toBe(false);
  });

  it("applies only a candidate with a timetable", () => {
    expect(isApplicable({ solverStatus: "OPTIMAL" })).toBe(true);
    expect(isApplicable({ solverStatus: "FEASIBLE" })).toBe(true);
    for (const status of ["INFEASIBLE", "TIMEOUT", "REJECTED", null] as const) {
      expect(isApplicable({ solverStatus: status })).toBe(false);
    }
  });
});

describe("names", () => {
  it("names a variant by its emphasis, and an unknown one by its ordinal, never its code", () => {
    expect(variantLabel(t, { variant: "TEACHER_GAPS", ordinal: 2 })).toBe("variant.TEACHER_GAPS");
    expect(variantLabel(t, { variant: "NIGHT_OWLS", ordinal: 5 })).toBe("variant.unknown(5)");
  });

  it("repeats the gateway's Swedish name of the safety version, whatever the language", () => {
    expect(safetyVersionName({ variant: "TEACHER_GAPS", ordinal: 2 })).toBe(
      "Före schemaförslag 2 – Färre håltimmar för lärarna",
    );
    expect(safetyVersionName({ variant: "KEEP", ordinal: 1 })).toBe("Före schemaförslag 1 – Behåll mest");
  });

  it("says why a candidate has no timetable", () => {
    expect(solverKey("TIMEOUT")).toBe("solver.TIMEOUT");
    expect(solverKey(null)).toBe("solver.unknown");
  });

  it("lists the changed parts as a sentence, keeping one it has no word for", () => {
    expect(changedPartsText(t, ["requirements", "rooms", "rules"], "sv")).toBe(
      "parts.requirements, parts.rooms och parts.rules",
    );
    expect(changedPartsText(t, ["rosters", "lunchTables"], "en")).toBe("parts.rosters and lunchTables");
  });
});

describe("why a run ended without a batch", () => {
  const run = (errorCode: string | null, error: string | null = "English for the log", errorParams = null) => ({
    errorCode,
    error,
    errorParams,
  });

  it("says this feature's own codes in its own words", () => {
    expect(runErrorText(t, engine({}), run("ENGINE_LACKS_CANDIDATES"))).toBe("runErrors.ENGINE_LACKS_CANDIDATES");
    // The engine's 5xx: without the key, the gateway's English reached a Swedish school.
    expect(runErrorText(t, engine({}), run("CANDIDATE_ENGINE_FAILED", "The AI engine returned an error."))).toBe(
      "runErrors.CANDIDATE_ENGINE_FAILED",
    );
  });

  it("says a first candidate that ran out of time as that, and promises a list only when there is one", () => {
    expect(firstFailedKey({ solverStatus: "TIMEOUT" }, true)).toBe("runErrors.CANDIDATES_FIRST_TIMEOUT");
    expect(firstFailedKey({ solverStatus: "TIMEOUT" }, false)).toBe("runErrors.CANDIDATES_FIRST_TIMEOUT");
    expect(firstFailedKey({ solverStatus: "INFEASIBLE" }, true)).toBe("runErrors.CANDIDATES_FIRST_FAILED");
    expect(firstFailedKey({ solverStatus: "INFEASIBLE" }, false)).toBe("runErrors.CANDIDATES_FIRST_FAILED_UNNAMED");
    expect(firstFailedKey(undefined, false)).toBe("runErrors.CANDIDATES_FIRST_FAILED_UNNAMED");
  });

  it("says a refusal the engine named in the engine's catalogue, with its values", () => {
    const lookup = engine({ STAFF_UNSTAFFED_REQUIREMENTS: "{count} poster saknar lärare." });
    expect(
      runErrorText(t, lookup, { errorCode: "STAFF_UNSTAFFED_REQUIREMENTS", error: "x", errorParams: { count: 2 } as never }),
    ).toBe("2 poster saknar lärare.");
  });

  it("falls back to the stored English, then to a plain sentence, never to nothing", () => {
    const lookup = engine({ NEEDS_PARAMS: "{count} saknas" });
    expect(runErrorText(t, lookup, run("NEEDS_PARAMS"))).toBe("English for the log");
    expect(runErrorText(t, lookup, run("SOMETHING_NEW"))).toBe("English for the log");
    expect(runErrorText(t, lookup, run(null, null))).toBe("runErrors.generic");
  });

  it("names a refusal today's basis would meet", () => {
    expect(refusalKey("BLOCK_PARTLY_LOCKED_SUMMARY")).toBe("refusal.BLOCK_PARTLY_LOCKED_SUMMARY");
    expect(refusalKey("YEAR_TOO_FAR_AHEAD")).toBe("refusal.other");
  });
});

describe("every refusal of the routes has a sentence (design §3, §4)", () => {
  it.each([
    "CANDIDATES_RUNNING",
    "GENERATE_RUNNING",
    "CANDIDATES_BUSY",
    "CANDIDATES_NEED_A_DRAFT",
    "SCHEDULE_BUSY",
    "PUBLISH_MODE_CHANGED",
    "PUBLISH_IN_PROGRESS",
    "SCHEDULE_CANDIDATE_BUSY",
    "SCHEDULE_CANDIDATE_NOT_APPLICABLE",
    "SCHEDULE_CANDIDATE_STALE",
  ])("%s", (code) => {
    expect(requestErrorKey({ status: 409, code }, "apply")).toBe(`errors.${code}`);
  });

  it("tells the two 404s apart by the route, since neither carries a code", () => {
    expect(requestErrorKey({ status: 404 }, "start")).toBe("errors.REFRESH_GONE");
    expect(requestErrorKey({ status: 404 }, "apply")).toBe("errors.CANDIDATE_GONE");
  });

  it("says the throttle in words, and anything else plainly", () => {
    expect(requestErrorKey({ status: 429 }, "start")).toBe("errors.TOO_MANY");
    expect(requestErrorKey({ status: 500, code: "SOMETHING_NEW" }, "apply")).toBe("errors.generic");
    expect(requestErrorKey(null, "discard")).toBe("errors.generic");
  });

  it("reads the parts a stale refusal names, as an array or flattened", () => {
    expect(staleParts({ changed: ["draft", "rooms"] })).toEqual(["draft", "rooms"]);
    expect(staleParts({ changed: "draft, rooms" })).toEqual(["draft", "rooms"]);
    expect(staleParts({})).toEqual([]);
    expect(staleParts(undefined)).toEqual([]);
  });
});

describe("signed", () => {
  const whole = (value: number) => `${Math.round(value)} min`;
  const tenth = (value: number) => `${value.toFixed(1)} min`;

  it("says which way a difference went in characters", () => {
    expect(signed(30, whole)).toBe("+30 min");
    expect(signed(-5, whole)).toBe("−5 min");
    expect(signed(0, whole)).toBe("±0 min");
  });

  it("calls a difference too small to print no difference", () => {
    expect(signed(0.04, tenth)).toBe("±0.0 min");
    expect(signed(-0.2, whole)).toBe("±0 min");
  });
});

describe("the message files hold every key these helpers can return", () => {
  type Messages = Record<string, unknown>;
  const lookup = (messages: Messages, key: string) =>
    key.split(".").reduce<unknown>((node, part) => (node as Messages | undefined)?.[part], messages);
  const keys = [
    ...Object.values(VARIANT_KEYS),
    "variant.unknown",
    ...Object.values(SOLVER_KEYS),
    "solver.unknown",
    ...Object.values(PART_KEYS),
    ...Object.values(RUN_ERROR_KEYS),
    ...Object.values(FIRST_FAILED_KEYS),
    "runErrors.generic",
    ...Object.values(REFUSAL_KEYS),
    "refusal.other",
    ...Object.values(REQUEST_ERROR_KEYS),
    "errors.TOO_MANY",
    "errors.REFRESH_GONE",
    "errors.CANDIDATE_GONE",
    "errors.generic",
  ];

  it.each([
    ["sv", sv],
    ["en", en],
  ])("%s", (_, messages) => {
    const namespace = (messages as Messages).scheduleCandidates as Messages;
    expect(keys.filter((key) => typeof lookup(namespace, key) !== "string")).toEqual([]);
  });

  /*
   * The other way round: a run's sentence nothing can reach is a code the
   * gateway stores and the page then says in English (CANDIDATE_ENGINE_FAILED
   * was one). Every runErrors key is a stored code's, except the plain
   * fallback and the sentences firstFailedKey chooses by the first
   * candidate's verdict.
   */
  it.each([
    ["sv", sv],
    ["en", en],
  ])("%s: every runErrors sentence is reachable from a stored code", (_, messages) => {
    const runErrors = ((messages as Messages).scheduleCandidates as Messages).runErrors as Messages;
    const chosen = new Set(["runErrors.generic", ...Object.values(FIRST_FAILED_KEYS)]);
    const reachable = new Set(Object.values(RUN_ERROR_KEYS));
    const unreachable = Object.keys(runErrors)
      .map((key) => `runErrors.${key}`)
      .filter((key) => !chosen.has(key) && !reachable.has(key));
    expect(unreachable).toEqual([]);
  });
});
