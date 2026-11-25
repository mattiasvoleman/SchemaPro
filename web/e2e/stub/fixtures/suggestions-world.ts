import type { OptimizationJob } from "../../../lib/queries";
import type { SuggestionChange, Suggestions } from "../../../lib/suggestion-types";
import { KIND, uid } from "../sessions";
import { addDays, stockholmInstant, TODAY } from "./calendar";

/**
 * Åtgärdsförslag vid vägran (G6): the runs the stub holds for the card of what to change, and the analysis the gateway would make of them.
 * A scenario is named by the header the page sends (e2e/signed-in.ts askForScenario), and every test names its own (`suggestions-<case>:<unique>`),
 * since the suites run against one stub and the stub remembers the press per scenario name.
 *
 *   suggestions-refusal   the newest run was REFUSED (INFEASIBLE). The analysis finds four changes that work together: three are shown and
 *                         the fourth is counted, so the card says "ytterligare 1 ändring hör till samma lösning"
 *   suggestions-timeout   the newest run TIMED OUT, with the account of where the time went and what the probe measured. The analysis finds
 *                         ONE change and the engine has solved the week with it: a timeout gets a proof from a second run
 *   suggestions-nothing   the newest run TIMED OUT and the analysis finds nothing in its time: the card says that, and that it is no proof
 *   suggestions-saved     the newest run was REFUSED and ALREADY CARRIES its analysis (the column the gateway keeps it in): the run answers with it
 *                         from the first read, and nobody has pressed anything
 *
 * The first read of the run after a press is RUNNING (the analysis counting), and every read after it is the answer.
 */
export const SUGGESTIONS_SCENARIO = "suggestions";

export type SuggestionsCase = "refusal" | "timeout" | "nothing" | "saved";

export const suggestionsCaseOf = (scenario: string | null): SuggestionsCase | null => {
  if (scenario === null || !scenario.startsWith(SUGGESTIONS_SCENARIO)) return null;
  const rest = scenario.slice(SUGGESTIONS_SCENARIO.length).replace(/^-/, "");
  for (const name of ["refusal", "timeout", "nothing", "saved"] as const) if (rest.startsWith(name)) return name;
  return null;
};

/** The refused run holds the analyses of two cases; the timed-out run those of the other two. */
const jobOf = (asked: SuggestionsCase): OptimizationJob => (asked === "refusal" || asked === "saved" ? REFUSED : TIMED_OUT);

/** `days` days before the stub's today at `time`, Stockholm time: as misc-school.ts writes it. */
const ago = (days: number, time: string) => stockholmInstant(addDays(TODAY, -days), time);

const REFUSED_ID = uid(KIND.misc, 9101);
const TIMEOUT_ID = uid(KIND.misc, 9102);

const base = {
  lessonsGenerated: 0,
  conflictSummaryNames: [] as string[],
  notes: [] as never[],
  error: null,
  errorCode: null,
  errorParams: null,
  errorNames: [] as string[],
  suggestionsOffered: true,
  suggestions: null,
};

const REFUSED: OptimizationJob = {
  ...base,
  id: REFUSED_ID,
  status: "SUCCEEDED",
  solverStatus: "INFEASIBLE",
  conflictSummary: "No timetable satisfies every rule. Start with the causes below: together they make the week impossible.",
  conflictSummaryCode: "CONFLICT_CORE_SUMMARY",
  conflictSummaryParams: {},
  conflicts: [
    {
      category: "AVAILABILITY",
      code: "TEACHER_DAILY_CAP_CANNOT_BE_KEPT",
      message: "The cap of 300 minutes a day cannot be kept on Tuesday.",
      params: { minutes: 300, rule: "Anna Andersson", day: 2 },
      resourceNames: ["Anna Andersson"],
    },
  ],
  createdAt: ago(0, "08:00"),
  finishedAt: ago(0, "08:03"),
};

const TIMED_OUT: OptimizationJob = {
  ...base,
  id: TIMEOUT_ID,
  status: "SUCCEEDED",
  solverStatus: "TIMEOUT",
  conflictSummary: null,
  conflictSummaryCode: null,
  conflictSummaryParams: null,
  conflicts: [
    { category: "TIMEOUT_PROBE", code: "PROBE_SOLVED_WITHOUT_TEACHER_DAILY_CAP", message: "With the teachers' daily caps removed a timetable was found in 4 s.", params: { seconds: 4 }, resourceNames: [] },
  ],
  report: {
    totalSeconds: 209,
    budgetSeconds: 180,
    configuredBudgetSeconds: 180,
    callerWaitSeconds: null,
    stages: [
      { stage: "PRECHECKS", seconds: 0.4 },
      { stage: "BUILD", seconds: 8 },
      { stage: "SEARCH_CLEAN", seconds: 100 },
      { stage: "SEARCH_CLONE", seconds: 80 },
      { stage: "PROBE", seconds: 20 },
    ],
    search: { solutions: 0, phases: [{ phase: "CLEAN", seconds: 100, conflicts: 118344, branches: 920113 }, { phase: "CLONE", seconds: 80, conflicts: 99000, branches: 810000 }] },
    weekLoadCut: false,
  },
  createdAt: ago(0, "08:00"),
  finishedAt: ago(0, "08:03"),
};

const change = (over: Partial<SuggestionChange>): SuggestionChange => ({
  rule: "TEACHER_DAILY_CAP",
  proof: "SOLVED_TOGETHER",
  cost: 0,
  current: null,
  needed: null,
  weekdays: [],
  requirementIds: [],
  requirementNames: [],
  roomIds: [],
  roomNames: [],
  resourceIds: [],
  teacherNames: [],
  hidden: false,
  ...over,
});

const WORK_RULE = uid(KIND.misc, 9201);
const ROOM_RULE = uid(KIND.misc, 9202);
const POST = uid(KIND.misc, 9203);

const ANALYSIS_START = "2027-03-05T10:00:00.000Z";
const done = (over: Partial<Suggestions>): Suggestions => ({
  version: 1,
  state: "DONE",
  startedAt: ANALYSIS_START,
  finishedAt: "2027-03-05T10:01:34.000Z",
  verdict: "CHANGES",
  verified: true,
  total: 0,
  searchSeconds: 60,
  verifySeconds: 2.4,
  changes: [],
  failure: null,
  ...over,
});

const REFUSAL_ANSWER = done({
  total: 4,
  changes: [
    change({ rule: "SUBJECT_PER_DAY", cost: 20, current: 1, needed: 2, weekdays: [2], requirementIds: [POST], requirementNames: ["Idrott och hälsa för 8A"] }),
    change({ rule: "ROOM_LOCK", cost: 80, roomIds: [uid(KIND.misc, 9204)], roomNames: ["Gymnastiksalen"], requirementIds: [POST], requirementNames: ["Idrott och hälsa för 8A"], resourceIds: [ROOM_RULE] }),
    change({ rule: "TEACHER_DAILY_CAP", cost: 168, current: 300, needed: 360, weekdays: [2, 3], resourceIds: [WORK_RULE], teacherNames: ["Anna Andersson"] }),
  ],
});

const ANSWER: Record<SuggestionsCase, Suggestions> = {
  refusal: REFUSAL_ANSWER,
  saved: REFUSAL_ANSWER,
  timeout: done({
    total: 1,
    changes: [change({ rule: "TEACHER_DAILY_CAP", proof: "SOLVED", cost: 168, current: 300, needed: 330, weekdays: [3], resourceIds: [WORK_RULE], teacherNames: ["Anna Andersson"] })],
  }),
  nothing: done({ verdict: "NOT_FOUND", verified: false, searchSeconds: 60, verifySeconds: null }),
};

const RUNNING: Suggestions = {
  version: 1, state: "RUNNING", startedAt: ANALYSIS_START, finishedAt: null, verdict: null, verified: false, total: 0,
  searchSeconds: null, verifySeconds: null, changes: [], failure: null,
};

/** How far each scenario's analysis has come: 0 not asked, 1 asked and counting, 2 answered. */
const progress = new Map<string, number>();

/** The run a scenario holds, with what the analysis has come to. */
export function suggestionsJobFor(id: string, scenario: string | null): OptimizationJob | null {
  const asked = suggestionsCaseOf(scenario);
  if (asked === null) return null;
  const job = jobOf(asked);
  if (id !== job.id) return null;
  const step = progress.get(scenario ?? "") ?? 0;
  // A run that already holds its analysis has it from the first read, and a press on "Räkna om" starts a new one.
  if (step === 0) return asked === "saved" ? { ...job, suggestions: ANSWER.saved } : job;
  // The first read after the press is the analysis counting; every read after it is the answer.
  progress.set(scenario ?? "", step + 1);
  return { ...job, suggestions: step === 1 ? RUNNING : ANSWER[asked] };
}

/** The run a Generera started from the page gets, for a scenario that holds one. */
export const suggestionsStartedJob = (scenario: string | null): string | null => {
  const asked = suggestionsCaseOf(scenario);
  return asked === null ? null : jobOf(asked).id;
};

/** The press: the analysis is asked for and answers RUNNING. */
export function pressForSuggestions(id: string, scenario: string | null): Suggestions | null {
  const asked = suggestionsCaseOf(scenario);
  if (asked === null) return null;
  const job = jobOf(asked);
  if (id !== job.id) return null;
  progress.set(scenario ?? "", 1);
  return RUNNING;
}

/**
 * The runs a scenario lists first in the history: the one it holds. The row carries no analysis, saved or not: the page takes the run up from
 * the history and reads it by its id (useOptimizationJob), which is where the answer is.
 */
export const suggestionsHistoryFor = (scenario: string | null): OptimizationJob[] => {
  const asked = suggestionsCaseOf(scenario);
  return asked === null ? [] : [jobOf(asked)];
};
