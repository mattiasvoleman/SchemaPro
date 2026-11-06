import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import type { MessageLookup } from "@/lib/engine-message";
import {
  ALWAYS_START,
  STARTABLE_PROFILES,
  blockingAlarmId,
  clock,
  countPupils,
  crisisErrorText,
  groupLabel,
  markTime,
  mayAct,
  newMark,
  stopwatch,
  unmarkedPupils,
  uuidV4,
} from "./crisis-view";
import { STARTED } from "./__fixtures__/crisis";

/** A catalogue with the given keys, answering like next-intl's lookup: the key's text, or has() false. */
function lookup(messages: Record<string, string>): MessageLookup {
  const t = ((key: string) => messages[key] ?? `?${key}`) as MessageLookup;
  t.has = (key) => key in messages;
  return t;
}

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("who may start, end and mark an alarm (mayAct)", () => {
  it("is always rektor and full, whatever the school chose, and never the läsare", () => {
    for (const profile of ALWAYS_START) expect(mayAct(profile, [])).toBe(true);
    expect(mayAct("LASARE", [...STARTABLE_PROFILES])).toBe(false);
    expect(mayAct(null, undefined)).toBe(false);
  });

  it("reads a profile built without an admin profile as full, as the (app) layout does", () => {
    expect(mayAct(undefined, [])).toBe(true);
  });

  it("follows the school's list for the narrower profiles", () => {
    expect(mayAct("SCHEMALAGGARE", ["FULL", "REKTOR", "SCHEMALAGGARE"])).toBe(true);
    expect(mayAct("EXPEDITION", ["FULL", "REKTOR", "SCHEMALAGGARE"])).toBe(false);
  });

  it("does not hold an alarm back for settings that could not be read: the database says no where it is no", () => {
    expect(mayAct("EXPEDITION", undefined)).toBe(true);
  });
});

describe("a mark's id", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is a v4 uuid, a new one each time", () => {
    const ids = Array.from({ length: 50 }, () => uuidV4());
    expect(new Set(ids).size).toBe(50);
    for (const id of ids) expect(id).toMatch(V4);
  });

  it("is a v4 uuid on a page without crypto.randomUUID (an insecure context)", () => {
    vi.stubGlobal("crypto", { getRandomValues: (bytes: Uint8Array) => bytes.fill(255) });
    expect(uuidV4()).toMatch(V4);
  });

  it("goes with the group, the pupil, the state and the time of a mark", () => {
    const mark = newMark("c-1", "s-1", "MISSING", STARTED);
    expect(mark).toMatchObject({ callId: "c-1", studentId: "s-1", state: "MISSING", at: STARTED });
    expect(mark.id).toMatch(V4);
  });
});

describe("the time of a mark", () => {
  it("is the device's clock moved by how far it was from the gateway's", () => {
    const now = Date.parse(STARTED) + 60_000;
    expect(markTime(now, 0, STARTED)).toBe(new Date(now).toISOString());
    expect(markTime(now, -5_000, STARTED)).toBe(new Date(now - 5_000).toISOString());
    expect(markTime(now, 5_000, STARTED)).toBe(new Date(now + 5_000).toISOString());
  });

  it("is never before the alarm began: the database holds a mark between the start and now", () => {
    expect(markTime(Date.parse(STARTED) - 90_000, 0, STARTED)).toBe(STARTED);
  });
});

describe("the figures", () => {
  it("count each status once", () => {
    expect(countPupils(["FOUND", "FOUND", "MISSING", "ABSENT_BEFORE", "UNREPORTED", "UNREPORTED"])).toEqual({
      pupils: 6,
      found: 2,
      missing: 1,
      absentBefore: 1,
      unreported: 2,
    });
  });

  it("leave 'Alla finns' the pupils nobody has marked: not the absent, not the found, and never the one marked missing", () => {
    expect(
      unmarkedPupils([
        { studentId: "a", status: "UNREPORTED" },
        { studentId: "b", status: "FOUND" },
        { studentId: "c", status: "MISSING" },
        { studentId: "d", status: "ABSENT_BEFORE" },
        { studentId: "e", status: "UNREPORTED" },
      ]),
    ).toEqual(["a", "e"]);
  });
});

describe("the clocks", () => {
  it("write a time in the school's zone and the reader's language, 24 hours in both", () => {
    expect(clock("2027-01-12T09:14:00.000Z", "sv", "Europe/Stockholm")).toBe("10:14");
    expect(clock("2027-01-12T09:14:00.000Z", "en", "Europe/Stockholm")).toBe("10:14");
    expect(clock("2027-01-12T09:14:00.000Z", "sv", "Asia/Tokyo")).toBe("18:14");
  });

  it("show how long an alarm has gone as a stopwatch", () => {
    const start = Date.parse(STARTED);
    expect(stopwatch(start, start + 4 * 60_000 + 12_000)).toBe("04:12");
    expect(stopwatch(start, start + 3_600_000 + 5 * 60_000 + 9_000)).toBe("1:05:09");
    expect(stopwatch(start, start - 5_000)).toBe("00:00");
  });
});

describe("a refusal in words", () => {
  const t = lookup({ CRISIS_NOT_YOURS: "Din roll får inte.", THROTTLED: "För många.", OFFLINE: "Ingen kontakt." });

  it("is the sentence of the gateway's code, a 429's, or the network's", () => {
    expect(crisisErrorText(t, new ApiError(403, "Du får inte", "CRISIS_NOT_YOURS"), "x")).toBe("Din roll får inte.");
    expect(crisisErrorText(t, new ApiError(429, "ThrottlerException"), "x")).toBe("För många.");
    expect(crisisErrorText(t, new TypeError("Failed to fetch"), "x")).toBe("Ingen kontakt.");
  });

  it("is the caller's own for anything it has no sentence for, never the gateway's prose", () => {
    expect(crisisErrorText(t, new ApiError(500, "Internal error"), "Det gick inte")).toBe("Det gick inte");
    expect(crisisErrorText(t, new ApiError(409, "Ett larm pågår", "SOMETHING_NEW"), "Det gick inte")).toBe("Det gick inte");
  });
});

describe("the alarm that refused a start", () => {
  const ID = "0f4e3c2a-9d1b-4a6e-8c3f-5b7d9e1a2c4f";

  it("is named by params.alarmId of a 409 CRISIS_ALARM_OPEN", () => {
    expect(blockingAlarmId(new ApiError(409, "Ett larm pågår", "CRISIS_ALARM_OPEN", { alarmId: ID.toUpperCase() }))).toBe(ID);
  });

  it("is nobody when the gateway names none (the loser of a race), or names something that is no id", () => {
    expect(blockingAlarmId(new ApiError(409, "Ett larm pågår", "CRISIS_ALARM_OPEN"))).toBeNull();
    expect(blockingAlarmId(new ApiError(409, "Ett larm pågår", "CRISIS_ALARM_OPEN", { alarmId: "../../x" }))).toBeNull();
    expect(blockingAlarmId(new ApiError(409, "Slut", "CRISIS_ALARM_ENDED", { alarmId: ID }))).toBeNull();
    expect(blockingAlarmId(new Error("x"))).toBeNull();
  });
});

describe("a group's name as the page says it", () => {
  it("is the gateway's name, except for the group of pupils on no lesson, which is said in the page's own words", () => {
    expect(groupLabel({ basis: "LESSON", groupName: "7A" }, "Ej i lektion just nu")).toBe("7A");
    expect(groupLabel({ basis: "NEXT_LESSON", groupName: "8B" }, "Ej i lektion just nu")).toBe("8B");
    // The gateway's stand-in is Swedish whatever the reader's language is.
    expect(groupLabel({ basis: "NO_LESSON", groupName: "Ej i lektion just nu" }, "Not in a lesson right now")).toBe("Not in a lesson right now");
  });
});
