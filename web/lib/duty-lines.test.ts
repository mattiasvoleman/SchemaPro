import { describe, expect, it } from "vitest";
import { keepsTimesAllYear } from "./duty-lines";

const year = { startDate: "2026-08-17", endDate: "2027-06-11" };
const slot = { dayOfWeek: 2, startTime: "15:00", endTime: "16:00" };

describe("keepsTimesAllYear", () => {
  it("is an uppdrag with times whose Från or Till shortens it inside the läsår", () => {
    expect(keepsTimesAllYear({ validFrom: "2027-01-07", validTo: null, slots: [slot] }, year)).toBe(true);
    expect(keepsTimesAllYear({ validFrom: null, validTo: "2026-12-18", slots: [slot] }, year)).toBe(true);
    expect(keepsTimesAllYear({ validFrom: "2026-09-01", validTo: "2026-09-30", slots: [slot] }, year)).toBe(true);
  });

  it("is no uppdrag without times, undated, or dated on the läsår's own bounds", () => {
    expect(keepsTimesAllYear({ validFrom: "2027-01-07", validTo: null, slots: [] }, year)).toBe(false);
    expect(keepsTimesAllYear({ validFrom: "2027-01-07", validTo: null }, year)).toBe(false);
    expect(keepsTimesAllYear({ validFrom: null, validTo: null, slots: [slot] }, year)).toBe(false);
    expect(keepsTimesAllYear({ validFrom: "2026-08-17", validTo: "2027-06-11", slots: [slot] }, year)).toBe(false);
  });

  it("reads a year that came as timestamps by its day", () => {
    const stamped = { startDate: "2026-08-17T00:00:00.000Z", endDate: "2027-06-11T00:00:00.000Z" };
    expect(keepsTimesAllYear({ validFrom: "2026-08-17", validTo: "2027-06-11", slots: [slot] }, stamped)).toBe(false);
    expect(keepsTimesAllYear({ validFrom: null, validTo: "2027-06-10", slots: [slot] }, stamped)).toBe(true);
  });

  it("counts any date while the year is not known, saying it once too often rather than once too few", () => {
    expect(keepsTimesAllYear({ validFrom: "2026-08-17", validTo: null, slots: [slot] }, null)).toBe(true);
    expect(keepsTimesAllYear({ validFrom: null, validTo: null, slots: [slot] }, undefined)).toBe(false);
  });
});
