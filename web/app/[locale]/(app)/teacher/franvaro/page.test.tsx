import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import sv from "@/messages/sv.json";
import { ApiError, api } from "@/lib/api";
import type { Absence } from "@/lib/cover-types";
import type { MyCover, MyCoverRequest, MyCoverPass } from "@/lib/cover-request-types";
import { orderRequests } from "@/components/cover/cover-requests-section";
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

/** Vikariefrågan: what GET /cover-requests/mine answers; a test sets it and a settled write may change it. */
const mine = vi.hoisted(() => ({ value: { requests: [], passes: [] } as MyCover, fail: false }));

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
    if (path === "/api/v1/cover-requests/mine") {
      if (mine.fail) throw new ApiError(500, "boom");
      return mine.value;
    }
    if (path === "/api/v1/cover/settings") return { poolPreference: "NEUTRAL", teacherSelfReport: selfReport };
    // Lektionslogg: the lessons this teacher handed over for an absence.
    if (path.startsWith("/api/v1/lesson-logs/handed-over?")) {
      return {
        lessons: [
          {
            lessonId: "l-gone",
            date: day,
            startsAt: `${day}T12:00:00.000Z`,
            endsAt: `${day}T13:00:00.000Z`,
            subjectId: "s-en",
            studentGroupId: "g-8b",
            roomId: null,
            status: "SCHEDULED",
            decision: "SUBSTITUTE",
            noted: false,
          },
        ],
      };
    }
    // Lektionslogg: the notes the lessons' own teachers left this substitute.
    if (path.startsWith("/api/v1/lesson-logs?")) {
      return {
        entries: [
          { lessonId: "l-cover", topic: null, homework: null, substituteNote: "Planeringen ligger i lärplattformen." },
          { lessonId: "l-own", topic: "Verb", homework: null, substituteNote: "Min egen lektions notis" },
        ],
      };
    }
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
  mine.value = { requests: [], passes: [] };
  mine.fail = false;
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

  it("shows on each pass the note its own teacher left, and links the pass to its lesson page (Lektionslogg)", async () => {
    answer(false);
    renderPage();
    const covers = (await screen.findByText("Mina vikariepass")).closest("section")!;
    expect(await within(covers).findByText("Planeringen ligger i lärplattformen.")).toBeInTheDocument();
    expect(within(covers).getByText("Notis från läraren:")).toBeInTheDocument();
    expect(within(covers).getByRole("link", { name: "Matematik" })).toHaveAttribute("href", expect.stringContaining("/teacher/lektion/l-cover"));
    // The teacher's own lesson is no pass, and its note is not listed here.
    expect(within(covers).queryByText("Min egen lektions notis")).not.toBeInTheDocument();
    const asked = get.mock.calls.map(([path]) => path as string).find((path) => path.startsWith("/api/v1/lesson-logs?"));
    expect(asked).toMatch(/^\/api\/v1\/lesson-logs\?from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}$/);
  });

  it("lists the lessons handed over for the teacher's absence, each with the way to its note (Lektionslogg)", async () => {
    answer(false);
    renderPage();
    const mine = (await screen.findByText("Min frånvaro")).closest("section")!;
    expect(await within(mine).findByText("Lektioner du lämnat över")).toBeInTheDocument();
    expect(within(mine).getByText("Vikarie tillsatt")).toBeInTheDocument();
    const link = within(mine).getByRole("link", { name: /^Skriv notis till vikarien/ });
    expect(link).toHaveAttribute("href", expect.stringContaining("/teacher/lektion/l-gone"));
  });

  it("offers no self-report when the school has it off, and says whom to tell", async () => {
    answer(false);
    renderPage();
    expect(await screen.findByText("Skolledningen registrerar frånvaro. Hör av dig till dem som vanligt.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Anmäl frånvaro/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Avsluta i förtid/ })).not.toBeInTheDocument();
  });

  it("offers report and end early when the school allows it, and the report form starts today", async () => {
    answer(true);
    const user = userEvent.setup();
    renderPage();
    // Named with the absence's period, so two rows' buttons are not one name.
    expect(await screen.findByRole("button", { name: /^Avsluta i förtid \S/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Anmäl frånvaro/ }));
    // The form is a lazy chunk: the first test to open one waits for it to be transformed.
    const dialog = await screen.findByRole("dialog", undefined, { timeout: 5000 });
    expect(within(dialog).getByText(/utan orsak/)).toBeInTheDocument();
    // A teacher reports their own: there is no teacher to choose.
    expect(within(dialog).queryByRole("combobox", { name: "Lärare" })).not.toBeInTheDocument();
  });

  it("tells a teacher whose lessons already have cover to ask the school, instead of offering to undo it", async () => {
    answer(true);
    post.mockRejectedValue(new ApiError(409, "…", "ABSENCE_HAS_DECISIONS", { count: 2 }));
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: /^Avsluta i förtid/ }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Avsluta" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Skolledningen har redan ordnat vikarie eller något annat för lektioner eller rastvaktspass efter tidpunkten. Be dem avsluta frånvaron.",
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

/*
 * Vikariefrågan. The gateway sends a colleague the lessons (when, subject,
 * class, room), the time to answer by and their own state, never who is away
 * or why; the page must not look either up. The first yes takes all lessons.
 */
const asked = (overrides: Partial<MyCoverRequest> = {}): MyCoverRequest => ({
  id: "r-1",
  state: "OPEN",
  createdAt: new Date(Date.now() - 600_000).toISOString(),
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  lessons: [
    { lessonId: "q-1", date: day, startsAt: `${day}T07:00:00.000Z`, endsAt: `${day}T08:00:00.000Z`, subjectName: "Historia", groupName: "9C", roomName: "Sal 4", cancelled: false },
    { lessonId: "q-2", date: day, startsAt: `${day}T08:00:00.000Z`, endsAt: `${day}T09:00:00.000Z`, subjectName: "Samhällskunskap", groupName: "9C", roomName: null, cancelled: false },
  ],
  ...overrides,
});
const requestsSection = async () => (await screen.findByRole("heading", { name: "Vikarieförfrågningar" })).closest("section")!;

describe("Vikarieförfrågningar", () => {
  it("shows the questions at the top: each lesson's day, time, subject, class and room, the time to answer by, and never who is away", async () => {
    answer(false);
    mine.value = { requests: [asked()], passes: [] };
    renderPage();
    const section = within(await requestsSection());
    expect(section.getByText("Historia")).toBeInTheDocument();
    expect(section.getByText("Samhällskunskap")).toBeInTheDocument();
    expect(section.getAllByText("9C")).toHaveLength(2);
    expect(section.getByText("Sal 4")).toBeInTheDocument();
    expect(section.getAllByText(/^\d{2}:\d{2}–\d{2}:\d{2}$/)).toHaveLength(2);
    expect(section.getByText(/^Svara senast .*\d{2}:\d{2}$/)).toBeInTheDocument();
    expect(section.getByRole("button", { name: /^Ja, jag tar dem/ })).toBeInTheDocument();
    expect(section.getByRole("button", { name: /^Nej/ })).toBeInTheDocument();
    expect(section.queryByText(/frånvarande|frånvaro|Sjuk|Anna/i)).not.toBeInTheDocument();
    // Above the passes the teacher already holds.
    const covers = screen.getByRole("heading", { name: "Mina vikariepass" }).closest("section")!;
    expect(section.getByText("Historia").compareDocumentPosition(covers) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // It asks for the questions and for nothing about the absence.
    expect(get).toHaveBeenCalledWith("/api/v1/cover-requests/mine");
  });

  it("says a single lesson as one: 'Ja, jag tar den'", async () => {
    answer(false);
    mine.value = { requests: [asked({ lessons: [asked().lessons[0]!] })], passes: [] };
    renderPage();
    expect(within(await requestsSection()).getByRole("button", { name: /^Ja, jag tar den / })).toBeInTheDocument();
  });

  it("says nothing, and takes no room, when nobody has asked", async () => {
    answer(false);
    renderPage();
    await screen.findByText("Mina vikariepass");
    await waitFor(() => expect(get).toHaveBeenCalledWith("/api/v1/cover-requests/mine"));
    expect(screen.queryByRole("heading", { name: "Vikarieförfrågningar" })).not.toBeInTheDocument();
  });

  it("says the questions could not be read, rather than showing none", async () => {
    answer(false);
    mine.fail = true;
    renderPage();
    expect(await within(await requestsSection()).findByText("Dina vikarieförfrågningar kunde inte hämtas")).toBeInTheDocument();
  });

  it("says yes for all the lessons in one tap, thanks the teacher, and shows the outcome", async () => {
    answer(false);
    mine.value = { requests: [asked()], passes: [] };
    post.mockImplementation(async () => {
      mine.value = { requests: [asked({ state: "ACCEPTED_BY_ME" })], passes: [] };
      return { requestId: "r-1", lessons: 2 };
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(within(await requestsSection()).getByRole("button", { name: /^Ja, jag tar dem/ }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/v1/cover-requests/r-1/accept"));
    expect(toast.success).toHaveBeenCalledWith("Tack! Alla 2 lektionerna är dina.");
    const section = within(await requestsSection());
    expect(await section.findByText("Du tackade ja")).toBeInTheDocument();
    expect(section.queryByRole("button", { name: /^Ja, jag tar dem/ })).not.toBeInTheDocument();
    expect(section.queryByRole("button", { name: /^Nej/ })).not.toBeInTheDocument();
    // The teacher's week moves: the covers are read again too.
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("tells a teacher who came second that a colleague said yes first, and reads the list again", async () => {
    answer(false);
    mine.value = { requests: [asked()], passes: [] };
    post.mockImplementation(async () => {
      mine.value = { requests: [asked({ state: "TAKEN" })], passes: [] };
      throw new ApiError(409, "Uppdraget är redan tillsatt: en kollega hann tacka ja före dig.", "COVER_REQUEST_TAKEN");
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(within(await requestsSection()).getByRole("button", { name: /^Ja, jag tar dem/ }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Uppdraget är redan tillsatt: en kollega hann tacka ja före dig."),
    );
    const section = within(await requestsSection());
    expect(await section.findByText("Redan tillsatt av en kollega")).toBeInTheDocument();
    expect(section.queryByRole("button", { name: /^Ja, jag tar dem/ })).not.toBeInTheDocument();
  });

  it.each([
    ["COVER_REQUEST_GONE", "EXPIRED" as const, "Gick ut", "Förfrågan är avslutad: den har gått ut, dragits tillbaka eller tillsatts på annat sätt."],
    ["COVER_REQUEST_GONE", "WITHDRAWN" as const, "Återkallad", "Förfrågan är avslutad: den har gått ut, dragits tillbaka eller tillsatts på annat sätt."],
    ["COVER_REQUEST_LESSON_CANCELLED", "CLOSED" as const, "Behövs inte längre", "Lektionen är inställd och går inte att fråga om."],
  ])("says %s in words and reads the list again (%s)", async (code, state, label, sentence) => {
    answer(false);
    mine.value = { requests: [asked()], passes: [] };
    post.mockImplementation(async () => {
      mine.value = { requests: [asked({ state })], passes: [] };
      throw new ApiError(409, "English log text", code);
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(within(await requestsSection()).getByRole("button", { name: /^Ja, jag tar dem/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(sentence));
    expect(await within(await requestsSection()).findByText(label)).toBeInTheDocument();
  });

  it("shows the gateway's own Swedish when a hard rule refuses the yes, and keeps the question open for another try or a no", async () => {
    answer(false);
    mine.value = { requests: [asked()], passes: [] };
    const sentence = "Du kan inte ta uppdraget (tis 14 okt 08:00) eftersom du skulle överskrida dagens tak för undervisning.";
    post.mockRejectedValue(new ApiError(409, sentence, "COVER_REQUEST_RULE", { lessonId: "q-1", rules: "DAILY_CAP" }));
    const user = userEvent.setup();
    renderPage();
    await user.click(within(await requestsSection()).getByRole("button", { name: /^Ja, jag tar dem/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(sentence));
    const section = within(await requestsSection());
    expect(section.getByText("Historia")).toBeInTheDocument();
    expect(section.getByRole("button", { name: /^Ja, jag tar dem/ })).toBeEnabled();
    expect(section.getByRole("button", { name: /^Nej/ })).toBeEnabled();
    expect(section.queryByText("Redan tillsatt av en kollega")).not.toBeInTheDocument();
  });

  it("says no in one tap and shows that the teacher did", async () => {
    answer(false);
    mine.value = { requests: [asked()], passes: [] };
    post.mockImplementation(async () => {
      mine.value = { requests: [asked({ state: "DECLINED_BY_ME" })], passes: [] };
      return { requestId: "r-1" };
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(within(await requestsSection()).getByRole("button", { name: /^Nej/ }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/v1/cover-requests/r-1/decline"));
    expect(toast.success).toHaveBeenCalledWith("Du har tackat nej.");
    expect(await within(await requestsSection()).findByText("Du tackade nej")).toBeInTheDocument();
  });

  it("says in words how each question that is no longer open ended, and offers no answer to it", async () => {
    answer(false);
    mine.value = {
      requests: [
        asked({ id: "r-a", state: "ACCEPTED_BY_ME" }),
        asked({ id: "r-t", state: "TAKEN" }),
        asked({ id: "r-w", state: "WITHDRAWN" }),
        asked({ id: "r-e", state: "EXPIRED" }),
        asked({ id: "r-c", state: "CLOSED" }),
      ],
      passes: [],
    };
    renderPage();
    const section = within(await requestsSection());
    for (const text of ["Du tackade ja", "Redan tillsatt av en kollega", "Återkallad", "Gick ut", "Behövs inte längre"]) {
      expect(await section.findByText(text)).toBeInTheDocument();
    }
    expect(section.queryByRole("button")).not.toBeInTheDocument();
  });

  it("puts the open questions first, soonest lesson first, then the five latest that ended", () => {
    const at = (hours: number) => new Date(Date.UTC(2030, 9, 14, hours)).toISOString();
    const open = (id: string, hours: number) => asked({ id, lessons: [{ ...asked().lessons[0]!, startsAt: at(hours) }] });
    const ended = (id: string, createdAt: string) => asked({ id, state: "EXPIRED", createdAt });
    const ordered = orderRequests([
      ended("e1", "2030-10-01T00:00:00Z"),
      open("late", 12),
      ended("e2", "2030-10-02T00:00:00Z"),
      open("early", 8),
      ended("e3", "2030-10-03T00:00:00Z"),
      ended("e4", "2030-10-04T00:00:00Z"),
      ended("e5", "2030-10-05T00:00:00Z"),
      ended("e6", "2030-10-06T00:00:00Z"),
    ]);
    expect(ordered.map((request) => request.id)).toEqual(["early", "late", "e6", "e5", "e4", "e3", "e2"]);
  });
});

describe("Bekräfta ett vikariepass", () => {
  const pass = (overrides: Partial<MyCoverPass> = {}): MyCoverPass => ({
    lessonId: "l-cover",
    date: day,
    startsAt: `${day}T07:00:00.000Z`,
    endsAt: `${day}T08:00:00.000Z`,
    subjectName: "Matematik",
    groupName: "7A",
    roomName: "Sal 12",
    confirmedAt: null,
    ...overrides,
  });
  const coversSection = async () => (await screen.findByText("Mina vikariepass")).closest("section")!;

  it("offers one tap on a pass not yet confirmed, and shows it confirmed once the school has it", async () => {
    answer(false);
    mine.value = { requests: [], passes: [pass()] };
    post.mockImplementation(async () => {
      mine.value = { requests: [], passes: [pass({ confirmedAt: new Date().toISOString() })] };
      return { lessonId: "l-cover", confirmed: 1 };
    });
    const user = userEvent.setup();
    renderPage();
    const covers = within(await coversSection());
    await user.click(await covers.findByRole("button", { name: /^Bekräfta Matematik/ }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/v1/cover-requests/lessons/l-cover/confirm"));
    expect(toast.success).toHaveBeenCalledWith("Tack, passet är bekräftat.");
    expect(await covers.findByText("Bekräftad")).toBeInTheDocument();
    expect(covers.queryByRole("button", { name: /^Bekräfta/ })).not.toBeInTheDocument();
  });

  it("shows 'Bekräftad' and no button on a pass already confirmed, and nothing on a lesson that is not a pass", async () => {
    answer(false);
    mine.value = { requests: [], passes: [pass({ confirmedAt: new Date().toISOString() })] };
    renderPage();
    const covers = within(await coversSection());
    expect(await covers.findByText("Bekräftad")).toBeInTheDocument();
    expect(covers.queryByRole("button", { name: /Bekräfta/ })).not.toBeInTheDocument();
  });

  it("offers no tap on a lesson /mine does not name as a pass", async () => {
    answer(false);
    mine.value = { requests: [], passes: [pass({ lessonId: "l-elsewhere" })] };
    renderPage();
    const covers = within(await coversSection());
    await covers.findByText("Matematik");
    await waitFor(() => expect(get).toHaveBeenCalledWith("/api/v1/cover-requests/mine"));
    expect(covers.queryByRole("button", { name: /Bekräfta/ })).not.toBeInTheDocument();
  });

  it("says a pass that is not the teacher's to confirm in words", async () => {
    answer(false);
    mine.value = { requests: [], passes: [pass()] };
    post.mockRejectedValue(new ApiError(404, "Passet är inte ditt att bekräfta.", "COVER_PASS_NOT_FOUND"));
    const user = userEvent.setup();
    renderPage();
    await user.click(await within(await coversSection()).findByRole("button", { name: /^Bekräfta Matematik/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Passet är inte ditt att bekräfta."));
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
