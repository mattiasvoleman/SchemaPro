import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { teachesLike } from "./teaching-staff";

describe("teachesLike", () => {
  it("takes a teacher, a marked administrator and nobody else", () => {
    expect(teachesLike({ role: "TEACHER" })).toBe(true);
    expect(teachesLike({ role: "TEACHER", teaches: false })).toBe(true);
    expect(teachesLike({ role: "SCHOOL_ADMIN", teaches: true })).toBe(true);
    expect(teachesLike({ role: "SCHOOL_ADMIN", teaches: false })).toBe(false);
    expect(teachesLike({ role: "STUDENT" })).toBe(false);
    expect(teachesLike({ role: "GUARDIAN" })).toBe(false);
  });

  it("reads the mark strictly: a person listed by a gateway older than the web is not marked", () => {
    expect(teachesLike({ role: "SCHOOL_ADMIN" })).toBe(false);
    expect(teachesLike({ role: "SCHOOL_ADMIN", teaches: undefined })).toBe(false);
    expect(teachesLike({ role: "SCHOOL_ADMIN", teaches: null })).toBe(false);
  });

  it("does not let the mark on any other role make a teacher of them", () => {
    // The database zeroes the mark on a LASARE-profile and the gateway only
    // sets it on an administrator; a stray true on a pupil is not a teacher.
    expect(teachesLike({ role: "STUDENT", teaches: true })).toBe(false);
    expect(teachesLike({ role: "GUARDIAN", teaches: true })).toBe(false);
  });

  it("says the gateway's sentence (src/staffing/teaching-staff.ts)", () => {
    // The web cannot import the gateway, so the two predicates are compared as
    // text: the same two roles, the same mark, read the same way.
    const gateway = readFileSync(join(__dirname, "..", "..", "src", "staffing", "teaching-staff.ts"), "utf8");
    const web = readFileSync(join(__dirname, "teaching-staff.ts"), "utf8");
    const body = (source: string): string => {
      const line = source.split("\n").find((candidate) => candidate.includes("person.role === 'TEACHER'") || candidate.includes('person.role === "TEACHER"'));
      return (line ?? "").replace(/['"]/g, "'").replace(/^\s*return\s+/, "").replace(/;$/, "").trim();
    };
    expect(body(gateway)).not.toBe("");
    expect(body(web)).toBe(body(gateway));
  });
});
