"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { useProfile } from "@/components/profile-context";
import { api } from "@/lib/api";
import { apiErrorText } from "@/lib/api-error-text";
import { profileWrites } from "@/lib/admin-areas";
import type { ObjectiveWeights } from "@/lib/queries";

/*
 * Optimeringsprofilen (P5): the five weights of Generera's sliders, the school's and not the browser's
 * (src/optimization/optimization-profile.ts). Beside the page and not in lib/queries.ts, as use-schedule-candidates.ts is: that module is in
 * every route's chunk graph.
 *
 * What the page does with it: the sliders start at the defaults, take the school's profile when it has been read, and save the whole
 * profile for the school half a second after the last move. A profile that only a läsare can see is read-only (the gateway refuses the save
 * by the area, and the sliders are not offered).
 *
 * What the browser held before (`schemapro.optimizationWeights`) is not lost: the first administrator who can save and opens the page of
 * a school that has no profile yet gives the school the profile their browser held, once, and the browser forgets it when the school has
 * it. Where the school already has a profile, the school's wins and the browser's is dropped.
 */

export type ProfileWeights = Required<ObjectiveWeights>;

export const DEFAULT_WEIGHTS: ProfileWeights = { preferredFree: 10, preferredBusy: 5, disruption: 8, spread: 3, teacherGap: 2 };
export const WEIGHT_KEYS = Object.keys(DEFAULT_WEIGHTS) as Array<keyof ProfileWeights>;
export const LOCAL_KEY = "schemapro.optimizationWeights";
export const PROFILE_KEY = ["optimizationProfile"] as const;
/** After the last move of a slider, so a drag is one save. */
export const SAVE_AFTER_MS = 500;

interface ProfileView {
  weights: ProfileWeights;
  stored: boolean;
  updatedAt: string | null;
}

/** "unreadable": the school's profile could not be read, so nothing may be saved over it. "failed": a save did not go through. */
export type ProfileStatus = "loading" | "idle" | "saving" | "saved" | "failed" | "unreadable";

/** What the browser held, if it is a profile: five whole weights 0..1000 and nothing else, else null. */
export function browserProfile(raw: string | null): ProfileWeights | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const weights = { ...DEFAULT_WEIGHTS };
    let any = false;
    for (const key of WEIGHT_KEYS) {
      const value = parsed[key];
      if (value === undefined) continue;
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 1000) return null;
      weights[key] = value;
      any = true;
    }
    return any ? weights : null;
  } catch {
    return null;
  }
}

const readProfile = () => api.get<ProfileView>("/api/v1/optimization/profile");

export function useOptimizationProfile(): {
  weights: ProfileWeights;
  setWeight: (key: keyof ProfileWeights, value: number) => void;
  /**
   * Whether the sliders may be moved: the signed-in administrator writes Schemaläggning AND the school's profile has been read. A move made
   * before it is read (or when it cannot be) would be saved as the defaults with that one weight changed, over the school's own four.
   */
  canSave: boolean;
  status: ProfileStatus;
} {
  const t = useTranslations("common");
  const queryClient = useQueryClient();
  const { profile } = useProfile();
  const mayWrite = profileWrites(profile.adminProfile, "SCHEMALAGGNING");
  const [weights, setWeights] = useState<ProfileWeights>(DEFAULT_WEIGHTS);
  const [status, setStatus] = useState<ProfileStatus>("loading");
  // The latest weights the page holds, for the save that fires later.
  const latest = useRef(weights);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The weights this reader has moved since the last save that went through: the only ones a save may put over what the school holds.
  const moved = useRef(new Set<keyof ProfileWeights>());

  const query = useQuery({
    queryKey: PROFILE_KEY,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    // Not kept when the page is left: a page opened again (even within the cache's five minutes) reads what the school holds now.
    gcTime: 0,
    queryFn: readProfile,
  });
  const loaded = query.isSuccess;
  const save = useMutation({
    mutationFn: (next: ProfileWeights) => api.put<ProfileView>("/api/v1/optimization/profile", next),
    onSuccess: (view) => queryClient.setQueryData(PROFILE_KEY, view),
  });

  /**
   * Saves `next` for the school. With `keys` (a reader's moves) the school's profile is read again first and only those weights are put over
   * it: a save replaces all five, and a colleague may have saved since this page read, so the four a reader did not touch are the school's
   * now and not this page's. Without them (what the browser held, for a school with none) `next` is saved as it stands.
   */
  const saveNow = useCallback(
    async (next: ProfileWeights, keys?: readonly (keyof ProfileWeights)[]): Promise<boolean> => {
      setStatus("saving");
      try {
        let sent = next;
        if (keys) {
          const fresh = await queryClient.fetchQuery({ queryKey: PROFILE_KEY, queryFn: readProfile, staleTime: 0 });
          if (fresh.stored) {
            sent = { ...fresh.weights };
            for (const key of keys) sent[key] = next[key];
          }
        }
        const view = await save.mutateAsync(sent);
        if (keys) {
          // What went through is no longer "moved", unless the slider moved again meanwhile; with nothing more on its way the sliders show what
          // the school holds, a colleague's weights included.
          for (const key of keys) if (latest.current[key] === next[key]) moved.current.delete(key);
          if (moved.current.size === 0 && !timer.current) {
            latest.current = view.weights;
            setWeights(view.weights);
          }
        }
        setStatus("saved");
        return true;
      } catch (error) {
        setStatus("failed");
        toast.error(apiErrorText(error, t));
        return false;
      }
    },
    [save, queryClient, t],
  );

  // The school's profile, once read: the sliders take it (they cannot be moved before). A school with none takes the browser's, once.
  const adopted = useRef(false);
  useEffect(() => {
    const view = query.data;
    if (!view || adopted.current) return;
    adopted.current = true;
    let local: string | null = null;
    try {
      local = window.localStorage.getItem(LOCAL_KEY);
    } catch {
      local = null;
    }
    const fromBrowser = view.stored ? null : browserProfile(local);
    if (view.stored || !mayWrite) {
      latest.current = view.weights;
      setWeights(view.weights);
      if (view.stored && local !== null) {
        try {
          window.localStorage.removeItem(LOCAL_KEY);
        } catch {
          // a browser that will not forget is no reason to fail
        }
      }
      setStatus("idle");
      return;
    }
    if (fromBrowser) {
      latest.current = fromBrowser;
      setWeights(fromBrowser);
      void saveNow(fromBrowser).then((saved) => {
        if (!saved) return;
        try {
          window.localStorage.removeItem(LOCAL_KEY);
        } catch {
          // as above
        }
      });
      return;
    }
    latest.current = view.weights;
    setWeights(view.weights);
    setStatus("idle");
  }, [query.data, mayWrite, saveNow]);

  // A move made in the last half second before the page is left is saved then and there, not dropped with the timer: the browser kept every
  // move as it was made, and the school's profile should not lose the last one to a click on another page.
  const saveLatest = useRef<() => void>(() => undefined);
  useEffect(() => {
    saveLatest.current = () => void saveNow(latest.current, [...moved.current]);
  });
  useEffect(
    () => () => {
      if (!timer.current) return;
      clearTimeout(timer.current);
      timer.current = null;
      saveLatest.current();
    },
    [],
  );

  const setWeight = useCallback(
    (key: keyof ProfileWeights, value: number) => {
      // Nothing is moved before the school's profile is read: `latest` is still the defaults, and a save of it would replace the school's own.
      if (!mayWrite || !loaded) return;
      const next = { ...latest.current, [key]: value };
      latest.current = next;
      moved.current.add(key);
      setWeights(next);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        void saveNow(latest.current, [...moved.current]);
      }, SAVE_AFTER_MS);
    },
    [mayWrite, loaded, saveNow],
  );

  return { weights, setWeight, canSave: mayWrite && loaded, status: query.isLoading ? "loading" : query.isError ? "unreadable" : status };
}
