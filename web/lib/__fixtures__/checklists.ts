import type {
  ConsentAskView,
  ConsentCounts,
  ConsentDetail,
  ConsentEntryView,
  ConsentListItem,
  ConsentRow,
  GroupChoice,
  Instructor,
  ProofRoster,
  ProofRow,
  ProofView,
  PupilCard,
  TemplateView,
} from "@/lib/checklists";

/*
 * Checklistor's answers as the tests need them: a few builders over the
 * gateway's shapes (src/checklists/checklists-views.ts), each filling in what a
 * test does not care about.
 */

export const template = (over: Partial<TemplateView> = {}): TemplateView => ({
  id: "t-1",
  subjectId: "s-slojd",
  subjectName: "Slöjd",
  title: "Maskinerna",
  description: null,
  active: true,
  ...over,
});

export const TEMPLATES: TemplateView[] = [
  template(),
  template({ id: "t-2", subjectId: "s-no", subjectName: "Naturorienterande ämnen", title: "Laborationssäkerhet", description: "Skyddsglasögon och dragskåp." }),
  template({ id: "t-3", subjectId: null, subjectName: null, title: "Brandövning" }),
  template({ id: "t-4", subjectId: "s-slojd", subjectName: "Slöjd", title: "Svarven", active: false }),
];

export const group = (over: Partial<GroupChoice> = {}): GroupChoice => ({
  id: "g-7a",
  name: "7A",
  kind: "CLASS",
  subjects: [],
  canTick: true,
  canMakeList: true,
  ...over,
});

export const GROUPS: GroupChoice[] = [
  group({ subjects: ["Slöjd"] }),
  group({ id: "g-sl1", name: "Slöjd 7", kind: "TEACHING_GROUP", subjects: ["Slöjd"], canMakeList: false }),
  group({ id: "g-8b", name: "8B", subjects: [], canTick: false }),
];

export const INSTRUCTORS: Instructor[] = [
  { id: "u-anna", name: "Anna Svensson" },
  { id: "u-bo", name: "Bo Ek" },
];

export const proof = (over: Partial<ProofView> = {}): ProofView => ({
  id: "pr-1",
  instructedOn: "2026-10-03",
  instructorId: "u-anna",
  instructorName: "Anna Svensson",
  recordedByName: "Anna Svensson",
  recordedAt: "2026-10-03T08:30:00.000Z",
  note: null,
  canVoid: true,
  ...over,
});

export const row = (id: string, name: string, over: Partial<ProofRow> = {}): ProofRow => ({
  studentId: id,
  name,
  className: "7A",
  canTick: true,
  proofs: [],
  ...over,
});

export const ROWS: ProofRow[] = [
  row("p-ada", "Ada Berg", { proofs: [proof(), proof({ id: "pr-0", instructedOn: "2026-05-02" })] }),
  row("p-bo", "Bo Ek"),
  row("p-cia", "Cia Lund", { className: "8B", canTick: false }),
  row("p-dan", "Dan Dal", { proofs: [proof({ id: "pr-2", instructedOn: "2026-10-02", instructorId: null, instructorName: null, recordedByName: "Cecilia Sand" })] }),
];

export const roster = (over: Partial<ProofRoster> = {}): ProofRoster => {
  const rows = over.rows ?? ROWS;
  return {
    template: template(),
    group: { id: "g-7a", name: "7A", kind: "CLASS" },
    rows,
    done: rows.filter((one) => one.proofs.length > 0).length,
    pupils: rows.length,
    heldOut: 0,
    ...over,
  };
};

export const entry = (over: Partial<ConsentEntryView> = {}): ConsentEntryView => ({
  id: "e-1",
  kind: "GRANTED",
  source: "REGISTERED",
  givenOn: "2026-10-03",
  givenBy: "Adas mamma",
  note: null,
  recordedByName: "Anna Svensson",
  recordedAt: "2026-10-05T09:12:00.000Z",
  ...over,
});

export const ask = (over: Partial<ConsentAskView> = {}): ConsentAskView => ({
  askedAt: "2026-10-06T07:00:00.000Z",
  guardiansAsked: 2,
  guardiansWaiting: 1,
  ...over,
});

export const consentRow = (id: string, name: string, over: Partial<ConsentRow> = {}): ConsentRow => ({
  studentId: id,
  name,
  className: "7A",
  inClass: true,
  state: "MISSING",
  entry: null,
  history: [],
  ask: null,
  canWrite: true,
  ...over,
});

const grantedAda = entry();
const withdrawnBo = entry({ id: "e-3", kind: "WITHDRAWN", givenOn: "2026-10-04", givenBy: "Bos pappa", recordedAt: "2026-10-05T10:00:00.000Z" });
const grantedBo = entry({ id: "e-2", givenOn: "2026-09-20", givenBy: "Bos pappa", recordedAt: "2026-09-21T08:00:00.000Z", note: "På blanketten" });

export const CONSENT_ROWS: ConsentRow[] = [
  consentRow("p-ada", "Ada Berg", { state: "GRANTED", entry: grantedAda, history: [grantedAda] }),
  consentRow("p-bo", "Bo Ek", { state: "WITHDRAWN", entry: withdrawnBo, history: [withdrawnBo, grantedBo] }),
  consentRow("p-cia", "Cia Lund", { state: "ASKED", ask: ask(), canWrite: true }),
  consentRow("p-dan", "Dan Dal", {
    state: "DECLINED",
    entry: entry({ id: "e-4", kind: "DECLINED", givenOn: "2026-10-01", givenBy: null, source: "REGISTERED" }),
    history: [entry({ id: "e-4", kind: "DECLINED", givenOn: "2026-10-01", givenBy: null })],
  }),
  consentRow("p-eva", "Eva Nord", {
    state: "GRANTED",
    entry: entry({ id: "e-5", source: "KVITTENS", givenOn: "2026-10-06", givenBy: null, recordedByName: null }),
    history: [entry({ id: "e-5", source: "KVITTENS", givenOn: "2026-10-06", givenBy: null, recordedByName: null })],
  }),
  consentRow("p-fia", "Fia Ström", { state: "MISSING", inClass: false, className: "7B" }),
  consentRow("p-gun", "Gun Ö", { state: "MISSING" }),
];

export const counts = (over: Partial<ConsentCounts> = {}): ConsentCounts => ({
  pupils: 7,
  granted: 2,
  declined: 1,
  withdrawn: 1,
  asked: 1,
  missing: 2,
  ...over,
});

export const listItem = (over: Partial<ConsentListItem> = {}): ConsentListItem => ({
  id: "l-1",
  title: "Fotografering HT 2026",
  classId: "g-7a",
  className: "7A",
  createdAt: "2026-09-15T08:00:00.000Z",
  createdByName: "Anna Svensson",
  closedAt: null,
  counts: counts(),
  ...over,
});

export const detail = (over: Partial<ConsentDetail> = {}): ConsentDetail => ({
  list: { ...listItem(), body: "Skolan får fotografera eleven vid skolfotograferingen.\nBilderna används i skolans eget register." },
  kvittens: true,
  canClose: true,
  rows: CONSENT_ROWS,
  heldOut: 0,
  ...over,
});

export const card = (over: Partial<PupilCard> = {}): PupilCard => ({
  student: { id: "p-ada", name: "Ada Berg", className: "7A" },
  proofs: [
    {
      ...proof(),
      templateId: "t-1",
      templateTitle: "Maskinerna",
      subjectName: "Slöjd",
      voidedAt: null,
      voidedByName: null,
      voidReason: null,
    },
    {
      ...proof({ id: "pr-9", instructedOn: "2026-09-01", instructorName: null, instructorId: null, recordedByName: "Bo Ek", note: "Bara svarven" }),
      templateId: "t-2",
      templateTitle: "Laborationssäkerhet",
      subjectName: null,
      voidedAt: "2026-09-02T10:05:00.000Z",
      voidedByName: "Bo Ek",
      voidReason: "Fel elev",
    },
  ],
  consents: [
    { listId: "l-1", title: "Fotografering HT 2026", className: "7A", closed: false, state: "GRANTED", entry: entry() },
    { listId: "l-0", title: "Utflykt VT 2026", className: "6A", closed: true, state: "ASKED", entry: entry({ kind: "WITHDRAWN", givenOn: "2026-03-01" }) },
    { listId: "l-9", title: "Publicering", className: "7A", closed: false, state: "MISSING", entry: null },
  ],
  ...over,
});
