import type {
  NationalSubject,
  NationalTimplanEntry,
  NationalTimplans,
  NationalTimplanVersion,
  TimplanStage,
} from "../../../lib/types";
import { KIND, uid } from "../sessions";

/**
 * GET /national-timplans, cut to what a grundskola 7–9 reads: bilaga 1 in
 * SFS 2023:945's lydelse and the enacted tioårig grundskola (SFS 2025:729),
 * whose fördelning is not published. The figures are the seed's
 * (prisma/migrations/20261006090000_den_nationella_timplanen_ar_referensdata),
 * which are the statute's, so every stage sums as bilaga 1 prints it:
 * 1 882 / 2 334 / 40 / 2 634 = 6 890. The other school forms' bilagor are left
 * out; nothing in the suites reads them.
 *
 * Ordered as the gateway orders them: versions and subjects by code, a
 * version's cells by code and then stage in the enum's order.
 */

// Subject codes are Skolverket's abbreviations, as the seed spells them.
const subject = (code: string, name: string, parentCode: string | null = null, isGroup = false): NationalSubject => ({
  code,
  name,
  parentCode,
  isGroup,
});

export const NATIONAL_SUBJECTS: NationalSubject[] = [
  subject("BI", "Biologi", "NO"),
  subject("BL", "Bild"),
  subject("EN", "Engelska"),
  subject("FY", "Fysik", "NO"),
  subject("GE", "Geografi", "SO"),
  subject("HI", "Historia", "SO"),
  subject("HKK", "Hem- och konsumentkunskap"),
  subject("IDH", "Idrott och hälsa"),
  subject("KE", "Kemi", "NO"),
  subject("M2", "Språkval"),
  subject("MA", "Matematik"),
  subject("MU", "Musik"),
  subject("NO", "Naturorienterande ämnen", null, true),
  subject("RE", "Religionskunskap", "SO"),
  subject("SH", "Samhällskunskap", "SO"),
  subject("SL", "Slöjd"),
  subject("SO", "Samhällsorienterande ämnen", null, true),
  subject("SV_SVA", "Svenska eller svenska som andraspråk"),
  subject("TK", "Teknik"),
];

type Cell = [code: string, stage: TimplanStage, hours: number, minimumHoursPerChild?: number | null, protectedFromReduction?: boolean];

const cells = (rows: Cell[]): NationalTimplanEntry[] =>
  rows.map(([subjectCode, stage, hours, minimumHoursPerChild = null, protectedFromReduction = false]) => ({
    subjectCode,
    stage,
    hours,
    minimumHoursPerChild,
    protectedFromReduction,
  }));

// "Får dock inte minskas": svenska/SvA, engelska, matematik and språkval.
const P = true;

export const BILAGA_1: NationalTimplanVersion = {
  id: uid(KIND.misc, 7901),
  code: "SFS2023:945/B1",
  sfs: "2023:945",
  title: "Skolförordningen (2011:185) bilaga 1, timplan för grundskolan, i lydelse enligt SFS 2023:945",
  schoolForm: "GRUNDSKOLA",
  totalHours: 6890,
  skolansValHours: 600,
  reductionCapPercent: 20,
  appliesFromCohortTerm: "HT2024",
  appliesBy: "STAGES_NOT_COMPLETED",
  supersededByCode: "SFS2025:729",
  entries: cells([
    ["BI", "MELLAN", 60], ["BI", "HOG", 80],
    ["BL", "LAG", 60], ["BL", "MELLAN", 80], ["BL", "HOG", 100],
    ["EN", "LAG", 60, null, P], ["EN", "MELLAN", 220, null, P], ["EN", "HOG", 200, null, P],
    ["FY", "MELLAN", 60], ["FY", "HOG", 80],
    ["GE", "MELLAN", 75], ["GE", "HOG", 80],
    ["HI", "MELLAN", 90], ["HI", "HOG", 100],
    ["HKK", "HOG", 90], ["HKK", "LAG_MELLAN", 40],
    ["IDH", "LAG", 140], ["IDH", "MELLAN", 180], ["IDH", "HOG", 280],
    ["KE", "MELLAN", 60], ["KE", "HOG", 80],
    ["M2", "MELLAN", 48, null, P], ["M2", "HOG", 272, null, P],
    ["MA", "LAG", 420, null, P], ["MA", "MELLAN", 410, null, P], ["MA", "HOG", 400, null, P],
    ["MU", "LAG", 80], ["MU", "MELLAN", 80], ["MU", "HOG", 80],
    ["NO", "LAG", 145], ["NO", "MELLAN", 216, 60], ["NO", "HOG", 289, 80],
    ["RE", "MELLAN", 75], ["RE", "HOG", 80],
    ["SH", "MELLAN", 75], ["SH", "HOG", 90],
    ["SL", "LAG", 50], ["SL", "MELLAN", 140], ["SL", "HOG", 140],
    ["SO", "LAG", 200], ["SO", "MELLAN", 375], ["SO", "HOG", 405],
    ["SV_SVA", "LAG", 680, null, P], ["SV_SVA", "MELLAN", 520, null, P], ["SV_SVA", "HOG", 290, null, P],
    ["TK", "LAG", 47], ["TK", "MELLAN", 65], ["TK", "HOG", 88],
  ]),
};

/** The tioårig grundskola: the total is law, the fördelning is not yet written. */
export const TIOARIG: NationalTimplanVersion = {
  id: uid(KIND.misc, 7902),
  code: "SFS2025:729",
  sfs: "2025:729",
  title:
    "Skollagen 10 kap. 5 § i lydelse enligt lag (2025:729) – tioårig grundskola; fördelningen (bilaga 1) är inte publicerad",
  schoolForm: "GRUNDSKOLA",
  totalHours: 7424,
  skolansValHours: null,
  reductionCapPercent: null,
  appliesFromCohortTerm: "HT2028",
  appliesBy: "COHORTS_STARTING",
  supersededByCode: null,
  entries: [],
};

export const NATIONAL_TIMPLANS: NationalTimplans = {
  versions: [BILAGA_1, TIOARIG],
  subjects: NATIONAL_SUBJECTS,
};

/** Code → its ämnesgrupp (BI → NO), or null for a top-level code. */
export const PARENT_OF = new Map(NATIONAL_SUBJECTS.map((entry) => [entry.code, entry.parentCode]));
export const NATIONAL_NAME = new Map(NATIONAL_SUBJECTS.map((entry) => [entry.code, entry.name]));
