import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePlacementBoard } from "./placement-board-queries";

/**
 * The week's read. The gateway deploys apart from the web, so a board from before the blocks, the warnings or the holds were on it must
 * read as a week with none of them, never as a week the page cannot draw (`undefined.filter`).
 */

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api }));

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
);
const OLD_BOARD = { academicYearId: "y1", placements: [], posts: [], kept: [], meals: [] };

describe("the week's read", () => {
  beforeEach(() => api.get.mockReset());

  it("reads a board from before the blocks, the warnings and the holds as one with none of them", async () => {
    api.get.mockResolvedValue(OLD_BOARD);
    const { result } = renderHook(() => usePlacementBoard("y1"), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data).toMatchObject({ blocks: [], warnings: [], holds: [] });
    expect(api.get).toHaveBeenCalledWith("/api/v1/teaching-requirements/placements/board?academicYearId=y1");
  });

  it("reads each of them on its own: a gateway with the holds and not the warnings has the one and not the other", async () => {
    const hold = { kind: "ROOM_LENT", resourceKind: "ROOM", resourceId: "r1", dayOfWeek: 2, startTime: "09:00", endTime: "10:00", schools: ["Östra skolan"] };
    api.get.mockResolvedValue({ ...OLD_BOARD, holds: [hold] });
    const { result } = renderHook(() => usePlacementBoard("y1"), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.holds).toEqual([hold]);
    expect(result.current.data?.warnings).toEqual([]);
    expect(result.current.data?.blocks).toEqual([]);
  });

  it("keeps what the gateway sends", async () => {
    const warning = { code: "NO_ROOM_FREE", refuses: true, params: { day: 2, start: "10:00", end: "11:00", roomType: "Slöjdsal" }, rowId: "row-1", requirementId: "post-1" };
    api.get.mockResolvedValue({ ...OLD_BOARD, blocks: [{ id: "b1" }], warnings: [warning] });
    const { result } = renderHook(() => usePlacementBoard("y1"), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.warnings).toEqual([warning]);
    expect(result.current.data?.blocks).toEqual([{ id: "b1" }]);
  });

  it("reads nothing before there is a year", () => {
    renderHook(() => usePlacementBoard(null), { wrapper });
    expect(api.get).not.toHaveBeenCalled();
  });
});
