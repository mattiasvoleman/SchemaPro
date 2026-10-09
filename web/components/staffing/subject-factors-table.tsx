"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useSubjects } from "@/lib/queries";
import { STAFFING_KEYS } from "@/lib/staffing-keys";
import { formatLoadFactor, parseLoadFactor } from "@/lib/load-factor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * "Faktor per ämne" — every subject's Subjects.loadFactor in one table, under
 * the policy card once the admin picks the Faktor model (staffing Fas 3).
 *
 * The same column the subject dialog on /admin/ämnen edits, here as a list
 * because a school that adopts Skola24's model sets a dozen factors at once,
 * and opening a dozen dialogs is how one is forgotten. Each changed row is a
 * PATCH /subjects/:id with `loadFactor` alone (the DTO leaves every absent
 * field as it is), and the load report is refetched after: a factor moves
 * every teacher's figure under FACTOR.
 *
 * The factors are SAVED HERE, separately from the card's Spara: they are the
 * subjects' rows, not the policy's. The hint says so, and it says the one
 * thing the protokoll needs — a factor is the school's, not the year's, so a
 * change reaches last year's figures too and is not in a teacher's Historik.
 */
export function SubjectFactorsTable() {
  const t = useTranslations("staffing.factor");
  const tCommon = useTranslations("common");
  const queryClient = useQueryClient();
  const { data: subjects, isLoading, isError } = useSubjects();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const rows = useMemo(
    () =>
      (subjects ?? []).map((subject) => {
        const stored = formatLoadFactor(subject.loadFactor);
        const value = drafts[subject.id] ?? stored;
        const factor = parseLoadFactor(value);
        return {
          subject,
          value,
          factor,
          changed: factor !== null && factor !== (subject.loadFactor ?? 1),
        };
      }),
    [subjects, drafts],
  );
  const invalid = rows.some((row) => row.factor === null);
  const changed = rows.filter((row) => row.changed);

  const save = async () => {
    if (invalid || changed.length === 0) return;
    setSaving(true);
    try {
      for (const row of changed) {
        await api.patch(`/api/v1/subjects/${row.subject.id}`, { loadFactor: row.factor });
      }
      setDrafts({});
      toast.success(t("saved", { count: changed.length }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    } finally {
      setSaving(false);
      // Also after a failure part-way: the rows saved before it are saved.
      void queryClient.invalidateQueries({ queryKey: ["subjects"] });
      void queryClient.invalidateQueries({ queryKey: STAFFING_KEYS.load });
      void queryClient.invalidateQueries({ queryKey: STAFFING_KEYS.suggestions });
    }
  };

  return (
    <div className="space-y-2 rounded-md border p-3">
      <h3 className="text-sm font-semibold">{t("tableTitle")}</h3>
      <p className="text-xs text-muted-foreground">{t("hint")}</p>
      {isLoading ? null : isError ? (
        <p className="text-sm text-destructive">{t("loadFailed")}</p>
      ) : (
        <>
          <table className="w-full text-sm">
            <caption className="sr-only">{t("tableTitle")}</caption>
            <thead>
              <tr className="text-left">
                <th scope="col" className="py-1 pr-3 font-medium">
                  {t("subject")}
                </th>
                <th scope="col" className="py-1 font-medium">
                  {t("factor")}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((row) => (
                <tr key={row.subject.id}>
                  <th scope="row" className="py-1 pr-3 text-left font-normal">
                    {row.subject.name}
                  </th>
                  <td className="py-1">
                    <Input
                      inputMode="decimal"
                      className="h-8 max-w-24"
                      aria-label={t("factorFor", { subject: row.subject.name })}
                      aria-invalid={row.factor === null}
                      value={row.value}
                      onChange={(event) =>
                        setDrafts((previous) => ({ ...previous, [row.subject.id]: event.target.value }))
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {invalid ? (
            <p role="alert" className="text-sm text-destructive">
              {t("invalid")}
            </p>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void save()}
            disabled={invalid || changed.length === 0 || saving}
          >
            {saving ? tCommon("saving") : t("save", { count: changed.length })}
          </Button>
        </>
      )}
    </div>
  );
}
