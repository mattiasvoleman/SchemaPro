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
  /**
   * A post that changes during the year is planned on its tightest period:
   * its dates, and target, limit, before and after are that period's.
   */
  period?: { from: string; to: string };
  /**
   * The same post stretch by stretch, the planned one at plannedStretch: the
   * apply judges each with weeks and a target, so the dialog does too.
   */
  stretches?: ProposalStretch[];
  plannedStretch?: number;
  before: TeacherLoadPoint;
  after: TeacherLoadPoint;
  /**
   * The ordinance's highest level of teaching time (SFS 2026:1487 3 §), in clock hours over the läsår, before and after the WHOLE
   * proposal: present when the school's mode is not OFF. `highestHours` is the span times the post, so null without HR-läs.
   * Computed by the gateway (src/staffing/assignment-scope.ts); the dialog does not re-judge it under a partial selection.
   */
  scope?: { hoursBefore: number; hoursAfter: number; highestHours: number | null; overBefore: boolean; overAfter: boolean };
}

/** One stretch of a changing post, its minutes exact to two decimals. */
export interface ProposalStretch {
  from: string;
  to: string;
  weeks: number;
  targetMinutesPerWeek: number | null;
  before: number;
  after: number;
}

/**
 * What a change of lead gives the teacher that they do not teach today (leads, co-leads or take lessons of a post):
 * the subject, and the years (a grade each, ascending). The gateway's new-teaching.ts.
 */
export interface NewTeaching {
  /** The teacher teaches no post of this subject today. */
  subject: boolean;
  /** Years of the post the teacher teaches none of today; empty when the post has no year. */
  years: number[];
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
  /**
   * What the row charges each stretch of the side's post, in the order of its
   * `stretches`, where that post changes during the year.
   */
  toStretchCharges?: number[];
  fromStretchCharges?: number[];
  /**
   * Present only when the change gives `toTeacherId` a subject or a year they do not teach today. The apply asks for a
   * second confirmation of every such row (ApplyStaffingRequest.confirmedNewTeaching).
   */
  newTeaching?: NewTeaching;
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
  /**
   * NO_CAPACITY_LEFT on a dated row: the posts that change during the year
   * which could otherwise have taken it, and which a dated row never gets.
   */
  excludedChanging?: string[];
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
    /** Posts of the year the school has released for the engine (släppt för motorn) that a teacher it chose leads: the ones a release is for. */
    releasedRequirements: number;
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
  /**
   * The reader may not see when and how a post changes (Roller i skolan):
   * every teacher is stated over the year, while the apply judges a changing
   * post per stretch. One flag for the answer, never one per teacher.
   */
  hrHidden?: true;
}

export interface StaffingChange {
  requirementId: string;
  fromTeacherId: string | null;
  toTeacherId: string | null;
}

/** The second confirmation of one change that gives a teacher new teaching: the row, and the teacher it is given to. */
export interface ConfirmedNewTeaching {
  requirementId: string;
  toTeacherId: string;
}

export interface ApplyStaffingRequest {
  academicYearId: string;
  basisSha256: string;
  /**
   * `basisSha256` is the digest that covers the week as well as the proposal (the one the week before and after returned
   * for the figure shown): the apply reads the week again under its lock and is refused as stale if it has changed since.
   * Left out, the proposal's own basis, as it always was.
   */
  coversWeek?: boolean;
  undo?: boolean;
  changes: StaffingChange[];
  /**
   * One entry for every change of `changes` that has `newTeaching` in the proposal; an apply without a matching entry
   * is refused 409 STAFF_NEW_TEACHING_UNCONFIRMED. Left out on an undo, which puts back what was.
   */
  confirmedNewTeaching?: ConfirmedNewTeaching[];
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
/**
 * An apply that gives a teacher a subject or a year they do not teach today, for a change the request has not confirmed.
 * Flat params: `count`, `requirementId`, `userId`, `newSubject` (0|1) and `newYears` ("8,9") of the first.
 */
export const STAFF_NEW_TEACHING_UNCONFIRMED = "STAFF_NEW_TEACHING_UNCONFIRMED";
/**
 * An apply that moves a post whose teacher the school chose and has not released for the engine (params `requirementId`).
 * A proposal never holds one, so only a request made by hand gets this.
 */
export const STAFF_ROW_NOT_RELEASED = "STAFF_ROW_NOT_RELEASED";
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
