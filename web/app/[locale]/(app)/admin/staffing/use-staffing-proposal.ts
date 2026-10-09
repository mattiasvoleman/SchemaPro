"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { STAFFING_KEYS } from "@/lib/staffing-keys";
import type { LoadModel, LoadStatus } from "@/lib/teacher-load";
import type { StaffingWarning, TeacherQualificationKind } from "@/lib/types";

/*
 * Föreslå bemanning (staffing Fas 4): POST /optimization/staffing/proposal
 * and .../apply, the gateway's staffing-proposal.service.ts.
 *
 * Beside the page, not in lib/staffing-queries.ts, for the reason
 * use-staffing-carry.ts gives: only the proposal dialog calls these, and that
 * module is imported by the drawer, the requirements page and /teacher/tjanst
 * too. The page itself imports nothing from here at runtime — the dialog is
 * React.lazy, and this file loads with it.
 *
 * The types mirror the gateway's answer field for field. Every id is a real
 * one: the gateway sends the engine fresh opaque ids and turns the answer back
 * before it gets here, and every NAME on the dialog comes from the page's own
 * lists — the answer carries none.
 */

/** The engine's secondary weights, each 0..100 (app/schemas/staffing.py StaffWeights). */
export interface StaffWeights {
  balance: number;
  classTeachers: number;
  continuity: number;
  keepCurrent: number;
  unqualified: number;
}

/**
 * The engine's own defaults. A request sends only the weights that differ, so
 * a school that never opens Avancerat asks exactly what the engine would
 * choose — and a future change of default in the engine reaches it.
 */
export const DEFAULT_STAFF_WEIGHTS: StaffWeights = {
  balance: 3,
  classTeachers: 2,
  continuity: 4,
  keepCurrent: 5,
  unqualified: 5,
};

export const STAFF_WEIGHT_KEYS = Object.keys(DEFAULT_STAFF_WEIGHTS) as (keyof StaffWeights)[];

export interface StaffingProposalRequest {
  academicYearId: string;
  onlyUnstaffed: boolean;
  respectQualifications: boolean;
  pinnedRequirementIds?: string[];
  weights?: Partial<StaffWeights>;
}

export type StaffSolveStatus = "OPTIMAL" | "FEASIBLE";
export type StaffUnstaffedReason =
  | "NO_QUALIFIED_TEACHER"
  | "NO_TEACHER_WITH_TARGET"
  | "NO_CAPACITY_LEFT"
  | "NOT_REACHED";

export interface TeacherLoadPoint {
  /** Whole minutes, as the matrix prints them. */
  countedMinutesPerWeek: number;
  /** Two decimals: what a selection is re-judged from. */
  countedExact: number;
  percentOfTarget: number | null;
  status: LoadStatus;
}

export interface ProposalTeacher {
  userId: string;
  targetMinutesPerWeek: number | null;
  /** floor(target × (1 + tolerance/100)): the most the proposal gives anybody. */
  limitMinutesPerWeek: number | null;
  /** No target, target 0 or already over the limit: keeps or gives up only their own rows. */
  keepOrShed: boolean;
  before: TeacherLoadPoint;
  after: TeacherLoadPoint;
}

export interface ProposalAssignment {
  requirementId: string;
  subjectId: string;
  studentGroupId: string;
  /** The lead the row has now; null for a row nobody teaches. */
  fromTeacherId: string | null;
  toTeacherId: string;
  /** What the row charges its lead, exact to two decimals. */
  chargeMinutesPerWeek: number;
  reasons: {
    qualificationKind: TeacherQualificationKind | null;
    familiarWithSubject: boolean;
    taughtLastYear: boolean;
    teachesGroupAlready: boolean;
  };
}

export interface ProposalUnstaffed {
  requirementId: string;
  subjectId: string;
  studentGroupId: string;
  chargeMinutesPerWeek: number;
  reason: StaffUnstaffedReason;
  onlyCoTeacherQualified: boolean;
}

export interface ProposalConflict {
  code: string;
  params: Record<string, string | number>;
  /** The engine's English with the subject's name in it: the fallback sentence. */
  message: string;
  requirementIds: string[];
  requirementNames: string[];
  subjectIds: string[];
  /** Real user ids; the dialog names them from the page's staff list. */
  teacherIds: string[];
}

export interface StaffingProposal {
  status: StaffSolveStatus;
  unstaffedProven: boolean;
  basisSha256: string;
  options: {
    onlyUnstaffed: boolean;
    respectQualifications: boolean;
    respectForcedByPolicy: boolean;
    qualificationsRecorded: boolean;
    pinnedRequirementIds: string[];
  };
  loadModel: LoadModel;
  counts: {
    freeRequirements: number;
    openRequirements: number;
    keptRequirements: number;
    fixedRequirements: number;
    vacated: number;
    inconsistent: number;
    teachersSent: number;
    teachersWithTarget: number;
    teachersWithZeroTarget: number;
    teachersWithoutTarget: number;
  };
  /** Lead CHANGES only. */
  assignments: ProposalAssignment[];
  teachers: ProposalTeacher[];
  unstaffed: ProposalUnstaffed[];
  conflicts: ProposalConflict[];
  terms: unknown;
}

export interface StaffingChange {
  requirementId: string;
  fromTeacherId: string | null;
  toTeacherId: string | null;
}

export interface ApplyStaffingRequest {
  academicYearId: string;
  basisSha256: string;
  undo?: boolean;
  changes: StaffingChange[];
}

/** A WARN the batch was saved with: whom it is about, and the rows that put it there. */
export interface StaffingBatchWarning extends StaffingWarning {
  userId: string;
  requirementIds: string[];
}

export interface StaffingApplyResult {
  updated: number;
  /** The basis AFTER the apply: what its undo sends. */
  basisSha256: string;
  warnings: StaffingBatchWarning[];
  logId: string;
}

/** The gateway's code for "the tjänstefördelning moved since the proposal was read". */
export const STAFF_PROPOSAL_STALE = "STAFF_PROPOSAL_STALE";
/** An engine without /staff yet (deployed separately): "not yet", not the year's 404. */
export const STAFF_ENGINE_UNAVAILABLE = "STAFF_ENGINE_UNAVAILABLE";

/**
 * The proposal. A mutation, not a query: it is a ten-second solve the admin
 * asks for, never something to refetch on focus — and never retried, because
 * a second press is the admin's to make (a time-limited answer may differ).
 */
export function useStaffingProposal() {
  return useMutation({
    retry: false,
    mutationFn: (body: StaffingProposalRequest) =>
      api.post<StaffingProposal>("/api/v1/optimization/staffing/proposal", body),
  });
}

/**
 * Apply, and undo (the same route with the changes swapped and `undo: true`).
 * Whatever the outcome, everything that reads a lead is refetched: the load
 * report, the unstaffed list, the picker's suggestions and the timplansposter
 * — a stale 409 means somebody else wrote, and the page should show that too.
 */
export function useApplyStaffing() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ApplyStaffingRequest) =>
      api.post<StaffingApplyResult>("/api/v1/optimization/staffing/apply", body),
    onSettled: () => {
      for (const queryKey of [
        STAFFING_KEYS.load,
        STAFFING_KEYS.unstaffed,
        STAFFING_KEYS.suggestions,
        ["requirements"],
      ]) {
        void queryClient.invalidateQueries({ queryKey });
      }
    },
  });
}
