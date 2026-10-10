import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationBell } from "./notification-bell";

// Environment shims for Radix in jsdom — not behaviour under test.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};
globalThis.ResizeObserver ??= class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// ---------------------------------------------------------------------------
// Supabase mock. The bell issues two shapes against "Notifications":
//   read  — .select(...).order(...).limit(...)   → awaited
//   write — .update({...}).is("readAt", null)    → awaited
// Each gets its own result queue (chosen by whether .update was called) and
// every chained call is recorded so the query/update contracts can be pinned.
// ---------------------------------------------------------------------------

const supabaseState = vi.hoisted(() => {
  interface TableResult {
    data: unknown;
    error: { message: string } | null;
  }
  return {
    selectResults: [] as TableResult[],
    updateResults: [] as TableResult[],
    calls: [] as Array<{ method: string; args: unknown[] }>,
  };
});

vi.mock("@/utils/supabase/client", () => ({
  createClient: () => ({
    from: (table: string) => {
      supabaseState.calls.push({ method: "from", args: [table] });
      let mode: "select" | "update" = "select";
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "order", "limit", "update", "is"]) {
        builder[method] = (...args: unknown[]) => {
          supabaseState.calls.push({ method, args });
          if (method === "update") mode = "update";
          return builder;
        };
      }
      (builder as { then?: unknown }).then = (
        onFulfilled: (value: unknown) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => {
        const queue =
          mode === "update" ? supabaseState.updateResults : supabaseState.selectResults;
        const result = queue.length > 0 ? queue.shift()! : { data: [], error: null };
        return Promise.resolve(result).then(onFulfilled, onRejected);
      };
      return builder;
    },
  }),
}));

// next-intl's Link needs the intl provider; an anchor is what it renders.
vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, className, children }: { href: string; className?: string; children: React.ReactNode }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

// Key echo that also surfaces interpolated values, so each notification type's
// message key AND its meta extraction can be asserted from the rendered text.
vi.mock("next-intl", () => ({
  // DateField reads the active locale for its month and weekday names.
  useLocale: () => "sv",
  useTranslations:
    () => (key: string, values?: Record<string, unknown>) =>
      values
        ? `${key}(${Object.entries(values)
            .map(([name, value]) => `${name}=${String(value)}`)
            .join("|")})`
        : key,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface BellRow {
  id: string;
  type: string;
  meta: Record<string, unknown> | null;
  readAt: string | null;
  createdAt: string;
}

let seq = 0;
const notif = (overrides: Partial<BellRow> = {}): BellRow => {
  seq += 1;
  return {
    id: `n-${seq}`,
    type: "SCHEDULE_CHANGED",
    meta: { subjectName: "Biology" },
    readAt: null,
    createdAt: "2026-08-07T13:05:00.000Z",
    ...overrides,
  };
};

const ok = (rows: unknown) => ({ data: rows, error: null });
const dbError = (message: string) => ({ data: null, error: { message } });

const argsFor = (method: string) =>
  supabaseState.calls
    .filter((entry) => entry.method === method)
    .map((entry) => entry.args);

function renderBell() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
  const view = render(
    <QueryClientProvider client={queryClient}>
      <NotificationBell />
    </QueryClientProvider>,
  );
  return { view, queryClient, invalidateSpy };
}

// While the dropdown is open, Radix aria-hides everything outside the portal
// (including the trigger), so hidden: true keeps the bell reachable in both
// states.
const bellButton = () =>
  screen.getByRole("button", { name: "title", hidden: true });

beforeEach(() => {
  seq = 0;
  supabaseState.selectResults.length = 0;
  supabaseState.updateResults.length = 0;
  supabaseState.calls.length = 0;
});

// ---------------------------------------------------------------------------
// Fetching + badge
// ---------------------------------------------------------------------------

describe("NotificationBell badge", () => {
  it("fetches the newest 20 rows and shows no badge when everything is read", async () => {
    supabaseState.selectResults.push(
      ok([notif({ readAt: "2026-08-07T14:00:00.000Z" })]),
    );
    renderBell();

    await waitFor(() => expect(argsFor("select")).toHaveLength(1));
    expect(argsFor("from")).toEqual([["Notifications"]]);
    expect(argsFor("select")).toEqual([["id, type, meta, readAt, createdAt"]]);
    expect(argsFor("order")).toEqual([["createdAt", { ascending: false }]]);
    expect(argsFor("limit")).toEqual([[20]]);

    expect(within(bellButton()).queryByText(/^\d+\+?$/)).not.toBeInTheDocument();
  });

  it("counts only unread rows on the badge", async () => {
    supabaseState.selectResults.push(
      ok([
        notif(),
        notif(),
        notif(),
        notif({ readAt: "2026-08-07T14:00:00.000Z" }),
        notif({ readAt: "2026-08-07T15:00:00.000Z" }),
      ]),
    );
    renderBell();

    await waitFor(() =>
      expect(within(bellButton()).getByText("3")).toBeInTheDocument(),
    );
  });

  it("caps the badge at 9+ past nine unread", async () => {
    supabaseState.selectResults.push(
      ok(Array.from({ length: 12 }, () => notif())),
    );
    renderBell();

    await waitFor(() =>
      expect(within(bellButton()).getByText("9+")).toBeInTheDocument(),
    );
  });

  it("shows no badge and the empty state when the query fails", async () => {
    const user = userEvent.setup();
    supabaseState.selectResults.push(dbError("permission denied"));
    renderBell();

    await waitFor(() => expect(argsFor("select")).toHaveLength(1));
    expect(within(bellButton()).queryByText(/^\d+\+?$/)).not.toBeInTheDocument();

    await user.click(bellButton());
    expect(screen.getByText("empty")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Inbox contents
// ---------------------------------------------------------------------------

describe("NotificationBell inbox", () => {
  it("links to the page where each person chooses what leaves SchemaPro", async () => {
    const user = userEvent.setup();
    supabaseState.selectResults.push(ok([]));
    renderBell();
    await user.click(bellButton());
    const link = await screen.findByRole("link", { name: "settingsLink" });
    expect(link).toHaveAttribute("href", "/notifications");
  });


  it("shows the empty message and no mark-all button when there is nothing", async () => {
    const user = userEvent.setup();
    supabaseState.selectResults.push(ok([]));
    renderBell();

    await waitFor(() => expect(argsFor("select")).toHaveLength(1));
    await user.click(bellButton());

    expect(screen.getByText("empty")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "markAllRead" }),
    ).not.toBeInTheDocument();
  });

  it("renders each notification type through its message key with meta values", async () => {
    const user = userEvent.setup();
    const startsAt = "2026-08-10T08:00:00.000Z";
    const when = new Date(startsAt).toLocaleString();
    supabaseState.selectResults.push(
      ok([
        notif({
          type: "ABSENCE_UNREPORTED",
          meta: { studentName: "Alma Berg", subjectName: "Biology", date: "2026-08-10" },
        }),
        notif({
          type: "LEAVE_DECIDED",
          meta: {
            status: "APPROVED",
            studentName: "Alma Berg",
            startDate: "2026-09-01",
            endDate: "2026-09-02",
          },
        }),
        notif({
          type: "LEAVE_DECIDED",
          meta: {
            status: "REJECTED",
            studentName: "Alma Berg",
            startDate: "2026-09-03",
            endDate: "2026-09-04",
          },
        }),
        notif({ type: "LESSON_CANCELLED", meta: { subjectName: "Maths", startsAt } }),
        notif({ type: "LESSON_SUBSTITUTE", meta: { subjectName: "Maths", startsAt } }),
        notif({ type: "LESSON_ROOM_CHANGED", meta: { subjectName: "Maths", startsAt } }),
        notif({
          type: "ROOM_BOOKING_DECIDED",
          meta: { status: "REJECTED", roomName: "Aula", startsAt },
        }),
      ]),
    );
    renderBell();

    await waitFor(() => expect(argsFor("select")).toHaveLength(1));
    await user.click(bellButton());

    expect(
      screen.getByText(
        "absenceUnreported(student=Alma Berg|subject=Biology|date=2026-08-10)",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("leaveApproved(student=Alma Berg|from=2026-09-01|to=2026-09-02)"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("leaveRejected(student=Alma Berg|from=2026-09-03|to=2026-09-04)"),
    ).toBeInTheDocument();
    expect(screen.getByText(`lessonCancelled(subject=Maths|when=${when})`)).toBeInTheDocument();
    expect(screen.getByText(`lessonSubstitute(subject=Maths|when=${when})`)).toBeInTheDocument();
    expect(
      screen.getByText(`lessonRoomChanged(subject=Maths|when=${when})`),
    ).toBeInTheDocument();
    expect(
      screen.getByText(`roomBookingRejected(room=Aula|when=${when})`),
    ).toBeInTheDocument();
  });

  it("tells a substitute their own cover and its withdrawal, and an admin a self-report, with no reason", async () => {
    const user = userEvent.setup();
    const startsAt = "2026-10-14T06:00:00.000Z";
    const endsAt = "2026-10-15T22:00:00.000Z";
    const when = new Date(startsAt).toLocaleString();
    // The reader's local midnights, as the school's are for a reader in the school.
    const dayStart = new Date(2026, 9, 12).toISOString();
    const dayEnd = new Date(2026, 9, 13).toISOString();
    supabaseState.selectResults.push(
      ok([
        notif({
          type: "LESSON_SUBSTITUTE",
          meta: { subjectName: "Matematik", startsAt, cover: true, groupName: "7A", roomName: "Sal 12" },
        }),
        notif({
          type: "LESSON_COVER_WITHDRAWN",
          meta: { subjectName: "Engelska", startsAt, groupName: "8B", roomName: "—" },
        }),
        notif({
          type: "TEACHER_ABSENCE_REPORTED",
          meta: { absenceId: "a-1", userId: "t-1", teacherName: "Karin Ek", startsAt, endsAt, wholeDays: false },
        }),
        // "Sjuk i dag": one whole day, midnight to midnight, is that one day.
        notif({
          type: "TEACHER_ABSENCE_REPORTED",
          meta: { absenceId: "a-2", userId: "t-2", teacherName: "Bo Ek", startsAt: dayStart, endsAt: dayEnd, wholeDays: true },
        }),
      ]),
    );
    renderBell();

    await waitFor(() => expect(argsFor("select")).toHaveLength(1));
    await user.click(bellButton());

    expect(
      screen.getByText(`lessonSubstituteCover(subject=Matematik|when=${when}|group=7A|room=Sal 12)`),
    ).toBeInTheDocument();
    expect(
      screen.getByText(`lessonCoverWithdrawn(subject=Engelska|when=${when}|group=8B|room=—)`),
    ).toBeInTheDocument();
    expect(
      screen.getByText(`teacherAbsenceReported(teacher=Karin Ek|period=${when} – ${new Date(endsAt).toLocaleString()})`),
    ).toBeInTheDocument();
    expect(
      screen.getByText(`teacherAbsenceReported(teacher=Bo Ek|period=${new Date(dayStart).toLocaleDateString()})`),
    ).toBeInTheDocument();
  });

  it("renders a null meta as empty interpolation values and shows the created time", async () => {
    const user = userEvent.setup();
    const createdAt = "2026-08-06T09:30:00.000Z";
    supabaseState.selectResults.push(
      ok([notif({ type: "SCHEDULE_CHANGED", meta: null, createdAt })]),
    );
    renderBell();

    await waitFor(() => expect(argsFor("select")).toHaveLength(1));
    await user.click(bellButton());

    expect(screen.getByText("scheduleChanged(subject=)")).toBeInTheDocument();
    // The timestamp line renders createdAt through the same locale formatter.
    expect(screen.getByText(new Date(createdAt).toLocaleString())).toBeInTheDocument();
  });

  it("highlights unread rows and not read ones", async () => {
    const user = userEvent.setup();
    supabaseState.selectResults.push(
      ok([
        notif({ meta: { subjectName: "Unread" } }),
        notif({ meta: { subjectName: "Read" }, readAt: "2026-08-07T14:00:00.000Z" }),
      ]),
    );
    renderBell();

    await waitFor(() => expect(argsFor("select")).toHaveLength(1));
    await user.click(bellButton());

    // Read state has no accessible handle (purely visual tint), so the row
    // container's class is the only observable signal.
    const unreadRow = screen.getByText("scheduleChanged(subject=Unread)").parentElement!;
    const readRow = screen.getByText("scheduleChanged(subject=Read)").parentElement!;
    expect(unreadRow).toHaveClass("bg-accent/40");
    expect(readRow).not.toHaveClass("bg-accent/40");
  });
});

// ---------------------------------------------------------------------------
// Mark all read
// ---------------------------------------------------------------------------

describe("NotificationBell mark all read", () => {
  it("updates only unread rows, invalidates, and the badge disappears on refetch", async () => {
    const user = userEvent.setup();
    const rows = [notif(), notif()];
    supabaseState.selectResults.push(
      ok(rows),
      ok(rows.map((row) => ({ ...row, readAt: "2026-08-08T10:00:00.000Z" }))),
    );
    supabaseState.updateResults.push(ok(null));
    const { invalidateSpy } = renderBell();

    await waitFor(() =>
      expect(within(bellButton()).getByText("2")).toBeInTheDocument(),
    );
    await user.click(bellButton());
    await user.click(screen.getByRole("button", { name: "markAllRead" }));

    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["notifications"] }),
    );
    // The write stamps now() onto readAt and filters to unread rows only.
    expect(argsFor("update")).toEqual([
      [
        {
          readAt: expect.stringMatching(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
          ),
        },
      ],
    ]);
    expect(argsFor("is")).toEqual([["readAt", null]]);

    await waitFor(() => {
      expect(within(bellButton()).queryByText("2")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "markAllRead" }),
      ).not.toBeInTheDocument();
    });
    expect(argsFor("select")).toHaveLength(2);
  });

  it("keeps the badge and does not refetch when the update fails", async () => {
    const user = userEvent.setup();
    supabaseState.selectResults.push(ok([notif()]));
    supabaseState.updateResults.push(dbError("permission denied"));
    const { invalidateSpy } = renderBell();

    await waitFor(() =>
      expect(within(bellButton()).getByText("1")).toBeInTheDocument(),
    );
    await user.click(bellButton());
    await user.click(screen.getByRole("button", { name: "markAllRead" }));

    await waitFor(() => expect(argsFor("update")).toHaveLength(1));
    // Let the rejected mutation settle before asserting nothing was refreshed.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(argsFor("select")).toHaveLength(1);
    expect(within(bellButton()).getByText("1")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

describe("NotificationBell polling", () => {
  it("refetches every 60 seconds and updates the badge", async () => {
    vi.useFakeTimers();
    try {
      supabaseState.selectResults.push(ok([notif()]));
      renderBell();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(argsFor("select")).toHaveLength(1);
      expect(within(bellButton()).getByText("1")).toBeInTheDocument();

      supabaseState.selectResults.push(ok([notif(), notif()]));
      // Overshoot the interval by 1ms: react-query notifies observers via a
      // 0-delay timeout scheduled exactly at the 60s mark, which sinon's fake
      // clock only fires once the clock moves past it.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_001);
      });
      expect(argsFor("select")).toHaveLength(2);
      expect(within(bellButton()).getByText("2")).toBeInTheDocument();

      // Nothing in between: the next poll is a full minute away.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(argsFor("select")).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
