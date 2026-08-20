import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { api } from "@/lib/api";
import { IMPORT_MAX_ROWS, importCsvInBatches } from "@/lib/queries";

vi.mock("@/lib/api", () => ({
  api: { post: vi.fn(), get: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

const post = (api as unknown as { post: Mock }).post;

/**
 * A school's file is bigger than one request may carry: 5400 teaching-group
 * memberships is an ordinary secondary school, and the endpoint takes 2000.
 * The upload is split — and the merged report must stay truthful about which
 * line of the ORIGINAL file each error belongs to, because the admin fixes
 * rows in their spreadsheet, not in our batches.
 */

const YEAR = "44444444-4444-4444-8444-444444444444";

const memberships = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    groupName: "Ma71",
    email: `elev${i}@exempelskolan.se`,
  }));

const bodies = () =>
  post.mock.calls.map(([, body]) => body as { rows: unknown[] });

describe("importCsvInBatches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    post.mockResolvedValue({ created: 0, skipped: 0, errors: [] });
  });

  it("mirrors the row caps the API DTOs declare", () => {
    expect(IMPORT_MAX_ROWS).toEqual({
      students: 500,
      teachers: 500,
      classes: 500,
      teachingGroups: 2000,
      roomTypes: 200,
    });
  });

  it("splits a 5400-row file into batches no larger than the cap", async () => {
    await importCsvInBatches({
      kind: "teachingGroups",
      academicYearId: YEAR,
      rows: memberships(5400),
    });

    expect(post).toHaveBeenCalledTimes(3);
    expect(bodies().map((body) => body.rows.length)).toEqual([2000, 2000, 1400]);
    // Nothing is dropped and nothing is sent twice.
    const sent = bodies().flatMap((body) => body.rows as { email: string }[]);
    expect(sent).toHaveLength(5400);
    expect(new Set(sent.map((row) => row.email)).size).toBe(5400);
  });

  it("sends a single request when the file already fits", async () => {
    await importCsvInBatches({
      kind: "teachingGroups",
      academicYearId: YEAR,
      rows: memberships(2000),
    });

    expect(post).toHaveBeenCalledTimes(1);
  });

  it("sums created and skipped across batches", async () => {
    post
      .mockResolvedValueOnce({ created: 2000, skipped: 0, errors: [] })
      .mockResolvedValueOnce({ created: 1900, skipped: 100, errors: [] })
      .mockResolvedValueOnce({ created: 1400, skipped: 0, errors: [] });

    const report = await importCsvInBatches({
      kind: "teachingGroups",
      academicYearId: YEAR,
      rows: memberships(5400),
    });

    expect(report).toMatchObject({ created: 5300, skipped: 100, errors: [] });
  });

  it("shifts error row numbers back onto the original file's lines", async () => {
    post
      .mockResolvedValueOnce({ created: 1999, skipped: 0, errors: [{ row: 7, message: "fel" }] })
      .mockResolvedValueOnce({ created: 1999, skipped: 0, errors: [{ row: 5, message: "fel" }] })
      .mockResolvedValueOnce({ created: 1400, skipped: 0, errors: [] });

    const report = await importCsvInBatches({
      kind: "teachingGroups",
      academicYearId: YEAR,
      rows: memberships(5400),
    });

    // Batch 2's row 5 is line 2005 of the file — reporting it as row 5 would
    // send the admin to the wrong line entirely.
    expect(report.errors).toEqual([
      { row: 7, message: "fel" },
      { row: 2005, message: "fel" },
    ]);
  });

  it("keeps what succeeded when a later batch fails, and says where it stopped", async () => {
    post
      .mockResolvedValueOnce({ created: 2000, skipped: 0, errors: [] })
      .mockRejectedValueOnce(new Error("För många förfrågningar"));

    const report = await importCsvInBatches({
      kind: "teachingGroups",
      academicYearId: YEAR,
      rows: memberships(5400),
    });

    expect(post).toHaveBeenCalledTimes(2); // stops, does not plough on
    expect(report.created).toBe(2000);
    expect(report.errors).toEqual([
      { row: 2001, message: "För många förfrågningar" },
    ]);
  });

  it("posts batches one after another, never overlapping", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    post.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return { created: 0, skipped: 0, errors: [] };
    });

    await importCsvInBatches({
      kind: "teachingGroups",
      academicYearId: YEAR,
      rows: memberships(5400),
    });

    // Parallel batches would trade a working import for a 429, and would fan
    // out invitation emails faster than the rate limit allows.
    expect(maxInFlight).toBe(1);
  });

  it("omits the year for a kind that has none, in every batch", async () => {
    await importCsvInBatches({
      kind: "roomTypes",
      academicYearId: YEAR,
      rows: Array.from({ length: 250 }, (_, i) => ({ name: `Sal ${i}` })),
    });

    expect(post).toHaveBeenCalledTimes(2);
    for (const body of bodies()) {
      expect(body).not.toHaveProperty("academicYearId");
    }
  });
});
