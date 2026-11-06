import { afterEach, describe, expect, it, vi } from "vitest";
import { CRISIS_STORAGE_PREFIX, clearCrisisStorage } from "./crisis-storage";
import { LEGACY_KEYS, queueKey, snapshotKey } from "./crisis-queue";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("wiping what Krisläge kept", () => {
  it("removes the queue and the list of every login, and the first version's keys, and nothing that is not Krisläge's", () => {
    localStorage.setItem(queueKey("u-anna"), "[]");
    localStorage.setItem(snapshotKey("u-anna"), "{}");
    localStorage.setItem(queueKey("u-bo"), "[]");
    localStorage.setItem(snapshotKey("u-bo"), "{}");
    for (const key of LEGACY_KEYS) localStorage.setItem(key, "[]");
    localStorage.setItem("schemapro.optimizationWeights", "{}");
    localStorage.setItem("theme", "dark");

    clearCrisisStorage();

    expect(Object.keys(localStorage).sort()).toEqual(["schemapro.optimizationWeights", "theme"]);
  });

  it("is every key the queue module writes that it wipes: they all start with the one prefix", () => {
    for (const key of [queueKey("u"), snapshotKey("u"), ...LEGACY_KEYS]) expect(key.startsWith(CRISIS_STORAGE_PREFIX)).toBe(true);
  });

  it("does nothing, and does not throw, where the storage cannot be used", () => {
    // Blocked site data: reaching for the storage at all throws.
    const blocked = vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(() => clearCrisisStorage()).not.toThrow();
    expect(blocked).toHaveBeenCalled();
    blocked.mockRestore();
    // Removing throws (a locked profile).
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    localStorage.setItem(queueKey("u"), "[]");
    expect(() => clearCrisisStorage()).not.toThrow();
  });

  it("does nothing where there is no storage at all", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(() => clearCrisisStorage()).not.toThrow();
    vi.unstubAllGlobals();
  });
});
