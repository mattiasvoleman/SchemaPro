import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EMPTY_SCOPE_DRAFT, SCOPE_EXCEPTIONS, SCOPE_LEVEL_MAX, SCOPE_NOTE_MAX, scopeDraftToBody, validateScopeDraft } from "./scope-assessment-form";

/**
 * The form's bounds and the report's shape are the gateway's, read as text because the web cannot import it (the pattern of
 * class-teacher.contract.test.ts). The form says "the same bounds as the gateway" so that a refusal is rare and the sentence is in
 * the reader's language; a bound that drifts is a form that lets through what the gateway refuses, and the refusal that comes back
 * for a validation error is the generic "One or more fields failed validation.", since the web shows `detail` and not `errors`.
 */
const root = join(__dirname, "..", "..");
const DTO = readFileSync(join(root, "src", "staffing", "dto", "scope-assessment.dto.ts"), "utf8");
const CONTROLLER = readFileSync(join(root, "src", "staffing", "scope-assessments.controller.ts"), "utf8");
const SCOPE = readFileSync(join(root, "src", "staffing", "assignment-scope.ts"), "utf8");
const SCHEMA = readFileSync(join(root, "prisma", "schema.prisma"), "utf8");
const QUERIES = readFileSync(join(__dirname, "scope-assessment-queries.ts"), "utf8");
const WEB_SCOPE = readFileSync(join(__dirname, "assignment-scope.ts"), "utf8");

const constant = (name: string): number => Number(new RegExp(`export const ${name} = (\\d+);`).exec(DTO)?.[1] ?? NaN);

const fieldsOf = (text: string, name: string): string[] => {
  const body = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(text)?.[1] ?? "";
  return [...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((match) => match[1]!).sort();
};

describe("the form's bounds are the gateway's", () => {
  it("holds a level to the gateway's 1..max and a note to its length", () => {
    expect(SCOPE_LEVEL_MAX).toBe(constant("SCOPE_LEVEL_MAX"));
    expect(SCOPE_NOTE_MAX).toBe(constant("SCOPE_NOTE_MAX"));
    expect(Number.isFinite(SCOPE_LEVEL_MAX) && Number.isFinite(SCOPE_NOTE_MAX)).toBe(true);
    expect(/@Min\(1,/.test(DTO)).toBe(true);
    expect(validateScopeDraft({ ...EMPTY_SCOPE_DRAFT, level: "1" })).toBeNull();
    expect(validateScopeDraft({ ...EMPTY_SCOPE_DRAFT, level: "0" })).not.toBeNull();
  });

  it("offers the kinds of exception the database has, in its order", () => {
    const body = /enum AssignmentScopeException \{([^}]*)\}/.exec(SCHEMA)?.[1] ?? "";
    expect([...SCOPE_EXCEPTIONS]).toEqual(body.split(/\s+/).filter(Boolean));
  });
});

describe("the route and the shape are the gateway's", () => {
  it("writes to the route the controller has, by teacher in the address and the year in the query", () => {
    expect(CONTROLLER).toContain("@Controller('api/v1/scope-assessments')");
    expect(CONTROLLER).toMatch(/@Put\(':userId'\)/);
    expect(CONTROLLER).toMatch(/@Delete\(':userId'\)/);
    expect(CONTROLLER).toContain("@Query('academicYearId'");
    expect(QUERIES).toContain("`/api/v1/scope-assessments/${userId}?academicYearId=${encodeURIComponent(academicYearId)}`");
    expect(CONTROLLER).toContain("@Decides()");
  });

  it("reads the assessment off the report with the fields the gateway puts there, and no others", () => {
    expect(fieldsOf(WEB_SCOPE, "ScopeAssessmentView")).toEqual(fieldsOf(SCOPE, "ScopeAssessmentView"));
    expect(fieldsOf(SCOPE, "ScopeAssessmentView")).toEqual(["decidedAt", "exceptionKind", "levelHours", "note", "ownInitiativeOn"]);
  });

  it("sends the fields the DTO has, all of them, because the gateway replaces the row", () => {
    const dto = [...DTO.matchAll(/^\s{2}(\w+)\?: /gm)].map((match) => match[1]!).sort();
    expect(dto).toEqual(["exceptionKind", "note", "ownInitiativeOn", "teachingLevelHours"]);
    expect(Object.keys(scopeDraftToBody(EMPTY_SCOPE_DRAFT)).sort()).toEqual(dto);
  });
});
