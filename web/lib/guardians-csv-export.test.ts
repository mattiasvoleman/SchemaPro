import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { api } from "@/lib/api";
import { guardiansCsvFor, guardiansToCsv } from "@/lib/guardians-csv-export";
import { mapGuardianRows, parseCsv } from "@/lib/csv";

vi.mock("@/lib/api", () => ({ api: { get: vi.fn() } }));

const get = (api as unknown as { get: Mock }).get;

const link = {
  firstName: "Gun",
  lastName: "Berg",
  email: "gun@skola.se",
  phone: "070-123 45 67",
  studentEmail: "alma@skola.se",
};

describe("vardnadshavare.csv's export", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads the school's links in one request, at the call, and writes the file the importer reads", async () => {
    get.mockResolvedValue([link, { ...link, phone: null, studentEmail: "nils@skola.se" }]);

    const file = await guardiansCsvFor();

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("/api/v1/guardian-links/export");
    expect(file).not.toBeNull();
    expect(mapGuardianRows(parseCsv(file!))).toMatchObject({
      errors: [],
      rows: [link, { ...link, phone: null, studentEmail: "nils@skola.se" }],
    });
  });

  it("answers null for a school with no link, rather than a file that is only a header", async () => {
    get.mockResolvedValue([]);

    expect(await guardiansCsvFor()).toBeNull();
  });

  it("lets a failed read fail: the page says so, a file that looks complete would not", async () => {
    get.mockRejectedValue(new Error("HTTP 500"));

    await expect(guardiansCsvFor()).rejects.toThrow("HTTP 500");
  });

  it("writes the five columns, an empty cell for a phone nobody wrote", () => {
    expect(guardiansToCsv([{ ...link, phone: null }])).toBe(
      "﻿fornamn;efternamn;epost;telefon;elev_epost\r\nGun;Berg;gun@skola.se;;alma@skola.se\r\n",
    );
  });
});
