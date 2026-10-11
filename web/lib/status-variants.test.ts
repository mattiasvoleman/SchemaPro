import { describe, expect, it } from "vitest";
import {
  ABSENCE_PHASE_VARIANT,
  ATTENDANCE_STATUS_VARIANT,
  BOOKING_STATUS_VARIANT,
  COVER_STATUS_VARIANT,
  KEY_STATE_VARIANT,
  LEAVE_STATUS_VARIANT,
  LINK_STATE_VARIANT,
  LOAD_STATUS_VARIANT,
  PLAN_STATUS_VARIANT,
  SYNC_RUN_VARIANT,
  VALIDITY_VARIANT,
  YEAR_STATUS_VARIANT,
  attendanceRateVariant,
  solverRunVariant,
  type StatusVariant,
} from "./status-variants";

const ALLOWED: StatusVariant[] = ["success", "warning", "destructive", "secondary", "outline"];

describe("status variants", () => {
  it("uses only the five semantic variants, never default", () => {
    for (const map of [
      ABSENCE_PHASE_VARIANT,
      ATTENDANCE_STATUS_VARIANT,
      BOOKING_STATUS_VARIANT,
      COVER_STATUS_VARIANT,
      KEY_STATE_VARIANT,
      LEAVE_STATUS_VARIANT,
      LINK_STATE_VARIANT,
      LOAD_STATUS_VARIANT,
      PLAN_STATUS_VARIANT,
      SYNC_RUN_VARIANT,
      VALIDITY_VARIANT,
      YEAR_STATUS_VARIANT,
    ]) {
      for (const variant of Object.values(map)) expect(ALLOWED).toContain(variant);
    }
  });

  it("calls a draft timplan a warning: it needs a decision", () => {
    expect(PLAN_STATUS_VARIANT.DRAFT).toBe("warning");
    expect(PLAN_STATUS_VARIANT.DECIDED).toBe("success");
  });

  it("calls anything revoked outline: finished, not failed", () => {
    expect(KEY_STATE_VARIANT.REVOKED).toBe("outline");
    expect(LINK_STATE_VARIANT.REVOKED).toBe("outline");
  });

  it("keeps the cover family's and the staffing badge's colours, which the manual names", () => {
    expect(COVER_STATUS_VARIANT).toEqual({
      OPEN: "warning",
      COVERED: "success",
      CANCELLED: "secondary",
      HANDLED_SUPERVISED_STUDY: "secondary",
      HANDLED_CO_TEACHER: "secondary",
      PASSED: "destructive",
    });
    expect(LOAD_STATUS_VARIANT).toEqual({ OVER: "destructive", UNDER: "warning", OK: "success", NO_TARGET: "outline" });
  });

  it("asks for a decision on pending bookings and leave", () => {
    expect(BOOKING_STATUS_VARIANT.PENDING).toBe("warning");
    expect(LEAVE_STATUS_VARIANT.PENDING).toBe("warning");
    expect(LEAVE_STATUS_VARIANT.REJECTED).toBe("destructive");
  });

  it("calls an excused absence information", () => {
    expect(ATTENDANCE_STATUS_VARIANT.EXCUSED).toBe("secondary");
    expect(ATTENDANCE_STATUS_VARIANT.ABSENT).toBe("destructive");
  });
});

describe("solverRunVariant", () => {
  it("reads a failed job first, then the verdict, then the job's state", () => {
    expect(solverRunVariant({ status: "FAILED", solverStatus: "OPTIMAL" })).toBe("destructive");
    expect(solverRunVariant({ status: "SUCCEEDED", solverStatus: "INFEASIBLE" })).toBe("warning");
    expect(solverRunVariant({ status: "SUCCEEDED", solverStatus: "TIMEOUT" })).toBe("warning");
    expect(solverRunVariant({ status: "SUCCEEDED", solverStatus: "FEASIBLE" })).toBe("success");
    expect(solverRunVariant({ status: "RUNNING", solverStatus: null })).toBe("secondary");
  });
});

describe("attendanceRateVariant", () => {
  it("keeps the report's thresholds", () => {
    expect(attendanceRateVariant(null)).toBe("outline");
    expect(attendanceRateVariant(0.95)).toBe("success");
    expect(attendanceRateVariant(0.9)).toBe("success");
    expect(attendanceRateVariant(0.8)).toBe("warning");
    expect(attendanceRateVariant(0.75)).toBe("warning");
    expect(attendanceRateVariant(0.5)).toBe("destructive");
  });
});
