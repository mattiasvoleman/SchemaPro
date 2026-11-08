import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import type { ExternalCreateBody, ExternalRuleBody, UtilisationParams } from "./local";
import {
  LOCAL_KEYS,
  downloadUtilisationCsv,
  useExternalBooking,
  useExternalBookingActions,
  useExternalBookings,
  useExternalClashes,
  useMyResourceBookings,
  useResourceActions,
  useResourceAvailability,
  useResourceBookingActions,
  useResourceBookings,
  useResourceTypeActions,
  useResourceTypes,
  useResources,
  useUtilisation,
} from "./local-queries";

/**
 * What goes over the wire to Lokal's routes (src/local/local.controllers.ts is the contract): the paths, the
 * verbs, the bodies, what is read again after a write, and the report's file.
 */

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api }));

const session = vi.hoisted(() => ({ data: { session: { access_token: "tok" } as { access_token: string } | null } }));
vi.mock("@/utils/supabase/client", () => ({ createClient: () => ({ auth: { getSession: async () => session } }) }));
vi.mock("@/lib/school-choice", () => ({ pageSchool: () => "school-1", schoolHeaders: (school?: string) => (school ? { "X-School-Id": school } : {}) }));

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}

/** The roots a write asks to be read again, in the order they were asked. */
const invalidated = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map(([filter]) => (filter as { queryKey: unknown }).queryKey);

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue([]);
  api.post.mockResolvedValue({});
  api.patch.mockResolvedValue({});
  api.delete.mockResolvedValue(undefined);
});

describe("the keys", () => {
  it("keeps every family under one root, so a clear of the root clears them all", () => {
    for (const key of [
      LOCAL_KEYS.resourceTypes,
      LOCAL_KEYS.resources,
      LOCAL_KEYS.availability,
      LOCAL_KEYS.resourceBookings,
      LOCAL_KEYS.external,
      LOCAL_KEYS.utilisation,
      LOCAL_KEYS.resourceBookingsByStatus("PENDING"),
      LOCAL_KEYS.myResourceBookings,
      LOCAL_KEYS.externalList("active"),
      LOCAL_KEYS.externalDetail("s-1"),
      LOCAL_KEYS.externalClashes,
    ]) {
      expect(key[0]).toBe("local");
    }
  });

  it("puts the lists of resource bookings and the series under their roots, so one invalidation reaches them all", () => {
    expect(LOCAL_KEYS.resourceBookingsByStatus("APPROVED").slice(0, 2)).toEqual([...LOCAL_KEYS.resourceBookings]);
    expect(LOCAL_KEYS.myResourceBookings.slice(0, 2)).toEqual([...LOCAL_KEYS.resourceBookings]);
    expect(LOCAL_KEYS.externalList("ended").slice(0, 2)).toEqual([...LOCAL_KEYS.external]);
    expect(LOCAL_KEYS.externalDetail("s-1").slice(0, 2)).toEqual([...LOCAL_KEYS.external]);
    expect(LOCAL_KEYS.externalClashes.slice(0, 2)).toEqual([...LOCAL_KEYS.external]);
    expect(LOCAL_KEYS.resourceBookingsByStatus("PENDING")).not.toEqual(LOCAL_KEYS.resourceBookingsByStatus("APPROVED"));
    expect(LOCAL_KEYS.externalDetail("a")).not.toEqual(LOCAL_KEYS.externalDetail("b"));
  });
});

describe("reading resources", () => {
  it("reads the kinds, the resources and the reader's own bookings from their routes", async () => {
    const { wrapper } = setup();
    const types = renderHook(() => useResourceTypes(), { wrapper });
    const resources = renderHook(() => useResources(), { wrapper });
    const mine = renderHook(() => useMyResourceBookings(), { wrapper });
    await waitFor(() => expect(types.result.current.isSuccess && resources.result.current.isSuccess && mine.result.current.isSuccess).toBe(true));
    expect(api.get.mock.calls.map(([path]) => path).sort()).toEqual(
      ["/api/v1/resource-bookings?mine=true", "/api/v1/resource-types", "/api/v1/resources"].sort(),
    );
  });

  it("says a failed read is a failed read", async () => {
    api.get.mockRejectedValue(new ApiError(500, "boom"));
    const { wrapper } = setup();
    const { result } = renderHook(() => useResources(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });

  it("asks what is free in a window with the instants encoded, and asks nothing before the window is known", async () => {
    const { wrapper } = setup();
    renderHook(() => useResourceAvailability(null, null), { wrapper });
    renderHook(() => useResourceAvailability("2027-02-03T08:00:00.000Z", null), { wrapper });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.get).not.toHaveBeenCalled();

    const { result } = renderHook(() => useResourceAvailability("2027-02-03T08:00:00.000Z", "2027-02-03T09:30:00.000Z"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.get).toHaveBeenCalledWith("/api/v1/resources/availability?from=2027-02-03T08%3A00%3A00.000Z&to=2027-02-03T09%3A30%3A00.000Z");
  });

  it("reads an administrator's bookings by their state", async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useResourceBookings("PENDING"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.get).toHaveBeenCalledWith("/api/v1/resource-bookings?status=PENDING");
  });
});

describe("writing resource types and resources", () => {
  /** Everything that names the resources is read again, a refusal included: what is on screen may be old. */
  const roots = [LOCAL_KEYS.resourceTypes, LOCAL_KEYS.resources, LOCAL_KEYS.availability, LOCAL_KEYS.utilisation];

  it("creates, renames and removes a kind, and reads the lists and the report again each time", async () => {
    const { client, wrapper } = setup();
    const spy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useResourceTypeActions(), { wrapper });
    await act(async () => {
      await result.current.create.mutateAsync({ name: "Surfplattor" });
    });
    expect(api.post).toHaveBeenCalledWith("/api/v1/resource-types", { name: "Surfplattor" });
    expect(invalidated(spy)).toEqual(roots);

    spy.mockClear();
    await act(async () => {
      await result.current.update.mutateAsync({ id: "t/1", name: "Läsplattor" });
    });
    expect(api.patch).toHaveBeenCalledWith("/api/v1/resource-types/t%2F1", { name: "Läsplattor" });
    expect(invalidated(spy)).toEqual(roots);

    spy.mockClear();
    await act(async () => {
      await result.current.remove.mutateAsync("t-1");
    });
    expect(api.delete).toHaveBeenCalledWith("/api/v1/resource-types/t-1");
    expect(invalidated(spy)).toEqual(roots);
  });

  it("creates, changes and removes a resource, the id out of the body", async () => {
    const { client, wrapper } = setup();
    const spy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useResourceActions(), { wrapper });
    const body = { name: "Minibuss", resourceTypeId: "t-1", quantity: 1, siteId: null, place: null, requiresApproval: true };
    await act(async () => {
      await result.current.create.mutateAsync(body);
      await result.current.update.mutateAsync({ id: "r-1", ...body, quantity: 2 });
      await result.current.remove.mutateAsync("r-1");
    });
    expect(api.post).toHaveBeenCalledWith("/api/v1/resources", body);
    expect(api.patch).toHaveBeenCalledWith("/api/v1/resources/r-1", { ...body, quantity: 2 });
    expect(api.delete).toHaveBeenCalledWith("/api/v1/resources/r-1");
    expect(invalidated(spy)).toEqual([...roots, ...roots, ...roots]);
  });

  it("reads again when a write is refused, since the refusal means the screen is old", async () => {
    api.delete.mockRejectedValueOnce(new ApiError(409, "no", "RESOURCE_IS_LET_OUT"));
    const { client, wrapper } = setup();
    const spy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useResourceActions(), { wrapper });
    await act(async () => {
      await expect(result.current.remove.mutateAsync("r-1")).rejects.toMatchObject({ status: 409, code: "RESOURCE_IS_LET_OUT" });
    });
    expect(invalidated(spy)).toEqual(roots);
  });
});

describe("booking resources", () => {
  const roots = [LOCAL_KEYS.resourceBookings, LOCAL_KEYS.availability, LOCAL_KEYS.utilisation];

  it("books with the window and the quantity, and reads the lists, what is free and the report again", async () => {
    api.post.mockResolvedValue({ id: "b-1", status: "PENDING" });
    const { client, wrapper } = setup();
    const spy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useResourceBookingActions(), { wrapper });
    const body = { resourceId: "r-1", title: "NO", quantity: 3, startsAt: "2027-02-03T08:00:00.000Z", endsAt: "2027-02-03T09:00:00.000Z" };
    await act(async () => {
      await expect(result.current.book.mutateAsync(body)).resolves.toEqual({ id: "b-1", status: "PENDING" });
    });
    expect(api.post).toHaveBeenCalledWith("/api/v1/resource-bookings", body);
    expect(invalidated(spy)).toEqual(roots);
  });

  it("reads again when a booking is refused, because a quantity was taken", async () => {
    api.post.mockRejectedValueOnce(new ApiError(409, "taken"));
    const { client, wrapper } = setup();
    const spy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useResourceBookingActions(), { wrapper });
    await act(async () => {
      await expect(result.current.book.mutateAsync({ resourceId: "r-1", title: "x", quantity: 1, startsAt: "a", endsAt: "b" })).rejects.toMatchObject({
        status: 409,
      });
    });
    expect(invalidated(spy)).toEqual(roots);
  });

  it("cancels by the booking's own route with an empty body", async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useResourceBookingActions(), { wrapper });
    await act(async () => {
      await result.current.cancel.mutateAsync("b-1");
    });
    expect(api.patch).toHaveBeenCalledWith("/api/v1/resource-bookings/b-1/cancel", {});
  });

  it("decides with the note when there is one, and without the key when there is not", async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useResourceBookingActions(), { wrapper });
    await act(async () => {
      await result.current.decide.mutateAsync({ id: "b-1", status: "REJECTED", note: "Upptagen" });
      await result.current.decide.mutateAsync({ id: "b-2", status: "APPROVED" });
      await result.current.decide.mutateAsync({ id: "b-3", status: "APPROVED", note: "" });
    });
    expect(api.patch.mock.calls).toEqual([
      ["/api/v1/resource-bookings/b-1/decide", { status: "REJECTED", note: "Upptagen" }],
      ["/api/v1/resource-bookings/b-2/decide", { status: "APPROVED" }],
      ["/api/v1/resource-bookings/b-3/decide", { status: "APPROVED" }],
    ]);
  });
});

describe("external bookings", () => {
  const rule: ExternalRuleBody = {
    target: "ROOM",
    roomId: "room-1",
    weekdays: [2],
    intervalWeeks: 1,
    startDate: "2027-02-02",
    endDate: "2027-06-08",
    startTime: "18:00",
    endTime: "20:00",
  };

  it("reads the list by state, one series and the clashes from their routes", async () => {
    const { wrapper } = setup();
    const list = renderHook(() => useExternalBookings("ended"), { wrapper });
    const one = renderHook(() => useExternalBooking("s-1"), { wrapper });
    const clashes = renderHook(() => useExternalClashes(), { wrapper });
    await waitFor(() => expect(list.result.current.isSuccess && one.result.current.isSuccess && clashes.result.current.isSuccess).toBe(true));
    expect(api.get.mock.calls.map(([path]) => path).sort()).toEqual(
      ["/api/v1/external-bookings/clashes", "/api/v1/external-bookings/s-1", "/api/v1/external-bookings?state=ended"].sort(),
    );
  });

  it("asks for no series while none is chosen", async () => {
    const { wrapper } = setup();
    renderHook(() => useExternalBooking(null), { wrapper });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.get).not.toHaveBeenCalled();
  });

  it("does not keep what it read once nothing shows it, since a series carries the contact of somebody with no login", async () => {
    const { client, wrapper } = setup();
    const list = renderHook(() => useExternalBookings("active"), { wrapper });
    const one = renderHook(() => useExternalBooking("s-1"), { wrapper });
    const clashes = renderHook(() => useExternalClashes(), { wrapper });
    await waitFor(() => expect(list.result.current.isSuccess && one.result.current.isSuccess && clashes.result.current.isSuccess).toBe(true));
    list.unmount();
    one.unmount();
    clashes.unmount();
    await waitFor(() => expect(client.getQueryCache().findAll({ queryKey: LOCAL_KEYS.external })).toHaveLength(0));
  });

  it("previews without writing anything and without reading anything again", async () => {
    api.post.mockResolvedValue({ occurrences: [], count: 0, blocked: 0, warned: 0, framesMissing: false });
    const { client, wrapper } = setup();
    const spy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useExternalBookingActions(), { wrapper });
    await act(async () => {
      await result.current.preview.mutateAsync(rule);
    });
    expect(api.post).toHaveBeenCalledWith("/api/v1/external-bookings/preview", rule);
    expect(spy).not.toHaveBeenCalled();
  });

  /** A series or a day changed: the series, what the teachers and Lokalbokningar read, what is free, the report. */
  const roots = [
    LOCAL_KEYS.external,
    LOCAL_KEYS.resourceBookings,
    LOCAL_KEYS.availability,
    LOCAL_KEYS.utilisation,
    ["roomBookings"],
    ["myRoomBookings"],
  ];

  it("registers a series and reads everything it touches again", async () => {
    api.post.mockResolvedValue({ id: "s-1", created: 3, skipped: [] });
    const { client, wrapper } = setup();
    const spy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useExternalBookingActions(), { wrapper });
    const body: ExternalCreateBody = {
      ...rule,
      organisation: "IF",
      contactName: "Kim",
      contactPhone: null,
      contactEmail: "kim@if.example",
      purpose: null,
      note: null,
      skipConflicts: true,
    };
    await act(async () => {
      await expect(result.current.create.mutateAsync(body)).resolves.toEqual({ id: "s-1", created: 3, skipped: [] });
    });
    expect(api.post).toHaveBeenCalledWith("/api/v1/external-bookings", body);
    expect(invalidated(spy)).toEqual(roots);
  });

  it("keeps the code of a refused registration, which is what the page branches on", async () => {
    api.post.mockRejectedValueOnce(new ApiError(409, "Några dagar går inte att boka.", "EXTERNAL_BOOKING_CONFLICTS"));
    const { client, wrapper } = setup();
    const spy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useExternalBookingActions(), { wrapper });
    await act(async () => {
      await expect(result.current.create.mutateAsync({} as ExternalCreateBody)).rejects.toMatchObject({
        status: 409,
        code: "EXTERNAL_BOOKING_CONFLICTS",
      });
    });
    expect(invalidated(spy)).toEqual(roots);
  });

  it("changes who a series is for, the id out of the body", async () => {
    const { client, wrapper } = setup();
    const spy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useExternalBookingActions(), { wrapper });
    const body = { organisation: "IF", contactName: "Kim", contactPhone: "070", contactEmail: null, purpose: null, note: null };
    await act(async () => {
      await result.current.update.mutateAsync({ id: "s-1", ...body });
    });
    expect(api.patch).toHaveBeenCalledWith("/api/v1/external-bookings/s-1", body);
    expect(invalidated(spy)).toEqual(roots);
  });

  it("cancels a series and a day by their own routes, with empty bodies", async () => {
    const { client, wrapper } = setup();
    const spy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useExternalBookingActions(), { wrapper });
    await act(async () => {
      await result.current.cancelSeries.mutateAsync("s-1");
      await result.current.cancelDay.mutateAsync({ id: "s-1", dayId: "d/2" });
    });
    expect(api.patch.mock.calls).toEqual([
      ["/api/v1/external-bookings/s-1/cancel", {}],
      ["/api/v1/external-bookings/s-1/days/d%2F2/cancel", {}],
    ]);
    expect(invalidated(spy)).toEqual([...roots, ...roots]);
  });
});

describe("the report", () => {
  const params: UtilisationParams = { from: "2027-01-01", to: "2027-07-31", kind: "ROOM", openFrom: "07:00", openTo: "22:00" };

  it("asks only for the form that was applied", async () => {
    const { wrapper } = setup();
    renderHook(() => useUtilisation(null), { wrapper });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.get).not.toHaveBeenCalled();

    const { result } = renderHook(() => useUtilisation(params), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.get).toHaveBeenCalledWith("/api/v1/utilisation?from=2027-01-01&to=2027-07-31&kind=ROOM&openFrom=07%3A00&openTo=22%3A00");
  });

  it("keeps a report of its own for each form", async () => {
    const { client, wrapper } = setup();
    const a = renderHook(() => useUtilisation(params), { wrapper });
    const b = renderHook(() => useUtilisation({ ...params, kind: "RESOURCE" }), { wrapper });
    await waitFor(() => expect(a.result.current.isSuccess && b.result.current.isSuccess).toBe(true));
    expect(client.getQueryCache().findAll({ queryKey: LOCAL_KEYS.utilisation })).toHaveLength(2);
  });
});

describe("downloadUtilisationCsv", () => {
  const params: UtilisationParams = { from: "2027-01-01", to: "2027-07-31", kind: "ALL", openFrom: "07:00", openTo: "22:00" };
  const click = vi.fn();
  let named: string;
  let fetched: Array<[string, RequestInit | undefined]>;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "https://api.test/");
    session.data.session = { access_token: "tok" };
    fetched = [];
    named = "";
    click.mockReset();
    vi.spyOn(document, "createElement").mockImplementation(((tag: string) =>
      tag === "a"
        ? ({ click, set href(_value: string) {}, set download(value: string) { named = value; } } as unknown as HTMLAnchorElement)
        : document.createElementNS("http://www.w3.org/1999/xhtml", tag)) as never);
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
  });

  const answer = (init: ResponseInit, body: BodyInit | null) =>
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => (fetched.push([String(url), options]), new Response(body, init)));

  it("is refused without a session, before any request", async () => {
    session.data.session = null;
    const spy = answer({ status: 200 }, "x");
    await expect(downloadUtilisationCsv(params)).rejects.toMatchObject({ status: 401 });
    expect(spy).not.toHaveBeenCalled();
  });

  it("is refused where the gateway's address is not configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "");
    const spy = answer({ status: 200 }, "x");
    await expect(downloadUtilisationCsv(params)).rejects.toMatchObject({ status: 0 });
    expect(spy).not.toHaveBeenCalled();
  });

  it("asks for the period with the token and the page's school, and saves the bytes under the name the gateway gives", async () => {
    answer({ status: 200 }, new Uint8Array([0x66, 0x72, 0xe5, 0x6e]));
    await downloadUtilisationCsv(params);
    expect(fetched[0]![0]).toBe("https://api.test/api/v1/utilisation/csv?from=2027-01-01&to=2027-07-31&kind=ALL&openFrom=07%3A00&openTo=22%3A00");
    expect(fetched[0]![1]).toMatchObject({ headers: { Authorization: "Bearer tok", "X-School-Id": "school-1" } });
    expect(named).toBe("utnyttjande-2027-01-01-2027-07-31.csv");
    expect(click).toHaveBeenCalledTimes(1);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:x");
  });

  it("says the gateway's reason for a refusal, and nothing is saved", async () => {
    answer({ status: 400 }, JSON.stringify({ message: "A report covers at most 400 days.", code: "REPORT_TOO_LONG" }));
    await expect(downloadUtilisationCsv(params)).rejects.toMatchObject({ status: 400, code: "REPORT_TOO_LONG", message: "A report covers at most 400 days." });
    expect(click).not.toHaveBeenCalled();
  });

  it("keeps the status when the refusal has no JSON body", async () => {
    answer({ status: 502 }, "<html>bad gateway</html>");
    await expect(downloadUtilisationCsv(params)).rejects.toMatchObject({ status: 502, message: "HTTP 502" });
    expect(click).not.toHaveBeenCalled();
  });
});
