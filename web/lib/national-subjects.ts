import { compareSwedish } from "@/lib/sorting";
import type { NationalSubject } from "@/lib/types";

/**
 * The national ämnen as a picker shows them: flat subjects first, then one
 * section per ämnesgrupp with the group itself at the top of its section.
 *
 * The statute has two kinds of cell. Most are one subject (Matematik, Bild).
 * Two are groups — NO with biologi, fysik, kemi and SO with geografi, historia,
 * religionskunskap, samhällskunskap — where the hours are stated for the group
 * and the children carry a per-child minimum. A school subject may map to
 * either level: högstadiet teaches Kemi, lågstadiet teaches NO as one subject,
 * and both are legal values of Subject.nationalCode. So the group code is an
 * OPTION inside its own section rather than only a heading, and a child is
 * never listed twice — once flat and once under its parent would let the
 * coverage module double-count it.
 *
 * Swedish order throughout, for the same reason useSubjects re-sorts: the
 * server's collation puts Ö in the middle of the alphabet.
 *
 * A child whose parent is missing from the list (a code the server knows and
 * this list does not) is shown flat rather than dropped: a subject the
 * administrator cannot pick is a mapping that silently never happens.
 */
export interface NationalSubjectSection {
  /** The ämnesgrupp this section is for, or null for the flat subjects. */
  group: NationalSubject | null;
  /** For a group section: the group itself first, then its children. */
  options: NationalSubject[];
}

export function sectionNationalSubjects(subjects: NationalSubject[]): NationalSubjectSection[] {
  const byName = (a: NationalSubject, b: NationalSubject) => compareSwedish(a.name, b.name);
  const groups = subjects.filter((subject) => subject.isGroup).sort(byName);
  const groupCodes = new Set(groups.map((group) => group.code));

  const flat = subjects
    .filter(
      (subject) =>
        !subject.isGroup && (subject.parentCode === null || !groupCodes.has(subject.parentCode)),
    )
    .sort(byName);

  const sections: NationalSubjectSection[] = [];
  if (flat.length > 0) sections.push({ group: null, options: flat });
  for (const group of groups) {
    const children = subjects
      .filter((subject) => !subject.isGroup && subject.parentCode === group.code)
      .sort(byName);
    sections.push({ group, options: [group, ...children] });
  }
  return sections;
}
