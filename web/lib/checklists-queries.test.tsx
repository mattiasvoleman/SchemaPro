import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHECKLIST_KEYS,
  useChecklistActions,
  useChecklistGroups,
  useConsentDetail,
  useConsentLists,
  useInstructors,
  usePupilCard,
  useRoster,
  useSubjectChoices,
  useTemplates,
} from "./checklists-queries";

/**
 * What goes over the wire to /api/v1/checklists: the routes, the verbs and the
 * bodies, and what is read again after a write. The gateway's routes are the
 * contract (src/checklists/checklists.controller.ts).
 */

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
vi.mock("@/lib/api", () => ({ api }));

const subjects = vi.hoisted(() => ({
  result: { data: null as unknown, error: null as null | { message: string } },
  from: vi.fn(),
  select: vi.fn(),
  order: vi.fn(),
}));
vi.mock("@/utils/supabase/client", () => ({
  createClient: () => ({ from: subjects.from }),
}));

const BASE = "/api/v1/checklists";

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const invalidated = vi.spyOn(client, "invalidateQueries");
  const keysInvalidated = () => invalidated.mock.calls.map(([filter]) => JSON.stringify((filter as { queryKey: unknown }).queryKey));
  return { client, wrapper, keysInvalidated };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue([]);
  api.post.mockResolvedValue({});
  api.patch.mockResolvedValue({});
  subjects.result = { data: [], error: null };
  subjects.from.mockReturnValue({ select: subjects.select });
  subjects.select.mockReturnValue({ order: subjects.order });
  // .order("name").order("id") resolves with the rows.
  subjects.order.mockImplementation(() => ({ order: () => Promise.resolve(subjects.result) }));
});

describe("reading", () => {
  it("reads each list from its own route", async () => {
    const { wrapper } = setup();
    const hooks = [
      renderHook(() => useTemplates(false), { wrapper }),
      renderHook(() => useTemplates(true), { wrapper }),
      renderHook(() => useChecklistGroups(), { wrapper }),
      renderHook(() => useInstructors(true), { wrapper }),
      renderHook(() => useRoster("t-1", "g-7a"), { wrapper }),
      renderHook(() => usePupilCard("p-ada"), { wrapper }),
      renderHook(() => useConsentLists("", false), { wrapper }),
      renderHook(() => useConsentLists("g-7a", true), { wrapper }),
      renderHook(() => useConsentDetail("l-1"), { wrapper }),
    ];
    for (const hook of hooks) await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
    expect(api.get.mock.calls.map(([path]) => path).sort()).toEqual(
      [
        `${BASE}/templates`,
        `${BASE}/templates?includeRetired=true`,
        `${BASE}/groups`,
        `${BASE}/instructors`,
        `${BASE}/templates/t-1/roster?groupId=g-7a`,
        `${BASE}/students/p-ada`,
        `${BASE}/consent-lists`,
        `${BASE}/consent-lists?classId=g-7a&includeClosed=true`,
        `${BASE}/consent-lists/l-1`,
      ].sort(),
    );
  });

  it("reads the roster only when a template and a group are both chosen, and the instructors only when asked", async () => {
    const { wrapper } = setup();
    renderHook(() => useRoster("", "g-7a"), { wrapper });
    renderHook(() => useRoster("t-1", ""), { wrapper });
    renderHook(() => useInstructors(false), { wrapper });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.get).not.toHaveBeenCalled();
  });

  it("does not retry a refusal: a failed read is shown at once", async () => {
    api.get.mockRejectedValue(new Error("403"));
    const { wrapper } = setup();
    const { result } = renderHook(() => useTemplates(false), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it("does not keep a roster, a pupil's card or a list once nothing shows them (the gateway records each reading)", async () => {
    const { client, wrapper } = setup();
    const roster = renderHook(() => useRoster("t-1", "g-7a"), { wrapper });
    const card = renderHook(() => usePupilCard("p-ada"), { wrapper });
    const detail = renderHook(() => useConsentDetail("l-1"), { wrapper });
    await waitFor(() => expect(roster.result.current.isSuccess && card.result.current.isSuccess && detail.result.current.isSuccess).toBe(true));
    roster.unmount();
    card.unmount();
    detail.unmount();
    await waitFor(() => expect(client.getQueryData(CHECKLIST_KEYS.rosterOf("t-1", "g-7a"))).toBeUndefined());
    expect(client.getQueryData(CHECKLIST_KEYS.cardOf("p-ada"))).toBeUndefined();
    expect(client.getQueryData(CHECKLIST_KEYS.detailOf("l-1"))).toBeUndefined();

    // Shown again, they are read again.
    const before = api.get.mock.calls.length;
    const again = renderHook(() => useRoster("t-1", "g-7a"), { wrapper });
    await waitFor(() => expect(again.result.current.isSuccess).toBe(true));
    expect(api.get.mock.calls.length).toBe(before + 1);
  });

  it("keeps the lists that name nobody (templates, groups, consent lists)", async () => {
    const { client, wrapper } = setup();
    const templates = renderHook(() => useTemplates(false), { wrapper });
    await waitFor(() => expect(templates.result.current.isSuccess).toBe(true));
    templates.unmount();
    expect(client.getQueryData([...CHECKLIST_KEYS.templates, false])).toEqual([]);
  });

  it("reads the subjects from PostgREST, in Swedish order, only when asked", async () => {
    subjects.result = {
      data: [
        { id: "s-o", name: "Övrigt" },
        { id: "s-b", name: "Bild" },
        { id: "s-a", name: "Ämnesval" },
      ],
      error: null,
    };
    const { wrapper } = setup();
    const idle = renderHook(() => useSubjectChoices(false), { wrapper });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(subjects.from).not.toHaveBeenCalled();
    expect(idle.result.current.data).toBeUndefined();

    const { result } = renderHook(() => useSubjectChoices(true), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(subjects.from).toHaveBeenCalledWith("Subjects");
    expect(subjects.select).toHaveBeenCalledWith("id, name");
    expect(result.current.data?.map((subject) => subject.name)).toEqual(["Bild", "Ämnesval", "Övrigt"]);
  });

  it("says a subject read that failed, with the database's words", async () => {
    subjects.result = { data: null, error: { message: "permission denied" } };
    const { wrapper } = setup();
    const { result } = renderHook(() => useSubjectChoices(true), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe("permission denied");
  });

  it("answers no subjects when the table gives none back", async () => {
    subjects.result = { data: null, error: null };
    const { wrapper } = setup();
    const { result } = renderHook(() => useSubjectChoices(true), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
  });
});

describe("writing", () => {
  it("makes a template and reads the templates again", async () => {
    const { wrapper, keysInvalidated } = setup();
    const { result } = renderHook(() => useChecklistActions(), { wrapper });
    await act(() => result.current.createTemplate.mutateAsync({ title: "Maskinerna", subjectId: "s-slojd" }));
    expect(api.post).toHaveBeenCalledWith(`${BASE}/templates`, { title: "Maskinerna", subjectId: "s-slojd" });
    expect(keysInvalidated()).toEqual([JSON.stringify(CHECKLIST_KEYS.templates)]);
  });

  it("changes a template with a patch, and reads the templates and the rosters (which carry it) again; a refusal reads the templates", async () => {
    const { wrapper, keysInvalidated } = setup();
    const { result } = renderHook(() => useChecklistActions(), { wrapper });
    await act(() => result.current.updateTemplate.mutateAsync({ id: "t-1", patch: { active: false } }));
    expect(api.patch).toHaveBeenCalledWith(`${BASE}/templates/t-1`, { active: false });
    expect(keysInvalidated()).toEqual([JSON.stringify(CHECKLIST_KEYS.templates), JSON.stringify(CHECKLIST_KEYS.roster)]);

    api.patch.mockRejectedValueOnce(new Error("404"));
    await act(async () => {
      await result.current.updateTemplate.mutateAsync({ id: "t-9", patch: { title: "x" } }).catch(() => undefined);
    });
    expect(keysInvalidated().slice(2)).toEqual([JSON.stringify(CHECKLIST_KEYS.templates)]);
  });

  it("ticks, and reads the rosters and the cards again; a refusal says the templates and the rosters are stale", async () => {
    const { wrapper, keysInvalidated } = setup();
    const { result } = renderHook(() => useChecklistActions(), { wrapper });
    const body = { templateId: "t-1", studentIds: ["p-bo"], note: "Svarven" };
    api.post.mockResolvedValueOnce({ written: 1, already: 0 });
    await expect(act(() => result.current.tick.mutateAsync(body))).resolves.toEqual({ written: 1, already: 0 });
    expect(api.post).toHaveBeenCalledWith(`${BASE}/proofs`, body);
    expect(keysInvalidated()).toEqual([JSON.stringify(CHECKLIST_KEYS.roster), JSON.stringify(CHECKLIST_KEYS.card)]);

    api.post.mockRejectedValueOnce(new Error("409"));
    await act(async () => {
      await result.current.tick.mutateAsync(body).catch(() => undefined);
    });
    expect(keysInvalidated().slice(2)).toEqual([JSON.stringify(CHECKLIST_KEYS.templates), JSON.stringify(CHECKLIST_KEYS.roster)]);
  });

  it("voids a tick with its reason, and reads the rosters and cards again whether it worked or not", async () => {
    const { wrapper, keysInvalidated } = setup();
    const { result } = renderHook(() => useChecklistActions(), { wrapper });
    await act(() => result.current.voidProof.mutateAsync({ id: "pr-1", reason: "Fel elev" }));
    expect(api.post).toHaveBeenCalledWith(`${BASE}/proofs/pr-1/void`, { reason: "Fel elev" });
    api.post.mockRejectedValueOnce(new Error("404"));
    await act(async () => {
      await result.current.voidProof.mutateAsync({ id: "pr-2", reason: "Fel dag" }).catch(() => undefined);
    });
    expect(keysInvalidated()).toEqual([
      JSON.stringify(CHECKLIST_KEYS.roster),
      JSON.stringify(CHECKLIST_KEYS.card),
      JSON.stringify(CHECKLIST_KEYS.roster),
      JSON.stringify(CHECKLIST_KEYS.card),
    ]);
  });

  it("makes a list and reads the lists again", async () => {
    const { wrapper, keysInvalidated } = setup();
    const { result } = renderHook(() => useChecklistActions(), { wrapper });
    await act(() => result.current.createList.mutateAsync({ classId: "g-7a", title: "Foto", body: "Vi får fotografera." }));
    expect(api.post).toHaveBeenCalledWith(`${BASE}/consent-lists`, { classId: "g-7a", title: "Foto", body: "Vi får fotografera." });
    expect(keysInvalidated()).toEqual([JSON.stringify(CHECKLIST_KEYS.lists)]);
  });

  it("writes answers to a list, and reads that list, the lists and the cards again; a refusal reads only the list", async () => {
    const { wrapper, keysInvalidated } = setup();
    const { result } = renderHook(() => useChecklistActions(), { wrapper });
    const body = { studentIds: ["p-ada"], kind: "GRANTED" };
    await act(() => result.current.record.mutateAsync({ id: "l-1", body }));
    expect(api.post).toHaveBeenCalledWith(`${BASE}/consent-lists/l-1/entries`, body);
    expect(keysInvalidated()).toEqual([
      JSON.stringify(CHECKLIST_KEYS.detailOf("l-1")),
      JSON.stringify(CHECKLIST_KEYS.lists),
      JSON.stringify(CHECKLIST_KEYS.card),
    ]);
    api.post.mockRejectedValueOnce(new Error("409"));
    await act(async () => {
      await result.current.record.mutateAsync({ id: "l-1", body }).catch(() => undefined);
    });
    expect(keysInvalidated().slice(3)).toEqual([JSON.stringify(CHECKLIST_KEYS.detailOf("l-1"))]);
  });

  it("asks the guardians, with the pupils or with nothing for everyone who has not answered", async () => {
    const { wrapper, keysInvalidated } = setup();
    const { result } = renderHook(() => useChecklistActions(), { wrapper });
    await act(() => result.current.ask.mutateAsync({ id: "l-1", body: { studentIds: ["p-ada"] } }));
    expect(api.post).toHaveBeenLastCalledWith(`${BASE}/consent-lists/l-1/ask`, { studentIds: ["p-ada"] });
    await act(() => result.current.ask.mutateAsync({ id: "l-1", body: {} }));
    expect(api.post).toHaveBeenLastCalledWith(`${BASE}/consent-lists/l-1/ask`, {});
    expect(keysInvalidated().slice(0, 2)).toEqual([JSON.stringify(CHECKLIST_KEYS.detailOf("l-1")), JSON.stringify(CHECKLIST_KEYS.lists)]);
    api.post.mockRejectedValueOnce(new Error("409"));
    await act(async () => {
      await result.current.ask.mutateAsync({ id: "l-1", body: {} }).catch(() => undefined);
    });
    expect(keysInvalidated().slice(4)).toEqual([JSON.stringify(CHECKLIST_KEYS.detailOf("l-1"))]);
  });

  it("ends a list with no body, and reads it and the lists again whatever came of it", async () => {
    const { wrapper, keysInvalidated } = setup();
    const { result } = renderHook(() => useChecklistActions(), { wrapper });
    await act(() => result.current.close.mutateAsync("l-1"));
    expect(api.post).toHaveBeenCalledWith(`${BASE}/consent-lists/l-1/close`);
    api.post.mockRejectedValueOnce(new Error("404"));
    await act(async () => {
      await result.current.close.mutateAsync("l-2").catch(() => undefined);
    });
    expect(keysInvalidated()).toEqual([
      JSON.stringify(CHECKLIST_KEYS.detailOf("l-1")),
      JSON.stringify(CHECKLIST_KEYS.lists),
      JSON.stringify(CHECKLIST_KEYS.detailOf("l-2")),
      JSON.stringify(CHECKLIST_KEYS.lists),
    ]);
  });
});
