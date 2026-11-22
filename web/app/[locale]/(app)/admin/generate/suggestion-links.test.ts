import { describe, expect, it } from "vitest";
import type { SuggestionRule } from "@/lib/suggestion-types";
import { PAGE_OF_RULE, linkOfChange, linkOfRule, linkOfWorkRule } from "./suggestion-links";

/*
 * WHERE A SUGGESTION IS APPLIED (suggestion-links.ts): the page that owns the data and, where a row can be named, the row, as a uuid and
 * nothing else. Nothing here writes, and the address never says what to write.
 */

const ROW = "11111111-1111-4111-8111-111111111111";
const POST = "22222222-2222-4222-8222-222222222222";
const RULES: SuggestionRule[] = ["SUBJECT_DAYS_APART", "SUBJECT_PER_DAY", "ROOM_LOCK", "TEACHER_DAILY_CAP", "TEACHER_WORK_DAYS"];

describe("the link of a change", () => {
  it("opens a teacher's working time on the people page, naming the work rule", () => {
    expect(linkOfChange({ rule: "TEACHER_DAILY_CAP", resourceIds: [ROW], requirementIds: [POST] })).toEqual({
      page: "people",
      href: `/admin/people?workRule=${ROW}`,
    });
  });

  it("opens a post's rule on the requirements page, naming the post and not the room or the rule", () => {
    for (const rule of ["SUBJECT_PER_DAY", "SUBJECT_DAYS_APART"] as const) {
      expect(linkOfChange({ rule, resourceIds: [ROW], requirementIds: [POST] })).toEqual({
        page: "requirements",
        href: `/admin/requirements?post=${POST}`,
      });
    }
  });

  it("names the läsår on a post's link when the run is for a läsår that is not the active one, and only there (granskning av #390, M-6)", () => {
    const YEAR = "33333333-3333-4333-8333-333333333333";
    for (const rule of ["SUBJECT_PER_DAY", "SUBJECT_DAYS_APART"] as const) {
      expect(linkOfChange({ rule, resourceIds: [ROW], requirementIds: [POST] }, YEAR).href).toBe(`/admin/requirements?post=${POST}&year=${YEAR}`);
      expect(linkOfChange({ rule, resourceIds: [ROW], requirementIds: [] }, YEAR).href).toBe(`/admin/requirements?year=${YEAR}`);
      expect(linkOfChange({ rule, resourceIds: [ROW], requirementIds: [POST] }, null).href).toBe(`/admin/requirements?post=${POST}`);
      expect(linkOfChange({ rule, resourceIds: [ROW], requirementIds: [POST] }, "next year</a>").href).toBe(`/admin/requirements?post=${POST}`);
    }
    // A work rule, a room rule and a part-timer's days are the school's, not the läsår's: no year on them.
    expect(linkOfChange({ rule: "TEACHER_DAILY_CAP", resourceIds: [ROW], requirementIds: [POST] }, YEAR).href).toBe(`/admin/people?workRule=${ROW}`);
    expect(linkOfChange({ rule: "ROOM_LOCK", resourceIds: [ROW], requirementIds: [POST] }, YEAR).href).toBe(`/admin/constraints?roomRule=${ROW}`);
    expect(linkOfChange({ rule: "TEACHER_WORK_DAYS", resourceIds: [ROW], requirementIds: [POST] }, YEAR).href).toBe("/admin/staffing");
  });

  it("opens the room rules naming the room rule of the lock", () => {
    expect(linkOfChange({ rule: "ROOM_LOCK", resourceIds: [ROW], requirementIds: [POST] })).toEqual({
      page: "constraints",
      href: `/admin/constraints?roomRule=${ROW}`,
    });
  });

  it("opens the staffing page for a part-timer's days, with no row: the post is HR data and the page is not this card's", () => {
    expect(linkOfChange({ rule: "TEACHER_WORK_DAYS", resourceIds: [ROW], requirementIds: [POST] })).toEqual({ page: "staffing", href: "/admin/staffing" });
  });

  it("puts nothing but a uuid in an address: a run's text never becomes part of a path", () => {
    for (const bad of ["x", "../../admin", `${ROW}&role=ADMIN`, `${ROW}#x`, "", "1"]) {
      for (const rule of RULES) {
        const link = linkOfChange({ rule, resourceIds: [bad], requirementIds: [bad] });
        expect(link.href).toBe(`/admin/${{ people: "people", requirements: "requirements", constraints: "constraints", staffing: "staffing" }[link.page]}`);
        expect(link.href).not.toContain("?");
      }
    }
  });

  it("opens the page without a row where the change names none", () => {
    expect(linkOfChange({ rule: "TEACHER_DAILY_CAP", resourceIds: [], requirementIds: [] }).href).toBe("/admin/people");
    expect(linkOfChange({ rule: "SUBJECT_PER_DAY", resourceIds: [], requirementIds: [] }).href).toBe("/admin/requirements");
  });

  it("gives every rule of the engine's list a page", () => {
    expect(Object.keys(PAGE_OF_RULE).sort()).toEqual([...RULES].sort());
  });
});

describe("the link of a rule alone and of a refusal's work rule", () => {
  it("is the page, for a measurement that names no row", () => {
    expect(linkOfRule("TEACHER_DAILY_CAP")).toEqual({ page: "people", href: "/admin/people" });
    expect(linkOfRule("TEACHER_WORK_DAYS")).toEqual({ page: "staffing", href: "/admin/staffing" });
  });

  it("names the work rule a refusal names, when it is one", () => {
    expect(linkOfWorkRule(ROW).href).toBe(`/admin/people?workRule=${ROW}`);
    expect(linkOfWorkRule(undefined).href).toBe("/admin/people");
    expect(linkOfWorkRule("the work rule of Anna Andersson").href).toBe("/admin/people");
  });
});
