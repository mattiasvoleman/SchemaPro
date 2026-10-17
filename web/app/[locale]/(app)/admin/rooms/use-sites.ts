"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

/**
 * The school's skolområden and the restid between them (Skolområden och
 * restid, migration 20261124090000), through the gateway: the tables have no
 * arm for a PostgREST session. Here and not in lib/queries, which is in every
 * app route's graph, for a card one page shows (as use-school-units.ts).
 */
export interface Site {
  id: string;
  name: string;
  /** Rooms standing on the site. */
  roomCount: number;
}

/** One pair's minutes, the pair in id order as the gateway stores it. */
export interface SiteTravelTime {
  siteAId: string;
  siteBId: string;
  minutes: number;
}

export interface Sites {
  sites: Site[];
  travelTimes: SiteTravelTime[];
  /** Rooms on no site: no travel is counted to or from them. */
  roomsWithoutSite: number;
}

export const SITES_KEY = ["sites"];

export function useSites() {
  return useQuery({ queryKey: SITES_KEY, queryFn: () => api.get<Sites>("/api/v1/sites") });
}

/**
 * Every travel time at once: the pairs listed are the school's figures, the
 * rest have none. `basis` is the figures the card was looking at
 * (travelBasis): the gateway refuses the save (SITE_TRAVEL_STALE) when they
 * have changed since, rather than undo someone else's. Either way the list
 * is read again.
 */
export function useSaveTravelTimes() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ times, basis }: { times: { siteIds: [string, string]; minutes: number }[]; basis: string }) =>
      api.put<SiteTravelTime[]>("/api/v1/sites/travel-times", { times, basis }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: SITES_KEY }),
  });
}

/** The figures as one string, as src/sites/sites.service.ts travelBasis builds it. */
export function travelBasis(times: readonly SiteTravelTime[]): string {
  return times
    .map((time) => `${pairKey(time.siteAId, time.siteBId)}:${time.minutes}`)
    .sort()
    .join(",");
}

/** The pair's key in id order, the order the gateway stores and answers it in. */
export function pairKey(a: string, b: string): string {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? `${x}|${y}` : `${y}|${x}`;
}

/** Every pair of the sites, in the order the sites are listed. */
export function sitePairs(sites: readonly Site[]): [Site, Site][] {
  const pairs: [Site, Site][] = [];
  for (let i = 0; i < sites.length; i++) {
    for (let j = i + 1; j < sites.length; j++) pairs.push([sites[i]!, sites[j]!]);
  }
  return pairs;
}
