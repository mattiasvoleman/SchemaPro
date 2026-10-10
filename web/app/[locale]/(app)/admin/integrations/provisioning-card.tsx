"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, Mail } from "lucide-react";
import type { MessageLookup } from "@/lib/engine-message";
import type { BulkInvitationReport } from "@/lib/queries";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CHECKBOX } from "./form-styles";
import { errorText } from "./ss12000-messages";
import { INVITE_CHUNK } from "./ss12000-types";
import { useInviteSelected, useProvisioning } from "./use-ss12000-sync";

/*
 * Nya personer: who the sync linked or created and nobody has invited yet.
 *
 * A person a sync creates is a catalogue row with no identity behind it and
 * no mail sent (the users service's placeholder authId): they appear in
 * schedules and the register, and cannot sign in. Giving them a login is this
 * list's explicit act — "Bjud in valda", the people register's own
 * invitation endpoint, 500 at a time — and nothing else's. No row here is
 * pre-ticked.
 */

export function ProvisioningCard() {
  const t = useTranslations("integrations.provisioning");
  const tRoles = useTranslations("integrations.review.roles");
  const tErrors = useTranslations("integrations.errors") as unknown as MessageLookup;
  const tCommon = useTranslations("common");
  const people = useProvisioning(true);
  const invite = useInviteSelected();
  const [chosen, setChosen] = useState<Set<string>>(() => new Set());
  const [report, setReport] = useState<BulkInvitationReport | null>(null);
  const list = useMemo(() => people.data ?? [], [people.data]);
  const live = [...chosen].filter((id) => list.some((person) => person.id === id));

  const toggle = (id: string, on: boolean) =>
    setChosen((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("body")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {people.isError ? <p role="alert" className="text-sm">{errorText(tErrors, people.error, tCommon("error"))}</p> : null}
        {people.data && list.length === 0 ? <p className="text-sm text-muted-foreground">{t("empty")}</p> : null}
        {list.length > 0 ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => setChosen(new Set(list.map((person) => person.id)))}>
                {t("selectAll", { count: list.length })}
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setChosen(new Set())} disabled={live.length === 0}>
                {t("selectNone")}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={live.length === 0 || invite.isPending}
                onClick={() =>
                  invite.mutate(live, {
                    onSuccess: (result) => {
                      setReport(result);
                      setChosen(new Set());
                      toast.success(t("invited", { sent: result.sent }));
                    },
                    onError: (error) => toast.error(errorText(tErrors, error, tCommon("error"))),
                  })
                }
              >
                {invite.isPending ? <Loader2 className="animate-spin" /> : <Mail />}
                {t("invite", { count: live.length })}
              </Button>
            </div>
            {live.length > INVITE_CHUNK ? <p className="text-xs text-muted-foreground">{t("chunked", { chunk: INVITE_CHUNK })}</p> : null}
            <ul className="max-h-96 divide-y overflow-y-auto rounded-md border" aria-label={t("title")}>
              {list.map((person) => {
                const id = `ss-prov-${person.id}`;
                return (
                  <li key={person.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <input id={id} type="checkbox" className={CHECKBOX} checked={chosen.has(person.id)} onChange={(event) => toggle(person.id, event.target.checked)} />
                    <label htmlFor={id} className="min-w-0 flex-1">
                      <span className="font-medium">
                        {person.firstName} {person.lastName}
                      </span>{" "}
                      <span className="text-xs text-muted-foreground">
                        {tRoles(person.role)}
                        {person.studentGroup ? ` · ${person.studentGroup.name}` : ""} · {person.email}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </>
        ) : null}
        {report ? (
          <div role="status" className="rounded-md border p-3 text-sm">
            <p>{t("report", { sent: report.sent, already: report.alreadyRegistered, failed: report.errors.length })}</p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
