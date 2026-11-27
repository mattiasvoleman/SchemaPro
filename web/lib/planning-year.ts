"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAcademicYears } from "@/lib/queries";
import { isProjectable, planningChoices, YEAR_ROSTERS_KEY } from "@/lib/projected-rosters";
import type { AcademicYear, YearRosters } from "@/lib/types";

/*
 * The year a planning page works on (/admin/generate, /admin/timetable), and
 * that year's förberäknade klasslistor — see lib/projected-rosters.ts.
 *
 * Beside lib/queries.ts rather than in it: that module is in every route's
 * chunk graph, and these hooks are three pages'.
 */

/**
 * GET /academic-years/:id/rosters for a year the gateway projects, and no
 * request at all for any other — the active year above all, whose rows are
 * its rosters. Not retried: a 409 or a 404 is an answer.
 */
export function useYearRosters(year: AcademicYear | null, active: AcademicYear | null) {
  const projectable = isProjectable(year, active);
  return useQuery({
    queryKey: [...YEAR_ROSTERS_KEY, projectable ? year!.id : null],
    enabled: projectable,
    retry: false,
    queryFn: () => api.get<YearRosters>(`/api/v1/academic-years/${year!.id}/rosters`),
  });
}

export interface PlanningYear {
  /**
   * The year on screen: the one chosen, else ?year=, else the active year.
   * Null on the first render, before ?year= has been read, so no year-keyed
   * read starts for a year the link is about to replace.
   */
  year: AcademicYear | null;
  active: AcademicYear | null;
  /** Next year while it is not activated; null when there is none to plan. */
  successor: AcademicYear | null;
  /**
   * Work on this year from now on. Also written to the address (?year=, left
   * out for the active year, which is where every page starts), so that a
   * reload, the browser's back button and a link copied from the page come
   * back to the year that was counted for.
   */
  choose: (yearId: string) => void;
  /** The server's overlay for `year`; null for the active year, or until it arrives. */
  rosters: YearRosters | null;
  /** The overlay was asked for and did not come: the page must say so. */
  rostersFailed: boolean;
}

/**
 * `?year=` of the address set to `yearId`, or removed for null, with every
 * other parameter and the hash left as they are. replaceState and not push: a
 * choice between two years is not a place to go back to, and not the router,
 * whose navigation would render the route again for a value this hook already
 * holds. A page without a window (the server's render) has no address to write.
 */
export function writeYearToAddress(yearId: string | null): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  // The rollover's offer (?year=<the new year>&start=PREVIOUS_YEAR, StartFromCard) belongs to the year the link names: left behind beside
  // another year, or beside none (the active year), a reload would offer last year's schedule as the start for a year it was not made for.
  if (url.searchParams.get("year") !== yearId) url.searchParams.delete("start");
  if (yearId === null) url.searchParams.delete("year");
  else url.searchParams.set("year", yearId);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

export function usePlanningYear(): PlanningYear {
  const { data: years } = useAcademicYears();
  const [chosenId, setChosenId] = useState<string | null>(null);
  // ?year= from the Läsår page's link, read once after mount — as the
  // requirements page reads it, and not with useSearchParams, which would opt
  // the route out of static rendering. Until it has been read there is no
  // year at all: resolving to the active year first would start its
  // timplan, history and grundschema reads (and paint them for a frame) only
  // for the link to replace them a render later.
  const [linked, setLinked] = useState<{ id: string | null } | null>(null);
  useEffect(() => setLinked({ id: new URLSearchParams(window.location.search).get("year") }), []);
  const { active, successor } = useMemo(() => planningChoices(years), [years]);
  const pick = (id: string | null) =>
    id === null ? null : ([active, successor].find((year) => year?.id === id) ?? null);
  const year = linked === null ? null : (pick(chosenId) ?? pick(linked.id) ?? active);
  const rosters = useYearRosters(year, active);
  const choose = useCallback(
    (yearId: string) => {
      setChosenId(yearId);
      writeYearToAddress(yearId === active?.id ? null : yearId);
    },
    [active?.id],
  );
  return {
    year,
    active,
    successor,
    choose,
    rosters: rosters.data ?? null,
    rostersFailed: rosters.isError,
  };
}
