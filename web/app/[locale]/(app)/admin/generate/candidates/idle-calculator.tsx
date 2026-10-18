"use client";

import { useEffect, useMemo } from "react";
import type { IdleComparison, IdleSummary } from "@/lib/candidates/idle";
import { idleContextOf, idleOf, type IdleInputs } from "@/lib/candidates/idle-run";
import type { MasterLesson } from "@/lib/types";

export interface IdleCalculatorProps {
  inputs: IdleInputs;
  /** The grundschema as it stands. */
  current: readonly MasterLesson[];
  /** Each candidate's grundschema as it would stand after an apply. */
  candidates: ReadonlyArray<{ id: string; week: readonly MasterLesson[] }>;
  onResult: (result: IdleComparison) => void;
}

/*
 * The håltimmar of every week on the compare page, computed. React.lazy
 * (never next/dynamic, whose loader costs 1.4 KB of its own), because this
 * is what brings lib/gaps.ts and the conflict engine in: the page draws its
 * table first and fills these two rows when the module has arrived.
 *
 * It draws nothing. The figures belong to cells all over the table, so they
 * travel up to the page rather than this module owning the markup — which
 * also means the table is never torn down and rebuilt when the module lands,
 * and a reader's focus inside it stays put.
 *
 * In an effect, not in render: findIdleGaps over a whole school takes tens
 * of milliseconds per week, five weeks at most, and the page should paint
 * before that is spent. A week already measured against the same school is
 * not measured again when another candidate's lessons arrive.
 */
export default function IdleCalculator({ inputs, current, candidates, onResult }: IdleCalculatorProps) {
  const context = useMemo(() => idleContextOf(inputs), [inputs]);
  const measured = useMemo(() => new WeakMap<readonly MasterLesson[], IdleSummary>(), [context]);

  useEffect(() => {
    const measure = (week: readonly MasterLesson[]) => {
      const known = measured.get(week);
      if (known) return known;
      const summary = idleOf(week, context);
      measured.set(week, summary);
      return summary;
    };
    onResult({
      current: measure(current),
      byCandidate: new Map(candidates.map((candidate) => [candidate.id, measure(candidate.week)])),
    });
  }, [context, measured, current, candidates, onResult]);

  return null;
}
