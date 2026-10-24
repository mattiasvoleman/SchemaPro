import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import sv from "@/messages/sv.json";
import { ApiError, api } from "@/lib/api";
import type { LessonLogLesson } from "@/lib/lesson-log";
import { LessonLogPage } from "./lesson-log-page";

/**
 * /teacher/lektion/[lessonId]: what the page offers is the gateway's `may`,
 * what it sends is the cleaned text against the version it read, and a
 * newer version is a notice that reloads, never an overwrite.
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { get: vi.fn(), put: vi.fn() } };
});
const get = api.get as unknown as Mock;
const put = api.put as unknown as Mock;
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const LESSON = "11111111-1111-4111-8111-111111111111";
const EDITED = "2026-10-20T09:15:00.000Z";

function view(overrides: Partial<LessonLogLesson> = {}): LessonLogLesson {
  return {
    lesson: {
      id: LESSON,
      date: "2026-10-20",
      start: "08:00",
      end: "08:45",
      status: "SCHEDULED",
      subject: "Matematik",
      subjectColor: null,
      groups: ["7A"],
      room: "B204",
      teachers: [
        { name: "Anna Lind", role: "LEAD" },
        { name: "Bo Berg", role: "SUBSTITUTE" },
      ],
    },
    role: "REGULAR",
    may: { writeLog: true, readNote: true, writeNote: true },
    log: { topic: "Bråk", homework: "Uppgift 4.1", writtenBy: "Anna Lind", updatedAt: EDITED },
    note: { body: "Planeringen ligger i lärplattformen.", writtenBy: "Anna Lind", updatedAt: EDITED },
    ...overrides,
  };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm">
        <LessonLogPage lessonId={LESSON} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("the lesson page", () => {
  it("gives the lesson's own teacher both forms, filled, and the register beside them", async () => {
    get.mockResolvedValue(view());
    renderPage();
    expect(await screen.findByRole("heading", { level: 1, name: "Matematik" })).toBeInTheDocument();
    expect(screen.getByText(/08:00–08:45 · 7A · B204/)).toBeInTheDocument();
    expect(screen.getByText("Lärare: Anna Lind, Bo Berg (vikarie)")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /^Ämne/ })).toHaveValue("Bråk");
    expect(screen.getByRole("textbox", { name: /^Läxa/ })).toHaveValue("Uppgift 4.1");
    expect(screen.getByRole("textbox", { name: /^Notis/ })).toHaveValue("Planeringen ligger i lärplattformen.");
    expect(screen.getByRole("link", { name: "Ta närvaro" })).toHaveAttribute("href", expect.stringContaining(`/teacher/attendance/${LESSON}`));
    // Saved as it stands: nothing to save.
    expect(screen.getByRole("button", { name: "Spara ämne och läxa" })).toBeDisabled();
    expect(get).toHaveBeenCalledWith(`/api/v1/lesson-logs/lessons/${LESSON}`);
  });

  it("sends the trimmed log, the topic on one line, against the version it read", async () => {
    get.mockResolvedValue(view());
    put.mockResolvedValue({ log: { topic: "Bråk och procent", homework: "Uppgift 4.1–4.3", writtenBy: "Anna Lind", updatedAt: "2026-10-20T10:00:00.000Z" } });
    const user = userEvent.setup();
    renderPage();
    const topic = await screen.findByRole("textbox", { name: /^Ämne/ });
    await user.clear(topic);
    await user.type(topic, "  Bråk och procent ");
    const homework = screen.getByRole("textbox", { name: /^Läxa/ });
    await user.clear(homework);
    await user.type(homework, "Uppgift 4.1–4.3\n");
    await user.click(screen.getByRole("button", { name: "Spara ämne och läxa" }));
    expect(put).toHaveBeenCalledWith(`/api/v1/lesson-logs/lessons/${LESSON}`, {
      topic: "Bråk och procent",
      homework: "Uppgift 4.1–4.3",
      basis: EDITED,
    });
    expect(toast.success).toHaveBeenCalledWith("Ämne och läxa sparade");
  });

  it("removes the log when both fields are emptied, and says so on the button", async () => {
    get.mockResolvedValue(view());
    put.mockResolvedValue({ log: null });
    const user = userEvent.setup();
    renderPage();
    await user.clear(await screen.findByRole("textbox", { name: /^Ämne/ }));
    await user.clear(screen.getByRole("textbox", { name: /^Läxa/ }));
    await user.click(screen.getByRole("button", { name: "Ta bort ämne och läxa" }));
    expect(put).toHaveBeenCalledWith(`/api/v1/lesson-logs/lessons/${LESSON}`, { topic: null, homework: null, basis: EDITED });
    expect(toast.success).toHaveBeenCalledWith("Ämne och läxa borttagna");
  });

  it("refuses to send a topic past 200 characters and says why", async () => {
    get.mockResolvedValue(view({ log: null }));
    const user = userEvent.setup();
    renderPage();
    const topic = await screen.findByRole("textbox", { name: /^Ämne/ });
    await user.click(topic);
    await user.paste("x".repeat(201));
    expect(topic).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Högst 200 tecken.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Spara ämne och läxa" })).toBeDisabled();
  });

  it("meets a newer version with a notice that reloads, and overwrites nothing", async () => {
    get.mockResolvedValue(view());
    put.mockRejectedValue(new ApiError(409, "…", "LESSON_LOG_STALE"));
    const user = userEvent.setup();
    renderPage();
    await user.type(await screen.findByRole("textbox", { name: /^Ämne/ }), " igen");
    await user.click(screen.getByRole("button", { name: "Spara ämne och läxa" }));
    const notice = await screen.findByText("Någon annan har ändrat ämne och läxa sedan du öppnade sidan");
    expect(toast.error).not.toHaveBeenCalled();
    get.mockResolvedValue(view({ log: { topic: "Ny version", homework: null, writtenBy: "Bo Berg", updatedAt: "2026-10-20T11:00:00.000Z" } }));
    await user.click(within(notice.closest("[role=status]") as HTMLElement).getByRole("button", { name: "Läs in igen" }));
    expect(await screen.findByDisplayValue("Ny version")).toBeInTheDocument();
  });

  it("shows the substitute the note to read, not to answer, and the log to write", async () => {
    get.mockResolvedValue(view({ role: "SUBSTITUTE", may: { writeLog: true, readNote: true, writeNote: false } }));
    renderPage();
    expect(await screen.findByText("Du är vikarie")).toBeInTheDocument();
    const note = screen.getByRole("region", { name: "Notis till vikarien" });
    expect(within(note).getByText("Planeringen ligger i lärplattformen.")).toBeInTheDocument();
    expect(within(note).getByText("Lektionens lärare har lämnat notisen till dig som vikarierar.")).toBeInTheDocument();
    expect(within(note).queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /^Ämne/ })).toBeInTheDocument();
  });

  it("shows another teacher the log to read, no note card and no register", async () => {
    get.mockResolvedValue(view({ role: "COLLEAGUE", may: { writeLog: false, readNote: false, writeNote: false }, note: null }));
    renderPage();
    const log = await screen.findByRole("region", { name: "Ämne och läxa" });
    expect(within(log).getByText("Bråk")).toBeInTheDocument();
    // On the reader's own clock, as every "Skrivet" line is.
    expect(within(log).getByText(/^Skrivet av Anna Lind, 20 okt/)).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Notis till vikarien" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Ta närvaro" })).not.toBeInTheDocument();
  });

  it("says a lesson the teacher may not open cannot be shown, and a failed read that it failed", async () => {
    get.mockRejectedValue(new ApiError(404, "Lektionen finns inte.", "LESSON_NOT_FOUND"));
    const { unmount } = renderPage();
    expect(await screen.findByText("Lektionen går inte att visa")).toBeInTheDocument();
    unmount();
    get.mockRejectedValue(new Error("network"));
    renderPage();
    expect(await screen.findByText("Lektionen gick inte att hämta")).toBeInTheDocument();
  });
});
