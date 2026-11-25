// Tests for the realtime collaboration hook. The socket layer is fully faked:
// `socket.io-client` is mocked per test (the hook imports it dynamically, so
// `vi.doMock` after `vi.resetModules` is enough), and the Supabase client is
// mocked at the module boundary. No test touches the network.
//
// `API_BASE_URL` is captured at module-evaluation time, so every test stubs
// the env var and re-imports the hook through a fresh module registry.

import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TimetablePeer } from "./use-timetable-realtime";

interface SessionPayload {
  data: { session: { access_token: string } | null };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Drains microtasks plus one macrotask so pending awaits inside the hook settle. */
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

type Handler = (payload?: unknown) => void;

function makeFakeSocket() {
  const handlers = new Map<string, Handler>();
  return {
    on: vi.fn((event: string, cb: Handler) => {
      handlers.set(event, cb);
    }),
    emit: vi.fn(),
    disconnect: vi.fn(),
    /** Simulates the server pushing an event to the client. */
    fire(event: string, payload?: unknown) {
      const handler = handlers.get(event);
      if (!handler) throw new Error(`no handler registered for "${event}"`);
      handler(payload);
    },
  };
}

interface SetupOptions {
  /** `undefined` leaves NEXT_PUBLIC_API_BASE_URL unset. */
  apiUrl?: string | undefined;
  /** Session token; `null` means "no session". */
  token?: string | null;
  /** Overrides getSession's return entirely (for in-flight control). */
  session?: Promise<SessionPayload>;
  /** Holds the socket.io-client dynamic import open until resolved. */
  gateImport?: Promise<void>;
  /** What a read of lessons by id answers: the rows, or an error. Absent, a read is a test's mistake. */
  read?: (ids: string[]) => ReadAnswer | Promise<ReadAnswer>;
}

type ReadAnswer = { data: unknown; error: { message: string } | null };

async function setup(options: SetupOptions = {}) {
  const { token = "tok-1", session, gateImport, read } = options;
  const apiUrl = "apiUrl" in options ? options.apiUrl : "https://api.test";

  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", apiUrl);

  const socket = makeFakeSocket();
  const io = vi.fn(() => socket);
  // Called the moment the dynamic import's module factory starts evaluating —
  // the observable proof that the hook is parked on `await import(...)`.
  const importStarted = vi.fn();
  vi.doMock("socket.io-client", async () => {
    importStarted();
    if (gateImport) await gateImport;
    return { io };
  });

  const getSession = session
    ? vi.fn(() => session)
    : vi.fn(
        async (): Promise<SessionPayload> => ({
          data: { session: token === null ? null : { access_token: token } },
        }),
      );
  const reads: string[][] = [];
  const from = vi.fn(() => ({
    select: () => ({
      in: (_column: string, ids: string[]) => {
        reads.push(ids);
        if (!read) throw new Error("a read of lessons nobody asked for");
        return Promise.resolve(read(ids));
      },
    }),
  }));
  vi.doMock("@/utils/supabase/client", () => ({
    createClient: () => ({ auth: { getSession }, from }),
  }));

  const { useTimetableRealtime } = await import("./use-timetable-realtime");

  const queryClient = new QueryClient();
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const view = renderHook(() => useTimetableRealtime(), { wrapper });

  return { view, io, socket, importStarted, getSession, invalidate, queryClient, reads, from };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("useTimetableRealtime", () => {
  it("connects with the Supabase access token and announces presence", async () => {
    const { io, socket } = await setup();

    await waitFor(() => expect(io).toHaveBeenCalledTimes(1));
    expect(io).toHaveBeenCalledWith("https://api.test", {
      transports: ["websocket"],
      auth: { token: "tok-1" },
    });
    expect(socket.emit).toHaveBeenCalledWith("timetable:presence", {
      editingLessonId: null,
    });
  });

  it("names the page's school in the handshake, for a session with more than one (Flera skolor)", async () => {
    const meta = document.createElement("meta");
    meta.name = "rastra-school";
    meta.content = "33333333-3333-4333-8333-333333333333";
    document.head.append(meta);
    try {
      const { io } = await setup();
      await waitFor(() => expect(io).toHaveBeenCalledTimes(1));
      expect(io).toHaveBeenCalledWith("https://api.test", {
        transports: ["websocket"],
        auth: { token: "tok-1", school: "33333333-3333-4333-8333-333333333333" },
      });
    } finally {
      meta.remove();
    }
  });

  it("does nothing when NEXT_PUBLIC_API_BASE_URL is unset", async () => {
    const { io, getSession, view } = await setup({ apiUrl: undefined });

    await flush();
    expect(getSession).not.toHaveBeenCalled();
    expect(io).not.toHaveBeenCalled();
    expect(view.result.current.peers).toEqual([]);
  });

  it("does not connect when there is no session", async () => {
    const { io, importStarted } = await setup({ token: null });

    await flush();
    // Bails before even loading the socket.io-client chunk.
    expect(importStarted).not.toHaveBeenCalled();
    expect(io).not.toHaveBeenCalled();
  });

  it("does not connect when unmounted while getSession is in flight", async () => {
    const session = deferred<SessionPayload>();
    const { view, io, importStarted, getSession } = await setup({
      session: session.promise,
    });

    expect(getSession).toHaveBeenCalledTimes(1);
    view.unmount();
    session.resolve({ data: { session: { access_token: "tok-late" } } });
    await flush();

    expect(importStarted).not.toHaveBeenCalled();
    expect(io).not.toHaveBeenCalled();
  });

  it("does not connect when unmounted while the socket.io-client import is in flight", async () => {
    // The critical race: the dynamic import is a second await point after the
    // token fetch. If the component unmounts while the chunk is loading, the
    // post-import `if (cancelled) return` is the only thing standing between
    // us and a leaked socket that no cleanup will ever disconnect.
    const gate = deferred<void>();
    const { view, io, socket, importStarted } = await setup({
      gateImport: gate.promise,
    });

    // The hook has passed the token check and is parked on `await import(...)`.
    await waitFor(() => expect(importStarted).toHaveBeenCalledTimes(1));
    expect(io).not.toHaveBeenCalled();

    view.unmount();
    gate.resolve();
    await flush();

    // The import completed after unmount — no socket may be opened.
    expect(io).not.toHaveBeenCalled();
    expect(socket.emit).not.toHaveBeenCalled();
  });

  it("updates the peers roster from timetable_presence events", async () => {
    const { view, socket } = await setup();
    await waitFor(() =>
      expect(socket.on).toHaveBeenCalledWith(
        "timetable_presence",
        expect.any(Function),
      ),
    );

    expect(view.result.current.peers).toEqual([]);

    const roster: TimetablePeer[] = [
      { userId: "u1", label: "Anna B.", editingLessonId: "lesson-3" },
      { userId: "u2", label: "Carl D.", editingLessonId: null },
    ];
    act(() => socket.fire("timetable_presence", { peers: roster }));
    expect(view.result.current.peers).toEqual(roster);

    // A payload without `peers` clears the roster rather than crashing.
    act(() => socket.fire("timetable_presence", {}));
    expect(view.result.current.peers).toEqual([]);
  });

  it("invalidates the timetable query caches when a collaborator edits", async () => {
    const { socket, invalidate } = await setup();
    await waitFor(() =>
      expect(socket.on).toHaveBeenCalledWith(
        "master_timetable_updated",
        expect.any(Function),
      ),
    );

    act(() => socket.fire("master_timetable_updated"));

    expect(invalidate).toHaveBeenCalledTimes(4);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["masterLessons"] });
    // The meal is replaced in the same transaction as the lessons. Refreshing
    // one and not the other showed a regenerated week with last run's lunch —
    // reported as "rasterna syns men inte luncherna", since rasts are derived
    // in the client and never wait on a fetch.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["lunch-sittings"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["calendarLessons"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["scheduleVersions"] });
  });

  it("setEditing announces the focused lesson over the socket", async () => {
    const { view, io, socket } = await setup();
    await waitFor(() => expect(io).toHaveBeenCalledTimes(1));
    socket.emit.mockClear();

    act(() => view.result.current.setEditing("lesson-42"));
    expect(socket.emit).toHaveBeenCalledWith("timetable:presence", {
      editingLessonId: "lesson-42",
    });

    act(() => view.result.current.setEditing(null));
    expect(socket.emit).toHaveBeenCalledWith("timetable:presence", {
      editingLessonId: null,
    });
  });

  it("setEditing is a safe no-op before any socket exists", async () => {
    const { view, socket } = await setup({ token: null });
    await flush();

    expect(() => view.result.current.setEditing("lesson-1")).not.toThrow();
    expect(socket.emit).not.toHaveBeenCalled();
  });

  it("disconnects on unmount and stops emitting afterwards", async () => {
    const { view, io, socket } = await setup();
    await waitFor(() => expect(io).toHaveBeenCalledTimes(1));

    const { setEditing } = view.result.current;
    view.unmount();
    expect(socket.disconnect).toHaveBeenCalledTimes(1);

    // The ref is cleared on cleanup, so a stale setEditing cannot reach the
    // disconnected socket.
    socket.emit.mockClear();
    setEditing("lesson-7");
    expect(socket.emit).not.toHaveBeenCalled();
  });
});

describe("a collaborator's change of a few lessons", () => {
  const YEAR = ["masterLessons", "year-1"];
  const lesson = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    academicYearId: "year-1",
    subjectId: "sv",
    studentGroupId: "7a",
    teacherId: "anna",
    coTeacherId: null,
    roomId: "r1",
    dayOfWeek: 1,
    startTime: "08:00:00",
    endTime: "09:00:00",
    isLocked: false,
    isParked: false,
    fromPlacement: false,
    recurrence: "ALL_WEEKS",
    startDate: null,
    endDate: null,
    extraGroupIds: [],
    studentIds: [],
    ...overrides,
  });
  /** A row as the read gives it: the groups and the pupils as nested rows. */
  const row = (id: string, overrides: Record<string, unknown> = {}) => {
    const { extraGroupIds: _g, studentIds: _s, ...rest } = lesson(id, overrides) as Record<string, unknown> & {
      extraGroupIds: string[];
      studentIds: string[];
    };
    return { ...rest, extraGroups: [{ studentGroupId: "7b" }], participants: [{ studentId: "pupil-1" }] };
  };
  const held = (queryClient: QueryClient) => queryClient.getQueryData<Array<{ id: string; dayOfWeek: number }>>(YEAR)!;
  /**
   * The event is fired, and the page has answered it when `until` holds. A fixed number of turns is not enough: the page loads
   * the cache module with a dynamic import, which takes as long as the machine takes, and a test that asserts after two turns
   * asserts before it on a loaded one.
   */
  const heard = async (socket: ReturnType<typeof makeFakeSocket>, payload: unknown, until?: () => void) => {
    await waitFor(() => expect(socket.on).toHaveBeenCalledWith("master_timetable_updated", expect.any(Function)));
    act(() => socket.fire("master_timetable_updated", payload));
    if (until) await waitFor(until);
    await flush();
  };

  it("reads just those lessons and lays them in the year's list, and does not read the year", async () => {
    const { socket, invalidate, queryClient, reads } = await setup({
      read: (ids) => ({ data: ids.map((id) => row(id, { dayOfWeek: 3 })), error: null }),
    });
    queryClient.setQueryData(YEAR, [lesson("a"), lesson("b"), lesson("c")]);
    const others = held(queryClient).slice(1);

    await heard(socket, { changedAt: "2026-11-25T10:00:00.000Z", lessonIds: ["a"] }, () =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["calendarLessons"] }),
    );

    expect(reads).toEqual([["a"]]);
    expect(held(queryClient).map((l) => [l.id, l.dayOfWeek])).toEqual([["a", 3], ["b", 1], ["c", 1]]);
    // The row is as the list holds a row: the groups and the pupils as ids.
    expect(held(queryClient)[0]).toMatchObject({ extraGroupIds: ["7b"], studentIds: ["pupil-1"] });
    // The lessons nobody touched are the objects they were, which is what keeps their cards.
    expect(held(queryClient).slice(1)).toEqual(others);
    expect(held(queryClient)[1]).toBe(others[0]);
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["masterLessons"] });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["lunch-sittings"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["calendarLessons"] });
  });

  it("adds a lesson somebody made, and takes out one somebody removed", async () => {
    const { socket, queryClient } = await setup({
      read: (ids) => ({ data: ids.filter((id) => id === "new").map((id) => row(id)), error: null }),
    });
    queryClient.setQueryData(YEAR, [lesson("a"), lesson("gone")]);

    await heard(socket, { lessonIds: ["new", "gone"] }, () =>
      expect(held(queryClient).map((l) => l.id).sort()).toEqual(["a", "new"]),
    );

    expect(held(queryClient).map((l) => l.id).sort()).toEqual(["a", "new"]);
  });

  it("reads the year, as before, when the event names no lessons (a regeneration, an older gateway)", async () => {
    const { socket, invalidate, reads, queryClient } = await setup();
    queryClient.setQueryData(YEAR, [lesson("a")]);

    await heard(socket, { changedAt: "2026-11-25T10:00:00.000Z" });
    expect(reads).toEqual([]);
    expect(invalidate).toHaveBeenCalledTimes(4);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["masterLessons"] });
  });

  it("reads the year when it names more lessons than are read one by one, or something that is not ids", async () => {
    const { socket, invalidate, reads, queryClient } = await setup();
    queryClient.setQueryData(YEAR, [lesson("a")]);

    await heard(socket, { lessonIds: Array.from({ length: 51 }, (_, index) => `l${index}`) });
    await heard(socket, { lessonIds: [] });
    await heard(socket, { lessonIds: [1, 2] });
    expect(reads).toEqual([]);
    expect(invalidate.mock.calls.filter(([filter]) => filter?.queryKey?.[0] === "masterLessons")).toHaveLength(3);
  });

  it("marks the maps kept beside the year's list as read before the change (the candidates' map of who owns each lesson), and leaves the list as it was laid", async () => {
    const ORIGIN = ["masterLessons", "year-1", "origin"];
    const { socket, queryClient } = await setup({ read: (ids) => ({ data: ids.map((id) => row(id, { dayOfWeek: 3 })), error: null }) });
    queryClient.setQueryData(YEAR, [lesson("a")]);
    queryClient.setQueryData(ORIGIN, [{ ...lesson("a"), isGenerated: true }]);

    await heard(socket, { lessonIds: ["a"] });
    await waitFor(() => expect(queryClient.getQueryState(ORIGIN)?.isInvalidated).toBe(true));

    expect(queryClient.getQueryState(YEAR)?.isInvalidated).toBe(false);
    expect(held(queryClient)[0]!.dayOfWeek).toBe(3);
  });

  it("reads the year when there is no list to lay the lessons in", async () => {
    const { socket, invalidate, reads } = await setup();
    await heard(socket, { lessonIds: ["a"] }, () => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["masterLessons"] }));
    expect(reads).toEqual([]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["masterLessons"] });
  });

  it("reads the year, and patches nothing, when the read of the lessons fails", async () => {
    const { socket, invalidate, queryClient } = await setup({ read: () => ({ data: null, error: { message: "JWT expired" } }) });
    queryClient.setQueryData(YEAR, [lesson("a"), lesson("gone")]);

    await heard(socket, { lessonIds: ["gone"] }, () => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["masterLessons"] }));

    // The lesson a failed read did not find is not a lesson somebody removed.
    expect(held(queryClient).map((l) => l.id)).toEqual(["a", "gone"]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["masterLessons"] });
  });

  it("reads the year, and does not let the one on its way land on top, when a read of the year began before the change", async () => {
    // The server holds one lesson; the year's read is slow and reads the lesson as it stood when it began.
    const server = { day: 1 };
    const { socket, queryClient } = await setup({
      read: (ids) => ({ data: ids.map((id) => row(id, { dayOfWeek: server.day })), error: null }),
    });
    const slow = deferred<void>();
    let reads = 0;
    queryClient.setQueryData(YEAR, [lesson("a")]);
    const observer = new QueryObserver(queryClient, {
      queryKey: YEAR,
      staleTime: 0,
      queryFn: async () => {
        reads += 1;
        const asItStood = server.day;
        if (reads === 1) await slow.promise;
        return [lesson("a", { dayOfWeek: asItStood })];
      },
    });
    const stop = observer.subscribe(() => undefined);
    await waitFor(() => expect(reads).toBe(1));

    // A colleague moves the lesson while the year is being read, and the page hears of it.
    server.day = 3;
    await waitFor(() => expect(socket.on).toHaveBeenCalledWith("master_timetable_updated", expect.any(Function)));
    act(() => socket.fire("master_timetable_updated", { lessonIds: ["a"] }));
    // The page has answered the event: the lesson laid in, or the year read again.
    await waitFor(() => expect(held(queryClient)[0]!.dayOfWeek === 3 || reads >= 2).toBe(true));
    // The read that began first now comes in, with the lesson as it stood before.
    slow.resolve();
    await flush();

    await waitFor(() => expect(held(queryClient)[0]!.dayOfWeek).toBe(3));
    await flush();
    expect(held(queryClient)[0]!.dayOfWeek).toBe(3);
    stop();
  });

  it("lays the answer of the later event, whichever of two reads of one lesson comes back last", async () => {
    // Two changes of one lesson, heard in order; the first read is slow and the second is not.
    const first = deferred<ReadAnswer>();
    const second = deferred<ReadAnswer>();
    const answers = [first, second];
    const { socket, queryClient, reads } = await setup({ read: () => answers.shift()!.promise });
    queryClient.setQueryData(YEAR, [lesson("a")]);
    await waitFor(() => expect(socket.on).toHaveBeenCalledWith("master_timetable_updated", expect.any(Function)));

    act(() => socket.fire("master_timetable_updated", { lessonIds: ["a"] }));
    await waitFor(() => expect(reads).toHaveLength(1));
    act(() => socket.fire("master_timetable_updated", { lessonIds: ["a"] }));
    await waitFor(() => expect(reads).toHaveLength(2));
    second.resolve({ data: [row("a", { dayOfWeek: 3 })], error: null });
    await flush();
    first.resolve({ data: [row("a", { dayOfWeek: 2 })], error: null });
    await flush();
    await flush();

    expect(held(queryClient).map((l) => [l.id, l.dayOfWeek])).toEqual([["a", 3]]);
  });
});
