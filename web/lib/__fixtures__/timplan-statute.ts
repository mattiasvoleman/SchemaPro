import fixture from "../../../src/common/__fixtures__/timplan-coverage-cases.json";
import type { NationalTimplans, NationalTimplanVersion, SchoolForm } from "@/lib/types";
import type { CoverageNationalSubject, CoverageVersion } from "@/lib/timplan-coverage";

/**
 * The seeded statute as GET /national-timplans hands it out, for the timplan
 * page's component tests.
 *
 * Built from the gateway's coverage fixture, which read it out of P0's
 * migration, so a test about "matematik lågstadiet, 420 h" is about the row
 * the database holds — not a number retyped here. The fixture carries the
 * columns the check needs; the four the endpoint adds (id, sfs, title,
 * appliesBy) are derived from the code — appliesBy as migration
 * 20261010130000 sets it: the tioårig grundskola's rows (SFS 2025:729) apply
 * by cohort, every older lydelse by stage — and a national subject's name is
 * its code, which is what the page falls back to when a name is missing
 * anyway.
 */

const { statute } = fixture as unknown as {
  statute: { versions: CoverageVersion[]; nationalSubjects: CoverageNationalSubject[] };
};

const GROUPS = new Set(
  statute.nationalSubjects.map((subject) => subject.parentCode).filter((code) => code !== null),
);

const NAMES: Record<string, string> = {
  MA: "Matematik",
  BL: "Bild",
  NO: "Naturorienterande ämnen",
  BI: "Biologi",
  KE: "Kemi",
  SV_SVA: "Svenska eller svenska som andraspråk",
};

export const versionId = (code: string) => `v-${code.replace(/[^A-Za-z0-9]/g, "")}`;

export const NATIONAL: NationalTimplans = {
  versions: statute.versions.map(
    (version): NationalTimplanVersion => ({
      id: versionId(version.code),
      code: version.code,
      sfs: version.code.replace(/^SFS/, "").split("/")[0]!,
      title: version.code,
      schoolForm: version.schoolForm as SchoolForm,
      totalHours: version.totalHours,
      skolansValHours: version.skolansValHours,
      reductionCapPercent: version.reductionCapPercent,
      appliesFromCohortTerm: version.appliesFromCohortTerm,
      appliesBy: version.code.startsWith("SFS2025:729") ? "COHORTS_STARTING" : "STAGES_NOT_COMPLETED",
      supersededByCode: null,
      entries: version.entries,
    }),
  ),
  subjects: statute.nationalSubjects.map((subject) => ({
    code: subject.code,
    name: NAMES[subject.code] ?? subject.code,
    parentCode: subject.parentCode,
    isGroup: GROUPS.has(subject.code),
  })),
};

export const B1 = NATIONAL.versions.find((version) => version.code === "SFS2023:945/B1")!;
export const LAW_2028 = NATIONAL.versions.find((version) => version.code === "SFS2025:729")!;
export const SAMESKOLA = NATIONAL.versions.find((version) => version.code === "SFS2023:945/B4")!;
export const SPECIALSKOLA = NATIONAL.versions.find((version) => version.code === "SFS2023:945/B3")!;
