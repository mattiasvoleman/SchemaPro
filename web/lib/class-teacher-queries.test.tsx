import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLASS_TEACHER_ADMIN_KEYS,
  CLASS_TEACHER_KEYS,
  REFRESH_MS,
  useAppointments,
  useCheck,
  useClassTeacherAdminActions,
  useClassTeacherActions,
  useClassTeacherSettings,
  useDrafts,
  useMine,
  useOpenTimes,
  usePreview,
  useWeek,
} from "./class-teacher-queries";
import { appointment, openTime, week, CLASS_ID, VERSION, YEAR_ID } from "./__fixtures__/class-teacher";

/**
 * What goes over the wire to /api/v1/class-teacher (the klasslärare) and
 * /api/v1/class-teachers (the administrators): the routes, the verbs and the
 * bodies, and what each write leaves stale. The gateway's controllers are the
 * contract (src/class-teacher/class-teacher.controller.ts and
 * class-teacher-admin.controller.ts).
 */

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api }));

const BASE = "/api/v1/class-teacher";
const ADMIN = "/api/v1/class-teachers";

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue({});
  api.post.mockResolvedValue({});
  api.patch.mockResolvedValue({});
  api.put.mockResolvedValue({});
  api.delete.mockResolvedValue(undefined);
});

describe("the klasslärare's reads", () => {
  it("asks for the classes the reader is klasslärare of", async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useMine(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.get).toHaveBeenCalledWith(`${BASE}/mine`);
  });

  it("asks for a week of a class: this week when no date is named, otherwise the week of the date", async () => {
    const { wrapper } = setup();
    const now = renderHook(() => useWeek(CLASS_ID, null), { wrapper });
    await waitFor(() => expect(now.result.current.isSuccess).toBe(true));
    const later = renderHook(() => useWeek(CLASS_ID, "2026-11-09"), { wrapper });
    await waitFor(() => expect(later.result.current.isSuccess).toBe(true));
    expect(api.get.mock.calls.map(([path]) => path)).toEqual([`${BASE}/classes/${CLASS_ID}/week`, `${BASE}/classes/${CLASS_ID}/week?from=2026-11-09`]);
  });

  it("asks nothing until there is a class", () => {
    const { wrapper } = setup();
    renderHook(() => useWeek(null, null), { wrapper });
    renderHook(() => useCheck(null), { wrapper });
    expect(api.get).not.toHaveBeenCalled();
  });

  it("reads the week again once a minute or less, and when the window is looked at again, so that two editors see each other", async () => {
    expect(REFRESH_MS).toBeGreaterThanOrEqual(30_000);
    expect(REFRESH_MS).toBeLessThanOrEqual(60_000);
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useWeek(CLASS_ID, null), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const options = client.getQueryCache().find({ queryKey: CLASS_TEACHER_KEYS.week(CLASS_ID, null) })!.observers[0]!.options;
    expect(options.refetchInterval).toBe(REFRESH_MS);
    expect(options.refetchOnWindowFocus).toBe(true);
  });

  it("keeps a week of its own in the cache, and the last one on screen while the next loads", async () => {
    expect(CLASS_TEACHER_KEYS.week(CLASS_ID, null)).not.toEqual(CLASS_TEACHER_KEYS.week(CLASS_ID, "2026-11-09"));
    let release!: (value: unknown) => void;
    api.get.mockResolvedValueOnce(week());
    const { wrapper } = setup();
    const { result, rerender } = renderHook(({ from }: { from: string | null }) => useWeek(CLASS_ID, from), { wrapper, initialProps: { from: null as string | null } });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    api.get.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    rerender({ from: "2026-11-09" });
    await waitFor(() => expect(result.current.isPlaceholderData).toBe(true));
    expect(result.current.data?.weekStart).toBe("2026-11-02");
    await act(async () => release(week({ weekStart: "2026-11-09" })));
    await waitFor(() => expect(result.current.isPlaceholderData).toBe(false));
    expect(result.current.data?.weekStart).toBe("2026-11-09");
  });

  it("judges the drafts only while there are drafts to judge", async () => {
    const { wrapper } = setup();
    renderHook(() => useCheck(CLASS_ID, false), { wrapper });
    expect(api.get).not.toHaveBeenCalled();
    const { result } = renderHook(() => useCheck(CLASS_ID, true), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.get).toHaveBeenCalledWith(`${BASE}/classes/${CLASS_ID}/check`);
  });
});

describe("the live check", () => {
  const body = { kind: "OCCASION_MOVE" as const, calendarLessonId: "o-ma", targetDate: "2026-11-04", targetStart: "10:00", targetEnd: "11:00" };

  it("asks nothing while the form is not sendable (no body)", () => {
    const { wrapper } = setup();
    renderHook(() => usePreview(CLASS_ID, null), { wrapper });
    expect(api.post).not.toHaveBeenCalled();
  });

  it("posts the change to the preview, without a version to hold it to, and lets a superseded one be cancelled", async () => {
    api.post.mockResolvedValue({ verdict: { state: "OK" } });
    const { wrapper } = setup();
    const { result } = renderHook(() => usePreview(CLASS_ID, body), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.post).toHaveBeenCalledWith(`${BASE}/classes/${CLASS_ID}/preview`, body, expect.any(AbortSignal));
    expect(result.current.data).toEqual({ verdict: { state: "OK" } });
  });

  it("keeps the last verdict on screen while the next is asked for", async () => {
    let release!: (value: unknown) => void;
    api.post.mockResolvedValueOnce({ verdict: { state: "OK" } });
    const { wrapper } = setup();
    const { result, rerender } = renderHook(({ target }: { target: string }) => usePreview(CLASS_ID, { ...body, targetStart: target }), {
      wrapper,
      initialProps: { target: "10:00" },
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    api.post.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    rerender({ target: "10:30" });
    await waitFor(() => expect(result.current.isPlaceholderData).toBe(true));
    expect(result.current.data).toEqual({ verdict: { state: "OK" } });
    await act(async () => release({ verdict: { state: "CONFLICT", conflicts: [] } }));
    await waitFor(() => expect(result.current.data).toEqual({ verdict: { state: "CONFLICT", conflicts: [] } }));
  });
});

describe("the klasslärare's writes", () => {
  it("creates a draft against the version of the lesson the page read", async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useClassTeacherActions(CLASS_ID), { wrapper });
    const body = { kind: "OCCASION_CANCEL" as const, calendarLessonId: "o-ma", baseVersion: VERSION, note: "Sjuk" };
    await act(async () => void (await result.current.create.mutateAsync(body)));
    expect(api.post).toHaveBeenCalledWith(`${BASE}/classes/${CLASS_ID}/changes`, body);
  });

  it("edits a draft at the revision it was read at", async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useClassTeacherActions(CLASS_ID), { wrapper });
    await act(async () => void (await result.current.update.mutateAsync({ id: "d-1", body: { rev: 2, targetStart: "10:30" } })));
    expect(api.patch).toHaveBeenCalledWith(`${BASE}/classes/${CLASS_ID}/changes/d-1`, { rev: 2, targetStart: "10:30" });
  });

  it("throws a draft away at the revision it was read at", async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useClassTeacherActions(CLASS_ID), { wrapper });
    await act(async () => void (await result.current.discard.mutateAsync({ id: "d-1", rev: 3 })));
    expect(api.delete).toHaveBeenCalledWith(`${BASE}/classes/${CLASS_ID}/changes/d-1?rev=3`);
  });

  it("publishes every draft of the class, or the ones named", async () => {
    api.post.mockResolvedValue({ outcomes: [] });
    const { wrapper } = setup();
    const { result } = renderHook(() => useClassTeacherActions(CLASS_ID), { wrapper });
    await act(async () => void (await result.current.publish.mutateAsync(undefined)));
    await act(async () => void (await result.current.publish.mutateAsync(["d-1", "d-2"])));
    expect(api.post.mock.calls).toEqual([
      [`${BASE}/classes/${CLASS_ID}/publish`, {}],
      [`${BASE}/classes/${CLASS_ID}/publish`, { changeIds: ["d-1", "d-2"] }],
    ]);
  });

  it("reads the week and the check again after a write, and after a refused one", async () => {
    const { client, wrapper } = setup();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useClassTeacherActions(CLASS_ID), { wrapper });
    await act(async () => void (await result.current.create.mutateAsync({ kind: "OCCASION_CANCEL", calendarLessonId: "o-ma", baseVersion: VERSION })));
    const keys = () => invalidate.mock.calls.map(([filters]) => (filters as { queryKey: unknown }).queryKey);
    expect(keys()).toEqual([CLASS_TEACHER_KEYS.weeks(CLASS_ID), CLASS_TEACHER_KEYS.check(CLASS_ID)]);
    // Every week of the class is under the prefix a write invalidates.
    expect(CLASS_TEACHER_KEYS.week(CLASS_ID, "2026-11-09").slice(0, 3)).toEqual(CLASS_TEACHER_KEYS.weeks(CLASS_ID));
    invalidate.mockClear();
    api.patch.mockRejectedValueOnce(new Error("409"));
    await act(async () => void (await result.current.update.mutateAsync({ id: "d-1", body: { rev: 1 } }).catch(() => undefined)));
    expect(keys()).toEqual([CLASS_TEACHER_KEYS.weeks(CLASS_ID), CLASS_TEACHER_KEYS.check(CLASS_ID)]);
  });
});

describe("the administrators' reads", () => {
  it("reads the appointments, the open times, the option and the drafts", async () => {
    const { wrapper } = setup();
    const appointments = renderHook(() => useAppointments(YEAR_ID), { wrapper });
    const times = renderHook(() => useOpenTimes(YEAR_ID), { wrapper });
    const settings = renderHook(() => useClassTeacherSettings(), { wrapper });
    const drafts = renderHook(() => useDrafts(), { wrapper });
    await waitFor(() => expect([appointments, times, settings, drafts].every((one) => one.result.current.isSuccess)).toBe(true));
    expect(api.get.mock.calls.map(([path]) => path).sort()).toEqual(
      [`${ADMIN}/appointments?academicYearId=${YEAR_ID}`, `${ADMIN}/open-times?academicYearId=${YEAR_ID}`, `${ADMIN}/settings`, `${ADMIN}/drafts`].sort(),
    );
  });

  it("asks nothing of a year before there is one", () => {
    const { wrapper } = setup();
    renderHook(() => useAppointments(null), { wrapper });
    renderHook(() => useOpenTimes(null), { wrapper });
    expect(api.get).not.toHaveBeenCalled();
  });

  it("keeps a läsår of its own in the cache, and reads the drafts again like the klasslärare's week", async () => {
    expect(CLASS_TEACHER_ADMIN_KEYS.appointments("y1")).not.toEqual(CLASS_TEACHER_ADMIN_KEYS.appointments("y2"));
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useDrafts(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const options = client.getQueryCache().find({ queryKey: CLASS_TEACHER_ADMIN_KEYS.drafts })!.observers[0]!.options;
    expect(options.refetchInterval).toBe(REFRESH_MS);
  });
});

describe("the administrators' writes", () => {
  it("appoints a teacher to a class, sends no year, and keeps the answer, the year's whole list, as the cache", async () => {
    const list = [appointment()];
    api.post.mockResolvedValue(list);
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useClassTeacherAdminActions(), { wrapper });
    await act(async () => void (await result.current.appoint.mutateAsync({ yearId: YEAR_ID, studentGroupId: CLASS_ID, userId: "t-anna" })));
    expect(api.post).toHaveBeenCalledWith(`${ADMIN}/appointments`, { studentGroupId: CLASS_ID, userId: "t-anna" });
    expect(client.getQueryData(CLASS_TEACHER_ADMIN_KEYS.appointments(YEAR_ID))).toEqual(list);
  });

  it("removes an appointment and reads the year's list again", async () => {
    const { client, wrapper } = setup();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useClassTeacherAdminActions(), { wrapper });
    await act(async () => void (await result.current.removeAppointment.mutateAsync({ yearId: YEAR_ID, id: "ap-1" })));
    expect(api.delete).toHaveBeenCalledWith(`${ADMIN}/appointments/ap-1`);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: CLASS_TEACHER_ADMIN_KEYS.appointments(YEAR_ID) });
  });

  it("replaces the spans of one scope whole, and keeps the answer as the year's open times", async () => {
    const list = [openTime(), openTime({ id: "ot-2", studentGroupId: CLASS_ID, dayOfWeek: 3 })];
    api.put.mockResolvedValue(list);
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useClassTeacherAdminActions(), { wrapper });
    const body = { academicYearId: YEAR_ID, studentGroupId: null, spans: [{ dayOfWeek: 1, startTime: "08:00", endTime: "12:00" }] };
    await act(async () => void (await result.current.setOpenTimes.mutateAsync(body)));
    expect(api.put).toHaveBeenCalledWith(`${ADMIN}/open-times`, body);
    expect(client.getQueryData(CLASS_TEACHER_ADMIN_KEYS.openTimes(YEAR_ID))).toEqual(list);
  });

  it("saves the option as {selfPublish} and keeps the answer", async () => {
    api.put.mockResolvedValue({ selfPublish: true });
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useClassTeacherAdminActions(), { wrapper });
    await act(async () => void (await result.current.updateSettings.mutateAsync(true)));
    expect(api.put).toHaveBeenCalledWith(`${ADMIN}/settings`, { selfPublish: true });
    expect(client.getQueryData(CLASS_TEACHER_ADMIN_KEYS.settings)).toEqual({ selfPublish: true });
  });

  it("reads the option again when a save is refused, since what is on screen may be stale", async () => {
    api.put.mockRejectedValue(new Error("403"));
    const { client, wrapper } = setup();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useClassTeacherAdminActions(), { wrapper });
    await act(async () => void (await result.current.updateSettings.mutateAsync(true).catch(() => undefined)));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: CLASS_TEACHER_ADMIN_KEYS.settings });
  });

  it("throws a draft away and publishes a class's drafts, and reads the drafts and the klasslärare's weeks again", async () => {
    api.post.mockResolvedValue({ outcomes: [] });
    const { client, wrapper } = setup();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useClassTeacherAdminActions(), { wrapper });
    await act(async () => void (await result.current.discardDraft.mutateAsync("d-1")));
    await act(async () => void (await result.current.publishClass.mutateAsync({ classId: CLASS_ID })));
    await act(async () => void (await result.current.publishClass.mutateAsync({ classId: CLASS_ID, changeIds: ["d-1"] })));
    expect(api.delete).toHaveBeenCalledWith(`${ADMIN}/drafts/d-1`);
    expect(api.post.mock.calls).toEqual([
      [`${ADMIN}/classes/${CLASS_ID}/publish`, {}],
      [`${ADMIN}/classes/${CLASS_ID}/publish`, { changeIds: ["d-1"] }],
    ]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: CLASS_TEACHER_ADMIN_KEYS.drafts });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: CLASS_TEACHER_KEYS.all });
  });
});
