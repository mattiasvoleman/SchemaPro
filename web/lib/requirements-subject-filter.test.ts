import { describe, expect, it } from "vitest";
import { splitGroupsByKind } from "@/lib/group-sections";
import { subjectView } from "@/lib/requirements-subject-filter";
import type { StudentGroup, TeachingRequirement } from "@/lib/types";

const group = (name: string, kind: StudentGroup["kind"], extra: Partial<StudentGroup> = {}): StudentGroup => ({
  id: `g-${name}`,
  academicYearId: "y1",
  name,
  kind,
  gradeLevel: kind === "CLASS" ? 7 : null,
  ...extra,
});

const post = (id: string, subjectId: string, groupId: string): TeachingRequirement =>
  ({ id, academicYearId: "y1", subjectId, studentGroupId: groupId, lessonsPerWeek: 2, minutesPerLesson: 60 }) as TeachingRequirement;

const sv = { id: "s-sv", name: "Svenska" };
const ma = { id: "s-ma", name: "Matematik" };
const sva = { id: "s-sva", name: "Svenska som andraspråk" };
const columns = [ma, sv, sva];

const g7A = group("7A", "CLASS");
const g7B = group("7B", "CLASS");
const g7C = group("7C", "CLASS");
const sva7 = group("SvA7", "TEACHING_GROUP", { replacesSubjectId: sv.id });
const half1 = group("7A:1", "TEACHING_GROUP", { gradeLevel: 7, halfOfId: g7A.id });
const half2 = group("7A:2", "TEACHING_GROUP", { gradeLevel: 7, halfOfId: g7A.id });
const ma7 = group("Ma7", "TEACHING_GROUP");

const posts = [
  post("r1", sv.id, g7A.id),
  post("r2", sv.id, g7B.id),
  post("r3", ma.id, g7A.id),
  post("r4", ma.id, g7C.id),
  post("r5", sva.id, sva7.id),
  // Matematik in halves for 7A:1 only; 7A's own Matematik post does not bring the other half along.
  post("r6", ma.id, half1.id),
  post("r7", ma.id, ma7.id),
];

const { sections } = splitGroupsByKind([g7A, g7B, g7C, sva7, half1, half2, ma7], []);

const names = (view: ReturnType<typeof subjectView>) =>
  view.sections.map((section) => `${section.kind} ${section.groups.length}/${section.total}: ${section.groups.map((g) => g.name).join(" ")}`);

describe("subjectView", () => {
  it("with no subject is the page as it was: every column, every group, every post", () => {
    const view = subjectView(null, false, columns, sections, posts);
    expect(view.subject).toBeNull();
    expect(view.columns).toBe(columns);
    expect(view.posts).toBe(posts);
    expect(names(view)).toEqual(["CLASS 3/3: 7A 7B 7C", "TEACHING_GROUP 4/4: SvA7 7A:1 7A:2 Ma7"]);
  });

  it("with a subject draws its column alone and counts its posts alone", () => {
    const view = subjectView(ma.id, false, columns, sections, posts);
    expect(view.subject).toBe(ma);
    expect(view.columns).toEqual([ma]);
    expect(view.posts.map((row) => row.id)).toEqual(["r3", "r4", "r6", "r7"]);
  });

  it("shows the groups with a post in the subject, and says how many of the year's that is", () => {
    expect(names(subjectView(sv.id, false, columns, sections, posts))).toEqual([
      "CLASS 2/3: 7A 7B",
      // SvA7 has no Svenska post: it is there because it replaces Svenska.
      "TEACHING_GROUP 1/4: SvA7",
    ]);
  });

  it("shows a replacing group under the subject it replaces, and under its own subject by its post", () => {
    const view = subjectView(sva.id, false, columns, sections, posts);
    // No class reads SvA, so the section is gone rather than "Klasser (0 av 3)".
    expect(names(view)).toEqual(["TEACHING_GROUP 1/4: SvA7"]);
    // Under Svenska it is a row and counts nothing: its post is SvA's.
    expect(subjectView(sv.id, false, columns, sections, posts).posts.map((row) => row.studentGroupId)).not.toContain(sva7.id);
  });

  it("holds a half to the teaching groups' rule: its own post, not its class's", () => {
    expect(names(subjectView(ma.id, false, columns, sections, posts))).toEqual([
      "CLASS 2/3: 7A 7C",
      "TEACHING_GROUP 2/4: 7A:1 Ma7",
    ]);
  });

  it("shows a half that replaces the subject, as any teaching group would", () => {
    const replacingHalf = { ...half2, replacesSubjectId: ma.id };
    const split = splitGroupsByKind([g7A, half1, replacingHalf], []);
    const view = subjectView(ma.id, false, columns, split.sections, [post("r3", ma.id, g7A.id)]);
    expect(names(view)).toEqual(["CLASS 1/1: 7A", "TEACHING_GROUP 1/2: 7A:2"]);
  });

  it("with Visa grupper utan post shows the year's other groups, and still counts only the subject's posts", () => {
    const view = subjectView(sv.id, true, columns, sections, posts);
    expect(names(view)).toEqual(["CLASS 3/3: 7A 7B 7C", "TEACHING_GROUP 4/4: SvA7 7A:1 7A:2 Ma7"]);
    expect(view.posts.map((row) => row.id)).toEqual(["r1", "r2"]);
    expect(view.columns).toEqual([sv]);
  });

  it("reads an id that is none of the school's subjects as Alla ämnen", () => {
    const view = subjectView("s-gone", false, columns, sections, posts);
    expect(view.subject).toBeNull();
    expect(view.columns).toBe(columns);
    expect(view.posts).toBe(posts);
    expect(names(view)).toEqual(["CLASS 3/3: 7A 7B 7C", "TEACHING_GROUP 4/4: SvA7 7A:1 7A:2 Ma7"]);
    // Nor does the checkbox mean anything without a subject.
    expect(names(subjectView("s-gone", true, columns, sections, posts))).toEqual(names(view));
  });

  it("drops every section when no group is in the subject, so the page can say so", () => {
    const empty = { id: "s-bl", name: "Bild" };
    const view = subjectView(empty.id, false, [...columns, empty], sections, posts);
    expect(view.subject).toBe(empty);
    expect(view.sections).toEqual([]);
    expect(view.posts).toEqual([]);
  });
});
