import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import sv from "../messages/sv.json";
import en from "../messages/en.json";
import { parseCsv } from "@/lib/csv";
import { scbCsv } from "./scb-csv";
import { scbFilePath, SCB_MISSING_FIELDS } from "./scb-file";

/**
 * The gateway's builder, read as text: its notice codes and missing fields
 * are what the answer can carry, so each must have a sentence in both
 * languages and a place in this module's types.
 */
const builder = readFileSync(path.resolve(__dirname, "../../src/staffing/scb/scb-pedpers.ts"), "utf8");
const listed = (pattern: RegExp): string[] => {
  const block = pattern.exec(builder)?.[1] ?? "";
  return [...block.matchAll(/'([A-Z0-9_]+)'/g)].map((match) => match[1]!);
};
const GATEWAY_NOTICES = listed(/export type ScbNoticeCode =([\s\S]*?);/);
const GATEWAY_MISSING = listed(/export const SCB_MISSING_FIELDS = \[([\s\S]*?)\]/);

const columns = ["System", "Datum", "Version", "SkolenhetsKod", "PersonNr", "PersonNamn"];

describe("the SCB file in the browser", () => {
  it("asks the gateway for the chosen year's file", () => {
    expect(scbFilePath("a b")).toBe("/api/v1/staffing/scb-file?academicYearId=a%20b");
  });

  it("writes the gateway's rows as a CSV for Excel: SCB's names as the header, BOM, semicolons, CRLF", () => {
    const csv = scbCsv({
      columns,
      rows: [
        ["Rastra Schema", "2026-10-15", "0.1.0", "12345678", "", "Anna Öberg"],
        ["Rastra Schema", "2026-10-15", "0.1.0", "", "", "=Bo Alm"],
      ],
    });
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv.endsWith("\r\n")).toBe(true);
    const parsed = parseCsv(csv);
    expect(parsed.headers).toEqual(columns);
    expect(parsed.rows[0]).toEqual(["Rastra Schema", "2026-10-15", "0.1.0", "12345678", "", "Anna Öberg"]);
    // Excel's formula guard belongs to the CSV, never to SCB's .txt.
    expect(csv).toContain("'=Bo Alm");
  });

  it("knows every field the gateway can list a row for, and says each in both languages", () => {
    expect(GATEWAY_MISSING.length).toBeGreaterThan(0);
    expect([...SCB_MISSING_FIELDS]).toEqual(GATEWAY_MISSING);
    for (const messages of [sv, en]) {
      expect(Object.keys(messages.reports.staffing.scb.missing).sort()).toEqual([...GATEWAY_MISSING].sort());
    }
  });

  it("has a sentence in both languages for every notice the gateway can send, and none it cannot", () => {
    expect(GATEWAY_NOTICES.length).toBeGreaterThan(10);
    for (const messages of [sv, en]) {
      expect(Object.keys(messages.reports.staffing.scb.notice).sort()).toEqual([...GATEWAY_NOTICES].sort());
    }
  });
});
