import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import sv from "@/messages/sv.json";
import { ApiError, api } from "@/lib/api";
import type { Absence } from "@/lib/cover-types";
import TeacherCoverPage, { mayWithdraw } from "./page";

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};
globalThis.ResizeObserver ??= class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
};

/**
 * /teacher/franvaro: the teacher's own cover duties and absences. What it
 * decides: only lessons the teacher COVERS are listed (not their own), the
 * self-report actions appear only when the school allows it, the reason is
 * the teacher's own to read, and "Min tillgänglighet" is a pool member's.
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() } };
});
const get = api.get as unknown as Mock;
const post = api.post as unknown as Mock;
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const pool = vi.hoisted(() => ({ member: false }));
vi.mock("@/utils/supabase/client", () => ({
  createClient: () => ({
    from: () => {
      const builder = {
        select: () => builder,
        eq: () => builder,
        limit: async () => ({ data: pool.member ? [{ userId: "t-me" }] : [], error: null }),
      };
      return builder;
    },
  }),
}));
vi.mock("@/components/profile-context", () => ({
  useProfile: () => ({ profile: { id: "t-me", role: "TEACHER" }, school: { timezone: "Europe/Stockholm" } }),
}));

const SOON = new Date(Date.now() + 2 * 86_400_000);
const day = SOON.toISOString().slice(0, 10);
vi.mock("@/lib/queries", () => ({
  useTeacherLessons: () => ({
    isLoading: false,
    data: [
      {
        id: "l-cover",
        subjectId: "s-ma",
        studentGroupId: "g-7a",
        roomId: "r-12",
        date: day,
        startsAt: `${day}T07:00:00.000Z`,
        endsAt: `${day}T08:00:00.000Z`,
        status: "SCHEDULED",
        note: null,
        assignmentRole: "SUBSTITUTE",
      },
      {
        id: "l-own",
        subjectId: "s-en",
        studentGroupId: "g-8b",
        roomId: null,
        date: day,
        startsAt: `${day}T09:00:00.000Z`,
        endsAt: `${day}T10:00:00.000Z`,
        status: "SCHEDULED",
        note: null,
        assignmentRole: "LEAD",
      },
    ],
  }),
  useSubjects: () => ({ data: [{ id: "s-ma", name: "Matematik" }, { id: "s-en", name: "Engelska" }] }),
  useGroups: () => ({ data: [{ id: "g-7a", name: "7A" }, { id: "g-8b", name: "8B" }] }),
  useRooms: () => ({ data: [{ id: "r-12", name: "Sal 12" }] }),
}));

const MINE: Absence = {
  id: "a-me",
  userId: "t-me",
  startsAt: new Date(Date.now() - 3_600_000).toISOString(),
  endsAt: new Date(Date.now() + 86_400_000).toISOString(),
  wholeDays: false,
  reasonId: "r-sick",
  status: "ACTIVE",
  phase: "ONGOING",
  selfReported: true,
  createdAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
  counts: { open: 1, covered: 2, cancelled: 0, handled: 0, passedOpen: 0 },
};

function answer(selfReport: boolean) {
  get.mockImplementation(async (path: string) => {
    if (path === "/api/v1/cover/settings") return { poolPreference: "NEUTRAL", teacherSelfReport: selfReport };
    if (path.startsWith("/api/v1/teacher-absences")) return [MINE];
    if (path === "/api/v1/teacher-absence-reasons") return [{ id: "r-sick", builtin: "SICK", label: null, sortOrder: 10, archived: false }];
    if (path.startsWith("/api/v1/cover/availability")) {
      return [{ id: "w-1", userId: "t-me", date: null, dayOfWeek: 2, startTime: "08:00", endTime: "15:00" }];
    }
    throw new Error(`unexpected GET ${path}`);
  });
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm">
        <TeacherCoverPage />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  pool.member = false;
});

describe("/teacher/franvaro", () => {
  it("lists the lessons the teacher covers, not their own, and their own absence with its reason", async () => {
    answer(false);
    renderPage();
    const covers = (await screen.findByText("Mina vikariepass")).closest("section")!;
    expect(within(covers).getByText("Matematik")).toBeInTheDocument();
    expect(within(covers).getByText("Sal 12")).toBeInTheDocument();
    expect(within(covers).queryByText("Engelska")).not.toBeInTheDocument();

    const mine = screen.getByText("Min frånvaro").closest("section")!;
    expect(await within(mine).findByText("Sjukdom")).toBeInTheDocument();
    expect(within(mine).getByText("2 med vikarie")).toBeInTheDocument();
  });

  it("offers no self-report when the school has it off, and says whom to tell", async () => {
    answer(false);
    renderPage();
    expect(await screen.findByText("Skolledningen registrerar frånvaro. Hör av dig till dem som vanligt.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Anmäl frånvaro/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Avsluta i förtid" })).not.toBeInTheDocument();
  });

  it("offers report and end early when the school allows it, and the report form starts today", async () => {
    answer(true);
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByRole("button", { name: "Avsluta i förtid" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Anmäl frånvaro/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/utan orsak/)).toBeInTheDocument();
    // A teacher reports their own: there is no teacher to choose.
    expect(within(dialog).queryByRole("combobox", { name: "Lärare" })).not.toBeInTheDocument();
  });

  it("tells a teacher whose lessons already have cover to ask the school, instead of offering to undo it", async () => {
    answer(true);
    post.mockRejectedValue(new ApiError(409, "…", "ABSENCE_HAS_DECISIONS", { count: 2 }));
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Avsluta i förtid" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Avsluta" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Skolledningen har redan ordnat vikarie eller något annat för lektioner efter tidpunkten. Be dem avsluta frånvaron.",
      ),
    );
    expect(screen.queryByText("Ångra besluten efter den nya sluttiden?")).not.toBeInTheDocument();
    expect(post).toHaveBeenCalledTimes(1);
    expect((post.mock.calls[0] as [string, { undoDecisions?: boolean }])[1].undoDecisions).toBeFalsy();
  });

  it("shows a pool member their own hours, and nobody else that section", async () => {
    answer(false);
    pool.member = true;
    renderPage();
    expect(await screen.findByText("Min tillgänglighet")).toBeInTheDocument();
    expect(await screen.findByText(/Tisdag 08:00–15:00/)).toBeInTheDocument();
    await waitFor(() => expect(get).toHaveBeenCalledWith("/api/v1/cover/availability"));
  });

  it("hides 'Min tillgänglighet' from a teacher outside the pool", async () => {
    answer(false);
    renderPage();
    await screen.findByText("Min frånvaro");
    await waitFor(() => expect(screen.queryByText("Min tillgänglighet")).not.toBeInTheDocument());
  });
});

describe("mayWithdraw", () => {
  const now = Date.parse("2026-10-12T08:00:00Z");
  const base = { ...MINE, startsAt: "2026-10-12T00:00:00Z", createdAt: "2026-10-12T07:30:00Z" };

  it("offers a withdrawal before the start, or within the hour when nothing is decided", () => {
    expect(mayWithdraw({ ...base, startsAt: "2026-10-13T00:00:00Z" }, now)).toBe(true);
    expect(mayWithdraw({ ...base, counts: { ...base.counts, covered: 0, cancelled: 0, handled: 0 } }, now)).toBe(true);
    expect(mayWithdraw(base, now)).toBe(false);
    expect(mayWithdraw({ ...base, counts: { ...base.counts, covered: 0 }, createdAt: "2026-10-12T06:30:00Z" }, now)).toBe(false);
  });
});
