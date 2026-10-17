"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, Plus, Trash2 } from "lucide-react";
import type { MessageLookup } from "@/lib/engine-message";
import { usePeople } from "@/lib/queries";
import {
  useAbsenceReasons,
  useCoverSettings,
  usePool,
  usePoolActions,
  useReasonActions,
  useUpdateCoverSettings,
} from "@/lib/cover-queries";
import type { AbsenceReason, PoolPreference } from "@/lib/cover-types";
import { coverErrorText, reasonName } from "@/lib/cover-view";
import { AvailabilityEditor } from "@/components/cover/availability-editor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const PREFERENCES: PoolPreference[] = ["PREFER", "NEUTRAL", "LAST_RESORT"];

function useErrorToast() {
  const tErrors = useTranslations("coverErrors") as unknown as MessageLookup;
  const tCommon = useTranslations("common");
  return (error: unknown) => toast.error(coverErrorText(tErrors, error, tCommon("error")));
}

/** Whether teachers report their own absence, and where the pool ranks. */
function PolicySection() {
  const t = useTranslations("coverSettings");
  const tCommon = useTranslations("common");
  const fail = useErrorToast();
  const { data: settings } = useCoverSettings();
  const save = useUpdateCoverSettings();
  const [selfReport, setSelfReport] = useState(false);
  const [preference, setPreference] = useState<PoolPreference>("NEUTRAL");

  useEffect(() => {
    if (!settings) return;
    setSelfReport(settings.teacherSelfReport);
    setPreference(settings.poolPreference);
  }, [settings]);

  const changed =
    settings !== undefined && (selfReport !== settings.teacherSelfReport || preference !== settings.poolPreference);

  return (
    <section className="space-y-3" aria-labelledby="cover-policy-title">
      <h3 id="cover-policy-title" className="text-sm font-semibold">
        {t("policyTitle")}
      </h3>
      {/* The whole row: its label presses the switch as well. */}
      <div className="flex items-start justify-between gap-4 rounded-md border p-3" data-writes-inert="DRIFT">
        <div className="space-y-1">
          <Label htmlFor="cover-self-report">{t("selfReport")}</Label>
          <p id="cover-self-report-hint" className="text-xs text-muted-foreground">
            {t("selfReportHint")}
          </p>
        </div>
        <Switch
          id="cover-self-report"
          checked={selfReport}
          onCheckedChange={setSelfReport}
          aria-describedby="cover-self-report-hint"
        />
      </div>
      <div className="max-w-sm space-y-1.5">
        <Label htmlFor="pool-preference">{t("poolPreference")}</Label>
        <Select value={preference} onValueChange={(value) => setPreference(value as PoolPreference)}>
          <SelectTrigger id="pool-preference" aria-describedby="pool-preference-hint" data-writes-inert="DRIFT">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PREFERENCES.map((value) => (
              <SelectItem key={value} value={value}>
                {t(`poolPreferences.${value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p id="pool-preference-hint" className="text-xs text-muted-foreground">
          {t("poolPreferenceHint")}
        </p>
      </div>
      <Button
        size="sm"
        disabled={!changed || save.isPending}
        data-writes="DRIFT"
        onClick={() =>
          save.mutate(
            { teacherSelfReport: selfReport, poolPreference: preference },
            { onSuccess: () => toast.success(t("policySaved")), onError: fail },
          )
        }
      >
        {save.isPending ? <Loader2 className="animate-spin" /> : null}
        {save.isPending ? tCommon("saving") : t("savePolicy")}
      </Button>
    </section>
  );
}

function ReasonRow({ reason }: { reason: AbsenceReason }) {
  const t = useTranslations("coverSettings");
  const tReasons = useTranslations("absenceReasons");
  const fail = useErrorToast();
  const { update } = useReasonActions();
  const [renaming, setRenaming] = useState(false);
  const [label, setLabel] = useState(reason.label ?? "");
  const name = reasonName(tReasons, reason);

  return (
    <li className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 text-sm">
      {renaming ? (
        <form
          className="flex flex-1 items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            update.mutate(
              { id: reason.id, label },
              { onSuccess: () => setRenaming(false), onError: fail },
            );
          }}
        >
          <Input
            aria-label={t("renameReason")}
            aria-describedby="reason-label-hint"
            value={label}
            maxLength={60}
            onChange={(event) => setLabel(event.target.value)}
            className="h-8"
          />
          <Button size="sm" type="submit" disabled={!label.trim() || update.isPending}>
            {t("saveReason")}
          </Button>
        </form>
      ) : (
        <span className="flex items-center gap-2">
          {name}
          {reason.archived ? <Badge variant="outline">{t("reasonHidden")}</Badge> : null}
        </span>
      )}
      <span className="flex gap-1">
        {reason.builtin === null && !renaming ? (
          <Button variant="ghost" size="sm" onClick={() => setRenaming(true)} data-writes="DRIFT">
            {t("renameReason")}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          disabled={update.isPending}
          onClick={() => update.mutate({ id: reason.id, archived: !reason.archived }, { onError: fail })}
          data-writes="DRIFT"
        >
          {reason.archived ? t("showReason") : t("hideReason")}
        </Button>
      </span>
    </li>
  );
}

/** The school's list: built-ins are hidden, never renamed; its own are renamed too. */
function ReasonsSection() {
  const t = useTranslations("coverSettings");
  const fail = useErrorToast();
  const { data: reasons } = useAbsenceReasons();
  const { create } = useReasonActions();
  const [label, setLabel] = useState("");
  const sorted = [...(reasons ?? [])].sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));

  return (
    <section className="space-y-2" aria-labelledby="cover-reasons-title">
      <h3 id="cover-reasons-title" className="text-sm font-semibold">
        {t("reasonsTitle")}
      </h3>
      <p className="text-sm text-muted-foreground">{t("reasonsBody")}</p>
      <ul className="divide-y rounded-md border">
        {sorted.map((reason) => (
          <ReasonRow key={`${reason.id}:${reason.label ?? ""}`} reason={reason} />
        ))}
      </ul>
      <form
        className="flex max-w-sm items-end gap-2"
        data-writes="DRIFT"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate(label.trim(), {
            onSuccess: () => {
              setLabel("");
              toast.success(t("reasonSaved"));
            },
            onError: fail,
          });
        }}
      >
        <div className="flex-1 space-y-1.5">
          <Label htmlFor="new-reason">{t("newReason")}</Label>
          <Input
            id="new-reason"
            aria-describedby="reason-label-hint"
            value={label}
            maxLength={60}
            onChange={(event) => setLabel(event.target.value)}
          />
        </div>
        <Button type="submit" size="sm" variant="outline" disabled={!label.trim() || create.isPending}>
          <Plus />
          {t("addReason")}
        </Button>
      </form>
      {/* The link from an absence to its reason is the admin's and the
          teacher's; the list itself is every teacher's (they pick from it). */}
      <p id="reason-label-hint" className="text-xs text-muted-foreground">
        {t("reasonLabelHint")}
      </p>
    </section>
  );
}

/** The pool: who covers without a post, how they are reached, and when they can. */
function PoolSection({ teachers }: { teachers: { id: string; name: string }[] }) {
  const tPool = useTranslations("substitutePool");
  const fail = useErrorToast();
  const { data: pool } = usePool();
  const { data: people } = usePeople();
  const { add, remove } = usePoolActions();
  const [candidate, setCandidate] = useState("");
  const [windowsOf, setWindowsOf] = useState<string | null>(null);

  const personOf = useMemo(() => new Map((people ?? []).map((person) => [person.id, person])), [people]);
  const members = new Set((pool ?? []).map((member) => member.userId));
  const nameOf = (id: string) => teachers.find((teacher) => teacher.id === id)?.name ?? "—";

  return (
    <section className="space-y-3" aria-labelledby="cover-pool-title">
      <h3 id="cover-pool-title" className="text-sm font-semibold">
        {tPool("members")}
      </h3>
      <p className="text-sm text-muted-foreground">{tPool("membersBody")}</p>
      {(pool ?? []).length === 0 ? (
        <p className="text-sm text-muted-foreground">{tPool("noMembers")}</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {(pool ?? []).map((member) => {
            const person = personOf.get(member.userId);
            const name = nameOf(member.userId);
            return (
              <li key={member.userId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 text-sm">
                <span>
                  <span className="font-medium">{name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {[person?.email, person?.phone].filter(Boolean).join(" · ")}
                  </span>
                </span>
                <span className="flex gap-1">
                  <Button
                    variant={windowsOf === member.userId ? "secondary" : "ghost"}
                    size="sm"
                    onClick={() => setWindowsOf(windowsOf === member.userId ? null : member.userId)}
                  >
                    {tPool("showAvailability")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={tPool("removeMember", { name })}
                    disabled={remove.isPending}
                    data-writes="DRIFT"
                    onClick={() =>
                      remove.mutate(member.userId, {
                        onSuccess: () => {
                          if (windowsOf === member.userId) setWindowsOf(null);
                          toast.success(tPool("memberRemoved", { name }));
                        },
                        onError: fail,
                      })
                    }
                  >
                    <Trash2 />
                  </Button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex max-w-md items-end gap-2" data-writes="DRIFT">
        <div className="flex-1 space-y-1.5">
          <Label htmlFor="pool-candidate">{tPool("addMember")}</Label>
          <Select value={candidate} onValueChange={setCandidate}>
            <SelectTrigger id="pool-candidate" aria-describedby="pool-candidate-hint">
              <SelectValue placeholder={tPool("memberPlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              {teachers
                .filter((teacher) => !members.has(teacher.id))
                .map((teacher) => (
                  <SelectItem key={teacher.id} value={teacher.id}>
                    {teacher.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={!candidate || add.isPending}
          onClick={() =>
            add.mutate(candidate, {
              onSuccess: () => {
                toast.success(tPool("memberAdded", { name: nameOf(candidate) }));
                setWindowsOf(candidate);
                setCandidate("");
              },
              onError: fail,
            })
          }
        >
          <Plus />
          {tPool("add")}
        </Button>
      </div>
      <p id="pool-candidate-hint" className="text-xs text-muted-foreground">
        {tPool("membersHint")}
      </p>
      {windowsOf ? (
        <div className="space-y-2 rounded-md border p-3">
          <h4 className="text-sm font-semibold">{tPool("availabilityOf", { name: nameOf(windowsOf) })}</h4>
          <AvailabilityEditor userId={windowsOf} />
        </div>
      ) : null}
    </section>
  );
}

/**
 * Frånvaro och vikarier — the school's settings, behind Lärarfrånvaro's
 * Inställningar button and loaded only then: the reason list, teacher
 * self-report, where the pool ranks, the pool and each member's windows.
 */
export function CoverSettingsDialog({
  open,
  onOpenChange,
  teachers,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  teachers: { id: string; name: string }[];
}) {
  const t = useTranslations("coverSettings");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("body")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-6">
          <PolicySection />
          <ReasonsSection />
          <PoolSection teachers={teachers} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
