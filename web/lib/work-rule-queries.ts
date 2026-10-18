"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { selectAll } from "@/lib/queries";
import type { TeacherWorkRule } from "@/lib/types";
import type { WorkRuleBody } from "@/lib/teacher-work-rules";

// ---------------------------------------------------------------------------
// Arbetstid: the teachers' work rules (TeacherWorkRules)
//
// A module of its own, not a section of lib/queries.ts, for the bundle — the
// reason lib/staffing-queries.ts gives. Every client page imports
// lib/queries.ts, and these two hooks sat in the slice of it that every admin
// route loads, though only /admin/people reads the rules and only its lazy
// Arbetstid dialog writes them. Lärarens dag (20261123090000) lengthened the
// select by two columns, which took /admin/requirements to 189.98KB own JS,
// 18 bytes under its 190KB budget; with the hooks here it measured 189.87KB
// and /admin/timetable 189.65KB (2026-10-17). They are paid for by the page
// and the dialog that use them.
// ---------------------------------------------------------------------------

/**
 * What each teacher's own working time is — the lunch owed, the night
 * between two teaching days, the day's cap on teaching and the weekday they
 * would rather have free.
 *
 * School-scoped like the raster, and for the same reason: an employment term
 * follows the person, not one läsår, and re-entering every teacher's lunch
 * each August is how a school ends up entering none.
 *
 * ONE ROW PER TEACHER AT MOST, and a teacher with no row is the normal case —
 * the table is empty for every school that has not opened the dialog. Callers
 * must therefore look a rule UP by userId and treat "not found" as "no rule",
 * never index a dense array by teacher.
 */
export function useTeacherWorkRules() {
  return useQuery({
    queryKey: ["teacher-work-rules"],
    queryFn: () =>
      selectAll<TeacherWorkRule>(
        "TeacherWorkRules",
        // Every field the form writes. A column missing from this list is
        // invisible to the page — the form would draw it empty and the next
        // save would clear a rule the school set a term ago. The day's cap and
        // the free-day wish (20261123090000) included: the dialog sends every
        // key, so a cap left out here would be cleared by the next lunch saved.
        "id, userId, lunchMinutes, lunchStartTime, lunchEndTime, minDailyRestMinutes, maxTeachingMinutesPerDay, preferredFreeDayOfWeek",
        "userId",
      ),
  });
}

/**
 * A teacher's working time: written, and taken away again.
 *
 * NOT `useCrudMutations`, and the difference is the endpoint's shape rather than
 * a preference. The table holds at most one row per teacher, so the gateway
 * offers no collection to post into: `PUT /:userId` upserts that teacher's row
 * and `DELETE /:userId` removes it, both keyed by the TEACHER's id and never by
 * the row's. A caller that sent the row id would address a resource that does
 * not exist at that path, and would 404 for the one teacher whose rule it was
 * trying to change.
 *
 * `remove` is not an afterthought. A row of nulls is legal — the table's
 * CHECK allows it — and would read back as "no rule", so clearing the form could
 * have been a PUT of nothing. It is a DELETE because the school's own question
 * is which of its teachers have a working time set, and a table where half the
 * rows mean nothing cannot answer it by counting.
 */
export function useTeacherWorkRuleActions() {
  const queryClient = useQueryClient();
  const invalidate = () => {
    // Only this cache. A rule is not part of the person row, and invalidating
    // ["people"] would refetch the school's longest list on every lunch saved.
    void queryClient.invalidateQueries({ queryKey: ["teacher-work-rules"] });
  };

  const save = useMutation({
    mutationFn: ({ userId, ...body }: { userId: string } & WorkRuleBody) =>
      // The teacher is named in the PATH and never in the body: the DTO
      // whitelists the rule's own fields only, and the gateway's ValidationPipe
      // runs with forbidNonWhitelisted, so a body carrying userId is a 400 with
      // nothing wrong in it.
      api.put<TeacherWorkRule>(`/api/v1/teacher-work-rules/${userId}`, body),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (userId: string) =>
      api.delete(`/api/v1/teacher-work-rules/${userId}`),
    onSuccess: invalidate,
  });

  return { save, remove };
}
