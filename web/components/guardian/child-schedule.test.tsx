import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FamilySchedule } from "@/lib/family-schedule";
import { ChildSchedule } from "./child-schedule";

/**
 * The guardian's "Schema" card: which child's week it asks for, what it says
 * about a lesson, and where it stops. Which rows exist for a guardian is the
 * gateway's and RLS's (test/family-schedule.e2e-spec.ts, rls-policies.sql
 * section 29); under test here is that the card asks only for the children it
 * is given, never shows one child's week under another's name, draws the
 * school's times as they come, and does not step past the weeks the gateway
 * answers.
 */

const state = vi.hoisted(() => ({
  asked: [] as string[],
  answer: (_path: string): Promise<unknown> => Promise.resolve(null),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: {
    get: (path: string) => {
      state.asked.push(path);
      return state.answer(path);
    },
  },
}));
vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) =>
    values ? `${namespace}.${key}(${Object.values(values).join("|")})` : `${namespace}.${key}`,
}));

const ALVA = "00000000-0000-4000-8000-0000000000a1";
const BO = "00000000-0000-4000-8000-0000000000b0";

const week = (studentId: string, firstName: string, from = "2026-10-19"): FamilySchedule => ({
  student: { id: studentId, firstName },
  week: { from, to: "", isoWeek: from === "2026-10-19" ? "2026-W43" : "2026-W42" },
  today: "2026-10-20",
  bounds: { earliest: "2026-10-12", latest: "2027-06-07" },
  timezone: "Europe/Stockholm",
  lessons: [
    {
      id: `${firstName}-ma`,
      date: "2026-10-20",
      start: "08:05",
      end: "08:50",
      startsAt: "2026-10-20T06:05:00.000Z",
      endsAt: "2026-10-20T06:50:00.000Z",
      subjectId: "ma",
      subject: `Matematik ${firstName}`,
      subjectColor: "#ff0000",
      room: "B204",
      teachers: ["ANLI"],
      status: "SCHEDULED",
      substitute: false,
    },
    {
      id: `${firstName}-sv`,
      date: "2026-10-20",
      start: "09:00",
      end: "09:45",
      startsAt: "2026-10-20T07:00:00.000Z",
      endsAt: "2026-10-20T07:45:00.000Z",
      subjectId: "sv",
      subject: "Svenska",
      subjectColor: null,
      room: null,
      teachers: [],
      status: "SCHEDULED",
      substitute: true,
    },
    {
      id: `${firstName}-en`,
      date: "2026-10-21",
      start: "10:00",
      end: "10:45",
      startsAt: "2026-10-21T08:00:00.000Z",
      endsAt: "2026-10-21T08:45:00.000Z",
      subjectId: "en",
      subject: "Engelska",
      subjectColor: null,
      room: "A1",
      teachers: [],
      status: "CANCELLED",
      substitute: false,
    },
  ],
  lunches: [{ id: "m", date: "2026-10-20", start: "11:20", end: "11:50" }],
  rasts: [],
});

const param = (path: string, name: string) => new URLSearchParams(path.split("?")[1]).get(name);

function renderCard(childList = [{ id: ALVA, firstName: "Alva" }, { id: BO, firstName: "Bo" }]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ChildSchedule childList={childList} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.asked = [];
  state.answer = (path) => {
    const id = param(path, "studentId");
    const from = param(path, "week") ?? "2026-10-19";
    return Promise.resolve(id === BO ? week(BO, "Bo", from) : week(ALVA, "Alva", from));
  };
});

describe("the guardian's Schema card", () => {
  it("asks for the first child's week at the school's own today, and shows today", async () => {
    renderCard();
    expect(await screen.findByText("Matematik Alva")).toBeInTheDocument();
    expect(state.asked[0]).toBe(`/api/v1/family/schedule?studentId=${ALVA}`);
    // Today only: Wednesday's lesson is not on screen.
    expect(screen.queryByText("Engelska")).not.toBeInTheDocument();
    expect(screen.getByText("guardian.schedule.title(Alva)")).toBeInTheDocument();
  });

  it("draws the school's times as given, the room and the school's label, and the lunch", async () => {
    renderCard();
    const row = (await screen.findByText("Matematik Alva")).closest("li")!;
    expect(within(row).getByText("08:05–08:50")).toBeInTheDocument();
    expect(within(row).getByText("B204 · ANLI")).toBeInTheDocument();
    expect(screen.getByText("guardian.schedule.lunch")).toBeInTheDocument();
  });

  it("says Vikarie for a substituted lesson and names nobody", async () => {
    renderCard();
    const row = (await screen.findByText("Svenska")).closest("li")!;
    expect(within(row).getByText("guardian.schedule.substitute")).toBeInTheDocument();
    expect(row.textContent).not.toContain("ANLI");
  });

  it("shows the whole week with the cancelled lesson marked", async () => {
    const user = userEvent.setup();
    renderCard();
    await screen.findByText("Matematik Alva");
    await user.click(screen.getByRole("button", { name: "guardian.schedule.week" }));
    const row = screen.getByText("Engelska").closest("li")!;
    expect(within(row).getByText("guardian.schedule.cancelled")).toBeInTheDocument();
    expect(screen.getByText("guardian.schedule.weekLabel(43)")).toBeInTheDocument();
  });

  it("steps back a week, then stops at the first week the gateway answers", async () => {
    const user = userEvent.setup();
    renderCard();
    await screen.findByText("Matematik Alva");
    await user.click(screen.getByRole("button", { name: "guardian.schedule.week" }));
    await user.click(screen.getByRole("button", { name: "guardian.schedule.previousWeek" }));
    await waitFor(() => expect(screen.getByText("guardian.schedule.weekLabel(42)")).toBeInTheDocument());
    expect(param(state.asked.at(-1)!, "week")).toBe("2026-10-12");
    await waitFor(() => expect(screen.getByRole("button", { name: "guardian.schedule.previousWeek" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "guardian.schedule.nextWeek" })).toBeEnabled();
  });

  it("switches child, asks for that child, and never shows one child's week under the other's name", async () => {
    const user = userEvent.setup();
    let release: () => void = () => undefined;
    renderCard();
    await screen.findByText("Matematik Alva");
    state.answer = (path) =>
      new Promise((resolve) => {
        release = () => resolve(week(BO, "Bo", param(path, "week") ?? "2026-10-19"));
      });
    await user.click(screen.getByRole("button", { name: "Bo" }));
    expect(param(state.asked.at(-1)!, "studentId")).toBe(BO);
    expect(screen.getByText("guardian.schedule.title(Bo)")).toBeInTheDocument();
    expect(screen.queryByText("Matematik Alva")).not.toBeInTheDocument();
    release();
    expect(await screen.findByText("Matematik Bo")).toBeInTheDocument();
  });

  it("offers no child switch for one child", async () => {
    renderCard([{ id: ALVA, firstName: "Alva" }]);
    await screen.findByText("Matematik Alva");
    expect(screen.queryByRole("group", { name: "guardian.schedule.childLabel" })).not.toBeInTheDocument();
  });

  it("says the week is out of range in words, not as an error code", async () => {
    const { ApiError } = await import("@/lib/api");
    state.answer = () => Promise.reject(new ApiError(400, "Veckan ligger utanför det som går att visa.", "WEEK_OUT_OF_RANGE"));
    renderCard();
    expect(await screen.findByRole("alert")).toHaveTextContent("guardian.schedule.weekOutOfRange");
  });

  it("says a failed read plainly", async () => {
    state.answer = () => Promise.reject(new Error("boom"));
    renderCard();
    expect(await screen.findByRole("alert")).toHaveTextContent("guardian.schedule.error");
  });
});
