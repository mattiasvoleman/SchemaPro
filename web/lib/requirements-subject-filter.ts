import type { GroupSection } from "@/lib/group-sections";
import type { TeachingRequirement } from "@/lib/types";

/**
 * Timplansposter filtered to one subject: which columns and rows the matrix
 * draws, and which posts its sums count.
 *
 * The filter is a VIEW. The page's CSV export reads the year's posts and not
 * this, so a file always holds every subject (the user's decision, 2026-11-09).
 */

/** A section as the matrix draws it: the groups shown, and how many the year has ("4 av 12"). */
export interface ShownSection extends GroupSection {
  total: number;
}

export interface SubjectView<S> {
  /** The chosen subject; null is Alla ämnen, and so is an id that is none of the school's subjects. */
  subject: S | null;
  columns: S[];
  /** Without the sections that show no group, as splitGroupsByKind drops an empty one. */
  sections: ShownSection[];
  /** The posts every sum on the page counts: the subject's own, or all of them. */
  posts: TeachingRequirement[];
}

/**
 * With a subject, its column alone, and the groups in it: those with a post
 * in it, and the teaching groups that replace it (SvA7 for Svenska, whose
 * members leave Svenska for it). A half is a teaching group and is held to
 * the same rule; its class's post does not bring it along. `withoutPosts`
 * ("Visa grupper utan post") shows the year's other groups too, so a post can
 * be added for a new class. The sums count the subject's posts only.
 */
export function subjectView<S extends { id: string }>(
  subjectId: string | null,
  withoutPosts: boolean,
  columns: S[],
  sections: GroupSection[],
  posts: TeachingRequirement[],
): SubjectView<S> {
  const subject = columns.find((column) => column.id === subjectId) ?? null;
  if (!subject) {
    return { subject, columns, posts, sections: sections.map((section) => ({ ...section, total: section.groups.length })) };
  }
  const own = posts.filter((post) => post.subjectId === subject.id);
  const posted = new Set(own.map((post) => post.studentGroupId));
  return {
    subject,
    columns: [subject],
    posts: own,
    sections: sections
      .map((section) => ({
        kind: section.kind,
        total: section.groups.length,
        groups: withoutPosts
          ? section.groups
          : section.groups.filter((group) => posted.has(group.id) || group.replacesSubjectId === subject.id),
      }))
      .filter((section) => section.groups.length > 0),
  };
}
