// Tests for the realtime collaboration hook. The socket layer is fully faked:
// `socket.io-client` is mocked per test (the hook imports it dynamically, so
// `vi.doMock` after `vi.resetModules` is enough), and the Supabase client is
// mocked at the module boundary. No test touches the network.
//
// `API_BASE_URL` is captured at module-evaluation time, so every test stubs
// the env var and re-imports the hook through a fresh module registry.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
}

async function setup(options: SetupOptions = {}) {
  const { token = "tok-1", session, gateImport } = options;
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
  vi.doMock("@/utils/supabase/client", () => ({
    createClient: () => ({ auth: { getSession } }),
  }));

  const { useTimetableRealtime } = await import("./use-timetable-realtime");

  const queryClient = new QueryClient();
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const view = renderHook(() => useTimetableRealtime(), { wrapper });

  return { view, io, socket, importStarted, getSession, invalidate };
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
