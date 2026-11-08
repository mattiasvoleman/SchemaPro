import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { REQUIREMENT_PLACEMENTS_KEY } from "./requirement-placements";
import {
  fetchPlacementsOf,
  invalidatePlacements,
  placementsOfKey,
  savePlacements,
} from "./requirement-placements-api";

/**
 * Förlagda poster, as the dialog reads and writes one post. The requests are
 * recorded and answered; the module is held to the paths it asks and the body
 * it sends.
 */

const calls = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: { get: calls.get, put: calls.put },
}));

const row = {
  id: "p1",
  requirementId: "r1",
  dayOfWeek: 2,
  startTime: "10:00",
  endTime: "11:00",
  minutes: 60,
  roomId: "room-1",
  roomName: "Simhallen",
  recurrence: "ALL_WEEKS" as const,
};

beforeEach(() => {
  calls.get.mockReset();
  calls.put.mockReset();
});

describe("one post's placed lessons", () => {
  it("reads the rows and their verdicts from the post's own route", async () => {
    const answer = { placements: [row], verdicts: [{ index: 0, ok: true }] };
    calls.get.mockResolvedValue(answer);

    await expect(fetchPlacementsOf("r 1")).resolves.toBe(answer);
    expect(calls.get).toHaveBeenCalledWith("/api/v1/teaching-requirements/r%201/placements");
  });

  it("replaces the rows with a PUT of the whole list, and an empty list takes them all away", async () => {
    calls.put.mockResolvedValue({ placements: [], verdicts: [] });
    const input = { dayOfWeek: 2, startTime: "10:00", minutes: 60, roomId: "room-1", recurrence: "ODD_WEEKS" as const };

    await savePlacements("r1", [input]);
    expect(calls.put).toHaveBeenLastCalledWith("/api/v1/teaching-requirements/r1/placements", { placements: [input] });

    await savePlacements("r1", []);
    expect(calls.put).toHaveBeenLastCalledWith("/api/v1/teaching-requirements/r1/placements", { placements: [] });
  });

  it("keeps each post's read under the prefix a write invalidates", async () => {
    expect(placementsOfKey("r1").slice(0, REQUIREMENT_PLACEMENTS_KEY.length)).toEqual([...REQUIREMENT_PLACEMENTS_KEY]);

    const client = new QueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    await invalidatePlacements(client);
    expect(spy).toHaveBeenCalledWith({ queryKey: REQUIREMENT_PLACEMENTS_KEY });
  });
});
