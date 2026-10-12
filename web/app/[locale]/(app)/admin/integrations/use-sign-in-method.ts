"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { INTEGRATION_KEYS } from "./query-keys";
import type { SignInMethodInput, SignInSettings } from "./sign-in-types";

/*
 * The school's "Logga in med skolkonto" (src/sign-in/sign-in-methods.service.ts).
 * SCHOOL_ADMIN only. GET answers the row (or null) and how the asking admin
 * signed in; PUT answers the same after saving; DELETE turns it off.
 */

export function useSignInSettings() {
  return useQuery({
    queryKey: INTEGRATION_KEYS.signIn,
    retry: false,
    queryFn: () => api.get<SignInSettings>("/api/v1/sign-in-method"),
  });
}

export function useSaveSignInMethod() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SignInMethodInput) => api.put<SignInSettings>("/api/v1/sign-in-method", input),
    onSuccess: (settings) => queryClient.setQueryData(INTEGRATION_KEYS.signIn, settings),
  });
}

export function useRemoveSignInMethod() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete<{ removed: boolean }>("/api/v1/sign-in-method"),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: INTEGRATION_KEYS.signIn }),
  });
}
