"use client";

/*
 * Vem har läst om en person? The read log (Läslogg) answered for one person:
 * who read what about them, when and through which client, newest first, and
 * the answer as a CSV for the dataskyddsombud or a guardian's request.
 *
 * Asked on the button, never as the fields change: the gateway records every
 * answer as a read about the person (ACCESS_LOG), and the card says so.
 */

import { useMemo, useState, type FormEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ApiError } from "@/lib/api";
import { formatRetentionInstant } from "@/lib/retention-types";
import type { UserRole } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { FormField } from "@/components/ui/form-field";
import { LoadError } from "@/components/ui/load-error";
import { NativeSelect } from "@/components/ui/native-select";
import { Notice } from "@/components/ui/notice";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TableCard } from "@/components/ui/table-card";
import { downloadAccessLog } from "./access-log-csv";
import { useAccessLog, useSchoolPeople, type AccessLogEntry, type AccessLogQuery } from "./use-access-log";

/** The picker's groups, in the order a school thinks of them. */
const ROLE_ORDER: UserRole[] = ["STUDENT", "GUARDIAN", "TEACHER", "SCHOOL_ADMIN"];

export function AccessLogCard() {
  const t = useTranslations("dataProtection.accessLog");
  const tRoles = useTranslations("roles");
  const locale = useLocale();
  const people = useSchoolPeople();
  const [personId, setPersonId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [asked, setAsked] = useState<AccessLogQuery | null>(null);
  const answer = useAccessLog(asked);

  const groups = useMemo(
    () =>
      ROLE_ORDER.map((role) => ({ role, people: (people.data ?? []).filter((person) => person.role === role) })).filter(
        (group) => group.people.length > 0,
      ),
    [people.data],
  );

  const rangeInvalid = from !== "" && to !== "" && from > to;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!personId || rangeInvalid) return;
    setAsked({ personId, from, to });
  };

  const data = answer.data;
  const name = data ? `${data.person.firstName} ${data.person.lastName}`.trim() : "";
  const when = (entry: AccessLogEntry) => formatRetentionInstant(entry.at, locale, data?.timezone ?? "Europe/Stockholm");
  const reader = (entry: AccessLogEntry) =>
    entry.reader.type === "KEY"
      ? entry.reader.name
        ? t("key", { name: entry.reader.name })
        : t("removedKey")
      : (entry.reader.name ?? t("removedPerson"));
  const role = (entry: AccessLogEntry) =>
    entry.reader.type === "PERSON" && entry.reader.role ? tRoles(entry.reader.role) : "–";
  const kind = (entry: AccessLogEntry) => t(`kinds.${entry.kind}`);
  const channel = (entry: AccessLogEntry) => t(`channels.${entry.channel}`);
  const readers = data ? new Set(data.entries.map((entry) => `${entry.reader.type}:${entry.reader.id ?? reader(entry)}`)).size : 0;

  const errorText = (error: unknown) =>
    error instanceof ApiError && error.code && t.has(`errors.${error.code}`) ? t(`errors.${error.code}`) : t("loadFailedHint");

  const exportCsv = () => {
    if (!data) return;
    const day = new Date().toISOString().slice(0, 10);
    void downloadAccessLog(t("exportFile", { name: name.replace(/\s+/g, "-").toLowerCase(), date: day }), data.entries, {
      headers: [t("csv.at"), t("csv.reader"), t("csv.role"), t("csv.kind"), t("csv.channel"), t("csv.others")],
      when,
      reader,
      role,
      kind,
      channel,
    });
  };

  return (
    <SectionCard id="access-log" title={t("title")} description={t("description")}>
      <form onSubmit={submit} className="space-y-4" aria-describedby="access-log-logged">
        <div className="grid gap-4 sm:grid-cols-[minmax(0,2fr)_auto_auto] sm:items-end">
          <FormField id="access-log-person" label={t("person")}>
            <NativeSelect
              value={personId}
              onChange={(event) => setPersonId(event.target.value)}
              disabled={people.isLoading || people.isError}
              required
            >
              <option value="">{people.isLoading ? t("peopleLoading") : t("personPlaceholder")}</option>
              {groups.map((group) => (
                <optgroup key={group.role} label={t(`groups.${group.role}`)}>
                  {group.people.map((person) => (
                    <option key={person.id} value={person.id}>
                      {`${person.lastName}, ${person.firstName}`}
                      {person.isActive ? "" : ` (${t("inactive")})`}
                    </option>
                  ))}
                </optgroup>
              ))}
            </NativeSelect>
          </FormField>
          <FormField id="access-log-from" label={t("from")} optional>
            <DateField id="access-log-from" label={t("from")} className="w-40" value={from} onChange={setFrom} max={to || undefined} />
          </FormField>
          <FormField id="access-log-to" label={t("to")} optional error={rangeInvalid ? t("errors.ACCESS_LOG_RANGE_INVALID") : undefined}>
            <DateField id="access-log-to" label={t("to")} className="w-40" value={to} onChange={setTo} min={from || undefined} />
          </FormField>
        </div>
        {people.isError ? <LoadError variant="inline" title={t("peopleFailed")} hint={t("loadFailedHint")} /> : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={!personId || rangeInvalid || answer.isFetching}>
            {t("show")}
          </Button>
          <p id="access-log-logged" className="text-sm text-muted-foreground">
            {t("searchIsLogged")}
          </p>
        </div>
      </form>

      <div className="mt-6 space-y-3" aria-live="polite" aria-busy={answer.isFetching || undefined}>
        {answer.isFetching && !data ? (
          <div className="space-y-2">
            <p className="sr-only">{t("loading")}</p>
            <Skeleton className="h-24 w-full" />
          </div>
        ) : answer.isError ? (
          <LoadError variant="inline" title={t("loadFailed")} hint={errorText(answer.error)} />
        ) : data ? (
          data.entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("empty", { name })}</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm">{t("summary", { count: data.entries.length, readers, name })}</p>
                <Button type="button" variant="outline" size="sm" onClick={exportCsv}>
                  {t("export")}
                </Button>
              </div>
              {data.truncated ? (
                <Notice tone="warning" title={t("truncatedTitle")}>
                  {t("truncated", { count: data.entries.length })}
                </Notice>
              ) : null}
              <TableCard caption={t("caption", { name })} tableClassName="min-w-[44rem]" busy={answer.isFetching}>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("columns.at")}</TableHead>
                    <TableHead>{t("columns.reader")}</TableHead>
                    <TableHead>{t("columns.role")}</TableHead>
                    <TableHead>{t("columns.kind")}</TableHead>
                    <TableHead>{t("columns.channel")}</TableHead>
                    <TableHead className="text-right">{t("columns.others")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.entries.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell className="whitespace-nowrap">{when(entry)}</TableCell>
                      <TableCell>{reader(entry)}</TableCell>
                      <TableCell>{role(entry)}</TableCell>
                      <TableCell>{kind(entry)}</TableCell>
                      <TableCell>{channel(entry)}</TableCell>
                      <TableCell className="text-right tabular-nums">{entry.others > 0 ? entry.others : "–"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </TableCard>
            </>
          )
        ) : null}
      </div>
    </SectionCard>
  );
}
