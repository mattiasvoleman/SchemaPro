"use client";

/*
 * Hela skolans data och registerutdrag (K5). A zip of the school's lists, its
 * grundschema and all its attendance, absence reports, leave, notices and
 * läslogg, for a school that ends its agreement; and one person's own data,
 * for a request under GDPR article 15. Rektor and a full administrator order
 * and fetch; to everybody else the card says whose it is.
 *
 * The file is built by a job in the background (a minute or two for a school of
 * a thousand pupils) and kept for three days. The card watches an order being
 * built and offers the file when it is ready. The persons with a protected
 * identity are not in the file; the order says how many.
 */

import { useMemo, useState, type FormEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { profileDecides } from "@/lib/admin-areas";
import { ApiError } from "@/lib/api";
import { formatRetentionInstant } from "@/lib/retention-types";
import type { SchoolExportOrder } from "@/lib/school-export";
import type { UserRole } from "@/lib/types";
import { useProfile } from "@/components/profile-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { LoadError } from "@/components/ui/load-error";
import { NativeSelect } from "@/components/ui/native-select";
import { Notice } from "@/components/ui/notice";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { useSchoolPeople } from "./use-access-log";
import {
  useFetchSchoolExport,
  useOrderSchoolExport,
  useSchoolExports,
  useSubjectAccess,
  useWithdrawSchoolExport,
} from "./use-school-exports";

const ROLE_ORDER: UserRole[] = ["STUDENT", "GUARDIAN", "TEACHER", "SCHOOL_ADMIN"];

const sizeOf = (bytes: number, locale: string): string =>
  bytes >= 1048576
    ? `${(bytes / 1048576).toLocaleString(locale, { maximumFractionDigits: 1, minimumFractionDigits: 1 })} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} kB`;

export function SchoolExportCard({ timeZone = "Europe/Stockholm" }: { timeZone?: string }) {
  const t = useTranslations("schoolExport");
  const { profile } = useProfile();
  const mayExport = profileDecides(profile.adminProfile);
  return (
    <SectionCard id="school-export" title={t("title")} description={t("description")}>
      {mayExport ? (
        <div className="space-y-8">
          <Orders timeZone={timeZone} />
          <SubjectAccess />
        </div>
      ) : (
        <Notice tone="neutral">{t("notDecider")}</Notice>
      )}
    </SectionCard>
  );
}

function Orders({ timeZone }: { timeZone: string }) {
  const t = useTranslations("schoolExport");
  const locale = useLocale();
  const orders = useSchoolExports(true);
  const order = useOrderSchoolExport();
  const withdraw = useWithdrawSchoolExport();
  const fetchFile = useFetchSchoolExport();
  const inHand = orders.data?.some((row) => row.status === "QUEUED" || row.status === "RUNNING") ?? false;

  const problem = (error: unknown): string => {
    if (error instanceof ApiError && error.code) {
      const known = ["SCHOOL_EXPORT_IN_HAND", "SCHOOL_EXPORT_TOO_MANY", "SCHOOL_EXPORT_EXPIRED", "SCHOOL_EXPORT_NOT_READY", "SCHOOL_EXPORT_INCOMPLETE", "SCHOOL_EXPORT_DECIDES"];
      if (known.includes(error.code)) return t(`errors.${error.code}`);
    }
    return t("errors.generic");
  };
  const when = (iso: string) => formatRetentionInstant(iso, locale, timeZone);

  return (
    <div className="space-y-3" aria-busy={orders.isLoading}>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={order.isPending || inHand}
          onClick={() => order.mutate(undefined, { onError: (error) => toast.error(problem(error)) })}
        >
          {order.isPending ? t("ordering") : t("order")}
        </Button>
        <p className="text-sm text-muted-foreground">{t("orderHint")}</p>
      </div>

      {orders.isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : orders.isError ? (
        <LoadError variant="inline" title={t("loadFailed")} />
      ) : orders.data && orders.data.length > 0 ? (
        <ul className="divide-y rounded-md border">
          {orders.data.map((row) => (
            <li key={row.id} className="flex flex-wrap items-start justify-between gap-3 p-3">
              <div className="min-w-0 space-y-1">
                <p className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge variant={row.status === "READY" ? "default" : row.status === "FAILED" ? "destructive" : "secondary"}>{t(`status.${row.status}`)}</Badge>
                  <span>{t("orderedAt", { when: when(row.requestedAt) })}</span>
                  {row.requestedBy ? <span className="text-muted-foreground">{t("by", { name: row.requestedBy.name })}</span> : null}
                </p>
                {row.status === "READY" && row.byteSize !== null ? (
                  <p className="text-sm text-muted-foreground">
                    {t("size", { size: sizeOf(row.byteSize, locale) })}
                    {row.expiresAt ? ` · ${row.fetchable ? t("expires", { when: when(row.expiresAt) }) : t("expired")}` : ""}
                  </p>
                ) : null}
                {row.status === "FAILED" ? <p className="text-sm text-destructive">{t("failed", { reason: row.errorClass ?? "" })}</p> : null}
                {row.heldOut && row.heldOut.people > 0 ? <p className="text-sm">{t("heldOut", { count: row.heldOut.people })}</p> : null}
                {row.heldOut?.notes?.map((note) => (
                  <p key={note} className="text-sm font-medium text-warning-foreground dark:text-warning" role="note">
                    {t("partMissing", { note })}
                  </p>
                ))}
                {row.status === "READY" && row.sha256 ? <p className="break-all font-mono text-xs text-muted-foreground">{t("checksum", { sha: row.sha256 })}</p> : null}
              </div>
              <div className="flex gap-2">
                {row.fetchable ? (
                  <Button
                    size="sm"
                    disabled={fetchFile.isPending}
                    onClick={() => fetchFile.mutate({ id: row.id, finishedAt: row.finishedAt }, { onError: (error) => toast.error(problem(error)) })}
                  >
                    {fetchFile.isPending && fetchFile.variables?.id === row.id ? t("fetching") : t("fetch")}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={withdraw.isPending}
                  onClick={() => withdraw.mutate(row.id, { onError: (error) => toast.error(problem(error)) })}
                >
                  {row.status === "QUEUED" || row.status === "RUNNING" ? t("cancel") : t("remove")}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{t("none")}</p>
      )}
      <p className="text-xs text-muted-foreground">{t("whatItHolds")}</p>
    </div>
  );
}

function SubjectAccess() {
  const t = useTranslations("schoolExport");
  const people = useSchoolPeople();
  const extract = useSubjectAccess();
  const [personId, setPersonId] = useState("");
  const [withRelated, setWithRelated] = useState(true);
  const groups = useMemo(
    () => ROLE_ORDER.map((role) => ({ role, people: (people.data ?? []).filter((person) => person.role === role) })).filter((group) => group.people.length > 0),
    [people.data],
  );
  const answer = extract.data;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!personId) return;
    extract.mutate({ personId, withRelated }, { onError: () => toast.error(t("extract.failed")) });
  };

  return (
    <form className="space-y-3 border-t pt-6" onSubmit={submit}>
      <h3 className="text-base font-semibold">{t("extract.title")}</h3>
      <p className="text-sm text-muted-foreground">{t("extract.description")}</p>
      <div className="flex flex-wrap items-end gap-4">
        <FormField id="extract-person" label={t("extract.person")}>
          <NativeSelect value={personId} onChange={(event) => setPersonId(event.target.value)} disabled={people.isLoading || people.isError}>
            <option value="">{t("extract.choose")}</option>
            {groups.map((group) => (
              <optgroup key={group.role} label={t(`extract.groups.${group.role}`)}>
                {group.people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {`${person.lastName}, ${person.firstName}`}
                    {person.isActive ? "" : ` (${t("extract.inactive")})`}
                  </option>
                ))}
              </optgroup>
            ))}
          </NativeSelect>
        </FormField>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <input type="checkbox" checked={withRelated} onChange={(event) => setWithRelated(event.target.checked)} />
          {t("extract.withRelated")}
        </label>
        <Button type="submit" disabled={!personId || extract.isPending}>
          {extract.isPending ? t("extract.building") : t("extract.fetch")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t("extract.recorded")}</p>
      {answer?.subjectIsMarked ? <Notice tone="warning">{t("extract.subjectMarked")}</Notice> : null}
      {answer && answer.relatedHeldOut > 0 ? <Notice tone="neutral">{t("extract.relatedHeldOut", { count: answer.relatedHeldOut })}</Notice> : null}
      {answer && !answer.subjectIsMarked ? <p className="text-sm">{t("extract.done", { count: answer.relatedIncluded })}</p> : null}
    </form>
  );
}

export type { SchoolExportOrder };
