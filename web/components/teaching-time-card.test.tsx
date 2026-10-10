import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TeachingTimeCard, type TeachingTimeCardResponse, type TeachingTimeStage } from "./teaching-time-card";

/**
 * The pupil's and the guardian's "Undervisningstid": what it reads, and what
 * it says in plain words. The statement is the gateway's (GET
 * /timplan-stages/card, under the caller's RLS); under test is that the card
 * asks for the pupil it is given, says "Sedan …" rather than "Hittills" for a
 * stage SchemaPro has only seen part of, names the grades left out, shows the
 * timplan's hours only where the distribution is published, carries no
 * verdict, and renders nothing at all when there is no statement.
 */

const state = vi.hoisted(() => ({ asked: [] as string[], response: null as unknown }));

vi.mock("@/lib/api", () => ({
  api: {
    get: async (path: string) => {
      state.asked.push(path);
      return state.response;
    },
  },
}));
vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) =>
    values ? `${namespace}.${key}(${Object.values(values).join("|")})` : `${namespace}.${key}`,
}));

const PUPIL = "00000000-0000-4000-8000-000000000221";

const mellan = (over: Partial<TeachingTimeStage> = {}): TeachingTimeStage => ({
  stage: "MELLAN",
  versionCode: "SFS2023:945/B1",
  distributionPublished: true,
  gradesFrom: 4,
  gradesTo: 6,
  complete: true,
  recordedFrom: "2024-08-17",
  plannedGrades: [],
  unrecordedGrades: [],
  unplannedGrades: [],
  backfilled: false,
  historyFrom: null,
  lines: [
    {
      subjectCode: "MA",
      subjectName: "Matematik",
      nationalHours: 410,
      plannedHours: 409,
      outcomeHours: 300.5,
      projectedHours: 409,
      status: "BELOW",
      projectedStatus: "BELOW",
    },
  ],
  ...over,
});

const statement = (stages: TeachingTimeStage[]): TeachingTimeCardResponse => ({
  statement: {
    studentId: PUPIL,
    academicYearId: "y-1",
    asOfDate: "2026-10-10",
    stages,
  },
});

function show(childName?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TeachingTimeCard studentId={PUPIL} childName={childName} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.asked = [];
  state.response = null;
});

describe("TeachingTimeCard", () => {
  it("asks for the pupil it is given, and shows hours so far, planned and the timplan's, without a verdict", async () => {
    state.response = statement([mellan()]);
    show();
    const card = await screen.findByRole("region", { name: "teachingTime.title" });
    expect(state.asked).toEqual([`/api/v1/timplan-stages/card?studentId=${PUPIL}`]);
    expect(card).toHaveTextContent("teachingTime.updated(10 oktober 2026)");
    expect(within(card).getByRole("heading", { name: "teachingTime.stage(MELLAN|4|6)" })).toBeInTheDocument();
    expect(within(card).getByRole("columnheader", { name: "teachingTime.soFar" })).toBeInTheDocument();
    const row = within(card).getByRole("row", { name: /Matematik/ });
    expect(row).toHaveTextContent("300,5 h");
    expect(row).toHaveTextContent("409 h");
    expect(row).toHaveTextContent("410 h");
    // The statement says BELOW; the family's card does not.
    expect(card).not.toHaveTextContent(/BELOW|under/);
    expect(card).toHaveTextContent("teachingTime.footer(SFS 2023:945 B1)");
  });

  it("says since when for a stage SchemaPro has seen only part of, and names the grades left out", async () => {
    state.response = statement([mellan({ complete: false, recordedFrom: "2026-10-01", unrecordedGrades: [4, 5] })]);
    show("Alva");
    const card = await screen.findByRole("region", { name: "teachingTime.titleChild(Alva)" });
    expect(within(card).getByRole("columnheader", { name: "teachingTime.since(1 oktober 2026)" })).toBeInTheDocument();
    expect(within(card).queryByRole("columnheader", { name: "teachingTime.soFar" })).not.toBeInTheDocument();
    expect(card).toHaveTextContent("teachingTime.unrecorded(4 och 5)");
  });

  it("never says 'Hittills' for a stage whose class was backfilled, and says until when the class is assumed", async () => {
    // Recorded from the year's start, but the class before 10 October is the
    // one the pupil had when the history began — not a recorded fact.
    state.response = statement([mellan({ complete: true, backfilled: true, recordedFrom: "2026-08-17", historyFrom: "2026-10-10" })]);
    show();
    const card = await screen.findByRole("region", { name: "teachingTime.title" });
    expect(within(card).queryByRole("columnheader", { name: "teachingTime.soFar" })).not.toBeInTheDocument();
    expect(within(card).getByRole("columnheader", { name: "teachingTime.since(17 augusti 2026)" })).toBeInTheDocument();
    expect(card).toHaveTextContent("teachingTime.backfilled(10 oktober 2026)");
  });

  it("labels a partial stage's planned figure with the grades it covers, and sets no whole-stage timplan beside it", async () => {
    // Åk 4 is before SchemaPro: planned covers åk 5 and 6, the timplan's 410 h all three.
    state.response = statement([mellan({ complete: false, recordedFrom: "2025-08-18", unrecordedGrades: [4], plannedGrades: [6] })]);
    show();
    const card = await screen.findByRole("region", { name: "teachingTime.title" });
    expect(within(card).getByRole("columnheader", { name: "teachingTime.plannedGrades(5 och 6)" })).toBeInTheDocument();
    expect(within(card).queryByRole("columnheader", { name: "teachingTime.planned" })).not.toBeInTheDocument();
    expect(within(card).queryByRole("columnheader", { name: "teachingTime.timplan" })).not.toBeInTheDocument();
    expect(within(card).getByRole("row", { name: /Matematik/ })).not.toHaveTextContent("410 h");
    expect(card).toHaveTextContent("teachingTime.timplanWhenComplete");
  });

  it("tells grades no plan carries yet apart from grades with no history", async () => {
    state.response = statement([mellan({ complete: false, recordedFrom: "2025-08-18", unrecordedGrades: [4], unplannedGrades: [6] })]);
    show();
    const card = await screen.findByRole("region", { name: "teachingTime.title" });
    expect(card).toHaveTextContent("teachingTime.unrecorded(4)");
    expect(card).toHaveTextContent("teachingTime.unplanned(6)");
    expect(card).not.toHaveTextContent("teachingTime.unrecorded(4 och 6)");
  });

  it("shows no timplan column where the national distribution is not published, and says so", async () => {
    state.response = statement([
      mellan({
        stage: "LAG",
        versionCode: "SFS2025:729",
        distributionPublished: false,
        gradesFrom: 1,
        gradesTo: 4,
        lines: [{ ...mellan().lines[0]!, nationalHours: null, status: "NO_NATIONAL", projectedStatus: "NO_NATIONAL" }],
      }),
    ]);
    show();
    const card = await screen.findByRole("region", { name: "teachingTime.title" });
    expect(within(card).queryByRole("columnheader", { name: "teachingTime.timplan" })).not.toBeInTheDocument();
    expect(card).toHaveTextContent("teachingTime.unpublished");
  });

  it("renders nothing when the school has not published, or the statement is for another year", async () => {
    state.response = { statement: null } satisfies TeachingTimeCardResponse;
    const { container } = show();
    await vi.waitFor(() => expect(state.asked).toHaveLength(1));
    expect(container).toBeEmptyDOMElement();
  });
});
