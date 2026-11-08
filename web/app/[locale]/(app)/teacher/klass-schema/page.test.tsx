import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { addDaysIso, type ChangeView, type CheckRow, type MineView, type Verdict, type WeekView } from "@/lib/class-teacher";
import {
  CANCELLED,
  CLASS_ID,
  MINE,
  NEWER_VERSION,
  OTHER_TEACHER,
  VERSION,
  draft,
  occasion,
  templateLesson,
  week,
} from "@/lib/__fixtures__/class-teacher";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import ClassSchedulePage from "./page";

// The page is a lot of component for jsdom, and the machines this runs on are shared: waits are generous, not slow.
configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30_000 });

// Environment shims for Radix in jsdom — not behaviour under test.
globalThis.ResizeObserver ??= class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
};

/**
 * /teacher/klass-schema, through the gateway's routes and the real messages:
 * the klasslärare's week as columns of time with the open hours behind it, a
 * lesson locked with its reason in words or open to the actions of its layer,
 * the form that previews its clashes while it is typed and saves a draft, every
 * 409 told without losing what was typed, and the class's drafts with their
 * verdicts and, when the school allows it, their publication.
 */

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api }));

// The profile only says who is reading, to tell another klasslärare's draft from their own.
vi.mock("@/components/profile-context", () => ({
  useProfile: () => ({ profile: { id: "u-me", role: "TEACHER" } }),
  useReadOnly: () => false,
}));

// next-intl's Link needs the routing context; an anchor is what it renders.
vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const BASE = "/api/v1/class-teacher";
const CLASS = `${BASE}/classes/${CLASS_ID}`;

const state = vi.hoisted(() => ({
  mine: undefined as unknown,
  week: undefined as unknown,
  weekAt: undefined as undefined | ((from: string | null) => unknown),
  check: [] as unknown,
  checkError: undefined as unknown,
  preview: undefined as unknown as (body: Record<string, unknown>) => unknown,
}));

const weekReads = () => api.get.mock.calls.map(([path]) => path as string).filter((path) => path.startsWith(`${CLASS}/week`));
const previews = () => api.post.mock.calls.filter(([path]) => path === `${CLASS}/preview`);
const writes = () => api.post.mock.calls.filter(([path]) => path === `${CLASS}/changes`);

/** The gateway as it answers this class: what `state` holds, read again at every request. */
function serve({ mine = MINE, held = week(), check = [] as CheckRow[] }: { mine?: MineView; held?: WeekView; check?: CheckRow[] } = {}) {
  state.mine = mine;
  state.week = held;
  state.weekAt = undefined;
  state.check = check;
  state.checkError = undefined;
  state.preview = () => ({ state: "OK" });
}

function renderPage(locale: "sv" | "en" = "sv") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider
        locale={locale}
        messages={locale === "sv" ? sv : en}
        timeZone="Europe/Stockholm"
        onError={(error) => {
          throw error;
        }}
      >
        <ClassSchedulePage />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.patch.mockReset();
  api.delete.mockReset();
  serve();
  api.get.mockImplementation(async (path: string) => {
    if (path === `${BASE}/mine`) return state.mine;
    if (path.startsWith(`${CLASS}/week`)) return state.weekAt ? state.weekAt(new URL(path, "http://x").searchParams.get("from")) : state.week;
    if (path === `${CLASS}/check`) {
      if (state.checkError) throw state.checkError;
      return state.check;
    }
    throw new Error(`unexpected read ${path}`);
  });
  api.post.mockImplementation(async (path: string, body: Record<string, unknown>) => {
    if (path === `${CLASS}/preview`) return { verdict: state.preview(body) };
    throw new Error(`unexpected write ${path}`);
  });
});

/** A week whose drafts the gateway holds, with the check that judges them. */
function withDrafts(drafts: ChangeView[], verdict: Verdict = { state: "OK" }, extra: Partial<WeekView> = {}) {
  serve({
    held: week({ occasions: [OTHER_TEACHER, occasion({ draftId: drafts[0]?.id ?? null }), CANCELLED], drafts, ...extra }),
    check: drafts.map((change) => ({ change, verdict })),
    mine: { ...MINE, selfPublish: extra.selfPublish ?? false },
  });
}

const lessonButton = (subject: string) => screen.findByRole("button", { name: new RegExp(`^${subject},`) });

describe("a teacher who is nobody's klasslärare", () => {
  it("is told so calmly, and the gateway is asked for no week", async () => {
    serve({ mine: { classes: [], selfPublish: false } });
    renderPage();
    expect(await screen.findByRole("heading", { level: 2, name: "Du är inte utsedd till klasslärare" })).toBeInTheDocument();
    expect(weekReads()).toEqual([]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("is told so too if the appointment was removed since the classes were read", async () => {
    api.get.mockImplementation(async (path: string) => {
      if (path === `${BASE}/mine`) return MINE;
      throw new ApiError(403, "no", "CLASS_TEACHER_NOT_APPOINTED");
    });
    renderPage();
    expect(await screen.findByRole("heading", { name: "Du är inte utsedd till klasslärare" })).toBeInTheDocument();
  });

  it("says a week that could not be read as one, and not as an empty week", async () => {
    api.get.mockImplementation(async (path: string) => {
      if (path === `${BASE}/mine`) return MINE;
      throw new ApiError(500, "boom");
    });
    renderPage();
    expect(await screen.findByText("Klassens schema kunde inte hämtas")).toBeInTheDocument();
    expect(screen.queryByText("Klassen har inga lektioner den här veckan.")).not.toBeInTheDocument();
  });
});

describe("the week", () => {
  it("draws the dated lessons with their state in words, the locked one with its reason", async () => {
    renderPage();
    const maths = await lessonButton("Matematik");
    expect(maths).toHaveAccessibleName(/Kan ändras/);
    expect(maths).toHaveAttribute("data-state", "editable");
    const swedish = await lessonButton("Svenska");
    expect(swedish).toHaveAccessibleName(/Låst, Lektionen har en annan lärare än du\./);
    expect(swedish).toHaveAttribute("data-state", "locked");
    const english = await lessonButton("Engelska");
    expect(english).toHaveAccessibleName(/Inställd/);
    expect(english).toHaveAttribute("data-state", "cancelled");
    expect(screen.getByText(/Vecka 45/)).toBeInTheDocument();
  });

  it("marks a lesson that has a draft", async () => {
    withDrafts([draft()]);
    renderPage();
    expect(await lessonButton("Matematik")).toHaveAttribute("data-state", "draft");
  });

  it("draws the open hours as a quiet band behind each day and says them in words under its name", async () => {
    renderPage();
    await lessonButton("Matematik");
    expect(document.querySelectorAll("[data-open-band]")).toHaveLength(5);
    expect(screen.getAllByText("Öppet 08:00–12:00")).toHaveLength(5);
    expect(screen.queryByText("Inga tider är öppna för klasslärare")).not.toBeInTheDocument();
  });

  it("says when no hour is open, and still shows the lessons", async () => {
    serve({ held: week({ openTimes: [] }) });
    renderPage();
    expect(await screen.findByText("Inga tider är öppna för klasslärare")).toBeInTheDocument();
    expect(screen.getAllByText("Inget öppet")).toHaveLength(5);
    expect(await lessonButton("Matematik")).toBeInTheDocument();
  });

  it("says a week that could not be read again, and goes on showing the last one it has", async () => {
    renderPage();
    await lessonButton("Matematik");
    api.get.mockImplementation(async (path: string) => {
      if (path.startsWith(`${CLASS}/week`)) throw new ApiError(503, "unavailable");
      return state.mine;
    });
    // Two people editing one class see each other by the week being read again when the window is looked at again.
    fireEvent(document, new Event("visibilitychange", { bubbles: true }));
    expect(await screen.findByText("Veckan kunde inte läsas om")).toBeInTheDocument();
    expect(screen.getByText(/Ladda om sidan innan du ändrar något/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Matematik,/ })).toBeInTheDocument();
  });

  it("says a week without lessons", async () => {
    serve({ held: week({ occasions: [] }) });
    renderPage();
    expect(await screen.findByText("Klassen har inga lektioner den här veckan.")).toBeInTheDocument();
  });

  it("moves between weeks and back, and lets go of a dated lesson that is not on the next week", async () => {
    const user = userEvent.setup();
    state.weekAt = (from) => {
      const start = from ? from : "2026-11-02";
      return week({ weekStart: start, days: [0, 1, 2, 3, 4].map((offset) => addDaysIso(start, offset)), occasions: from ? [] : [occasion()] });
    };
    renderPage();
    await user.click(await lessonButton("Matematik"));
    expect(screen.getByRole("heading", { level: 2, name: "Matematik" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Nästa vecka" }));
    await waitFor(() => expect(weekReads()).toContain(`${CLASS}/week?from=2026-11-09`));
    expect(await screen.findByText(/Vecka 46/)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2, name: "Matematik" })).not.toBeInTheDocument();
    expect(screen.getByText("Välj en lektion i schemat för att se vad du kan göra med den.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Föregående vecka" }));
    await waitFor(() => expect(weekReads()).toContain(`${CLASS}/week?from=2026-11-02`));
    await user.click(screen.getByRole("button", { name: "Denna vecka" }));
    // No date is named: the gateway says which week is this one, on the school's clock.
    await waitFor(() => expect(weekReads().at(-1)).toBe(`${CLASS}/week`));
    expect(await screen.findByText(/Vecka 45/)).toBeInTheDocument();
  });

  it("offers a choice of class to a teacher who has more than one", async () => {
    const user = userEvent.setup();
    serve({ mine: { classes: [{ id: CLASS_ID, name: "3A", academicYearId: "y" }, { id: "c-3b", name: "3B", academicYearId: "y" }], selfPublish: false } });
    renderPage();
    const select = await screen.findByLabelText("Klass");
    expect(within(select).getAllByRole("option").map((one) => one.textContent)).toEqual(["3A", "3B"]);
    api.get.mockImplementation(async (path: string) => {
      if (path === `${BASE}/mine`) return state.mine;
      if (path.startsWith(`${BASE}/classes/c-3b/week`)) return week({ classId: "c-3b", className: "3B", occasions: [] });
      return state.week;
    });
    await user.selectOptions(select, "c-3b");
    await waitFor(() => expect(api.get.mock.calls.map(([path]) => path)).toContain(`${BASE}/classes/c-3b/week`));
  });
});

describe("a lesson chosen", () => {
  it("says why a locked lesson is locked, in the frame's words, and offers nothing", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await lessonButton("Svenska"));
    expect(screen.getByRole("heading", { level: 2, name: "Svenska" })).toBeInTheDocument();
    expect(screen.getByText("Lektionen är låst")).toBeInTheDocument();
    expect(screen.getByText("Lektionen har en annan lärare än du.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Flytta" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ställ in" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Byt sal" })).not.toBeInTheDocument();
  });

  it("offers a dated lesson to be moved, cancelled or given another room", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await lessonButton("Matematik"));
    for (const name of ["Flytta", "Ställ in", "Byt sal"]) expect(screen.getByRole("button", { name })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Dela passet" })).not.toBeInTheDocument();
  });

  it("offers a lesson of the template to be moved in it or split", async () => {
    const user = userEvent.setup();
    renderPage();
    await lessonButton("Matematik");
    await user.click(screen.getByRole("tab", { name: "Mallen" }));
    await user.click(await lessonButton("Matematik"));
    expect(screen.getByRole("button", { name: "Flytta i mallen" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Dela passet" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Ställ in" })).not.toBeInTheDocument();
    expect(screen.getByText("Klassens veckomall. Det du ändrar här gäller varje vecka framöver, när utkastet har publicerats.")).toBeInTheDocument();
  });

  it("does not offer to split a lesson too short for two parts", async () => {
    const user = userEvent.setup();
    serve({ held: week({ template: [templateLesson({ start: "09:00", end: "09:25" })] }) });
    renderPage();
    await lessonButton("Matematik");
    await user.click(screen.getByRole("tab", { name: "Mallen" }));
    await user.click(await lessonButton("Matematik"));
    expect(screen.getByRole("button", { name: "Dela passet" })).toBeDisabled();
    expect(screen.getByText(/för kort för att delas/)).toBeInTheDocument();
  });
});

describe("a move, typed", () => {
  async function openMove() {
    const user = userEvent.setup();
    renderPage();
    await user.click(await lessonButton("Matematik"));
    await user.click(screen.getByRole("button", { name: "Flytta" }));
    return user;
  }

  it("opens as the lesson stands and asks nothing of the gateway until something is changed", async () => {
    await openMove();
    expect(screen.getByRole("heading", { level: 3, name: "Flytta lektionen" })).toBeInTheDocument();
    expect(screen.getByLabelText("Nytt datum")).toHaveValue("2026-11-03");
    expect(screen.getByLabelText("Från")).toHaveValue("09:00");
    expect(screen.getByLabelText("Till")).toHaveValue("10:00");
    expect(screen.getByText("Ändra dag, tid eller sal för att kunna spara.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Spara utkast" })).toBeDisabled();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(previews()).toEqual([]);
  });

  it("says in the live check what publishing would take out of the calendar, in a warning and not in the green of 'can be published'", async () => {
    await openMove();
    state.preview = () => ({ state: "OK", removes: { lessons: 2, withLog: 1 } });
    fireEvent.change(screen.getByLabelText("Nytt datum"), { target: { value: "2026-11-05" } });
    const region = screen.getByTestId("preview-region");
    expect(await within(region).findByText("Kan publiceras, men tar bort lektioner ur kalendern", undefined, { timeout: 3000 })).toBeInTheDocument();
    expect(within(region).getByText(/2 kommande lektioner tas bort/)).toBeInTheDocument();
    expect(within(region).getByText(/1 av dem har lektionslogg/)).toBeInTheDocument();
    expect(region.querySelector('[data-tone="warning"]')).not.toBeNull();
    expect(within(region).queryByText("Kan publiceras")).not.toBeInTheDocument();
  });

  it("asks what the change would clash with once it stands still, and says the clashes by what clashes", async () => {
    await openMove();
    state.preview = () => ({
      state: "CONFLICT",
      conflicts: [
        { kind: "ROOM", other: { className: "3B", subjectName: "Svenska", date: "2026-11-05", start: "10:00", end: "11:00" } },
        { kind: "TEACHER" },
      ],
    });
    // Three edits in quick succession: one question, about the last of them.
    fireEvent.change(screen.getByLabelText("Nytt datum"), { target: { value: "2026-11-05" } });
    fireEvent.change(screen.getByLabelText("Från"), { target: { value: "10:00" } });
    fireEvent.change(screen.getByLabelText("Till"), { target: { value: "11:00" } });
    const region = screen.getByTestId("preview-region");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(within(region).getByText("Kontrollerar mot schemat…")).toBeInTheDocument();

    await waitFor(() => expect(previews()).toHaveLength(1), { timeout: 3000 });
    expect(previews()[0]![1]).toEqual({ kind: "OCCASION_MOVE", calendarLessonId: "o-ma", targetDate: "2026-11-05", targetStart: "10:00", targetEnd: "11:00" });
    expect(await within(region).findByText("Utkastet krockar i schemat")).toBeInTheDocument();
    expect(within(region).getByText(/Salen är upptagen då: 3B, Svenska, tors 5 nov\. 10:00–11:00/)).toBeInTheDocument();
    expect(within(region).getByText("Läraren har en annan lektion då")).toBeInTheDocument();
    expect(screen.getByText(/Du kan spara utkastet ändå/)).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(previews()).toHaveLength(1);
    // The title is a label and the region under it carries the live text.
    expect(screen.getByText("Konflikter")).toBeInTheDocument();
  });

  it("says a change the frame refuses, with its reason, and does not let it be saved", async () => {
    await openMove();
    state.preview = () => ({ state: "REFUSED", reason: "TARGET_CLOSED" });
    fireEvent.change(screen.getByLabelText("Till"), { target: { value: "13:00" } });
    const region = screen.getByTestId("preview-region");
    expect(await within(region).findByText("Kan inte publiceras", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(within(region).getByText("Den nya tiden ligger utanför de tider som är öppna för klasslärare.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Spara utkast" })).toBeDisabled();
  });

  it("says no clash when there is none", async () => {
    await openMove();
    fireEvent.change(screen.getByLabelText("Nytt datum"), { target: { value: "2026-11-04" } });
    expect(await screen.findByText("Inga konflikter. Utkastet kan sparas.", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Spara utkast" })).toBeEnabled();
  });

  it("checks the form itself first: an end before its start is said at the field, and nothing is asked", async () => {
    await openMove();
    fireEvent.change(screen.getByLabelText("Till"), { target: { value: "08:00" } });
    expect(await screen.findByText("Sluttiden ska vara efter starttiden.")).toBeInTheDocument();
    expect(screen.getByLabelText("Till")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Spara utkast" })).toBeDisabled();
    expect(screen.getByText("Rätta formuläret för att kontrollera mot schemat.")).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(previews()).toEqual([]);
  });

  it("does not take a Saturday", async () => {
    await openMove();
    fireEvent.change(screen.getByLabelText("Nytt datum"), { target: { value: "2026-11-07" } });
    expect(await screen.findByText("Lektioner läggs måndag till fredag.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Spara utkast" })).toBeDisabled();
  });

  it("saves a draft held to the lesson's version, and shows it in the list of drafts", async () => {
    const user = await openMove();
    const saved = draft({ targetDate: "2026-11-05", targetStart: "10:00", targetEnd: "11:00", targetRoomId: "r-14", note: "Prov" });
    api.post.mockImplementation(async (path: string, body: Record<string, unknown>) => {
      if (path === `${CLASS}/preview`) return { verdict: { state: "OK" } };
      if (path === `${CLASS}/changes`) {
        withDrafts([saved]);
        return saved;
      }
      throw new Error(`unexpected write ${path}`);
    });
    fireEvent.change(screen.getByLabelText("Nytt datum"), { target: { value: "2026-11-05" } });
    fireEvent.change(screen.getByLabelText("Från"), { target: { value: "10:00" } });
    fireEvent.change(screen.getByLabelText("Till"), { target: { value: "11:00" } });
    fireEvent.change(screen.getByLabelText("Sal"), { target: { value: "r-14" } });
    fireEvent.change(screen.getByLabelText(/^Anteckning/), { target: { value: "  Prov  " } });
    await user.click(screen.getByRole("button", { name: "Spara utkast" }));

    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]![1]).toEqual({
      kind: "OCCASION_MOVE",
      calendarLessonId: "o-ma",
      baseVersion: VERSION,
      targetDate: "2026-11-05",
      targetStart: "10:00",
      targetEnd: "11:00",
      targetRoomId: "r-14",
      note: "Prov",
    });
    // The form closes, the week is read again, and the draft is in the list.
    await waitFor(() => expect(screen.queryByRole("heading", { level: 3, name: "Flytta lektionen" })).not.toBeInTheDocument());
    expect(await screen.findByRole("button", { name: /^Redigera utkastet: Flytta Matematik .* till .* 10:00–11:00 i Sal 14$/ })).toBeInTheDocument();
    expect(await lessonButton("Matematik")).toHaveAttribute("data-state", "draft");
  });

  it("keeps what was typed when the lesson has changed meanwhile (409), says so, and offers to read the week again", async () => {
    const user = await openMove();
    api.post.mockImplementation(async (path: string) => {
      if (path === `${CLASS}/preview`) return { verdict: { state: "OK" } };
      throw new ApiError(409, "Lektionen har ändrats", "CLASS_TEACHER_STALE");
    });
    fireEvent.change(screen.getByLabelText("Nytt datum"), { target: { value: "2026-11-05" } });
    const reads = weekReads().length;
    await user.click(screen.getByRole("button", { name: "Spara utkast" }));

    expect(await screen.findByText("Lektionen har ändrats sedan du öppnade den")).toBeInTheDocument();
    expect(screen.getByText(/Det du skrev finns kvar/)).toBeInTheDocument();
    expect(screen.getByLabelText("Nytt datum")).toHaveValue("2026-11-05");
    // The write left the week stale, so it was read again; and the notice offers the same by hand.
    await waitFor(() => expect(weekReads().length).toBeGreaterThan(reads));
    state.week = week({ occasions: [OTHER_TEACHER, occasion({ version: NEWER_VERSION }), CANCELLED] });
    await waitFor(() => expect(screen.getByRole("button", { name: "Läs om" })).toBeEnabled());
    const before = weekReads().length;
    await user.click(screen.getByRole("button", { name: "Läs om" }));
    await waitFor(() => expect(weekReads().length).toBeGreaterThan(before));
    // A save now is held to the version that was read last.
    api.post.mockImplementation(async (path: string) => (path === `${CLASS}/preview` ? { verdict: { state: "OK" } } : draft()));
    await user.click(screen.getByRole("button", { name: "Spara utkast" }));
    await waitFor(() => expect(api.post.mock.calls.at(-1)![1]).toMatchObject({ baseVersion: NEWER_VERSION }));
  });

  it("says a draft already waits for the lesson (409) and opens it on request", async () => {
    const user = await openMove();
    api.post.mockImplementation(async (path: string) => {
      if (path === `${CLASS}/preview`) return { verdict: { state: "OK" } };
      withDrafts([draft()]);
      throw new ApiError(409, "Det finns redan ett utkast", "CLASS_TEACHER_DRAFT_EXISTS");
    });
    fireEvent.change(screen.getByLabelText("Nytt datum"), { target: { value: "2026-11-05" } });
    await user.click(screen.getByRole("button", { name: "Spara utkast" }));
    expect(await screen.findByText("Det finns redan ett utkast för lektionen")).toBeInTheDocument();
    const open = screen.getByRole("button", { name: "Öppna utkastet" });
    await waitFor(() => expect(open).toBeEnabled());
    await user.click(open);
    // The draft's own form, with the draft's own values.
    expect(await screen.findByRole("heading", { level: 3, name: "Redigera utkast: Flytta lektionen" })).toBeInTheDocument();
    expect(screen.getByLabelText("Nytt datum")).toHaveValue("2026-11-04");
  });

  it("tells a refusal outside the frame, and points to the reason the preview gives when the gateway sent none", async () => {
    const user = await openMove();
    api.post.mockImplementation(async (path: string) => {
      if (path === `${CLASS}/preview`) return { verdict: { state: "OK" } };
      throw new ApiError(403, "Ändringen ligger utanför det du får ändra.", "CLASS_TEACHER_OUTSIDE_FRAME");
    });
    fireEvent.change(screen.getByLabelText("Nytt datum"), { target: { value: "2026-11-05" } });
    await user.click(screen.getByRole("button", { name: "Spara utkast" }));
    expect(await screen.findByText("Ändringen ligger utanför det du får ändra")).toBeInTheDocument();
    expect(screen.getByText("Orsaken står under Konflikter ovan.")).toBeInTheDocument();
  });

  it("names the reason when the gateway sent it", async () => {
    const user = await openMove();
    api.post.mockImplementation(async (path: string) => {
      if (path === `${CLASS}/preview`) return { verdict: { state: "OK" } };
      throw new ApiError(403, "Tiden är inte öppen", "CLASS_TEACHER_OUTSIDE_FRAME", { reason: "TIME_CLOSED" });
    });
    fireEvent.change(screen.getByLabelText("Nytt datum"), { target: { value: "2026-11-05" } });
    await user.click(screen.getByRole("button", { name: "Spara utkast" }));
    expect(await screen.findByText("Tiden är inte öppen för klasslärarens ändringar.")).toBeInTheDocument();
  });

  it("tells a klasslärare whose appointment lapsed to ask for a new one", async () => {
    const user = await openMove();
    api.post.mockImplementation(async (path: string) => {
      if (path === `${CLASS}/preview`) throw new ApiError(409, "x", "CLASS_TEACHER_APPOINTER_GONE");
      throw new ApiError(409, "x", "CLASS_TEACHER_APPOINTER_GONE");
    });
    fireEvent.change(screen.getByLabelText("Nytt datum"), { target: { value: "2026-11-05" } });
    const region = screen.getByTestId("preview-region");
    expect(await within(region).findByText("Du behöver utses på nytt", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(within(region).getByText(/Be en schemaläggare utse dig på nytt/)).toBeInTheDocument();
  });
});

describe("the other actions", () => {
  it("cancels a lesson with a note, and sends the note and nothing else", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await lessonButton("Matematik"));
    await user.click(screen.getByRole("button", { name: "Ställ in" }));
    api.post.mockImplementation(async (path: string) => (path === `${CLASS}/preview` ? { verdict: { state: "OK" } } : draft({ kind: "OCCASION_CANCEL" })));
    // A cancellation is sendable as it opens, so it is checked at once.
    await waitFor(() => expect(previews()).toHaveLength(1), { timeout: 3000 });
    expect(previews()[0]![1]).toEqual({ kind: "OCCASION_CANCEL", calendarLessonId: "o-ma" });
    fireEvent.change(screen.getByLabelText(/^Anteckning/), { target: { value: "Sjukdom" } });
    await user.click(screen.getByRole("button", { name: "Spara utkast" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]![1]).toEqual({ kind: "OCCASION_CANCEL", calendarLessonId: "o-ma", baseVersion: VERSION, note: "Sjukdom" });
  });

  it("gives a lesson another room: a room that cannot be chosen is in the list, and says why", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await lessonButton("Matematik"));
    await user.click(screen.getByRole("button", { name: "Byt sal" }));
    const options = within(screen.getByLabelText("Sal")).getAllByRole("option");
    expect(options.map((one) => one.textContent)).toEqual([
      "Välj sal",
      "Sal 12",
      "Sal 14",
      "Gymnastiksalen (kan inte väljas: Salen är utlånad till eller från en annan skola.)",
    ]);
    expect(options[3]).toBeDisabled();
    expect(screen.getByRole("button", { name: "Spara utkast" })).toBeDisabled();
    expect(screen.getByText("Välj en sal.")).toBeInTheDocument();
    api.post.mockImplementation(async (path: string) => (path === `${CLASS}/preview` ? { verdict: { state: "OK" } } : draft({ kind: "OCCASION_ROOM" })));
    fireEvent.change(screen.getByLabelText("Sal"), { target: { value: "r-14" } });
    await user.click(await screen.findByRole("button", { name: "Spara utkast" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]![1]).toEqual({ kind: "OCCASION_ROOM", calendarLessonId: "o-ma", baseVersion: VERSION, targetRoomId: "r-14" });
  });

  it("moves a lesson of the template to another weekday", async () => {
    const user = userEvent.setup();
    renderPage();
    await lessonButton("Matematik");
    await user.click(screen.getByRole("tab", { name: "Mallen" }));
    await user.click(await lessonButton("Matematik"));
    await user.click(screen.getByRole("button", { name: "Flytta i mallen" }));
    expect(screen.getByLabelText("Veckodag")).toHaveValue("2");
    api.post.mockImplementation(async (path: string) => (path === `${CLASS}/preview` ? { verdict: { state: "OK" } } : draft({ kind: "TEMPLATE_MOVE" })));
    await user.selectOptions(screen.getByLabelText("Veckodag"), "4");
    await user.click(await screen.findByRole("button", { name: "Spara utkast" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]![1]).toEqual({
      kind: "TEMPLATE_MOVE",
      masterLessonId: "m-ma",
      baseVersion: VERSION,
      targetDayOfWeek: 4,
      targetStart: "09:00",
      targetEnd: "10:30",
    });
  });

  describe("splitting a lesson of the template", () => {
    async function openSplit() {
      const user = userEvent.setup();
      renderPage();
      await lessonButton("Matematik");
      await user.click(screen.getByRole("tab", { name: "Mallen" }));
      await user.click(await lessonButton("Matematik"));
      await user.click(screen.getByRole("button", { name: "Dela passet" }));
      return user;
    }

    it("opens in two halves that add up, and says the minutes", async () => {
      await openSplit();
      expect(screen.getByLabelText("Första delen slutar")).toHaveValue("09:45");
      expect(screen.getByLabelText("Från")).toHaveValue("09:45");
      expect(screen.getByLabelText("Till")).toHaveValue("10:30");
      expect(screen.getByTestId("split-minutes")).toHaveTextContent("Första delen 45 min, andra delen 45 min: tillsammans 90 av 90 min.");
      expect(screen.getByText("Behåller tisdag 09:00.")).toBeInTheDocument();
    });

    it("refuses parts that do not add up, and parts under 15 minutes, before asking the gateway", async () => {
      await openSplit();
      // As it opens it is whole, so it is asked about at once; the edits below make it whole no more.
      await waitFor(() => expect(previews()).toHaveLength(1), { timeout: 3000 });
      expect(previews()[0]![1]).toMatchObject({ keepEnd: "09:45", targetStart: "09:45", targetEnd: "10:30" });
      fireEvent.change(screen.getByLabelText("Till"), { target: { value: "10:20" } });
      expect(await screen.findByText("Delarna ska tillsammans vara lika långa som passet.")).toBeInTheDocument();
      expect(screen.getByTestId("split-minutes")).toHaveTextContent("tillsammans 80 av 90 min");
      expect(screen.getByRole("button", { name: "Spara utkast" })).toBeDisabled();
      fireEvent.change(screen.getByLabelText("Första delen slutar"), { target: { value: "09:10" } });
      fireEvent.change(screen.getByLabelText("Från"), { target: { value: "10:00" } });
      fireEvent.change(screen.getByLabelText("Till"), { target: { value: "11:20" } });
      expect(await screen.findByText("Varje del ska vara minst 15 minuter.")).toBeInTheDocument();
      expect(screen.getByText("Rätta formuläret för att kontrollera mot schemat.")).toBeInTheDocument();
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(previews()).toHaveLength(1);
    });

    it("saves the first part's end and where the second goes", async () => {
      const user = await openSplit();
      api.post.mockImplementation(async (path: string) => (path === `${CLASS}/preview` ? { verdict: { state: "OK" } } : draft({ kind: "TEMPLATE_SPLIT" })));
      await user.selectOptions(screen.getByLabelText("Veckodag"), "3");
      fireEvent.change(screen.getByLabelText("Från"), { target: { value: "10:00" } });
      fireEvent.change(screen.getByLabelText("Till"), { target: { value: "10:45" } });
      // The split opened whole and was asked about at once; the question about the edited one follows, once.
      await waitFor(() => expect(previews().at(-1)![1]).toEqual({
        kind: "TEMPLATE_SPLIT", masterLessonId: "m-ma", targetDayOfWeek: 3, targetStart: "10:00", targetEnd: "10:45", keepEnd: "09:45",
      }), { timeout: 3000 });
      expect(previews()).toHaveLength(2);
      await user.click(await screen.findByRole("button", { name: "Spara utkast" }));
      await waitFor(() => expect(writes()).toHaveLength(1));
      expect(writes()[0]![1]).toEqual({
        kind: "TEMPLATE_SPLIT", masterLessonId: "m-ma", baseVersion: VERSION, targetDayOfWeek: 3, targetStart: "10:00", targetEnd: "10:45", keepEnd: "09:45",
      });
    });
  });
});

describe("a draft being edited", () => {
  it("is held to the revision that was read, and a change by somebody else is told with the choice of taking theirs or keeping mine", async () => {
    withDrafts([draft({ rev: 2 })]);
    const user = userEvent.setup();
    renderPage();
    await user.click(await lessonButton("Matematik"));
    expect(screen.getAllByText(/^Flytta Matematik/).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Redigera utkastet" }));
    expect(screen.getByRole("heading", { level: 3, name: "Redigera utkast: Flytta lektionen" })).toBeInTheDocument();
    expect(screen.getByLabelText("Nytt datum")).toHaveValue("2026-11-04");
    fireEvent.change(screen.getByLabelText("Från"), { target: { value: "10:30" } });

    // Somebody else saved in the meantime: the draft is at revision 3, with another end.
    const theirs = draft({ rev: 3, targetEnd: "11:30" });
    api.patch.mockImplementationOnce(async () => {
      withDrafts([theirs]);
      throw new ApiError(409, "Utkastet har ändrats", "CLASS_TEACHER_REV");
    });
    await user.click(screen.getByRole("button", { name: "Spara ändringarna" }));
    expect(api.patch.mock.calls[0]).toEqual([
      `${CLASS}/changes/d-1`,
      { rev: 2, targetDate: "2026-11-04", targetStart: "10:30", targetEnd: "11:00", targetRoomId: null, note: "" },
    ]);

    expect(await screen.findByText("Någon annan har ändrat utkastet")).toBeInTheDocument();
    // What was typed is still there.
    expect(screen.getByLabelText("Från")).toHaveValue("10:30");
    const mine = screen.getByRole("button", { name: "Spara mina ändringar ändå" });
    await waitFor(() => expect(mine).toBeEnabled());
    api.patch.mockResolvedValueOnce(draft({ rev: 4 }));
    await user.click(mine);
    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(2));
    // Over their draft, at the revision that is now theirs.
    expect(api.patch.mock.calls[1]![1]).toMatchObject({ rev: 3, targetStart: "10:30" });
  });

  it("can take the other writer's draft in place of what was typed", async () => {
    withDrafts([draft({ rev: 2 })]);
    const user = userEvent.setup();
    renderPage();
    await user.click(await lessonButton("Matematik"));
    await user.click(screen.getByRole("button", { name: "Redigera utkastet" }));
    fireEvent.change(screen.getByLabelText("Från"), { target: { value: "10:30" } });
    api.patch.mockImplementationOnce(async () => {
      withDrafts([draft({ rev: 3, targetStart: "12:00", targetEnd: "13:00" })]);
      throw new ApiError(409, "Utkastet har ändrats", "CLASS_TEACHER_REV");
    });
    await user.click(screen.getByRole("button", { name: "Spara ändringarna" }));
    const theirs = await screen.findByRole("button", { name: "Läs in det nya utkastet" });
    await waitFor(() => expect(theirs).toBeEnabled());
    await user.click(theirs);
    expect(screen.getByLabelText("Från")).toHaveValue("12:00");
    expect(screen.queryByText("Någon annan har ändrat utkastet")).not.toBeInTheDocument();
  });

  it("closes its form without turning into a new draft if the draft is gone when the window is looked at again", async () => {
    withDrafts([draft()]);
    const user = userEvent.setup();
    renderPage();
    await user.click(await lessonButton("Matematik"));
    await user.click(screen.getByRole("button", { name: "Redigera utkastet" }));
    expect(screen.getByRole("heading", { level: 3, name: "Redigera utkast: Flytta lektionen" })).toBeInTheDocument();
    // Somebody threw the draft away; the page learns of it when the window is looked at again.
    serve({});
    const reads = weekReads().length;
    fireEvent(document, new Event("visibilitychange", { bubbles: true }));
    await waitFor(() => expect(weekReads().length).toBeGreaterThan(reads));
    await waitFor(() => expect(screen.queryByRole("heading", { level: 3, name: /^Redigera utkast/ })).not.toBeInTheDocument());
    // The lesson can be changed afresh, and nothing was written.
    expect(await screen.findByRole("button", { name: "Flytta" })).toBeEnabled();
    expect(writes()).toEqual([]);
  });
});

describe("the list of drafts", () => {
  it("says there are none, and how to make one", async () => {
    renderPage();
    expect(await screen.findByRole("heading", { level: 2, name: "Mina utkast" })).toBeInTheDocument();
    expect(screen.getByText(/Inga utkast väntar/)).toBeInTheDocument();
    expect(screen.queryByText("Kontrollerar mot schemat…")).not.toBeInTheDocument();
    // Nothing waits, so the check is not asked.
    expect(api.get.mock.calls.map(([path]) => path)).not.toContain(`${CLASS}/check`);
  });

  const verdicts: Array<[string, Verdict, Array<string | RegExp>]> = [
    ["can be published", { state: "OK" }, ["Kan publiceras"]],
    ["is refused by the frame", { state: "REFUSED", reason: "TIME_CLOSED" }, ["Kan inte publiceras", "Tiden är inte öppen för klasslärarens ändringar."]],
    [
      "is stale",
      { state: "STALE", changed: [{ field: "roomId", was: "r-12", now: "r-14" }, { field: "teacherId", was: "a", now: "b" }] },
      ["Lektionen har ändrats sedan utkastet skrevs", "Det som ändrats: Sal (Sal 12 → Sal 14), Lärare.", /behöver slängas och skrivas igen/],
    ],
    ["has lost its lesson", { state: "GONE" }, ["Lektionen finns inte längre. Släng utkastet."]],
    [
      "clashes",
      { state: "CONFLICT", conflicts: [{ kind: "TEACHER", other: { className: "3B", subjectName: "Svenska", day: 3, start: "10:00", end: "11:00" } }, { kind: "BREAK" }] },
      ["Utkastet krockar i schemat", "Läraren har en annan lektion då: 3B, Svenska, Onsdag 10:00–11:00", "Tiden ligger i en rast eller ett lov"],
    ],
    [
      "breaks the board's rules, which name no lesson",
      { state: "CONFLICT", conflicts: [{ kind: "FRAME" }, { kind: "LUNCH" }, { kind: "GRADE_RULE" }] },
      ["Utkastet krockar i schemat", "Tiden ligger utanför stadiets ramtid", "Tiden ligger på klassens lunch", "Tiden är stängd för klassens årskurs"],
    ],
    [
      "would move a lesson already moved for a date",
      { state: "CONFLICT", conflicts: [{ kind: "EXCEPTION", other: { className: "3B", subjectName: "Matematik", date: "2026-11-10", start: "13:00", end: "14:00" } }] },
      [/Lektionen är redan ändrad för ett datum \(dag, tid eller sal\), och ändringen skulle skriva över det: 3B, Matematik, tis 10 nov\. 13:00–14:00/],
    ],
    [
      "can be published but takes lessons out of the calendar",
      { state: "OK", removes: { lessons: 3, withLog: 0 } },
      ["Kan publiceras, men tar bort lektioner ur kalendern", /3 kommande lektioner tas bort/],
    ],
    [
      "takes a lesson with a log out of the calendar, and says the log goes",
      { state: "OK", removes: { lessons: 1, withLog: 1 } },
      ["Kan publiceras, men tar bort lektioner ur kalendern", /1 kommande lektion tas bort/, /1 av dem har lektionslogg, läxa eller vikarieanteckning, som försvinner med lektionen/],
    ],
    ["can be published when nothing is removed", { state: "OK", removes: { lessons: 0, withLog: 0 } }, ["Kan publiceras"]],
  ];

  it.each(verdicts)("tells a draft that %s", async (_name, verdict, texts) => {
    withDrafts([draft()], verdict);
    renderPage();
    const list = await screen.findByRole("heading", { level: 2, name: "Mina utkast" });
    const section = list.closest("section")!;
    for (const text of texts) expect(await within(section).findByText(text)).toBeInTheDocument();
  });

  it("names no person: a clash is by what clashes, and another writer's draft by 'another'", async () => {
    withDrafts([draft({ authorId: "u-other" })], { state: "CONFLICT", conflicts: [{ kind: "ROOM", other: { className: "3B", subjectName: "Svenska", date: "2026-11-04", start: "10:00", end: "11:00" } }] });
    renderPage();
    expect(await screen.findByText("Skrivet av en annan klasslärare")).toBeInTheDocument();
    expect(await screen.findByText(/Salen är upptagen då: 3B, Svenska/)).toBeInTheDocument();
  });

  it("does not say who wrote the reader's own draft", async () => {
    withDrafts([draft({ authorId: "u-me" })]);
    renderPage();
    await screen.findByText("Kan publiceras");
    expect(screen.queryByText("Skrivet av en annan klasslärare")).not.toBeInTheDocument();
  });

  it("opens a draft in its lesson's form from the list", async () => {
    withDrafts([draft({ note: "Prov" })]);
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Anteckning: Prov");
    await user.click(await screen.findByRole("button", { name: /^Redigera utkastet: Flytta Matematik/ }));
    expect(await screen.findByRole("heading", { level: 3, name: "Redigera utkast: Flytta lektionen" })).toBeInTheDocument();
    expect(screen.getByLabelText("Nytt datum")).toHaveValue("2026-11-04");
  });

  it("brings the week of a draft that is not on screen to the screen", async () => {
    const elsewhere = draft({ calendarLessonId: "o-later", date: "2026-11-10" });
    withDrafts([elsewhere]);
    state.weekAt = (from) =>
      from === "2026-11-10"
        ? week({ weekStart: "2026-11-09", days: ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"], occasions: [occasion({ id: "o-later", date: "2026-11-10", draftId: "d-1" })], drafts: [elsewhere] })
        : week({ drafts: [elsewhere] });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: /^Redigera utkastet:/ }));
    await waitFor(() => expect(weekReads()).toContain(`${CLASS}/week?from=2026-11-10`));
    expect(await screen.findByRole("heading", { level: 3, name: "Redigera utkast: Flytta lektionen" })).toBeInTheDocument();
  });

  it("says when the drafts could not be checked, and that the lesson's klasslärare must be appointed again", async () => {
    withDrafts([draft()]);
    state.checkError = new ApiError(409, "x", "CLASS_TEACHER_APPOINTER_GONE");
    renderPage();
    expect(await screen.findByText("Utkastet kunde inte kontrolleras just nu.")).toBeInTheDocument();
    expect(await screen.findByText("Du behöver utses på nytt")).toBeInTheDocument();
    expect(screen.getByText(/Be en schemaläggare utse dig på nytt/)).toBeInTheDocument();
  });

  describe("throwing a draft away", () => {
    it("is held to the revision that was read", async () => {
      withDrafts([draft({ rev: 2 })]);
      const user = userEvent.setup();
      renderPage();
      await screen.findByText("Kan publiceras");
      api.delete.mockResolvedValue(undefined);
      await user.click(screen.getByRole("button", { name: /^Släng utkastet: Flytta Matematik/ }));
      await waitFor(() => expect(api.delete).toHaveBeenCalledWith(`${CLASS}/changes/d-1?rev=2`));
    });

    it("says a draft that somebody else changed meanwhile is still there", async () => {
      withDrafts([draft({ rev: 2 })]);
      const user = userEvent.setup();
      renderPage();
      await screen.findByText("Kan publiceras");
      api.delete.mockRejectedValue(new ApiError(409, "Utkastet har ändrats", "CLASS_TEACHER_REV"));
      await user.click(screen.getByRole("button", { name: /^Släng utkastet: Flytta Matematik/ }));
      expect(await screen.findByText("Någon annan har ändrat utkastet")).toBeInTheDocument();
      expect(screen.getByText("Utkastet finns kvar. Läs om för att se hur det ser ut nu.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^Släng utkastet: Flytta Matematik/ })).toBeInTheDocument();
    });
  });
});

describe("publication", () => {
  it("is the schemaläggare's when the school has not switched it on: no button, and a sentence that says so", async () => {
    withDrafts([draft()]);
    renderPage();
    await screen.findByText("Kan publiceras");
    expect(screen.queryByRole("button", { name: /Publicera/ })).not.toBeInTheDocument();
    expect(screen.getByText(/förrän en schemaläggare har publicerat dem/)).toBeInTheDocument();
  });

  it("publishes every draft of the class when the school has switched it on, and tells what happened to each", async () => {
    withDrafts([draft(), draft({ id: "d-2", calendarLessonId: "o-other", date: "2026-11-02", kind: "OCCASION_CANCEL", targetDate: null, targetStart: null, targetEnd: null })], { state: "OK" }, { selfPublish: true });
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByText("Kan publiceras");
    api.post.mockImplementation(async (path: string) => {
      if (path === `${CLASS}/publish`) {
        return {
          outcomes: [
            { id: "d-1", outcome: "PUBLISHED" },
            { id: "d-2", outcome: "CONFLICT", conflicts: [{ kind: "ROOM", other: { className: "3B", subjectName: "Svenska", date: "2026-11-02", start: "08:00", end: "09:00" } }] },
          ],
        };
      }
      return { verdict: { state: "OK" } };
    });
    await user.click(screen.getByRole("button", { name: "Publicera utkasten" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(`${CLASS}/publish`, {}));
    const outcomes = (await screen.findByText("Så gick publiceringen")).closest("[role=status]") as HTMLElement;
    expect(within(outcomes).getByText("Publicerad")).toBeInTheDocument();
    expect(within(outcomes).getByText("Publicerades inte: krockar i schemat")).toBeInTheDocument();
    expect(within(outcomes).getByText(/Salen är upptagen då: 3B, Svenska/)).toBeInTheDocument();
    // The week is read again: what was published is not a draft any more.
    expect(weekReads().length).toBeGreaterThan(1);
  });

  it("publishes one draft by its id, and only one that the check calls publishable", async () => {
    withDrafts([draft()], { state: "OK" }, { selfPublish: true });
    const user = userEvent.setup();
    renderPage();
    api.post.mockImplementation(async (path: string) => (path === `${CLASS}/publish` ? { outcomes: [{ id: "d-1", outcome: "PUBLISHED" }] } : { verdict: { state: "OK" } }));
    const one = await screen.findByRole("button", { name: /^Publicera utkastet: Flytta Matematik/ });
    await waitFor(() => expect(one).toBeEnabled());
    await user.click(one);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(`${CLASS}/publish`, { changeIds: ["d-1"] }));
  });

  it("does not offer to publish a draft that clashes", async () => {
    withDrafts([draft()], { state: "CONFLICT", conflicts: [{ kind: "BREAK" }] }, { selfPublish: true });
    renderPage();
    await screen.findByText("Utkastet krockar i schemat");
    expect(screen.getByRole("button", { name: /^Publicera utkastet:/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Publicera utkasten" })).toBeDisabled();
  });

  it("tells a school that has not allowed it, if the setting was changed since the page was read", async () => {
    withDrafts([draft()], { state: "OK" }, { selfPublish: true });
    const user = userEvent.setup();
    renderPage();
    api.post.mockImplementation(async (path: string) => {
      if (path === `${CLASS}/publish`) throw new ApiError(403, "Skolan har inte låtit klasslärare publicera.", "CLASS_TEACHER_PUBLISH_OFF");
      return { verdict: { state: "OK" } };
    });
    const all = await screen.findByRole("button", { name: "Publicera utkasten" });
    await waitFor(() => expect(all).toBeEnabled());
    await user.click(all);
    expect(await screen.findByText("Publiceringen gick inte igenom")).toBeInTheDocument();
    expect(screen.getByText(/Skolan har inte låtit klasslärare publicera/)).toBeInTheDocument();
  });
});

describe("in English", () => {
  it("says the page, a lock and its reason in English", async () => {
    const user = userEvent.setup();
    renderPage("en");
    expect(await screen.findByRole("heading", { level: 1, name: "Class timetable" })).toBeInTheDocument();
    const swedish = await screen.findByRole("button", { name: /^Svenska,/ });
    expect(swedish).toHaveAccessibleName(/Locked, The lesson has a teacher other than you\./);
    await user.click(swedish);
    expect(screen.getByText("The lesson is locked")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Matematik,/ }));
    await user.click(screen.getByRole("button", { name: "Move" }));
    expect(screen.getByRole("heading", { level: 3, name: "Move the lesson" })).toBeInTheDocument();
    expect(screen.getByText("Change the day, time or room to be able to save.")).toBeInTheDocument();
  });
});
