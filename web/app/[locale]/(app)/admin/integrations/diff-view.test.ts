import { describe, expect, it, vi } from "vitest";
import {
  endedGuardianLinks,
  isSelectable,
  matchesFilter,
  personNames,
  readChange,
  selectionBody,
  summarise,
  withAll,
} from "./diff-view";
import { inviteInChunks } from "./use-ss12000-sync";
import { urlProblem, inputOf } from "./source-card";
import type { SyncChange } from "./ss12000-types";

/**
 * The review's arithmetic without the dialog. What it must hold: the apply
 * sends exactly what the admin changed from the gateway's defaults, a note or
 * an applied change is never selectable, a run that has left DIFF_READY
 * offers nothing, and a row names its person even when the change itself
 * carries only an id.
 */

let seq = 0;
const change = (over: Partial<SyncChange>): SyncChange => ({
  id: `c${++seq}`,
  seq,
  entity: "PERSON",
  op: "UPDATE",
  externalId: null,
  localId: null,
  before: null,
  after: null,
  conflictCode: null,
  selected: true,
  autoApplicable: false,
  protectedIdentity: false,
  applied: false,
  ...over,
});

describe("selection", () => {
  const create = change({ op: "CREATE", selected: true });
  const relink = change({ op: "RELINK", selected: false, conflictCode: "PERSON_MATCHES_INACTIVE" });
  const conflict = change({ op: "CONFLICT", selected: false, conflictCode: "PERSON_EMAIL_TAKEN" });
  const applied = change({ op: "MOVE", entity: "CLASS_MEMBERSHIP", selected: true, applied: true });
  const deactivate = change({ op: "DEACTIVATE", selected: true, protectedIdentity: false });
  const protectedOne = change({ op: "UPDATE", selected: false, protectedIdentity: true });
  const all = [create, relink, conflict, applied, deactivate, protectedOne];

  it("sends nothing when the admin changed nothing", () => {
    expect(selectionBody(all, new Map(), "DIFF_READY")).toEqual({ select: [], deselect: [] });
  });

  it("sends a tick on a default-off change as select and an untick on a default-on change as deselect", () => {
    const overrides = new Map([
      [relink.id, true],
      [protectedOne.id, true],
      [deactivate.id, false],
      [create.id, true], // the default anyway: not sent
    ]);
    expect(selectionBody(all, overrides, "DIFF_READY")).toEqual({ select: [relink.id, protectedOne.id], deselect: [deactivate.id] });
  });

  it("never offers a note, an applied change or anything of a run that is not DIFF_READY", () => {
    expect(isSelectable(conflict, "DIFF_READY")).toBe(false);
    expect(isSelectable(applied, "DIFF_READY")).toBe(false);
    expect(isSelectable(create, "APPLIED")).toBe(false);
    expect(selectionBody(all, new Map([[conflict.id, true], [applied.id, false]]), "DIFF_READY")).toEqual({ select: [], deselect: [] });
    expect(selectionBody(all, new Map([[relink.id, true]]), "SUPERSEDED")).toEqual({ select: [], deselect: [] });
  });

  it("counts what would be applied, the deactivations among it, and the protected among it", () => {
    expect(summarise(all, new Map(), "DIFF_READY")).toEqual({
      chosen: 2,
      selectable: 4,
      deactivations: 1,
      protectedChosen: 0,
      applied: 1,
      notes: 1,
    });
    expect(summarise(all, new Map([[protectedOne.id, true]]), "DIFF_READY").protectedChosen).toBe(1);
  });

  it("ticks only the selectable among the shown", () => {
    const next = withAll(new Map(), all, "DIFF_READY", false);
    expect([...next.keys()].sort()).toEqual([create.id, relink.id, deactivate.id, protectedOne.id].sort());
    expect([...next.values()].every((value) => value === false)).toBe(true);
  });

  it("filters on kind, and on what needs attention", () => {
    const group = change({ entity: "GROUP", op: "CREATE" });
    expect(matchesFilter(group, { entity: "PERSON", attention: false })).toBe(false);
    expect(matchesFilter(group, { entity: "ALL", attention: false })).toBe(true);
    expect(matchesFilter(group, { entity: "ALL", attention: true })).toBe(false);
    expect(matchesFilter(relink, { entity: "ALL", attention: true })).toBe(true);
    expect(matchesFilter(protectedOne, { entity: "PERSON", attention: true })).toBe(true);
  });
});

describe("reading a change", () => {
  const ada = change({ op: "CREATE", externalId: "ext-ada", after: { role: "STUDENT", firstName: "Ada", lastName: "Lind", email: "ada@skola.se" } });
  const move = change({
    entity: "CLASS_MEMBERSHIP",
    op: "MOVE",
    externalId: "ext-ada",
    before: { studentGroupId: null, groupName: null },
    after: { groupName: "7A" },
  });
  const names = personNames([ada, move]);
  const local = (id: string) => (id === "u-bo" ? "Bo Ek" : null);

  it("names a person the change carries only by id, from the run's own person rows", () => {
    expect(readChange(ada, names, local)).toEqual({ subject: "Ada Lind", detail: { key: "roleEmail", values: { role: "STUDENT", email: "ada@skola.se" } } });
    expect(readChange(move, names, local)).toEqual({ subject: "Ada Lind", detail: { key: "classJoin", values: { to: "7A" } } });
  });

  it("reads an email change, a name change, a deactivation's reason and a duty", () => {
    expect(readChange(change({ localId: "u-bo", before: { email: "bo@a.se" }, after: { email: "bo@b.se" } }), names, local)).toEqual({
      subject: "Bo Ek",
      detail: { key: "emailChange", values: { from: "bo@a.se", to: "bo@b.se" } },
    });
    expect(
      readChange(change({ before: { firstName: "Bo", lastName: "Ek" }, after: { firstName: "Bo", lastName: "Eklund" } }), names, local),
    ).toEqual({ subject: "Bo Ek", detail: { key: "nameChange", values: { from: "Bo Ek", to: "Bo Eklund" } } });
    expect(
      readChange(change({ op: "DEACTIVATE", before: { firstName: "Cia", lastName: "Holm" }, after: { reason: "NO_ACTIVE_CHILD" } }), names, local),
    ).toEqual({ subject: "Cia Holm", detail: { key: "reason.NO_ACTIVE_CHILD", values: {} } });
    expect(
      readChange(
        change({ entity: "DUTY_LINK", op: "ADD", after: { personExternalId: "ext-ada", dutyRole: "Lärare", startDate: "2026-08-17", endDate: null } }),
        names,
        local,
      ),
    ).toEqual({ subject: "Ada Lind", detail: { key: "duty", values: { role: "Lärare", start: "2026-08-17" } } });
  });

  it("reads a minimised row by kind alone", () => {
    expect(readChange(change({ entity: "GROUP", op: "CREATE" }), new Map(), () => null)).toEqual({ subject: null, detail: null });
  });

  it("lists each pupil whose guardian the register no longer names, once", () => {
    const ended = change({
      entity: "RESPONSIBLE",
      op: "CONFLICT",
      conflictCode: "RESPONSIBLE_ENDED_AT_SOURCE",
      localId: "u-pupil",
      after: { guardianLocalId: "u-g", guardianName: "Gun Berg" },
    });
    expect(endedGuardianLinks([ended, { ...ended, id: "dup" }, ada])).toEqual([{ pupilId: "u-pupil", guardianName: "Gun Berg" }]);
  });
});

describe("Bjud in valda", () => {
  it("sends 500 at a time and sums the reports, counting a failed chunk against each of its people", async () => {
    const ids = Array.from({ length: 1203 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    const post = vi
      .fn()
      .mockResolvedValueOnce({ sent: 498, alreadyRegistered: 1, errors: [{ userId: ids[3]!, message: "x" }] })
      .mockRejectedValueOnce(new Error("HTTP 502"))
      .mockResolvedValueOnce({ sent: 203, alreadyRegistered: 0, errors: [] });
    const report = await inviteInChunks(ids, post);
    expect(post.mock.calls.map(([chunk]) => (chunk as string[]).length)).toEqual([500, 500, 203]);
    expect(report.sent).toBe(701);
    expect(report.alreadyRegistered).toBe(1);
    expect(report.errors).toHaveLength(501);
    expect(report.sent + report.alreadyRegistered + report.errors.length).toBe(ids.length);
  });
});

describe("the source form", () => {
  it("says what is wrong with an address before the gateway does", () => {
    expect(urlProblem("", "base")).toBeNull();
    expect(urlProblem("https://api.ist.com/ss12000v2-api/source/x/v2.0", "base")).toBeNull();
    expect(urlProblem("http://api.ist.com/v2.0", "base")).toBe("https");
    expect(urlProblem("https://user:pw@api.ist.com/v2.0", "base")).toBe("userinfo");
    expect(urlProblem("https://api.ist.com/v2.0?x=1", "base")).toBe("query");
    expect(urlProblem("https://api.ist.com/v2.0/", "base")).toBe("query");
    expect(urlProblem("https://skolid.se/connect/token#a", "token")).toBe("query");
  });

  it("sends a client only for the sign-ins that use one", () => {
    const base = {
      name: " IST ",
      baseUrl: "https://api.ist.com/v2.0",
      tokenUrl: "https://skolid.se/connect/token",
      clientId: "abc",
      tokenScope: "",
      tokenAuthStyle: "BASIC" as const,
      pageSize: "1000",
      enabled: true,
    };
    expect(inputOf({ ...base, authKind: "OAUTH2_CLIENT_CREDENTIALS" })).toMatchObject({
      name: "IST",
      tokenUrl: "https://skolid.se/connect/token",
      clientId: "abc",
      tokenScope: null,
      pageSize: 1000,
    });
    expect(inputOf({ ...base, authKind: "BEARER_TOKEN" })).toMatchObject({ tokenUrl: null, clientId: null });
    expect(inputOf({ ...base, authKind: "MTLS_CLIENT_CERT", tokenUrl: "", clientId: "" })).toMatchObject({ tokenUrl: null, clientId: null });
    expect(inputOf({ ...base, authKind: "OAUTH2_CLIENT_CREDENTIALS", pageSize: "50" })).not.toHaveProperty("pageSize");
  });
});
