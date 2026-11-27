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

export type ProfileStatus = "loading" | "idle" | "saving" | "saved" | "failed";

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

export function useOptimizationProfile(): {
  weights: ProfileWeights;
  setWeight: (key: keyof ProfileWeights, value: number) => void;
  /** Whether the sliders may be moved: the signed-in administrator writes Schemaläggning. */
  canSave: boolean;
  status: ProfileStatus;
} {
  const t = useTranslations("common");
  const queryClient = useQueryClient();
  const { profile } = useProfile();
  const canSave = profileWrites(profile.adminProfile, "SCHEMALAGGNING");
  const [weights, setWeights] = useState<ProfileWeights>(DEFAULT_WEIGHTS);
  const [status, setStatus] = useState<ProfileStatus>("loading");
  // The latest weights the page holds, for the save that fires later, and whether the reader has moved a slider before the school's profile came.
  const latest = useRef(weights);
  const touched = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const query = useQuery({
    queryKey: PROFILE_KEY,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: () => api.get<ProfileView>("/api/v1/optimization/profile"),
  });
  const save = useMutation({
    mutationFn: (next: ProfileWeights) => api.put<ProfileView>("/api/v1/optimization/profile", next),
    onSuccess: (view) => queryClient.setQueryData(PROFILE_KEY, view),
  });

  const saveNow = useCallback(
    async (next: ProfileWeights): Promise<boolean> => {
      setStatus("saving");
      try {
        await save.mutateAsync(next);
        setStatus("saved");
        return true;
      } catch (error) {
        setStatus("failed");
        toast.error(apiErrorText(error, t));
        return false;
      }
    },
    [save, t],
  );

  // The school's profile, once read: the sliders take it, unless the reader moved one first. A school with none takes the browser's, once.
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
    if (view.stored || !canSave) {
      if (!touched.current) {
        latest.current = view.weights;
        setWeights(view.weights);
      }
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
    if (fromBrowser && !touched.current) {
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
    if (!touched.current) {
      latest.current = view.weights;
      setWeights(view.weights);
    }
    setStatus("idle");
  }, [query.data, canSave, saveNow]);

  useEffect(() => {
    if (query.isError) setStatus("failed");
  }, [query.isError]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const setWeight = useCallback(
    (key: keyof ProfileWeights, value: number) => {
      touched.current = true;
      const next = { ...latest.current, [key]: value };
      latest.current = next;
      setWeights(next);
      if (!canSave) return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        void saveNow(latest.current);
      }, SAVE_AFTER_MS);
    },
    [canSave, saveNow],
  );

  return { weights, setWeight, canSave, status: query.isLoading ? "loading" : status };
}
