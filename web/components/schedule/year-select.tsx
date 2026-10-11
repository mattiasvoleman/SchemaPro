"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useAcademicYears } from "@/lib/queries";
import type { AcademicYear } from "@/lib/types";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * The läsår a page is scoped to: the one chosen, else the active one, else
 * the first. Reads the same cached query as YearSelect, so a page and its
 * picker never disagree. `year` is null until the years have loaded, and
 * stays null for a school without any — render the no-scope EmptyState then.
 */
export function useYearScope(initialYearId: string | null = null) {
  const query = useAcademicYears();
  const [chosen, setYearId] = useState<string | null>(initialYearId);
  const years = query.data ?? [];
  const year =
    years.find((candidate) => candidate.id === chosen) ??
    years.find((candidate) => candidate.isActive) ??
    years[0] ??
    null;
  return {
    years,
    year,
    yearId: year?.id ?? null,
    setYearId,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}

export interface YearSelectProps {
  /** The chosen year's id; null shows the placeholder. */
  value: string | null;
  onValueChange: (yearId: string) => void;
  /**
   * The trigger's accessible name; defaults to common.year ("Läsår"). Ignored
   * when `id` is given: then a visible <Label htmlFor={id}> (FilterField) names it.
   */
  label?: string;
  id?: string;
  /** The years to offer, when the page narrows them; defaults to every year of the school. */
  years?: AcademicYear[];
  /** On the trigger; the width is w-44 unless overridden. */
  className?: string;
  disabled?: boolean;
}

/**
 * The page's scope selector, first in PageHeader's actions: a radix Select of
 * the school's läsår, w-44. A skeleton of the same size while the years load,
 * so the header does not jump; nothing at all for a school without years (the
 * page's no-scope state says what to do).
 *
 * Radix Select is a route cost (+8.7 KB measured on /admin/generate): on a
 * page that has no other Select, weigh it before adding this.
 */
export function YearSelect({ value, onValueChange, label, id, years, className, disabled }: YearSelectProps) {
  const t = useTranslations("common");
  const query = useAcademicYears();
  const options = years ?? query.data ?? [];

  if (!years && query.isLoading) {
    return <Skeleton className={cn("h-9 w-44", className)} aria-hidden="true" />;
  }
  if (options.length === 0) return null;

  return (
    <Select value={value ?? undefined} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger
        id={id}
        className={cn("w-44", className)}
        aria-label={id ? undefined : (label ?? t("year"))}
      >
        <SelectValue placeholder={t("select")} />
      </SelectTrigger>
      <SelectContent>
        {options.map((year) => (
          <SelectItem key={year.id} value={year.id}>
            {year.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
