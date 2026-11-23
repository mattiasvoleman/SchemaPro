"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { IntakeView } from "@/lib/intake";

/** Vad kom in: the school's base data counted against what Generera asks for (GET /api/v1/intake). A module of its own, as lib/intake.ts says. */
export const INTAKE_KEY = ["intake"] as const;

export function useIntake() {
  return useQuery({
    queryKey: INTAKE_KEY,
    // What the page says is read at the moment it is opened: a class added on another page a minute ago must be there, not what a
    // cache held from the last visit. The counts are cheap and the person came here to see them as they are now.
    staleTime: 0,
    refetchOnMount: "always",
    queryFn: () => api.get<IntakeView>("/api/v1/intake"),
  });
}
