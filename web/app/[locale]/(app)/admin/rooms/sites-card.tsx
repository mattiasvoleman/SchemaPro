"use client";

/*
 * Skolområden och restid (migration 20261124090000): the school's campuses
 * and the minutes between each two. A room stands on a site (the room
 * dialog), and the gateway warns when a hand edit or a vikarie leaves a
 * teacher or a class less time between two lessons than the walk, and counts
 * the walks as restid in the load (src/common/site-travel.ts).
 *
 * One figure per pair, the same both ways: what a school says ("tio minuter
 * mellan Norra och Södra"), and a minimum gap whichever way the teacher
 * walks. A pair left empty is unknown: nothing is warned about or counted
 * between its sites, which is why the card names the pairs still missing
 * one, and the rooms that stand on no site.
 *
 * On Salar rather than a page of its own: sites are the rooms' frame, set up
 * once, and a menu row would cost every route bytes.
 */

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { STAFFING_KEYS } from "@/lib/staffing-keys";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { ApiError } from "@/lib/api";
import { useCrudMutations } from "@/lib/queries";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { LoadError } from "@/components/ui/load-error";
import { Notice } from "@/components/ui/notice";
import { RowActions } from "@/components/ui/row-actions";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TableCard } from "@/components/ui/table-card";
import { SITES_KEY, pairKey, sitePairs, travelBasis, useSaveTravelTimes, useSites, type Site } from "./use-sites";

/** The range the database holds a travel time to (SiteTravelTimes_minutes_range). */
const MAX_MINUTES = 240;

/**
 * A typed figure: null when empty, undefined when it is not 0..240 whole
 * minutes written as digits ("1e2" and "-" are not minutes, and are said to
 * be wrong rather than read as a number or as nothing).
 */
export function minutesFromField(value: string): number | null | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (!/^\d{1,3}$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return parsed <= MAX_MINUTES ? parsed : undefined;
}

/** A pair's key as a field id: the pair key with no "|", which a CSS selector would read as an operator. */
const fieldId = (key: string) => `site-travel-${key.replace("|", "-")}`;

export function SitesCard() {
  const t = useTranslations("sites");
  const tCommon = useTranslations("common");
  const sites = useSites();
  // A site removed leaves its rooms on none, and the load's restid with them.
  const mutations = useCrudMutations<{ name: string }>("/api/v1/sites", [SITES_KEY, ["rooms"], [...STAFFING_KEYS.load]]);
  const saveTimes = useSaveTravelTimes();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Site | null>(null);
  const [name, setName] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Site | null>(null);

  const list = useMemo(() => sites.data?.sites ?? [], [sites.data]);
  const pairs = useMemo(() => sitePairs(list), [list]);
  // On the travel times alone: a room saved or a site renamed refetches the
  // list, and the pairs keep their reference (react-query's structural
  // sharing), so nothing typed is touched.
  const travelTimes = sites.data?.travelTimes;
  const saved = useMemo(
    () => new Map((travelTimes ?? []).map((time) => [pairKey(time.siteAId, time.siteBId), time.minutes])),
    [travelTimes],
  );
  // The figures as typed, by pair. When the saved ones change, a field the
  // admin has not touched takes the new figure; one they have edited keeps
  // what they typed.
  const [typed, setTyped] = useState<Record<string, string>>({});
  const previous = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    const before = previous.current;
    previous.current = saved;
    setTyped((current) => {
      const next: Record<string, string> = {};
      for (const key of new Set([...Object.keys(current), ...saved.keys()])) {
        const untouched = (current[key] ?? "") === (before.has(key) ? String(before.get(key)) : "");
        const value = untouched ? (saved.has(key) ? String(saved.get(key)) : "") : current[key]!;
        if (value !== "") next[key] = value;
      }
      return next;
    });
  }, [saved]);

  const valueOf = (a: Site, b: Site) => typed[pairKey(a.id, b.id)] ?? "";
  const invalidPairs = pairs.filter(([a, b]) => minutesFromField(valueOf(a, b)) === undefined);
  // The pairs the school has given no figure: what the gateway treats as unknown.
  const missing = pairs.filter(([a, b]) => !saved.has(pairKey(a.id, b.id)));
  const dirty = pairs.some(([a, b]) => {
    const now = minutesFromField(valueOf(a, b));
    return now !== (saved.get(pairKey(a.id, b.id)) ?? null);
  });

  const errorText = (error: unknown) =>
    error instanceof ApiError && error.code && t.has(`errors.${error.code}`)
      ? t(`errors.${error.code}`)
      : error instanceof Error
        ? error.message
        : tCommon("error");

  const startCreate = () => {
    setEditing(null);
    setName("");
    setFormError(null);
    setOpen(true);
  };
  const startEdit = (site: Site) => {
    setEditing(site);
    setName(site.name);
    setFormError(null);
    setOpen(true);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);
    const trimmed = name.trim();
    if (trimmed === "") return;
    try {
      if (editing) {
        await mutations.update.mutateAsync({ id: editing.id, name: trimmed });
        toast.success(t("saved", { name: trimmed }));
      } else {
        await mutations.create.mutateAsync({ name: trimmed });
        toast.success(t("created", { name: trimmed }));
      }
      setOpen(false);
    } catch (error) {
      setFormError(errorText(error));
    }
  };

  const remove = async () => {
    if (!deleting) return;
    try {
      await mutations.remove.mutateAsync(deleting.id);
      toast.success(t("deleted", { name: deleting.name }));
      setDeleting(null);
    } catch (error) {
      toast.error(errorText(error));
    }
  };

  const saveTravelTimes = async (event: FormEvent) => {
    event.preventDefault();
    if (!dirty || invalidPairs.length > 0) return;
    const times = pairs.flatMap(([a, b]) => {
      const minutes = minutesFromField(valueOf(a, b));
      return minutes === null || minutes === undefined ? [] : [{ siteIds: [a.id, b.id] as [string, string], minutes }];
    });
    try {
      await saveTimes.mutateAsync({ times, basis: travelBasis(travelTimes ?? []) });
      // The load's restid is read from these figures.
      void queryClient.invalidateQueries({ queryKey: STAFFING_KEYS.load });
      toast.success(t("travelSaved"));
    } catch (error) {
      toast.error(errorText(error));
    }
  };

  const roomsWithoutSite = sites.data?.roomsWithoutSite ?? 0;
  const pending = mutations.create.isPending || mutations.update.isPending;

  return (
    <SectionCard
      id="sites"
      title={t("title")}
      description={t("description")}
      action={
        <Button type="button" variant="outline" size="sm" onClick={startCreate} disabled={!sites.data}>
          <Plus aria-hidden="true" />
          {t("add")}
        </Button>
      }
    >
      {sites.isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-24 w-full" />
        </div>
      ) : sites.isError && !sites.data ? (
        <LoadError variant="inline" title={t("loadFailed")} hint={t("loadFailedHint")} />
      ) : list.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <div className="space-y-4">
          {sites.isError ? <LoadError variant="inline" title={t("loadFailed")} hint={tCommon("refetchFailedHint")} /> : null}
          <TableCard caption={t("caption")}>
            <TableHeader>
              <TableRow>
                <TableHead>{t("columns.name")}</TableHead>
                <TableHead className="text-right">{t("columns.rooms")}</TableHead>
                <TableHead className="w-24 text-right">{tCommon("actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((site) => (
                <TableRow key={site.id}>
                  <TableCell className="font-medium">{site.name}</TableCell>
                  <TableCell className="text-right tabular-nums">{site.roomCount}</TableCell>
                  <TableCell className="text-right">
                    <RowActions
                      name={site.name}
                      actions={[
                        {
                          label: tCommon("edit"),
                          icon: Pencil,
                          ariaLabel: tCommon("editNamed", { name: site.name }),
                          onSelect: () => startEdit(site),
                        },
                        {
                          label: tCommon("delete"),
                          icon: Trash2,
                          ariaLabel: tCommon("deleteNamed", { name: site.name }),
                          onSelect: () => setDeleting(site),
                        },
                      ]}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </TableCard>

          {list.length >= 2 ? (
            <form aria-labelledby="sites-travel-title" className="space-y-3" onSubmit={saveTravelTimes} noValidate>
              <div className="space-y-1">
                <h3 id="sites-travel-title" className="text-sm font-semibold">
                  {t("travelTitle")}
                </h3>
                <p className="text-sm text-muted-foreground">{t("travelHint")}</p>
              </div>
              {missing.length > 0 ? (
                <Notice tone="warning" title={t("missingTitle")}>
                  {t("missing", { pairs: missing.map(([a, b]) => `${a.name}–${b.name}`).join(", ") })}
                </Notice>
              ) : null}
              {roomsWithoutSite > 0 ? (
                <Notice tone="neutral" title={t("roomsWithoutSiteTitle")}>
                  {t("roomsWithoutSite", { count: roomsWithoutSite })}
                </Notice>
              ) : null}
              <ul className="grid gap-3 sm:grid-cols-2">
                {pairs.map(([a, b]) => {
                  const key = pairKey(a.id, b.id);
                  const value = valueOf(a, b);
                  return (
                    <li key={key}>
                      <FormField
                        id={fieldId(key)}
                        label={t("pairLabel", { a: a.name, b: b.name })}
                        optional
                        error={minutesFromField(value) === undefined ? t("minutesInvalid") : undefined}
                      >
                        <Input
                          inputMode="numeric"
                          autoComplete="off"
                          maxLength={3}
                          value={value}
                          placeholder={t("minutesPlaceholder")}
                          onChange={(event) => setTyped((current) => ({ ...current, [key]: event.target.value }))}
                        />
                      </FormField>
                    </li>
                  );
                })}
              </ul>
              <div className="flex justify-end">
                <Button type="submit" disabled={!dirty || invalidPairs.length > 0 || saveTimes.isPending}>
                  {t("saveTravel")}
                </Button>
              </div>
            </form>
          ) : (
            <p className="text-sm text-muted-foreground">{t("oneSite")}</p>
          )}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <form onSubmit={save} noValidate>
            <DialogHeader>
              <DialogTitle>{editing ? t("editTitle", { name: editing.name }) : t("addTitle")}</DialogTitle>
              <DialogDescription>{t("dialogHint")}</DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              {formError ? (
                <Notice tone="destructive" title={t("saveFailed")}>
                  {formError}
                </Notice>
              ) : null}
              <FormField id="site-name" label={t("columns.name")}>
                <Input
                  value={name}
                  required
                  maxLength={60}
                  placeholder={t("namePlaceholder")}
                  onChange={(event) => setName(event.target.value)}
                />
              </FormField>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                {tCommon("cancel")}
              </Button>
              <Button type="submit" disabled={name.trim() === "" || pending}>
                {tCommon("save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(next) => !next && setDeleting(null)}
        title={tCommon("deleteConfirmTitle", { name: deleting?.name ?? "" })}
        description={t("deleteBody", { count: deleting?.roomCount ?? 0 })}
        confirmLabel={tCommon("delete")}
        loading={mutations.remove.isPending}
        onConfirm={remove}
      />
    </SectionCard>
  );
}
