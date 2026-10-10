import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { ApiError, api } from "@/lib/api";
import { draftPendingFor } from "@/lib/publication-draft-notice";
import { errorCode, publicationErrorText } from "@/lib/publication-messages";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { get: vi.fn() } };
});
const get = api.get as unknown as Mock;

const state = (overrides: Record<string, unknown> = {}) => ({
  academicYearId: "y",
  publishMode: "DRAFT",
  publicationId: "p",
  added: [],
  changed: [],
  removed: [],
  pendingRemovals: 0,
  ...overrides,
});

describe("draftPendingFor", () => {
  beforeEach(() => get.mockReset());

  it("asks nothing more of a school that publishes directly", async () => {
    get.mockResolvedValueOnce({ publishMode: "DIRECT" });
    await expect(draftPendingFor("y")).resolves.toBe(false);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("marks a draft that differs from what is published, removals included", async () => {
    get.mockResolvedValueOnce({ publishMode: "DRAFT" }).mockResolvedValueOnce(state({ added: [{ id: "l" }] }));
    await expect(draftPendingFor("y")).resolves.toBe(true);
    expect(get).toHaveBeenLastCalledWith("/api/v1/publications/state?academicYearId=y");
    get.mockResolvedValueOnce({ publishMode: "DRAFT" }).mockResolvedValueOnce(state({ pendingRemovals: 2 }));
    await expect(draftPendingFor("y")).resolves.toBe(true);
    get.mockResolvedValueOnce({ publishMode: "DRAFT" }).mockResolvedValueOnce(state());
    await expect(draftPendingFor("y")).resolves.toBe(false);
  });

  it("lets the export through unmarked when the reads fail", async () => {
    get.mockRejectedValueOnce(new ApiError(500, "boom"));
    await expect(draftPendingFor("y")).resolves.toBe(false);
  });
});

describe("publicationErrorText", () => {
  const t = Object.assign((key: string, values?: Record<string, string | number>) => `${key}${values ? JSON.stringify(values) : ""}`, {
    has: (key: string) => key !== "UNKNOWN_CODE",
  });

  it("renders a known code in the reader's language with the gateway's params", () => {
    const error = new ApiError(400, "Ett utkast publiceras från i dag …", "PUBLISH_FROM_IN_PAST", { today: "2026-10-10" });
    expect(publicationErrorText(t, error, "fel")).toBe('PUBLISH_FROM_IN_PAST{"today":"2026-10-10"}');
    expect(errorCode(error)).toBe("PUBLISH_FROM_IN_PAST");
  });

  it("falls back to the gateway's sentence for an untranslated code, and to the fallback for nothing", () => {
    expect(publicationErrorText(t, new ApiError(409, "Gatewayens mening.", "UNKNOWN_CODE"), "fel")).toBe("Gatewayens mening.");
    expect(publicationErrorText(t, new Error("nät"), "fel")).toBe("nät");
    expect(publicationErrorText(t, "?", "fel")).toBe("fel");
    expect(errorCode(new Error("x"))).toBeUndefined();
  });
});
