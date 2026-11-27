import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import {
  browserProfile,
  DEFAULT_WEIGHTS,
  LOCAL_KEY,
  SAVE_AFTER_MS,
  useOptimizationProfile,
} from "./use-optimization-profile";

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api }));
const toast = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
const whoami = vi.hoisted(() => ({ adminProfile: "FULL" as string }));
vi.mock("@/components/profile-context", () => ({ useProfile: () => ({ profile: { adminProfile: whoami.adminProfile } }) }));

/*
 * Optimeringsprofilen as the Generera page holds it (P5): the school's, read when the page opens and saved half a second after the last
 * move of a slider; what the browser held before is given to a school that has none, once.
 */

const SCHOOLS = { preferredFree: 20, preferredBusy: 1, disruption: 9, spread: 4, teacherGap: 3 };
const view = (weights = SCHOOLS, stored = true) => ({ weights, stored, updatedAt: stored ? "2026-11-26T08:00:00.000Z" : null });

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderHook(() => useOptimizationProfile(), { wrapper });
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  api.get.mockReset();
  api.put.mockReset();
  toast.error.mockReset();
  window.localStorage.clear();
  whoami.adminProfile = "FULL";
});

describe("browserProfile: what the browser held", () => {
  it("is the five weights the page saved there, whole numbers 0..1000", () => {
    expect(browserProfile(JSON.stringify(SCHOOLS))).toEqual(SCHOOLS);
    expect(browserProfile(JSON.stringify({ spread: 7 }))).toEqual({ ...DEFAULT_WEIGHTS, spread: 7 });
  });

  it.each([[null], [""], ["not json"], ["[]"], ["{}"], [JSON.stringify({ spread: 1001 })], [JSON.stringify({ spread: -1 })], [JSON.stringify({ spread: 2.5 })], [JSON.stringify({ spread: "3" })]])(
    "is nothing for %p",
    (raw) => {
      expect(browserProfile(raw as string | null)).toBeNull();
    },
  );
});

describe("useOptimizationProfile", () => {
  it("starts at the defaults and takes the school's profile when it has been read, writing nothing", async () => {
    api.get.mockResolvedValue(view());
    const { result } = mount();
    expect(result.current.weights).toEqual(DEFAULT_WEIGHTS);
    await waitFor(() => expect(result.current.weights).toEqual(SCHOOLS));
    expect(result.current.status).toBe("idle");
    expect(api.put).not.toHaveBeenCalled();
  });

  it("saves the whole profile once, half a second after the last move, however many moves a drag made", async () => {
    api.get.mockResolvedValue(view());
    api.put.mockResolvedValue(view({ ...SCHOOLS, spread: 12 }));
    const { result } = mount();
    await waitFor(() => expect(result.current.weights).toEqual(SCHOOLS));
    act(() => {
      for (const value of [5, 8, 12]) result.current.setWeight("spread", value);
    });
    expect(result.current.weights.spread).toBe(12);
    expect(api.put).not.toHaveBeenCalled();
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1), { timeout: SAVE_AFTER_MS + 2000 });
    expect(api.put).toHaveBeenCalledWith("/api/v1/optimization/profile", { ...SCHOOLS, spread: 12 });
    await waitFor(() => expect(result.current.status).toBe("saved"));
  });

  it("says the save failed and keeps the sliders where they were put", async () => {
    api.get.mockResolvedValue(view());
    api.put.mockRejectedValue(new ApiError(500, "Servern svarade inte", undefined));
    const { result } = mount();
    await waitFor(() => expect(result.current.weights).toEqual(SCHOOLS));
    act(() => result.current.setWeight("teacherGap", 40));
    await waitFor(() => expect(result.current.status).toBe("failed"), { timeout: SAVE_AFTER_MS + 2000 });
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(result.current.weights.teacherGap).toBe(40);
  });

  it("gives a school that has no profile the one this browser held, once, and the browser forgets it when the school has it", async () => {
    window.localStorage.setItem(LOCAL_KEY, JSON.stringify(SCHOOLS));
    api.get.mockResolvedValue(view(DEFAULT_WEIGHTS, false));
    api.put.mockResolvedValue(view());
    const { result } = mount();
    await waitFor(() => expect(result.current.weights).toEqual(SCHOOLS));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(api.put).toHaveBeenCalledWith("/api/v1/optimization/profile", SCHOOLS);
    await waitFor(() => expect(window.localStorage.getItem(LOCAL_KEY)).toBeNull());
  });

  it("keeps what the browser held when the school's save of it fails, to try again at the next visit", async () => {
    window.localStorage.setItem(LOCAL_KEY, JSON.stringify(SCHOOLS));
    api.get.mockResolvedValue(view(DEFAULT_WEIGHTS, false));
    api.put.mockRejectedValue(new ApiError(500, "Servern svarade inte", undefined));
    const { result } = mount();
    await waitFor(() => expect(result.current.status).toBe("failed"));
    expect(window.localStorage.getItem(LOCAL_KEY)).not.toBeNull();
  });

  it("lets the school's profile win over the browser's, and drops the browser's, when the school has one", async () => {
    window.localStorage.setItem(LOCAL_KEY, JSON.stringify({ ...SCHOOLS, spread: 99 }));
    api.get.mockResolvedValue(view());
    const { result } = mount();
    await waitFor(() => expect(result.current.weights).toEqual(SCHOOLS));
    expect(api.put).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(LOCAL_KEY)).toBeNull();
  });

  it("writes nothing for a reader (a profile that writes no Schemaläggning): the sliders are not offered and nothing is given to the school", async () => {
    whoami.adminProfile = "LASARE";
    window.localStorage.setItem(LOCAL_KEY, JSON.stringify(SCHOOLS));
    api.get.mockResolvedValue(view(DEFAULT_WEIGHTS, false));
    const { result } = mount();
    await waitFor(() => expect(result.current.status).toBe("idle"));
    expect(result.current.canSave).toBe(false);
    act(() => result.current.setWeight("spread", 30));
    await act(() => wait(SAVE_AFTER_MS + 200));
    expect(api.put).not.toHaveBeenCalled();
    // The läsare's own browser is not emptied for a profile it could not give.
    expect(window.localStorage.getItem(LOCAL_KEY)).not.toBeNull();
  });

  it("keeps the move a reader made before the school's profile came, and does not write it over the school's", async () => {
    let answer!: (value: unknown) => void;
    api.get.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    api.put.mockResolvedValue(view({ ...SCHOOLS, spread: 33 }));
    const { result } = mount();
    act(() => result.current.setWeight("spread", 33));
    await act(async () => answer(view()));
    expect(result.current.weights.spread).toBe(33);
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1), { timeout: SAVE_AFTER_MS + 2000 });
  });
});
