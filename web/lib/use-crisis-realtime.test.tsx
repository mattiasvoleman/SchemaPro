// Krisläge's realtime hook with the socket fully faked: socket.io-client is
// mocked per test (the hook imports it inside its effect, so vi.doMock after
// vi.resetModules is enough) and so is the Supabase client. API_BASE_URL is
// read when the module is evaluated, so every test stubs the variable and
// imports the hook afresh.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CRISIS_KEYS } from "./crisis-keys";

type Handler = (payload?: unknown) => void;

function makeFakeSocket() {
  const handlers = new Map<string, Handler>();
  return {
    on: vi.fn((event: string, callback: Handler) => void handlers.set(event, callback)),
    disconnect: vi.fn(),
    fire(event: string, payload?: unknown) {
      const handler = handlers.get(event);
      if (!handler) throw new Error(`no handler registered for "${event}"`);
      handler(payload);
    },
    has: (event: string) => handlers.has(event),
  };
}

async function setup({ token = "tok-1", noApi = false, failImport = false } = {}) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", noApi ? undefined : "https://api.test");
  const socket = makeFakeSocket();
  const io = vi.fn(() => socket);
  vi.doMock("socket.io-client", () => {
    if (failImport) throw new Error("chunk failed to load");
    return { io };
  });
  const getSession = vi.fn(async () => ({ data: { session: token === null ? null : { access_token: token } } }));
  vi.doMock("@/utils/supabase/client", () => ({ createClient: () => ({ auth: { getSession } }) }));
  const { useCrisisRealtime } = await import("./use-crisis-realtime");
  const queryClient = new QueryClient();
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  const view = renderHook(() => useCrisisRealtime(), { wrapper });
  return { view, io, socket, getSession, invalidate };
}

afterEach(() => vi.unstubAllEnvs());

describe("useCrisisRealtime", () => {
  it("connects with the access token", async () => {
    const { io } = await setup();
    await waitFor(() => expect(io).toHaveBeenCalledTimes(1));
    expect(io).toHaveBeenCalledWith("https://api.test", { transports: ["websocket"], auth: { token: "tok-1" } });
  });

  it("asks every read of the alarm again when the gateway says it changed, whoever made the change", async () => {
    const { io, socket, invalidate } = await setup();
    await waitFor(() => expect(io).toHaveBeenCalled());
    // The event names no pupil and no group: {alarmId, changedAt}, and that is all it can say.
    socket.fire("crisis_updated", { alarmId: "a-1", changedAt: "2027-01-12T09:20:00.000Z" });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: CRISIS_KEYS.all });
    // The prefix is the keys of the settings, the lists, the alarm, the protocol and the teacher's list alike.
    for (const key of [CRISIS_KEYS.recent, CRISIS_KEYS.list("LIVE"), CRISIS_KEYS.detail("a-1"), CRISIS_KEYS.protocol("a-1"), CRISIS_KEYS.mine]) {
      expect(key.slice(0, CRISIS_KEYS.all.length)).toEqual([...CRISIS_KEYS.all]);
    }
  });

  it("asks again when the socket has been gone and is back, but not for its first connection", async () => {
    const { io, socket, invalidate } = await setup();
    await waitFor(() => expect(io).toHaveBeenCalled());
    socket.fire("connect");
    expect(invalidate).not.toHaveBeenCalled();
    socket.fire("connect");
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("names the page's school in the handshake, for a session with more than one", async () => {
    const meta = document.createElement("meta");
    meta.name = "rastra-school";
    meta.content = "33333333-3333-4333-8333-333333333333";
    document.head.append(meta);
    try {
      const { io } = await setup();
      await waitFor(() => expect(io).toHaveBeenCalled());
      expect(io).toHaveBeenCalledWith("https://api.test", {
        transports: ["websocket"],
        auth: { token: "tok-1", school: "33333333-3333-4333-8333-333333333333" },
      });
    } finally {
      meta.remove();
    }
  });

  it("disconnects when the page goes", async () => {
    const { io, socket, view } = await setup();
    await waitFor(() => expect(io).toHaveBeenCalled());
    view.unmount();
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
  });

  it("does nothing without an API address or a session, and the page polls instead", async () => {
    const without = await setup({ noApi: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(without.getSession).not.toHaveBeenCalled();
    expect(without.io).not.toHaveBeenCalled();
    const signedOut = await setup({ token: null as unknown as string });
    await waitFor(() => expect(signedOut.getSession).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(signedOut.io).not.toHaveBeenCalled();
  });

  it("does not throw when the socket's chunk cannot be fetched (a phone with one bar)", async () => {
    const { io, getSession } = await setup({ failImport: true });
    await waitFor(() => expect(getSession).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(io).not.toHaveBeenCalled();
  });
});
